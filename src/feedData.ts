// Feed de oportunidades (planeta HAYAI): lo que las máquinas y los agentes ENCONTRARON. La bitácora es lo que el equipo HIZO;
// esto es lo que llega de afuera. Capa de datos de la pantalla (GET/POST /api/feed...) + el aviso en vivo + el "abrir el feed".
//
// Estados (v1.6.5): revisar, descartar y guardar son PERSONALES (cada socio ve lo suyo); convertir es GLOBAL (lo ve todo el equipo).
import { useSyncExternalStore } from 'react'
import { api } from './api'

export const FEED_TIPOS = ['idea', 'prospecto', 'alerta', 'noticia', 'oportunidad', 'proyecto'] as const
/** Lo que ve el socio al filtrar: su estado personal, y «convertido» (global) manda sobre lo personal. */
export const FEED_ESTADOS = ['nuevo', 'revisado', 'descartado', 'convertido'] as const
export type FeedTipo = (typeof FEED_TIPOS)[number]
export type FeedEstado = (typeof FEED_ESTADOS)[number]
/** Estado PERSONAL del socio que consulta. */
export type MiEstado = 'nuevo' | 'revisado' | 'descartado'
/** Lo que se puede crear a partir de un ítem (POST /feed/:id/convertir). La propuesta se arma desde la ficha del cliente (con `feed_item_id`). */
export type FeedConversion = 'posible_cliente' | 'cliente' | 'tarea' | 'seguimiento' | 'proyecto' | 'contenido'
/** Todo lo que puede quedar enlazado a un ítem. */
export type CreadoKind = FeedConversion | 'propuesta'
/** v1.6.6: con qué cliente está vinculado el ítem (por conversión, por sus datos o por el nombre). */
export type VinculoEstado = 'sin_vinculo' | 'posible_cliente' | 'cliente'
export interface FeedVinculo {
  estado: VinculoEstado
  cliente_id: string | null
  cliente: string | null
  origen: 'conversion' | 'datos' | 'nombre' | null
}
export type Creados = Partial<Record<CreadoKind, { id: string | null; por: string | null; el: string | null }>>

export const FEED_TIPO_LABEL: Record<FeedTipo, string> = {
  idea: 'Idea',
  prospecto: 'Prospecto',
  alerta: 'Alerta',
  noticia: 'Noticia',
  oportunidad: 'Oportunidad',
  proyecto: 'Proyecto',
}
export const FEED_ESTADO_LABEL: Record<FeedEstado, string> = { nuevo: 'Nuevo', revisado: 'Revisado', descartado: 'Descartado', convertido: 'Convertido' }

export interface FeedItem {
  id: string
  titulo: string
  resumen: string | null
  tipo: FeedTipo
  fuente: string
  categoria: string | null
  clave_externa: string | null
  publicado_por: { id: string; nombre: string }
  /** GLOBAL: 'nuevo' o 'convertido'. Lo que cada socio revisó o descartó es suyo: mira `mi_estado`. */
  estado: 'nuevo' | 'convertido'
  /** PERSONAL (del socio que consulta) */
  mi_estado: MiEstado
  motivo_descarte: string | null
  /** PERSONAL: lo guardó el socio que consulta */
  guardado: boolean
  /** forma libre: negocio, fugas, guion, urls, metricas, contacto, origen_url, telefono, email, origen... */
  datos: Record<string, unknown>
  fecha: string
  publicado_el: string
  /** GLOBAL: en qué se convirtió, quién y cuándo */
  convertido: { a: CreadoKind; id: string | null; por: string | null; el: string | null } | null
  /** v1.6.6: el cliente al que apunta el ítem (decide «Convertir en posible cliente» / «en cliente» / «Crear propuesta») */
  vinculo: FeedVinculo
  /** v1.6.6: lo que ya se creó desde el ítem, por clase (tarea, proyecto, propuesta...): ahí el botón dice «✓ Creada» */
  creados: Creados
  actualizado_el: string | null
}
/** Lo que el socio ve de un ítem: convertido (global) manda; si no, su estado personal. */
export const vistaDe = (it: Pick<FeedItem, 'estado' | 'mi_estado'>): FeedEstado => (it.estado === 'convertido' ? 'convertido' : it.mi_estado)

