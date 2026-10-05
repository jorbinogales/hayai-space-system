import { Router } from 'express'
import { z } from 'zod'
import { pool } from '../db.ts'
import { sendToTrash } from '../trash.ts'
import { HttpError, id, idParam, isoDate, parse, text } from '../util.ts'

export const PROJECT_SELECT = `SELECT p.id, p.name, p.icon, u.name AS owner, c.name AS client, p.client_id AS "clientId",
    p.status, p.due_date AS due, p.archived_at IS NOT NULL AS archived, c.archived_at IS NOT NULL AS "clientArchived"
  FROM projects p JOIN users u ON u.id = p.owner_id JOIN clients c ON c.id = p.client_id`

export const projectIcon = z.enum(['globe', 'phone', 'chart', 'cart', 'palette', 'box', 'code'], 'Icono inválido')

const newProject = z.object({
  name: text(80),
  icon: projectIcon,
  clientId: id,
  owner: text(80),
  status: z.enum(['activo', 'entrega', 'planeacion'], 'Estado inválido').default('planeacion'),
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
  const client = (await pool.query('SELECT 1 FROM clients WHERE id = $1', [b.clientId])).rowCount
  if (!client) throw new HttpError(404, 'Cliente no encontrado')

  const { rows } = await pool.query(
    `INSERT INTO projects (name, icon, client_id, owner_id, status, due_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [b.name, b.icon, b.clientId, owner.id, b.status, b.due ?? null, req.user!.id],
  )
  res.status(201).json((await pool.query(`${PROJECT_SELECT} WHERE p.id = $1`, [rows[0].id])).rows[0])
})

const editProject = z
  .object({
    name: text(80).optional(),
    icon: projectIcon.optional(),
    clientId: id.optional(),
    owner: text(80).optional(),
    status: z.enum(['activo', 'entrega', 'planeacion'], 'Estado inválido').optional(),
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

  const { rowCount } = await pool.query(
    `UPDATE projects SET name = COALESCE($2, name), icon = COALESCE($3, icon), client_id = COALESCE($4::uuid, client_id),
       owner_id = COALESCE($5::uuid, owner_id), status = COALESCE($6, status),
       due_date = CASE WHEN $7::boolean THEN $8::date ELSE due_date END
     WHERE id = $1`,
    [projectId, b.name ?? null, b.icon ?? null, b.clientId ?? null, ownerId, b.status ?? null, b.due !== undefined, b.due ?? null],
  )
  if (!rowCount) throw new HttpError(404, 'Proyecto no encontrado')
  res.json((await pool.query(`${PROJECT_SELECT} WHERE p.id = $1`, [projectId])).rows[0])
})
