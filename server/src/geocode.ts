// Geocodificación (dirección en texto -> coordenadas) para el mapa del feed. El proveedor va detrás de una interfaz y se elige con
// GEOCODER: `nominatim` (OpenStreetMap, gratis y sin llave; el predeterminado), `mapbox` (token público en MAPBOX_PUBLIC_TOKEN, solo en el
// servidor) u `off`. Agregar otro es escribir otro `Geocoder` y registrarlo en `crearGeocoder`. Nada de esto inventa coordenadas: sin
// resultado, o con uno demasiado grueso (la ciudad entera), devuelve null.
//
// Política de uso de Nominatim (https://operations.osmfoundation.org/policies/nominatim/): máximo 1 petición por segundo en total,
// User-Agent que identifique la aplicación (nunca el de la librería HTTP), nada de barridos masivos. Por eso todas las consultas de este
// proceso pasan por UNA cola con espera mínima entre peticiones, y los resultados se guardan en el ítem para no volver a pedirlos.

export type Precision = 'exacta' | 'calle' | 'zona'
/** Quién encontró las coordenadas (se guarda en datos.geo.origen; `manual` y `datos` no pasan por un geocodificador). */
export type ProveedorGeo = 'nominatim' | 'mapbox'
export type GeoResultado = {
  lat: number
  lng: number
  /** exacta: el edificio o el local · calle: la vía · zona: el centro de la urbanización o el barrio (aproximada). */
  precision: Precision
  /** Cómo lo nombra el proveedor (para mostrar «encontrado como…»). */
  nombre: string
}

export interface Geocoder {
  readonly nombre: ProveedorGeo
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

// ---------- Mapbox (Geocoding API v6) ----------
export type MapboxOpts = { url: string; token: string; minMs: number; timeoutMs: number; permanent?: boolean }

/** Qué tan fino es un resultado de Mapbox. null = demasiado grueso (ciudad, municipio, estado, código postal) o poco fiable: sin pin. */
export function precisionMapbox(tipo: unknown, exactitud: unknown, confianza: unknown): Precision | null {
  if (confianza === 'low') return null // «encontré algo parecido»: mejor que la siguiente consulta, más general, diga el sector
  switch (tipo) {
    case 'poi':
      return 'exacta'
    case 'address':
      // rooftop / parcel / point = el edificio; interpolated / street / approximate = sobre la calle, no en el portal
      return exactitud === 'rooftop' || exactitud === 'parcel' || exactitud === 'point' ? 'exacta' : 'calle'
    case 'street':
      return 'calle'
    case 'neighborhood':
    case 'locality':
      return 'zona'
    default:
      return null // place, district, region, country, postcode…
  }
}

export function mapbox(o: MapboxOpts): Geocoder {
  // El token viaja en la URL de la consulta (así lo exige Mapbox): nunca debe acabar en un mensaje de error ni en un log.
  const limpio = (t: string) => t.split(o.token).join('***')
  return {
    nombre: 'mapbox',
    buscar: (consulta) =>
      enCola(o.minMs, async () => {
        const u = new URL('/search/geocode/v6/forward', o.url)
        u.searchParams.set('q', consulta.slice(0, 256))
        u.searchParams.set('country', 've')
        u.searchParams.set('language', 'es')
        u.searchParams.set('limit', '4')
        u.searchParams.set('autocomplete', 'false') // es una dirección completa, no lo que alguien va tecleando
        u.searchParams.set('proximity', `${CENTRO.lng},${CENTRO.lat}`) // inclina hacia Barquisimeto, no excluye el resto del país
        if (o.permanent) u.searchParams.set('permanent', 'true') // Mapbox solo permite guardar resultados con su geocodificación «permanente»
        u.searchParams.set('access_token', o.token)
        let res: Response
        try {
          res = await fetch(u, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(o.timeoutMs) })
        } catch (e) {
          throw new GeocoderError(`Mapbox no respondió (${(e as Error).name === 'TimeoutError' ? 'tiempo agotado' : limpio((e as Error).message)})`)
        }
        if (res.status === 401 || res.status === 403)
          throw new GeocoderError(`Mapbox rechazó el token (${res.status}): revisa MAPBOX_PUBLIC_TOKEN${res.status === 403 && o.permanent ? ' y que la cuenta tenga habilitada la geocodificación permanente' : ''}`)
        if (res.status === 429) throw new GeocoderError('Mapbox respondió 429 (demasiadas consultas): se reintenta luego')
        if (!res.ok) throw new GeocoderError(`Mapbox respondió ${res.status}`)
        const cuerpo = (await res.json().catch(() => null)) as { features?: unknown } | null
        if (!cuerpo || !Array.isArray(cuerpo.features)) throw new GeocoderError('Mapbox devolvió una respuesta que no se entiende')
        for (const f of cuerpo.features as Record<string, unknown>[]) {
          const p = (f.properties ?? {}) as Record<string, unknown>
          const c = (p.coordinates ?? {}) as Record<string, unknown>
          const g = ((f.geometry ?? {}) as { coordinates?: unknown }).coordinates
          const lat = num(c.latitude) ?? (Array.isArray(g) ? num(g[1]) : null)
          const lng = num(c.longitude) ?? (Array.isArray(g) ? num(g[0]) : null)
          if (lat === null || lng === null || !enVenezuela(lat, lng)) continue
          const confianza = ((p.match_code ?? {}) as Record<string, unknown>).confidence
          const precision = precisionMapbox(p.feature_type, c.accuracy, confianza)
          if (!precision) continue
          const nombre = typeof p.full_address === 'string' ? p.full_address : [p.name, p.place_formatted].filter((x) => typeof x === 'string' && x).join(', ')
          return { lat, lng, precision, nombre: (nombre || consulta).slice(0, 300) }
        }
        return null
      }),
  }
}

