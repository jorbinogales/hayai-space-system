// Tablero (kanban tipo Trello, migración 040): un tablero por tenant con columnas, tarjetas y comentarios.
// La web (routes/board.ts) usa estas funciones con su forma (camelCase); la API v1 y el MCP, las `op` del final (español, snake_case).
// Orden: el cliente manda la columna y `after_id` (null = arriba; sin él = al final); la posición la calcula el servidor dentro de la
// transacción, tras bloquear el padre (la columna destino o el tablero). Ver `slot`.
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { recordActivity } from '../activity.ts'
import { assertFresh, stamp } from '../concurrency.ts'
import { type Db, pool, tx } from '../db.ts'
import { userByName } from '../socios.ts'
import { tid } from '../tenant.ts'
import { HttpError, id, isoDate, text } from '../util.ts'
import { type Actor, op } from './common.ts'

export const PRIORITIES = ['baja', 'media', 'alta', 'urgente'] as const
export const priority = z.enum(PRIORITIES, 'Prioridad inválida (baja, media, alta o urgente)')
/** Descripción opcional: vacía = sin descripción (el CHECK no admite ''). */
export const description = z.string().trim().max(4000, 'Máximo 4000 caracteres').transform((v) => v || null)

const STEP = 1024
const MAX_SCALE = 10

const ORDER = {
  cards: { table: 'board_cards', parent: 'column_id', lock: 'board_columns', missing: 'Columna no encontrada', after: 'after_id: esa tarjeta no está en la columna destino' },
  columns: { table: 'board_columns', parent: 'board_id', lock: 'boards', missing: 'Tablero no encontrado', after: 'after_id: esa columna no está en el tablero' },
} as const

/**
 * Posición nueva (numeric exacto, como texto) dentro de `parentId`: tras `afterId`; null = la primera; undefined = la última.
 * Bloquea el padre (FOR NO KEY UPDATE): dos arrastres al mismo hueco se serializan. `selfId` = la fila que se mueve (no es vecina).
 * Entre a y b: trim_scale((a+b)/2); arriba: primera - 1024; abajo: última + 1024; vacía: 1024. Si queda con más de 10 decimales
 * (o empata con un vecino: dos filas restauradas con la misma posición), renumera el padre (1024, 2048...) y vuelve a calcular.
 */
async function slot(c: PoolClient, kind: keyof typeof ORDER, parentId: string, afterId: string | null | undefined, selfId: string | null = null): Promise<string> {
  const o = ORDER[kind]
  const T = tid()
  if (!(await c.query(`SELECT 1 FROM ${o.lock} WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE`, [T, parentId])).rowCount) throw new HttpError(404, o.missing)
  if (afterId && afterId === selfId) throw new HttpError(400, 'after_id: no puede ser el mismo elemento que se mueve')
  const mode = afterId === undefined ? 'end' : afterId === null ? 'top' : 'after'
  for (let pass = 0; ; pass++) {
    const r = (
      await c.query(
        `WITH sib AS (SELECT id, position FROM ${o.table} WHERE tenant_id = $1 AND ${o.parent} = $2 AND id IS DISTINCT FROM $4::uuid),
              a AS (SELECT position FROM sib WHERE id = $3::uuid),
              b AS (SELECT s.position FROM sib s, a WHERE (s.position, s.id) > (a.position, $3::uuid) ORDER BY s.position, s.id LIMIT 1),
              v AS (SELECT CASE
                WHEN $5::text = 'end' THEN COALESCE((SELECT max(position) FROM sib) + ${STEP}, ${STEP})
                WHEN $5::text = 'top' THEN COALESCE((SELECT min(position) FROM sib) - ${STEP}, ${STEP})
                WHEN NOT EXISTS (SELECT 1 FROM b) THEN (SELECT position FROM a) + ${STEP}
                ELSE trim_scale(((SELECT position FROM a) + (SELECT position FROM b)) * 0.5) END AS v)
         SELECT v::text AS p, scale(v) AS s, EXISTS (SELECT 1 FROM a) AS found,
                COALESCE(v = (SELECT position FROM a) OR v = (SELECT position FROM b), false) AS tie FROM v`,
        [T, parentId, mode === 'after' ? afterId : null, selfId, mode],
      )
    ).rows[0]
    if (mode === 'after' && !r.found) throw new HttpError(400, o.after)
    if (pass === 0 && (r.s > MAX_SCALE || r.tie)) {
      await c.query(
        `UPDATE ${o.table} x SET position = r.n * ${STEP}
         FROM (SELECT id, row_number() OVER (ORDER BY position, id) AS n FROM ${o.table} WHERE tenant_id = $1 AND ${o.parent} = $2) r
         WHERE x.id = r.id AND x.tenant_id = $1`,
        [T, parentId],
      )
      continue
    }
    return r.p as string
  }
}

