// Ubicación de los ítems del feed (para la vista de mapa). La dirección en texto llega en `datos` (`donde`, que es lo que trae Growi, u otras
// llaves parecidas); las coordenadas se calculan UNA vez y se guardan en `datos.geo`, con su estado, para que nada se repita ni se invente:
//   { estado: 'ok', lat, lng, precision, origen: 'nominatim' | 'mapbox' | 'manual', consulta, encontrado_como, el }
//   { estado: 'sin_resultado' | 'error', consulta, intentos, el, error? }
// Un ítem con dirección y sin `geo` (o con un `geo` de otra dirección) está «pendiente». Un pin puesto a mano nunca se pisa.
import { pool, type Db } from './db.ts'
import { consultasDe, enVenezuela, geocoderOSinConfigurar, GeocoderError, type Precision } from './geocode.ts'

export type EstadoUbicacion = 'ok' | 'pendiente' | 'sin_resultado' | 'error' | 'sin_direccion'
export type Ubicacion = {
  estado: EstadoUbicacion
  /** La dirección en texto que trae el ítem (donde / direccion…), o null. */
  direccion: string | null
  lat: number | null
  lng: number | null
  /** exacta | calle | zona (aproximada: centro de la urbanización o el barrio). Solo con estado ok. */
  precision: Precision | null
  /** nominatim | mapbox: se buscó la dirección con ese proveedor · manual: alguien puso el pin · datos: ya venía con coordenadas ·
   *  google_maps: salen del enlace de la ficha de Google Maps (`datos.google_maps.url`). */
  origen: 'nominatim' | 'mapbox' | 'manual' | 'datos' | 'google_maps' | null
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim() : null)
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null)

/** Las llaves de `datos` que usan la dirección, el teléfono y la ubicación: el mapa solo trae esas (no el guion ni las fugas). */
export const CLAVES_UBICACION = ['donde', 'direccion', 'dirección', 'ubicacion', 'lugar', 'negocio', 'contacto', 'telefono', 'phone', 'whatsapp', 'geo', 'lat', 'lng', 'latitud', 'longitud', 'google_maps'] as const

/** La dirección del negocio: `datos.donde` (Growi) y, si no, las llaves de uso común, también dentro de `negocio` y `contacto`. */
export function direccionDe(d: Record<string, unknown>): string | null {
  const dentro = (o: unknown) => {
    const x = obj(o)
    return x ? (s(x.donde) ?? s(x.direccion) ?? s(x['dirección']) ?? s(x.ubicacion) ?? s(x.address)) : null
  }
  const c = s(d.donde) ?? s(d.direccion) ?? s(d['dirección']) ?? s(d.ubicacion) ?? s(d.lugar) ?? dentro(d.donde) ?? dentro(d.negocio) ?? dentro(d.contacto)
  return c ? c.slice(0, 300) : null
}

/** El teléfono que se muestra en el pin (el mismo orden de llaves que el resto del feed). */
export function telefonoDe(d: Record<string, unknown>): string | null {
  const c = obj(d.contacto) ?? {}
  return s(c.telefono) ?? s(c.phone) ?? s(c.whatsapp) ?? s(d.telefono) ?? s(d.phone) ?? s(d.whatsapp)
}

/**
 * Las coordenadas que trae un enlace de Google Maps, sin pedir nada a nadie. En orden de confianza:
 *   `!3d<lat>!4d<lng>` (el punto del lugar en un enlace /maps/place/…) y `q=` / `query=` / `ll=` / `destination=` con «lat,lng»: exacta;
 *   `@<lat>,<lng>,<zoom>z` es el centro de la cámara (suele caer encima del local, pero no siempre): calle.
 * Un enlace corto (maps.app.goo.gl) no trae coordenadas: hay que abrirlo para saberlas, y eso no se hace aquí. null si no hay nada utilizable.
 */
