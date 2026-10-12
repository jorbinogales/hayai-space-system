// Envío por WhatsApp de lo que se le escribe a un prospecto (hoy: el guión del feed). Detrás de una interfaz para poder cambiar de vía sin
// tocar a quien la usa:
//   · FASE 1 (la de hoy, gratis, sin llaves): enlace wa.me con el texto ya escrito. La persona lo abre y toca «enviar» desde SU WhatsApp;
//     el sistema no manda nada por su cuenta (por eso `enviado: false`).
//   · FASE 2 (a futuro): WhatsApp Cloud API de Meta. Pide verificar el negocio, plantillas aprobadas para el primer mensaje y tiene costo
//     por conversación. Se agrega como otro `Enviador` y se elige con WHATSAPP_ENVIO; nada de afuera cambia.
// Aquí también vive la ÚNICA normalización de teléfonos venezolanos para WhatsApp en el servidor: sin «+», sin espacios ni guiones,
// sin el 0 inicial y con el 58 por delante.

const str = (v: unknown): string | null => (typeof v === 'string' ? v.trim() || null : typeof v === 'number' && Number.isFinite(v) ? String(v) : null)
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(strs) : str(v) ? [str(v)!] : [])
const rec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Móviles venezolanos (412, 414, 416, 424, 426): los que reciben WhatsApp. */
const MOVIL = /^4(12|14|16|24|26)\d{7}$/

export type Telefono = { /** 584141234567: listo para wa.me */ digitos: string; movil: boolean }

/**
 * 0414-1234567, 0414 1234567, +58 414 1234567, 58414…, 4141234567 → 584141234567. Un fijo venezolano (0251…) se reconoce pero no es de
 * WhatsApp. Un número internacional solo se acepta con «+» o «00» (8 a 15 dígitos). Lo demás es null: nunca se inventa un número.
 */
export function normalizarTelefono(v: unknown): Telefono | null {
  const s = str(v)
  if (!s) return null
  const intl = /^\s*(\+|00)/.test(s)
  let d = s.replace(/\D/g, '')
  if (d.startsWith('00')) d = d.slice(2)
  let nac: string | null = null
  if (d.length === 12 && d.startsWith('58')) nac = d.slice(2)
  else if (d.length === 11 && d[0] === '0') nac = d.slice(1)
  else if (d.length === 10 && !intl) nac = d
  if (nac && /^[24]\d{9}$/.test(nac)) return { digitos: `58${nac}`, movil: MOVIL.test(nac) }
  if (intl && d.length >= 8 && d.length <= 15) return { digitos: d, movil: false }
  return null
}

const PHONE_KEY = /(^|[^a-z])(tel|telf|tlf|cel|celular|movil|móvil|phone|numero|número|whats)/i
/** Los teléfonos que trae un ítem, el de WhatsApp primero (misma lectura tolerante que el feed de la web). */
export function telefonosDe(d: Record<string, unknown>): string[] {
  const c: Record<string, unknown> = rec(d.contacto) ? d.contacto : {}
  const sueltos = typeof d.contacto === 'string' || Array.isArray(d.contacto) ? strs(d.contacto) : []
  const wa = [c.whatsapp, c.wa, d.whatsapp].flatMap(strs)
  const otros: unknown[] = [c.telefono, c.tel, c.celular, c.movil, c['móvil'], c.phone, d.telefono, d.tel, d.celular, ...sueltos]
  for (const [k, v] of Object.entries(c)) if (!['telefono', 'tel', 'celular', 'movil', 'móvil', 'phone', 'whatsapp', 'wa'].includes(k) && PHONE_KEY.test(k)) otros.push(v)
  for (const k of ['telefonos', 'numeros', 'celulares']) otros.push(c[k], d[k])
  return [...wa, ...otros.flatMap(strs)]
}

