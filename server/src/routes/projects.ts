import { Router } from 'express'
import { z } from 'zod'
import { pool } from '../db.ts'
import { HttpError, id, isoDate, parse, text } from '../util.ts'

const SELECT = `SELECT p.id, p.name, p.icon, u.name AS owner, c.name AS client, p.client_id AS "clientId",
    p.status, p.due_date AS due
  FROM projects p JOIN users u ON u.id = p.owner_id JOIN clients c ON c.id = p.client_id`

const newProject = z.object({
  name: text(80),
  icon: z.enum(['globe', 'phone', 'chart', 'cart', 'palette', 'box', 'code'], 'Icono inválido'),
  clientId: id,
  owner: text(80),
  status: z.enum(['activo', 'entrega', 'planeacion'], 'Estado inválido').default('planeacion'),
  due: isoDate.nullish(),
})

export const projectsRouter = Router()

projectsRouter.get('/', async (_req, res) => {
  const { rows } = await pool.query(`${SELECT} ORDER BY p.created_at, p.id`)
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
  res.status(201).json((await pool.query(`${SELECT} WHERE p.id = $1`, [rows[0].id])).rows[0])
})
