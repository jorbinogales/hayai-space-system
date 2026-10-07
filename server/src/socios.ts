// Socios (usuarios) por nombre. Hoja del grafo de imports (db/util): la usan cobros, tareas, acuerdos y el hub.
import type { Db } from './db.ts'
import { HttpError } from './util.ts'

/** Socio activo por nombre (sin importar mayúsculas). 404 con los nombres válidos si no existe. */
export async function userByName(c: Db, name: string, field = 'responsable'): Promise<{ id: string; name: string }> {
  const rows = (await c.query('SELECT id, name FROM users WHERE active ORDER BY name')).rows as { id: string; name: string }[]
  const u = rows.find((r) => r.name.toLowerCase() === name.trim().toLowerCase())
  if (!u) throw new HttpError(404, `${field}: no hay un socio llamado "${name}" (${rows.map((r) => r.name).join(', ')})`)
  return u
}
