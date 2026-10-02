import { Router } from 'express'
import { z } from 'zod'
import { pool } from '../db.ts'
import { HttpError, id, idParam, isoDate, parse, text } from '../util.ts'

export const TASK_SELECT = `SELECT t.id, t.project_id AS "projectId", t.title, t.done, t.due_date AS due, u.name AS owner
  FROM tasks t JOIN users u ON u.id = t.created_by`

export const tasksRouter = Router()

tasksRouter.get('/', async (_req, res) => {
  const { rows } = await pool.query(`${TASK_SELECT} ORDER BY t.created_at, t.id`)
  res.json(rows)
})

tasksRouter.post('/', async (req, res) => {
  const b = parse(z.object({ projectId: id, title: text(160), due: isoDate.nullish() }), req.body)
  if (!(await pool.query('SELECT 1 FROM projects WHERE id = $1', [b.projectId])).rowCount)
    throw new HttpError(404, 'Proyecto no encontrado')
  const { rows } = await pool.query('INSERT INTO tasks (project_id, title, due_date, created_by) VALUES ($1, $2, $3, $4) RETURNING id', [
    b.projectId,
    b.title,
    b.due ?? null,
    req.user!.id,
  ])
  res.status(201).json((await pool.query(`${TASK_SELECT} WHERE t.id = $1`, [rows[0].id])).rows[0])
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
  const { rowCount } = await pool.query(
    `UPDATE tasks SET
       done = COALESCE($2::boolean, done),
       done_at = CASE WHEN $2::boolean IS NULL THEN done_at WHEN $2::boolean THEN COALESCE(done_at, now()) ELSE NULL END,
       due_date = CASE WHEN $3::boolean THEN $4::date ELSE due_date END
     WHERE id = $1`,
    [taskId, b.done ?? null, b.due !== undefined, b.due ?? null],
  )
  if (!rowCount) throw new HttpError(404, 'Tarea no encontrada')
  res.json((await pool.query(`${TASK_SELECT} WHERE t.id = $1`, [taskId])).rows[0])
})

tasksRouter.delete('/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM tasks WHERE id = $1', [idParam(req.params.id)])
  if (!rowCount) throw new HttpError(404, 'Tarea no encontrada')
  res.status(204).end()
})
