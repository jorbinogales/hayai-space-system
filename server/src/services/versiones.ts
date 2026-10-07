// Versión del sistema e historial (changelog tipo "releases"). Se publica desde la web, la API o el MCP; el autor es el
// dueño de la llave o de la sesión. Solo se agrega: no hay editar ni borrar. La versión actual es la más alta publicada.
//
// UNA sola fuente de verdad: la fila más alta de app_versions. De ella salen (1) el aviso "Nueva actualización vX.Y.Z disponible"
// en la campana y en vivo, (2) el banner de la web, que compara esta versión con la que cargó la pestaña, y (3) lo que consultan
// los agentes: GET /version (con ?desde=<su última versión> trae lo que cambió), la cabecera X-Hayai-Version de cada respuesta y
// las instrucciones del MCP. El aviso se emite una sola vez por versión (announced_at): al publicarla, o al arrancar el sistema
// ya desplegado si la versión la sembró una migración.
import type { NextFunction, Request, Response } from 'express'
import { z } from 'zod'
import { recordActivity } from '../activity.ts'
import { currentRate } from '../bcv.ts'
import { pool, tx } from '../db.ts'
import { HttpError, isoDate, text } from '../util.ts'
import { op, todayISO } from './common.ts'

const ORDER = `(string_to_array(v.version, '.'))[1]::int DESC, (string_to_array(v.version, '.'))[2]::int DESC, (string_to_array(v.version, '.'))[3]::int DESC`
const SELECT = `SELECT v.id, v.version, v.title, v.summary, v.changes, v.released_on::text AS released_on, v.created_at, v.announced_at, u.name AS author
  FROM app_versions v LEFT JOIN users u ON u.id = v.author_id`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const out = (r: any, actual = false) => ({
  id: r.id as string,
  version: r.version as string,
  titulo: (r.title ?? null) as string | null,
  resumen: (r.summary ?? null) as string | null,
  cambios: r.changes as string[],
  fecha: r.released_on as string,
  autor: (r.author ?? 'Equipo HAYAI') as string, // sin autor = entrada histórica anterior a este registro
  anunciada_el: r.announced_at ? (r.announced_at as Date).toISOString() : null, // cuándo se avisó al equipo (null = aún no)
  actual,
})

const parts = (v: string) => v.split('.').map(Number)
export const newer = (a: string, b: string) => {
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

async function listAll() {
  const rows = (await pool.query(`${SELECT} ORDER BY ${ORDER}`)).rows
  return rows.map((r, i) => out(r, i === 0))
}

// ---------- versión vigente en memoria (para la cabecera de cada respuesta) ----------
// Una consulta barata cada 30 s como mucho; al publicar o anunciar se invalida. Si la BD falla, no se rompe ninguna respuesta.
let cached: { version: string | null; at: number } | null = null
const TTL_MS = 30_000
export const invalidateVersionCache = () => {
  cached = null
}
export async function currentVersionString(): Promise<string | null> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.version
  try {
    const r = (await pool.query(`SELECT v.version FROM app_versions v ORDER BY ${ORDER} LIMIT 1`)).rows[0]
    cached = { version: (r?.version as string | undefined) ?? null, at: Date.now() }
  } catch {
    return cached?.version ?? null
  }
  return cached.version
}

/** X-Hayai-Version en cada respuesta de /api, /api/v1 y /mcp: la web y los agentes se enteran de una versión nueva sin preguntar. */
export async function versionHeader(_req: Request, res: Response, next: NextFunction) {
  const v = await currentVersionString()
  if (v) res.setHeader('X-Hayai-Version', v)
  next()
}

const semver = z.string('versión inválida').trim().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/, 'La versión va como 1.6.0 (mayor.menor.parche)')

/**
 * Versión actual + tasa BCV con su fecha: lo que muestra la barra superior (fecha / v1.5.0 / BCV Bs. 873,87).
 * Con ?desde=<versión> (la última que conoce quien consulta, p. ej. un agente) trae además lo que cambió desde entonces.
 */
