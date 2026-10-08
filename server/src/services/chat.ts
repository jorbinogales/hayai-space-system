// Chat interno entre astronautas (socios): UN canal para todo el equipo, mensajes tipo nota con @menciones. Un servicio para la web,
// la API v1 y el MCP. Quien escribe sale SIEMPRE de la sesión o de la llave (author_id), nunca del cuerpo; `fuente` es el origen
// lógico ('manual' si lo escribe un socio en la web; en la API/MCP, la automatización o el Muse que habla).
//
// Lectura: un "leído hasta" por socio (chat_reads). Sin leer = mensajes de OTROS posteriores a ese instante; las menciones sin leer
// son los míos dentro de esos mensajes. Los instantes (creado_el, leido_hasta) viajan con microsegundos: el cursor de la lista y el
// "leído hasta" comparan contra created_at tal cual, y un instante truncado a milisegundos dejaría mensajes fuera de la página.
import { z } from 'zod'
import { notifyChat } from '../activity.ts'
import { assertFresh, stamp } from '../concurrency.ts'
import { pool, tx, type Db } from '../db.ts'
import { sendToTrash } from '../trash.ts'
import { HttpError, id, text } from '../util.ts'
import { op } from './common.ts'
import { fuente } from './feed.ts'

/** Máximo de menciones explícitas por uuid en un mensaje (las de @Nombre salen del texto). */
const MAX_MENCIONES = 20
const US = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

/** Instante con zona (hasta microsegundos): el mismo texto que devolvió la API en creado_el / leido_hasta. */
const instante = z
  .string('Fecha inválida')
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/, 'Fecha inválida: usa el creado_el que devolvió un mensaje (ej. 2026-10-08T15:04:05.123456Z)')

const cuerpo = text(4000)
const menciones = z.array(id, 'menciones debe ser una lista de ids de astronauta').max(MAX_MENCIONES, `Máximo ${MAX_MENCIONES} menciones por id`)

// ---------- salida ----------
const SELECT = `SELECT m.id, m.body, m.source, m.external_key, m.edited_at, m.updated_at, ${US('m.created_at')} AS created_us,
    u.id AS author_id, u.name AS author_name,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id', x.id, 'nombre', x.name) ORDER BY lower(x.name))
              FROM chat_mentions cm JOIN users x ON x.id = cm.user_id WHERE cm.message_id = m.id), '[]'::jsonb) AS mentions
  FROM chat_messages m JOIN users u ON u.id = m.author_id`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mensajeOut = (r: any) => ({
  id: r.id as string,
  autor: { id: r.author_id as string, nombre: r.author_name as string },
  cuerpo: r.body as string,
  fuente: r.source as string,
  clave_externa: (r.external_key ?? null) as string | null,
  menciones: r.mentions as { id: string; nombre: string }[],
  editado_el: stamp(r.edited_at),
  creado_el: r.created_us as string,
  actualizado_el: stamp(r.updated_at),
})
export type Mensaje = ReturnType<typeof mensajeOut>

/** null si no existe (lo usa el stream en vivo: un mensaje borrado entre el aviso y la lectura no es un error). */
export async function mensajePorId(db: Db, mensajeId: string): Promise<Mensaje | null> {
  const r = (await db.query(`${SELECT} WHERE m.id = $1`, [mensajeId])).rows[0]
  return r ? mensajeOut(r) : null
}
async function mensaje(db: Db, mensajeId: string): Promise<Mensaje> {
  const m = await mensajePorId(db, mensajeId)
  if (!m) throw new HttpError(404, 'Mensaje no encontrado')
  return m
}