export interface FeedMeta {
  page: number
  per_page: number
  total: number
  /** los nuevos DEL SOCIO: el contador visible del hub, no depende del filtro */
  nuevos: number
  guardados: number
  por_estado: Record<FeedEstado, number>
  por_tipo: Record<FeedTipo, { total: number; nuevos: number }>
  fuentes: { fuente: string; total: number; nuevos: number }[]
  categorias: { categoria: string; total: number }[]
  sin_categoria: number
}
export interface FeedPage {
  data: FeedItem[]
  meta: FeedMeta
}
export interface FeedFilters {
  tipo?: FeedTipo
  estado?: FeedEstado
  fuente?: string
  /** una categoría, o 'sin_categoria' */
  categoria?: string
  guardado?: boolean
  q?: string
  page?: number
  per_page?: number
}

const qs = (f: FeedFilters) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== false) p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

export const loadFeed = (f: FeedFilters = {}) => api.get<FeedPage>(`/feed${qs(f)}`)
/** Un ítem por id (GET /feed/:id): la campana abre una tarjeta que puede no estar en la primera página. */
export const loadFeedItem = (id: string) => api.get<FeedItem>(`/feed/${encodeURIComponent(id)}`)

/** Publicar a mano (la fuente es «manual»; quien publica sale de la sesión). */
export const publishFeed = (b: { titulo: string; tipo: FeedTipo; resumen?: string; datos?: Record<string, unknown>; fuente?: string }) =>
  api.post<FeedItem & { creado: boolean }>('/feed', { fuente: 'manual', ...b })

/** Revisar / descartar / volver a nuevo: PERSONAL (no afecta a los demás socios). Solo da 409 si el ítem ya está convertido. */
export const markFeed = (it: FeedItem, estado: MiEstado, motivo?: string) => api.patch<FeedItem>(`/feed/${it.id}/estado`, { estado, ...(motivo ? { motivo } : {}) })
/** Guardar o quitar de guardados: PERSONAL. */
export const saveFeed = (it: FeedItem, guardado: boolean) => api.post<FeedItem>(`/feed/${it.id}/guardar`, { guardado })

export interface ConvertBody {
  a: FeedConversion
  nombre?: string
  origen?: string
  notas?: string
  telefono?: string
  email?: string
  valor_estimado?: number
  titulo?: string
  proyecto_id?: string
  vence?: string
  responsable?: string
  cliente_id?: string
  descripcion?: string
  /** «cliente»: día de implementación (hoy por defecto) y, si el posible cliente tiene propuesta vigente, el esquema de cobro */
  fecha_implementacion?: string
  esquema_cobro?: { inicio_cobro: string; meses: number; unicos_cobrados: boolean }
}
export interface ConvertResult {
  item: FeedItem
  creado: { tipo: FeedConversion; id: string; detalle: Record<string, unknown> }
}
export const convertFeed = (it: Pick<FeedItem, 'id'>, b: ConvertBody) => api.post<ConvertResult>(`/feed/${it.id}/convertir`, b)
/** «Deshacer» del aviso «Listo ✓»: solo quien lo creó y en los 2 minutos siguientes. Lo creado va a la papelera. */
/** «Devolver al feed» desde la ficha del posible cliente: sin límite de tiempo (el posible cliente va a la papelera y el ítem queda nuevo). */
export const devolverAlFeed = (itemId: string) => api.post<{ item: FeedItem; deshecho: string }>(`/feed/${itemId}/deshacer`, { a: 'posible_cliente', devolver: true })
export const undoFeed = (it: Pick<FeedItem, 'id'>, a: Exclude<CreadoKind, 'propuesta'>) => api.post<{ item: FeedItem; deshecho: string }>(`/feed/${it.id}/deshacer`, { a })

