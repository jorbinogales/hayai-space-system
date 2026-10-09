// Nucleo del CRM: ficha del cliente y pipeline de posibles clientes. Un solo lugar decide como cambia una etapa, asi que la
// web, la API v1 y el MCP no pueden contradecirse (ni dejar la probabilidad o el motivo de perdida a medias).
// Hoja del grafo de imports a proposito (solo db/util): lo usan routes/ y services/, y estos ya se importan entre si.
import type { PoolClient } from 'pg'
import { expandCharge, insertCharges, insertItems } from './charges.ts'
import { recordActivity } from './activity.ts'
import { assertFresh } from './concurrency.ts'
import type { Db } from './db.ts'
import { z } from 'zod'
import { HttpError, isoDate, money, text } from './util.ts'

// ---------- etapas: viven en la tabla pipeline_stages (se editan sin migracion) ----------
// En codigo solo quedan fijas 'ganado' y 'perdido', porque tienen logica propia (convertir en cliente; exigir motivo).
export type StageRow = { key: string; label: string; position: number; probability: number; kind: 'abierta' | 'ganada' | 'perdida'; active: boolean }

export async function loadStages(db: Db): Promise<StageRow[]> {
  const { rows } = await db.query('SELECT key, label, position, probability, kind, active FROM pipeline_stages ORDER BY position')
  return rows as StageRow[]
}

/** Nombres de la Fase 1 que se siguen aceptando en la ENTRADA de la API (la salida siempre usa los nuevos). Transitorio. */
export const STAGE_ALIASES: Record<string, string> = {
  nuevo: 'prospecto',
  contactado: 'visita_agendada',
  propuesta: 'propuesta_en_armado',
  negociacion: 'propuesta_presentada',
}

/** La etapa que el usuario pidio (con alias viejos aceptados) o un 400 que lista las validas. */
export function resolveStage(stages: StageRow[], input: string): StageRow {
  const key = STAGE_ALIASES[input] && !stages.some((s) => s.key === input) ? STAGE_ALIASES[input] : input
  const found = stages.find((s) => s.key === key && s.active)
  if (!found) throw new HttpError(400, `Etapa inválida (${stages.filter((s) => s.active).map((s) => s.key).join(', ')})`)
  return found
}

/** La primera etapa abierta: donde entra un posible cliente nuevo. */
export const entryStage = (stages: StageRow[]) => {
  const s = stages.find((x) => x.kind === 'abierta' && x.active)
  if (!s) throw new HttpError(500, 'No hay etapas abiertas activas en el pipeline')
  return s
}

/** Posible cliente en una etapa abierta (ni ganado ni perdido). */
export const isOpenStage = (prospect: boolean, stage: string | null) => prospect && stage !== null && stage !== 'perdido'

export const SOURCES = ['referido', 'instagram', 'whatsapp', 'facebook', 'meta_ads', 'web', 'visita_frio', 'evento', 'otro'] as const

/** Un posible cliente sin contacto real desde hace mas de estos dias esta "frio". */
export const COLD_DAYS = 14

// ---------- esquema compartido (REST v1 y MCP lo usan tal cual; la web lo usa tras traducir sus llaves) ----------
// `null` borra un campo; omitirlo lo deja como esta. Cadenas vacias no valen (text() exige contenido): para borrar, null.
const phone = z
  .string()
  .trim()
  .max(40, 'Máximo 40 caracteres')
  .regex(/^\+?[\d\s().-]{6,40}$/, 'Teléfono inválido (solo dígitos, espacios, + ( ) . -)')
const tag = z.string().trim().min(1, 'Etiqueta vacía').max(30, 'Cada etiqueta admite máximo 30 caracteres')

// ---------- redes sociales ----------
export const NETWORKS = ['instagram', 'tiktok', 'facebook', 'x', 'youtube', 'linkedin', 'web', 'otra'] as const
const HANDLE_BASE: Partial<Record<(typeof NETWORKS)[number], string>> = { instagram: 'https://instagram.com/', tiktok: 'https://tiktok.com/@', x: 'https://x.com/' }

/** '@usuario' (instagram, tiktok, x) se convierte en su URL; todo lo demas debe ser https. null si no vale. */
export function normalizeSocialUrl(red: string, raw: string): string | null {
  const v = raw.trim()
  const base = HANDLE_BASE[red as keyof typeof HANDLE_BASE]
  const url = base && /^@?[A-Za-z0-9._]{1,40}$/.test(v) ? `${base}${v.replace(/^@/, '')}` : v
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && url.length <= 200 && u.hostname.includes('.') ? u.toString() : null
  } catch {
    return null
  }
}

