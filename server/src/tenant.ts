// Multitenant (migración 039). El tenant activo se resuelve EN CADA PETICIÓN: la web manda la cabecera X-Tenant-Id (el SSE, que no
// manda cabeceras, ?tenant=), la API v1 y el MCP lo toman de la llave. El servidor valida membresía (o ADMIN, que es global) y que
// el tenant esté activo, y deja el tenant en req.tenant y en un AsyncLocalStorage: cada consulta lo lee con tid() y filtra por él.
// tid() sin tenant en el contexto es un error del programa (500), nunca un «todos los tenants» callado.
// Hoja del grafo de imports a propósito (solo db/util).
import { AsyncLocalStorage } from 'node:async_hooks'
import type { NextFunction, Request, Response } from 'express'
import { pool } from './db.ts'
import { HttpError } from './util.ts'

/** Catálogo de módulos: el mismo del CHECK user_tenants_modules_ck. */
export const MODULES = ['hub', 'feed', 'clientes', 'crm', 'cobros', 'proyectos', 'tareas', 'tablero', 'finanzas', 'marketing', 'sistemas', 'chat', 'integraciones', 'papelera'] as const
export type Module = (typeof MODULES)[number]

export type TenantCtx = { id: string; name: string; slug: string; modules: Module[] }

declare module 'express-serve-static-core' {
  interface Request {
    tenant?: TenantCtx
  }
}

const als = new AsyncLocalStorage<TenantCtx>()

/** Tenant de la petición (o del trabajo de fondo) en curso. */
export function tenantCtx(): TenantCtx {
  const t = als.getStore()
  if (!t) throw new Error('tenant: consulta de negocio sin tenant en el contexto')
  return t
}
/** Id del tenant en curso: lo que va en cada `tenant_id = $n`. */
export const tid = () => tenantCtx().id
/** ¿El usuario tiene este módulo en el tenant en curso? */
export const hasModule = (m: Module) => tenantCtx().modules.includes(m)
/** 403 si el usuario no tiene el módulo en el tenant en curso (para lo que un módulo crea en otro: convertir desde el feed, etc.). */
export function requireModule(m: Module) {
  if (!hasModule(m)) throw tenantErrors.module(m)
}

/** Corre `fn` dentro de un tenant (peticiones ya validadas y trabajos de fondo que recorren los tenants). */
export const withTenant = <T>(t: TenantCtx, fn: () => T): T => als.run(t, fn)

/** Scripts de terminal (un proceso, un tenant): fija el tenant para todo lo que sigue. No usar dentro del servidor. */
export const enterTenant = (t: TenantCtx) => als.enterWith(t)

/** Trabajos de fondo: el tenant por id, con todos los módulos (lo hace el sistema, no un socio). */
export async function tenantById(id: string): Promise<TenantCtx | null> {
  const { rows } = await pool.query('SELECT id, name, slug FROM tenants WHERE id = $1', [id])
  return rows[0] ? { ...rows[0], modules: [...MODULES] } : null
}
export async function activeTenants(): Promise<TenantCtx[]> {
  const { rows } = await pool.query('SELECT id, name, slug FROM tenants WHERE active ORDER BY created_at, id')
  return rows.map((r) => ({ ...r, modules: [...MODULES] }))
}
export const tenantBySlug = async (slug: string): Promise<TenantCtx | null> => {
  const { rows } = await pool.query('SELECT id FROM tenants WHERE slug = $1 AND active', [slug])
  return rows[0] ? tenantById(rows[0].id) : null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Acceso de un socio a un tenant: ADMIN entra a todo tenant activo con todos los módulos; un SOCIO, solo con su fila de
 * user_tenants y sus módulos. null = sin acceso (no existe, está inactivo o no es miembro: la misma respuesta, sin pistas).
 */
export async function resolveAccess(user: { id: string; role: string }, tenantId: string): Promise<TenantCtx | null> {
  if (!UUID.test(tenantId)) return null
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.slug, CASE WHEN $2 = 'ADMIN' THEN $3::text[] ELSE ut.modules END AS modules
     FROM tenants t LEFT JOIN user_tenants ut ON ut.tenant_id = t.id AND ut.user_id = $1
     WHERE t.id = $4 AND t.active AND ($2 = 'ADMIN' OR ut.user_id IS NOT NULL)`,
    [user.id, user.role, MODULES, tenantId],
  )
  return (rows[0] as TenantCtx | undefined) ?? null
}

/** Tenants a los que entra un socio, cada uno con sus módulos (lo que devuelven /auth/me y el login). */
export async function accessibleTenants(user: { id: string; role: string }) {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.slug, CASE WHEN $2 = 'ADMIN' THEN $3::text[] ELSE ut.modules END AS modules
     FROM tenants t LEFT JOIN user_tenants ut ON ut.tenant_id = t.id AND ut.user_id = $1
     WHERE t.active AND ($2 = 'ADMIN' OR ut.user_id IS NOT NULL)
     ORDER BY t.created_at, t.id`,
    [user.id, user.role, MODULES],
  )
  return rows.map((r) => ({ id: r.id as string, name: r.name as string, slug: r.slug as string, modules: (r.modules as Module[]).filter((m) => MODULES.includes(m)) }))
}

