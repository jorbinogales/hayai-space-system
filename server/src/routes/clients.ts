import { Router } from 'express'
import { z } from 'zod'
import { pool, tx, type Db } from '../db.ts'
import { isoDate, money, parse, text } from '../util.ts'

type Item = { id: string; concept: string; amount: number }
type Movement = { id: string; date: string; concept: string; amount: number; kind: string; status: string }

/** 3 consultas y se agrupa en memoria (sin N+1). Con ids, solo esos clientes. */
async function loadClients(db: Db, ids?: string[]) {
  const [clients, items, moves] = await Promise.all([
    db.query(`SELECT id, name, avatar FROM clients ${ids ? 'WHERE id = ANY($1::uuid[])' : ''} ORDER BY created_at, id`, ids ? [ids] : []),
    db.query(
      `SELECT id, client_id, concept, amount FROM client_items ${ids ? 'WHERE client_id = ANY($1::uuid[])' : ''} ORDER BY created_at, id`,
      ids ? [ids] : [],
    ),
    db.query(
      `SELECT id, client_id, date, concept, amount, kind, status FROM payments ${ids ? 'WHERE client_id = ANY($1::uuid[])' : ''} ORDER BY date, created_at, id`,
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
    list.push({ id: r.id, date: r.date, concept: r.concept, amount: r.amount, kind: r.kind, status: r.status })
    movesBy.set(r.client_id, list)
  }
  return clients.rows.map((c) => ({
    id: c.id,
    name: c.name,
    avatar: c.avatar,
    items: itemsBy.get(c.id) ?? [],
    movements: movesBy.get(c.id) ?? [],
  }))
}

const newClient = z.object({
  name: text(80),
  avatar: text(40),
  initialDate: isoDate,
  items: z.array(z.object({ concept: text(120), amount: money })).max(50, 'Máximo 50 conceptos'),
  charges: z.array(z.object({ date: isoDate, amount: money, concept: text(120) })).max(100, 'Máximo 100 cobros'),
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
    // created_at = now() + n µs: el orden de inserción queda estable al listar (now() es igual dentro de la transacción).
    if (b.items.length) {
      await c.query(
        `INSERT INTO client_items (client_id, concept, amount, created_at)
         SELECT $1, t.c, t.a, now() + t.n * interval '1 microsecond'
         FROM unnest($2::text[], $3::numeric[]) WITH ORDINALITY AS t(c, a, n)`,
        [id, b.items.map((i) => i.concept), b.items.map((i) => i.amount)],
      )
    }
    if (totalCents > 0) {
      await c.query(
        `INSERT INTO payments (client_id, date, concept, amount, kind, status, created_by)
         VALUES ($1, $2, 'Inicial', $3, 'inicial', 'cobrado', $4)`,
        [id, b.initialDate, totalCents / 100, userId],
      )
    }
    if (b.charges.length) {
      await c.query(
        `INSERT INTO payments (client_id, date, concept, amount, kind, status, created_by, created_at)
         SELECT $1, t.d, t.c, t.a, 'pago', 'pendiente', $5, now() + t.n * interval '1 microsecond'
         FROM unnest($2::date[], $3::text[], $4::numeric[]) WITH ORDINALITY AS t(d, c, a, n)`,
        [id, b.charges.map((x) => x.date), b.charges.map((x) => x.concept), b.charges.map((x) => x.amount), userId],
      )
    }
    return id
  })

  res.status(201).json((await loadClients(pool, [clientId]))[0])
})
