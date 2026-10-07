// Utilidades de la capa de servicios. Un "servicio" (op) es UNA operacion de negocio definida una sola vez:
// su esquema de entrada (zod) y la funcion que la ejecuta. La API REST /api/v1 y las herramientas MCP la usan tal cual,
// asi que validan y se comportan igual por los dos lados.
import { z } from 'zod'
import { parse } from '../util.ts'

/** Socio al que se atribuye lo que se escriba (el dueño de la llave de API). */
export type Actor = { id: string; name: string; via?: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyObject = z.ZodObject<any, any>
export type Op<S extends AnyObject = AnyObject, R = unknown> = {
  schema: S
  run: (actor: Actor, input: z.infer<S>) => Promise<R>
}

export const op = <S extends AnyObject, R>(schema: S, run: Op<S, R>['run']): Op<S, R> => ({ schema, run })

/** Valida la entrada cruda (HTTP o MCP) con el esquema de la operacion y la ejecuta. */
export const exec = <S extends AnyObject, R>(o: Op<S, R>, actor: Actor, raw: unknown): Promise<R> =>
  o.run(actor, parse(o.schema, raw))

// ---------- dominio ----------
export const AVATAR_SEEDS = ['nova', 'orion', 'lyra', 'vega', 'atlas', 'luna', 'kepler', 'sirio', 'rigel', 'titan', 'cygnus', 'pulsar']
export const CATEGORIES = ['Herramientas', 'Infraestructura', 'Operación', 'Marketing', 'Equipos', 'Otros'] as const

export const projectIcon = z.enum(['globe', 'phone', 'chart', 'cart', 'palette', 'box', 'code'], 'Icono inválido')

// En la BD "Por visitar" es 'planeacion'; la API v1 lo llama 'visita' (como el SPEC).
export const PROJECT_STATES = ['activo', 'entrega', 'visita', 'pausado', 'completado'] as const
export const projectStateOut = (s: string) => (s === 'planeacion' ? 'visita' : s)
export const projectStateIn = (s: string) => (s === 'visita' ? 'planeacion' : s)

// ---------- fechas y dinero ----------
export const TZ = process.env.APP_TZ ?? 'America/Caracas'

/** Un instante como AAAA-MM-DD en la zona horaria del negocio. */
export const dayISO = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)

/** Hoy como AAAA-MM-DD en la zona horaria del negocio (el servidor corre en UTC; sin esto "este mes" cambia a las 8 pm). */
export const todayISO = () => dayISO(new Date())

export const r2 = (n: number) => Math.round(n * 100) / 100
export const cents = (n: number) => Math.round(n * 100)

/** Archivados: por defecto se ocultan (como en las pantallas de trabajo de la web). */
export const archivadosParam = z
  .enum(['excluir', 'incluir', 'solo'], 'archivados inválido (excluir, incluir o solo)')
  .default('excluir')

// ---------- paginacion ----------
export const pageShape = {
  page: z.number().int().min(1).default(1),
  per_page: z.number().int().min(1).max(100).default(20),
}

export const paged = <T>(data: T[], total: number, page: number, per_page: number, extra: Record<string, unknown> = {}) => ({
  data,
  meta: { page, per_page, total, ...extra },
})

/** Arma un WHERE con parametros posicionales ($1, $2...) sin concatenar valores en el SQL. */
export function filters() {
  const sql: string[] = []
  const params: unknown[] = []
  return {
    /** cond lleva un unico "?" donde va el valor, p. ej. add('p.date >= ?', desde) */
    add(cond: string, value: unknown) {
      params.push(value)
      sql.push(cond.replace('?', `$${params.length}`))
    },
    /** Condicion fija, sin valor. */
    raw(cond: string) {
      sql.push(cond)
    },
    where: () => (sql.length ? `WHERE ${sql.join(' AND ')}` : ''),
    params: () => [...params],
    page(per: number, page: number) {
      return {
        clause: `LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        args: [...params, per, (page - 1) * per],
      }
    },
  }
}
