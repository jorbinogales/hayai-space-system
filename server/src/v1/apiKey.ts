import { createHash, randomBytes } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { pool } from '../db.ts'
import { HttpError } from '../util.ts'

export const KEY_PREFIX = 'hy_'

export const SCOPES = ['read', 'write', 'delete'] as const
export type Scope = (typeof SCOPES)[number]
export const SCOPE_LABEL: Record<Scope, string> = { read: 'lectura', write: 'escritura', delete: 'borrado' }

declare module 'express-serve-static-core' {
  interface Request {
    apiKey?: { id: string; name: string; prefix: string; scopes: Scope[] }
  }
}

/** Falla con 403 si la llave no tiene el permiso. */
export function requireScope(req: { apiKey?: { scopes: Scope[] } }, scope: Scope) {
  if (!req.apiKey?.scopes.includes(scope))
    throw new HttpError(403, `Esta llave no tiene permiso de ${SCOPE_LABEL[scope]}`, { required_scope: scope })
}

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex')

/** Llave de 256 bits al azar. Se muestra una vez; en la BD solo queda el hash. */
export function generateApiKey() {
  const key = KEY_PREFIX + randomBytes(32).toString('base64url')
  return { key, hash: hashKey(key), prefix: key.slice(0, KEY_PREFIX.length + 8) }
}

// ---------- limite de intentos fallidos por IP (en memoria) ----------
// ponytail: un solo proceso; con varias instancias, mover el contador a la BD.
const FAIL_MAX = Number(process.env.V1_AUTH_FAIL_MAX ?? 30)
const FAIL_WINDOW_MS = 15 * 60_000
const fails = new Map<string, { n: number; reset: number }>()

function failedFrom(ip: string | undefined) {
  const key = ip ?? '?'
  const now = Date.now()
  if (fails.size > 5000) for (const [k, v] of fails) if (v.reset < now) fails.delete(k)
  const f = fails.get(key)
  if (!f || f.reset < now) fails.set(key, { n: 1, reset: now + FAIL_WINDOW_MS })
  else f.n++
}

function assertNotBlocked(ip: string | undefined) {
  const f = fails.get(ip ?? '?')
  if (f && f.reset > Date.now() && f.n > FAIL_MAX)
    throw new HttpError(429, 'Demasiados intentos con llaves inválidas. Espera unos minutos', {
      retryAfter: Math.ceil((f.reset - Date.now()) / 1000),
    })
}

/**
 * Autentica con el header X-API-Key. Deja en req.user al socio dueño de la llave (las escrituras se le atribuyen).
 * No acepta la cookie de sesion de la web: una llave y una sesion son cosas distintas.
 */
export async function apiKeyAuth(req: Request, _res: Response, next: NextFunction) {
  assertNotBlocked(req.ip)
  const raw = req.headers['x-api-key']
  const key = typeof raw === 'string' ? raw.trim() : ''
  const reject = () => {
    failedFrom(req.ip)
    return new HttpError(401, 'API key ausente o inválida (header X-API-Key)')
  }
  if (!key.startsWith(KEY_PREFIX) || key.length > 200) throw reject()

  const { rows } = await pool.query(
    `SELECT k.id AS key_id, k.name AS key_name, k.prefix, k.scopes, u.id, u.name, u.avatar, u.role
     FROM api_keys k JOIN users u ON u.id = k.user_id
     WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND u.active`,
    [hashKey(key)],
  )
  const r = rows[0]
  if (!r) throw reject()

  const scopes = r.scopes as Scope[]
  req.user = { id: r.id, name: r.name, avatar: r.avatar, role: r.role, mustChangePin: false, scopes, via: `api:${r.key_name}` }
  req.apiKey = { id: r.key_id, name: r.key_name, prefix: r.prefix, scopes }
  // last_used_at como mucho una vez por minuto: no escribimos en la BD en cada llamada.
  pool
    .query(
      `UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
      [r.key_id],
    )
    .catch(() => {})
  next()
}

// ---------- limite por llave (en memoria) ----------
const buckets = new Map<string, { n: number; reset: number }>()

/** Ventana fija por llave. Debe ir despues de apiKeyAuth. */
export function keyRateLimit(max = Number(process.env.V1_RATE_MAX ?? 120), windowMs = 60_000) {
  return (req: Request, res: Response, next: NextFunction) => {
    const id = req.apiKey?.id ?? req.ip ?? '?'
    const now = Date.now()
    if (buckets.size > 5000) for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k)
    let b = buckets.get(id)
    if (!b || b.reset < now) buckets.set(id, (b = { n: 0, reset: now + windowMs }))
    b.n++
    res.setHeader('RateLimit-Limit', max)
    res.setHeader('RateLimit-Remaining', Math.max(0, max - b.n))
    if (b.n > max) {
      const retryAfter = Math.ceil((b.reset - now) / 1000)
      res.setHeader('Retry-After', retryAfter)
      throw new HttpError(429, 'Demasiadas solicitudes. Espera un momento', { retryAfter })
    }
    next()
  }
}
