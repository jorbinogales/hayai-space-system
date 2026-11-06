// Papelera: borrar = mover a `trash`, no destruir. La foto guarda la fila y todo lo que cuelga de ella como jsonb;
// restaurar la vuelve a insertar con los MISMOS ids (jsonb_populate_recordset: no depende de la lista de columnas).
// La usan la web (DELETE /api/...), la API v1 y el MCP, asi que borrar es recuperable venga de donde venga.
import type { PoolClient } from 'pg'
import { notifyChat } from './activity.ts'
import { ALL_TENANTS, pool, tx } from './db.ts'
import { tid } from './tenant.ts'
import { HttpError } from './util.ts'

// Multitenant: la foto, la lista, el restaurar y el borrado definitivo son del tenant en curso (la fila de trash lleva su tenant_id).
// Cada SELECT de la foto filtra por tenant_id ($T: el ultimo parametro), y al restaurar cada fila vuelve con el tenant de su fila de
// trash (nunca con el que diga el jsonb). Solo la limpieza por fecha recorre todos los tenants.

export const RETENTION_DAYS = 30
export type Entity = 'cliente' | 'proyecto' | 'pago' | 'gasto' | 'tarea' | 'interaccion' | 'hito' | 'checklist_item' | 'mensaje' | 'tarjeta' | 'columna'

type Row = Record<string, unknown>
type Snapshot = { root: Row; children: Record<string, Row[]>; label: string; detail: string | null }

const NOT_FOUND: Record<Entity, string> = {
  cliente: 'Cliente no encontrado',
  proyecto: 'Proyecto no encontrado',
  pago: 'Pago no encontrado',
  gasto: 'Gasto no encontrado',
  tarea: 'Tarea no encontrada',
  interaccion: 'Interacción no encontrada',
  hito: 'Hito no encontrado',
  checklist_item: 'Elemento no encontrado',
  mensaje: 'Mensaje no encontrado',
  tarjeta: 'Tarjeta no encontrada',
  columna: 'Columna no encontrada',
}

// Tabla de cada entidad e hijos, en orden de insercion (los padres antes que los hijos). Lista cerrada: nunca viene del cliente.
const TABLE: Record<Entity, string> = { cliente: 'clients', proyecto: 'projects', pago: 'payments', gasto: 'expenses', tarea: 'tasks', interaccion: 'interactions', hito: 'project_milestones', checklist_item: 'project_checklist', mensaje: 'chat_messages', tarjeta: 'board_cards', columna: 'board_columns' }
const INSERT_ORDER: Record<Entity, string[]> = {
  cliente: ['clients', 'client_items', 'interactions', 'payments', 'payment_receipts', 'systems', 'proposals', 'proposal_items', 'projects', 'project_milestones', 'project_checklist', 'tasks', 'expenses'],
  proyecto: ['projects', 'project_milestones', 'project_checklist', 'tasks', 'expenses'],
  pago: ['payments', 'payment_receipts'],
  gasto: ['expenses'],
  tarea: ['tasks'],
  interaccion: ['interactions'],
  hito: ['project_milestones'],
  checklist_item: ['project_checklist'],
  mensaje: ['chat_messages', 'chat_mentions'],
  tarjeta: ['board_cards', 'board_card_comments'],
  columna: ['board_columns', 'board_cards', 'board_card_comments'],
}

/** `sql` filtra con `tenant_id = $T`: $T es el tenant en curso, que se agrega como ultimo parametro. */
const rows = async (c: PoolClient, sql: string, params: unknown[]) =>
  (await c.query(`SELECT to_jsonb(t) AS j FROM (${sql.replaceAll('$T', `$${params.length + 1}`)}) t`, [...params, tid()])).rows.map((r) => r.j as Row)
const one = async (c: PoolClient, sql: string, params: unknown[]) => (await c.query(sql.replaceAll('$T', `$${params.length + 1}`), [...params, tid()])).rows[0]

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const money = (n: unknown) => `$${Number(n).toLocaleString('es-VE', { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 })}`

