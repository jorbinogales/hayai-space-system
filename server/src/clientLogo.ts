// Logo del cliente: la imagen vive en la BD (client_logos), igual que los comprobantes de cobro.
// Hoja del grafo de imports (solo db/util): lo usan las rutas de la web, el servicio de clientes
// de la API v1/MCP y cualquier otro consumidor sin crear ciclos.
import type { Db } from './db.ts'
import { HttpError } from './util.ts'

export const MAX_LOGO_BYTES = 4 * 1024 * 1024
export type LogoMime = 'image/png' | 'image/jpeg' | 'image/webp'

/** Tipo real por los primeros bytes (no por lo que diga el cliente): solo PNG, JPEG y WebP. */
export function sniffLogo(b: Buffer): LogoMime | null {
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}
export const LOGO_EXT: Record<LogoMime, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

/** Guarda (o reemplaza) el logo del cliente. 404 si el cliente no existe. */
export async function saveClientLogo(db: Db, clientId: string, userId: string, f: { filename: string; mime: LogoMime; data: Buffer }): Promise<void> {
  if (!(await db.query('SELECT 1 FROM clients WHERE id = $1', [clientId])).rowCount) throw new HttpError(404, 'Cliente no encontrado')
  await db.query(
    `INSERT INTO client_logos (client_id, filename, mime, size, data, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (client_id) DO UPDATE SET filename = EXCLUDED.filename, mime = EXCLUDED.mime, size = EXCLUDED.size,
       data = EXCLUDED.data, uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now()`,
    [clientId, f.filename, f.mime, f.data.length, f.data, userId],
  )
}

/** Quita el logo del cliente. Devuelve si había uno. */
export async function deleteClientLogo(db: Db, clientId: string): Promise<boolean> {
  return ((await db.query('DELETE FROM client_logos WHERE client_id = $1', [clientId])).rowCount ?? 0) > 0
}

/** El archivo del logo para servirlo. 404 si el cliente no tiene logo. */
export async function clientLogoFile(db: Db, clientId: string): Promise<{ data: Buffer; mime: LogoMime; filename: string }> {
  const r = (await db.query('SELECT data, mime, filename FROM client_logos WHERE client_id = $1', [clientId])).rows[0]
  if (!r) throw new HttpError(404, 'El cliente no tiene logo')
  return { data: r.data as Buffer, mime: r.mime as LogoMime, filename: r.filename as string }
}
