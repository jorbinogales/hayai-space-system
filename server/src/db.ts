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
