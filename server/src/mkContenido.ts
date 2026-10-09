// Hoja del grafo de imports: crear una pieza de contenido (planeta Marketing). La usan el servicio de marketing y el del feed
// (convertir una idea en contenido) sin importarse entre sí.
import type { Db } from './db.ts'

export type NuevoContenido = {
  titulo: string
  keyword_id?: string | null
  responsable_id: string
  fecha_objetivo?: string | null
  notas?: string | null
  feed_item_id?: string | null
  created_by: string
}

/** Inserta la pieza en «idea» y devuelve su id. */
export async function insertContenido(c: Db, n: NuevoContenido): Promise<string> {
  const { rows } = await c.query(
    `INSERT INTO mk_contenidos (titulo, keyword_id, responsable_id, fecha_objetivo, notas, feed_item_id, created_by)
     VALUES ($1, $2, $3, $4::date, $5, $6, $7) RETURNING id`,
    [n.titulo, n.keyword_id ?? null, n.responsable_id, n.fecha_objetivo ?? null, n.notas ?? null, n.feed_item_id ?? null, n.created_by],
  )
  return rows[0].id as string
}