/** Lee la fila y su descendencia (bloqueando la fila). null si no existe. */
async function snapshot(c: PoolClient, entity: Entity, entityId: string): Promise<Snapshot | null> {
  const root = (await rows(c, `SELECT * FROM ${TABLE[entity]} WHERE id = $1 AND tenant_id = $T FOR UPDATE`, [entityId]))[0]
  if (!root) return null

  if (entity === 'cliente') {
    const projects = await rows(c, 'SELECT * FROM projects WHERE client_id = $1 AND tenant_id = $T', [entityId])
    const projectIds = projects.map((p) => p.id)
    const proposals = await rows(c, 'SELECT * FROM proposals WHERE client_id = $1 AND tenant_id = $T', [entityId])
    const children = {
      client_items: await rows(c, 'SELECT * FROM client_items WHERE client_id = $1 AND tenant_id = $T', [entityId]),
      // La bitacora muere con el cliente (CASCADE): si no entra en la foto, se perderia para siempre.
      interactions: await rows(c, 'SELECT * FROM interactions WHERE client_id = $1 AND tenant_id = $T', [entityId]),
      payments: await rows(c, 'SELECT * FROM payments WHERE client_id = $1 AND tenant_id = $T', [entityId]),
      // Comprobantes (la imagen vive en la fila) y sistemas: mueren con el cliente por CASCADE, asi que entran en la foto.
      payment_receipts: await rows(c, 'SELECT * FROM payment_receipts WHERE tenant_id = $T AND payment_id IN (SELECT id FROM payments WHERE client_id = $1 AND tenant_id = $T)', [entityId]),
      systems: await rows(c, 'SELECT * FROM systems WHERE client_id = $1 AND tenant_id = $T', [entityId]),
      // Las propuestas (y sus items) mueren con el cliente por CASCADE: sin foto se perderia la negociacion.
      proposals,
      proposal_items: await rows(c, 'SELECT * FROM proposal_items WHERE proposal_id = ANY($1::uuid[]) AND tenant_id = $T', [proposals.map((p) => p.id)]),
      projects,
      project_milestones: await rows(c, 'SELECT * FROM project_milestones WHERE project_id = ANY($1::uuid[]) AND tenant_id = $T', [projectIds]),
      project_checklist: await rows(c, 'SELECT * FROM project_checklist WHERE project_id = ANY($1::uuid[]) AND tenant_id = $T', [projectIds]),
      tasks: await rows(c, 'SELECT * FROM tasks WHERE project_id = ANY($1::uuid[]) AND tenant_id = $T', [projectIds]),
      expenses: await rows(c, 'SELECT * FROM expenses WHERE (client_id = $1 OR project_id = ANY($2::uuid[])) AND tenant_id = $T', [entityId, projectIds]),
      // Las tarjetas del tablero NO se borran con el cliente (su FK lo suelta: SET NULL): se guarda cuáles eran para volver a enlazarlas.
      board_card_links: await rows(c, 'SELECT id, client_id FROM board_cards WHERE client_id = $1 AND tenant_id = $T', [entityId]),
    }
    const parts = [
      plural(children.payments.length, 'cobro', 'cobros'),
      ...(proposals.length ? [plural(proposals.length, 'propuesta', 'propuestas')] : []),
      plural(projects.length, 'proyecto', 'proyectos'),
      plural(children.tasks.length, 'tarea', 'tareas'),
      plural(children.expenses.length, 'gasto', 'gastos'),
      ...(children.systems.length ? [plural(children.systems.length, 'sistema', 'sistemas')] : []),
      ...(children.interactions.length ? [plural(children.interactions.length, 'interacción', 'interacciones')] : []),
    ]
    return { root, children, label: String(root.name), detail: parts.join(', ') }
  }
  if (entity === 'proyecto') {
    const children = {
      project_milestones: await rows(c, 'SELECT * FROM project_milestones WHERE project_id = $1 AND tenant_id = $T', [entityId]),
      project_checklist: await rows(c, 'SELECT * FROM project_checklist WHERE project_id = $1 AND tenant_id = $T', [entityId]),
      tasks: await rows(c, 'SELECT * FROM tasks WHERE project_id = $1 AND tenant_id = $T', [entityId]),
      expenses: await rows(c, 'SELECT * FROM expenses WHERE project_id = $1 AND tenant_id = $T', [entityId]),
    }
    const owner = root.client_id ? (await one(c, 'SELECT name FROM clients WHERE id = $1 AND tenant_id = $T', [root.client_id]))?.name : null
    const detail = [owner && `de ${owner}`, plural(children.tasks.length, 'tarea', 'tareas'), plural(children.expenses.length, 'gasto', 'gastos')]
    return { root, children, label: String(root.name), detail: detail.filter(Boolean).join(', ') }
  }
  if (entity === 'pago') {
    const owner = (await one(c, 'SELECT name FROM clients WHERE id = $1 AND tenant_id = $T', [root.client_id]))?.name
    const receipts = await rows(c, 'SELECT * FROM payment_receipts WHERE payment_id = $1 AND tenant_id = $T', [entityId])
    return { root, children: { payment_receipts: receipts }, label: `${root.concept} · ${money(root.amount)}`, detail: owner ? `Cobro de ${owner}${receipts.length ? ' (con comprobante)' : ''}` : null }
  }
  if (entity === 'gasto') return { root, children: {}, label: `${root.concept} · ${money(root.amount)}`, detail: `Gasto del ${root.date}` }
  if (entity === 'interaccion') {
    const owner = (await one(c, 'SELECT name FROM clients WHERE id = $1 AND tenant_id = $T', [root.client_id]))?.name
    const summary = String(root.summary)
    return { root, children: {}, label: `${root.kind}: ${summary.length > 60 ? `${summary.slice(0, 57)}...` : summary}`, detail: owner ? `Bitácora de ${owner}` : null }
  }
  if (entity === 'mensaje') {
    // Las menciones (CASCADE) viajan en la foto: al restaurar el mensaje vuelven a mencionar a los mismos socios.
    const mentions = await rows(c, 'SELECT * FROM chat_mentions WHERE message_id = $1 AND tenant_id = $T', [entityId])
    const author = (await c.query('SELECT name FROM users WHERE id = $1', [root.author_id])).rows[0]?.name
    const flat = String(root.body).replace(/\s+/g, ' ')
    return { root, children: { chat_mentions: mentions }, label: flat.length > 80 ? `${flat.slice(0, 80)}…` : flat, detail: `Mensaje de ${author ?? 'un astronauta'} en el chat${mentions.length ? ` (${plural(mentions.length, 'mención', 'menciones')})` : ''}` }
  }
  if (entity === 'tarjeta') {
    // Los comentarios mueren con la tarjeta (CASCADE): viajan en la foto.
    const comments = await rows(c, 'SELECT * FROM board_card_comments WHERE card_id = $1 AND tenant_id = $T', [entityId])
    const col = (await one(c, 'SELECT name FROM board_columns WHERE id = $1 AND tenant_id = $T', [root.column_id]))?.name
    const parts = [col && `Tarjeta de «${col}»`, comments.length ? plural(comments.length, 'comentario', 'comentarios') : null]
    return { root, children: { board_card_comments: comments }, label: String(root.title), detail: parts.filter(Boolean).join(', ') || null }
  }
  if (entity === 'columna') {
    // La columna se lleva TODAS sus tarjetas (archivadas incluidas) y sus comentarios.
    const cards = await rows(c, 'SELECT * FROM board_cards WHERE column_id = $1 AND tenant_id = $T', [entityId])
    const comments = await rows(c, 'SELECT * FROM board_card_comments WHERE card_id = ANY($1::uuid[]) AND tenant_id = $T', [cards.map((k) => k.id)])
    return { root, children: { board_cards: cards, board_card_comments: comments }, label: String(root.name), detail: `Columna del tablero, ${plural(cards.length, 'tarjeta', 'tarjetas')}` }
  }
  const project = (await one(c, 'SELECT name FROM projects WHERE id = $1 AND tenant_id = $T', [root.project_id]))?.name
  if (entity === 'hito') {
    // Borrar el hito suelta sus tareas (SET NULL): se guarda cuales eran para volver a colgarlas al restaurar.
    const links = await rows(c, 'SELECT id, milestone_id FROM tasks WHERE milestone_id = $1 AND tenant_id = $T', [entityId])
    return { root, children: { task_links: links }, label: String(root.title), detail: project ? `Hito de ${project}` : null }
  }
  if (entity === 'checklist_item') return { root, children: {}, label: String(root.text), detail: project ? `Checklist de ${project}` : null }
  return { root, children: {}, label: String(root.title), detail: project ? `Tarea de ${project}` : null }
}

