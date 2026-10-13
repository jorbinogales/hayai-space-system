// Guión versionado de los potenciales del feed. La publicación trae `datos.guion` (texto); desde la migración 030 cada guión vive en
// feed_guion_versiones: la versión 1 es el ORIGINAL (inmutable) y cada edición o «restablecer al original» agrega una versión nueva.
// El guión vigente es la versión con el nro más alto. Nada se borra.
//
// Esta parte (sin dependencias del servicio del feed) la usan el listado/detalle (adjuntar el guión vigente a cada ítem), la publicación
// (sembrar el original de un ítem nuevo) y el script de reescritura. Las operaciones (ver, editar, restablecer) están en services/feedGuion.ts.
import { pool, tx, type Db } from './db.ts'
import { entradaDe, guionPAS } from './guionPAS.ts'
import { textoWhatsapp, whatsappDe, type WhatsappDe } from './whatsapp.ts'

export const GUION_MAX = 1200 // un mensaje de WhatsApp por enlace: más largo no cabe cómodo en la URL ni se lee
export type TipoVersion = 'original' | 'previo' | 'edicion' | 'restablecido'

export type Version = {
  nro: number
  tipo: TipoVersion
  contenido: string
  editado_por: string | null
  editado_el: string
  /** Sobre qué versión estaba mirando quien la guardó (null en el original y los respaldos). */
  base_nro: number | null
}

/** Lo que cada ítem con guión lleva en el listado y el detalle. */
export type GuionOut = {
  /** nro de la versión vigente */
  version: number
  actual: string
  original: string
  /** quién guardó la versión vigente y cuándo; null en `por` si es del sistema (reescritura) */
  por: string | null
  el: string
  tipo: TipoVersion
  /** cuántas veces se editó o restableció (el original y el respaldo no cuentan) */
  ediciones: number
  /** el vigente es distinto del original */
  modificado: boolean
  /** a qué número se le escribe y el enlace wa.me con el guión vigente ya escrito */
  whatsapp: WhatsappDe
}

/** Normaliza lo que escribe una persona: \n reales, sin espacios al final de línea ni más de una línea en blanco seguida. */
export const limpiarGuion = (t: string) => textoWhatsapp(t)

/** El guión tal como lo trae la publicación (`datos.guion`), o null si no trae. */
export function guionDeDatos(d: Record<string, unknown>): string | null {
  const g = typeof d.guion === 'string' ? limpiarGuion(d.guion) : ''
  return g && g.length <= 4000 ? g : null
}

