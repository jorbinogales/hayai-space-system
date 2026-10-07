// Avisos en vivo (SSE). Un cliente LISTEN de Postgres recibe el pg_notify que cada cambio dispara AL CONFIRMARSE y lo
// reparte a todas las pestañas abiertas. Si el servidor se cae o el LISTEN se corta, al volver se reenvia lo perdido
// (por id), y el navegador tambien pide lo que le falte con Last-Event-ID al reconectar. Sin dependencias nuevas.
import type { Request, Response } from 'express'
import pg from 'pg'
import { ACTIVITY_SELECT, activityOut, CHANNEL } from './activity.ts'
import { connectionString, pool } from './db.ts'

type Sub = { res: Response; userId: string; timer: NodeJS.Timeout }

const subs = new Set<Sub>()
let listener: pg.Client | null = null
let stopped = false
let lastId = 0 // ultimo id repartido (para reenviar lo que pase mientras el LISTEN estuvo caido)

const HEARTBEAT_MS = 25_000
const MAX_LIFE_MS = 25 * 60_000 // el navegador reconecta solo; asi una sesion vencida no deja un stream abierto para siempre
const MAX_PER_USER = 8
const REPLAY_MAX = 100

function frame(id: number, data: unknown) {
  return `id: ${id}\nevent: actividad\ndata: ${JSON.stringify(data)}\n\n`
}

async function fetchAfter(afterId: number, limit = REPLAY_MAX) {
  const { rows } = await pool.query(`${ACTIVITY_SELECT} WHERE a.id > $1 ORDER BY a.id LIMIT $2`, [afterId, limit])
  return rows
}

// Ids ya repartidos (los ultimos): el aviso en vivo y el reenvio tras una caida pueden traer el mismo evento dos veces.
const recent = new Set<number>()
function broadcast(rows: unknown[]) {
  for (const r of rows as { id: string | number }[]) {
    const id = Number(r.id)
    lastId = Math.max(lastId, id)
    if (recent.has(id)) continue
    recent.add(id)
    if (recent.size > 500) recent.delete(recent.values().next().value as number)
    for (const s of subs) s.res.write(frame(id, activityOut(r, s.userId)))
  }
}

// Un solo trabajo a la vez: sin esto, dos avisos seguidos leerian y repartirian en paralelo y el orden se mezclaria.
let chain: Promise<void> = Promise.resolve()
const enqueue = (job: () => Promise<void>) => {
  chain = chain.then(job).catch((e) => console.error('events:', (e as Error).message))
}

async function connectListener() {
  if (stopped) return
  const c = new pg.Client({ connectionString })
  let dead = false
  const retry = () => {
    if (dead) return
    dead = true
    if (listener === c) listener = null
    c.end().catch(() => {})
    if (!stopped) setTimeout(() => void connectListener(), 2000).unref()
  }
  c.on('error', retry)
  c.on('end', retry)
  c.on('notification', (m) => {
    // Cada aviso trae el id de la fila: se lee (con el nombre del autor) y se reparte. Se pide ESE id y no "todo lo posterior
    // al ultimo": un cambio con id menor puede confirmarse despues que otro con id mayor y no debe perderse.
    const id = Number(m.payload)
    if (!Number.isInteger(id)) return
    enqueue(async () => {
      const { rows } = await pool.query(`${ACTIVITY_SELECT} WHERE a.id = $1`, [id])
      broadcast(rows)
    })
  })
  try {
    await c.connect()
    await c.query(`LISTEN ${CHANNEL}`)
    listener = c
    // Lo que se confirmo mientras no escuchabamos.
    enqueue(async () => broadcast(await fetchAfter(lastId)))
  } catch (e) {
    console.error('events: LISTEN fallo, reintentando:', (e as Error).message)
    retry()
  }
}

/** Arranca el LISTEN. Se llama una vez desde index.ts (los tests de createApp no lo necesitan). */
export async function startEvents() {
  stopped = false
  const { rows } = await pool.query('SELECT coalesce(max(id), 0)::bigint AS n FROM activity')
  lastId = Number(rows[0].n)
  await connectListener()
}

export function stopEvents() {
  stopped = true
  for (const s of [...subs]) end(s)
  void listener?.end().catch(() => {})
  listener = null
}

function end(s: Sub) {
  clearInterval(s.timer)
  subs.delete(s)
  s.res.end()
}

/** GET /api/events: stream de la actividad del equipo para la sesion en curso. Last-Event-ID reenvia lo que se perdio. */
export async function openStream(req: Request, res: Response) {
  const userId = req.user!.id
  const mine = [...subs].filter((s) => s.userId === userId)
  if (mine.length >= MAX_PER_USER) end(mine[0]) // el mas viejo cede (pestañas olvidadas)

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform', // no-transform: que el proxy no comprima/almacene el stream
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()
  res.write('retry: 3000\n\n')

  const sub: Sub = { res, userId, timer: setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS) }
  const life = setTimeout(() => end(sub), MAX_LIFE_MS)
  life.unref()
  sub.timer.unref()
  req.on('close', () => {
    clearTimeout(life)
    clearInterval(sub.timer)
    subs.delete(sub)
  })

  // Se suscribe ANTES de reenviar lo perdido: asi nada cae entre la consulta y el alta (el cliente descarta ids repetidos).
  subs.add(sub)
  const last = Number(req.headers['last-event-id'] ?? req.query.desde_id ?? NaN)
  if (Number.isInteger(last) && last >= 0) {
    for (const r of await fetchAfter(last)) res.write(frame(Number(r.id), activityOut(r, userId)))
  }
}
