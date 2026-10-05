import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { pool } from './db.ts'
import { HttpError } from './util.ts'

export const COOKIE = 'hayai_sid'
export const SESSION_DAYS = 7
export const MAX_ATTEMPTS = 5
export const LOCK_MINUTES = 15
export const INITIAL_PIN = '000000'

const isProd = process.env.NODE_ENV === 'production'
export const cookieOpts = {
  httpOnly: true,
  sameSite: 'lax' as const,
  // Secure en producción; COOKIE_SECURE=false solo para probar un build de producción por http en local.
  secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE !== 'false' : isProd,
  path: '/',
}

export type SessionUser = {
  id: string
  name: string
  avatar: string
  role: string
  mustChangePin: boolean
  /** Solo en llamadas con llave de API: sus permisos (read | write | delete) y de donde viene, para la papelera. */
  scopes?: string[]
  via?: string
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionUser
    sessionId?: string
  }
}

// ---------- PIN: scrypt$N$r$p$salt$hash (base64) ----------
const N = 16384
const R = 8
const P = 1
const KEYLEN = 64

const derive = (pin: string, salt: Buffer, n: number, r: number, p: number, len: number) =>
  new Promise<Buffer>((res, rej) =>
    scrypt(pin, salt, len, { N: n, r, p, maxmem: 256 * n * r }, (e, k) => (e ? rej(e) : res(k))),
  )

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await derive(pin, salt, N, R, P, KEYLEN)
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPinHash(pin: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$')
  if (alg !== 'scrypt' || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  const key = await derive(pin, Buffer.from(salt, 'base64'), +n, +r, +p, expected.length)
  return key.length === expected.length && timingSafeEqual(key, expected)
}

// Hash falso para que "usuario inexistente" tarde lo mismo que "PIN incorrecto".
const dummyHash = hashPin('dummy-not-a-real-pin')
export const burnTime = async (pin: string) => void (await verifyPinHash(pin, await dummyHash))

/**
 * Comprueba el PIN de un usuario con bloqueo anti fuerza bruta.
 * Devuelve null si es correcto; los segundos de bloqueo (>0) si está o quedó bloqueado; 0 si solo falló.
 */
export async function checkPin(userId: string, pin: string, pinHash: string, lockSecs: number): Promise<number | null> {
  if (lockSecs > 0) return lockSecs
  if (await verifyPinHash(pin, pinHash)) {
    await pool.query(
      'UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1 AND (failed_attempts <> 0 OR locked_until IS NOT NULL)',
      [userId],
    )
    return null
  }
  // UPDATE atómico: dos fallos en paralelo no se pisan el contador.
  // ponytail: el chequeo de bloqueo previo no es atómico con este UPDATE; un burst paralelo puede colar unos pocos intentos extra (acotado por el límite por IP).
  const { rows } = await pool.query(
    `UPDATE users SET
       failed_attempts = CASE WHEN failed_attempts + 1 >= $2 THEN 0 ELSE failed_attempts + 1 END,
       locked_until    = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
     WHERE id = $1
     RETURNING CEIL(EXTRACT(EPOCH FROM (locked_until - now())))::int AS lock_secs`,
    [userId, MAX_ATTEMPTS, LOCK_MINUTES],
  )
  return Math.max(0, rows[0]?.lock_secs ?? 0)
}

export const lockedError = (secs: number) =>
  new HttpError(423, `Cuenta bloqueada por demasiados intentos. Intenta de nuevo en ${secs} s`, { retryAfter: secs })

// ---------- sesiones ----------
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export async function createSession(res: Response, userId: string) {
  const token = randomBytes(32).toString('base64url')
  await pool.query(
    'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))',
    [userId, sha256(token), SESSION_DAYS],
  )
  pool.query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {}) // limpieza oportunista
  res.cookie(COOKIE, token, { ...cookieOpts, maxAge: SESSION_DAYS * 86_400_000 })
}

export const clearSessionCookie = (res: Response) => void res.clearCookie(COOKIE, cookieOpts)

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
}

export const sessionJson = (u: SessionUser) => ({
  id: u.id,
  name: u.name,
  avatar: u.avatar,
  role: u.role,
  mustChangePin: u.mustChangePin,
})

export async function requireSession(req: Request, res: Response, next: NextFunction) {
  const token = readCookie(req, COOKIE)
  if (token) {
    const { rows } = await pool.query(
      `SELECT s.id AS sid, u.id, u.name, u.avatar, u.role, u.must_change_pin
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`,
      [sha256(token)],
    )
    const r = rows[0]
    if (r) {
      req.sessionId = r.sid
      req.user = { id: r.id, name: r.name, avatar: r.avatar, role: r.role, mustChangePin: r.must_change_pin }
      return next()
    }
    clearSessionCookie(res)
  }
  throw new HttpError(401, 'Sesión no válida o expirada')
}

/** Con el PIN inicial sin cambiar, solo /auth/me, /auth/change-pin y /auth/logout (que no pasan por aquí). */
export function requirePinChanged(req: Request, res: Response, next: NextFunction) {
  if (req.user?.mustChangePin) return void res.status(403).json({ error: 'pin_change_required' })
  next()
}

// ---------- límite por IP en memoria ----------
// ponytail: un solo proceso; con varias instancias, mover el contador a la BD.
const hits = new Map<string, { n: number; reset: number }>()
export function rateLimit(bucket: string, max: number, windowMs = 15 * 60_000) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const now = Date.now()
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k)
    const key = `${bucket}:${req.ip}`
    const h = hits.get(key)
    if (!h || h.reset < now) hits.set(key, { n: 1, reset: now + windowMs })
    else if (++h.n > max)
      throw new HttpError(429, 'Demasiados intentos. Espera unos minutos', { retryAfter: Math.ceil((h.reset - now) / 1000) })
    next()
  }
}
