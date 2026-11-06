import pg from 'pg'

// date -> 'YYYY-MM-DD' (sin pasar por Date/zona horaria); numeric(14,2) -> number (cabe de sobra en un double).
pg.types.setTypeParser(1082, (v) => v)
pg.types.setTypeParser(1700, (v) => Number(v))

const isProd = process.env.NODE_ENV === 'production'
const connectionString =
  process.env.DATABASE_URL ?? (isProd ? undefined : 'postgres://hayai:hayai@localhost:54329/hayai')
if (!connectionString) throw new Error('Falta DATABASE_URL')

export { connectionString }
export const pool = new pg.Pool({ connectionString, max: 10 })
pool.on('error', (e) => console.error('pg idle client error:', e.message))

// ---------- red contra el olvido del tenant (migración 039) ----------
// Toda consulta que toque una tabla de negocio debe nombrar tenant_id (filtro, INSERT o ON CONFLICT). La que no, falla aquí en vez
// de leer o escribir en todos los tenants. Lo que de verdad recorre todos los tenants (limpiezas por fecha, colas de trabajo) lo
// declara con el comentario /* todos los tenants */. ponytail: es una red de texto, no una prueba (un JOIN sin filtro propio pasa);
// la FK compuesta (tenant_id, id) de la 039 es la segunda red.
export const TENANT_TABLES = [
  'clients', 'client_items', 'client_logos', 'interactions', 'proposals', 'proposal_items', 'offerings', 'meta_leads',
  'payments', 'payment_receipts', 'receiver_documents', 'projects', 'project_milestones', 'project_checklist', 'tasks', 'expenses',
  'systems', 'system_checks', 'agreements', 'activity', 'activity_seen', 'notification_reads', 'briefs', 'trash', 'api_keys',
  'feed_items', 'feed_item_usuarios', 'feed_item_vinculos', 'feed_guion_versiones', 'competidores',
  'chat_messages', 'chat_mentions', 'chat_reads', 'mk_keywords', 'mk_serp', 'mk_competidores', 'mk_contenidos',
  'boards', 'board_columns', 'board_cards', 'board_card_comments',
]
const TOUCHES = new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE|TABLE|NULL::)\\s*(?:ONLY\\s+)?(?:${TENANT_TABLES.join('|')})\\b`, 'i')
export const ALL_TENANTS = '/* todos los tenants */'
export function assertTenantScoped(text: unknown) {
  if (typeof text !== 'string' || !TOUCHES.test(text) || text.includes('tenant_id') || text.includes(ALL_TENANTS)) return
  throw Object.assign(new Error(`Consulta sin tenant_id sobre una tabla de negocio: ${text.replace(/\s+/g, ' ').slice(0, 200)}`), { code: 'HAYAI_TENANT' })
}
pool.on('connect', (client) => {
  const query = client.query.bind(client) as (...a: unknown[]) => unknown
  ;(client as unknown as { query: (...a: unknown[]) => unknown }).query = (...a: unknown[]) => {
    const q = a[0] as string | { text?: string }
    try {
      assertTenantScoped(typeof q === 'string' ? q : q?.text)
    } catch (e) {
      const cb = a.find((x) => typeof x === 'function') as ((e: unknown) => void) | undefined
      if (cb) return void process.nextTick(() => cb(e)) // pool.query usa la forma con callback
      return Promise.reject(e)
    }
    return query(...a)
  }
})

export type Db = pg.Pool | pg.PoolClient

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    const out = await fn(c)
    await c.query('COMMIT')
    return out
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}
