// Papelera: borrar = mover a `trash`, no destruir. La foto guarda la fila y todo lo que cuelga de ella como jsonb;
// restaurar la vuelve a insertar con los MISMOS ids (jsonb_populate_recordset: no depende de la lista de columnas).
// La usan la web (DELETE /api/...), la API v1 y el MCP, asi que borrar es recuperable venga de donde venga.
import type { PoolClient } from 'pg'
import { pool, tx } from './db.ts'
import { HttpError } from './util.ts'

export const RETENTION_DAYS = 30
export type Entity = 'cliente' | 'proyecto' | 'pago' | 'gasto' | 'tarea'

type Row = Record<string, unknown>
type Snapshot = { root: Row; children: Record<string, Row[]>; label: string; detail: string | null }

const NOT_FOUND: Record<Entity, string> = {
  cliente: 'Cliente no encontrado',
  proyecto: 'Proyecto no encontrado',
  pago: 'Pago no encontrado',
  gasto: 'Gasto no encontrado',
  tarea: 'Tarea no encontrada',
}

// Tabla de cada entidad e hijos, en orden de insercion (los padres antes que los hijos). Lista cerrada: nunca viene del cliente.
const TABLE: Record<Entity, string> = { cliente: 'clients', proyecto: 'projects', pago: 'payments', gasto: 'expenses', tarea: 'tasks' }
const INSERT_ORDER: Record<Entity, string[]> = {
  cliente: ['clients', 'client_items', 'payments', 'projects', 'tasks', 'expenses'],
  proyecto: ['projects', 'tasks', 'expenses'],
  pago: ['payments'],
  gasto: ['expenses'],
  tarea: ['tasks'],
}

const rows = async (c: PoolClient, sql: string, params: unknown[]) =>
  (await c.query(`SELECT to_jsonb(t) AS j FROM (${sql}) t`, params)).rows.map((r) => r.j as Row)

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const money = (n: unknown) => `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`

/** Lee la fila y su descendencia (bloqueando la fila). null si no existe. */
async function snapshot(c: PoolClient, entity: Entity, entityId: string): Promise<Snapshot | null> {
  const root = (await rows(c, `SELECT * FROM ${TABLE[entity]} WHERE id = $1 FOR UPDATE`, [entityId]))[0]
  if (!root) return null

  if (entity === 'cliente') {
    const projects = await rows(c, 'SELECT * FROM projects WHERE client_id = $1', [entityId])
    const projectIds = projects.map((p) => p.id)
    const children = {
      client_items: await rows(c, 'SELECT * FROM client_items WHERE client_id = $1', [entityId]),
      payments: await rows(c, 'SELECT * FROM payments WHERE client_id = $1', [entityId]),
      projects,
      tasks: await rows(c, 'SELECT * FROM tasks WHERE project_id = ANY($1::uuid[])', [projectIds]),
      expenses: await rows(c, 'SELECT * FROM expenses WHERE client_id = $1 OR project_id = ANY($2::uuid[])', [entityId, projectIds]),
    }
    const parts = [
      plural(children.payments.length, 'cobro', 'cobros'),
      plural(projects.length, 'proyecto', 'proyectos'),
      plural(children.tasks.length, 'tarea', 'tareas'),
      plural(children.expenses.length, 'gasto', 'gastos'),
    ]
    return { root, children, label: String(root.name), detail: parts.join(', ') }
  }
  if (entity === 'proyecto') {
    const children = {
      tasks: await rows(c, 'SELECT * FROM tasks WHERE project_id = $1', [entityId]),
      expenses: await rows(c, 'SELECT * FROM expenses WHERE project_id = $1', [entityId]),
    }
    const owner = (await c.query('SELECT name FROM clients WHERE id = $1', [root.client_id])).rows[0]?.name
    const detail = [owner && `de ${owner}`, plural(children.tasks.length, 'tarea', 'tareas'), plural(children.expenses.length, 'gasto', 'gastos')]
    return { root, children, label: String(root.name), detail: detail.filter(Boolean).join(', ') }
  }
  if (entity === 'pago') {
    const owner = (await c.query('SELECT name FROM clients WHERE id = $1', [root.client_id])).rows[0]?.name
    return { root, children: {}, label: `${root.concept} · ${money(root.amount)}`, detail: owner ? `Cobro de ${owner}` : null }
  }
  if (entity === 'gasto') return { root, children: {}, label: `${root.concept} · ${money(root.amount)}`, detail: `Gasto del ${root.date}` }
  const project = (await c.query('SELECT name FROM projects WHERE id = $1', [root.project_id])).rows[0]?.name
  return { root, children: {}, label: String(root.title), detail: project ? `Tarea de ${project}` : null }
}

/** Los gastos de un proyecto no se borran solos (RESTRICT en el esquema); las tareas se van por CASCADE. */
async function deleteProjectRows(c: PoolClient, where: string, params: unknown[]) {
  await c.query(`DELETE FROM expenses WHERE project_id IN (SELECT id FROM projects WHERE ${where})`, params)
  await c.query(`DELETE FROM projects WHERE ${where}`, params)
}

