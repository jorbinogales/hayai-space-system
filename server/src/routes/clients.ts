import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { pool, tx, type Db } from '../db.ts'
import { isoDate, money, parse, text } from '../util.ts'

type ChargeRow = { d: string; c: string; a: number; sid: string | null; si: number | null; st: number | null }
type Item = { id: string; concept: string; amount: number }
type Movement = { id: string; date: string; concept: string; amount: number; kind: string; status: string; series: { id: string; index: number; total: number } | null }

/** 3 consultas y se agrupa en memoria (sin N+1). Con ids, solo esos clientes. */
async function loadClients(db: Db, ids?: string[]) {
  const [clients, items, moves] = await Promise.all([
    db.query(`SELECT id, name, avatar FROM clients ${ids ? 'WHERE id = ANY($1::uuid[])' : ''} ORDER BY created_at, id`, ids ? [ids] : []),
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

const repeatMonths = z
  .number('Repetición inválida (entero de 2 a 36)')
  .int('Repetición inválida (entero de 2 a 36)')
  .min(2, 'Mínimo 2 meses de repetición')
  .max(36, 'Máximo 36 meses de repetición')

const newClient = z.object({
  name: text(80),
  avatar: text(40),
  initialDate: isoDate,
  items: z.array(z.object({ concept: text(120), amount: money })).max(50, 'Máximo 50 conceptos'),
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
    // Cada cobro con repeatMonths = N se materializa en N filas con su propio series_id.
    const charges = b.charges.flatMap((x): ChargeRow[] => {
      if (!x.repeatMonths) return [{ d: x.date, c: x.concept, a: x.amount, sid: null, si: null, st: null }]
      const sid = randomUUID()
      return Array.from({ length: x.repeatMonths }, (_, i) => ({
        d: addMonths(x.date, i),
        c: x.concept,
        a: x.amount,
        sid,
        si: i + 1,
        st: x.repeatMonths!,
      }))
    })
    if (charges.length) {
      await c.query(
        `INSERT INTO payments (client_id, date, concept, amount, kind, status, created_by, series_id, series_index, series_total, created_at)
         SELECT $1, t.d, t.c, t.a, 'pago', 'pendiente', $9, t.sid, t.si, t.st, now() + t.n * interval '1 microsecond'
         FROM unnest($2::date[], $3::text[], $4::numeric[], $5::uuid[], $6::smallint[], $7::smallint[], $8::bigint[])
              AS t(d, c, a, sid, si, st, n)`,
        [
          id,
          charges.map((x) => x.d),
          charges.map((x) => x.c),
          charges.map((x) => x.a),
          charges.map((x) => x.sid),
          charges.map((x) => x.si),
          charges.map((x) => x.st),
          charges.map((_, i) => i + 1),
          userId,
        ],
      )
    }
    return id
  })

  res.status(201).json((await loadClients(pool, [clientId]))[0])
})
