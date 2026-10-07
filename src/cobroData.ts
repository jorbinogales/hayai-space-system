// Datos del detalle de un cobro: bolívares y tasa, banco, quién recibió, comprobante (imagen) y el mapeo cédula -> socio.
// La web habla con /api/cobros/* y /api/receptores (mismos servicios que la API v1 y el MCP). El monto en USD sigue siendo de Finanzas.
import { api } from './api'

export const METODOS = ['transferencia', 'pago_movil', 'efectivo', 'zelle', 'otro'] as const
export type Metodo = (typeof METODOS)[number]
export const METODO_LABEL: Record<Metodo, string> = { transferencia: 'Transferencia', pago_movil: 'Pago móvil', efectivo: 'Efectivo', zelle: 'Zelle', otro: 'Otro' }

export interface Cobro {
  id: string
  cliente_id: string
  cliente: string
  /** YYYY-MM-DD */
  fecha: string
  concepto: string
  /** USD */
  monto: number
  tipo: string
  estado: 'pendiente' | 'cobrado'
  vencido: boolean
  /** versión del cobro: se manda como If-Match al editar */
  actualizado_el: string | null
  monto_bs: number | null
  tasa: number | null
  fecha_tasa: string | null
  referencia: string | null
  banco_origen: string | null
  cuenta_origen_ultimos4: string | null
  banco_destino: string | null
  recibido_por: { id: string; nombre: string } | null
  recibido_por_origen: 'manual' | 'comprobante' | null
  metodo: Metodo | null
  notas: string | null
  comprobante: { nombre: string; tipo: string; tamano: number; subido_el: string } | null
}

/** Qué pasó al cruzar la cédula del comprobante con los socios. La cédula siempre llega enmascarada. */
export interface Deteccion {
  documento: string | null
  estado: 'asignado' | 'ya_asignado' | 'difiere' | 'sin_mapeo' | 'no_detectado'
  socio: { id: string; nombre: string } | null
  requiere_confirmacion: boolean
  texto_ocr?: string
}

export interface Receptor {
  id: string
  /** enmascarada: V-263•••92 */
  documento: string
  socio: { id: string; nombre: string }
}

export const getCobro = (id: string) => api.get<Cobro>(`/cobros/${id}`)

export type CobroPatch = Partial<{
  monto_bs: number | null
  tasa: number | null
  fecha_tasa: string | null
  referencia: string | null
  banco_origen: string | null
  cuenta_origen_ultimos4: string | null
  banco_destino: string | null
  recibido_por: string | null
  metodo: Metodo | null
  notas: string | null
}>
export const patchCobro = (id: string, patch: CobroPatch, ifMatch?: string | null) => api.patch<Cobro>(`/cobros/${id}`, patch, { ifMatch })

export const uploadComprobante = (id: string, imagen_base64: string, nombre: string) =>
  api.post<{ cobro: Cobro; deteccion: Deteccion }>(`/cobros/${id}/comprobante`, { imagen_base64, nombre })
export const getComprobante = (id: string) => api.get<{ cobro: Cobro; documento_detectado: string | null; texto_ocr: string }>(`/cobros/${id}/comprobante`)
export const detectarComprobante = (id: string) => api.post<{ cobro: Cobro; deteccion: Deteccion }>(`/cobros/${id}/comprobante/detectar`)
/** URL de la imagen del comprobante (misma origen, con la cookie de sesión). `v` evita ver la anterior tras reemplazarla. */
export const comprobanteUrl = (id: string, v?: string | null) => `/api/cobros/${id}/comprobante/archivo${v ? `?v=${encodeURIComponent(v)}` : ''}`

export const listReceptores = async () => (await api.get<{ data: Receptor[] }>('/receptores')).data
/** El documento completo SOLO viaja aquí (se escribe en el input, nunca se muestra después). */
export const saveReceptor = (documento: string, socio: string) => api.post<Receptor>('/receptores', { documento, socio })
export const deleteReceptor = (id: string) => api.del<{ eliminado: boolean }>(`/receptores/${id}`)

// ---------- comprobante: validación y lectura en el cliente ----------
export const MAX_RECEIPT_BYTES = 4 * 1024 * 1024
export const RECEIPT_TYPES = ['image/png', 'image/jpeg', 'image/webp']

/** Mensaje de error si el archivo no sirve como comprobante; null si está bien. */
export function receiptProblem(f: File): string | null {
  if (!RECEIPT_TYPES.includes(f.type)) return 'Solo se aceptan fotos JPG, PNG o WebP. Si es un PDF, sácale una captura.'
  if (f.size === 0) return 'El archivo está vacío.'
  if (f.size > MAX_RECEIPT_BYTES) return `La imagen pesa ${(f.size / 1_048_576).toFixed(1).replace('.', ',')} MB y el máximo es 4 MB.`
  return null
}

/** Imagen -> base64 puro (sin el prefijo data:). */
export function readBase64(f: File): Promise<string> {
  return new Promise((ok, fail) => {
    const r = new FileReader()
    r.onerror = () => fail(new Error('No se pudo leer el archivo.'))
    r.onload = () => {
      const s = String(r.result)
      ok(s.slice(s.indexOf(',') + 1))
    }
    r.readAsDataURL(f)
  })
}

export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${Math.round(n / 1024)} KB` : `${(n / 1_048_576).toFixed(1).replace('.', ',')} MB`)

// ---------- números en formato venezolano ----------
const nf = (min: number, max: number) => new Intl.NumberFormat('es-VE', { minimumFractionDigits: min, maximumFractionDigits: max })
const bsFmt = nf(2, 2)
const rateFmt = nf(2, 4)
/** 65540.25 -> "65.540,25" */
export const fmtBsNum = (n: number) => bsFmt.format(n)
/** 873.87 -> "873,87" (hasta 4 decimales si hacen falta) */
export const fmtRate = (n: number) => rateFmt.format(n)
/** 75 -> "$ 75,00" */
export const fmtUsd = (n: number) => `$ ${bsFmt.format(n)}`
/** Lo que se ve en un input al editar: coma decimal, sin separador de miles. */
export const inputNum = (n: number | null | undefined, dec = 2) => (n == null ? '' : String(Number(n.toFixed(dec))).replace('.', ','))

/**
 * "65.540,25", "65540,25", "65540.25" o "873,87" -> número. Si trae punto y coma, el último es el decimal; con un solo separador
 * repetido (1.234.567) es de miles. null si no es un número.
 */
export function parseNum(raw: string): number | null {
  let s = raw.replace(/\s|bs\.?|\$/gi, '')
  if (!s) return null
  const dot = s.lastIndexOf('.')
  const comma = s.lastIndexOf(',')
  if (dot >= 0 && comma >= 0) {
    const dec = dot > comma ? '.' : ','
    const grp = dec === '.' ? ',' : '.'
    s = s.split(grp).join('').replace(dec, '.')
  } else if (comma >= 0) {
    s = s.split(',').length > 2 ? s.split(',').join('') : s.replace(',', '.')
  } else if (dot >= 0 && s.split('.').length > 2) {
    s = s.split('.').join('')
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}
export const round2 = (n: number) => Math.round(n * 100) / 100
export const round4 = (n: number) => Math.round(n * 10_000) / 10_000
