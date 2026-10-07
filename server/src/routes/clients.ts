import { Router } from 'express'
import { z } from 'zod'
import { pool, tx, type Db } from '../db.ts'
import { HttpError, idParam, isoDate, money, parse, text } from '../util.ts'
import { applyClientPatch, entryStage, loadStages } from '../crm.ts'
import { moneyLabel, patchPayment } from '../payments.ts'
import { recordActivity } from '../activity.ts'
import { assertFresh } from '../concurrency.ts'
import { sendToTrash } from '../trash.ts'
import { expandCharge, insertCharges, insertItems, repeatMonths } from '../charges.ts'
export { expandCharge, insertCharges, insertItems, repeatMonths }
import { PROJECT_SELECT, projectIcon } from './projects.ts'
import { TASK_SELECT } from './tasks.ts'

type Item = { id: string; concept: string; amount: number }
type Movement = { id: string; updatedAt: Date; date: string; concept: string; amount: number; kind: string; status: string; series: { id: string; index: number; total: number } | null }

/** 3 consultas y se agrupa en memoria (sin N+1). Con ids, solo esos clientes. */
export async function loadClients(db: Db, ids?: string[]) {
  const [clients, items, moves] = await Promise.all([
    db.query(
      `SELECT c.id, c.name, c.avatar, c.is_prospect, c.archived_at, c.created_at, c.phone, c.email, c.contact_name, c.contact_role, c.address, c.notes,
              c.tags, c.lead_source, c.pipeline_stage, c.est_value, c.probability, c.expected_close, c.lost_reason, c.stage_changed_at,
              c.next_action, c.next_action_date, c.socials, c.implementation_date, c.updated_at,
              -- ultimo contacto real: las entradas automaticas de etapa no cuentan
              (SELECT max(i.occurred_at) FROM interactions i WHERE i.client_id = c.id AND i.kind <> 'etapa') AS last_contact_at
       FROM clients c ${ids ? 'WHERE c.id = ANY($1::uuid[])' : ''} ORDER BY c.created_at, c.id`,
      ids ? [ids] : [],
    ),
    db.query(
      `SELECT id, client_id, concept, amount FROM client_items ${ids ? 'WHERE client_id = ANY($1::uuid[])' : ''} ORDER BY created_at, id`,
      ids ? [ids] : [],
    ),
    db.query(
      `SELECT id, client_id, updated_at, date, concept, amount, kind, status, series_id, series_index, series_total FROM payments ${ids ? 'WHERE client_id = ANY($1::uuid[])' : ''} ORDER BY date, created_at, id`,
      ids ? [ids] : [],
    ),
  ])
  const itemsBy = new Map<string, Item[]>()
  for (const r of items.rows) {
    const list = itemsBy.get(r.client_id) ?? []
    list.push({ id: r.id, concept: r.concept, amount: r.amount })
    itemsBy.set(r.client_id, list)
  }
  const movesBy = new Map<string, Movement[]>()
  for (const r of moves.rows) {
    const list = movesBy.get(r.client_id) ?? []
    const series = r.series_id ? { id: r.series_id, index: r.series_index, total: r.series_total } : null
    list.push({ id: r.id, updatedAt: r.updated_at, date: r.date, concept: r.concept, amount: r.amount, kind: r.kind, status: r.status, series })
    movesBy.set(r.client_id, list)
  }
  return clients.rows.map((c) => ({
    id: c.id,
    name: c.name,
    avatar: c.avatar,
    prospect: c.is_prospect,
    archived: c.archived_at !== null,
    createdAt: c.created_at as Date,
    updatedAt: c.updated_at as Date, // version del registro: se manda como If-Match al editar
    phone: c.phone as string | null,
    email: c.email as string | null,
    contactName: c.contact_name as string | null,
    contactRole: c.contact_role as string | null,
    address: c.address as string | null,
    notes: c.notes as string | null,
    tags: c.tags as string[],
    source: c.lead_source as string | null,
    stage: c.pipeline_stage as string | null,
    estValue: c.est_value as number | null,
    probability: c.probability as number | null,
    expectedClose: c.expected_close as string | null,
    lostReason: c.lost_reason as string | null,
    stageChangedAt: c.stage_changed_at as Date | null,
    nextAction: c.next_action as string | null,
    nextActionDate: c.next_action_date as string | null,
    socials: (c.socials ?? []) as { red: string; url: string }[],
    implementationDate: c.implementation_date as string | null,
    lastContactAt: c.last_contact_at as Date | null,
    items: itemsBy.get(c.id) ?? [],
    movements: movesBy.get(c.id) ?? [],
  }))
}