const social = z
  .strictObject({
    red: z.enum(NETWORKS, `Red inválida (${NETWORKS.join(', ')})`),
    url: z.string().trim().min(1, 'Es obligatorio').max(200, 'Máximo 200 caracteres'),
  })
  .refine((v) => normalizeSocialUrl(v.red, v.url) !== null, { path: ['url'], message: 'URL inválida (https://… o @usuario en instagram, tiktok y x)' })

/** Normaliza (URL final) y valida el conjunto: una red por tipo, salvo 'otra' (hasta 3). */
export function normSocials(list: { red: string; url: string }[]) {
  const out = list.map((x) => ({ red: x.red, url: normalizeSocialUrl(x.red, x.url)! }))
  const seen = new Set<string>()
  for (const x of out) {
    if (x.red !== 'otra' && seen.has(x.red)) throw new HttpError(400, `redes: solo una cuenta de ${x.red}`)
    seen.add(x.red)
  }
  if (out.filter((x) => x.red === 'otra').length > 3) throw new HttpError(400, 'redes: máximo 3 en "otra"')
  return out
}

export const fichaShape = {
  telefono: phone.nullable().optional(),
  email: z.email('Email inválido').max(120, 'Máximo 120 caracteres').nullable().optional(),
  contacto_nombre: text(80).nullable().optional(),
  contacto_cargo: text(80).nullable().optional(),
  direccion: text(300).nullable().optional(),
  notas: text(4000).nullable().optional(),
  etiquetas: z.array(tag).max(10, 'Máximo 10 etiquetas').optional(), // [] las quita todas
  redes: z.array(social).max(8, 'Máximo 8 redes').optional(), // reemplazo completo; [] las quita todas
  origen: z.enum(SOURCES, `Origen inválido (${SOURCES.join(', ')})`).nullable().optional(),
  utm_source: text(80).nullable().optional(), // texto libre del utm_source con que llegó el lead (campaña, anuncio, página…)
  fecha_implementacion: isoDate.nullable().optional(), // dia en que se implementa el sistema (obligatorio al ganar)
  // pipeline (solo posibles clientes). etapa: ver GET /pipeline/etapas (los nombres de la fase 1 se siguen aceptando).
  etapa: z.string('Etapa inválida').trim().min(1, 'Etapa inválida').max(30, 'Etapa inválida').optional(),
  valor_estimado: money.nullable().optional(),
  probabilidad: z.number('Probabilidad inválida (entero de 0 a 100)').int('Probabilidad inválida (entero de 0 a 100)').min(0, 'Mínimo 0').max(100, 'Máximo 100').optional(),
  cierre_previsto: isoDate.nullable().optional(),
  motivo_perdida: text(300).nullable().optional(),
  // seguimiento
  proxima_accion: text(160).nullable().optional(),
  proxima_accion_fecha: isoDate.nullable().optional(),
}

/** Datos que acompañan a un cambio de etapa (solo en actualizar, no al crear). */
export const esquemaCobro = z.strictObject({
  inicio_cobro: isoDate, // fecha de la primera mensualidad (las siguientes caen el mismo dia de cada mes)
  meses: z.number('meses inválido (entero de 2 a 36)').int('meses inválido (entero de 2 a 36)').min(2, 'Mínimo 2 meses').max(36, 'Máximo 36 meses').default(12),
  unicos_cobrados: z.boolean().default(false), // true: los pagos únicos se registran ya cobrados como la inicial; false: quedan pendientes
})
export const transitionShape = {
  fecha_visita: isoDate.optional(), // con la etapa visita_agendada: crea (o reprograma) la tarea de visita
  resumen_visita: text(2000).optional(), // con visita_realizada: queda en la bitácora como una visita
  esquema_cobro: esquemaCobro.optional(), // al ganar con una propuesta vigente: genera las mensualidades y los pagos únicos
}

export type FichaPatch = z.infer<z.ZodObject<typeof fichaShape>>
export type TransitionPatch = z.infer<z.ZodObject<typeof transitionShape>>
export type ClientPatch = FichaPatch & Partial<TransitionPatch> & { nombre?: string; avatar?: string; estado?: 'activo' | 'posible'; archivado?: boolean }

