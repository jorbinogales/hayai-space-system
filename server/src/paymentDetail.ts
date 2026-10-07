// Datos del cobro más allá del monto en USD: bolívares, tasa, referencia, bancos, quién recibió, método y notas.
// Hoja del grafo de imports (db/util/zod): la usan payments.ts (editar), services/clientes.ts (registrar) y services/cobros.ts.
// monto (USD) sigue siendo el campo principal de Finanzas; aquí solo se documenta CÓMO entró el dinero (auditoría).
import { z } from 'zod'
import type { Db } from './db.ts'
import { userByName } from './socios.ts'
import { HttpError, isoDate, text } from './util.ts'

export const METHODS = ['transferencia', 'pago_movil', 'efectivo', 'zelle', 'otro'] as const

const decimals = (max: number) => (v: number) => Math.abs(v * 10 ** max - Math.round(v * 10 ** max)) < 1e-6
const bs = z.number('Monto en bolívares inválido').gt(0, 'Los bolívares deben ser mayores que 0').max(1e12, 'Monto demasiado grande').refine(decimals(2), 'Máximo 2 decimales en bolívares')
const tasa = z.number('Tasa inválida').gt(0, 'La tasa debe ser mayor que 0').max(1e9, 'Tasa demasiado grande').refine(decimals(4), 'Máximo 4 decimales en la tasa')

/** Campos del detalle del cobro. null borra el dato; omitirlo lo deja igual. */
export const detalleShape = {
  monto_bs: bs.nullish(), // bolívares recibidos (p. ej. 65540.25)
  tasa: tasa.nullish(), // Bs por USD (p. ej. 873.87); con monto y monto_bs se calcula sola
  fecha_tasa: isoDate.nullish(), // día de la tasa (por defecto, la fecha del cobro)
  referencia: text(60).nullish(), // referencia bancaria
  banco_origen: text(60).nullish(), // banco emisor; vale "Bancrecer ****8017" (se separan los 4 últimos)
  cuenta_origen_ultimos4: z.string('Últimos 4 inválidos').regex(/^\d{4}$/, 'Son exactamente 4 dígitos').nullish(),
  banco_destino: text(60).nullish(), // banco receptor
  recibido_por: text(40).nullish(), // socio que recibió los fondos (Elis, Jorbi, Leandro)
  metodo: z.enum(METHODS, `Método inválido (${METHODS.join(', ')})`).nullish(),
  notas: text(1000).nullish(),
}
export type Detalle = { [K in keyof typeof detalleShape]?: z.infer<(typeof detalleShape)[K]> }
const KEYS = Object.keys(detalleShape) as (keyof typeof detalleShape)[]
export const hasDetalle = (p: Record<string, unknown>) => KEYS.some((k) => p[k] !== undefined)
export const pickDetalle = (p: Record<string, unknown>): Detalle => Object.fromEntries(KEYS.flatMap((k) => (p[k] !== undefined ? [[k, p[k]]] : [])))

const r2 = (n: number) => Math.round(n * 100) / 100
const r4 = (n: number) => Math.round(n * 10_000) / 10_000

/** "Bancrecer ****8017" -> banco y últimos 4. Lo que no trae asteriscos se deja tal cual. */
function splitBank(p: Detalle): Detalle {
  const b = p.banco_origen
  if (typeof b !== 'string') return p
  const m = /^(.*?)[\s\-–:]*\*{2,}\s*(\d{4})$/.exec(b)
  if (!m || !m[1].trim()) return p
  return { ...p, banco_origen: m[1].trim(), cuenta_origen_ultimos4: p.cuenta_origen_ultimos4 ?? m[2] }
}

/**
 * Escribe el detalle de un cobro dentro de la transacción `c` (el cobro ya existe y su monto ya está al día).
 * Reglas de bolívares y tasa (siempre viajan juntos y la tasa guarda su fecha):
 *  - monto_bs sin tasa: tasa = monto_bs / monto (4 decimales); tasa sin monto_bs: monto_bs = monto × tasa.
 *  - los dos a la vez: deben cuadrar con el monto (0,5 % de margen) o es un 400.
 *  - si cambia el monto en USD y hay bolívares guardados, la tasa se recalcula (lo recibido en Bs no cambia).
 *  - quitar uno de los dos (null) quita ambos.
 * Una referencia bancaria no se registra dos veces (409): casi siempre es el mismo cobro cargado de nuevo.
 */
