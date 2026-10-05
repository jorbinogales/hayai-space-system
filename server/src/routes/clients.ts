import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { pool, tx, type Db } from '../db.ts'
import { HttpError, idParam, isoDate, money, parse, text } from '../util.ts'
import { PROJECT_SELECT, deleteProjects, projectIcon } from './projects.ts'
import { TASK_SELECT } from './tasks.ts'

type ChargeRow = { d: string; c: string; a: number; s: string; sid: string | null; si: number | null; st: number | null }
type Item = { id: string; concept: string; amount: number }
type Movement = { id: string; date: string; concept: string; amount: number; kind: string; status: string; series: { id: string; index: number; total: number } | null }

/** 3 consultas y se agrupa en memoria (sin N+1). Con ids, solo esos clientes. */
export async function loadClients(db: Db, ids?: string[]) {
  const [clients, items, moves] = await Promise.all([
    db.query(`SELECT id, name, avatar, is_prospect FROM clients ${ids ? 'WHERE id = ANY($1::uuid[])' : ''} ORDER BY created_at, id`, ids ? [ids] : []),
    db.query(
      `SELECT id, client_id, concept, amount FROM client_items ${ids ? 'WHERE client_id = ANY($1::uuid[])' : ''} ORDER BY created_at, id`,
      ids ? [ids] : [],
    ),
    db.query(
      `SELECT id, client_id, date, concept, amount, kind, status, series_id, series_index, series_total FROM payments ${ids ? 'WHERE client_id = ANY($1::uuid[])' : ''} ORDER BY date, created_at, id`,
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
    list.push({ id: r.id, date: r.date, concept: r.concept, amount: r.amount, kind: r.kind, status: r.status, series })
    movesBy.set(r.client_id, list)
  }
  return clients.rows.map((c) => ({
    id: c.id,
    name: c.name,
    avatar: c.avatar,
    prospect: c.is_prospect,
    items: itemsBy.get(c.id) ?? [],
    movements: movesBy.get(c.id) ?? [],
  }))
}

/** 'AAAA-MM-DD' + k meses, mismo día del mes recortado al último día si no existe (siempre desde el día original). */
function addMonths(iso: string, k: number): string {
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

const status = z.enum(['pendiente', 'cobrado'], 'Estado inválido')
const itemList = z.array(z.object({ concept: text(120), amount: money })).max(50, 'Máximo 50 conceptos')

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
export async function insertItems(c: Db, clientId: string, items: Item[] | { concept: string; amount: number }[]) {
  if (!items.length) return
  await c.query(
    `INSERT INTO client_items (client_id, concept, amount, created_at)
     SELECT $1, t.c, t.a, now() + t.n * interval '1 microsecond'
     FROM unnest($2::text[], $3::numeric[]) WITH ORDINALITY AS t(c, a, n)`,
    [clientId, items.map((i) => i.concept), items.map((i) => i.amount)],
  )
}

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
      .object({ name: text(80).optional(), avatar: text(40).optional() })
      .refine((v) => v.name !== undefined || v.avatar !== undefined, 'Envía al menos name o avatar'),
    req.body,
  )
  const { rowCount } = await pool.query('UPDATE clients SET name = COALESCE($2, name), avatar = COALESCE($3, avatar) WHERE id = $1', [
    clientId,
    b.name ?? null,
    b.avatar ?? null,
  ])
  if (!rowCount) throw new HttpError(404, 'Cliente no encontrado')
  res.json(await clientOr404(pool, clientId))
})

// Borra el cliente con todo lo suyo: gastos, proyectos (y sus tareas/gastos), cobros e ítems.
clientsRouter.delete('/:id', async (req, res) => {
  const clientId = idParam(req.params.id)
  const found = await tx(async (c) => {
    const exists = (await c.query('SELECT 1 FROM clients WHERE id = $1 FOR UPDATE', [clientId])).rowCount
    if (!exists) return 0
    await deleteProjects(c, 'client_id = $1', [clientId])
    await c.query('DELETE FROM expenses WHERE client_id = $1', [clientId])
    await c.query('DELETE FROM payments WHERE client_id = $1', [clientId])
    await c.query('DELETE FROM clients WHERE id = $1', [clientId]) // client_items: CASCADE
    return 1
  })
  if (!found) throw new HttpError(404, 'Cliente no encontrado')
  res.status(204).end()
})

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
  })
  res.status(201).json(await clientOr404(pool, clientId))
})

clientsRouter.post('/:id/convert', async (req, res) => {
  const clientId = idParam(req.params.id)
  const { rowCount } = await pool.query('UPDATE clients SET is_prospect = false WHERE id = $1 AND is_prospect', [clientId])
  if (!rowCount) {
    await clientOr404(pool, clientId)
    throw new HttpError(409, 'El cliente ya no es un posible cliente')
  }
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
  const clientId = await paymentOwner(paymentId)
  await pool.query(
    `UPDATE payments SET date = COALESCE($2, date), amount = COALESCE($3, amount), concept = COALESCE($4, concept), status = COALESCE($5, status)
     WHERE id = $1`,
    [paymentId, b.date ?? null, b.amount ?? null, b.concept ?? null, b.status ?? null],
  )
  res.json(await clientOr404(pool, clientId))
})

paymentsRouter.delete('/:id', async (req, res) => {
  const paymentId = idParam(req.params.id)
  const clientId = await paymentOwner(paymentId)
  await pool.query('DELETE FROM payments WHERE id = $1', [paymentId])
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
    const client = await c.query('INSERT INTO clients (name, avatar, is_prospect, created_by) VALUES ($1, $2, true, $3) RETURNING id', [
      b.name,
      b.avatar,
      userId,
    ])
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
    return { client: client.rows[0].id as string, project: project.rows[0].id as string, task: task.rows[0].id as string }
  })

  const [client, project, task] = await Promise.all([
    clientOr404(pool, ids.client),
    pool.query(`${PROJECT_SELECT} WHERE p.id = $1`, [ids.project]),
    pool.query(`${TASK_SELECT} WHERE t.id = $1`, [ids.task]),
  ])
  res.status(201).json({ client, project: project.rows[0], task: task.rows[0] })
})
