// Relleno de ubicaciones del feed: busca las coordenadas de los ítems que tienen dirección (datos.donde) y todavía no tienen pin.
// Idempotente: lo ya ubicado (por búsqueda, a mano o desde los datos) no se vuelve a pedir; se puede correr las veces que haga falta.
//
//   npm run feed:geocodificar                    -> busca todos los pendientes (1 consulta por segundo: ~1 min por cada 50)
//   npm run feed:geocodificar -- --ensayo        -> no consulta nada: cuenta lo que haría
//   npm run feed:geocodificar -- --tipo potencial --limite 100
//   npm run feed:geocodificar -- --reintentar    -> repite también los que ya dieron «sin resultado» (p. ej. tras corregir direcciones)
//
//   npm run feed:geocodificar -- --medir [--proveedor nominatim|mapbox|ambos] [--tipo potencial] [--limite N] [--json]
//        -> MIDE la cobertura de cada proveedor con las direcciones reales del feed y NO guarda nada (para decidir cuál usar)
//
// Usa la misma base de datos y el mismo proveedor que el servidor: DATABASE_URL y GEOCODER = nominatim (por defecto) | mapbox | off
// (con mapbox, MAPBOX_PUBLIC_TOKEN; GEOCODER_URL / GEOCODER_MIN_MS / GEOCODER_USER_AGENT son opcionales). Funciona igual con cualquiera.
// En producción: `railway run npm run feed:geocodificar` o POST /api/v1/feed/geocodificar (hace lo mismo en segundo plano).
import { pool } from './db.ts'
import { rellenarUbicaciones } from './feedGeo.ts'
import { crearGeocoder, estadoGeocoder, type Geocoder } from './geocode.ts'
import { medir } from './feedGeoMedir.ts'

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
if (flag('medir')) {
  const quien = (val('proveedor') ?? process.env.GEOCODER ?? 'nominatim').toLowerCase()
  const lista = quien === 'ambos' ? ['nominatim', 'mapbox'] : [quien]
  const provs: Geocoder[] = []
  try {
    for (const p of lista) {
      if (p === 'off') throw new Error('--proveedor off: no hay con qué medir')
      const gc = crearGeocoder({ ...process.env, GEOCODER: p })
      if (gc) provs.push(gc)
    }
  } catch (e) {
    console.error(`No se puede medir: ${(e as Error).message}`)
    process.exit(2)
  }
  const med = []
  for (const prov of provs) {
    console.log(`\nMidiendo con ${prov.nombre}…`)
    med.push(await medir(prov, { tipo: val('tipo'), limite, progreso: (t, r) => console.log(`${r.padEnd(13)} ${t.slice(0, 60)}`) }))
  }
  if (flag('json')) console.log(JSON.stringify(med.map((m) => ({ ...m, detalle: [...m.detalle].map(([id, d]) => ({ id, ...d })) })), null, 2))
  console.log('\nProveedor    Evaluadas  Con pin  Cobertura  Exacta/calle  Zona  Sin result.  Errores  Consultas  Segundos')
  for (const m of med)
    console.log(`${m.proveedor.padEnd(12)} ${String(m.evaluados).padStart(9)}  ${String(m.encontrados).padStart(7)}  ${(m.cobertura === null ? '-' : `${m.cobertura}%`).padStart(9)}  ${(m.cobertura_fina === null ? '-' : `${m.cobertura_fina}%`).padStart(12)}  ${String(m.por_resultado.zona).padStart(4)}  ${String(m.por_resultado.sin_resultado).padStart(10)}  ${String(m.por_resultado.error).padStart(7)}  ${String(m.consultas).padStart(9)}  ${String(m.segundos).padStart(8)}`)
  if (med.length === 2) {
    const [a, b] = med
    const solo = (x: typeof a, y: typeof a) => [...x.detalle].filter(([id, d]) => ['exacta', 'calle', 'zona'].includes(d.resultado) && !['exacta', 'calle', 'zona'].includes(y.detalle.get(id)?.resultado ?? '')).map(([, d]) => d)
    console.log(`\nSolo ${a.proveedor} encontró: ${solo(a, b).length} · solo ${b.proveedor} encontró: ${solo(b, a).length} (direcciones que el otro no resolvió)`)
    for (const d of solo(b, a).slice(0, 10)) console.log(`  solo ${b.proveedor}: ${d.titulo.slice(0, 40)} — ${d.direccion.slice(0, 80)}`)
    for (const d of solo(a, b).slice(0, 10)) console.log(`  solo ${a.proveedor}: ${d.titulo.slice(0, 40)} — ${d.direccion.slice(0, 80)}`)
  }
  console.log('\nMedición: no se guardó nada en el feed.')
  await pool.end()
  process.exit(0)
}

const g = estadoGeocoder({ estricto: true }) // el script no cae a Nominatim a escondidas: si pediste Mapbox y falta el token, para
if (g.error) {
  console.error(`El geocodificador está mal configurado: ${g.error}`)
  process.exit(2)
}
if (!flag('ensayo') && !g.proveedor) {
  console.error('El geocodificador está apagado (GEOCODER=off): no hay con qué buscar. Usa --ensayo para solo contar.')
  process.exit(2)
}
console.log(`Proveedor: ${g.proveedor ?? 'apagado'}`)

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
