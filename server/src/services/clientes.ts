import { z } from 'zod'
import { recordActivity } from '../activity.ts'
import { stamp } from '../concurrency.ts'
import { pool, tx } from '../db.ts'
import { expandCharge, insertCharges, insertItems, loadClients, repeatMonths } from '../routes/clients.ts'
import { applyClientPatch, COLD_DAYS, daysBetween, entryStage, fichaShape, isOpenStage, loadStages, resolveStage, transitionShape, type ClientPatch } from '../crm.ts'
import { moneyLabel, patchPayment } from '../payments.ts'
import { DETAIL_COLUMNS, DETAIL_JOINS, detalleOut, detalleShape, hasDetalle, METHODS, pickDetalle, writeDetalle } from '../paymentDetail.ts'
import { HttpError, id, isoDate, money, text } from '../util.ts'
import { archivadosParam, AVATAR_SEEDS, dayISO, filters, op, pageShape, paged, projectStateOut, r2, todayISO } from './common.ts'
import { interaccionOut } from './interacciones.ts'
import { propuestasPor } from './propuestas.ts'

type Loaded = Awaited<ReturnType<typeof loadClients>>[number]
type Move = Loaded['movements'][number]

const label = (m: { concept: string; series: { index: number; total: number } | null }) =>
  m.series ? `${m.concept} ${m.series.index}/${m.series.total}` : m.concept

const serie = (m: Move) => (m.series ? { id: m.series.id, indice: m.series.index, total: m.series.total } : null)

