import { z } from 'zod'
import { pool, tx } from '../db.ts'
import { expandCharge, insertCharges, insertItems, loadClients, repeatMonths } from '../routes/clients.ts'
import { HttpError, id, isoDate, money, text } from '../util.ts'
import { archivadosParam, AVATAR_SEEDS, filters, op, pageShape, paged, projectStateOut, r2, todayISO } from './common.ts'

type Loaded = Awaited<ReturnType<typeof loadClients>>[number]
type Move = Loaded['movements'][number]

const label = (m: { concept: string; series: { index: number; total: number } | null }) =>
  m.series ? `${m.concept} ${m.series.index}/${m.series.total}` : m.concept

const serie = (m: Move) => (m.series ? { id: m.series.id, indice: m.series.index, total: m.series.total } : null)

/** Resumen del cliente: lo recaudado y lo por cobrar se derivan de sus movimientos (no se guardan). */
function resumen(c: Loaded) {
  let recaudado = 0
  let porCobrar = 0
  let completados = 0
  let pendientes = 0
  let proximo: { id: string; fecha: string; concepto: string; monto: number } | null = null
  for (const m of c.movements) {
    if (m.status === 'cobrado') {
      recaudado += m.amount
      completados++
    } else {
      porCobrar += m.amount
      pendientes++
      proximo ??= { id: m.id, fecha: m.date, concepto: label(m), monto: m.amount } // movimientos vienen por fecha
    }
  }
  return {
    id: c.id,
    nombre: c.name,
    avatar: c.avatar,
    estado: c.prospect ? 'posible' : 'activo',
    archivado: c.archived,
    recaudado: r2(recaudado),
    por_cobrar: r2(porCobrar),
    pagos_completados: completados,
    pagos_por_cobrar: pendientes,
    n_items: c.items.length,
    proximo_pago: proximo,
  }
}

/** Cliente completo: resumen + desglose de la inicial + movimientos + proyectos. */
export async function clienteDetalle(clientId: string) {
  const c = (await loadClients(pool, [clientId]))[0]
  if (!c) throw new HttpError(404, 'Cliente no encontrado')
  const { rows } = await pool.query('SELECT id, name, status FROM projects WHERE client_id = $1 ORDER BY created_at, id', [clientId])
  return {
    ...resumen(c),
    items: c.items.map((i) => ({ id: i.id, concepto: i.concept, monto: i.amount })),
    movimientos: c.movements.map((m) => ({
      id: m.id,
      fecha: m.date,
      concepto: label(m),
      monto: m.amount,
      tipo: m.kind,
      estado: m.status,
      serie: serie(m),
    })),
    proyectos: rows.map((p) => ({ id: p.id, nombre: p.name, estado: projectStateOut(p.status) })),
  }
}

// ---------- clientes ----------
export const clientesListar = op(
  z.strictObject({ estado: z.enum(['activo', 'posible']).optional(), archivados: archivadosParam, ...pageShape }),
  async (_a, i) => {
    const f = filters()
    if (i.estado) f.add('is_prospect = ?', i.estado === 'posible')
    if (i.archivados === 'excluir') f.raw('archived_at IS NULL')
    if (i.archivados === 'solo') f.raw('archived_at IS NOT NULL')
    const { clause, args } = f.page(i.per_page, i.page)
    const [total, ids, head] = await Promise.all([
      pool.query(`SELECT count(*)::int AS n FROM clients ${f.where()}`, f.params()),
      pool.query(`SELECT id FROM clients ${f.where()} ORDER BY created_at, id ${clause}`, args),
      // Mismos totales que la cabecera de Clientes en la web: solo clientes activos y no archivados (los posibles no cuentan).
      pool.query(
        `SELECT (SELECT count(*)::int FROM clients WHERE NOT is_prospect AND archived_at IS NULL) AS activos,
                (SELECT count(*)::int FROM clients WHERE is_prospect AND archived_at IS NULL) AS posibles,
                (SELECT count(*)::int FROM clients WHERE archived_at IS NOT NULL) AS archivados,
                COALESCE(sum(p.amount) FILTER (WHERE p.status = 'cobrado'), 0) AS recaudado,
                count(*) FILTER (WHERE p.status = 'pendiente')::int AS cuotas_por_cobrar
         FROM payments p JOIN clients c ON c.id = p.client_id WHERE NOT c.is_prospect AND c.archived_at IS NULL`,
      ),
    ])
    const list = ids.rows.length ? await loadClients(pool, ids.rows.map((r) => r.id)) : []
    const h = head.rows[0]
    return paged(list.map(resumen), total.rows[0].n, i.page, i.per_page, {
      resumen: { activos: h.activos, posibles: h.posibles, archivados: h.archivados, recaudado: r2(h.recaudado), cuotas_por_cobrar: h.cuotas_por_cobrar },
    })
  },
)

