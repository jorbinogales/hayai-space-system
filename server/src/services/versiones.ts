// Versión del sistema e historial (changelog tipo "releases"). Se publica desde la web, la API o el MCP; el autor es el
// dueño de la llave o de la sesión. Solo se agrega: no hay editar ni borrar. La versión actual es la más alta publicada.
import { z } from 'zod'
import { recordActivity } from '../activity.ts'
import { currentRate } from '../bcv.ts'
import { pool, tx } from '../db.ts'
import { HttpError, isoDate, text } from '../util.ts'
import { op, todayISO } from './common.ts'

const ORDER = `(string_to_array(v.version, '.'))[1]::int DESC, (string_to_array(v.version, '.'))[2]::int DESC, (string_to_array(v.version, '.'))[3]::int DESC`
const SELECT = `SELECT v.id, v.version, v.title, v.summary, v.changes, v.released_on::text AS released_on, v.created_at, u.name AS author
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
  actual,
})

const parts = (v: string) => v.split('.').map(Number)
const newer = (a: string, b: string) => {
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

async function listAll() {
  const rows = (await pool.query(`${SELECT} ORDER BY ${ORDER}`)).rows
  return rows.map((r, i) => out(r, i === 0))
}

/** Versión actual + tasa BCV con su fecha: lo que muestra la barra superior (fecha / v1.5.0 / BCV Bs. 873,87). */
export const versionVer = op(z.strictObject({}), async () => {
  const [rows, bcv] = await Promise.all([pool.query(`${SELECT} ORDER BY ${ORDER} LIMIT 1`), currentRate()])
  if (!rows.rows[0]) throw new HttpError(404, 'Aún no hay versiones publicadas')
  const v = out(rows.rows[0], true)
  return {
    version: v.version,
    titulo: v.titulo,
    fecha_version: v.fecha,
    autor: v.autor,
    hoy: todayISO(),
    // null solo si la fuente nunca respondió desde que arrancó el sistema. fecha = día de la tasa (en fin de semana o feriado, la última publicada).
    bcv: bcv ? { moneda: 'USD', tasa: bcv.tasa, fecha: bcv.fecha, es_de_hoy: bcv.es_de_hoy, fuente: bcv.fuente, actualizada_el: bcv.actualizada_el } : null,
  }
})

export const versionesListar = op(z.strictObject({}), async () => ({ data: await listAll() }))

const semver = z.string('versión inválida').trim().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/, 'La versión va como 1.6.0 (mayor.menor.parche)')

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
      const { rows } = await c.query(
        `INSERT INTO app_versions (version, title, summary, changes, released_on, author_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [b.version, b.titulo ?? null, b.resumen ?? null, b.cambios, fecha, actor.id],
      )
      await recordActivity(c, { kind: 'version_nueva', actorId: actor.id, subject: b.version, detail: b.titulo ?? undefined, via: actor.via })
      return rows[0].id as string
    })
    return out((await pool.query(`${SELECT} WHERE v.id = $1`, [row])).rows[0], true)
  },
)
