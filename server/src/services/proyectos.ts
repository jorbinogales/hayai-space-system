import { z } from 'zod'
import { pool } from '../db.ts'
import { projectIcon } from '../routes/projects.ts'
import { HttpError, id, isoDate, text } from '../util.ts'
import { archivadosParam, filters, op, pageShape, paged, PROJECT_STATES, projectStateIn, projectStateOut } from './common.ts'

const SELECT = `SELECT p.id, p.name, p.icon, u.name AS owner, c.name AS client, p.client_id, p.status, p.due_date,
    (p.archived_at IS NOT NULL) AS archived, (c.archived_at IS NOT NULL) AS client_archived,
    (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id) AS t_total,
    (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.done) AS t_done
  FROM projects p JOIN users u ON u.id = p.owner_id JOIN clients c ON c.id = p.client_id`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const out = (r: any) => ({
  id: r.id,
  nombre: r.name,
  icono: r.icon,
  cliente: r.client,
  cliente_id: r.client_id,
  responsable: r.owner,
  estado: projectStateOut(r.status),
  entrega: r.due_date as string | null,
  archivado: r.archived as boolean,
  cliente_archivado: r.client_archived as boolean,
  tareas: { total: r.t_total as number, completadas: r.t_done as number },
})

const estado = z.enum(PROJECT_STATES, 'Estado inválido (activo, entrega o visita)')

async function ownerId(name: string): Promise<string> {
  const o = (await pool.query('SELECT id FROM users WHERE lower(name) = lower($1) AND active', [name])).rows[0]
  if (!o) throw new HttpError(404, 'Responsable no encontrado')
  return o.id
}

async function proyecto(projectId: string) {
  const r = (await pool.query(`${SELECT} WHERE p.id = $1`, [projectId])).rows[0]
  if (!r) throw new HttpError(404, 'Proyecto no encontrado')
  return out(r)
}

export const proyectosListar = op(
  z.strictObject({ estado: estado.optional(), cliente_id: id.optional(), archivados: archivadosParam, ...pageShape }),
  async (_a, i) => {
    const f = filters()
    if (i.estado) f.add('p.status = ?', projectStateIn(i.estado))
    if (i.cliente_id) f.add('p.client_id = ?', i.cliente_id)
    // Un proyecto queda oculto si él o su cliente están archivados.
    if (i.archivados === 'excluir') f.raw('p.archived_at IS NULL AND c.archived_at IS NULL')
    if (i.archivados === 'solo') f.raw('(p.archived_at IS NOT NULL OR c.archived_at IS NOT NULL)')
    const { clause, args } = f.page(i.per_page, i.page)
    const [total, rows, groups] = await Promise.all([
      pool.query(`SELECT count(*)::int AS n FROM projects p JOIN clients c ON c.id = p.client_id ${f.where()}`, f.params()),
      pool.query(`${SELECT} ${f.where()} ORDER BY p.created_at, p.id ${clause}`, args),
      pool.query(
        'SELECT p.status, count(*)::int AS n FROM projects p JOIN clients c ON c.id = p.client_id WHERE p.archived_at IS NULL AND c.archived_at IS NULL GROUP BY p.status',
      ),
    ])
    const por_estado: Record<string, number> = { activo: 0, entrega: 0, visita: 0 }
    for (const g of groups.rows) por_estado[projectStateOut(g.status)] = g.n
    return paged(rows.rows.map(out), total.rows[0].n, i.page, i.per_page, { por_estado })
  },
)

export const proyectoVer = op(z.strictObject({ id }), async (_a, i) => {
  const p = await proyecto(i.id)
  const { rows } = await pool.query(
    `SELECT t.id, t.title, t.done, t.due_date FROM tasks t WHERE t.project_id = $1 ORDER BY t.done, t.due_date NULLS LAST, t.created_at, t.id`,
    [i.id],
  )
  return {
    ...p,
    lista_tareas: rows.map((t) => ({ id: t.id, titulo: t.title, estado: t.done ? 'completada' : 'pendiente', vence: t.due_date as string | null })),
  }
})

export const proyectoCrear = op(
  z.strictObject({
    nombre: text(80),
    cliente_id: id,
    icono: projectIcon.default('box'),
    responsable: text(80).optional(), // por defecto, el dueño de la llave
    estado: estado.default('visita'),
    entrega: isoDate.nullish(),
  }),
  async (actor, b) => {
    const owner = b.responsable ? await ownerId(b.responsable) : actor.id
    if (!(await pool.query('SELECT 1 FROM clients WHERE id = $1', [b.cliente_id])).rowCount) throw new HttpError(404, 'Cliente no encontrado')
    const { rows } = await pool.query(
      `INSERT INTO projects (name, icon, client_id, owner_id, status, due_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [b.nombre, b.icono, b.cliente_id, owner, projectStateIn(b.estado), b.entrega ?? null, actor.id],
    )
    return proyecto(rows[0].id)
  },
)

async function actualizar(b: {
  id: string
  nombre?: string
  icono?: string
  cliente_id?: string
  responsable?: string
  estado?: string
  entrega?: string | null
  archivado?: boolean
}) {
  const owner = b.responsable !== undefined ? await ownerId(b.responsable) : null
  if (b.cliente_id && !(await pool.query('SELECT 1 FROM clients WHERE id = $1', [b.cliente_id])).rowCount)
    throw new HttpError(404, 'Cliente no encontrado')
  const { rowCount } = await pool.query(
    `UPDATE projects SET name = COALESCE($2, name), icon = COALESCE($3, icon), client_id = COALESCE($4::uuid, client_id),
       owner_id = COALESCE($5::uuid, owner_id), status = COALESCE($6, status),
       due_date = CASE WHEN $7::boolean THEN $8::date ELSE due_date END,
       archived_at = CASE WHEN $9::boolean IS NULL THEN archived_at WHEN $9::boolean THEN COALESCE(archived_at, now()) ELSE NULL END
     WHERE id = $1`,
    [
      b.id,
      b.nombre ?? null,
      b.icono ?? null,
      b.cliente_id ?? null,
      owner,
      b.estado ? projectStateIn(b.estado) : null,
      b.entrega !== undefined,
      b.entrega ?? null,
      b.archivado ?? null,
    ],
  )
  if (!rowCount) throw new HttpError(404, 'Proyecto no encontrado')
  return proyecto(b.id)
}

export const proyectoActualizar = op(
  z
    .strictObject({
      id,
      nombre: text(80).optional(),
      icono: projectIcon.optional(),
      cliente_id: id.optional(),
      responsable: text(80).optional(),
      estado: estado.optional(),
      entrega: isoDate.nullable().optional(), // null borra la fecha
      archivado: z.boolean().optional(), // true = archivar (se oculta pero conserva su historial), false = desarchivar
    })
    .refine((v) => Object.entries(v).some(([k, x]) => k !== 'id' && x !== undefined), 'Envía al menos un campo a modificar'),
  (_a, b) => actualizar(b),
)

export const proyectoEstado = op(z.strictObject({ id, estado }), (_a, b) => actualizar({ id: b.id, estado: b.estado }))
