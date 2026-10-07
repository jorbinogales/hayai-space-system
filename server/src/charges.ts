// Cobros e items de la inicial: hoja del grafo de imports (solo db/util/zod). Lo usan la web, la API v1 y el cierre de venta
// (crm.ts), asi que "repetir cada mes" y el orden estable de las filas se resuelven en un solo lugar.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Db } from './db.ts'

export type ChargeRow = { d: string; c: string; a: number; s: string; sid: string | null; si: number | null; st: number | null }

/** 'AAAA-MM-DD' + k meses, mismo día del mes recortado al último día si no existe (siempre desde el día original). */
export function addMonths(iso: string, k: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const t = m - 1 + k
  const ny = y + Math.floor(t / 12)
  const nm = (t % 12) + 1
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate() // día 0 del mes siguiente = último de nm (calendario puro, UTC)
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
}

export const repeatMonths = z
  .number('Repetición inválida (entero de 2 a 36)')
  .int('Repetición inválida (entero de 2 a 36)')
  .min(2, 'Mínimo 2 meses de repetición')
  .max(36, 'Máximo 36 meses de repetición')

/** Un cobro con repeatMonths = N se materializa en N filas pendientes con su propio series_id. */
export function expandCharge(x: { date: string; amount: number; concept: string; status?: string; repeatMonths?: number }): ChargeRow[] {
  if (!x.repeatMonths) return [{ d: x.date, c: x.concept, a: x.amount, s: x.status ?? 'pendiente', sid: null, si: null, st: null }]
  const sid = randomUUID()
  return Array.from({ length: x.repeatMonths }, (_, i) => ({
    d: addMonths(x.date, i),
    c: x.concept,
    a: x.amount,
    s: 'pendiente',
    sid,
    si: i + 1,
    st: x.repeatMonths!,
  }))
}

export async function insertCharges(c: Db, clientId: string, userId: string, rows: ChargeRow[]) {
  if (!rows.length) return
  await c.query(
    `INSERT INTO payments (client_id, date, concept, amount, kind, status, created_by, series_id, series_index, series_total, created_at)
     SELECT $1, t.d, t.c, t.a, 'pago', t.s, $10, t.sid, t.si, t.st, now() + t.n * interval '1 microsecond'
     FROM unnest($2::date[], $3::text[], $4::numeric[], $5::text[], $6::uuid[], $7::smallint[], $8::smallint[], $9::bigint[])
          AS t(d, c, a, s, sid, si, st, n)`,
    [
      clientId,
      rows.map((x) => x.d),
      rows.map((x) => x.c),
      rows.map((x) => x.a),
      rows.map((x) => x.s),
      rows.map((x) => x.sid),
      rows.map((x) => x.si),
      rows.map((x) => x.st),
      rows.map((_, i) => i + 1),
      userId,
    ],
  )
}

/** created_at = now() + n µs: el orden de inserción queda estable al listar (now() es igual dentro de la transacción). */
export async function insertItems(c: Db, clientId: string, items: { concept: string; amount: number }[]) {
  if (!items.length) return
  await c.query(
    `INSERT INTO client_items (client_id, concept, amount, created_at)
     SELECT $1, t.c, t.a, now() + t.n * interval '1 microsecond'
     FROM unnest($2::text[], $3::numeric[]) WITH ORDINALITY AS t(c, a, n)`,
    [clientId, items.map((i) => i.concept), items.map((i) => i.amount)],
  )
}