const PIPELINE_KEYS = ['etapa', 'valor_estimado', 'probabilidad', 'cierre_previsto', 'motivo_perdida'] as const

/** Minuscula, espacios colapsados, sin repetidas y en el orden en que llegaron. */
export const normTags = (tags: string[]) => [...new Set(tags.map((t) => t.trim().replace(/\s+/g, ' ').toLowerCase()))]

/** Dias enteros entre dos fechas 'AAAA-MM-DD' (calendario puro, sin zonas horarias). */
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

// ---------- propuestas: totales y valor estimado ----------
type PItem = { kind: string; qty: number; unit_price: number }
const lineCents = (i: PItem) => Math.round(i.unit_price * 100) * i.qty
/** Mensualidad (base + extras mensuales) y pagos unicos de una propuesta, en centavos (se suman enteros: sin error de coma flotante). */
export const proposalTotals = (items: PItem[]) => ({
  mensual: items.filter((i) => i.kind !== 'extra_unico').reduce((s, i) => s + lineCents(i), 0),
  unico: items.filter((i) => i.kind === 'extra_unico').reduce((s, i) => s + lineCents(i), 0),
})

/**
 * Mientras un cliente tenga una propuesta viva (borrador, presentada o aceptada), su valor estimado ES la mensualidad de la
 * ultima, y el pipeline pondera esa mensualidad. Sin propuesta, el valor sigue siendo el que se anote a mano.
 */
export async function syncEstValue(c: PoolClient, clientId: string) {
  const p = (
    await c.query(
      `SELECT id FROM proposals WHERE client_id = $1 AND status IN ('borrador', 'presentada', 'aceptada') ORDER BY version DESC LIMIT 1`,
      [clientId],
    )
  ).rows[0]
  if (!p) return
  const items = (await c.query('SELECT kind, qty, unit_price FROM proposal_items WHERE proposal_id = $1', [p.id])).rows as PItem[]
  const mensual = proposalTotals(items).mensual
  await c.query('UPDATE clients SET est_value = $2 WHERE id = $1', [clientId, mensual > 0 ? mensual / 100 : null])
}

const liveProposal = async (c: PoolClient, clientId: string) =>
  (await c.query(`SELECT id, status, version FROM proposals WHERE client_id = $1 AND status IN ('borrador', 'presentada') FOR UPDATE`, [clientId])).rows[0] as
    | { id: string; status: string; version: number }
    | undefined

/** Crea (o reprograma) la tarea de visita del posible cliente. Vive en su proyecto en planeacion; si no tiene, se crea uno. */
async function scheduleVisit(c: PoolClient, actorId: string, clientId: string, name: string, date: string) {
  let project = (
    await c.query(
      `SELECT id FROM projects WHERE client_id = $1 AND status = 'planeacion' AND archived_at IS NULL ORDER BY created_at DESC, id LIMIT 1`,
      [clientId],
    )
  ).rows[0]
  if (!project)
    project = (
      await c.query(
        `INSERT INTO projects (name, icon, client_id, owner_id, status, created_by) VALUES ($1, 'box', $2, $3, 'planeacion', $3) RETURNING id`,
        [`Proyecto de ${name}`.slice(0, 80), clientId, actorId],
      )
    ).rows[0]
  const open = (
    await c.query(`SELECT id FROM tasks WHERE project_id = $1 AND NOT done AND title LIKE 'Visita%' ORDER BY created_at, id LIMIT 1`, [project.id])
  ).rows[0]
  if (open) await c.query('UPDATE tasks SET due_date = $2 WHERE id = $1', [open.id, date])
  else await c.query('INSERT INTO tasks (project_id, title, due_date, created_by) VALUES ($1, $2, $3, $4)', [project.id, `Visita a ${name}`.slice(0, 160), date, actorId])
}