const status = z.enum(['pendiente', 'cobrado'], 'Estado inválido')
const itemList = z.array(z.object({ concept: text(120), amount: money })).max(50, 'Máximo 50 conceptos')

const newClient = z.object({
  name: text(80),
  avatar: text(40),
  initialDate: isoDate,
  items: itemList,
  charges: z.array(z.object({ date: isoDate, amount: money, concept: text(120), repeatMonths: repeatMonths.optional() })).max(100, 'Máximo 100 cobros'),
})

export const clientsRouter = Router()

clientsRouter.get('/', async (_req, res) => {
  res.json(await loadClients(pool))
})

clientsRouter.post('/', async (req, res) => {
  const b = parse(newClient, req.body)
  const userId = req.user!.id
  const totalCents = b.items.reduce((s, i) => s + Math.round(i.amount * 100), 0)

  const clientId = await tx(async (c) => {
    const { rows } = await c.query('INSERT INTO clients (name, avatar, created_by) VALUES ($1, $2, $3) RETURNING id', [
      b.name,
      b.avatar,
      userId,
    ])
    const id: string = rows[0].id
    await insertItems(c, id, b.items)
    if (totalCents > 0) {
      await c.query(
        `INSERT INTO payments (client_id, date, concept, amount, kind, status, created_by)
         VALUES ($1, $2, 'Inicial', $3, 'inicial', 'cobrado', $4)`,
        [id, b.initialDate, totalCents / 100, userId],
      )
    }
    await insertCharges(c, id, userId, b.charges.flatMap(expandCharge))
    await recordActivity(c, { kind: 'cliente_nuevo', actorId: userId, subject: b.name, clientId: id })
    return id
  })

  res.status(201).json((await loadClients(pool, [clientId]))[0])
})

/** Cliente completo (misma forma que GET /clients) o 404. */
async function clientOr404(db: Db, clientId: string) {
  const c = (await loadClients(db, [clientId]))[0]
  if (!c) throw new HttpError(404, 'Cliente no encontrado')
  return c
}

clientsRouter.patch('/:id', async (req, res) => {
  const clientId = idParam(req.params.id)
  const b = parse(
    z
      .strictObject({ name: text(80).optional(), avatar: text(40).optional() })
      .refine((v) => v.name !== undefined || v.avatar !== undefined, 'Envía al menos name o avatar'),
    req.body,
  )
  const rowCount = await tx(async (c) => {
    await assertFresh(c, 'clients', clientId)
    return (await c.query('UPDATE clients SET name = COALESCE($2, name), avatar = COALESCE($3, avatar) WHERE id = $1', [clientId, b.name ?? null, b.avatar ?? null])).rowCount
  })
  if (!rowCount) throw new HttpError(404, 'Cliente no encontrado')
  res.json(await clientOr404(pool, clientId))
})

// "Borrar" manda el cliente con todo lo suyo (gastos, proyectos con sus tareas, cobros e ítems) a la papelera, donde se restaura.
clientsRouter.delete('/:id', async (req, res) => {
  await sendToTrash('cliente', idParam(req.params.id), req.user!.id)
  res.status(204).end()
})

