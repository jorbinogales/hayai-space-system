import { Router } from 'express'
import { z } from 'zod'
import { pool } from '../db.ts'
import { exec } from '../services/common.ts'
import { tareaActualizar, tareaCrear } from '../services/tareas.ts'
import { sendToTrash } from '../trash.ts'
import { id, idParam, isoDate, parse, text } from '../util.ts'

// owner = quien la creó; responsable = quien la lleva (el asignado y, sin asignar, el
// responsable del proyecto — la misma regla que la API v1 y el MCP). La web antes solo
// devolvía owner, así que la pantalla mostraba al creador como si fuera el responsable.
export const TASK_SELECT = `SELECT t.id, t.project_id AS "projectId", t.milestone_id AS "milestoneId", t.title, t.done, t.due_date AS due, u.name AS owner, t.assignee_id AS "assigneeId", COALESCE(au.name, po.name) AS responsable, (t.assignee_id IS NOT NULL) AS asignada, t.updated_at AS "updatedAt",
    (p.archived_at IS NOT NULL OR COALESCE(c.archived_at IS NOT NULL, false)) AS hidden
  FROM tasks t JOIN projects p ON p.id = t.project_id LEFT JOIN clients c ON c.id = p.client_id JOIN users u ON u.id = t.created_by LEFT JOIN users au ON au.id = t.assignee_id JOIN users po ON po.id = p.owner_id`

export const tasksRouter = Router()

tasksRouter.get('/', async (_req, res) => {
  const { rows } = await pool.query(`${TASK_SELECT} ORDER BY t.created_at, t.id`)
  res.json(rows)
})

// La web llama a los MISMOS servicios que la API v1 y el MCP (tarea nueva / completada avisan al equipo desde alli).
tasksRouter.post('/', async (req, res) => {
  const b = parse(z.object({ projectId: id, milestoneId: id.nullish(), title: text(160), due: isoDate.nullish(), responsable: text(40).nullish() }), req.body)
  const t = await exec(tareaCrear, req.user!, { titulo: b.title, proyecto_id: b.projectId, hito_id: b.milestoneId, vence: b.due, responsable: b.responsable ?? undefined })
  res.status(201).json((await pool.query(`${TASK_SELECT} WHERE t.id = $1`, [t.id])).rows[0])
})

tasksRouter.patch('/:id', async (req, res) => {
  const taskId = idParam(req.params.id)
  const b = parse(
    z
      .object({ done: z.boolean('done debe ser verdadero o falso').optional(), due: isoDate.nullable().optional(), milestoneId: id.nullable().optional(), titulo: text(160).optional(), responsable: text(40).nullable().optional() })
      .refine((v) => v.done !== undefined || v.due !== undefined || v.milestoneId !== undefined || v.titulo !== undefined || v.responsable !== undefined, 'Envía done, due, milestoneId, titulo o responsable'),
    req.body,
  )
  // done ausente => no cambia; due ausente => no cambia, due null => borra la fecha; milestoneId null => la suelta del hito.
  // responsable null => la tarea vuelve al responsable del proyecto (no cambia el responsable del proyecto).
  await exec(tareaActualizar, req.user!, {
    id: taskId,
    estado: b.done === undefined ? undefined : b.done ? 'completada' : 'pendiente',
    vence: b.due,
    hito_id: b.milestoneId,
    titulo: b.titulo,
    responsable: b.responsable === undefined ? undefined : b.responsable,
  })
  res.json((await pool.query(`${TASK_SELECT} WHERE t.id = $1`, [taskId])).rows[0])
})

tasksRouter.delete('/:id', async (req, res) => {
  await sendToTrash('tarea', idParam(req.params.id), req.user!.id)
  res.status(204).end()
})
