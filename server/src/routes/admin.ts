// Administración (solo ADMIN; requireAdmin va en app.ts). Global: no lleva X-Tenant-Id.
// Tenants (crear, listar, renombrar, desactivar), socios (crear con PIN inicial 000000, activar/desactivar, rol, resetear PIN) y sus
// accesos: qué tenants y qué módulos por tenant. Los ADMIN son globales: ven todo sin fila en user_tenants.
import { Router } from 'express'
import { z } from 'zod'
import { hashPin, INITIAL_PIN } from '../auth.ts'
import { pool, tx } from '../db.ts'
import { AVATAR_SEEDS } from '../services/common.ts'
import { MODULES } from '../tenant.ts'
import { HttpError, idParam, parse, text } from '../util.ts'

export const adminRouter = Router()

const modules = z.array(z.enum(MODULES, `Módulo inválido (${MODULES.join(', ')})`)).max(MODULES.length).transform((v) => [...new Set(v)])
const role = z.enum(['ADMIN', 'SOCIO'], 'Rol inválido (ADMIN o SOCIO)')
const avatar = z.enum(AVATAR_SEEDS as [string, ...string[]], `Avatar inválido (${AVATAR_SEEDS.join(', ')})`)

/** "Panadería La Estrella" -> "panaderia-la-estrella" (el CHECK de tenants.slug). */
export const slugify = (s: string) =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36).replace(/-+$/, '') || 'espacio'

// ---------- tenants ----------
const TENANT_SELECT = `SELECT t.id, t.name, t.slug, t.active, t.created_at,
    (SELECT count(*)::int FROM user_tenants ut JOIN users u ON u.id = ut.user_id WHERE ut.tenant_id = t.id AND u.active) AS miembros
  FROM tenants t`
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tenantOut = (r: any) => ({ id: r.id as string, name: r.name as string, slug: r.slug as string, active: r.active as boolean, members: r.miembros as number, createdAt: (r.created_at as Date).toISOString() })
const tenantOr404 = async (tenantId: string) => {
  const r = (await pool.query(`${TENANT_SELECT} WHERE t.id = $1`, [tenantId])).rows[0]
  if (!r) throw new HttpError(404, 'Tenant no encontrado')
  return tenantOut(r)
}

adminRouter.get('/tenants', async (_req, res) => {
  res.json((await pool.query(`${TENANT_SELECT} ORDER BY t.created_at, t.id`)).rows.map(tenantOut))
})