// ---------- contadores ----------
/** El "leído hasta" nace en now() la primera vez que el socio mira el chat: nadie arranca con todo el historial sin leer. */
async function contadores(db: Db, userId: string) {
  await db.query('INSERT INTO chat_reads (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId])
  const r = (
    await db.query(
      `SELECT ${US('r.read_at')} AS leido_hasta,
         (SELECT count(*)::int FROM chat_messages m WHERE m.author_id <> $1 AND m.created_at > r.read_at) AS sin_leer,
         (SELECT count(*)::int FROM chat_mentions cm JOIN chat_messages m ON m.id = cm.message_id
           WHERE cm.user_id = $1 AND m.author_id <> $1 AND m.created_at > r.read_at) AS menciones_sin_leer
       FROM chat_reads r WHERE r.user_id = $1`,
      [userId],
    )
  ).rows[0]
  return { sin_leer: r.sin_leer as number, menciones_sin_leer: r.menciones_sin_leer as number, leido_hasta: r.leido_hasta as string }
}

export const chatContadores = op(z.strictObject({}), (actor) => contadores(pool, actor.id))

// ---------- menciones ----------
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A quién menciona el mensaje: los `@Nombre` del texto que coinciden (sin importar mayúsculas) con un astronauta activo, más los ids
 * explícitos. Un @ que no corresponde a nadie (un correo, «@todos») se ignora: es texto, no un error. Un id explícito que no existe o
 * está inactivo sí es un error (400). Sin repetidos y sin el propio autor.
 */
async function resolverMenciones(db: Db, autor: string, texto: string, ids: string[] | undefined): Promise<string[]> {
  const users = (await db.query('SELECT id, name FROM users WHERE active')).rows as { id: string; name: string }[]
  const out = new Set<string>()
  let resto = texto
  // Los nombres más largos primero: «@Ana María» no se confunde con «@Ana».
  for (const u of [...users].sort((a, b) => b.name.length - a.name.length)) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])@${escape(u.name)}(?![\\p{L}\\p{N}_])`, 'giu')
    if (re.test(resto)) {
      out.add(u.id)
      resto = resto.replace(re, ' ')
    }
  }
  const explicitos = [...new Set(ids ?? [])]
  if (explicitos.length) {
    const validos = new Set(users.map((u) => u.id))
    const malos = explicitos.filter((x) => !validos.has(x))
    if (malos.length) throw new HttpError(400, `menciones: no existe un astronauta activo con id ${malos.join(', ')}`)
    for (const x of explicitos) out.add(x)
  }
  out.delete(autor)
  return [...out]
}

const guardarMenciones = async (c: Db, mensajeId: string, ids: string[]) => {
  if (ids.length) await c.query('INSERT INTO chat_mentions (message_id, user_id) SELECT $1, unnest($2::uuid[])', [mensajeId, ids])
}

// ---------- listar ----------
export const chatListar = op(
  z
    .strictObject({
      limite: z.number('limite debe ser un entero').int('limite debe ser un entero').min(1).max(100).default(30),
      // Cursor keyset: el (creado_el, id) del mensaje MÁS VIEJO que ya tienes; devuelve los anteriores. Van juntos.
      antes_de: instante.optional(),
      antes_de_id: id.optional(),
    })
    .refine((v) => (v.antes_de === undefined) === (v.antes_de_id === undefined), 'antes_de y antes_de_id van juntos (el creado_el y el id del mensaje más viejo que tienes)'),
  async (actor, i) => {
    const args: unknown[] = []
    const where = i.antes_de !== undefined ? `WHERE (m.created_at, m.id) < ($${args.push(i.antes_de)}::timestamptz, $${args.push(i.antes_de_id)}::uuid)` : ''
    const rows = (await pool.query(`${SELECT} ${where} ORDER BY m.created_at DESC, m.id DESC LIMIT $${args.push(i.limite + 1)}`, args)).rows
    const hayMas = rows.length > i.limite
    const data = rows.slice(0, i.limite).map(mensajeOut)
    const viejo = data.at(-1)
    return {
      data, // el más reciente primero
      meta: {
        limite: i.limite,
        hay_mas: hayMas,
        // Para pedir la página siguiente (los anteriores): antes_de=<creado_el>&antes_de_id=<id>
        siguiente: hayMas && viejo ? { antes_de: viejo.creado_el, antes_de_id: viejo.id } : null,
        ...(await contadores(pool, actor.id)),
      },
    }
  },
)

export const chatVer = op(z.strictObject({ id }), (_a, i) => mensaje(pool, i.id))

/** Los astronautas a quienes se puede mencionar (con su id para `menciones`; en el texto basta @Nombre). */
export const chatUsuarios = op(z.strictObject({}), async () => {
  const { rows } = await pool.query('SELECT id, name, avatar FROM users WHERE active ORDER BY created_at, name')
  return { data: rows.map((r) => ({ id: r.id as string, nombre: r.name as string, avatar: r.avatar as string })) }
})

// ---------- publicar ----------
export const chatPublicar = op(
  z.strictObject({
    cuerpo,
    fuente, // origen lógico; la web manda 'manual'
    clave_externa: text(200).nullish(), // idempotencia por fuente: la misma (fuente, clave_externa) no se publica dos veces
    menciones: menciones.optional(), // ids de astronauta además de los @Nombre del texto
  }),
  async (actor, b) => {
    const r = await tx(async (c) => {
      const ins = await c.query(
        `INSERT INTO chat_messages (author_id, body, source, external_key) VALUES ($1, $2, $3, $4)
         ON CONFLICT (source, external_key) WHERE external_key IS NOT NULL DO NOTHING RETURNING id`,
        [actor.id, b.cuerpo, b.fuente, b.clave_externa ?? null],
      )
      if (!ins.rowCount) {
        const ya = (await c.query('SELECT id FROM chat_messages WHERE source = $1 AND external_key = $2', [b.fuente, b.clave_externa])).rows[0]
        if (!ya) throw new HttpError(409, 'El mensaje cambió mientras se publicaba: vuelve a intentarlo')
        return { m: await mensaje(c, ya.id), creado: false }
      }
      const mid = ins.rows[0].id as string
      await guardarMenciones(c, mid, await resolverMenciones(c, actor.id, b.cuerpo, b.menciones))
      await notifyChat(c, 'nuevo', mid)
      return { m: await mensaje(c, mid), creado: true }
    })
    return { ...r.m, creado: r.creado }
  },
)

// ---------- editar ----------
export const chatEditar = op(
  z.strictObject({
    id,
    cuerpo,
    // Si la mandas, reemplaza las menciones por id; en cualquier caso se recalculan también las @Nombre del texto nuevo.
    menciones: menciones.optional(),
  }),
  async (actor, b) => {
    await tx(async (c) => {
      const cur = (await c.query('SELECT author_id, body FROM chat_messages WHERE id = $1 FOR UPDATE', [b.id])).rows[0]
      if (!cur) throw new HttpError(404, 'Mensaje no encontrado')
      if (cur.author_id !== actor.id) throw new HttpError(403, 'Solo el autor puede editar su mensaje')
      await assertFresh(c, 'chat_messages', b.id)
      if (cur.body === b.cuerpo && b.menciones === undefined) return // nada cambió: no se marca como editado
      await c.query('UPDATE chat_messages SET body = $2, edited_at = now() WHERE id = $1', [b.id, b.cuerpo])
      await c.query('DELETE FROM chat_mentions WHERE message_id = $1', [b.id])
      await guardarMenciones(c, b.id, await resolverMenciones(c, actor.id, b.cuerpo, b.menciones))
      await notifyChat(c, 'editado', b.id)
    })
    return mensaje(pool, b.id)
  },
)

// ---------- borrar ----------
/** Solo el autor o un ADMIN. Va a la papelera 30 días (entidad «mensaje») y se restaura con todo y menciones. */
export const chatBorrar = op(z.strictObject({ id }), async (actor, i) => {
  const m = (await pool.query('SELECT author_id FROM chat_messages WHERE id = $1', [i.id])).rows[0]
  if (!m) throw new HttpError(404, 'Mensaje no encontrado')
  if (m.author_id !== actor.id) {
    const rol = (await pool.query('SELECT role FROM users WHERE id = $1', [actor.id])).rows[0]?.role
    if (rol !== 'ADMIN') throw new HttpError(403, 'Solo el autor o un administrador puede borrar este mensaje')
  }
  return sendToTrash('mensaje', i.id, actor.id, actor.via ?? 'web')
})

// ---------- marcar leído ----------
export const chatMarcarLeido = op(
  z
    .strictObject({
      // creado_el del mensaje más nuevo que viste (el cursor nunca retrocede ni pasa de «ahora»); o todos=true: hasta el último.
      hasta: instante.optional(),
      todos: z.literal(true, 'todos solo admite true').optional(),
    })
    .refine((v) => (v.hasta === undefined) !== (v.todos === undefined), 'Envía hasta (el creado_el del mensaje más nuevo que viste) o todos=true'),
  async (actor, b) => {
    await contadores(pool, actor.id) // crea la fila la primera vez
    await pool.query(
      `UPDATE chat_reads SET read_at = greatest(read_at, least(coalesce($2::timestamptz, (SELECT max(created_at) FROM chat_messages), read_at), now())) WHERE user_id = $1`,
      [actor.id, b.hasta ?? null],
    )
    return contadores(pool, actor.id)
  },
)
