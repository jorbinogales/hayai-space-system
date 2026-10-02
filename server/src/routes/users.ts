import { Router } from 'express'
import { pool } from '../db.ts'

export const usersRouter = Router()

usersRouter.get('/', async (_req, res) => {
  const { rows } = await pool.query('SELECT id, name, avatar FROM users WHERE active ORDER BY created_at, name')
  res.json(rows)
})