// ---------- lectura ----------
const CARD_SELECT = `SELECT k.id, k.column_id, k.position, k.title, k.description, k.priority, k.due_date, k.archived_at, k.created_at, k.updated_at,
    cu.id AS by_id, cu.name AS by_name, au.id AS a_id, au.name AS a_name, au.avatar AS a_avatar, cl.id AS c_id, cl.name AS c_name,
    (SELECT count(*)::int FROM board_card_comments m WHERE m.tenant_id = k.tenant_id AND m.card_id = k.id) AS comments
  FROM board_cards k JOIN users cu ON cu.id = k.created_by LEFT JOIN users au ON au.id = k.assignee_id
  LEFT JOIN clients cl ON cl.tenant_id = k.tenant_id AND cl.id = k.client_id`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cardOut = (r: any) => ({
  id: r.id as string,
  columnId: r.column_id as string,
  position: r.position as number,
  title: r.title as string,
  description: r.description as string | null,
  priority: r.priority as (typeof PRIORITIES)[number],
  dueDate: r.due_date as string | null,
  archivedAt: stamp(r.archived_at),
  assignee: r.a_id ? { id: r.a_id as string, name: r.a_name as string, avatar: r.a_avatar as string } : null,
  client: r.c_id ? { id: r.c_id as string, name: r.c_name as string } : null,
  comments: r.comments as number,
  createdBy: { id: r.by_id as string, name: r.by_name as string },
  createdAt: stamp(r.created_at)!,
  updatedAt: stamp(r.updated_at)!, // versión del contenido: va en If-Match al editar
})
export type Card = ReturnType<typeof cardOut>

export async function card(db: Db, cardId: string): Promise<Card> {
  const r = (await db.query(`${CARD_SELECT} WHERE k.tenant_id = $1 AND k.id = $2`, [tid(), cardId])).rows[0]
  if (!r) throw new HttpError(404, 'Tarjeta no encontrada')
  return cardOut(r)
}

const boardRow = async (db: Db) => {
  const b = (await db.query('SELECT id, name FROM boards WHERE tenant_id = $1', [tid()])).rows[0]
  if (!b) throw new HttpError(404, 'Tablero no encontrado') // la BD siembra uno por tenant: no debería pasar
  return b as { id: string; name: string }
}

/** El tablero completo: columnas en orden, cada una con sus tarjetas no archivadas en orden. */
export async function board() {
  const b = await boardRow(pool)
  const [cols, cards] = await Promise.all([
    pool.query('SELECT id, name, position FROM board_columns WHERE tenant_id = $1 AND board_id = $2 ORDER BY position, id', [tid(), b.id]),
    pool.query(`${CARD_SELECT} WHERE k.tenant_id = $1 AND k.archived_at IS NULL ORDER BY k.position, k.id`, [tid()]),
  ])
  const all = cards.rows.map(cardOut)
  return { id: b.id, name: b.name, columns: cols.rows.map((col) => ({ id: col.id as string, name: col.name as string, position: col.position as number, cards: all.filter((k) => k.columnId === col.id) })) }
}

/** Tarjetas archivadas (lo último archivado primero), para desarchivarlas. */
export async function archivedCards() {
  return (await pool.query(`${CARD_SELECT} WHERE k.tenant_id = $1 AND k.archived_at IS NOT NULL ORDER BY k.archived_at DESC, k.id`, [tid()])).rows.map(cardOut)
}

// ---------- columnas ----------
const COLUMN_RET = 'RETURNING id, name, position'
const columnOut = (r: { id: string; name: string; position: number }) => ({ id: r.id, name: r.name, position: r.position })

export async function createColumn(b: { name: string; afterId?: string | null }) {
  return tx(async (c) => {
    const { id: boardId } = await boardRow(c)
    const pos = await slot(c, 'columns', boardId, b.afterId)
    return columnOut((await c.query(`INSERT INTO board_columns (tenant_id, board_id, name, position) VALUES ($1, $2, $3, $4::numeric) ${COLUMN_RET}`, [tid(), boardId, b.name, pos])).rows[0])
  })
}

