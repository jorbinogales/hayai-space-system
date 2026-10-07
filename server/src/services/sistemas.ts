// Sistemas entregados a los clientes (hub central): enlace, usuario de gestión, datos del entorno y semáforo de disponibilidad.
// SIN contraseñas: solo URLs y el nombre del usuario de gestión. La verificación vive en systems.ts.
import { z } from 'zod'
import { pool } from '../db.ts'
import { checkSystem } from '../systems.ts'
import { HttpError, id, text } from '../util.ts'
import { boolFlag, filters, op, pageShape, paged } from './common.ts'

const SELECT = `SELECT s.id, s.client_id, c.name AS client, s.name, s.app_url, s.prod_url, s.check_url, s.repo_url, s.server, s.admin_user, s.notes,
    s.monitor, s.active, s.status, s.status_since, s.last_check_at, s.last_ok_at, s.last_code, s.last_ms, s.last_error, s.fail_streak,
    (SELECT round(100.0 * count(*) FILTER (WHERE k.ok) / NULLIF(count(*), 0), 1) FROM system_checks k WHERE k.system_id = s.id AND k.at > now() - interval '24 hours') AS uptime_24h
  FROM systems s JOIN clients c ON c.id = s.client_id`

const iso = (d: unknown) => (d ? (d as Date).toISOString() : null)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const out = (r: any) => ({
  id: r.id as string,
  cliente_id: r.client_id as string,
  cliente: r.client as string,
  nombre: r.name as string,
  enlace: r.app_url as string | null,
  url_produccion: r.prod_url as string | null,
  url_verificacion: r.check_url as string | null,
  repo: r.repo_url as string | null,
  servidor: r.server as string | null,
  usuario_gestion: r.admin_user as string | null,
  notas: r.notes as string | null,
  verificar: r.monitor as boolean,
  activo: r.active as boolean,
  // semáforo: arriba (verde) | caido (rojo) | desconocido (aún sin verificar o sin URL)
  estado: r.status as 'arriba' | 'caido' | 'desconocido',
  desde: iso(r.status_since),
  ultima_verificacion: iso(r.last_check_at),
  ultima_vez_arriba: iso(r.last_ok_at),
  codigo_http: r.last_code as number | null,
  respuesta_ms: r.last_ms as number | null,
  error: r.last_error as string | null,
  disponibilidad_24h: r.uptime_24h == null ? null : Number(r.uptime_24h),
})

const url = z
  .string('URL inválida')
  .trim()
  .max(500, 'URL demasiado larga')
  .regex(/^https?:\/\/[^/@\s]+(\/\S*)?$/, 'URL inválida (http o https, sin usuario:clave@)')

/** Campos editables. null borra el dato; omitirlo lo deja igual. */
const campos = {
  nombre: text(80),
  enlace: url.nullish(), // el sistema construido: lo que abre el cliente
  url_produccion: url.nullish(),
  url_verificacion: url.nullish(), // lo que se verifica; por defecto url_produccion y, si no hay, enlace
  repo: url.nullish(),
  servidor: text(120).nullish(), // dónde corre (proveedor / host)
  usuario_gestion: text(80).nullish(), // usuario interno de gestión. NUNCA la contraseña
  notas: text(1000).nullish(),
  verificar: z.boolean('verificar debe ser verdadero o falso').optional(),
  activo: z.boolean('activo debe ser verdadero o falso').optional(),
}

async function sistema(systemId: string) {
  const r = (await pool.query(`${SELECT} WHERE s.id = $1`, [systemId])).rows[0]
  if (!r) throw new HttpError(404, 'Sistema no encontrado')
  return out(r)
}

