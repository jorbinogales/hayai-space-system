import { Router } from 'express'
import { z } from 'zod'
import { pool } from '../db.ts'
import { sendToTrash } from '../trash.ts'
import { projectIcon, projectStateOut } from '../services/common.ts'
import { actualizarProyecto } from '../services/proyectos.ts'
import { HttpError, id, idParam, isoDate, parse, text } from '../util.ts'

// client puede ser null: un proyecto interno no tiene cliente.
export const PROJECT_SELECT = `SELECT p.id, p.name, p.description, p.icon, u.name AS owner, c.name AS client, p.client_id AS "clientId", p.updated_at AS "updatedAt",
    p.status, p.due_date AS due, p.archived_at IS NOT NULL AS archived, COALESCE(c.archived_at IS NOT NULL, false) AS "clientArchived"
  FROM projects p JOIN users u ON u.id = p.owner_id LEFT JOIN clients c ON c.id = p.client_id`

const STATES = ['activo', 'entrega', 'planeacion', 'pausado', 'completado'] as const
export { projectIcon }

const newProject = z.object({
  name: text(80),
  description: text(4000).nullish(),
  icon: projectIcon,
  clientId: id.nullish(),
  owner: text(80),
  status: z.enum(STATES, 'Estado inválido').default('planeacion'),
  due: isoDate.nullish(),
})

export const projectsRouter = Router()

projectsRouter.get('/', async (_req, res) => {
  const { rows } = await pool.query(`${PROJECT_SELECT} ORDER BY p.created_at, p.id`)
  res.json(rows)
})

projectsRouter.post('/', async (req, res) => {
  const b = parse(newProject, req.body)
  const owner = (await pool.query('SELECT id FROM users WHERE lower(name) = lower($1) AND active', [b.owner])).rows[0]
  if (!owner) throw new HttpError(404, 'Responsable no encontrado')
  if (b.clientId && !(await pool.query('SELECT 1 FROM clients WHERE id = $1', [b.clientId])).rowCount) throw new HttpError(404, 'Cliente no encontrado')

  const { rows } = await pool.query(
    `INSERT INTO projects (name, description, icon, client_id, owner_id, status, due_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [b.name, b.description ?? null, b.icon, b.clientId ?? null, owner.id, b.status, b.due ?? null, req.user!.id],
  )
  res.status(201).json((await pool.query(`${PROJECT_SELECT} WHERE p.id = $1`, [rows[0].id])).rows[0])
})

const editProject = z
  .object({
    name: text(80).optional(),
    description: text(4000).nullable().optional(),
    icon: projectIcon.optional(),
    clientId: id.nullable().optional(), // null = proyecto interno
    owner: text(80).optional(),
    status: z.enum(STATES, 'Estado inválido').optional(),
    due: isoDate.nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Envía al menos un campo a modificar')

// "Borrar" manda el proyecto con sus tareas y gastos a la papelera, donde se restaura.
projectsRouter.delete('/:id', async (req, res) => {
  await sendToTrash('proyecto', idParam(req.params.id), req.user!.id)
  res.status(204).end()
})

for (const [action, value] of [['archive', 'now()'], ['unarchive', 'NULL']] as const) {
  projectsRouter.post(`/:id/${action}`, async (req, res) => {
    const projectId = idParam(req.params.id)
    const { rowCount } = await pool.query(`UPDATE projects SET archived_at = ${value} WHERE id = $1`, [projectId])
    if (!rowCount) throw new HttpError(404, 'Proyecto no encontrado')
    res.json((await pool.query(`${PROJECT_SELECT} WHERE p.id = $1`, [projectId])).rows[0])
  })
}

// Solo cambia lo enviado; due: null borra la fecha.
projectsRouter.patch('/:id', async (req, res) => {
  const projectId = idParam(req.params.id)
  const b = parse(editProject, req.body)
  let ownerId: string | null = null
  if (b.owner !== undefined) {
    ownerId = (await pool.query('SELECT id FROM users WHERE lower(name) = lower($1) AND active', [b.owner])).rows[0]?.id
    if (!ownerId) throw new HttpError(404, 'Responsable no encontrado')
  }
  if (b.clientId && !(await pool.query('SELECT 1 FROM clients WHERE id = $1', [b.clientId])).rowCount)
    throw new HttpError(404, 'Cliente no encontrado')

  await actualizarProyecto({
    id: projectId,
    nombre: b.name,
    descripcion: b.description,
    icono: b.icon,
    cliente_id: b.clientId,
    responsable: b.owner,
    estado: b.status === undefined ? undefined : projectStateOut(b.status),
    entrega: b.due,
  })
  res.json((await pool.query(`${PROJECT_SELECT} WHERE p.id = $1`, [projectId])).rows[0])
})
