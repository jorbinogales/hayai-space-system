// Postgres 16 embebido para desarrollo (sin Docker ni instalacion). Datos en server/.pgdata.
// Uso: npm run db:dev  (Ctrl+C lo detiene). Reiniciar desde cero: detenerlo y borrar server/.pgdata.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import EmbeddedPostgres from 'embedded-postgres'

const dir = join(import.meta.dirname, '..', '.pgdata')
const port = 54329
const pg = new EmbeddedPostgres({
  databaseDir: dir,
  port,
  user: 'hayai',
  password: 'hayai',
  authMethod: 'scram-sha-256',
  persistent: true,
  // ICU para que lower() y el orden traten bien acentos (José = JOSÉ), igual que la imagen docker en_US.utf8.
  initdbFlags: ['--encoding=UTF8', '--locale-provider=icu', '--icu-locale=und', '--locale=C'],
  onLog: () => {},
})

if (!existsSync(join(dir, 'PG_VERSION'))) await pg.initialise()
await pg.start()

const admin = pg.getPgClient()
await admin.connect()
const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'hayai'")
await admin.end()
if (!rowCount) await pg.createDatabase('hayai')

console.log(`Postgres listo. DATABASE_URL=postgres://hayai:hayai@localhost:${port}/hayai`)
console.log('Ctrl+C para detenerlo.')

let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  await pg.stop()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
setInterval(() => {}, 1 << 30) // mantener vivo el proceso