// ---------- elección del proveedor (por entorno) ----------
export const GEO_UA = process.env.GEOCODER_USER_AGENT?.trim() || 'HAYAI-Space/1.0 (+https://space.hayai.com.ve)'
const PROVEEDORES = 'nominatim | mapbox | off'
/** GEOCODER=mapbox sin MAPBOX_PUBLIC_TOKEN: no es un error del proveedor sino un token que aún no se configuró. */
export class SinTokenMapbox extends Error {}
const entero = (v: string | undefined, def: number) => (v && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : def)

/** El token público de Mapbox: SOLO del entorno del servidor (MAPBOX_PUBLIC_TOKEN). Debe ser público (pk.…): uno secreto (sk.…) se rechaza. */
export function tokenMapbox(env: NodeJS.ProcessEnv = process.env): string | null {
  const t = env.MAPBOX_PUBLIC_TOKEN?.trim()
  if (!t) return null
  if (t.startsWith('sk.') || t.startsWith('tk.')) throw new Error('MAPBOX_PUBLIC_TOKEN tiene un token secreto (sk.…): usa un token público (pk.…) con solo scopes públicos')
  return t
}

/**
 * Crea el geocodificador que dice el entorno: GEOCODER=nominatim (por defecto) | mapbox | off. null = apagado.
 * Lanza si la configuración no sirve (proveedor desconocido, mapbox sin MAPBOX_PUBLIC_TOKEN): mejor decirlo que fingir que busca.
 */
