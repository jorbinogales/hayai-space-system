import { Router } from 'express'
import { z } from 'zod'
import { recordActivity } from '../activity.ts'
import { pool, tx } from '../db.ts'
import { sendToTrash } from '../trash.ts'
import { HttpError, id, idParam, isoDate, parse, text } from '../util.ts'

export const TASK_SELECT = `SELECT t.id, t.project_id AS "projectId", t.title, t.done, t.due_date AS due, u.name AS owner,
    (p.archived_at IS NOT NULL OR c.archived_at IS NOT NULL) AS hidden
  FROM tasks t JOIN projects p ON p.id = t.project_id JOIN clients c ON c.id = p.client_id JOIN users u ON u.id = t.created_by`

export const tasksRouter = Router()

tasksRouter.get('/', async (_req, res) => {
  const { rows } = await pool.query(`${TASK_SELECT} ORDER BY t.created_at, t.id`)
  res.json(rows)
})

tasksRouter.post('/', async (req, res) => {
  const b = parse(z.object({ projectId: id, title: text(160), due: isoDate.nullish() }), req.body)
  const project = (await pool.query('SELECT name, client_id FROM projects WHERE id = $1', [b.projectId])).rows[0]
  if (!project) throw new HttpError(404, 'Proyecto no encontrado')
  // La tarea y su aviso al equipo se confirman juntos.
  const taskId = await tx(async (c) => {
    const { rows } = await c.query('INSERT INTO tasks (project_id, title, due_date, created_by) VALUES ($1, $2, $3, $4) RETURNING id', [
      b.projectId,
      b.title,
      b.due ?? null,
      req.user!.id,
    ])
    await recordActivity(c, { kind: 'tarea_nueva', actorId: req.user!.id, subject: b.title, detail: project.name, clientId: project.client_id, projectId: b.projectId, taskId: rows[0].id })
    return rows[0].id as string
  })
  res.status(201).json((await pool.query(`${TASK_SELECT} WHERE t.id = $1`, [taskId])).rows[0])
})

tasksRouter.patch('/:id', async (req, res) => {
  const taskId = idParam(req.params.id)
  const b = parse(
    z
      .object({ done: z.boolean('done debe ser verdadero o falso').optional(), due: isoDate.nullable().optional() })
      .refine((v) => v.done !== undefined || v.due !== undefined, 'Envía done o due'),
    req.body,
  )
  // done ausente => no cambia; due ausente => no cambia, due null => borra la fecha.
  await tx(async (c) => {
    // Se bloquea la fila para saber si ESTE cambio es el que la completa (solo ese momento avisa; reabrir o repetir no).
    const cur = (
      await c.query(
        `SELECT t.done, t.title, p.id AS project_id, p.name AS project, p.client_id
         FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = $1 FOR UPDATE OF t`,
        [taskId],
      )
    ).rows[0]
    if (!cur) throw new HttpError(404, 'Tarea no encontrada')
    await c.query(
      `UPDATE tasks SET
         done = COALESCE($2::boolean, done),
         done_at = CASE WHEN $2::boolean IS NULL THEN done_at WHEN $2::boolean THEN COALESCE(done_at, now()) ELSE NULL END,
         due_date = CASE WHEN $3::boolean THEN $4::date ELSE due_date END
       WHERE id = $1`,
      [taskId, b.done ?? null, b.due !== undefined, b.due ?? null],
    )
    if (b.done === true && !cur.done)
      await recordActivity(c, { kind: 'tarea_completada', actorId: req.user!.id, subject: cur.title, detail: cur.project, clientId: cur.client_id, projectId: cur.project_id, taskId })
  })
  res.json((await pool.query(`${TASK_SELECT} WHERE t.id = $1`, [taskId])).rows[0])
})

tasksRouter.delete('/:id', async (req, res) => {
  await sendToTrash('tarea', idParam(req.params.id), req.user!.id)
  res.status(204).end()
})
