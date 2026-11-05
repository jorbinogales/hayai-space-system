import { Router } from 'express'
import { pool } from '../db.ts'
import { memberSql } from '../socios.ts'
import { tid } from '../tenant.ts'

export const usersRouter = Router()

// Socios del tenant activo (sus miembros y los ADMIN, que son globales).
usersRouter.get('/', async (_req, res) => {
  const { rows } = await pool.query(`SELECT u.id, u.name, u.avatar FROM users u WHERE ${memberSql('u', '$1')} ORDER BY u.created_at, u.name`, [tid()])
  res.json(rows)
})