export function crearGeocoder(env: NodeJS.ProcessEnv = process.env): Geocoder | null {
  const prov = (env.GEOCODER ?? 'nominatim').trim().toLowerCase()
  if (prov === 'off' || prov === 'none' || prov === '') return null
  const timeoutMs = entero(env.GEOCODER_TIMEOUT_MS, 10_000) || 10_000
  const url = (env[`${prov.toUpperCase()}_URL`] ?? env.GEOCODER_URL)?.trim() // NOMINATIM_URL / MAPBOX_URL mandan sobre GEOCODER_URL (útil para medir los dos a la vez)
  if (prov === 'mapbox') {
    const token = tokenMapbox(env)
    if (!token) throw new SinTokenMapbox('GEOCODER=mapbox necesita MAPBOX_PUBLIC_TOKEN en el entorno del servidor (token público, pk.…)')
    return mapbox({ url: url || 'https://api.mapbox.com', token, minMs: entero(env.GEOCODER_MIN_MS, 100), timeoutMs, permanent: /^(1|true|si|sí)$/i.test(env.MAPBOX_PERMANENT?.trim() ?? '') })
  }
  if (prov !== 'nominatim') throw new Error(`GEOCODER desconocido: ${prov} (${PROVEEDORES})`)
  const base = url || 'https://nominatim.openstreetmap.org'
  // Con el servidor público el mínimo es 1 s (la política lo exige); un Nominatim propio o uno de pruebas puede ir más rápido.
  const publico = /(^|\/\/)nominatim\.openstreetmap\.org/.test(base)
  const pedido = Number(env.GEOCODER_MIN_MS)
  const minMs = Math.max(publico ? 1000 : 0, Number.isFinite(pedido) && env.GEOCODER_MIN_MS ? pedido : 1100)
  return nominatim({ url: base, userAgent: env.GEOCODER_USER_AGENT?.trim() || GEO_UA, minMs, timeoutMs, email: env.GEOCODER_EMAIL?.trim() || undefined })
}

let activo: Geocoder | null | undefined
/** El geocodificador configurado, o null si está apagado (GEOCODER=off). Lanza si la configuración es inválida. */
export function geocoder(): Geocoder | null {
  if (activo !== undefined) return activo
  try {
    return (activo = crearGeocoder())
  } catch (e) {
    // Mapbox pedido pero sin token (todavía no está en el entorno del servidor): el mapa sigue con Nominatim y se dice una vez en el log.
    // El script y las mediciones (crearGeocoder directo) siguen siendo estrictos. Un token secreto o un proveedor desconocido sí son errores.
    if (!(e instanceof SinTokenMapbox)) throw e
    console.warn('[geocodificar] GEOCODER=mapbox pero MAPBOX_PUBLIC_TOKEN no está definido: se usa Nominatim hasta que se configure el token')
    return (activo = crearGeocoder({ ...process.env, GEOCODER: 'nominatim' }))
  }
}

let avisado = ''
/** Como `geocoder()`, pero con una configuración inválida devuelve null (y lo dice una vez en el log): publicar o abrir el mapa nunca falla por esto. */
export function geocoderOSinConfigurar(): Geocoder | null {
  try {
    return geocoder()
  } catch (e) {
    const m = (e as Error).message
    if (avisado !== m) console.error('[geocodificar]', m), (avisado = m)
    return null
  }
}

/** Estado para mostrar/diagnosticar: qué proveedor está activo y, si la configuración no sirve, por qué. */
export function estadoGeocoder(o: { estricto?: boolean } = {}): { proveedor: ProveedorGeo | null; error: string | null } {
  try {
    // estricto (scripts): GEOCODER=mapbox sin token es un error, no un Nominatim de repuesto
    return { proveedor: (o.estricto ? crearGeocoder() : geocoder())?.nombre ?? null, error: null }
  } catch (e) {
    return { proveedor: null, error: (e as Error).message }
  }
}
/** Solo para pruebas: vuelve a leer el entorno. */
export const reiniciarGeocoder = () => {
  activo = undefined
  avisado = ''
}

// ---------- teselas del mapa ----------
export type Teselas = {
  proveedor: 'osm' | 'mapbox'
  /** plantilla {z}/{x}/{y} para Leaflet */
  url: string
  /** HTML (de este servidor) con la atribución que exige el proveedor */
  atribucion: string
  tamano: number
  zoom_offset: number
  max_zoom: number
}
const ATRIB_OSM = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>'

/**
 * Las teselas que usa el mapa: MAP_TILES=osm (por defecto) | mapbox. Con mapbox se usa el mismo MAPBOX_PUBLIC_TOKEN del servidor, que
 * llega al navegador solo por aquí (no está en el código del front ni en el repo): por eso tiene que ser PÚBLICO y conviene restringirlo
 * a https://space.hayai.com.ve en la cuenta de Mapbox. Estilo con MAPBOX_STYLE (usuario/estilo, por defecto mapbox/streets-v12).
 * Sin token, mapbox cae a OpenStreetMap (y lo dice en el log): un mapa gris no le sirve a nadie.
 */
