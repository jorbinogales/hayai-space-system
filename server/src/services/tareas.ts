import { z } from 'zod'
import { recordActivity } from '../activity.ts'
import { pool, tx } from '../db.ts'
import { HttpError, id, isoDate, text } from '../util.ts'
import { type Actor, archivadosParam, filters, op, pageShape, paged } from './common.ts'

const SELECT = `SELECT t.id, t.project_id, p.name AS project, t.title, t.done, t.due_date, u.name AS owner
  FROM tasks t JOIN projects p ON p.id = t.project_id JOIN clients c ON c.id = p.client_id JOIN users u ON u.id = t.created_by`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const out = (r: any) => ({
  id: r.id,
  titulo: r.title as string,
  proyecto_id: r.project_id as string,
  proyecto: r.project as string,
  estado: r.done ? 'completada' : 'pendiente',
  vence: r.due_date as string | null,
  // Las tareas no tienen asignado: quien aparece es quien la creó.
  creada_por: r.owner as string,
})

const estado = z.enum(['pendiente', 'completada'], 'Estado inválido (pendiente o completada)')

async function tarea(taskId: string) {
  const r = (await pool.query(`${SELECT} WHERE t.id = $1`, [taskId])).rows[0]
  if (!r) throw new HttpError(404, 'Tarea no encontrada')
  return out(r)
}

export const tareasListar = op(
  z.strictObject({ estado: estado.optional(), proyecto_id: id.optional(), archivados: archivadosParam, ...pageShape }),
  async (_a, i) => {
    // Las tareas de proyectos (o clientes) archivados se ocultan, igual que en la web.
    const hide = (g: ReturnType<typeof filters>) => {
      if (i.archivados === 'excluir') g.raw('p.archived_at IS NULL AND c.archived_at IS NULL')
      if (i.archivados === 'solo') g.raw('(p.archived_at IS NOT NULL OR c.archived_at IS NOT NULL)')
    }
    const base = filters()
    if (i.proyecto_id) base.add('t.project_id = ?', i.proyecto_id)
    hide(base)
    // Los contadores respetan el proyecto pedido pero no el estado, para ver "n pendientes / m completadas".
    const counts = await pool.query(
      `SELECT count(*) FILTER (WHERE NOT t.done)::int AS pendientes, count(*) FILTER (WHERE t.done)::int AS completadas
       FROM tasks t JOIN projects p ON p.id = t.project_id JOIN clients c ON c.id = p.client_id ${base.where()}`,
      base.params(),
    )
    const f = filters()
    if (i.proyecto_id) f.add('t.project_id = ?', i.proyecto_id)
    if (i.estado) f.add('t.done = ?', i.estado === 'completada')
    hide(f)
    const { clause, args } = f.page(i.per_page, i.page)
    const [total, rows] = await Promise.all([
      pool.query(`SELECT count(*)::int AS n FROM tasks t JOIN projects p ON p.id = t.project_id JOIN clients c ON c.id = p.client_id ${f.where()}`, f.params()),
      pool.query(`${SELECT} ${f.where()} ORDER BY t.done, t.due_date NULLS LAST, t.created_at, t.id ${clause}`, args),
    ])
    return paged(rows.rows.map(out), total.rows[0].n, i.page, i.per_page, { ...counts.rows[0] })
  },
)

export const tareaVer = op(z.strictObject({ id }), (_a, i) => tarea(i.id))

export const tareaCrear = op(
  z.strictObject({ titulo: text(160), proyecto_id: id, vence: isoDate.nullish() }),
  async (actor, b) => {
    const project = (await pool.query('SELECT name, client_id FROM projects WHERE id = $1', [b.proyecto_id])).rows[0]
    if (!project) throw new HttpError(404, 'Proyecto no encontrado')
    const taskId = await tx(async (c) => {
      const { rows } = await c.query('INSERT INTO tasks (project_id, title, due_date, created_by) VALUES ($1, $2, $3, $4) RETURNING id', [
        b.proyecto_id,
        b.titulo,
        b.vence ?? null,
        actor.id,
      ])
      // El aviso nombra al dueño de la llave (actor.name), venga de donde venga la peticion.
      await recordActivity(c, { kind: 'tarea_nueva', actorId: actor.id, subject: b.titulo, detail: project.name, clientId: project.client_id, projectId: b.proyecto_id, taskId: rows[0].id, via: actor.via })
      return rows[0].id as string
    })
    return tarea(taskId)
  },
)

async function actualizar(actor: Actor, b: { id: string; titulo?: string; estado?: string; vence?: string | null }) {
  // estado ausente => no cambia; vence ausente => no cambia, vence null => borra la fecha.
  await tx(async (c) => {
    // Se bloquea la fila: solo el cambio que la completa avisa al equipo (reabrir o repetir "completada" no).
    const cur = (
      await c.query(
        `SELECT t.done, t.title, p.id AS project_id, p.name AS project, p.client_id
         FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = $1 FOR UPDATE OF t`,
        [b.id],
      )
    ).rows[0]
    if (!cur) throw new HttpError(404, 'Tarea no encontrada')
    await c.query(
      `UPDATE tasks SET
         title = COALESCE($5, title),
         done = COALESCE($2::boolean, done),
         done_at = CASE WHEN $2::boolean IS NULL THEN done_at WHEN $2::boolean THEN COALESCE(done_at, now()) ELSE NULL END,
         due_date = CASE WHEN $3::boolean THEN $4::date ELSE due_date END
       WHERE id = $1`,
      [b.id, b.estado === undefined ? null : b.estado === 'completada', b.vence !== undefined, b.vence ?? null, b.titulo ?? null],
    )
    if (b.estado === 'completada' && !cur.done)
      await recordActivity(c, { kind: 'tarea_completada', actorId: actor.id, subject: b.titulo ?? cur.title, detail: cur.project, clientId: cur.client_id, projectId: cur.project_id, taskId: b.id, via: actor.via })
  })
  return tarea(b.id)
}

export const tareaActualizar = op(
  z
    .strictObject({ id, titulo: text(160).optional(), estado: estado.optional(), vence: isoDate.nullable().optional() })
    .refine((v) => v.titulo !== undefined || v.estado !== undefined || v.vence !== undefined, 'Envía titulo, estado o vence'),
  (actor, b) => actualizar(actor, b),
)

export const tareaCompletar = op(z.strictObject({ id }), (actor, b) => actualizar(actor, { id: b.id, estado: 'completada' }))