// Archivar oculta al cliente de las pantallas de trabajo sin tocar su historial.
for (const [action, value] of [['archive', 'now()'], ['unarchive', 'NULL']] as const) {
  clientsRouter.post(`/:id/${action}`, async (req, res) => {
    const clientId = idParam(req.params.id)
    const { rowCount } = await pool.query(`UPDATE clients SET archived_at = ${value} WHERE id = $1`, [clientId])
    if (!rowCount) throw new HttpError(404, 'Cliente no encontrado')
    res.json(await clientOr404(pool, clientId))
  })
}

// Reemplaza el desglose de la inicial y sincroniza su movimiento (crea, actualiza o borra según la suma).
clientsRouter.put('/:id/initial', async (req, res) => {
  const clientId = idParam(req.params.id)
  const b = parse(z.object({ date: isoDate, items: itemList }), req.body)
  const totalCents = b.items.reduce((s, i) => s + Math.round(i.amount * 100), 0)

  await tx(async (c) => {
    // FOR UPDATE serializa ediciones concurrentes de la misma inicial.
    if (!(await c.query('SELECT 1 FROM clients WHERE id = $1 FOR UPDATE', [clientId])).rowCount)
      throw new HttpError(404, 'Cliente no encontrado')
    await c.query('DELETE FROM client_items WHERE client_id = $1', [clientId])
    await insertItems(c, clientId, b.items)
    if (totalCents > 0) {
      await c.query(
        `INSERT INTO payments (client_id, date, concept, amount, kind, status, created_by)
         VALUES ($1, $2, 'Inicial', $3, 'inicial', 'cobrado', $4)
         ON CONFLICT (client_id) WHERE kind = 'inicial' DO UPDATE SET date = EXCLUDED.date, amount = EXCLUDED.amount, status = 'cobrado'`,
        [clientId, b.date, totalCents / 100, req.user!.id],
      )
    } else {
      await c.query("DELETE FROM payments WHERE client_id = $1 AND kind = 'inicial'", [clientId])
    }
  })
  res.json(await clientOr404(pool, clientId))
})

clientsRouter.post('/:id/payments', async (req, res) => {
  const clientId = idParam(req.params.id)
  const b = parse(
    z
      .object({ date: isoDate, amount: money, concept: text(120), status: status.default('pendiente'), repeatMonths: repeatMonths.optional() })
      .refine((v) => !(v.repeatMonths && v.status === 'cobrado'), {
        path: ['status'],
        message: 'Un pago recurrente se crea pendiente; márcalo como cobrado cuota por cuota',
      }),
    req.body,
  )
  await tx(async (c) => {
    if (!(await c.query('SELECT 1 FROM clients WHERE id = $1 FOR UPDATE', [clientId])).rowCount)
      throw new HttpError(404, 'Cliente no encontrado')
    await insertCharges(c, clientId, req.user!.id, expandCharge(b))
    if (b.status === 'cobrado') {
      const name = (await c.query('SELECT name FROM clients WHERE id = $1', [clientId])).rows[0].name as string
      await recordActivity(c, { kind: 'cobro_cobrado', actorId: req.user!.id, subject: name, detail: moneyLabel(b.amount), clientId })
    }
  })
  res.status(201).json(await clientOr404(pool, clientId))
})

// Convertir = pasar a la etapa "ganado" (probabilidad 100, queda en la bitacora). Lo decide applyClientPatch, igual que en la API.
clientsRouter.post('/:id/convert', async (req, res) => {
  const clientId = idParam(req.params.id)
  // La pantalla actual no pide la fecha de implementacion: si la ficha no la tiene, se asume hoy (Caracas).
  await tx(async (c) => {
    const { rows } = await c.query(`SELECT implementation_date IS NOT NULL AS has, (now() AT TIME ZONE 'America/Caracas')::date::text AS today FROM clients WHERE id = $1`, [clientId])
    await applyClientPatch(c, req.user!.id, clientId, { etapa: 'ganado', ...(rows[0] && !rows[0].has ? { fecha_implementacion: rows[0].today } : {}) })
  })
  res.json(await clientOr404(pool, clientId))
})