export function teselas(env: NodeJS.ProcessEnv = process.env): Teselas {
  const osm: Teselas = { proveedor: 'osm', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', atribucion: ATRIB_OSM, tamano: 256, zoom_offset: 0, max_zoom: 19 }
  if ((env.MAP_TILES ?? 'osm').trim().toLowerCase() !== 'mapbox') return osm
  let token: string | null = null
  try {
    token = tokenMapbox(env)
  } catch (e) {
    console.error('[mapa]', (e as Error).message)
  }
  if (!token) {
    console.error('[mapa] MAP_TILES=mapbox sin un MAPBOX_PUBLIC_TOKEN público: se usan las teselas de OpenStreetMap')
    return osm
  }
  const estilo = env.MAPBOX_STYLE?.trim() || 'mapbox/streets-v12'
  if (!/^[\w.-]+\/[\w.-]+$/.test(estilo)) {
    console.error(`[mapa] MAPBOX_STYLE inválido (${estilo}): se usa mapbox/streets-v12`)
    return teselas({ ...env, MAPBOX_STYLE: 'mapbox/streets-v12' })
  }
  const base = (env.MAPBOX_TILES_URL?.trim() || 'https://api.mapbox.com').replace(/\/$/, '')
  return {
    proveedor: 'mapbox',
    url: `${base}/styles/v1/${estilo}/tiles/{z}/{x}/{y}?access_token=${encodeURIComponent(token)}`,
    atribucion: `© <a href="https://www.mapbox.com/about/maps/" target="_blank" rel="noopener noreferrer">Mapbox</a> ${ATRIB_OSM}`,
    tamano: 512, // teselas de 512 px: cuatro veces menos peticiones que las de 256
    zoom_offset: -1,
    max_zoom: 19,
  }
}

/**
 * Lo que el servidor dice del mapa al arrancar. Nunca incluye el token (ni un pedazo): solo si está o no. Sin token NO es un error:
 * el mapa sigue con Nominatim (geocodificación) y OpenStreetMap (teselas).
 */
export function avisosMapa(env: NodeJS.ProcessEnv = process.env): { nivel: 'info' | 'warn'; texto: string }[] {
  const prov = (env.GEOCODER ?? 'nominatim').trim().toLowerCase() || 'off'
  const tiles = (env.MAP_TILES ?? 'osm').trim().toLowerCase() || 'osm'
  const pideMapbox = prov === 'mapbox' || tiles === 'mapbox'
  let token: string | null = null
  try {
    token = tokenMapbox(env)
  } catch (e) {
    return [{ nivel: 'warn', texto: `[mapa] ${(e as Error).message}: el mapa usa Nominatim/OpenStreetMap hasta que se corrija` }]
  }
  if (!token)
    return [
      pideMapbox
        ? { nivel: 'warn', texto: `[mapa] MAPBOX_PUBLIC_TOKEN no está definido y GEOCODER=${prov} / MAP_TILES=${tiles} piden Mapbox: se usa Nominatim/OpenStreetMap hasta que se configure · ¿lo guardaste en GitHub Secrets y no llega? Revisa AcceptEnv en el sshd del VPS y el script de deploy (README, «Mapa del Feed»)` }
        : { nivel: 'info', texto: '[mapa] MAPBOX_PUBLIC_TOKEN no está definido: el mapa usa Nominatim (geocodificación) y OpenStreetMap (teselas) · ¿lo guardaste en GitHub Secrets y no llega? Revisa AcceptEnv en el sshd del VPS y el script de deploy (README, «Mapa del Feed»)' },
    ]
  return [{ nivel: 'info', texto: `[mapa] MAPBOX_PUBLIC_TOKEN definido · geocodificación: ${prov} · teselas: ${tiles}${pideMapbox ? '' : ' (Mapbox listo pero aún sin usar)'}` }]
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
