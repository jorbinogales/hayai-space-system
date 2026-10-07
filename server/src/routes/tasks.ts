import { Router } from 'express'
import { z } from 'zod'
import { pool } from '../db.ts'
import { exec } from '../services/common.ts'
import { tareaActualizar, tareaCrear } from '../services/tareas.ts'
import { sendToTrash } from '../trash.ts'
import { id, idParam, isoDate, parse, text } from '../util.ts'

export const TASK_SELECT = `SELECT t.id, t.project_id AS "projectId", t.milestone_id AS "milestoneId", t.title, t.done, t.due_date AS due, u.name AS owner, t.updated_at AS "updatedAt",
    (p.archived_at IS NOT NULL OR COALESCE(c.archived_at IS NOT NULL, false)) AS hidden
  FROM tasks t JOIN projects p ON p.id = t.project_id LEFT JOIN clients c ON c.id = p.client_id JOIN users u ON u.id = t.created_by`

export const tasksRouter = Router()

tasksRouter.get('/', async (_req, res) => {
  const { rows } = await pool.query(`${TASK_SELECT} ORDER BY t.created_at, t.id`)
  res.json(rows)
})

// La web llama a los MISMOS servicios que la API v1 y el MCP (tarea nueva / completada avisan al equipo desde alli).
tasksRouter.post('/', async (req, res) => {
  const b = parse(z.object({ projectId: id, milestoneId: id.nullish(), title: text(160), due: isoDate.nullish() }), req.body)
  const t = await exec(tareaCrear, req.user!, { titulo: b.title, proyecto_id: b.projectId, hito_id: b.milestoneId, vence: b.due })
  res.status(201).json((await pool.query(`${TASK_SELECT} WHERE t.id = $1`, [t.id])).rows[0])
})

tasksRouter.patch('/:id', async (req, res) => {
  const taskId = idParam(req.params.id)
  const b = parse(
    z
      .object({ done: z.boolean('done debe ser verdadero o falso').optional(), due: isoDate.nullable().optional(), milestoneId: id.nullable().optional() })
      .refine((v) => v.done !== undefined || v.due !== undefined || v.milestoneId !== undefined, 'Envía done, due o milestoneId'),
    req.body,
  )
  // done ausente => no cambia; due ausente => no cambia, due null => borra la fecha; milestoneId null => la suelta del hito.
  await exec(tareaActualizar, req.user!, {
    id: taskId,
    estado: b.done === undefined ? undefined : b.done ? 'completada' : 'pendiente',
    vence: b.due,
    hito_id: b.milestoneId,
  })
  res.json((await pool.query(`${TASK_SELECT} WHERE t.id = $1`, [taskId])).rows[0])
})

tasksRouter.delete('/:id', async (req, res) => {
  await sendToTrash('tarea', idParam(req.params.id), req.user!.id)
  res.status(204).end()
})
