// Operaciones sobre el guión versionado de un potencial del feed: ver con su historial, editar (nueva versión) y restablecer al original
// (también una versión nueva, marcada «restablecido»). Un servicio para la web, la API v1 y el MCP. Nada se borra ni se pisa: ver
// server/src/feedGuion.ts y la migración 030.
//
// Si dos personas editan a la vez: quien guarda manda la versión que estaba mirando (`base`). Si mientras tanto hubo otra más nueva,
// responde 409 (codigo «conflicto_guion») con la versión vigente y NO guarda; con `forzar: true` se guarda igual como versión nueva
// (la de la otra persona sigue en el historial) y queda anotado sobre qué versión se hizo.
import { z } from 'zod'
import { pool, tx } from '../db.ts'
import { GUION_MAX, guionDe, limpiarGuion, versionesDe, type GuionOut, type Version } from '../feedGuion.ts'
import { HttpError, id } from '../util.ts'
import { op } from './common.ts'
import { item, visible } from './feed.ts'

type Item = Awaited<ReturnType<typeof item>>
export type GuionDetalle = {
  item_id: string
  titulo: string
  guion: GuionOut
  /** de la más nueva a la más vieja */
  versiones: Version[]
  /** el ítem completo ya con el guión vigente (para refrescar la tarjeta sin otra consulta) */
  item: Item
}

async function detalle(itemId: string, userId: string): Promise<GuionDetalle> {
  const it = await item(pool, itemId, userId)
  const versiones = await versionesDe(pool, itemId)
  const guion = guionDe(versiones, it.datos)
  if (!guion) throw new HttpError(404, 'Este ítem no tiene guión')
  return { item_id: it.id, titulo: it.titulo, guion, versiones, item: it }
}

export const feedGuionVer = op(z.strictObject({ id }), (actor, b) => detalle(b.id, actor.id))

const base = z.number('base debe ser el número de la versión que estabas viendo').int('base debe ser un entero').min(0)
const forzar = z.boolean('forzar debe ser true o false').optional()

/** Bloquea el ítem (si el socio lo ve), lee la versión vigente y, si hay `base` y cambió, responde 409 con la vigente. */
async function guardar(
  actor: { id: string },
  b: { id: string; base?: number; forzar?: boolean },
  nueva: (vigente: Version, original: Version) => { contenido: string; tipo: 'edicion' | 'restablecido' },
) {
  await tx(async (c) => {
    if (!(await c.query(`SELECT 1 FROM feed_items f WHERE f.id = $1 AND ${visible('$2')} FOR UPDATE`, [b.id, actor.id])).rowCount) throw new HttpError(404, 'Ítem del feed no encontrado')
    const vs = await versionesDe(c, b.id)
    const vigente = vs[0]
    const original = vs.find((v) => v.tipo === 'original')
    if (!vigente || !original) throw new HttpError(404, 'Este ítem no tiene guión')
    if (b.base !== undefined && b.base !== vigente.nro && !b.forzar)
      throw new HttpError(409, `${vigente.editado_por ?? 'Otra persona'} guardó la versión ${vigente.nro} del guión mientras lo editabas. Revísala antes de guardar la tuya.`, {
        codigo: 'conflicto_guion',
        vigente: { nro: vigente.nro, tipo: vigente.tipo, contenido: vigente.contenido, por: vigente.editado_por, el: vigente.editado_el },
      })
    const n = nueva(vigente, original)
    await c.query(
      `INSERT INTO feed_guion_versiones (item_id, nro, contenido, tipo, editado_por, base_nro) VALUES ($1, $2, $3, $4, $5, $6)`,
      [b.id, vigente.nro + 1, n.contenido, n.tipo, actor.id, b.base ?? vigente.nro],
    )
  })
  return detalle(b.id, actor.id)
}

export const feedGuionEditar = op(
  z.strictObject({
    id,
    contenido: z.string('contenido debe ser un texto').max(GUION_MAX * 2, `El guión no puede pasar de ${GUION_MAX} caracteres`),
    base: base.optional(), // la versión que estabas viendo; sin ella no se comprueba nada (agentes que escriben a ciegas)
    forzar,
  }),
  (actor, b) => {
    const contenido = limpiarGuion(b.contenido)
    if (!contenido) throw new HttpError(400, 'El guión no puede quedar vacío')
    if (contenido.length > GUION_MAX) throw new HttpError(400, `El guión no puede pasar de ${GUION_MAX} caracteres (tiene ${contenido.length})`)
    return guardar(actor, b, (vigente) => {
      if (contenido === vigente.contenido) throw new HttpError(400, 'No hay cambios: el guión es igual al vigente')
      return { contenido, tipo: 'edicion' }
    })
  },
)

export const feedGuionRestablecer = op(z.strictObject({ id, base: base.optional(), forzar }), (actor, b) =>
  guardar(actor, b, (vigente, original) => {
    if (vigente.contenido === original.contenido) throw new HttpError(409, 'El guión vigente ya es el original: no hay nada que restablecer')
    return { contenido: original.contenido, tipo: 'restablecido' }
  }),
)