/** Al ganar con una propuesta vigente: la acepta y genera las mensualidades y los pagos unicos con el esquema de cobro. */
async function closeWithProposal(c: PoolClient, actorId: string, clientId: string, proposalId: string, impl: string, plan: z.infer<typeof esquemaCobro>) {
  const items = (await c.query('SELECT kind, concept, qty, unit_price FROM proposal_items WHERE proposal_id = $1 ORDER BY position', [proposalId])).rows as (PItem & { concept: string })[]
  const { mensual, unico } = proposalTotals(items)
  if (mensual > 0)
    await insertCharges(c, clientId, actorId, expandCharge({ date: plan.inicio_cobro, amount: mensual / 100, concept: 'Mensualidad', repeatMonths: plan.meses }))
  if (unico > 0) {
    const unicos = items.filter((i) => i.kind === 'extra_unico')
    if (plan.unicos_cobrados) {
      // Igual que la inicial de siempre: su desglose queda en los items del cliente y el cobro, cobrado.
      await insertItems(c, clientId, unicos.map((i) => ({ concept: i.qty > 1 ? `${i.concept} x${i.qty}` : i.concept, amount: (Math.round(i.unit_price * 100) * i.qty) / 100 })).filter((i) => i.amount > 0))
      await c.query(
        `INSERT INTO payments (client_id, date, concept, amount, kind, status, created_by, received_by, received_by_source) VALUES ($1, $2, 'Inicial', $3, 'inicial', 'cobrado', $4, $4, 'manual')
         ON CONFLICT (client_id) WHERE kind = 'inicial' DO UPDATE SET amount = payments.amount + EXCLUDED.amount`,
        [clientId, impl, unico / 100, actorId],
      )
    } else {
      await insertCharges(c, clientId, actorId, expandCharge({ date: impl, amount: unico / 100, concept: 'Implementación y extras' }))
    }
  }
  await c.query(`UPDATE proposals SET status = 'aceptada' WHERE id = $1`, [proposalId])
}

/**
 * Aplica un cambio de ficha / pipeline / seguimiento (y de nombre, avatar, estado o archivo) a un cliente, dentro de la
 * transaccion `c`. Bloquea la fila, resuelve la etapa final y la valida entera ANTES de escribir:
 *  - estado 'activo' sobre un posible = ganado; estado 'posible' sobre un cliente = primera etapa; etapa 'ganado' = convertir.
 *  - ganado fija la probabilidad en 100 y perdido en 0 (pedir otra cosa es un 400, no se ignora en silencio).
 *    Las demas etapas traen la probabilidad de la tabla pipeline_stages (se puede pisar a mano).
 *  - ganado exige fecha_implementacion; con una propuesta vigente exige ademas esquema_cobro (genera los cobros).
 *  - perdido exige motivo_perdida (y rechaza la propuesta viva); fuera de perdido el motivo no existe.
 *  - propuesta_presentada exige una propuesta y la marca como presentada.
 *  - los datos de pipeline solo se editan en un posible cliente (o en la misma peticion que lo convierte, para anotar el valor).
 *  - cada cambio de etapa deja una entrada 'etapa' en la bitacora, escrita aqui y solo aqui.
 * Devuelve si cambio la etapa.
 */