export const tenantErrors = {
  required: () => new HttpError(400, 'Falta el tenant: manda la cabecera X-Tenant-Id con el id del espacio de trabajo', { codigo: 'tenant_requerido' }),
  forbidden: () => new HttpError(403, 'No tienes acceso a ese espacio de trabajo (no existe, está desactivado o no eres miembro)', { codigo: 'tenant_sin_acceso' }),
  module: (m: Module) => new HttpError(403, `No tienes acceso al módulo «${m}» en este espacio de trabajo`, { codigo: 'modulo_sin_acceso', modulo: m }),
}

/** Web: tras requireSession. Cabecera X-Tenant-Id (el SSE de GET /events puede mandarlo en ?tenant=, porque EventSource no manda cabeceras). */
export async function requireTenant(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers['x-tenant-id']
  const raw = typeof header === 'string' ? header : req.method === 'GET' && req.path === '/events' && typeof req.query.tenant === 'string' ? req.query.tenant : undefined
  if (!raw?.trim()) throw tenantErrors.required()
  const t = await resolveAccess(req.user!, raw.trim())
  if (!t) throw tenantErrors.forbidden()
  req.tenant = t
  als.run(t, next)
}

/**
 * Módulo que exige cada ruta, por su primer segmento (y algunas subrutas). null = basta con ser miembro del tenant (lo que se
 * filtra por módulo adentro: alertas, búsqueda, actividad). Una ruta que no esté aquí NO existe (404): negar por defecto.
 */
type ModuleMap = Record<string, Module | null>
type SubMap = { re: RegExp; module: Module }[]

export function moduleGate(map: ModuleMap, subs: SubMap = []) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const path = req.path
    const sub = subs.find((s) => s.re.test(path))
    const seg = path.split('/')[1] ?? ''
    const m = sub ? sub.module : Object.hasOwn(map, seg) ? map[seg] : undefined
    if (m === undefined) throw new HttpError(404, 'No encontrado')
    if (m !== null && !tenantCtx().modules.includes(m)) throw tenantErrors.module(m)
    next()
  }
}

/** Web (/api). */
export const WEB_MODULES: ModuleMap = {
  users: null,
  clients: 'clientes',
  payments: 'cobros',
  prospects: 'crm',
  projects: 'proyectos',
  milestones: 'proyectos',
  checklist: 'proyectos',
  expenses: 'finanzas',
  tasks: 'tareas',
  board: 'tablero',
  keys: 'integraciones',
  trash: 'papelera',
  chat: 'chat',
  interactions: 'clientes',
  proposals: 'crm',
  offerings: 'crm',
  pipeline: 'crm',
  notifications: null, // filtradas por módulo
  search: null, // filtrada por módulo
  activity: null, // filtrada por módulo
  events: null, // el stream reparte solo lo de los módulos del socio
  version: null,
  versions: null,
  hub: 'hub',
  team: 'hub',
  agreements: 'hub',
  systems: 'sistemas',
  marketing: 'marketing',
  cobros: 'cobros',
  receptores: 'cobros',
  competidores: 'feed',
  feed: 'feed',
}
export const WEB_SUBMODULES: SubMap = [
  { re: /^\/clients\/[^/]+\/proposals\/?$/, module: 'crm' },
  { re: /^\/clients\/[^/]+\/(payments|initial)\/?$/, module: 'cobros' },
]

