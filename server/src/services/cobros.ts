// Módulo de cobros: detalle de un cobro (bolívares, tasa, banco, quién recibió), comprobante (imagen del capture) y el mapeo
// documento -> socio que recibe. Un servicio para la web, la API v1 y el MCP.
// Flujo del comprobante: se guarda la imagen, se lee el texto (OCR, o el texto que ya traiga quien llama) y se busca
// "DOCUMENTO V-..."; si el documento está en el mapeo, recibido_por se asigna solo. Si no se detecta o no está mapeado,
// NO se inventa nada: la respuesta pide confirmación manual.
import { z } from 'zod'
import { type Db, pool, tx } from '../db.ts'
import { detectDocument, extractText, maskDocument, maskDocumentsIn, normalizeDocument } from '../ocr.ts'
import { DETAIL_COLUMNS, DETAIL_JOINS, detalleOut } from '../paymentDetail.ts'
import { userByName } from '../socios.ts'
import { HttpError, id, text } from '../util.ts'
import { op, todayISO } from './common.ts'

export const MAX_RECEIPT_BYTES = 4 * 1024 * 1024
type Mime = 'image/png' | 'image/jpeg' | 'image/webp'

/** Tipo real por los primeros bytes (no por lo que diga el cliente): solo PNG, JPEG y WebP. */
export function sniffImage(b: Buffer): Mime | null {
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}
const EXT: Record<Mime, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

const BASE = `SELECT p.id, p.client_id, cl.name AS client, p.date, p.concept, p.amount, p.kind, p.status, p.series_index, p.series_total, ${DETAIL_COLUMNS}
  FROM payments p JOIN clients cl ON cl.id = p.client_id ${DETAIL_JOINS}`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const cobroOut = (r: any) => ({
  id: r.id as string,
  cliente_id: r.client_id as string,
  cliente: r.client as string,
  fecha: r.date as string,
  concepto: (r.series_index ? `${r.concept} ${r.series_index}/${r.series_total}` : r.concept) as string,
  monto: Number(r.amount),
  tipo: r.kind as string,
  estado: r.status as string,
  vencido: r.status === 'pendiente' && r.date < todayISO(),
  ...detalleOut(r),
})

export async function cobro(paymentId: string) {
  const r = (await pool.query(`${BASE} WHERE p.id = $1`, [paymentId])).rows[0]
  if (!r) throw new HttpError(404, 'Pago no encontrado')
  return cobroOut(r)
}

export const pagoVer = op(z.strictObject({ id }), (_a, i) => cobro(i.id))

// ---------- mapeo documento -> socio ----------
const documento = z.string('Documento inválido').trim().min(5, 'Documento inválido').max(20, 'Documento inválido')

export const receptoresListar = op(z.strictObject({}), async () => {
  const { rows } = await pool.query(
    `SELECT d.id, d.document, d.created_at, u.id AS user_id, u.name FROM receiver_documents d JOIN users u ON u.id = d.user_id ORDER BY u.name, d.created_at`,
  )
  // Enmascarado: el listado no expone cédulas completas a cada llave; para cambiar uno se guarda de nuevo o se elimina por id.
  return { data: rows.map((r) => ({ id: r.id as string, documento: maskDocument(r.document), socio: { id: r.user_id as string, nombre: r.name as string } })) }
})

export const receptorGuardar = op(z.strictObject({ documento, socio: text(40) }), async (_a, b) => {
  const doc = normalizeDocument(b.documento)
  if (!doc) throw new HttpError(400, 'documento: usa letra y número, por ejemplo V-12345678')
  const u = await userByName(pool, b.socio, 'socio')
  const { rows } = await pool.query(
    `INSERT INTO receiver_documents (document, user_id) VALUES ($1, $2)
     ON CONFLICT (document) DO UPDATE SET user_id = EXCLUDED.user_id RETURNING id`,
    [doc, u.id],
  )
  return { id: rows[0].id as string, documento: maskDocument(doc), socio: { id: u.id, nombre: u.name } }
})

export const receptorEliminar = op(z.strictObject({ id }), async (_a, b) => {
  const r = await pool.query('DELETE FROM receiver_documents WHERE id = $1', [b.id])
  if (!r.rowCount) throw new HttpError(404, 'Mapeo no encontrado')
  return { eliminado: true }
})

/** Siembra el mapeo desde RECEIVER_DOCUMENTS="V-111=Elis,V-222=Jorbi" (solo agrega los que faltan; lo editado en la interfaz manda). */
export async function seedReceiverDocuments(spec = process.env.RECEIVER_DOCUMENTS) {
  if (!spec?.trim()) return 0
  let n = 0
  for (const pair of spec.split(',')) {
    const [rawDoc, rawName] = pair.split('=').map((s) => s?.trim())
    const doc = rawDoc ? normalizeDocument(rawDoc) : null
    if (!doc || !rawName) {
      console.error(`RECEIVER_DOCUMENTS: entrada ignorada (${rawName ? 'documento inválido' : 'falta el socio'})`)
      continue
    }
    const u = (await pool.query('SELECT id FROM users WHERE lower(name) = lower($1)', [rawName])).rows[0]
    if (!u) {
      console.error(`RECEIVER_DOCUMENTS: no hay un socio llamado "${rawName}"`)
      continue
    }
    n += (await pool.query('INSERT INTO receiver_documents (document, user_id) VALUES ($1, $2) ON CONFLICT (document) DO NOTHING', [doc, u.id])).rowCount ?? 0
  }
  return n
}