export function coordenadasDeGoogleMaps(url: string): { lat: number; lng: number; precision: Precision } | null {
  let t = url.trim()
  if (!/^https?:\/\/([\w-]+\.)*google\.[a-z.]+\/maps|^https?:\/\/maps\.google\.[a-z.]+\//i.test(t)) return null
  try {
    t = decodeURIComponent(t)
  } catch {
    // un % suelto: se lee tal cual
  }
  const par = (a: string, b: string, precision: Precision) => {
    const lat = Number(a)
    const lng = Number(b)
    return Number.isFinite(lat) && Number.isFinite(lng) && enVenezuela(lat, lng) ? { lat, lng, precision } : null
  }
  const NUM = '(-?\\d{1,2}(?:\\.\\d+)?)'
  const lugar = [...t.matchAll(new RegExp(`!3d${NUM}!4d${NUM}`, 'g'))].at(-1) // si hay varios, el último es el del lugar
  if (lugar) return par(lugar[1], lugar[2], 'exacta')
  const q = t.match(new RegExp(`[?&](?:q|query|ll|destination|center)=(?:loc:)?${NUM}\\s*,\\s*${NUM}`))
  if (q) return par(q[1], q[2], 'exacta')
  const cam = t.match(new RegExp(`@${NUM},${NUM}(?:,|$)`))
  if (cam) return par(cam[1], cam[2], 'calle')
  return null
}
const urlGoogleMaps = (d: Record<string, unknown>) => {
  const g = obj(d.google_maps)
  return g ? (s(g.url) ?? s(g.link) ?? s(g.enlace)) : s(d.google_maps)
}

const norma = (v: string) => v.replace(/\s+/g, ' ').trim().toLowerCase()

/** Estado de la ubicación de un ítem a partir de su `datos`. Función pura: la usan el listado, el mapa y el relleno. */
export function ubicacionDe(d: Record<string, unknown>): Ubicacion {
  const direccion = direccionDe(d)
  const base = { direccion, lat: null, lng: null, precision: null, origen: null } as const
  const g = obj(d.geo)
  const glat = g ? n(g.lat) : null
  const glng = g ? n(g.lng) : null
  const geoOk = g?.estado === 'ok' && glat !== null && glng !== null && enVenezuela(glat, glng)
  if (geoOk && g.origen === 'manual') return { ...base, estado: 'ok', lat: glat, lng: glng, precision: g.precision === 'calle' || g.precision === 'zona' ? g.precision : 'exacta', origen: 'manual' }
  // La ficha de Google Maps sabe dónde queda el local mejor que cualquier geocodificador con una dirección de aquí: manda sobre él (no sobre un pin manual).
  const gm = urlGoogleMaps(d)
  const deMaps = gm ? coordenadasDeGoogleMaps(gm) : null
  if (deMaps) return { ...base, estado: 'ok', ...deMaps, origen: 'google_maps' }
  // Un pin buscado por texto es de ESA dirección: si la dirección cambió por otra vía, vuelve a estar pendiente.
  if (geoOk && (!direccion || (typeof g.consulta === 'string' && norma(g.consulta) === norma(direccion)))) {
    const p = g.precision
    return { ...base, estado: 'ok', lat: glat, lng: glng, precision: p === 'exacta' || p === 'calle' || p === 'zona' ? p : 'zona', origen: g.origen === 'mapbox' ? 'mapbox' : 'nominatim' }
  }
  // Coordenadas que ya traía el ítem (si el que publica las manda, se respetan).
  const dlat = n(d.lat) ?? n(d.latitud)
  const dlng = n(d.lng) ?? n(d.longitud)
  if (dlat !== null && dlng !== null && enVenezuela(dlat, dlng)) return { ...base, estado: 'ok', lat: dlat, lng: dlng, precision: 'exacta', origen: 'datos' }
  if (!direccion) return { ...base, estado: 'sin_direccion' }
  if (g && (g.estado === 'sin_resultado' || g.estado === 'error') && typeof g.consulta === 'string' && norma(g.consulta) === norma(direccion)) return { ...base, estado: g.estado }
  return { ...base, estado: 'pendiente' }
}

// ---------- geocodificar un ítem ----------
export type Resultado = 'ok' | 'sin_resultado' | 'error' | 'omitido' | 'sin_proveedor'

/** Lo que se guarda en `datos.geo` de un fallo (o del éxito si trae `ok`). */
const escribir = async (db: Db, id: string, geo: Record<string, unknown>, consulta: string) => {
  // Solo si el ítem sigue con esa dirección y nadie puso un pin a mano mientras se consultaba (la consulta tarda).
  const r = await db.query(`SELECT data FROM feed_items WHERE id = $1`, [id])
  if (!r.rowCount) return false
  const d = (r.rows[0].data ?? {}) as Record<string, unknown>
  const dir = direccionDe(d)
  if (!dir || norma(dir) !== norma(consulta) || obj(d.geo)?.origen === 'manual') return false
  await db.query(`UPDATE feed_items SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{geo}', $2::jsonb, true) WHERE id = $1`, [id, JSON.stringify(geo)])
  return true
}

/**
 * Busca las coordenadas de la dirección del ítem y las guarda. `forzar` repite aunque ya hubiera un resultado de texto (o un fallo);
 * un pin manual no se toca nunca. Un fallo de red queda como `error` (se reintenta en el siguiente relleno); «no hay resultado», como `sin_resultado`.
 */
export async function geocodificarItem(db: Db, id: string, o: { forzar?: boolean } = {}): Promise<Resultado> {
  const prov = geocoderOSinConfigurar()
  if (!prov) return 'sin_proveedor'
  const r = (await db.query(`SELECT title, data FROM feed_items WHERE id = $1`, [id])).rows[0]
  if (!r) return 'omitido'
  const d = (r.data ?? {}) as Record<string, unknown>
  const u = ubicacionDe(d)
  if (u.origen === 'manual' || u.origen === 'datos' || u.origen === 'google_maps' || !u.direccion) return 'omitido'
  if (u.estado === 'ok' && !o.forzar) return 'omitido'
  const direccion = u.direccion
  const previo = obj(d.geo)
  const intentos = (previo && typeof previo.consulta === 'string' && norma(previo.consulta) === norma(direccion) ? (n(previo.intentos) ?? 0) : 0) + 1
  const el = new Date().toISOString()
  const negocio = typeof r.title === 'string' ? r.title : null
  try {
    for (const q of consultasDe(direccion, negocio)) {
      const hit = await prov.buscar(q)
      if (hit) {
        await escribir(db, id, { estado: 'ok', lat: hit.lat, lng: hit.lng, precision: hit.precision, origen: prov.nombre, consulta: direccion, encontrado_como: hit.nombre, busqueda: q, el }, direccion)
        return 'ok'
      }
    }
    await escribir(db, id, { estado: 'sin_resultado', consulta: direccion, intentos, el }, direccion)
    return 'sin_resultado'
  } catch (e) {
    if (!(e instanceof GeocoderError)) console.error('[geocodificar]', e)
    await escribir(db, id, { estado: 'error', consulta: direccion, intentos, el, error: (e as Error).message.slice(0, 200) }, direccion)
    return 'error'
  }
}

// ---------- en segundo plano (al publicar) ----------
const pendientes = new Set<string>()
let trabajo: Promise<void> = Promise.resolve()
/** Mete ítems a la cola de geocodificación del proceso (una por una, a la velocidad que permite el proveedor). No bloquea ni lanza. */
export function programarGeocodificacion(ids: string[]) {
  if (!geocoderOSinConfigurar()) return
  for (const id of ids)
    if (!pendientes.has(id) && pendientes.size < 500) {
      pendientes.add(id)
      trabajo = trabajo.then(async () => {
        try {
          await geocodificarItem(pool, id)
        } catch (e) {
          console.error('[geocodificar]', e)
        } finally {
          pendientes.delete(id)
        }
      })
    }
}
/** Se resuelve cuando la cola de segundo plano queda vacía (para el script y las pruebas). */
export const colaGeocodificacion = () => trabajo

// ---------- relleno de los que ya estaban ----------
export type Relleno = { revisados: number; con_direccion: number; ya_ubicados: number; ubicados: number; sin_resultado: number; errores: number; omitidos: number; pendientes: number; cobertura: number | null }

/**
 * Geocodifica los ítems que tienen dirección y todavía no tienen coordenadas. Idempotente: lo ya ubicado (por texto, a mano o desde los datos)
 * no se vuelve a pedir. Un `sin_resultado` solo se repite con `reintentar`; un `error` (red) se repite siempre.
 * `ensayo` no consulta nada: cuenta lo que haría.
 */
export async function rellenarUbicaciones(o: { tipo?: string; limite?: number; reintentar?: boolean; ensayo?: boolean; progreso?: (id: string, titulo: string, r: Resultado) => void } = {}): Promise<Relleno> {
  const rows = (await pool.query(`SELECT id, title, data FROM feed_items WHERE ($1::text IS NULL OR kind = $1) ORDER BY found_at DESC, id`, [o.tipo ?? null])).rows
  const out: Relleno = { revisados: rows.length, con_direccion: 0, ya_ubicados: 0, ubicados: 0, sin_resultado: 0, errores: 0, omitidos: 0, pendientes: 0, cobertura: null }
  let hechos = 0
  for (const r of rows) {
    const u = ubicacionDe((r.data ?? {}) as Record<string, unknown>)
    if (u.estado === 'sin_direccion') continue
    out.con_direccion++
    if (u.estado === 'ok') {
      out.ya_ubicados++
      continue
    }
    if (u.estado === 'sin_resultado' && !o.reintentar) {
      out.sin_resultado++
      continue
    }
    if (o.ensayo || (o.limite !== undefined && hechos >= o.limite)) {
      out.pendientes++
      continue
    }
    hechos++
    const res = await geocodificarItem(pool, r.id as string, { forzar: !!o.reintentar })
    o.progreso?.(r.id as string, r.title as string, res)
    if (res === 'ok') out.ubicados++
    else if (res === 'sin_resultado') out.sin_resultado++
    else if (res === 'error') out.errores++
    else out.omitidos++
  }
  out.cobertura = out.con_direccion ? Math.round(((out.ya_ubicados + out.ubicados) / out.con_direccion) * 1000) / 10 : null
  return out
}

let corriendo = false
export const relleno_en_curso = () => corriendo
/** Lanza el relleno en segundo plano (uno a la vez). Devuelve false si ya había uno corriendo. */
export function iniciarRelleno(o: Parameters<typeof rellenarUbicaciones>[0] = {}): boolean {
  if (corriendo) return false
  corriendo = true
  void rellenarUbicaciones({ ...o, ensayo: false })
    .then((r) => console.log('[geocodificar] relleno terminado', JSON.stringify(r)))
    .catch((e) => console.error('[geocodificar] relleno falló', e))
    .finally(() => {
      corriendo = false
    })
  return true
}