/** API v1 (/api/v1) con llave. */
export const V1_MODULES: ModuleMap = {
  me: null,
  clientes: 'clientes',
  interacciones: 'clientes',
  propuestas: 'crm',
  ofertas: 'crm',
  pipeline: 'crm',
  pagos: 'cobros',
  receptores: 'cobros',
  proyectos: 'proyectos',
  hitos: 'proyectos',
  checklist: 'proyectos',
  gastos: 'finanzas',
  finanzas: 'finanzas',
  version: null,
  versiones: null,
  hub: 'hub',
  equipo: 'hub',
  acuerdos: 'hub',
  sistemas: 'sistemas',
  marketing: 'marketing',
  feed: 'feed',
  competidores: 'feed',
  chat: 'chat',
  tareas: 'tareas',
  tablero: 'tablero',
  papelera: 'papelera',
  notificaciones: null,
  actividad: null,
  buscar: null,
}
export const V1_SUBMODULES: SubMap = [
  { re: /^\/clientes\/[^/]+\/pagos\/?$/, module: 'cobros' },
  { re: /^\/clientes\/[^/]+\/propuestas\/?$/, module: 'crm' },
]

/** MCP: módulo de cada herramienta por su primera palabra (hayai_<palabra>_...). Sin entrada = la herramienta no se ofrece. */
const MCP_WORDS: ModuleMap = {
  clientes: 'clientes', cliente: 'clientes', interacciones: 'clientes', interaccion: 'clientes',
  proyectos: 'proyectos', proyecto: 'proyectos', hito: 'proyectos', hitos: 'proyectos', checklist: 'proyectos',
  gastos: 'finanzas', gasto: 'finanzas', finanzas: 'finanzas',
  tareas: 'tareas', tarea: 'tareas',
  tablero: 'tablero', tarjeta: 'tablero', tarjetas: 'tablero', columna: 'tablero',
  pagos: 'cobros', pago: 'cobros', comprobante: 'cobros', receptores: 'cobros', receptor: 'cobros',
  pipeline: 'crm', ofertas: 'crm', oferta: 'crm', propuestas: 'crm', propuesta: 'crm',
  notificaciones: null, actividad: null, buscar: null, version: null, versiones: null,
  hub: 'hub', equipo: 'hub', acuerdos: 'hub', acuerdo: 'hub',
  sistemas: 'sistemas', sistema: 'sistemas',
  marketing: 'marketing', kw: 'marketing', competidores: 'marketing', competidor: 'marketing', contenidos: 'marketing', contenido: 'marketing', campanas: 'marketing',
  feed: 'feed', chat: 'chat', papelera: 'papelera',
}
/** ¿Se ofrece esta herramienta MCP con estos módulos? */
export function mcpToolAllowed(name: string, modules: Module[]): boolean {
  const word = name.replace(/^hayai_/, '').split('_')[0]
  if (!Object.hasOwn(MCP_WORDS, word)) return false
  const m = MCP_WORDS[word]
  return m === null || modules.includes(m)
}

// ---------- actividad: qué avisos ve cada módulo ----------
const KIND_MODULE: Record<string, Module | null> = {
  cliente_nuevo: 'clientes',
  posible_nuevo: 'crm',
  tarea_nueva: 'tareas',
  tarea_completada: 'tareas',
  tarea_reasignada: 'tareas',
  cobro_cobrado: 'cobros',
  cambio_etapa: 'crm',
  cliente_ganado: 'crm',
  cliente_perdido: 'crm',
  lead_meta: 'crm',
  acuerdo_nuevo: 'hub',
  sistema_caido: 'sistemas',
  sistema_recuperado: 'sistemas',
  version_nueva: null,
  feed_nuevo: 'feed',
  tarjeta_nueva: 'tablero',
  tarjeta_movida: 'tablero',
  tarjeta_comentada: 'tablero',
  tarjeta_asignada: 'tablero',
}
/** Tipos de actividad que puede ver quien tiene estos módulos (va como `a.kind = ANY($n)`). */
export const visibleKinds = (modules: readonly Module[]) => Object.keys(KIND_MODULE).filter((k) => KIND_MODULE[k] === null || modules.includes(KIND_MODULE[k]!))
