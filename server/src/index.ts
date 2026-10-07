import { createApp } from './app.ts'
import { pool } from './db.ts'
import { startEvents, stopEvents } from './events.ts'
import { startMetaWorker, stopMetaWorker } from './meta.ts'
import { startBcvWorker, stopBcvWorker } from './bcv.ts'
import { seedIfEmpty } from './seed.ts'
import { seedReceiverDocuments } from './services/cobros.ts'
import { startSystemsWorker, stopSystemsWorker } from './systems.ts'

const port = Number(process.env.PORT ?? 3001)

try {
  await seedIfEmpty()
} catch (e) {
  console.error('No se pudo preparar la BD (¿corriste `npm run db:dev` y `npm run db:migrate`?):', (e as Error).message)
  process.exit(1)
}

await seedReceiverDocuments().catch((e) => console.error('receptores: no se pudo sembrar el mapeo de documentos:', (e as Error).message))

await startEvents().catch((e) => console.error('events: no arrancó (la web seguirá consultando):', (e as Error).message))

startBcvWorker() // tasa BCV de la barra superior (BCV_REFRESH_MS; 0 lo apaga)
startSystemsWorker() // semáforo de los sistemas de los clientes (SYSTEMS_CHECK_MS; 0 lo apaga)
startMetaWorker() // solo hace algo con META_LEADS_ENABLED=true: reintenta los leads que Graph no entrego

const server = createApp().listen(port, () => console.log(`HAYAI API en http://localhost:${port}`))

const stop = () => {
  stopMetaWorker()
  stopSystemsWorker()
  stopBcvWorker()
  stopEvents() // cierra los streams abiertos; si no, server.close() espera a que cada pestaña se desconecte
  server.close()
  pool.end().finally(() => process.exit(0))
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