export const clienteVer = op(z.strictObject({ id }), (_a, i) => clienteDetalle(i.id))

export const clienteCrear = op(
  z.strictObject({
    nombre: text(80),
    avatar: text(40).optional(),
    fecha_inicial: isoDate.optional(),
    items: z.array(z.strictObject({ concepto: text(120), monto: money })).max(50, 'Máximo 50 conceptos').default([]),
    cobros: z
      .array(z.strictObject({ fecha: isoDate, monto: money, concepto: text(120), repetir_meses: repeatMonths.optional() }))
      .max(100, 'Máximo 100 cobros')
      .default([]),
  }),
  async (actor, b) => {
    const items = b.items.map((x) => ({ concept: x.concepto, amount: x.monto }))
    const totalCents = items.reduce((s, x) => s + Math.round(x.amount * 100), 0)
    const avatar = b.avatar ?? AVATAR_SEEDS[Math.floor(Math.random() * AVATAR_SEEDS.length)]
    const charges = b.cobros.flatMap((x) =>
      expandCharge({ date: x.fecha, amount: x.monto, concept: x.concepto, repeatMonths: x.repetir_meses }),
    )

    const clientId = await tx(async (c) => {
      const { rows } = await c.query('INSERT INTO clients (name, avatar, created_by) VALUES ($1, $2, $3) RETURNING id', [
        b.nombre,
        avatar,
        actor.id,
      ])
      const cid: string = rows[0].id
      await insertItems(c, cid, items)
      if (totalCents > 0) {
        await c.query(
          `INSERT INTO payments (client_id, date, concept, amount, kind, status, created_by)
           VALUES ($1, $2, 'Inicial', $3, 'inicial', 'cobrado', $4)`,
          [cid, b.fecha_inicial ?? todayISO(), totalCents / 100, actor.id],
        )
      }
      await insertCharges(c, cid, actor.id, charges)
      return cid
    })
    return clienteDetalle(clientId)
  },
)

export const clienteActualizar = op(
  z
    .strictObject({
      id,
      nombre: text(80).optional(),
      avatar: text(40).optional(),
      estado: z.enum(['activo', 'posible']).optional(),
      archivado: z.boolean().optional(), // true = archivar (se oculta pero conserva su historial), false = desarchivar
    })
    .refine((v) => Object.entries(v).some(([k, x]) => k !== 'id' && x !== undefined), 'Envía al menos nombre, avatar, estado o archivado'),
  async (_a, b) => {
    const { rowCount } = await pool.query(
      `UPDATE clients SET name = COALESCE($2, name), avatar = COALESCE($3, avatar), is_prospect = COALESCE($4::boolean, is_prospect),
         archived_at = CASE WHEN $5::boolean IS NULL THEN archived_at WHEN $5::boolean THEN COALESCE(archived_at, now()) ELSE NULL END
       WHERE id = $1`,
      [b.id, b.nombre ?? null, b.avatar ?? null, b.estado === undefined ? null : b.estado === 'posible', b.archivado ?? null],
    )
    if (!rowCount) throw new HttpError(404, 'Cliente no encontrado')
    return clienteDetalle(b.id)
  },
)

// ---------- pagos (cobros) ----------
const pagoEstado = z.enum(['pendiente', 'cobrado'], 'Estado inválido (pendiente o cobrado)')