/** Resumen del cliente: lo recaudado y lo por cobrar se derivan de sus movimientos (no se guardan). */
function resumen(c: Loaded) {
  const hoy = todayISO()
  let recaudado = 0
  let porCobrar = 0
  let completados = 0
  let pendientes = 0
  let vencidasN = 0
  let vencidasMonto = 0
  let proximo: { id: string; fecha: string; concepto: string; monto: number } | null = null
  for (const m of c.movements) {
    if (m.status === 'cobrado') {
      recaudado += m.amount
      completados++
    } else {
      porCobrar += m.amount
      pendientes++
      if (m.date < hoy) {
        vencidasN++
        vencidasMonto += m.amount
      }
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
    // Vencido = pendiente con fecha anterior a hoy (hora de Caracas). Se deriva: no hay un estado "vencido" guardado.
    cuotas_vencidas: vencidasN,
    monto_vencido: r2(vencidasMonto),
    actualizado_el: stamp(c.updatedAt), // mándalo como If-Match / actualizado_el al editar: si cambió, 409 en vez de pisar
    // ficha
    telefono: c.phone,
    email: c.email,
    etiquetas: c.tags,
    origen: c.source,
    redes: c.socials,
    fecha_implementacion: c.implementationDate,
    // pipeline (etapa es null en los clientes de antes del pipeline)
    etapa: c.stage,
    valor_estimado: c.estValue,
    probabilidad: c.probability,
    valor_ponderado: c.estValue !== null && c.probability !== null ? r2((c.estValue * c.probability) / 100) : null,
    cierre_previsto: c.expectedClose,
    motivo_perdida: c.lostReason,
    dias_en_etapa: c.stageChangedAt ? daysBetween(dayISO(c.stageChangedAt), hoy) : null,
    // Frio: posible cliente en etapa abierta sin contacto real (llamada, visita, WhatsApp o nota) hace mas de COLD_DAYS dias.
    frio: isOpenStage(c.prospect, c.stage) && daysBetween(dayISO(c.lastContactAt ?? c.createdAt), hoy) > COLD_DAYS,
    ultimo_contacto: c.lastContactAt ? c.lastContactAt.toISOString() : null,
    // seguimiento
    proxima_accion: c.nextAction,
    proxima_accion_fecha: c.nextActionDate,
    seguimiento_vencido: c.nextActionDate !== null && c.nextActionDate < hoy,
  }
}

/** Cliente completo: resumen + desglose de la inicial + movimientos + proyectos. */
export async function clienteDetalle(clientId: string) {
  const c = (await loadClients(pool, [clientId]))[0]
  if (!c) throw new HttpError(404, 'Cliente no encontrado')
  const [{ rows }, recientes, total, propuestas] = await Promise.all([
    pool.query('SELECT id, name, status, description, due_date FROM projects WHERE client_id = $1 ORDER BY created_at, id', [clientId]),
    pool.query(
      `SELECT i.id, i.client_id, i.kind, i.occurred_at, i.summary, i.meta, u.name AS author
       FROM interactions i JOIN users u ON u.id = i.created_by WHERE i.client_id = $1 ORDER BY i.occurred_at DESC, i.id LIMIT 10`,
      [clientId],
    ),
    pool.query('SELECT count(*)::int AS n FROM interactions WHERE client_id = $1', [clientId]),
    propuestasPor('WHERE p.client_id = $1', [clientId]),
  ])
  return {
    ...resumen(c),
    contacto_nombre: c.contactName,
    contacto_cargo: c.contactRole,
    direccion: c.address,
    notas: c.notes,
    // De qué ítem del feed salió (null si no vino de ahí). Se puede devolver con POST /feed/:id/deshacer { a: 'posible_cliente', devolver: true }.
    del_feed: c.delFeed,
    // Las 10 mas recientes (de cualquier tipo, con las de etapa); el feed completo y paginado es /clientes/:id/interacciones.
    interacciones: { total: total.rows[0].n as number, recientes: recientes.rows.map(interaccionOut) },
    items: c.items.map((i) => ({ id: i.id, concepto: i.concept, monto: i.amount })),
    movimientos: c.movements.map((m) => ({
      id: m.id,
      fecha: m.date,
      concepto: label(m),
      monto: m.amount,
      tipo: m.kind,
      estado: m.status,
      serie: serie(m),
      actualizado_el: stamp(m.updatedAt),
    })),
    proyectos: rows.map((p) => ({ id: p.id, nombre: p.name, descripcion: p.description as string | null, estado: projectStateOut(p.status), entrega: p.due_date as string | null })),
    // La propuesta que cuenta (borrador, presentada o aceptada) con sus items y totales; el historial completo es /clientes/:id/propuestas.
    propuesta_vigente: propuestas.find((p) => p.vigente) ?? null,
    propuestas_total: propuestas.length,
  }
}

// ---------- clientes ----------
export const clientesListar = op(
  z.strictObject({
    estado: z.enum(['activo', 'posible']).optional(),
    etapa: z.string('Etapa inválida').trim().min(1).max(30).optional(), // ver GET /pipeline/etapas (los nombres de la fase 1 se siguen aceptando)
    archivados: archivadosParam,
    ...pageShape,
  }),
  async (_a, i) => {
    const f = filters()
    if (i.estado) f.add('is_prospect = ?', i.estado === 'posible')
    if (i.etapa) f.add('pipeline_stage = ?', resolveStage(await loadStages(pool), i.etapa).key)
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
    // estado 'posible' lo mete al pipeline (en la primera etapa salvo que se pida otra etapa abierta); la ficha y el seguimiento valen para ambos.
    estado: z.enum(['activo', 'posible'], 'Estado inválido (activo o posible)').default('activo'),
    ...fichaShape,
  }),
  async (actor, b) => {
    const posible = b.estado === 'posible'
    if (!posible && [b.etapa, b.valor_estimado, b.probabilidad, b.cierre_previsto, b.motivo_perdida].some((v) => v !== undefined))
      throw new HttpError(400, 'Los datos de pipeline (etapa, valor, probabilidad, cierre, motivo) solo aplican a un posible cliente: usa estado "posible"')
    const stages = await loadStages(pool)
    const entry = posible ? (b.etapa ? resolveStage(stages, b.etapa) : entryStage(stages)) : null
    if (entry && entry.kind !== 'abierta')
      throw new HttpError(400, `Un posible cliente entra en una etapa abierta (${stages.filter((s) => s.kind === 'abierta' && s.active).map((s) => s.key).join(', ')}); ganar o perder se hace después`)
    if (entry?.key === 'propuesta_presentada') throw new HttpError(400, 'Arma una propuesta antes de pasar a "propuesta_presentada": entra en otra etapa y avanza después')
    const stage = entry?.key ?? null
    const ficha: ClientPatch = Object.fromEntries(
      Object.keys(fichaShape).flatMap((k) => (k !== 'etapa' && k in b && b[k as keyof typeof b] !== undefined ? [[k, b[k as keyof typeof b]]] : [])),
    )
    const items = b.items.map((x) => ({ concept: x.concepto, amount: x.monto }))
    const totalCents = items.reduce((s, x) => s + Math.round(x.amount * 100), 0)
    const avatar = b.avatar ?? AVATAR_SEEDS[Math.floor(Math.random() * AVATAR_SEEDS.length)]
    const charges = b.cobros.flatMap((x) =>
      expandCharge({ date: x.fecha, amount: x.monto, concept: x.concepto, repeatMonths: x.repetir_meses }),
    )

    const clientId = await tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO clients (name, avatar, created_by, is_prospect, pipeline_stage, probability, stage_changed_at)
         VALUES ($1, $2, $3, $4::boolean, $5, $6, CASE WHEN $4::boolean THEN now() END) RETURNING id`,
        [b.nombre, avatar, actor.id, posible, stage, entry ? entry.probability : null],
      )
      const cid: string = rows[0].id
      if (Object.keys(ficha).length) await applyClientPatch(c, actor.id, cid, ficha, actor.via) // misma validacion que al actualizar
      await insertItems(c, cid, items)
      if (totalCents > 0) {
        await c.query(
          `INSERT INTO payments (client_id, date, concept, amount, kind, status, created_by, received_by, received_by_source)
           VALUES ($1, $2, 'Inicial', $3, 'inicial', 'cobrado', $4, $4, 'manual')`,
          [cid, b.fecha_inicial ?? todayISO(), totalCents / 100, actor.id],
        )
      }
      await insertCharges(c, cid, actor.id, charges)
      await recordActivity(c, { kind: posible ? 'posible_nuevo' : 'cliente_nuevo', actorId: actor.id, subject: b.nombre, clientId: cid, via: actor.via })
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
      estado: z.enum(['activo', 'posible'], 'Estado inválido (activo o posible)').optional(), // activo = ganado; posible = vuelve al pipeline en la primera etapa
      archivado: z.boolean().optional(), // true = archivar (se oculta pero conserva su historial), false = desarchivar
      ...fichaShape,
      ...transitionShape,
    })
    .refine((v) => Object.entries(v).some(([k, x]) => k !== 'id' && x !== undefined), 'Envía al menos un campo a modificar'),
  async (actor, { id: clientId, ...patch }) => {
    await tx((c) => applyClientPatch(c, actor.id, clientId, patch, actor.via))
    return clienteDetalle(clientId)
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
    // vencido=true: solo lo pendiente con fecha anterior a hoy; false: lo que no lo esta. (Por query llega como texto.)
    vencido: z.union([z.boolean(), z.enum(['true', 'false'])], 'vencido inválido (true o false)').optional(),
    recibido_por: text(40).optional(), // socio que recibió los fondos (para cuadrar a quién entró el dinero)
    metodo: z.enum(METHODS, `Método inválido (${METHODS.join(', ')})`).optional(),
    ...pageShape,
  }),
  async (_a, i) => {
    const f = filters()
    if (i.estado) f.add('p.status = ?', i.estado)
    if (i.recibido_por) f.add('lower(ru.name) = lower(?)', i.recibido_por)
    if (i.metodo) f.add('p.method = ?', i.metodo)
    if (i.vencido !== undefined) {
      const si = i.vencido === true || i.vencido === 'true'
      f.add(si ? "(p.status = 'pendiente' AND p.date < ?::date)" : "NOT (p.status = 'pendiente' AND p.date < ?::date)", todayISO())
    }
    if (i.cliente_id) f.add('p.client_id = ?', i.cliente_id)
    if (i.desde) f.add('p.date >= ?', i.desde)
    if (i.hasta) f.add('p.date <= ?', i.hasta)
    const from = `FROM payments p JOIN clients c ON c.id = p.client_id ${DETAIL_JOINS} ${f.where()}`
    const { clause, args } = f.page(i.per_page, i.page)
    const [agg, rows] = await Promise.all([
      pool.query(`SELECT count(*)::int AS n, COALESCE(sum(p.amount), 0) AS total ${from}`, f.params()),
      pool.query(
        `SELECT p.id, p.client_id, c.name AS client, p.date, p.concept, p.amount, p.kind, p.status, p.series_index, p.series_total, ${DETAIL_COLUMNS}
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
        ...detalleOut(r),
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
      ...detalleShape, // bolívares, tasa, referencia, bancos, recibido_por, método y notas (no con repetir_meses: se registran cuota por cuota)
    })
    .refine((v) => !(v.repetir_meses && v.estado === 'cobrado'), {
      path: ['estado'],
      message: 'Un pago recurrente se crea pendiente; márcalo como cobrado cuota por cuota',
    })
    .refine((v) => !(v.repetir_meses && hasDetalle(v)), { path: ['repetir_meses'], message: 'Los datos del cobro (bolívares, banco, referencia...) se registran en cada cuota, no al repetir' }),
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
      if (hasDetalle(b)) {
        const made = (await c.query('SELECT id FROM payments WHERE client_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [b.cliente_id])).rows[0].id as string
        await writeDetalle(c, made, pickDetalle(b))
      }
      if (b.estado === 'cobrado') {
        const name = (await c.query('SELECT name FROM clients WHERE id = $1', [b.cliente_id])).rows[0].name as string
        await recordActivity(c, { kind: 'cobro_cobrado', actorId: actor.id, subject: name, detail: moneyLabel(b.monto), clientId: b.cliente_id, via: actor.via })
      }
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
  ...detalleShape,
}

async function actualizarPago(actor: { id: string; via?: string }, b: { id: string; fecha?: string; monto?: number; concepto?: string; estado?: 'pendiente' | 'cobrado' } & ReturnType<typeof pickDetalle>) {
  const { id: paymentId, ...patch } = b
  return clienteDetalle(await patchPayment(actor, paymentId, patch)) // un cobro que pasa a cobrado avisa al equipo (payments.ts)
}

export const pagoActualizar = op(
  z.strictObject(pagoPatch).refine((v) => Object.entries(v).some(([k, x]) => k !== 'id' && x !== undefined), 'Envía al menos un campo a modificar'),
  (actor, b) => actualizarPago(actor, b),
)

export const pagoMarcarCobrado = op(z.strictObject({ id }), (actor, b) => actualizarPago(actor, { id: b.id, estado: 'cobrado' }))
