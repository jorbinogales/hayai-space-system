// Medición de cobertura de la geocodificación: para decidir con datos reales entre Nominatim y Mapbox. Toma las direcciones (datos.donde…) de
// los ítems del feed, las busca con el proveedor y cuenta cuántas se resuelven y con qué precisión. NO escribe nada: ni datos.geo ni el
// ítem (los resultados de Mapbox no se guardan en una medición). Idempotente y sin efectos; se puede correr cuando se quiera.
import { pool } from './db.ts'
import { direccionDe } from './feedGeo.ts'
import { consultasDe, GeocoderError, type Geocoder, type Precision } from './geocode.ts'

export type ResultadoMedida = 'exacta' | 'calle' | 'zona' | 'sin_resultado' | 'error'
export type Medicion = {
  proveedor: string
  evaluados: number
  /** exacta + calle + zona */
  encontrados: number
  por_resultado: Record<ResultadoMedida, number>
  /** % de las direcciones evaluadas que quedaron con pin */
  cobertura: number | null
  /** % con precisión exacta o de calle (no solo «el sector») */
  cobertura_fina: number | null
  consultas: number
  segundos: number
  /** id del ítem -> qué resultó */
  detalle: Map<string, { titulo: string; direccion: string; resultado: ResultadoMedida; nombre: string | null }>
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null)

export async function medir(prov: Geocoder, o: { tipo?: string; limite?: number; progreso?: (titulo: string, r: ResultadoMedida) => void } = {}): Promise<Medicion> {
  const rows = (await pool.query(`SELECT id, title, data FROM feed_items WHERE ($1::text IS NULL OR kind = $1) ORDER BY found_at DESC, id`, [o.tipo ?? null])).rows
  const m: Medicion = {
    proveedor: prov.nombre,
    evaluados: 0,
    encontrados: 0,
    por_resultado: { exacta: 0, calle: 0, zona: 0, sin_resultado: 0, error: 0 },
    cobertura: null,
    cobertura_fina: null,
    consultas: 0,
    segundos: 0,
    detalle: new Map(),
  }
  const t0 = Date.now()
  for (const r of rows) {
    const direccion = direccionDe((r.data ?? {}) as Record<string, unknown>)
    if (!direccion) continue
    if (o.limite !== undefined && m.evaluados >= o.limite) break
    m.evaluados++
    let resultado: ResultadoMedida = 'sin_resultado'
    let nombre: string | null = null
    try {
      for (const q of consultasDe(direccion, r.title as string)) {
        m.consultas++
        const hit = await prov.buscar(q)
        if (hit) {
          resultado = hit.precision as Precision
          nombre = hit.nombre
          break
        }
      }
    } catch (e) {
      if (!(e instanceof GeocoderError)) throw e
      resultado = 'error'
    }
    m.por_resultado[resultado]++
    m.detalle.set(r.id as string, { titulo: r.title as string, direccion, resultado, nombre })
    o.progreso?.(r.title as string, resultado)
  }
  m.encontrados = m.por_resultado.exacta + m.por_resultado.calle + m.por_resultado.zona
  m.cobertura = pct(m.encontrados, m.evaluados)
  m.cobertura_fina = pct(m.por_resultado.exacta + m.por_resultado.calle, m.evaluados)
  m.segundos = Math.round((Date.now() - t0) / 100) / 10
  return m
}