export async function writeDetalle(c: Db, paymentId: string, raw: Detalle, opts: { amountChanged?: boolean } = {}): Promise<void> {
  const p = splitBank(raw)
  const cur = (await c.query('SELECT amount, date, amount_bs, exchange_rate, rate_date FROM payments WHERE id = $1', [paymentId])).rows[0]
  if (!cur) throw new HttpError(404, 'Pago no encontrado')
  const usd = Number(cur.amount)
  let monto: number | null = cur.amount_bs == null ? null : Number(cur.amount_bs)
  let rate: number | null = cur.exchange_rate == null ? null : Number(cur.exchange_rate)
  let rdate: string | null = cur.rate_date

  const setBs = p.monto_bs !== undefined
  const setRate = p.tasa !== undefined
  if (setBs) monto = p.monto_bs ?? null
  if (setRate) rate = p.tasa ?? null
  const drop = (setBs && p.monto_bs === null && !(setRate && p.tasa != null)) || (setRate && p.tasa === null && !(setBs && p.monto_bs != null))
  if (drop) {
    monto = null
    rate = null
    rdate = null
  } else if (setBs && setRate && monto != null && rate != null) {
    if (Math.abs(monto / rate - usd) > Math.max(0.01, usd * 0.005))
      throw new HttpError(400, `monto_bs / tasa (${r2(monto / rate)}) no cuadra con el monto en USD (${usd}). Revisa los bolívares o la tasa`)
  } else if (setRate && rate != null) {
    monto = r2(usd * rate)
  } else if ((setBs || opts.amountChanged) && monto != null) {
    rate = r4(monto / usd)
  }
  if (monto != null && rate != null) {
    if (p.fecha_tasa !== undefined) rdate = p.fecha_tasa
    rdate ??= cur.date
  } else if (p.fecha_tasa) {
    throw new HttpError(400, 'fecha_tasa solo aplica con monto_bs o tasa')
  }
  if (monto != null && monto <= 0) throw new HttpError(400, 'Los bolívares deben ser mayores que 0')

  const sets: string[] = []
  const args: unknown[] = [paymentId]
  const set = (col: string, v: unknown) => sets.push(`${col} = $${args.push(v)}`)
  if (setBs || setRate || opts.amountChanged || drop) {
    set('amount_bs', monto)
    set('exchange_rate', rate)
    set('rate_date', rdate)
  }
  if (p.referencia !== undefined) {
    if (p.referencia) {
      const dup = (
        await c.query(
          `SELECT p.date, cl.name FROM payments p JOIN clients cl ON cl.id = p.client_id WHERE lower(p.bank_reference) = lower($1) AND p.id <> $2 LIMIT 1`,
          [p.referencia, paymentId],
        )
      ).rows[0]
      if (dup) throw new HttpError(409, `La referencia ${p.referencia} ya está registrada en un cobro de ${dup.name} (${dup.date}). ¿Es el mismo pago?`)
    }
    set('bank_reference', p.referencia ?? null)
  }
  if (p.banco_origen !== undefined) set('bank_origin', p.banco_origen ?? null)
  if (p.cuenta_origen_ultimos4 !== undefined) set('origin_last4', p.cuenta_origen_ultimos4 ?? null)
  if (p.banco_origen === null && p.cuenta_origen_ultimos4 === undefined) set('origin_last4', null)
  if (p.banco_destino !== undefined) set('bank_destination', p.banco_destino ?? null)
  if (p.metodo !== undefined) set('method', p.metodo ?? null)
  if (p.notas !== undefined) set('notes', p.notas ?? null)
  if (p.recibido_por !== undefined) {
    if (p.recibido_por === null) {
      set('received_by', null)
      set('received_by_source', null)
    } else {
      set('received_by', (await userByName(c, p.recibido_por, 'recibido_por')).id)
      set('received_by_source', 'manual')
    }
  }
  if (sets.length) await c.query(`UPDATE payments SET ${sets.join(', ')} WHERE id = $1`, args)
}

/** Columnas del detalle (con el socio que recibió y si hay comprobante) para armar la forma pública. */
export const DETAIL_COLUMNS = `p.amount_bs, p.exchange_rate, p.rate_date, p.bank_reference, p.bank_origin, p.origin_last4, p.bank_destination, p.method, p.notes,
    p.received_by, ru.name AS received_by_name, p.received_by_source,
    (r.payment_id IS NOT NULL) AS has_receipt, r.filename AS receipt_name, r.mime AS receipt_mime, r.size AS receipt_size, r.uploaded_at AS receipt_at`
export const DETAIL_JOINS = `LEFT JOIN users ru ON ru.id = p.received_by LEFT JOIN payment_receipts r ON r.payment_id = p.id`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const detalleOut = (r: any) => ({
  monto_bs: r.amount_bs == null ? null : Number(r.amount_bs),
  tasa: r.exchange_rate == null ? null : Number(r.exchange_rate),
  fecha_tasa: (r.rate_date ?? null) as string | null,
  referencia: (r.bank_reference ?? null) as string | null,
  banco_origen: (r.bank_origin ?? null) as string | null,
  cuenta_origen_ultimos4: (r.origin_last4 ?? null) as string | null,
  banco_destino: (r.bank_destination ?? null) as string | null,
  recibido_por: r.received_by ? { id: r.received_by as string, nombre: r.received_by_name as string } : null,
  recibido_por_origen: (r.received_by_source === 'comprobante' ? 'comprobante' : r.received_by ? 'manual' : null) as 'manual' | 'comprobante' | null,
  metodo: (r.method ?? null) as string | null,
  notas: (r.notes ?? null) as string | null,
  comprobante: r.has_receipt
    ? { nombre: r.receipt_name as string, tipo: r.receipt_mime as string, tamano: Number(r.receipt_size), subido_el: (r.receipt_at as Date).toISOString() }
    : null,
})