/** Los gastos de un proyecto no se borran solos (RESTRICT en el esquema); las tareas se van por CASCADE. */
async function deleteProjectRows(c: PoolClient, where: string, params: unknown[]) {
  await one(c, `DELETE FROM expenses WHERE tenant_id = $T AND project_id IN (SELECT id FROM projects WHERE ${where} AND tenant_id = $T)`, params)
  await one(c, `DELETE FROM projects WHERE ${where} AND tenant_id = $T`, params)
}

/** Mueve a la papelera. `via` dice desde donde se borro ('web' o 'api:<llave>'). */
export async function sendToTrash(entity: Entity, entityId: string, userId: string, via = 'web') {
  return tx(async (c) => {
    // Limpieza oportunista de lo que ya paso la retencion: sin tareas programadas que mantener.
    await c.query(`DELETE FROM trash WHERE deleted_at < now() - make_interval(days => $1) ${ALL_TENANTS}`, [RETENTION_DAYS])
    const snap = await snapshot(c, entity, entityId)
    if (!snap) throw new HttpError(404, NOT_FOUND[entity])
    // La inicial es el desglose del cliente (client_items): se edita desde ahí, no se borra como un cobro más.
    if (entity === 'pago' && snap.root.kind === 'inicial') throw new HttpError(400, 'La inicial se edita desde sus ítems, no se borra como un pago')

    // Las entradas de etapa las escribe el sistema: borrarlas falsificaria el historial del pipeline.
    if (entity === 'interaccion' && snap.root.kind === 'etapa') throw new HttpError(409, 'Las entradas de etapa las escribe el sistema y no se borran')

    // Orden inverso al de insercion: primero lo que depende de otras filas.
    if (entity === 'cliente') {
      await one(c, 'DELETE FROM expenses WHERE client_id = $1 AND tenant_id = $T', [entityId])
      await one(c, 'DELETE FROM payments WHERE client_id = $1 AND tenant_id = $T', [entityId])
      await deleteProjectRows(c, 'client_id = $1', [entityId])
      await one(c, 'DELETE FROM clients WHERE id = $1 AND tenant_id = $T', [entityId]) // client_items por CASCADE
    } else if (entity === 'proyecto') {
      await deleteProjectRows(c, 'id = $1', [entityId])
    } else if (entity === 'columna') {
      await one(c, 'DELETE FROM board_cards WHERE column_id = $1 AND tenant_id = $T', [entityId]) // la FK es RESTRICT; comentarios por CASCADE
      await one(c, 'DELETE FROM board_columns WHERE id = $1 AND tenant_id = $T', [entityId])
    } else {
      await one(c, `DELETE FROM ${TABLE[entity]} WHERE id = $1 AND tenant_id = $T`, [entityId])
    }
    if (entity === 'mensaje') await notifyChat(c, 'borrado', entityId) // en la misma transaccion: avisa al confirmarse

    const { rows } = await c.query(
      `INSERT INTO trash (tenant_id, entity, entity_id, label, detail, data, via, deleted_by)
       VALUES ($8, $1, $2, $3, $4, $5, $6, $7) RETURNING id, deleted_at`,
      [entity, entityId, snap.label, snap.detail, JSON.stringify({ root: snap.root, children: snap.children }), via, userId, tid()],
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
  await pool.query(`DELETE FROM trash WHERE deleted_at < now() - make_interval(days => $1) ${ALL_TENANTS}`, [RETENTION_DAYS])
  const { rows } = await pool.query(
    `SELECT t.id, t.entity, t.label, t.detail, t.via, u.name AS by, t.deleted_at
     FROM trash t JOIN users u ON u.id = t.deleted_by WHERE t.tenant_id = $1 ORDER BY t.deleted_at DESC, t.id`,
    [tid()],
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
  rowId == null || (await c.query(`SELECT 1 FROM ${table} WHERE id = $1${table === 'users' ? '' : ' AND tenant_id = $2'}`, table === 'users' ? [rowId] : [rowId, tid()])).rowCount! > 0

/** Vuelve a insertar la fila y lo que colgaba de ella. Falla con 409 si algo de lo que depende ya no esta. */
export async function restoreFromTrash(trashId: string) {
  try {
    return await tx(async (c) => {
      const t = (await c.query('SELECT id, tenant_id, entity, entity_id, label, data FROM trash WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [trashId, tid()])).rows[0]
      if (!t) throw new HttpError(404, 'No está en la papelera (¿ya se restauró o venció?)')
      const entity = t.entity as Entity
      const { root, children } = t.data as { root: Row; children: Record<string, Row[]> }

      const missing = (what: string) =>
        new HttpError(409, `No se puede restaurar: ${what} ya no existe o está en la papelera. Restaura primero eso.`)
      if (entity === 'proyecto' && !(await exists(c, 'clients', root.client_id))) throw missing('el cliente de este proyecto')
      if ((entity === 'hito' || entity === 'checklist_item') && !(await exists(c, 'projects', root.project_id))) throw missing('el proyecto de este elemento')
      if (entity === 'pago' && !(await exists(c, 'clients', root.client_id))) throw missing('el cliente de este cobro')
      if (entity === 'tarea' && !(await exists(c, 'projects', root.project_id))) throw missing('el proyecto de esta tarea')
      if (entity === 'mensaje' && !(await exists(c, 'users', root.author_id))) throw missing('el autor de este mensaje')
      if (entity === 'interaccion' && !(await exists(c, 'clients', root.client_id))) throw missing('el cliente de esta interacción')
      if (entity === 'tarjeta' && !(await exists(c, 'board_columns', root.column_id))) throw missing('la columna de esta tarjeta')
      if (entity === 'columna' && !(await exists(c, 'boards', root.board_id))) throw missing('el tablero de esta columna')
      if (entity === 'tarjeta' || entity === 'columna') {
        // El cliente o el responsable de una tarjeta pueden haberse ido (papelera, baja): la tarjeta vuelve sin ese enlace.
        const cards = entity === 'tarjeta' ? [root] : (children.board_cards ?? [])
        const ids = (k: string) => [...new Set(cards.map((r) => r[k]).filter(Boolean))]
        const clients = new Set((await c.query('SELECT id FROM clients WHERE id = ANY($1::uuid[]) AND tenant_id = $2', [ids('client_id'), tid()])).rows.map((r) => r.id))
        const users = new Set((await c.query('SELECT id FROM users WHERE id = ANY($1::uuid[])', [ids('assignee_id')])).rows.map((r) => r.id))
        for (const k of cards) {
          if (k.client_id && !clients.has(k.client_id)) k.client_id = null
          if (k.assignee_id && !users.has(k.assignee_id)) k.assignee_id = null
        }
      }
      if (entity === 'gasto') {
        if (!(await exists(c, 'clients', root.client_id))) throw missing('el cliente de este gasto')
        if (!(await exists(c, 'projects', root.project_id))) throw missing('el proyecto de este gasto')
      }

      const all: Record<string, Row[]> = { [TABLE[entity]]: [root], ...children }
      for (const table of INSERT_ORDER[entity]) {
        // El tenant de cada fila es el de su fila de trash (la del tenant en curso), no el que traiga la foto.
        const list = (all[table] ?? []).map((r) => ({ ...r, tenant_id: t.tenant_id }))
        if (!list.length) continue
        await c.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb) /* tenant_id: el de la fila de trash */`, [JSON.stringify(list)])
      }
      // Un hito restaurado recupera las tareas que colgaban de el (las que sigan existiendo y no tengan otro hito).
      if (entity === 'hito' && children.task_links?.length)
        await c.query(
          `UPDATE tasks t SET milestone_id = $1 WHERE t.id = ANY($2::uuid[]) AND t.milestone_id IS NULL AND t.project_id = $3 AND t.tenant_id = $4`,
          [t.entity_id, children.task_links.map((l) => l.id), root.project_id, t.tenant_id],
        )
      // Un cliente restaurado vuelve a quedar enlazado a sus tarjetas del tablero (las que sigan existiendo y no tengan otro cliente).
      if (entity === 'cliente' && children.board_card_links?.length)
        await c.query('UPDATE board_cards SET client_id = $1 WHERE id = ANY($2::uuid[]) AND client_id IS NULL AND tenant_id = $3', [t.entity_id, children.board_card_links.map((l) => l.id), t.tenant_id])
      if (entity === 'mensaje') await notifyChat(c, 'nuevo', t.entity_id as string) // reaparece en el canal de todos
      await c.query('DELETE FROM trash WHERE id = $1 AND tenant_id = $2', [trashId, t.tenant_id])
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
  const { rowCount } = await pool.query('DELETE FROM trash WHERE id = $1 AND tenant_id = $2', [trashId, tid()])
  if (!rowCount) throw new HttpError(404, 'No está en la papelera')
}
