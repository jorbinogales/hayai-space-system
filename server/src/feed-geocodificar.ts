// Relleno de ubicaciones del feed: busca las coordenadas de los ítems que tienen dirección (datos.donde) y todavía no tienen pin.
// Idempotente: lo ya ubicado (por búsqueda, a mano o desde los datos) no se vuelve a pedir; se puede correr las veces que haga falta.
//
//   npm run feed:geocodificar                    -> busca todos los pendientes (1 consulta por segundo: ~1 min por cada 50)
//   npm run feed:geocodificar -- --ensayo        -> no consulta nada: cuenta lo que haría
//   npm run feed:geocodificar -- --tipo prospecto --limite 100
//   npm run feed:geocodificar -- --reintentar    -> repite también los que ya dieron «sin resultado» (p. ej. tras corregir direcciones)
//
// Usa la misma base de datos y el mismo GEOCODER* que el servidor (DATABASE_URL, GEOCODER, GEOCODER_URL, GEOCODER_USER_AGENT).
// En producción: `railway run npm run feed:geocodificar` o POST /api/v1/feed/geocodificar (hace lo mismo en segundo plano).
import { pool } from './db.ts'
import { rellenarUbicaciones } from './feedGeo.ts'
import { geocoder } from './geocode.ts'

const args = process.argv.slice(2)
const flag = (n: string) => args.includes(`--${n}`)
const val = (n: string) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : undefined
}
const limite = val('limite') ? Number(val('limite')) : undefined
if (limite !== undefined && (!Number.isInteger(limite) || limite < 1)) {
  console.error('--limite debe ser un entero positivo')
  process.exit(2)
}
if (!flag('ensayo') && !geocoder()) {
  console.error('El geocodificador está apagado (GEOCODER=off): no hay con qué buscar. Usa --ensayo para solo contar.')
  process.exit(2)
}

const r = await rellenarUbicaciones({
  tipo: val('tipo'),
  limite,
  reintentar: flag('reintentar'),
  ensayo: flag('ensayo'),
  progreso: (id, titulo, res) => console.log(`${res.padEnd(13)} ${titulo.slice(0, 60)}  (${id})`),
})
console.log(`\nRevisados: ${r.revisados} · con dirección: ${r.con_direccion} · ya ubicados: ${r.ya_ubicados} · ubicados ahora: ${r.ubicados}`)
console.log(`Sin resultado: ${r.sin_resultado} · errores de red: ${r.errores} · por buscar: ${r.pendientes}`)
if (r.cobertura !== null) console.log(`Cobertura: ${r.cobertura}% de los que tienen dirección ya tienen pin${r.cobertura < 80 ? ' (por debajo del 80%: revisa «Sin ubicación» en el mapa y corrige esas direcciones o ponles el pin a mano)' : ''}`)
await pool.end()
