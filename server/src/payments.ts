// Cambios de un pago (cobro) en un solo lugar: la web y la API v1/MCP los usan igual, asi que el aviso "registró el cobro"
// sale una sola vez, dentro de la misma transaccion, venga de donde venga. Hoja del grafo de imports (db/util/activity).
import { tx } from './db.ts'
import { recordActivity } from './activity.ts'
import { HttpError } from './util.ts'

export type PaymentPatch = { fecha?: string; monto?: number; concepto?: string; estado?: 'pendiente' | 'cobrado' }

/** Monto para el texto del aviso: "$120" o "$120.50". */
export const moneyLabel = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`

/**
 * Edita un pago que no es la inicial. Si pasa de pendiente a cobrado deja el aviso 'cobro_cobrado' (cliente, monto).
 * Devuelve el id del cliente dueño.
 */
export async function patchPayment(actor: { id: string; via?: string }, paymentId: string, p: PaymentPatch): Promise<string> {
  return tx(async (c) => {
    const row = (
      await c.query(
        `SELECT p.client_id, p.kind, p.status, p.amount, cl.name AS client FROM payments p JOIN clients cl ON cl.id = p.client_id WHERE p.id = $1 FOR UPDATE OF p`,
        [paymentId],
      )
    ).rows[0]
    if (!row) throw new HttpError(404, 'Pago no encontrado')
    if (row.kind === 'inicial') throw new HttpError(400, 'La inicial se edita desde sus ítems, no como un pago')
    const { rows } = await c.query(
      `UPDATE payments SET date = COALESCE($2, date), amount = COALESCE($3, amount), concept = COALESCE($4, concept), status = COALESCE($5, status)
       WHERE id = $1 RETURNING amount, status`,
      [paymentId, p.fecha ?? null, p.monto ?? null, p.concepto ?? null, p.estado ?? null],
    )
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
