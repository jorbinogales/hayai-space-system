// Geocodificación (dirección en texto -> coordenadas) para el mapa del feed. El proveedor va detrás de una interfaz: hoy es Nominatim
// (OpenStreetMap, gratis y sin llave); cambiar a otro (Photon, un Nominatim propio, un servicio de pago) es escribir otro `Geocoder`
// y elegirlo con GEOCODER. Nada de esto inventa coordenadas: sin resultado, o con uno demasiado grueso (la ciudad entera), devuelve null.
//
// Política de uso de Nominatim (https://operations.osmfoundation.org/policies/nominatim/): máximo 1 petición por segundo en total,
// User-Agent que identifique la aplicación (nunca el de la librería HTTP), nada de barridos masivos. Por eso todas las consultas de este
// proceso pasan por UNA cola con espera mínima entre peticiones, y los resultados se guardan en el ítem para no volver a pedirlos.

export type Precision = 'exacta' | 'calle' | 'zona'
export type GeoResultado = {
  lat: number
  lng: number
  /** exacta: el edificio o el local · calle: la vía · zona: el centro de la urbanización o el barrio (aproximada). */
  precision: Precision
  /** Cómo lo nombra el proveedor (para mostrar «encontrado como…»). */
  nombre: string
}

export interface Geocoder {
  readonly nombre: string
  /** null = el proveedor respondió pero no encontró nada utilizable. Lanza si falló la consulta (red, 5xx, 429): se puede reintentar. */
  buscar(consulta: string): Promise<GeoResultado | null>
}

export class GeocoderError extends Error {}

// Venezuela (con holgura): fuera de esto, un resultado es un error del proveedor y se descarta.
const VE = { lat: [0.5, 12.5], lng: [-73.5, -59.5] } as const
export const enVenezuela = (lat: number, lng: number) => lat >= VE.lat[0] && lat <= VE.lat[1] && lng >= VE.lng[0] && lng <= VE.lng[1]

/** Centro de Barquisimeto: el mapa arranca aquí y las búsquedas se inclinan hacia esta zona (sin excluir el resto del país). */
export const CENTRO = { lat: 10.0647, lng: -69.3570 } as const
// viewbox de Nominatim: izquierda,arriba,derecha,abajo
const SESGO = '-69.60,10.30,-69.00,9.85'

const num = (v: unknown) => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

/** Qué tan fino es un resultado de Nominatim: place_rank 30 = edificio, 26 = calle, 20-25 = urbanización o barrio, menos = ciudad, municipio, estado. */
export function precisionDe(rank: number): Precision | null {
  if (rank >= 28) return 'exacta'
  if (rank >= 26) return 'calle'
  if (rank >= 20) return 'zona'
  return null
}

export type NominatimOpts = { url: string; userAgent: string; minMs: number; timeoutMs: number; email?: string }

/** Una sola cola por proceso: ni dos consultas en paralelo ni más rápido que `minMs` (1 s mínimo, 1,1 por defecto). */
let cola: Promise<unknown> = Promise.resolve()
let ultima = 0
function enCola<T>(minMs: number, f: () => Promise<T>): Promise<T> {
  const turno = cola.then(async () => {
    const espera = ultima + minMs - Date.now()
    if (espera > 0) await new Promise((r) => setTimeout(r, espera))
    try {
      return await f()
    } finally {
      ultima = Date.now()
    }
  })
  cola = turno.catch(() => undefined)
  return turno
}

export function nominatim(o: NominatimOpts): Geocoder {
  return {
    nombre: 'nominatim',
    buscar: (consulta) =>
      enCola(o.minMs, async () => {
        const u = new URL('/search', o.url)
        u.searchParams.set('q', consulta)
        u.searchParams.set('format', 'jsonv2')
        u.searchParams.set('limit', '4')
        u.searchParams.set('countrycodes', 've')
        u.searchParams.set('accept-language', 'es')
        u.searchParams.set('viewbox', SESGO) // inclina, no excluye (bounded=0)
        if (o.email) u.searchParams.set('email', o.email)
        let res: Response
        try {
          res = await fetch(u, { headers: { 'User-Agent': o.userAgent, Accept: 'application/json', 'Accept-Language': 'es' }, signal: AbortSignal.timeout(o.timeoutMs) })
        } catch (e) {
          throw new GeocoderError(`Nominatim no respondió (${(e as Error).name === 'TimeoutError' ? 'tiempo agotado' : (e as Error).message})`)
        }
        if (!res.ok) throw new GeocoderError(`Nominatim respondió ${res.status}`)
        const lista = (await res.json().catch(() => null)) as unknown
        if (!Array.isArray(lista)) throw new GeocoderError('Nominatim devolvió una respuesta que no se entiende')
        for (const r of lista as Record<string, unknown>[]) {
          const lat = num(r.lat)
          const lng = num(r.lon)
          const rank = num(r.place_rank)
          if (lat === null || lng === null || rank === null || !enVenezuela(lat, lng)) continue
          const precision = precisionDe(rank)
          if (!precision) continue // «Barquisimeto» a secas no es la ubicación de un negocio: mejor sin pin que un pin falso
          return { lat, lng, precision, nombre: typeof r.display_name === 'string' ? r.display_name.slice(0, 300) : consulta }
        }
        return null
      }),
  }
}

