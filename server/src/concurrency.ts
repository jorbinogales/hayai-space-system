// Guardado sin pisar a nadie. Quien edita un registro manda la version que vio (su `actualizado_el`) en la cabecera If-Match
// (web y API) o en el campo `actualizado_el` (API y MCP). Dentro de la transaccion del cambio, `assertFresh` bloquea la fila y,
// si ya cambio (otro socio, un agente o una actualizacion del sistema), responde 409 en vez de sobrescribir en silencio.
// ADITIVO: sin esa version no se comprueba nada, asi un frontend viejo o un agente que no la manda siguen guardando como siempre.
import { AsyncLocalStorage } from 'node:async_hooks'
import type { NextFunction, Request, Response } from 'express'
import type { PoolClient } from 'pg'
import { HttpError } from './util.ts'

type Store = { expected: string | null }
const als = new AsyncLocalStorage<Store>()

export const VERSIONED_TABLES = ['clients', 'projects', 'tasks', 'payments', 'expenses', 'proposals', 'agreements', 'feed_items'] as const
export type VersionedTable = (typeof VERSIONED_TABLES)[number]

/** Un instante ISO valido, o null si no se mando. Lo demas es un 400 (mejor avisar que comparar contra basura). */
export function parseExpected(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string') throw new HttpError(400, 'actualizado_el debe ser un texto con fecha y hora (ISO)')
  const s = raw.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1')
  if (s === '*' || s === '') return null
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(s) || Number.isNaN(Date.parse(s)))
    throw new HttpError(400, 'actualizado_el inválido: usa el valor que devolvió el registro (ej. 2026-10-07T15:04:05.123Z)')
  return s
}

/** Corre `fn` sabiendo que version del registro vio quien edita. */
export const withExpected = <T>(raw: unknown, fn: () => Promise<T>): Promise<T> => als.run({ expected: parseExpected(raw) }, fn)

/**
 * Middleware para PATCH/PUT: lee If-Match (y, en la API, `actualizado_el` del cuerpo, que se quita para no chocar con los
 * esquemas estrictos) y lo deja disponible para `assertFresh` durante toda la peticion.
 */
export function conflictGuard(req: Request, _res: Response, next: NextFunction) {
  if (req.method !== 'PATCH' && req.method !== 'PUT') return next()
  let raw: unknown = req.headers['if-match']
  const body = req.body as Record<string, unknown> | undefined
  if (body && typeof body === 'object' && !Array.isArray(body) && 'actualizado_el' in body) {
    raw ??= body.actualizado_el
    delete body.actualizado_el
  }
  als.run({ expected: parseExpected(raw) }, next)
}

/**
 * Dentro de la transaccion y ANTES de escribir: si quien edita mando la version que vio y la fila ya cambio, 409.
 * Bloquea la fila (FOR UPDATE): entre la comprobacion y el UPDATE nadie mas la toca.
 */
export async function assertFresh(db: Pick<PoolClient, 'query'>, table: VersionedTable, rowId: string): Promise<void> {
  const expected = als.getStore()?.expected
  if (!expected) return
  const { rows } = await db.query(
    `SELECT updated_at, date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $2::timestamptz) AS fresh FROM ${table} WHERE id = $1 FOR UPDATE`,
    [rowId, expected],
  )
  if (!rows[0] || rows[0].fresh) return // sin fila: la operacion responde su propio 404
  throw new HttpError(409, 'Este registro cambió mientras lo editabas (otro socio, un agente o una actualización del sistema). Vuelve a leerlo y revisa antes de guardar.', {
    codigo: 'conflicto',
    actualizado_el: (rows[0].updated_at as Date).toISOString(),
  })
}

/** Instante de un registro en la forma publica (la que se manda de vuelta como If-Match). */
export const stamp = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null)