/** Versión 1 (original) de un ítem recién publicado. Idempotente. */
export async function sembrarGuion(db: Db, itemId: string, datos: Record<string, unknown>, userId: string | null): Promise<boolean> {
  const g = guionDeDatos(datos)
  if (!g) return false
  const r = await db.query(
    `INSERT INTO feed_guion_versiones (item_id, nro, contenido, tipo, editado_por) VALUES ($1, 1, $2, 'original', $3) ON CONFLICT DO NOTHING`,
    [itemId, g, userId],
  )
  return !!r.rowCount
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const versionOut = (r: any): Version => ({
  nro: r.nro as number,
  tipo: r.tipo as TipoVersion,
  contenido: r.contenido as string,
  editado_por: (r.por ?? null) as string | null,
  editado_el: (r.editado_en as Date).toISOString(),
  base_nro: (r.base_nro ?? null) as number | null,
})

/** Todas las versiones de un ítem, la más nueva primero. */
export async function versionesDe(db: Db, itemId: string): Promise<Version[]> {
  const rows = (
    await db.query(
      `SELECT v.nro, v.tipo, v.contenido, v.editado_en, v.base_nro, u.name AS por
         FROM feed_guion_versiones v LEFT JOIN users u ON u.id = v.editado_por WHERE v.item_id = $1 ORDER BY v.nro DESC`,
      [itemId],
    )
  ).rows
  return rows.map(versionOut)
}

/** Arma el bloque `guion` a partir de las versiones (la más nueva primero) y los datos de contacto del ítem. */
export function guionDe(versiones: Version[], datos: Record<string, unknown>): GuionOut | null {
  const actual = versiones[0]
  const original = versiones.find((v) => v.tipo === 'original')
  if (!actual || !original) return null
  return {
    version: actual.nro,
    actual: actual.contenido,
    original: original.contenido,
    por: actual.editado_por,
    el: actual.editado_el,
    tipo: actual.tipo,
    ediciones: versiones.filter((v) => v.tipo === 'edicion' || v.tipo === 'restablecido').length,
    modificado: actual.contenido !== original.contenido,
    whatsapp: whatsappDe(datos, actual.contenido),
  }
}

type ConGuion = { id: string; datos: Record<string, unknown>; guion: GuionOut | null }

/**
 * Le pone a cada ítem su guión vigente (`guion`) y deja `datos.guion` con ese mismo texto: quien lee `datos.guion` (la web, un agente,
 * las notas de conversión) siempre ve el guión que se está usando, no el que publicó la fuente. Una sola consulta para toda la página.
 */
export async function adjuntarGuiones<T extends ConGuion>(db: Db, items: T[]): Promise<T[]> {
  const ids = items.filter((i) => typeof i.datos.guion === 'string').map((i) => i.id)
  if (!ids.length) return items
  const rows = (
    await db.query(
      `SELECT v.item_id, v.nro, v.tipo, v.contenido, v.editado_en, v.base_nro, u.name AS por
         FROM feed_guion_versiones v LEFT JOIN users u ON u.id = v.editado_por WHERE v.item_id = ANY($1::uuid[]) ORDER BY v.item_id, v.nro DESC`,
      [ids],
    )
  ).rows
  const por = new Map<string, Version[]>()
  for (const r of rows) {
    const l = por.get(r.item_id as string) ?? []
    l.push(versionOut(r))
    por.set(r.item_id as string, l)
  }
  for (const it of items) {
    const g = guionDe(por.get(it.id) ?? [], it.datos)
    if (!g) continue
    it.guion = g
    it.datos = { ...it.datos, guion: g.actual }
  }
  return items
}

// ---------- reescritura masiva del original (PAS + BAB) ----------
export type ResultadoReescritura = 'reescrito' | 'sin_fugas' | 'editado' | 'ya_reescrito' | 'igual'
export type Reescritura = { revisados: number } & Record<ResultadoReescritura, number>

/**
 * Reescribe el guión ORIGINAL de los ítems que lo tienen con la plantilla PAS+BAB (server/src/guionPAS.ts). El texto anterior queda como
 * versión 0 («previo»: nada se pierde) y el nuevo pasa a ser el original. Respeta lo humano: un guión que alguien ya editó no se toca, uno ya
 * reescrito tampoco (idempotente) y un ítem sin fugas no se inventa (queda para escribirlo a mano). `aplicar: false` solo cuenta y muestra.
 */
export async function reescribirOriginales(o: { aplicar: boolean; id?: string; limite?: number; progreso?: (id: string, titulo: string, r: ResultadoReescritura, nuevo: string | null) => void } = { aplicar: false }): Promise<Reescritura> {
  const rows = (
    await pool.query(
      `SELECT DISTINCT f.id, f.title, f.data, f.found_at FROM feed_items f JOIN feed_guion_versiones v ON v.item_id = f.id WHERE ($1::uuid IS NULL OR f.id = $1) ORDER BY f.found_at DESC, f.id`,
      [o.id ?? null],
    )
  ).rows
  const out: Reescritura = { revisados: 0, reescrito: 0, sin_fugas: 0, editado: 0, ya_reescrito: 0, igual: 0 }
  let hechos = 0
  for (const r of rows) {
    if (o.limite !== undefined && hechos >= o.limite) break
    out.revisados++
    const nuevo = guionPAS(entradaDe((r.data ?? {}) as Record<string, unknown>, r.title as string))
    const res = await tx(async (c): Promise<ResultadoReescritura> => {
      await c.query('SELECT 1 FROM feed_items WHERE id = $1 FOR UPDATE', [r.id])
      const vs = await versionesDe(c, r.id as string)
      const original = vs.find((v) => v.tipo === 'original')
      if (!original) return 'igual'
      if (vs.some((v) => v.tipo === 'previo')) return 'ya_reescrito'
      if (vs[0].nro !== original.nro) return 'editado' // alguien ya lo tocó: no se pisa su trabajo
      if (!nuevo) return 'sin_fugas'
      if (nuevo === original.contenido) return 'igual'
      if (o.aplicar) {
        await c.query(`SELECT set_config('hayai.guion_reescritura', 'on', true)`) // solo esta transacción: el trigger deja tocar el original
        await c.query(
          `INSERT INTO feed_guion_versiones (item_id, nro, contenido, tipo, editado_por, editado_en) SELECT item_id, 0, contenido, 'previo', editado_por, editado_en FROM feed_guion_versiones WHERE item_id = $1 AND tipo = 'original'`,
          [r.id],
        )
        await c.query(`UPDATE feed_guion_versiones SET contenido = $2, editado_por = NULL, editado_en = now() WHERE item_id = $1 AND tipo = 'original'`, [r.id, nuevo])
      }
      return 'reescrito'
    })
    out[res]++
    if (res === 'reescrito') hechos++
    o.progreso?.(r.id as string, r.title as string, res, res === 'reescrito' ? nuevo : null)
  }
  return out
}