export async function applyClientPatch(c: PoolClient, actorId: string, clientId: string, p: ClientPatch, via?: string): Promise<{ changed: boolean }> {
  await assertFresh(c, 'clients', clientId) // si quien edita mandó la versión que vio y ya cambió: 409
  const cur = (
    await c.query(
      `SELECT name, is_prospect, pipeline_stage, probability, lost_reason, next_action, next_action_date, archived_at, implementation_date
       FROM clients WHERE id = $1 FOR UPDATE`,
      [clientId],
    )
  ).rows[0]
  if (!cur) throw new HttpError(404, 'Cliente no encontrado')
  const was: string | null = cur.pipeline_stage
  const stages = await loadStages(c)
  const byKey = new Map(stages.map((s) => [s.key, s]))

  // ---- etapa final ----
  const asked = p.etapa !== undefined ? resolveStage(stages, p.etapa).key : undefined
  if (p.estado && asked && (p.estado === 'activo') !== (asked === 'ganado'))
    throw new HttpError(400, 'estado y etapa se contradicen: "activo" equivale a la etapa "ganado" y "posible" a las demás')
  if (asked === 'ganado' && !cur.is_prospect) throw new HttpError(409, 'El cliente ya no es un posible cliente')
  if (asked === 'perdido' && !cur.is_prospect) throw new HttpError(409, 'Solo un posible cliente se marca como perdido')

  let stage: string | null = was
  if (asked) stage = asked
  else if (p.estado === 'activo' && cur.is_prospect) stage = 'ganado'
  else if (p.estado === 'posible' && !cur.is_prospect) stage = entryStage(stages).key
  const changed = stage !== was
  const prospect = stage !== null && stage !== 'ganado'
  const row = stage ? byKey.get(stage) : undefined

  const touchesPipeline = PIPELINE_KEYS.some((k) => p[k] !== undefined)
  if (touchesPipeline && !(prospect || (changed && stage === 'ganado')))
    throw new HttpError(400, 'Los datos de pipeline (etapa, valor, probabilidad, cierre, motivo) solo aplican a un posible cliente')

  // ---- datos que acompañan a la etapa ----
  if (p.fecha_visita !== undefined && stage !== 'visita_agendada') throw new HttpError(400, 'fecha_visita solo aplica a la etapa "visita_agendada"')
  if (p.resumen_visita !== undefined && stage !== 'visita_realizada') throw new HttpError(400, 'resumen_visita solo aplica a la etapa "visita_realizada"')
  if (p.esquema_cobro !== undefined && !(changed && stage === 'ganado')) throw new HttpError(400, 'esquema_cobro solo aplica al ganar un posible cliente')

  // ---- probabilidad ----
  let prob: number | null = cur.probability
  if (stage === 'ganado' || stage === 'perdido') {
    const fixed = row!.probability
    if (p.probabilidad !== undefined && p.probabilidad !== fixed) throw new HttpError(400, `En la etapa "${stage}" la probabilidad es ${fixed}`)
    prob = fixed
  } else if (stage !== null) {
    if (p.probabilidad !== undefined) prob = p.probabilidad
    else if (changed) prob = row!.probability // cada etapa trae la suya; se puede pisar mandando probabilidad
  }

  // ---- motivo de perdida ----
  let lost: string | null = null
  if (stage === 'perdido') {
    lost = p.motivo_perdida !== undefined ? p.motivo_perdida : changed ? null : cur.lost_reason
    if (!lost) throw new HttpError(400, 'Indica motivo_perdida para marcar un posible cliente como perdido')
  } else if (p.motivo_perdida != null) throw new HttpError(400, 'motivo_perdida solo aplica a la etapa "perdido"')

  // ---- proxima accion: la fecha siempre acompana a una accion ----
  let action: string | null = cur.next_action
  let actionDate: string | null = cur.next_action_date
  if (p.proxima_accion !== undefined) action = p.proxima_accion
  if (p.proxima_accion_fecha !== undefined) actionDate = p.proxima_accion_fecha
  if (action === null) {
    if (p.proxima_accion_fecha != null) throw new HttpError(400, 'proxima_accion_fecha necesita una proxima_accion')
    actionDate = null // borrar la accion se lleva su fecha
  }

  // ---- propuestas y cierre de la venta ----
  const live = changed || p.valor_estimado !== undefined ? await liveProposal(c, clientId) : undefined
  if (p.valor_estimado != null) {
    const has = (await c.query(`SELECT 1 FROM proposals WHERE client_id = $1 AND status IN ('borrador', 'presentada', 'aceptada')`, [clientId])).rowCount
    if (has) throw new HttpError(400, 'El valor estimado sale de la mensualidad de la propuesta vigente: edita la propuesta')
  }
  if (changed && stage === 'propuesta_presentada' && !live) throw new HttpError(400, 'Arma una propuesta antes de pasar a "propuesta_presentada"')
  let implementation: string | null | undefined = p.fecha_implementacion
  if (changed && stage === 'ganado') {
    implementation = p.fecha_implementacion ?? cur.implementation_date
    if (!implementation) throw new HttpError(400, 'Indica fecha_implementacion (el día de implementación) para ganar un posible cliente')
    if (live && !p.esquema_cobro) throw new HttpError(400, 'Con una propuesta vigente, indica esquema_cobro (inicio_cobro, meses y unicos_cobrados) para generar los cobros')
    if (!live && p.esquema_cobro) throw new HttpError(400, 'No hay propuesta vigente: esquema_cobro no aplica (registra los cobros con pagos)')
  }

  // ---- escritura (un solo UPDATE: los CHECK se evaluan al final, con todo coherente) ----
  const sets: string[] = []
  const args: unknown[] = [clientId]
  const set = (col: string, value: unknown, cast = '') => {
    args.push(value)
    sets.push(`${col} = $${args.length}${cast}`)
  }
  if (p.nombre !== undefined) set('name', p.nombre)
  if (p.avatar !== undefined) set('avatar', p.avatar)
  if (p.telefono !== undefined) set('phone', p.telefono)
  if (p.email !== undefined) set('email', p.email === null ? null : p.email.toLowerCase())
  if (p.contacto_nombre !== undefined) set('contact_name', p.contacto_nombre)
  if (p.contacto_cargo !== undefined) set('contact_role', p.contacto_cargo)
  if (p.direccion !== undefined) set('address', p.direccion)
  if (p.notas !== undefined) set('notes', p.notas)
  if (p.etiquetas !== undefined) set('tags', normTags(p.etiquetas), '::text[]')
  if (p.redes !== undefined) set('socials', JSON.stringify(normSocials(p.redes)), '::jsonb')
  if (p.origen !== undefined) set('lead_source', p.origen)
  if (p.utm_source !== undefined) set('utm_source', p.utm_source)
  if (implementation !== undefined) set('implementation_date', implementation, '::date')
  if (p.valor_estimado !== undefined) set('est_value', p.valor_estimado)
  if (p.cierre_previsto !== undefined) set('expected_close', p.cierre_previsto)
  if (p.proxima_accion !== undefined || p.proxima_accion_fecha !== undefined) {
    set('next_action', action)
    set('next_action_date', actionDate, '::date')
  }
  if (changed) {
    set('is_prospect', prospect)
    set('pipeline_stage', stage)
    sets.push('stage_changed_at = now()')
  }
  if (changed || touchesPipeline) {
    set('probability', prob)
    set('lost_reason', lost)
  }
  if (p.archivado === true) sets.push('archived_at = COALESCE(archived_at, now())')
  if (p.archivado === false) sets.push('archived_at = NULL')
  if (sets.length) await c.query(`UPDATE clients SET ${sets.join(', ')} WHERE id = $1`, args)

  // ---- efectos de la etapa ----
  if (changed && stage === 'propuesta_presentada' && live?.status === 'borrador')
    await c.query(`UPDATE proposals SET status = 'presentada', presented_at = now() WHERE id = $1`, [live.id])
  if (changed && stage === 'perdido' && live) await c.query(`UPDATE proposals SET status = 'rechazada' WHERE id = $1`, [live.id])
  if (changed && stage === 'ganado' && live) {
    await closeWithProposal(c, actorId, clientId, live.id, implementation!, p.esquema_cobro!)
    await syncEstValue(c, clientId)
  }
  const name = (p.nombre ?? cur.name) as string
  if (p.fecha_visita !== undefined) await scheduleVisit(c, actorId, clientId, name, p.fecha_visita)
  if (p.resumen_visita !== undefined)
    await c.query(`INSERT INTO interactions (client_id, kind, summary, created_by) VALUES ($1, 'visita', $2, $3)`, [clientId, p.resumen_visita, actorId])

  if (changed) {
    const label = (s: string | null) => (s ? (byKey.get(s)?.label ?? s) : 'Sin etapa')
    // Al presentar o ganar queda escrito QUE version de la propuesta fue (la bitacora es la fuente de verdad de la negociacion).
    const version = live && (stage === 'propuesta_presentada' || stage === 'ganado') ? live.version : null
    await c.query(
      `INSERT INTO interactions (client_id, kind, summary, meta, created_by) VALUES ($1, 'etapa', $2, $3::jsonb, $4)`,
      [
        clientId,
        `${label(was)} → ${label(stage)}${version ? ` (propuesta v${version})` : ''}`,
        JSON.stringify({ de: was, a: stage, ...(lost ? { motivo: lost } : {}), ...(version ? { propuesta_version: version, propuesta_id: live!.id } : {}) }),
        actorId,
      ],
    )
    // Aviso al equipo en la misma transaccion. Ganar y perder tienen su propio texto; el resto es "movió a X (De → A)".
    const kind = stage === 'ganado' ? 'cliente_ganado' : stage === 'perdido' ? 'cliente_perdido' : 'cambio_etapa'
    await recordActivity(c, {
      kind,
      actorId,
      subject: name,
      detail: stage === 'perdido' ? lost : stage === 'ganado' ? null : `${label(was)} → ${label(stage)}${version && stage === 'propuesta_presentada' ? ` · propuesta v${version}` : ''}`,
      clientId,
      via,
    })
  }
  return { changed }
}