// ---------- elección del proveedor (por entorno) ----------
export const GEO_UA = process.env.GEOCODER_USER_AGENT?.trim() || 'HAYAI-Space/1.0 (+https://space.hayai.com.ve)'

let activo: Geocoder | null | undefined
/** El geocodificador configurado, o null si está apagado (GEOCODER=off): los ítems quedan «pendientes» y el mapa los muestra en la bandeja. */
export function geocoder(): Geocoder | null {
  if (activo !== undefined) return activo
  const prov = (process.env.GEOCODER ?? 'nominatim').trim().toLowerCase()
  if (prov === 'off' || prov === 'none' || prov === '') return (activo = null)
  if (prov !== 'nominatim') throw new Error(`GEOCODER desconocido: ${prov} (nominatim | off)`)
  const url = process.env.GEOCODER_URL?.trim() || 'https://nominatim.openstreetmap.org'
  // Con el servidor público el mínimo es 1 s (la política lo exige); un Nominatim propio o uno de pruebas puede ir más rápido.
  const publico = /(^|\/\/)nominatim\.openstreetmap\.org/.test(url)
  const pedido = Number(process.env.GEOCODER_MIN_MS)
  const minMs = Math.max(publico ? 1000 : 0, Number.isFinite(pedido) && process.env.GEOCODER_MIN_MS ? pedido : 1100)
  return (activo = nominatim({ url, userAgent: GEO_UA, minMs, timeoutMs: Number(process.env.GEOCODER_TIMEOUT_MS) || 10_000, email: process.env.GEOCODER_EMAIL?.trim() || undefined }))
}
/** Solo para pruebas: vuelve a leer el entorno. */
export const reiniciarGeocoder = () => {
  activo = undefined
}

// ---------- de una dirección venezolana a consultas que Nominatim entienda ----------
const CIUDADES = /\b(barquisimeto|cabudare|carora|quibor|el tocuyo|duaca|sarare|araure|acarigua|guanare|san felipe|valencia|maracay|caracas|merida|maracaibo|punto fijo|coro)\b/i
const sinTildes = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '')

/**
 * Variantes de consulta, de la más específica a la más general, sin repetir. Las direcciones de aquí rara vez cuadran con OSM
 * («Av. Lara con calle 30, C.C. Las Trinitarias, local 12»): se quita lo que solo sirve para llegar al local y, si hace falta, se
 * va soltando el primer tramo para quedarse con la urbanización o el sector.
 */
export function consultasDe(direccion: string, negocio?: string | null): string[] {
  const limpia = direccion.replace(/\s+/g, ' ').replace(/[\n\r]+/g, ', ').trim()
  const tieneCiudad = CIUDADES.test(sinTildes(limpia))
  const cola = tieneCiudad ? '' : ', Barquisimeto, Lara'
  const out: string[] = []
  const meter = (q: string) => {
    const t = q.replace(/\s+/g, ' ').replace(/^[\s,.-]+|[\s,.-]+$/g, '')
    if (t.length >= 4 && !out.includes(t)) out.push(t)
  }
  meter(`${limpia}${cola}`)
  // Detalles de interior que OSM no conoce: local, piso, nivel, oficina, galpón, apto, planta baja, c.c./centro comercial (el nombre se conserva).
  const sinInterior = limpia
    .replace(/\b(local|loc\.?|nivel|piso|planta baja|pb|oficina|ofic\.?|galp[oó]n|apto\.?|apartamento|torre)\s*#?\s*[\w-]*/gi, '')
    .replace(/\b(frente a|diagonal a|al lado de|cerca de|detr[aá]s de|entre)\b.*$/i, '')
    .replace(/\s{2,}/g, ' ')
  meter(`${sinInterior}${cola}`)
  const tramos = limpia.split(/\s*,\s*/).filter(Boolean)
  if (tramos.length >= 3) meter(`${tramos.slice(1).join(', ')}${cola}`)
  if (tramos.length >= 2) meter(`${tramos.slice(-2).join(', ')}${cola}`)
  if (negocio) meter(`${negocio}, ${tieneCiudad ? limpia : 'Barquisimeto, Lara'}`)
  return out.slice(0, 4)
}