export type WhatsappDe = {
  /** ok: hay un móvil al que escribir · solo_fijo: el único número es un fijo (no recibe WhatsApp) · sin_numero: el ítem no trae teléfono */
  estado: 'ok' | 'solo_fijo' | 'sin_numero'
  /** 584141234567 */
  telefono: string | null
  /** https://wa.me/584141234567?text=… con el texto ya escrito (saltos de línea reales); null si no hay a quién escribirle */
  url: string | null
}

/** Texto para WhatsApp: saltos de línea reales (\n), sin \r ni espacios al borde. Lo que WhatsApp interpreta (*negrita*, _cursiva_) se respeta. */
export const textoWhatsapp = (t: string) => t.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

/** https://wa.me/<número>?text=<mensaje codificado>. El número va sin «+». */
export function enlaceWhatsapp(telefono: string, texto?: string | null): string {
  const t = texto ? textoWhatsapp(texto) : ''
  return `https://wa.me/${telefono}${t ? `?text=${encodeURIComponent(t)}` : ''}`
}

/** A qué número se le escribe y con qué enlace: el primer móvil (el de WhatsApp declarado va antes). */
export function whatsappDe(datos: Record<string, unknown>, texto?: string | null): WhatsappDe {
  const tels = telefonosDe(datos).map(normalizarTelefono).filter((t): t is Telefono => !!t)
  const movil = tels.find((t) => t.movil) ?? tels.find((t) => t.digitos.length !== 12 || !t.digitos.startsWith('58')) // un internacional con «+» también puede tener WhatsApp
  if (movil) return { estado: 'ok', telefono: movil.digitos, url: enlaceWhatsapp(movil.digitos, texto) }
  return { estado: tels.length ? 'solo_fijo' : 'sin_numero', telefono: null, url: null }
}

// ---------- vías de envío ----------
export type MensajeWhatsapp = { telefono: string; texto: string }
export type ResultadoEnvio = {
  via: string
  /** true solo si el sistema mandó el mensaje por su cuenta (Cloud API). Con wa.me lo manda la persona desde su teléfono. */
  enviado: boolean
  /** La vía manual: el enlace que la persona abre. */
  url: string | null
}
export interface Enviador {
  readonly nombre: string
  enviar(m: MensajeWhatsapp): Promise<ResultadoEnvio>
}

/** Fase 1: wa.me. No manda nada; prepara el enlace. */
export const waMe: Enviador = {
  nombre: 'wa.me',
  enviar: async (m) => ({ via: 'wa.me', enviado: false, url: enlaceWhatsapp(m.telefono, m.texto) }),
}

let activo: Enviador | undefined
/** El enviador configurado (WHATSAPP_ENVIO): hoy solo `wa.me`. `cloud` queda reservado para la fase 2 y falla con un mensaje claro. */
export function enviador(): Enviador {
  if (activo) return activo
  const v = (process.env.WHATSAPP_ENVIO ?? 'wa.me').trim().toLowerCase()
  if (v === 'wa.me' || v === 'wame' || v === '') return (activo = waMe)
  if (v === 'cloud') throw new Error('WHATSAPP_ENVIO=cloud (WhatsApp Cloud API) es la fase 2 y todavía no está implementada: usa wa.me')
  throw new Error(`WHATSAPP_ENVIO desconocido: ${v} (wa.me)`)
}
/** Solo para pruebas: vuelve a leer el entorno. */
export const reiniciarEnviador = () => {
  activo = undefined
}

/** El punto de entrada de «mandar este mensaje a este número»: quien lo llama no sabe por qué vía sale. */
export const enviarWhatsApp = (m: MensajeWhatsapp): Promise<ResultadoEnvio> => {
  const t = normalizarTelefono(m.telefono)
  if (!t) return Promise.reject(new Error('Teléfono inválido para WhatsApp'))
  const texto = textoWhatsapp(m.texto)
  if (!texto) return Promise.reject(new Error('El mensaje está vacío'))
  return enviador().enviar({ telefono: t.digitos, texto })
}
