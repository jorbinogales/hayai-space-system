// Cambios de un pago (cobro) en un solo lugar: la web y la API v1/MCP los usan igual, asi que el aviso "registró el cobro"
// sale una sola vez, dentro de la misma transaccion, venga de donde venga. Hoja del grafo de imports (db/util/activity).
import { tx } from './db.ts'
import { recordActivity } from './activity.ts'
import { assertFresh } from './concurrency.ts'
import { type Detalle, hasDetalle, pickDetalle, writeDetalle } from './paymentDetail.ts'
import { HttpError } from './util.ts'

export type PaymentPatch = { fecha?: string; monto?: number; concepto?: string; estado?: 'pendiente' | 'cobrado' } & Detalle

/** Monto para el texto del aviso: "$120" o "$120.50". */
export const moneyLabel = (n: number) => `$${n.toLocaleString('es-VE', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`

/**
 * Edita un pago. Si pasa de pendiente a cobrado deja el aviso 'cobro_cobrado' (cliente, monto). La inicial solo admite el
 * detalle del cobro (bolívares, banco, recibido por...): su monto y su fecha salen de sus ítems.
 * Devuelve el id del cliente dueño.
 */
export async function patchPayment(actor: { id: string; via?: string }, paymentId: string, p: PaymentPatch): Promise<string> {
  return tx(async (c) => {
    await assertFresh(c, 'payments', paymentId)
    const row = (
      await c.query(
        `SELECT p.client_id, p.kind, p.status, p.amount, cl.name AS client FROM payments p JOIN clients cl ON cl.id = p.client_id WHERE p.id = $1 FOR UPDATE OF p`,
        [paymentId],
      )
    ).rows[0]
    if (!row) throw new HttpError(404, 'Pago no encontrado')
    const core = [p.fecha, p.monto, p.concepto, p.estado].some((v) => v !== undefined)
    if (row.kind === 'inicial' && core) throw new HttpError(400, 'La inicial se edita desde sus ítems, no como un pago')
    const { rows } = await c.query(
      `UPDATE payments SET date = COALESCE($2, date), amount = COALESCE($3, amount), concept = COALESCE($4, concept), status = COALESCE($5, status)
       WHERE id = $1 RETURNING amount, status`,
      [paymentId, p.fecha ?? null, p.monto ?? null, p.concepto ?? null, p.estado ?? null],
    )
    // al pasar a cobrado, lo recibió quien lo marca (si nadie lo fijó antes; un recibido_por explícito manda y se escribe abajo)
    if (row.status !== 'cobrado' && rows[0].status === 'cobrado' && p.recibido_por === undefined)
      await c.query(`UPDATE payments SET received_by = $2, received_by_source = 'manual' WHERE id = $1 AND received_by IS NULL`, [paymentId, actor.id])
    if (hasDetalle(p) || p.monto !== undefined) await writeDetalle(c, paymentId, pickDetalle(p), { amountChanged: p.monto !== undefined && Number(p.monto) !== Number(row.amount) })
    if (row.status !== 'cobrado' && rows[0].status === 'cobrado')
      await recordActivity(c, {
        kind: 'cobro_cobrado',
        actorId: actor.id,
        subject: row.client,
        detail: moneyLabel(Number(rows[0].amount)),
        clientId: row.client_id,
        via: actor.via,
      })
    return row.client_id as string
  })
}