/** Id del cliente dueño de un pago editable (kind='pago'); 404 si no existe, 400 si es la inicial. */
async function paymentOwner(paymentId: string) {
  const row = (await pool.query('SELECT client_id, kind FROM payments WHERE id = $1', [paymentId])).rows[0]
  if (!row) throw new HttpError(404, 'Pago no encontrado')
  if (row.kind === 'inicial') throw new HttpError(400, 'La inicial se edita desde sus ítems')
  return row.client_id as string
}

export const paymentsRouter = Router()

paymentsRouter.patch('/:id', async (req, res) => {
  const paymentId = idParam(req.params.id)
  const b = parse(
    z
      .object({ date: isoDate.optional(), amount: money.optional(), concept: text(120).optional(), status: status.optional() })
      .refine((v) => Object.values(v).some((x) => x !== undefined), 'Envía al menos un campo a modificar'),
    req.body,
  )
  const clientId = await patchPayment(req.user!, paymentId, { fecha: b.date, monto: b.amount, concepto: b.concept, estado: b.status })
  res.json(await clientOr404(pool, clientId))
})

paymentsRouter.delete('/:id', async (req, res) => {
  const paymentId = idParam(req.params.id)
  const clientId = await paymentOwner(paymentId)
  await sendToTrash('pago', paymentId, req.user!.id)
  res.json(await clientOr404(pool, clientId))
})

const newProspect = z.object({
  name: text(80),
  avatar: text(40),
  project: z.object({ name: text(80), icon: projectIcon, owner: text(80), due: isoDate.nullish() }),
  visit: z.object({ date: isoDate.nullish(), title: text(160).optional() }).default({}),
})

export const prospectsRouter = Router()

// Posible cliente + su posible proyecto (planeación) + la tarea de visita, todo o nada.
prospectsRouter.post('/', async (req, res) => {
  const b = parse(newProspect, req.body)
  const userId = req.user!.id
  const owner = (await pool.query('SELECT id FROM users WHERE lower(name) = lower($1) AND active', [b.project.owner])).rows[0]
  if (!owner) throw new HttpError(404, 'Responsable no encontrado')

  const ids = await tx(async (c) => {
    // Entra al pipeline en la primera etapa abierta (prospecto, 10 %), contando desde ahora.
    const entry = entryStage(await loadStages(c))
    const client = await c.query(
      `INSERT INTO clients (name, avatar, is_prospect, pipeline_stage, probability, stage_changed_at, created_by)
       VALUES ($1, $2, true, $3, $4, now(), $5) RETURNING id`,
      [b.name, b.avatar, entry.key, entry.probability, userId],
    )
    const project = await c.query(
      `INSERT INTO projects (name, icon, client_id, owner_id, status, due_date, created_by)
       VALUES ($1, $2, $3, $4, 'planeacion', $5, $6) RETURNING id`,
      [b.project.name, b.project.icon, client.rows[0].id, owner.id, b.project.due ?? null, userId],
    )
    const task = await c.query('INSERT INTO tasks (project_id, title, due_date, created_by) VALUES ($1, $2, $3, $4) RETURNING id', [
      project.rows[0].id,
      b.visit.title ?? `Visita a ${b.name}`,
      b.visit.date ?? null,
      userId,
    ])
    // Un solo aviso para todo el alta (cliente + proyecto + visita): "añadió un posible cliente", no tres.
    await recordActivity(c, { kind: 'posible_nuevo', actorId: userId, subject: b.name, clientId: client.rows[0].id })
    return { client: client.rows[0].id as string, project: project.rows[0].id as string, task: task.rows[0].id as string }
  })

  const [client, project, task] = await Promise.all([
    clientOr404(pool, ids.client),
    pool.query(`${PROJECT_SELECT} WHERE p.id = $1`, [ids.project]),
    pool.query(`${TASK_SELECT} WHERE t.id = $1`, [ids.task]),
  ])
  res.status(201).json({ client, project: project.rows[0], task: task.rows[0] })
})