export async function updateColumn(columnId: string, b: { name?: string; afterId?: string | null }) {
  return tx(async (c) => {
    const { id: boardId } = await boardRow(c)
    const pos = b.afterId !== undefined ? await slot(c, 'columns', boardId, b.afterId, columnId) : null
    const r = (await c.query(`UPDATE board_columns SET name = COALESCE($3, name), position = COALESCE($4::numeric, position) WHERE tenant_id = $1 AND id = $2 ${COLUMN_RET}`, [tid(), columnId, b.name ?? null, pos])).rows[0]
    if (!r) throw new HttpError(404, 'Columna no encontrada')
    return columnOut(r)
  })
}

// ---------- tarjetas ----------
/** Responsable válido: socio activo del tenant con el módulo tablero (o ADMIN, que entra a todo). $1 = el tenant. */
const BOARD_MEMBER = `u.active AND (u.role = 'ADMIN' OR EXISTS (SELECT 1 FROM user_tenants ut WHERE ut.user_id = u.id AND ut.tenant_id = $1 AND 'tablero' = ANY (ut.modules)))`
/** Quienes pueden ser responsables de una tarjeta (para el selector). */
export const boardMembers = async () => (await pool.query(`SELECT u.id, u.name, u.avatar FROM users u WHERE ${BOARD_MEMBER} ORDER BY u.name`, [tid()])).rows as { id: string; name: string; avatar: string }[]
async function checkAssignee(c: Db, userId: string) {
  const { rowCount } = await c.query(`SELECT 1 FROM users u WHERE u.id = $2 AND ${BOARD_MEMBER}`, [tid(), userId])
  if (!rowCount) throw new HttpError(400, 'El responsable debe ser un socio de este espacio con acceso al tablero', { codigo: 'responsable_invalido' })
}
async function checkClient(c: Db, clientId: string) {
  if (!(await c.query('SELECT 1 FROM clients WHERE tenant_id = $1 AND id = $2', [tid(), clientId])).rowCount) throw new HttpError(404, 'Cliente no encontrado')
}
const userName = async (c: Db, userId: string) => (await c.query('SELECT name FROM users WHERE id = $1', [userId])).rows[0]?.name as string

export type CardInput = { columnId: string; title: string; description?: string | null; priority?: string; assigneeId?: string | null; clientId?: string | null; dueDate?: string | null; afterId?: string | null }