adminRouter.post('/tenants', async (req, res) => {
  const b = parse(z.strictObject({ name: text(80) }), req.body)
  const base = slugify(b.name)
  const id = await tx(async (c) => {
    if ((await c.query('SELECT 1 FROM tenants WHERE lower(name) = lower($1)', [b.name])).rowCount) throw new HttpError(409, `Ya existe un tenant llamado «${b.name}»`)
    const taken = new Set((await c.query(`SELECT slug FROM tenants WHERE slug = $1 OR slug LIKE $1 || '-%'`, [base])).rows.map((r) => r.slug as string))
    let slug = base
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`
    return (await c.query('INSERT INTO tenants (name, slug, created_by) VALUES ($1, $2, $3) RETURNING id', [b.name, slug, req.user!.id])).rows[0].id as string
  })
  res.status(201).json(await tenantOr404(id))
})

adminRouter.patch('/tenants/:id', async (req, res) => {
  const tenantId = idParam(req.params.id)
  const b = parse(z.strictObject({ name: text(80).optional(), active: z.boolean('active debe ser true o false').optional() }).refine((v) => v.name !== undefined || v.active !== undefined, 'Envía name o active'), req.body)
  const r = await pool.query('UPDATE tenants SET name = COALESCE($2, name), active = COALESCE($3, active) WHERE id = $1', [tenantId, b.name ?? null, b.active ?? null])
  if (!r.rowCount) throw new HttpError(404, 'Tenant no encontrado')
  res.json(await tenantOr404(tenantId))
})

// ---------- socios ----------
const USER_SELECT = `SELECT u.id, u.name, u.avatar, u.role, u.active, u.must_change_pin, u.created_at,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('tenantId', t.id, 'name', t.name, 'slug', t.slug, 'active', t.active, 'modules', ut.modules) ORDER BY t.created_at)
              FROM user_tenants ut JOIN tenants t ON t.id = ut.tenant_id WHERE ut.user_id = u.id), '[]'::jsonb) AS tenants
  FROM users u`
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const userOut = (r: any) => ({
  id: r.id as string,
  name: r.name as string,
  avatar: r.avatar as string,
  role: r.role as 'ADMIN' | 'SOCIO',
  active: r.active as boolean,
  mustChangePin: r.must_change_pin as boolean,
  createdAt: (r.created_at as Date).toISOString(),
  // ADMIN: global (entra a todo tenant activo con todos los módulos); esta lista son solo sus filas explícitas.
  tenants: r.tenants as { tenantId: string; name: string; slug: string; active: boolean; modules: string[] }[],
})
const userOr404 = async (userId: string) => {
  const r = (await pool.query(`${USER_SELECT} WHERE u.id = $1`, [userId])).rows[0]
  if (!r) throw new HttpError(404, 'Socio no encontrado')
  return userOut(r)
}

adminRouter.get('/users', async (_req, res) => {
  res.json((await pool.query(`${USER_SELECT} ORDER BY u.created_at, u.name`)).rows.map(userOut))
})

const assignment = z.strictObject({ tenantId: z.uuid('tenantId inválido'), modules })

adminRouter.post('/users', async (req, res) => {
  const b = parse(
    z.strictObject({ name: text(40), avatar: avatar.optional(), role: role.default('SOCIO'), tenants: z.array(assignment).max(100).default([]) }),
    req.body,
  )
  const pinHash = await hashPin(INITIAL_PIN)
  const id = await tx(async (c) => {
    if ((await c.query('SELECT 1 FROM users WHERE lower(name) = lower($1)', [b.name])).rowCount) throw new HttpError(409, `Ya existe un socio llamado «${b.name}»`)
    const uid = (
      await c.query(`INSERT INTO users (name, avatar, role, pin_hash, must_change_pin, active) VALUES ($1, $2, $3, $4, true, true) RETURNING id`, [
        b.name,
        b.avatar ?? AVATAR_SEEDS[Math.floor(Math.random() * AVATAR_SEEDS.length)],
        b.role,
        pinHash,
      ])
    ).rows[0].id as string
    for (const a of b.tenants) {
      if (!(await c.query('SELECT 1 FROM tenants WHERE id = $1', [a.tenantId])).rowCount) throw new HttpError(404, `Tenant no encontrado: ${a.tenantId}`)
      await c.query('INSERT INTO user_tenants (user_id, tenant_id, modules) VALUES ($1, $2, $3) ON CONFLICT (user_id, tenant_id) DO UPDATE SET modules = EXCLUDED.modules', [uid, a.tenantId, a.modules])
    }
    return uid
  })
  // El PIN inicial (000000) no viaja: es el de siempre. Al entrar, el socio debe cambiarlo (mustChangePin).
  res.status(201).json(await userOr404(id))
})

adminRouter.patch('/users/:id', async (req, res) => {
  const userId = idParam(req.params.id)
  const b = parse(
    z.strictObject({ active: z.boolean('active debe ser true o false').optional(), role: role.optional(), avatar: avatar.optional() }).refine((v) => Object.values(v).some((x) => x !== undefined), 'Envía active, role o avatar'),
    req.body,
  )
  // Un admin no puede dejarse fuera a sí mismo (desactivarse o quitarse el rol): siempre queda alguien que administre.
  if (userId === req.user!.id && (b.active === false || b.role === 'SOCIO')) throw new HttpError(409, 'No puedes desactivarte ni quitarte el rol de administrador a ti mismo')
  await tx(async (c) => {
    const r = await c.query('UPDATE users SET active = COALESCE($2, active), role = COALESCE($3, role), avatar = COALESCE($4, avatar) WHERE id = $1', [userId, b.active ?? null, b.role ?? null, b.avatar ?? null])
    if (!r.rowCount) throw new HttpError(404, 'Socio no encontrado')
    if (b.active === false) await c.query('DELETE FROM sessions WHERE user_id = $1', [userId]) // fuera al instante
  })
  res.json(await userOr404(userId))
})

adminRouter.post('/users/:id/reset-pin', async (req, res) => {
  const userId = idParam(req.params.id)
  const pinHash = await hashPin(INITIAL_PIN)
  await tx(async (c) => {
    const r = await c.query('UPDATE users SET pin_hash = $2, must_change_pin = true, failed_attempts = 0, locked_until = NULL WHERE id = $1', [userId, pinHash])
    if (!r.rowCount) throw new HttpError(404, 'Socio no encontrado')
    if (userId !== req.user!.id) await c.query('DELETE FROM sessions WHERE user_id = $1', [userId])
  })
  res.json(await userOr404(userId))
})

// Asignar (o cambiar los módulos de) un tenant a un socio. modules: [] = entra al tenant pero no ve ningún módulo.
adminRouter.put('/users/:id/tenants/:tenantId', async (req, res) => {
  const userId = idParam(req.params.id)
  const tenantId = idParam(req.params.tenantId)
  const b = parse(z.strictObject({ modules }), req.body)
  if (!(await pool.query('SELECT 1 FROM users WHERE id = $1', [userId])).rowCount) throw new HttpError(404, 'Socio no encontrado')
  if (!(await pool.query('SELECT 1 FROM tenants WHERE id = $1', [tenantId])).rowCount) throw new HttpError(404, 'Tenant no encontrado')
  await pool.query('INSERT INTO user_tenants (user_id, tenant_id, modules) VALUES ($1, $2, $3) ON CONFLICT (user_id, tenant_id) DO UPDATE SET modules = EXCLUDED.modules', [userId, tenantId, b.modules])
  res.json(await userOr404(userId))
})

adminRouter.delete('/users/:id/tenants/:tenantId', async (req, res) => {
  const userId = idParam(req.params.id)
  const r = await pool.query('DELETE FROM user_tenants WHERE user_id = $1 AND tenant_id = $2', [userId, idParam(req.params.tenantId)])
  if (!r.rowCount) throw new HttpError(404, 'Ese socio no tiene acceso a ese tenant')
  res.json(await userOr404(userId))
})