export const pagosListar = op(
  z.strictObject({
    estado: pagoEstado.optional(),
    cliente_id: id.optional(),
    desde: isoDate.optional(),
    hasta: isoDate.optional(),
    ...pageShape,
  }),
  async (_a, i) => {
    const f = filters()
    if (i.estado) f.add('p.status = ?', i.estado)
    if (i.cliente_id) f.add('p.client_id = ?', i.cliente_id)
    if (i.desde) f.add('p.date >= ?', i.desde)
    if (i.hasta) f.add('p.date <= ?', i.hasta)
    const from = `FROM payments p JOIN clients c ON c.id = p.client_id ${f.where()}`
    const { clause, args } = f.page(i.per_page, i.page)
    const [agg, rows] = await Promise.all([
      pool.query(`SELECT count(*)::int AS n, COALESCE(sum(p.amount), 0) AS total ${from}`, f.params()),
      pool.query(
        `SELECT p.id, p.client_id, c.name AS client, p.date, p.concept, p.amount, p.kind, p.status, p.series_index, p.series_total
         ${from} ORDER BY p.date, p.created_at, p.id ${clause}`,
        args,
      ),
    ])
    const hoy = todayISO()
    return paged(
      rows.rows.map((r) => ({
        id: r.id,
        cliente_id: r.client_id,
        cliente: r.client,
        fecha: r.date,
        concepto: r.series_index ? `${r.concept} ${r.series_index}/${r.series_total}` : r.concept,
        monto: r.amount,
        tipo: r.kind,
        estado: r.status,
        vencido: r.status === 'pendiente' && r.date < hoy,
      })),
      agg.rows[0].n,
      i.page,
      i.per_page,
      { total_monto: r2(agg.rows[0].total) },
    )
  },
)

export const pagoRegistrar = op(
  z
    .strictObject({
      cliente_id: id,
      fecha: isoDate,
      monto: money,
      concepto: text(120),
      estado: pagoEstado.default('pendiente'),
      repetir_meses: repeatMonths.optional(),
    })
    .refine((v) => !(v.repetir_meses && v.estado === 'cobrado'), {
      path: ['estado'],
      message: 'Un pago recurrente se crea pendiente; márcalo como cobrado cuota por cuota',
    }),
  async (actor, b) => {
    await tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM clients WHERE id = $1 FOR UPDATE', [b.cliente_id])).rowCount)
        throw new HttpError(404, 'Cliente no encontrado')
      await insertCharges(
        c,
        b.cliente_id,
        actor.id,
        expandCharge({ date: b.fecha, amount: b.monto, concept: b.concepto, status: b.estado, repeatMonths: b.repetir_meses }),
      )
    })
    return clienteDetalle(b.cliente_id)
  },
)

const pagoPatch = {
  id,
  fecha: isoDate.optional(),
  monto: money.optional(),
  concepto: text(120).optional(),
  estado: pagoEstado.optional(),
}

async function actualizarPago(b: { id: string; fecha?: string; monto?: number; concepto?: string; estado?: string }) {
  const row = (await pool.query('SELECT client_id, kind FROM payments WHERE id = $1', [b.id])).rows[0]
  if (!row) throw new HttpError(404, 'Pago no encontrado')
  if (row.kind === 'inicial') throw new HttpError(400, 'La inicial se edita desde sus ítems, no como un pago')
  await pool.query(
    `UPDATE payments SET date = COALESCE($2, date), amount = COALESCE($3, amount), concept = COALESCE($4, concept), status = COALESCE($5, status)
     WHERE id = $1`,
    [b.id, b.fecha ?? null, b.monto ?? null, b.concepto ?? null, b.estado ?? null],
  )
  return clienteDetalle(row.client_id as string)
}

export const pagoActualizar = op(
  z.strictObject(pagoPatch).refine((v) => Object.entries(v).some(([k, x]) => k !== 'id' && x !== undefined), 'Envía al menos un campo a modificar'),
  (_a, b) => actualizarPago(b),
)

export const pagoMarcarCobrado = op(z.strictObject({ id }), (_a, b) => actualizarPago({ id: b.id, estado: 'cobrado' }))