// ---------- botones inteligentes (v1.6.6): qué acciones tiene cada tarjeta y cuál va destacada ----------
export const ES_LEAD: FeedTipo[] = ['prospecto', 'oportunidad']
/**
 * «Convertir» según el vínculo: sin vincular → posible cliente; vinculado a un posible cliente → cliente (lo promueve);
 * vinculado a un cliente activo → nada. Solo prospectos y oportunidades: en ideas, noticias y alertas no se muestra.
 */
export function conversionDe(it: Pick<FeedItem, 'tipo' | 'vinculo'>): 'posible_cliente' | 'cliente' | null {
  if (!ES_LEAD.includes(it.tipo)) return null
  return it.vinculo.estado === 'sin_vinculo' ? 'posible_cliente' : it.vinculo.estado === 'posible_cliente' ? 'cliente' : null
}
/** «Crear propuesta»: oportunidades ya vinculadas a un cliente (posible o activo). */
export const puedeProponer = (it: Pick<FeedItem, 'tipo' | 'vinculo'>) => it.tipo === 'oportunidad' && it.vinculo.estado !== 'sin_vinculo' && !!it.vinculo.cliente_id

const DATOS_COBRO = ['cobro_id', 'pago_id', 'cuota_id', 'cuota']
const TEXTO_COBRO = /\b(cuota|vencimiento|vence|vencid[oa]|cobro|mensualidad)\b/i
const idDe = (v: unknown): string | null => (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v.trim()) ? v.trim() : null)
/** Una alerta de cuota o vencimiento: trae el cobro en sus datos o lo dice en el título. */
export const esAlertaDeCobro = (it: Pick<FeedItem, 'tipo' | 'titulo' | 'datos'>) =>
  it.tipo === 'alerta' && (DATOS_COBRO.some((k) => it.datos[k] != null) || TEXTO_COBRO.test(it.titulo))
/** A dónde lleva «Registrar cobro»: el cobro (si el ítem lo trae) y/o el cliente. Sin ninguno de los dos no hay botón. */
export function destinoCobro(it: Pick<FeedItem, 'datos' | 'vinculo'>): { cobroId: string | null; clienteId: string | null } | null {
  const cobroId = idDe(it.datos.cobro_id) ?? idDe(it.datos.pago_id) ?? idDe(it.datos.cuota_id)
  const clienteId = it.vinculo.cliente_id ?? idDe(it.datos.cliente_id)
  return cobroId || clienteId ? { cobroId, clienteId } : null
}
const txt = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
/** Concepto con el que se prellena la propuesta, si el ítem lo trae. */
export const conceptoDe = (d: Record<string, unknown>): string | null => txt(d.concepto) ?? txt(d.propuesta) ?? txt(d.producto) ?? txt(d.servicio) ?? txt(d.oferta)

export type AccionId = 'contacto' | 'posible_cliente' | 'cliente' | 'propuesta' | 'cobro' | 'proyecto' | 'tarea' | 'seguimiento' | 'contenido' | 'origen'
const hechoDe: Partial<Record<AccionId, CreadoKind>> = { propuesta: 'propuesta', proyecto: 'proyecto', tarea: 'tarea', seguimiento: 'seguimiento', contenido: 'contenido' }
/** ¿Esa acción ya se hizo desde el ítem? Entonces el botón dice «✓ Creada» y abre lo creado. */
export const yaCreada = (it: Pick<FeedItem, 'creados'>, a: AccionId) => !!(hechoDe[a] && it.creados[hechoDe[a]!])

export interface AccionesDe {
  /** la acción destacada de la tarjeta (una sola) */
  principal: AccionId | null
  /** el resto, en orden fijo */
  secundarias: AccionId[]
}
/**
 * Qué botones tiene una tarjeta y cuál es el principal:
 * prospecto con teléfono → WhatsApp/Llamar · prospecto sin teléfono → Convertir · oportunidad vinculada → Crear propuesta ·
 * oportunidad sin vincular → Convertir · idea → Crear proyecto · alerta de cuota → Registrar cobro · noticia → Ver origen.
 * Lo que ya se creó no vuelve a ser el principal (queda como «✓ Creada»).
 */