export async function createCard(actor: Actor, b: CardInput): Promise<Card> {
  const cardId = await tx(async (c) => {
    const pos = await slot(c, 'cards', b.columnId, b.afterId)
    if (b.assigneeId) await checkAssignee(c, b.assigneeId)
    if (b.clientId) await checkClient(c, b.clientId)
    const { rows } = await c.query(
      `INSERT INTO board_cards (tenant_id, column_id, position, title, description, priority, assignee_id, client_id, due_date, created_by)
       VALUES ($1, $2, $3::numeric, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [tid(), b.columnId, pos, b.title, b.description ?? null, b.priority ?? 'media', b.assigneeId ?? null, b.clientId ?? null, b.dueDate ?? null, actor.id],
    )
    const col = (await c.query('SELECT name FROM board_columns WHERE tenant_id = $1 AND id = $2', [tid(), b.columnId])).rows[0].name
    await recordActivity(c, { kind: 'tarjeta_nueva', actorId: actor.id, subject: b.title, detail: col, clientId: b.clientId ?? null, cardId: rows[0].id, via: actor.via })
    return rows[0].id as string
  })
  return card(pool, cardId)
}

export type CardPatch = { title?: string; description?: string | null; priority?: string; assigneeId?: string | null; clientId?: string | null; dueDate?: string | null }

/** Edita el contenido (If-Match: 409 si cambió). Ausente = no cambia; null = lo borra. Asignar a otra persona avisa al equipo. */
export async function updateCard(actor: Actor, cardId: string, b: CardPatch): Promise<Card> {
  await tx(async (c) => {
    await assertFresh(c, 'board_cards', cardId)
    const cur = (await c.query('SELECT title, assignee_id, client_id FROM board_cards WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tid(), cardId])).rows[0]
    if (!cur) throw new HttpError(404, 'Tarjeta no encontrada')
    if (b.assigneeId) await checkAssignee(c, b.assigneeId)
    if (b.clientId) await checkClient(c, b.clientId)
    const set = (v: unknown) => v !== undefined
    await c.query(
      `UPDATE board_cards SET
         title = COALESCE($3, title),
         description = CASE WHEN $4::boolean THEN $5 ELSE description END,
         priority = COALESCE($6, priority),
         assignee_id = CASE WHEN $7::boolean THEN $8::uuid ELSE assignee_id END,
         client_id = CASE WHEN $9::boolean THEN $10::uuid ELSE client_id END,
         due_date = CASE WHEN $11::boolean THEN $12::date ELSE due_date END
       WHERE tenant_id = $1 AND id = $2`,
      [tid(), cardId, b.title ?? null, set(b.description), b.description ?? null, b.priority ?? null, set(b.assigneeId), b.assigneeId ?? null, set(b.clientId), b.clientId ?? null, set(b.dueDate), b.dueDate ?? null],
    )
    if (b.assigneeId && b.assigneeId !== cur.assignee_id) {
      const clientId = b.clientId !== undefined ? b.clientId : cur.client_id
      await recordActivity(c, { kind: 'tarjeta_asignada', actorId: actor.id, subject: b.title ?? cur.title, detail: await userName(c, b.assigneeId), clientId, cardId, via: actor.via })
    }
  })
  return card(pool, cardId)
}

/** Mueve la tarjeta a `columnId`, tras `afterId` (null = arriba; sin él = al final). Solo cambiar de columna avisa al equipo. */
export async function moveCard(actor: Actor, cardId: string, columnId: string, afterId: string | null | undefined): Promise<Card> {
  await tx(async (c) => {
    const pos = await slot(c, 'cards', columnId, afterId, cardId) // primero el padre (el orden de bloqueo de la 040)
    const cur = (await c.query('SELECT column_id, title, client_id FROM board_cards WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tid(), cardId])).rows[0]
    if (!cur) throw new HttpError(404, 'Tarjeta no encontrada')
    await c.query('UPDATE board_cards SET column_id = $3, position = $4::numeric WHERE tenant_id = $1 AND id = $2', [tid(), cardId, columnId, pos])
    if (cur.column_id !== columnId) {
      const col = (await c.query('SELECT name FROM board_columns WHERE tenant_id = $1 AND id = $2', [tid(), columnId])).rows[0].name
      await recordActivity(c, { kind: 'tarjeta_movida', actorId: actor.id, subject: cur.title, detail: col, clientId: cur.client_id, cardId, via: actor.via })
    }
  })
  return card(pool, cardId)
}

/** Archivar la saca del tablero sin borrarla; desarchivar la devuelve a su lugar. No toca la versión del contenido. */
export async function setArchived(cardId: string, archived: boolean): Promise<Card> {
  const { rowCount } = await pool.query('UPDATE board_cards SET archived_at = CASE WHEN $3 THEN COALESCE(archived_at, now()) END WHERE tenant_id = $1 AND id = $2', [tid(), cardId, archived])
  if (!rowCount) throw new HttpError(404, 'Tarjeta no encontrada')
  return card(pool, cardId)
}

// ---------- comentarios ----------
const COMMENT_SELECT = `SELECT m.id, m.card_id, m.body, m.edited_at, m.created_at, u.id AS u_id, u.name AS u_name, u.avatar AS u_avatar
  FROM board_card_comments m JOIN users u ON u.id = m.author_id`
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const commentOut = (r: any) => ({
  id: r.id as string,
  cardId: r.card_id as string,
  author: { id: r.u_id as string, name: r.u_name as string, avatar: r.u_avatar as string },
  body: r.body as string,
  editedAt: stamp(r.edited_at),
  createdAt: stamp(r.created_at)!,
})
export type Comment = ReturnType<typeof commentOut>
const comment = async (db: Db, commentId: string) => commentOut((await db.query(`${COMMENT_SELECT} WHERE m.tenant_id = $1 AND m.id = $2`, [tid(), commentId])).rows[0])

export async function listComments(cardId: string): Promise<Comment[]> {
  await card(pool, cardId) // 404 si no es de este tenant
  return (await pool.query(`${COMMENT_SELECT} WHERE m.tenant_id = $1 AND m.card_id = $2 ORDER BY m.created_at, m.id`, [tid(), cardId])).rows.map(commentOut)
}

export async function addComment(actor: Actor, cardId: string, body: string): Promise<Comment> {
  return tx(async (c) => {
    const k = (await c.query('SELECT title, client_id FROM board_cards WHERE tenant_id = $1 AND id = $2 FOR SHARE', [tid(), cardId])).rows[0]
    if (!k) throw new HttpError(404, 'Tarjeta no encontrada')
    const { rows } = await c.query('INSERT INTO board_card_comments (tenant_id, card_id, author_id, body) VALUES ($1, $2, $3, $4) RETURNING id', [tid(), cardId, actor.id, body])
    await recordActivity(c, { kind: 'tarjeta_comentada', actorId: actor.id, subject: k.title, clientId: k.client_id, cardId, via: actor.via })
    return comment(c, rows[0].id)
  })
}

/** Editar o borrar un comentario: solo su autor o un ADMIN (403 si no). Borrar es definitivo (los comentarios no van solos a la papelera). */
async function ownComment(c: PoolClient, actor: Actor, commentId: string) {
  const m = (await c.query('SELECT author_id FROM board_card_comments WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tid(), commentId])).rows[0]
  if (!m) throw new HttpError(404, 'Comentario no encontrado')
  if (m.author_id !== actor.id && actor.role !== 'ADMIN') throw new HttpError(403, 'Solo el autor o un administrador puede cambiar este comentario')
}
export const editComment = (actor: Actor, commentId: string, body: string) =>
  tx(async (c) => {
    await ownComment(c, actor, commentId)
    await c.query('UPDATE board_card_comments SET body = $3, edited_at = now() WHERE tenant_id = $1 AND id = $2', [tid(), commentId, body])
    return comment(c, commentId)
  })
export const deleteComment = (actor: Actor, commentId: string) =>
  tx(async (c) => {
    await ownComment(c, actor, commentId)
    await c.query('DELETE FROM board_card_comments WHERE tenant_id = $1 AND id = $2', [tid(), commentId])
  })

// ---------- API v1 y MCP (español, snake_case; el responsable va por nombre, como en tareas) ----------
const tarjetaEs = (k: Card) => ({
  id: k.id,
  columna_id: k.columnId,
  titulo: k.title,
  descripcion: k.description,
  prioridad: k.priority,
  vence: k.dueDate,
  archivada: k.archivedAt !== null,
  responsable: k.assignee && { id: k.assignee.id, nombre: k.assignee.name },
  cliente: k.client && { id: k.client.id, nombre: k.client.name },
  comentarios: k.comments,
  creada_por: k.createdBy.name,
  creada_el: k.createdAt,
  actualizado_el: k.updatedAt,
})
const despuesDe = id.nullable().optional().describe('Id de la tarjeta tras la que va (en esa columna). null = arriba; sin él = al final.')

export const tableroVer = op(z.strictObject({}), async () => {
  const b = await board()
  return { id: b.id, nombre: b.name, columnas: b.columns.map((c) => ({ id: c.id, nombre: c.name, tarjetas: c.cards.map(tarjetaEs) })) }
})

export const tarjetaCrear = op(
  z.strictObject({ columna_id: id, titulo: text(200), descripcion: description.nullish(), prioridad: priority.optional(), responsable: text(40).nullish(), cliente_id: id.nullish(), vence: isoDate.nullish(), despues_de: despuesDe }),
  async (actor, b) => {
    const assigneeId = b.responsable ? (await userByName(pool, b.responsable)).id : null
    return tarjetaEs(await createCard(actor, { columnId: b.columna_id, title: b.titulo, description: b.descripcion, priority: b.prioridad, assigneeId, clientId: b.cliente_id, dueDate: b.vence, afterId: b.despues_de }))
  },
)

export const tarjetaMover = op(z.strictObject({ id, columna_id: id, despues_de: despuesDe }), async (actor, b) => tarjetaEs(await moveCard(actor, b.id, b.columna_id, b.despues_de)))

export const tarjetaComentar = op(z.strictObject({ id, texto: text(4000) }), async (actor, b) => {
  const m = await addComment(actor, b.id, b.texto)
  return { id: m.id, tarjeta_id: m.cardId, autor: m.author.name, texto: m.body, creado_el: m.createdAt }
})
