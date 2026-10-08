// Vínculos de un ítem del feed con lo que se creó a partir de él (feed_item_vinculos). Hoja del grafo de imports (db/util):
// lo usan el servicio del feed y el de propuestas sin que se importen entre sí.
import type { Db } from './db.ts'
import { HttpError } from './util.ts'

export const VINCULOS = ['posible_cliente', 'cliente', 'tarea', 'proyecto', 'propuesta', 'seguimiento'] as const
export type Vinculo = (typeof VINCULOS)[number]
/** En qué tabla vive lo creado por cada clase (lista cerrada: nunca viene del cliente). */
export const VINCULO_TABLA: Record<Vinculo, string> = { posible_cliente: 'clients', cliente: 'clients', tarea: 'tasks', proyecto: 'projects', propuesta: 'proposals', seguimiento: 'tasks' }

/** Anota que `refId` salió del ítem; la primera cosa creada pasa el ítem a «convertido» (global). Si ya había una de esa clase, la reemplaza. */
export async function vincular(c: Db, itemId: string, kind: Vinculo, refId: string, actorId: string) {
  const it = (await c.query('SELECT status FROM feed_items WHERE id = $1 FOR UPDATE', [itemId])).rows[0]
  if (!it) throw new HttpError(404, 'Ítem del feed no encontrado')
  await c.query(
    `INSERT INTO feed_item_vinculos (item_id, kind, ref_id, created_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (item_id, kind) DO UPDATE SET ref_id = EXCLUDED.ref_id, created_by = EXCLUDED.created_by, created_at = now()`,
    [itemId, kind, refId, actorId],
  )
  if (it.status !== 'convertido')
    await c.query(`UPDATE feed_items SET status = 'convertido', converted_to = $2, converted_id = $3, discard_reason = NULL, status_by = $4, status_at = now() WHERE id = $1`, [itemId, kind, refId, actorId])
}
