import { Router } from 'express'
import { z } from 'zod'
import { pool } from '../db.ts'
import { HttpError, id, idParam, isoDate, money, parse, text } from '../util.ts'

const SELECT = `SELECT e.id, e.date, e.concept, e.amount, e.category, e.scope,
    COALESCE(c.name, p.name) AS ref, COALESCE(e.client_id, e.project_id) AS "refId", u.name AS owner
  FROM expenses e
  LEFT JOIN clients c ON c.id = e.client_id
  LEFT JOIN projects p ON p.id = e.project_id
  JOIN users u ON u.id = e.created_by`

const newExpense = z
  .object({
    date: isoDate,
    concept: text(120),
    amount: money,
    category: z.enum(['Herramientas', 'Infraestructura', 'Operación', 'Marketing', 'Equipos', 'Otros'], 'Categoría inválida'),
    scope: z.enum(['general', 'cliente', 'proyecto'], 'Ámbito inválido'),
    refId: id.nullish(),
  })
  .refine((b) => b.scope === 'general' || b.refId, { path: ['refId'], message: 'Selecciona el cliente o proyecto del gasto' })

export const expensesRouter = Router()

expensesRouter.get('/', async (_req, res) => {
  const { rows } = await pool.query(`${SELECT} ORDER BY e.date DESC, e.created_at DESC, e.id`)
  res.json(rows)
})

expensesRouter.post('/', async (req, res) => {
  const b = parse(newExpense, req.body)
  // El esquema exige client_id solo con scope=cliente, project_id solo con proyecto, y ninguno con general.
  const clientId = b.scope === 'cliente' ? b.refId! : null
  const projectId = b.scope === 'proyecto' ? b.refId! : null
  if (clientId && !(await pool.query('SELECT 1 FROM clients WHERE id = $1', [clientId])).rowCount)
    throw new HttpError(404, 'Cliente no encontrado')
  if (projectId && !(await pool.query('SELECT 1 FROM projects WHERE id = $1', [projectId])).rowCount)
    throw new HttpError(404, 'Proyecto no encontrado')

  const { rows } = await pool.query(
    `INSERT INTO expenses (date, concept, amount, category, scope, client_id, project_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [b.date, b.concept, b.amount, b.category, b.scope, clientId, projectId, req.user!.id],
  )
  res.status(201).json((await pool.query(`${SELECT} WHERE e.id = $1`, [rows[0].id])).rows[0])
})

expensesRouter.delete('/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM expenses WHERE id = $1', [idParam(req.params.id)])
  if (!rowCount) throw new HttpError(404, 'Gasto no encontrado')
  res.status(204).end()
})
