// Para `npm run dev:all` (db:dev arranca en paralelo): espera a Postgres y aplica las migraciones pendientes.
import pg from 'pg'

process.env.DATABASE_URL ??= 'postgres://hayai:hayai@localhost:54329/hayai'
const url = process.env.DATABASE_URL

let up = false
for (let i = 0; i < 120 && !up; i++) {
  const c = new pg.Client({ connectionString: url })
  try {
    await c.connect()
    up = true
  } catch {
    await new Promise((r) => setTimeout(r, 500))
  }
  await c.end().catch(() => {})
}
if (!up) {
  console.error('Postgres no respondió en 60 s.')
  process.exit(1)
}
await import('./db/migrate.mjs') // se ejecuta al importarlo; deja process.exitCode=1 si falla
