import { Router } from 'express'
import { z } from 'zod'
import {
  burnTime,
  checkPin,
  clearSessionCookie,
  createSession,
  hashPin,
  INITIAL_PIN,
  lockedError,
  rateLimit,
  requireSession,
  sessionJson,
} from '../auth.ts'
import { pool, tx } from '../db.ts'
import { HttpError, parse, text } from '../util.ts'

const pin = z.string('PIN inválido').regex(/^\d{6}$/, 'El PIN debe tener 6 dígitos numéricos')
const loginMax = Number(process.env.LOGIN_IP_MAX ?? 30)

export const authRouter = Router()

const USER_BY_NAME = `SELECT id, name, avatar, role, must_change_pin, pin_hash,
  GREATEST(0, CEIL(EXTRACT(EPOCH FROM (locked_until - now()))))::int AS lock_secs
  FROM users WHERE lower(name) = lower($1) AND active`

// Existe para que la UI muestre el avatar del socio al escribir su nombre.
authRouter.post('/lookup', rateLimit('lookup', loginMax * 2), async (req, res) => {
  const { name } = parse(z.object({ name: text(80) }), req.body)
  const { rows } = await pool.query('SELECT name, avatar FROM users WHERE lower(name) = lower($1) AND active', [name])
  if (!rows[0]) throw new HttpError(404, 'No existe ese socio')
  res.json({ name: rows[0].name, avatar: rows[0].avatar })
})

authRouter.post('/login', rateLimit('login', loginMax), async (req, res) => {
  const body = parse(z.object({ name: text(80), pin }), req.body)
  const { rows } = await pool.query(USER_BY_NAME, [body.name])
  const u = rows[0]
  const generic = new HttpError(401, 'Nombre o PIN incorrectos')
  if (!u) {
    await burnTime(body.pin)
    throw generic
  }
  const lock = await checkPin(u.id, body.pin, u.pin_hash, u.lock_secs)
  if (lock === null) {
    await createSession(res, u.id)
    return void res.json(
      sessionJson({ id: u.id, name: u.name, avatar: u.avatar, role: u.role, mustChangePin: u.must_change_pin }),
    )
  }
  if (lock > 0) {
    res.setHeader('Retry-After', lock)
    throw lockedError(lock)
  }
  throw generic
})

authRouter.get('/me', requireSession, (req, res) => {
  res.json(sessionJson(req.user!))
})

authRouter.post('/logout', requireSession, async (req, res) => {
  await pool.query('DELETE FROM sessions WHERE id = $1', [req.sessionId])
  clearSessionCookie(res)
  res.status(204).end()
})

authRouter.post('/change-pin', requireSession, async (req, res) => {
  const body = parse(z.object({ currentPin: pin, newPin: pin }), req.body)
  if (body.newPin === body.currentPin) throw new HttpError(400, 'El PIN nuevo debe ser distinto del actual')
  if (body.newPin === INITIAL_PIN) throw new HttpError(400, 'El PIN nuevo no puede ser el PIN inicial')

  const me = req.user!
  const { rows } = await pool.query(
    `SELECT pin_hash, GREATEST(0, CEIL(EXTRACT(EPOCH FROM (locked_until - now()))))::int AS lock_secs FROM users WHERE id = $1`,
    [me.id],
  )
  // Cuenta como intento: una sesión robada no puede adivinar el PIN actual sin límite.
  const lock = await checkPin(me.id, body.currentPin, rows[0].pin_hash, rows[0].lock_secs)
  if (lock !== null) {
    if (lock > 0) {
      res.setHeader('Retry-After', lock)
      throw lockedError(lock)
    }
    throw new HttpError(403, 'El PIN actual es incorrecto')
  }

  const newHash = await hashPin(body.newPin)
  await tx(async (c) => {
    await c.query('UPDATE users SET pin_hash = $2, must_change_pin = false WHERE id = $1', [me.id, newHash])
    await c.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [me.id, req.sessionId])
  })
  res.json(sessionJson({ ...me, mustChangePin: false }))
})