export function accionesDe(it: FeedItem): AccionesDe {
  const contacto = accionPrincipal(contactoDe(it.datos))
  const conv = conversionDe(it)
  const cobro = esAlertaDeCobro(it) && !!destinoCobro(it)
  const origen = !!origenUrl(it.datos)
  const todas: AccionId[] = []
  if (contacto) todas.push('contacto')
  if (conv) todas.push(conv)
  if (puedeProponer(it)) todas.push('propuesta')
  if (cobro) todas.push('cobro')
  todas.push('tarea', 'seguimiento', 'proyecto')
  if (it.tipo === 'idea') todas.push('contenido') // una idea también puede ser una pieza del tablero de Contenido (Marketing)
  if (origen) todas.push('origen')

  const candidata: AccionId | null =
    it.tipo === 'prospecto' ? (contacto && contacto.tipo !== 'email' ? 'contacto' : conv) :
    it.tipo === 'oportunidad' ? (puedeProponer(it) ? 'propuesta' : conv) :
    it.tipo === 'idea' ? (it.fuente === 'marketing' ? 'contenido' : 'proyecto') :
    it.tipo === 'proyecto' ? 'proyecto' :
    it.tipo === 'alerta' ? (cobro ? 'cobro' : null) :
    origen ? 'origen' : null
  const ok = (a: AccionId | null): a is AccionId => !!a && todas.includes(a) && !yaCreada(it, a)
  const principal = ok(candidata) ? candidata : ok('tarea') ? 'tarea' : null
  return { principal, secundarias: todas.filter((a) => a !== principal) }
}

/** Texto de WhatsApp con el guion del ítem ya escrito (wa.me?text=…). Sin guion, el enlace queda igual. */
export function conGuion(href: string, d: Record<string, unknown>): string {
  const g = txt(d.guion)
  return g ? `${href}${href.includes('?') ? '&' : '?'}text=${encodeURIComponent(g)}` : href
}

// ---------- números ----------
/** Conteos con punto de miles a partir de 1.000 (es-VE), sin depender de la regla de agrupación del navegador. */
export const fmtN = (n: number) => String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')

// ---------- textos ----------
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)
const FUENTES: Record<string, string> = {
  growi: 'Growi',
  'radar-hayai': 'Radar HAYAI',
  'cazador-summit': 'Cazador Summit',
  'video-auditorias': 'Video-auditorías',
  'espia-pos': 'Espía POS',
  'leads-tibios': 'Leads tibios',
  'demo-first': 'Demo-first',
}
/** Growi es el sello de lo que encuentra Growi (castor + tejón). */
export const isGrowi = (fuente: string) => fuente === 'growi'
/** Nombre legible de la fuente (el slug que manda el servidor, humanizado). */
export function fuenteLabel(fuente: string, by?: { nombre: string }): string {
  if (FUENTES[fuente]) return FUENTES[fuente]
  if (fuente === 'manual') return by ? `Manual · ${by.nombre}` : 'Manual'
  const muse = /^muse-(.+)$/.exec(fuente)
  if (muse) return `Muse de ${cap(muse[1].replace(/[-_.]+/g, ' '))}`
  return cap(fuente.replace(/[-_.]+/g, ' ').trim())
}
export const categoriaLabel = (c: string) => cap(c.replace(/[-_]+/g, ' ').trim())

/**
 * Corta un texto en una palabra completa (nunca a mitad de palabra) y cierra con «…». Si cabe, lo devuelve igual.
 * Una sola palabra más larga que el máximo no se parte: se queda entera.
 */
