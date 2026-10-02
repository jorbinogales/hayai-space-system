// Aplica en orden las migraciones pendientes de ./migrations (NNN_nombre.sql), cada una en su transaccion,
// y las registra en schema_migrations. Uso: DATABASE_URL=postgres://... node server/db/migrate.mjs
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('Falta DATABASE_URL (ver .env.example).')
  process.exit(1)
}

const dir = join(import.meta.dirname, 'migrations')
const files = readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort()
const db = new pg.Client({ connectionString: url })
await db.connect()

try {
  await db.query('SELECT pg_advisory_lock(727274)') // dos runners a la vez no aplican lo mismo dos veces
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`)
  const done = new Map((await db.query('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]))

  let applied = 0
  for (const f of files) {
    const sql = readFileSync(join(dir, f), 'utf8')
    const sum = createHash('sha256').update(sql).digest('hex')
    if (done.has(f)) {
      if (done.get(f) !== sum) throw new Error(`${f} cambio despues de aplicarse. No edites migraciones aplicadas: crea una nueva.`)
      continue
    }
    await db.query('BEGIN')
    try {
      await db.query(sql)
      await db.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [f, sum])
      await db.query('COMMIT')
    } catch (e) {
      await db.query('ROLLBACK')
      throw new Error(`${f}: ${e.message}`)
    }
    console.log(`aplicada ${f}`)
    applied++
  }
  console.log(applied ? `${applied} migracion(es) aplicada(s).` : 'Sin migraciones pendientes.')
} catch (e) {
  console.error(e.message)
  process.exitCode = 1
} finally {
  await db.end()
}
