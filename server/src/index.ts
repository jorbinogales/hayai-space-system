import { createApp } from './app.ts'
import { pool } from './db.ts'
import { seedIfEmpty } from './seed.ts'

const port = Number(process.env.PORT ?? 3001)

try {
  await seedIfEmpty()
} catch (e) {
  console.error('No se pudo preparar la BD (¿corriste `npm run db:dev` y `npm run db:migrate`?):', (e as Error).message)
  process.exit(1)
}

const server = createApp().listen(port, () => console.log(`HAYAI API en http://localhost:${port}`))

const stop = () => {
  server.close()
  pool.end().finally(() => process.exit(0))
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