// ---------- comprobante ----------
type Deteccion = {
  documento: string | null
  estado: 'asignado' | 'ya_asignado' | 'difiere' | 'sin_mapeo' | 'no_detectado'
  socio: { id: string; nombre: string } | null
  requiere_confirmacion: boolean
}

/** Cruza el documento detectado con el mapeo y, si procede, asigna recibido_por (nunca pisa lo que alguien ya fijó a mano). */
async function applyDetection(c: Db, paymentId: string, doc: string | null): Promise<Deteccion> {
  if (!doc) return { documento: null, estado: 'no_detectado', socio: null, requiere_confirmacion: true }
  const m = (
    await c.query(`SELECT u.id, u.name FROM receiver_documents d JOIN users u ON u.id = d.user_id WHERE d.document = $1`, [doc])
  ).rows[0] as { id: string; name: string } | undefined
  const shown = maskDocument(doc)
  if (!m) return { documento: shown, estado: 'sin_mapeo', socio: null, requiere_confirmacion: true }
  const cur = (await c.query('SELECT received_by FROM payments WHERE id = $1 FOR UPDATE', [paymentId])).rows[0]
  const socio = { id: m.id, nombre: m.name }
  if (!cur.received_by) {
    await c.query(`UPDATE payments SET received_by = $2, received_by_source = 'comprobante' WHERE id = $1`, [paymentId, m.id])
    return { documento: shown, estado: 'asignado', socio, requiere_confirmacion: false }
  }
  if (cur.received_by === m.id) return { documento: shown, estado: 'ya_asignado', socio, requiere_confirmacion: false }
  return { documento: shown, estado: 'difiere', socio, requiere_confirmacion: true }
}

export const comprobanteSubir = op(
  z.strictObject({
    id,
    imagen_base64: z.string('imagen_base64 es obligatoria').min(100, 'La imagen está vacía o incompleta').max(6_000_000, 'Imagen demasiado grande (máximo 4 MB)'),
    nombre: text(120).optional(),
    // Si quien llama ya leyó el texto (p. ej. un agente con visión), se usa en vez del OCR del servidor.
    texto_ocr: z.string().max(20_000).optional(),
  }),
  async (actor, b) => {
    const buf = Buffer.from(b.imagen_base64.replace(/^data:[^;]+;base64,/, ''), 'base64')
    if (buf.length > MAX_RECEIPT_BYTES) throw new HttpError(413, 'Imagen demasiado grande (máximo 4 MB)')
    const mime = sniffImage(buf)
    if (!mime) throw new HttpError(400, 'imagen_base64: solo se aceptan imágenes PNG, JPEG o WebP')
    if (!(await pool.query('SELECT 1 FROM payments WHERE id = $1', [b.id])).rowCount) throw new HttpError(404, 'Pago no encontrado')

    const ocr = (b.texto_ocr ?? (await extractText(buf))).slice(0, 20_000) // lo lento va antes de la transacción
    const doc = detectDocument(ocr)
    const nombre = (b.nombre ?? `comprobante.${EXT[mime]}`).replace(/[\r\n"\\/]/g, '_')

    const deteccion = await tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM payments WHERE id = $1 FOR UPDATE', [b.id])).rowCount) throw new HttpError(404, 'Pago no encontrado')
      await c.query(
        `INSERT INTO payment_receipts (payment_id, filename, mime, size, data, ocr_text, detected_document, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (payment_id) DO UPDATE SET filename = EXCLUDED.filename, mime = EXCLUDED.mime, size = EXCLUDED.size, data = EXCLUDED.data,
           ocr_text = EXCLUDED.ocr_text, detected_document = EXCLUDED.detected_document, uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now()`,
        [b.id, nombre, mime, buf.length, buf, ocr || null, doc, actor.id],
      )
      return applyDetection(c, b.id, doc)
    })
    return { cobro: await cobro(b.id), deteccion: { ...deteccion, texto_ocr: maskDocumentsIn(ocr).slice(0, 1500) } }
  },
)

/** Vuelve a cruzar el documento ya leído con el mapeo (por si lo acaban de agregar). No repite el OCR. */
export const comprobanteDetectar = op(z.strictObject({ id }), async (_a, b) => {
  const r = (await pool.query('SELECT detected_document, ocr_text FROM payment_receipts WHERE payment_id = $1', [b.id])).rows[0]
  if (!r) throw new HttpError(404, 'Este cobro no tiene comprobante')
  const doc = (r.detected_document as string | null) ?? detectDocument((r.ocr_text as string | null) ?? '')
  const deteccion = await tx((c) => applyDetection(c, b.id, doc))
  return { cobro: await cobro(b.id), deteccion }
})

export const comprobanteVer = op(z.strictObject({ id }), async (_a, b) => {
  const r = (await pool.query('SELECT detected_document, ocr_text FROM payment_receipts WHERE payment_id = $1', [b.id])).rows[0]
  if (!r) throw new HttpError(404, 'Este cobro no tiene comprobante')
  return { cobro: await cobro(b.id), documento_detectado: r.detected_document ? maskDocument(r.detected_document) : null, texto_ocr: maskDocumentsIn((r.ocr_text as string | null) ?? '').slice(0, 1500) }
})

/** Los bytes de la imagen (para la web y la ruta de descarga de la API). */
export async function comprobanteArchivo(paymentId: string) {
  const r = (await pool.query('SELECT data, mime, filename FROM payment_receipts WHERE payment_id = $1', [paymentId])).rows[0]
  if (!r) throw new HttpError(404, 'Este cobro no tiene comprobante')
  return { data: r.data as Buffer, mime: r.mime as Mime, filename: r.filename as string }
}