export const versionVer = op(z.strictObject({ desde: semver.optional() }), async (_a, i) => {
  const [rows, bcv, all] = await Promise.all([
    pool.query(`${SELECT} ORDER BY ${ORDER} LIMIT 1`),
    currentRate(),
    i.desde ? listAll() : Promise.resolve(null),
  ])
  if (!rows.rows[0]) throw new HttpError(404, 'Aún no hay versiones publicadas')
  const v = out(rows.rows[0], true)
  const nuevas = all ? all.filter((x) => newer(x.version, i.desde!)) : null
  return {
    version: v.version,
    titulo: v.titulo,
    resumen: v.resumen,
    cambios: v.cambios,
    fecha_version: v.fecha,
    anunciada_el: v.anunciada_el,
    autor: v.autor,
    hoy: todayISO(),
    // null solo si la fuente nunca respondió desde que arrancó el sistema. fecha = día de la tasa (en fin de semana o feriado, la última publicada).
    bcv: bcv ? { moneda: 'USD', tasa: bcv.tasa, fecha: bcv.fecha, es_de_hoy: bcv.es_de_hoy, fuente: bcv.fuente, actualizada_el: bcv.actualizada_el } : null,
    // Solo con ?desde=: hay_cambios dice si la versión actual es posterior a la que conocías; versiones = lo nuevo, de la más reciente a la más vieja.
    ...(nuevas ? { novedades: { desde: i.desde!, hay_cambios: nuevas.length > 0, versiones: nuevas } } : {}),
  }
})

export const versionesListar = op(z.strictObject({ desde: semver.optional() }), async (_a, i) => {
  const all = await listAll()
  return { data: i.desde ? all.filter((x) => newer(x.version, i.desde!)) : all } // desde: solo las posteriores a esa versión
})

export const versionPublicar = op(
  z.strictObject({
    version: semver,
    titulo: text(80).nullish(),
    resumen: text(600).nullish(),
    cambios: z.array(text(300), 'cambios debe ser una lista de textos').min(1, 'Agrega al menos un cambio').max(60, 'Máximo 60 cambios'),
    fecha: isoDate.optional(), // por defecto, hoy (hora de Caracas)
  }),
  async (actor, b) => {
    const row = await tx(async (c) => {
      // Dos publicaciones a la vez no pueden saltarse la regla de orden.
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['app_versions'])
      const top = (await c.query(`SELECT v.version FROM app_versions v ORDER BY ${ORDER} LIMIT 1`)).rows[0]?.version as string | undefined
      if ((await c.query('SELECT 1 FROM app_versions WHERE version = $1', [b.version])).rowCount) throw new HttpError(409, `La versión ${b.version} ya está publicada`)
      if (top && !newer(b.version, top)) throw new HttpError(409, `La versión debe ser mayor que la actual (${top})`)
      const fecha = b.fecha ?? todayISO()
      if (fecha > todayISO()) throw new HttpError(400, 'La fecha de una versión no puede ser futura')
      // Publicar ES avisar: announced_at y el aviso van en la misma transacción (todo o nada).
      const { rows } = await c.query(
        `INSERT INTO app_versions (version, title, summary, changes, released_on, author_id, announced_at) VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING id`,
        [b.version, b.titulo ?? null, b.resumen ?? null, b.cambios, fecha, actor.id],
      )
      await recordActivity(c, { kind: 'version_nueva', actorId: actor.id, subject: b.version, detail: b.titulo ?? undefined, via: actor.via })
      return rows[0].id as string
    })
    invalidateVersionCache()
    return out((await pool.query(`${SELECT} WHERE v.id = $1`, [row])).rows[0], true)
  },
)

/**
 * Al arrancar el sistema ya desplegado: si la versión vigente aún no se anunció (la sembró una migración, no se publicó a mano),
 * se avisa al equipo UNA vez. Idempotente y a prueba de dos instancias (candado). Las anteriores que se saltaron quedan como anunciadas.
 * ANNOUNCE_VERSION=false lo apaga (desarrollo y pruebas).
 */
export async function announceCurrentVersion(): Promise<string | null> {
  if (process.env.ANNOUNCE_VERSION === 'false') return null
  const announced = await tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['app_versions'])
    const top = (await c.query(`SELECT v.id, v.version, v.title, v.author_id FROM app_versions v ORDER BY ${ORDER} LIMIT 1`)).rows[0]
    if (!top) return null
    if ((await c.query('SELECT announced_at FROM app_versions WHERE id = $1', [top.id])).rows[0].announced_at) return null
    // El aviso necesita un socio como actor (activity.actor_id): el autor de la versión o, si es histórica, el socio activo más antiguo.
    const actorId = top.author_id ?? (await c.query('SELECT id FROM users WHERE active ORDER BY created_at, id LIMIT 1')).rows[0]?.id
    await c.query('UPDATE app_versions SET announced_at = now() WHERE announced_at IS NULL')
    if (!actorId) return null // sin socios no hay a quién avisar
    await recordActivity(c, { kind: 'version_nueva', actorId, subject: top.version, detail: top.title ?? undefined, via: 'deploy' })
    return top.version as string
  })
  invalidateVersionCache()
  return announced
}