/** Mueve a la papelera. `via` dice desde donde se borro ('web' o 'api:<llave>'). */
export async function sendToTrash(entity: Entity, entityId: string, userId: string, via = 'web') {
  return tx(async (c) => {
    // Limpieza oportunista de lo que ya paso la retencion: sin tareas programadas que mantener.
    await c.query('DELETE FROM trash WHERE deleted_at < now() - make_interval(days => $1)', [RETENTION_DAYS])
    const snap = await snapshot(c, entity, entityId)
    if (!snap) throw new HttpError(404, NOT_FOUND[entity])
    // La inicial es el desglose del cliente (client_items): se edita desde ahí, no se borra como un cobro más.
    if (entity === 'pago' && snap.root.kind === 'inicial') throw new HttpError(400, 'La inicial se edita desde sus ítems, no se borra como un pago')

    // Orden inverso al de insercion: primero lo que depende de otras filas.
    if (entity === 'cliente') {
      await c.query('DELETE FROM expenses WHERE client_id = $1', [entityId])
      await c.query('DELETE FROM payments WHERE client_id = $1', [entityId])
      await deleteProjectRows(c, 'client_id = $1', [entityId])
      await c.query('DELETE FROM clients WHERE id = $1', [entityId]) // client_items por CASCADE
    } else if (entity === 'proyecto') {
      await deleteProjectRows(c, 'id = $1', [entityId])
    } else {
      await c.query(`DELETE FROM ${TABLE[entity]} WHERE id = $1`, [entityId])
    }

    const { rows } = await c.query(
      `INSERT INTO trash (entity, entity_id, label, detail, data, via, deleted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, deleted_at`,
      [entity, entityId, snap.label, snap.detail, JSON.stringify({ root: snap.root, children: snap.children }), via, userId],
    )
    return {
      papelera_id: rows[0].id as string,
      entidad: entity,
      nombre: snap.label,
      resumen: snap.detail,
      restaurable_hasta: new Date(new Date(rows[0].deleted_at).getTime() + RETENTION_DAYS * 86_400_000).toISOString(),
    }
  })
}

export type TrashItem = {
  id: string
  entity: Entity
  label: string
  detail: string | null
  via: string
  deletedBy: string
  deletedAt: string
  expiresAt: string
}

export async function listTrash(): Promise<TrashItem[]> {
  await pool.query('DELETE FROM trash WHERE deleted_at < now() - make_interval(days => $1)', [RETENTION_DAYS])
  const { rows } = await pool.query(
    `SELECT t.id, t.entity, t.label, t.detail, t.via, u.name AS by, t.deleted_at
     FROM trash t JOIN users u ON u.id = t.deleted_by ORDER BY t.deleted_at DESC, t.id`,
  )
  return rows.map((r) => ({
    id: r.id,
    entity: r.entity,
    label: r.label,
    detail: r.detail,
    via: r.via,
    deletedBy: r.by,
    deletedAt: r.deleted_at.toISOString(),
    expiresAt: new Date(r.deleted_at.getTime() + RETENTION_DAYS * 86_400_000).toISOString(),
  }))
}

const exists = async (c: PoolClient, table: string, rowId: unknown) =>
  rowId == null || (await c.query(`SELECT 1 FROM ${table} WHERE id = $1`, [rowId])).rowCount! > 0

/** Vuelve a insertar la fila y lo que colgaba de ella. Falla con 409 si algo de lo que depende ya no esta. */
export async function restoreFromTrash(trashId: string) {
  try {
    return await tx(async (c) => {
      const t = (await c.query('SELECT id, entity, entity_id, label, data FROM trash WHERE id = $1 FOR UPDATE', [trashId])).rows[0]
      if (!t) throw new HttpError(404, 'No está en la papelera (¿ya se restauró o venció?)')
      const entity = t.entity as Entity
      const { root, children } = t.data as { root: Row; children: Record<string, Row[]> }

      const missing = (what: string) =>
        new HttpError(409, `No se puede restaurar: ${what} ya no existe o está en la papelera. Restaura primero eso.`)
      if (entity === 'proyecto' && !(await exists(c, 'clients', root.client_id))) throw missing('el cliente de este proyecto')
      if (entity === 'pago' && !(await exists(c, 'clients', root.client_id))) throw missing('el cliente de este cobro')
      if (entity === 'tarea' && !(await exists(c, 'projects', root.project_id))) throw missing('el proyecto de esta tarea')
      if (entity === 'gasto') {
        if (!(await exists(c, 'clients', root.client_id))) throw missing('el cliente de este gasto')
        if (!(await exists(c, 'projects', root.project_id))) throw missing('el proyecto de este gasto')
      }

      const all: Record<string, Row[]> = { [TABLE[entity]]: [root], ...children }
      for (const table of INSERT_ORDER[entity]) {
        const list = all[table] ?? []
        if (!list.length) continue
        await c.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)`, [JSON.stringify(list)])
      }
      await c.query('DELETE FROM trash WHERE id = $1', [trashId])
      return { entidad: entity, id: t.entity_id as string, nombre: t.label as string, restaurado: true }
    })
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === '23505') throw new HttpError(409, 'No se puede restaurar: ya existe algo equivalente (p. ej. otra inicial del mismo cliente).')
    if (code === '23503') throw new HttpError(409, 'No se puede restaurar: falta un elemento del que depende.')
    throw e
  }
}

/** Borrado definitivo de un elemento de la papelera (solo desde la web). */
export async function purgeFromTrash(trashId: string) {
  const { rowCount } = await pool.query('DELETE FROM trash WHERE id = $1', [trashId])
  if (!rowCount) throw new HttpError(404, 'No está en la papelera')
}
