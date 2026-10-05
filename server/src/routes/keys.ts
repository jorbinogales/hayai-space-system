// Llaves de API propias: cada socio crea y revoca las suyas desde la web (sesion + PIN). Una llave actua como su dueño.
import { Router } from 'express'
import { z } from 'zod'
import { checkPin, lockedError } from '../auth.ts'
import { pool } from '../db.ts'
import { generateApiKey, SCOPES } from '../v1/apiKey.ts'
import { HttpError, idParam, parse, text } from '../util.ts'

export const keysRouter = Router()

const MAX_ACTIVE = 10

const KEY_SELECT = `SELECT id, name, prefix, scopes, created_at, last_used_at FROM api_keys`
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const out = (r: any) => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  scopes: r.scopes as string[],
  createdAt: r.created_at.toISOString(),
  lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
})

keysRouter.get('/', async (req, res) => {
  const { rows } = await pool.query(`${KEY_SELECT} WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC, id`, [req.user!.id])
  res.json(rows.map(out))
})

const newKey = z.object({
  name: text(60),
  scopes: z
    .array(z.enum(SCOPES, 'Permiso inválido'))
    .min(1, 'Elige al menos un permiso')
    .transform((v) => [...new Set(v)]),
  pin: z.string('PIN inválido').regex(/^\d{6}$/, 'El PIN debe tener 6 dígitos numéricos'),
})

// Pide el PIN: una sesion robada no puede dejarse una llave con permisos de borrado que sobreviva al cierre de sesion.
keysRouter.post('/', async (req, res) => {
  const b = parse(newKey, req.body)
  const me = req.user!
  const { rows: u } = await pool.query(
    `SELECT pin_hash, GREATEST(0, CEIL(EXTRACT(EPOCH FROM (locked_until - now()))))::int AS lock_secs FROM users WHERE id = $1`,
    [me.id],
  )
  const lock = await checkPin(me.id, b.pin, u[0].pin_hash, u[0].lock_secs)
  if (lock !== null) {
    if (lock > 0) {
      res.setHeader('Retry-After', lock)
      throw lockedError(lock)
    }
    throw new HttpError(403, 'El PIN es incorrecto')
  }

  const active = (await pool.query('SELECT count(*)::int AS n FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL', [me.id])).rows[0].n
  if (active >= MAX_ACTIVE) throw new HttpError(409, `Máximo ${MAX_ACTIVE} llaves activas. Revoca alguna que ya no uses`)

  const k = generateApiKey()
  const { rows } = await pool.query(
    `INSERT INTO api_keys (user_id, name, prefix, key_hash, scopes) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, prefix, scopes, created_at, last_used_at`,
    [me.id, b.name, k.prefix, k.hash, b.scopes],
  )
  // La llave en claro solo viaja en esta respuesta; en la BD queda su hash.
  res.status(201).json({ ...out(rows[0]), key: k.key })
})

keysRouter.delete('/:id', async (req, res) => {
  const { rowCount } = await pool.query(
    'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
    [idParam(req.params.id), req.user!.id],
  )
  if (!rowCount) throw new HttpError(404, 'Llave no encontrada')
  res.status(204).end()
})