export const sistemasListar = op(
  z.strictObject({
    cliente_id: id.optional(),
    estado: z.enum(['arriba', 'caido', 'desconocido'], 'Estado inválido (arriba, caido o desconocido)').optional(),
    activos: boolFlag.default(true), // false: solo los desactivados
    ...pageShape,
  }),
  async (_a, i) => {
    const f = filters()
    if (i.cliente_id) f.add('s.client_id = ?', i.cliente_id)
    if (i.estado) f.add('s.status = ?', i.estado)
    f.add('s.active = ?', i.activos === true || i.activos === 'true')
    const { clause, args } = f.page(i.per_page, i.page)
    const [total, rows, sum] = await Promise.all([
      pool.query(`SELECT count(*)::int AS n FROM systems s ${f.where()}`, f.params()),
      pool.query(`${SELECT} ${f.where()} ORDER BY (s.status = 'caido') DESC, c.name, s.name, s.id ${clause}`, args),
      pool.query(`SELECT status, count(*)::int AS n FROM systems WHERE active GROUP BY status`),
    ])
    const por_estado = { arriba: 0, caido: 0, desconocido: 0 } as Record<string, number>
    for (const r of sum.rows) por_estado[r.status] = r.n
    return paged(rows.rows.map(out), total.rows[0].n, i.page, i.per_page, { por_estado })
  },
)

export const sistemaVer = op(z.strictObject({ id }), (_a, i) => sistema(i.id))

export const sistemaCrear = op(
  z.strictObject({ cliente_id: id, ...campos }),
  async (actor, b) => {
    if (!(await pool.query('SELECT 1 FROM clients WHERE id = $1', [b.cliente_id])).rowCount) throw new HttpError(404, 'Cliente no encontrado')
    const { rows } = await pool.query(
      `INSERT INTO systems (client_id, name, app_url, prod_url, check_url, repo_url, server, admin_user, notes, monitor, active, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [b.cliente_id, b.nombre, b.enlace ?? null, b.url_produccion ?? null, b.url_verificacion ?? null, b.repo ?? null, b.servidor ?? null, b.usuario_gestion ?? null, b.notas ?? null, b.verificar ?? true, b.activo ?? true, actor.id],
    )
    return sistema(rows[0].id)
  },
)

export const sistemaActualizar = op(
  z
    .strictObject({ id, ...campos, nombre: campos.nombre.optional() })
    .refine((v) => Object.entries(v).some(([k, x]) => k !== 'id' && x !== undefined), 'Envía al menos un campo a modificar'),
  async (_a, b) => {
    const COL = { nombre: 'name', enlace: 'app_url', url_produccion: 'prod_url', url_verificacion: 'check_url', repo: 'repo_url', servidor: 'server', usuario_gestion: 'admin_user', notas: 'notes', verificar: 'monitor', activo: 'active' } as const
    const sets: string[] = []
    const args: unknown[] = [b.id]
    for (const [k, col] of Object.entries(COL)) {
      const v = (b as Record<string, unknown>)[k]
      if (v !== undefined) sets.push(`${col} = $${args.push(v)}`)
    }
    // Cambiar la URL que se verifica reinicia el semáforo: lo anterior ya no habla de esta dirección.
    if (b.url_verificacion !== undefined || b.url_produccion !== undefined || b.enlace !== undefined)
      sets.push(`status = 'desconocido'`, 'status_since = NULL', 'fail_streak = 0', 'last_error = NULL', 'last_code = NULL', 'last_ms = NULL')
    const r = await pool.query(`UPDATE systems SET ${sets.join(', ')} WHERE id = $1`, args)
    if (!r.rowCount) throw new HttpError(404, 'Sistema no encontrado')
    return sistema(b.id)
  },
)

/** Verifica ahora (sin esperar al vigilante). Un fallo se confirma con un segundo intento antes de declarar la caída. */
export const sistemaVerificar = op(z.strictObject({ id }), async (_a, b) => {
  const r = await checkSystem(b.id)
  return { verificacion: { estado: r.estado, codigo_http: r.codigo, respuesta_ms: r.ms, error: r.error, cambio: r.cambio }, sistema: await sistema(b.id) }
})