export function cortar(text: string, max = 180): { texto: string; cortado: boolean } {
  const t = text.trim()
  if (t.length <= max) return { texto: t, cortado: false }
  let end = max
  if (!/\s/.test(t[max])) {
    // la posición de corte cae dentro de una palabra: se retrocede hasta el último espacio
    const back = t.slice(0, max).search(/\s\S*$/)
    if (back > 0) end = back
    else {
      const fwd = t.slice(max).search(/\s/)
      if (fwd === -1) return { texto: t, cortado: false } // una sola palabra enorme: se muestra completa
      end = max + fwd
    }
  }
  const head = t.slice(0, end).replace(/[\s,;:.\-–—(¿¡]+$/, '')
  return { texto: `${head}…`, cortado: true }
}

// ---------- lectura tolerante de `datos` (forma libre: se usa lo que haya y el resto se ignora) ----------
export const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v.trim() || null : typeof v === 'number' && Number.isFinite(v) ? String(v) : null)
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(strs) : str(v) ? [str(v)!] : [])

/** Solo enlaces http(s): lo demás (javascript:, data:, ftp:...) nunca llega a un href. */
export const safeUrl = (v: unknown): string | null => {
  if (typeof v !== 'string' || !/^https?:\/\//i.test(v.trim())) return null
  try {
    const u = new URL(v.trim())
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}
export const urlLabel = (href: string) => href.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '')

// ---------- teléfonos venezolanos ----------
export interface Tel {
  /** 0414-1234567 */
  display: string
  /** tel:+584141234567 */
  tel: string
  /** https://wa.me/584141234567 */
  wa: string
  /** móvil venezolano (412, 414, 416, 424, 426): se puede escribir por WhatsApp */
  movil: boolean
}
const MOVIL = /^4(12|14|16|24|26)\d{7}$/
/** Normaliza 0412-1234567, 0414 1234567, +58 414 1234567, 58414..., 4141234567... Lo que no sea un número venezolano ni internacional con «+» da null. */
export function parseTel(v: unknown): Tel | null {
  const s = str(v)
  if (!s) return null
  const intl = /^\s*(\+|00)/.test(s)
  let d = s.replace(/\D/g, '')
  if (d.startsWith('00')) d = d.slice(2)
  let nac: string | null = null
  if (d.length === 12 && d.startsWith('58')) nac = d.slice(2)
  else if (d.length === 11 && d[0] === '0') nac = d.slice(1)
  else if (d.length === 10 && !intl) nac = d
  if (nac && /^[24]\d{9}$/.test(nac)) return { display: `0${nac.slice(0, 3)}-${nac.slice(3)}`, tel: `tel:+58${nac}`, wa: `https://wa.me/58${nac}`, movil: MOVIL.test(nac) }
  if (intl && d.length >= 8 && d.length <= 15) return { display: `+${d}`, tel: `tel:+${d}`, wa: `https://wa.me/${d}`, movil: false }
  return null
}

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/
const parseEmail = (v: unknown): string | null => {
  const s = str(v)
  return s && EMAIL.test(s) ? s : null
}
/** Sitio web: http(s) tal cual, o un dominio sin esquema (se le pone https). Nada más llega a un href. */
function parseWeb(v: unknown): string | null {
  const s = str(v)
  if (!s) return null
  if (/^https?:\/\//i.test(s)) return safeUrl(s)
  return /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(s) ? safeUrl(`https://${s}`) : null
}
/** Red social: un enlace http(s) o un @usuario. */
function parseSocial(host: 'instagram' | 'facebook', v: unknown): string | null {
  const s = str(v)
  if (!s) return null
  if (/^https?:\/\//i.test(s)) return safeUrl(s)
  const u = s.replace(/^@/, '')
  return /^[A-Za-z0-9._-]{1,50}$/.test(u) ? `https://${host}.com/${u}` : null
}

export interface EnlaceContacto {
  tipo: 'web' | 'instagram' | 'facebook' | 'enlace'
  label: string
  href: string
}
export interface Contacto {
  tels: Tel[]
  /** WhatsApp explícito (`contacto.whatsapp`), si vale */
  wa: Tel | null
  correos: string[]
  enlaces: EnlaceContacto[]
}
export type AccionContacto = { tipo: 'whatsapp' | 'llamar' | 'email'; label: string; href: string; detalle: string }

const PHONE_KEY = /(^|[^a-z])(tel|telf|tlf|cel|celular|movil|móvil|phone|numero|número|whats)/i
/** Todo lo que el ítem trae para contactar: teléfonos (tolera claves sueltas y «números extra»), correos y enlaces (web, redes, urls[]). */
export function contactoDe(d: Record<string, unknown>): Contacto {
  const c: Record<string, unknown> = isRec(d.contacto) ? d.contacto : {}
  const loose = typeof d.contacto === 'string' || Array.isArray(d.contacto) ? strs(d.contacto) : []
  const phones: unknown[] = [c.telefono, c.tel, c.celular, c.movil, c['móvil'], c.phone, d.telefono, d.tel, d.celular, ...loose]
  for (const [k, v] of Object.entries(c)) if (!['telefono', 'tel', 'celular', 'movil', 'móvil', 'phone', 'whatsapp'].includes(k) && PHONE_KEY.test(k)) phones.push(v)
  for (const k of ['telefonos', 'numeros', 'celulares']) phones.push(c[k], d[k])

  const wa = [c.whatsapp, c.wa, d.whatsapp].flatMap(strs).map(parseTel).find((t): t is Tel => !!t) ?? null
  const tels: Tel[] = []
  for (const t of phones.flatMap(strs).map(parseTel)) if (t && !tels.some((x) => x.tel === t.tel)) tels.push(t)
  if (wa && !tels.some((x) => x.tel === wa.tel)) tels.unshift(wa)

  const correos = [...new Set([c.correo, c.email, c.mail, d.email, d.correo, ...loose].flatMap(strs).map(parseEmail).filter((x): x is string => !!x))]

  const enlaces: EnlaceContacto[] = []
  const add = (e: EnlaceContacto | null) => {
    if (e && !enlaces.some((x) => x.href.replace(/\/$/, '') === e.href.replace(/\/$/, ''))) enlaces.push(e)
  }
  const web = [c.web, c.sitio, c.website, c.url, d.web, d.sitio].flatMap(strs).map(parseWeb).find((x): x is string => !!x)
  if (web) add({ tipo: 'web', label: urlLabel(web), href: web })
  const ig = [c.instagram, d.instagram].flatMap(strs).map((x) => parseSocial('instagram', x)).find((x): x is string => !!x)
  if (ig) add({ tipo: 'instagram', label: 'Instagram', href: ig })
  const fb = [c.facebook, d.facebook].flatMap(strs).map((x) => parseSocial('facebook', x)).find((x): x is string => !!x)
  if (fb) add({ tipo: 'facebook', label: 'Facebook', href: fb })
  for (const u of strs(d.urls).map(safeUrl)) if (u) add({ tipo: /instagram\.com/i.test(u) ? 'instagram' : /facebook\.com|fb\.com/i.test(u) ? 'facebook' : 'enlace', label: /instagram\.com/i.test(u) ? 'Instagram' : /facebook\.com|fb\.com/i.test(u) ? 'Facebook' : urlLabel(u), href: u })
  return { tels, wa, correos, enlaces }
}
export const hayContacto = (c: Contacto) => c.tels.length > 0 || c.correos.length > 0 || c.enlaces.length > 0

/**
 * El botón principal según prioridad: WhatsApp (explícito, o el primer móvil venezolano) > Llamar (solo fijo u otro número) > Email.
 * Sin teléfono ni correo no hay botón.
 */
export function accionPrincipal(c: Contacto): AccionContacto | null {
  const wa = c.wa ?? c.tels.find((t) => t.movil)
  if (wa) return { tipo: 'whatsapp', label: 'WhatsApp', href: wa.wa, detalle: wa.display }
  const t = c.tels[0]
  if (t) return { tipo: 'llamar', label: 'Llamar', href: t.tel, detalle: t.display }
  const m = c.correos[0]
  if (m) return { tipo: 'email', label: 'Email', href: `mailto:${m}`, detalle: m }
  return null
}

/** Noticias: de dónde salió (solo http/https). */
export const origenUrl = (d: Record<string, unknown>): string | null => safeUrl(d.origen_url)

// ---------- aviso en vivo: llegó algo nuevo al feed ----------
let tick = 0
const tickSubs = new Set<() => void>()
/** live.ts lo llama cuando el servidor avisa `feed_nuevo`: las pantallas que muestran el feed lo vuelven a pedir. */
export const notifyFeed = () => {
  tick++
  tickSubs.forEach((f) => f())
}
export const useFeedTick = () =>
  useSyncExternalStore(
    (f) => (tickSubs.add(f), () => void tickSubs.delete(f)),
    () => tick,
  )

// ---------- contador de nuevos compartido (la tarjeta de acceso del Hub y la vista del feed) ----------
let knownNuevos: number | null = null
const nuevosSubs = new Set<() => void>()
/** La vista del feed (o un refresco) publica aquí cuántos nuevos tiene el socio; la tarjeta del Hub lo muestra. */
export function publishNuevos(n: number) {
  if (knownNuevos === n) return
  knownNuevos = n
  nuevosSubs.forEach((f) => f())
}
export const useKnownNuevos = () =>
  useSyncExternalStore(
    (f) => (nuevosSubs.add(f), () => void nuevosSubs.delete(f)),
    () => knownNuevos,
  )

// ---------- el feed es una vista propia dentro del Hub: #hub/feed ----------
// El hash sigue siendo la ruta (la primera parte, «hub», es la que lee App); «/feed» solo dice qué vista del Hub se ve.
const feedHash = () => /^#hub\/feed(\/|\?|$)/.test(location.hash)
/** ¿Está abierta la vista del feed dentro del Hub? Se re-renderiza al cambiar el hash (también con Atrás/Adelante). */
export const useFeedView = () =>
  useSyncExternalStore(
    (f) => (window.addEventListener('hashchange', f), () => window.removeEventListener('hashchange', f)),
    feedHash,
  )
let openedFromHub = false
/** Vuelve al Hub (a la lista de bloques). Si el feed se abrió desde el propio Hub, "Atrás" del navegador es lo mismo y no apila historial. */
export function closeFeed() {
  if (openedFromHub && history.length > 1) {
    openedFromHub = false
    history.back()
  } else location.hash = 'hub'
}

// ---------- abrir el feed desde otro sitio (la campana, la tarjeta del Hub) ----------
export interface FeedFocus {
  /** si viene, esa tarjeta se resalta (y se baja hasta ella) */
  itemId?: string | null
  filters?: Pick<FeedFilters, 'tipo' | 'fuente' | 'estado'>
}
let pending: FeedFocus | null = null
const focusSubs = new Set<() => void>()
/**
 * Abre la vista del feed (con foco/filtros opcionales). Funciona desde cualquier pantalla: la vista, al montarse, recoge lo pedido;
 * si ya estaba abierta, se le avisa para que lo aplique.
 */
export function openFeed(f: FeedFocus = {}) {
  pending = f
  const [screen, sub] = location.hash.slice(1).split('/')
  if (screen === 'hub' && sub === 'feed') focusSubs.forEach((fn) => fn())
  else {
    openedFromHub = screen === 'hub'
    location.hash = 'hub/feed'
  }
}
/** La vista recoge (una sola vez) lo que se le pidió enfocar. */
export const takeFeedFocus = (): FeedFocus | null => {
  const f = pending
  pending = null
  return f
}
/** Se dispara cuando se pide enfocar el feed estando ya en su vista. */
export const onFeedFocus = (fn: () => void) => (focusSubs.add(fn), () => void focusSubs.delete(fn))
