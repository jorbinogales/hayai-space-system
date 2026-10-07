// OCR de los comprobantes (capture de la transferencia): lee el texto de la imagen para sacar el DOCUMENTO del receptor.
// tesseract.js corre en WASM dentro de Node (sin binarios del sistema, sirve en alpine) y el idioma viaja en el paquete
// @tesseract.js-data/eng: no sale a internet. Un worker por lectura (se crea y se cierra) y de una en una, para no disparar
// la memoria del VPS. Si algo falla, devuelve '' y el flujo pide confirmacion manual: el OCR ayuda, nunca bloquea un cobro.
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'

const require = createRequire(import.meta.url)
const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS) || 25_000

let chain: Promise<unknown> = Promise.resolve()

/** Texto de la imagen ('' si no se pudo leer). Las lecturas se encolan: nunca hay dos workers a la vez. */
export function extractText(image: Buffer): Promise<string> {
  const run = chain.then(() => read(image))
  chain = run.catch(() => {})
  return run
}

type OcrWorker = { recognize: (i: Buffer) => Promise<{ data: { text: string } }>; terminate: () => Promise<unknown> }

async function read(image: Buffer): Promise<string> {
  const held: { worker?: OcrWorker; timer?: NodeJS.Timeout } = {}
  const deadline = (what: string) =>
    new Promise<never>((_, no) => {
      clearTimeout(held.timer)
      held.timer = setTimeout(() => no(new Error(`OCR: tiempo agotado ${what}`)), OCR_TIMEOUT_MS)
    })
  try {
    const { createWorker } = await import('tesseract.js')
    const langPath = dirname(require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'))
    const creating = createWorker('eng', 1, { langPath, gzip: true, cachePath: tmpdir(), errorHandler: () => {} }) as unknown as Promise<OcrWorker>
    // Si se agota el tiempo al iniciar, el worker que termine de crearse despues igual se cierra (no queda colgado).
    creating.then((w) => (held.worker = w)).catch(() => {})
    held.worker = await Promise.race([creating, deadline('al iniciar')])
    const out = await Promise.race([held.worker.recognize(image), deadline('al leer')])
    return out.data.text ?? ''
  } catch (e) {
    console.error('ocr:', (e as Error).message)
    return ''
  } finally {
    clearTimeout(held.timer)
    await held.worker?.terminate().catch(() => {})
  }
}

/** Letra + digitos, sin puntos ni guiones: 'V-26.358.692' -> 'V26358692'. null si no parece un documento. */
export function normalizeDocument(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const m = /^([VEJGP])?(\d{5,10})$/.exec(s)
  return m ? `${m[1] ?? 'V'}${m[2]}` : null
}

/** 'V26358692' -> 'V-26358692' (para mostrar). */
export const formatDocument = (d: string) => `${d[0]}-${d.slice(1)}`

/** 'V-26358692' -> 'V-263•••92': el mapeo se lista enmascarado. */
export const maskDocument = (d: string) => `${d[0]}-${d.slice(1, 4)}${'•'.repeat(Math.max(d.length - 6, 1))}${d.slice(-2)}`

/**
 * Busca el patron "DOCUMENTO V-26358692" (o con puntos, espacios, dos puntos). Tolera los errores tipicos del OCR
 * ('DOCUMENT0', 'V 26358692'). Devuelve el documento normalizado o null.
 */
export function detectDocument(text: string): string | null {
  const m = /DOCUMENT[O0][ \t]*[:.\-]?[ \t]*([VEJGP])?[ \t]*[-–.]?[ \t]*(\d[\d.]{4,12})/i.exec(text.replace(/\r/g, ''))
  if (!m) return null
  return normalizeDocument(`${m[1] ?? 'V'}${m[2]}`)
}

/** El texto leído del capture puede traer la cédula completa: se devuelve con todo documento enmascarado. */
export function maskDocumentsIn(text: string): string {
  const mask = (raw: string) => {
    const d = normalizeDocument(raw)
    return d ? maskDocument(d) : raw
  }
  return text
    .replace(/(DOCUMENT[O0][ \t]*[:.\-]?[ \t]*)([VEJGP]?[ \t]*[-–.]?[ \t]*\d[\d.]{4,12})/gi, (_m, pre: string, doc: string) => pre + mask(doc))
    .replace(/\b[VEJGP][ \t]*-?[ \t]*\d[\d.]{4,11}\b/gi, (m) => mask(m))
}
