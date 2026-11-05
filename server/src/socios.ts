// Socios (usuarios) por nombre. Hoja del grafo de imports (db/util/tenant): la usan cobros, tareas, acuerdos y el hub.
// Los socios de un tenant son sus miembros (user_tenants) más los ADMIN, que son globales y cuentan como miembros de todos.
import type { Db } from './db.ts'
import { tid } from './tenant.ts'
import { HttpError } from './util.ts'

/** Condición SQL «el usuario `alias` es socio activo del tenant $param» (ADMIN incluidos). */
export const memberSql = (alias: string, param: string) =>
  `(${alias}.active AND (${alias}.role = 'ADMIN' OR EXISTS (SELECT 1 FROM user_tenants ut WHERE ut.user_id = ${alias}.id AND ut.tenant_id = ${param})))`

/** Socios activos del tenant en curso, por nombre. */
export async function tenantMembers(c: Db): Promise<{ id: string; name: string; avatar: string }[]> {
  return (await c.query(`SELECT u.id, u.name, u.avatar FROM users u WHERE ${memberSql('u', '$1')} ORDER BY u.name`, [tid()])).rows
}

/** Socio activo del tenant en curso por nombre (sin importar mayúsculas). 404 con los nombres válidos si no existe. */
export async function userByName(c: Db, name: string, field = 'responsable'): Promise<{ id: string; name: string }> {
  const rows = await tenantMembers(c)
  const u = rows.find((r) => r.name.toLowerCase() === name.trim().toLowerCase())
  if (!u) throw new HttpError(404, `${field}: no hay un socio llamado "${name}" (${rows.map((r) => r.name).join(', ')})`)
  return u
}

/** Id de un socio del tenant en curso por nombre, o null (las rutas de la web que responden su propio 404). */
export async function memberIdByName(c: Db, name: string): Promise<string | null> {
  const { rows } = await c.query(`SELECT u.id FROM users u WHERE lower(u.name) = lower($1) AND ${memberSql('u', '$2')}`, [name, tid()])
  return rows[0]?.id ?? null
}
