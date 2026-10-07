// Papelera y borrado para la API v1 / MCP. Borrar siempre es recuperable (30 días): lo borrado va a la papelera y se restaura.
// El borrado definitivo NO se expone aquí: solo existe en la web.
import { z } from 'zod'
import { listTrash, restoreFromTrash, sendToTrash, type Entity } from '../trash.ts'
import { id } from '../util.ts'
import { op, pageShape, paged } from './common.ts'

const eliminar = (entity: Entity) =>
  op(z.strictObject({ id }), (actor, i) => sendToTrash(entity, i.id, actor.id, actor.via ?? 'api'))

export const clienteEliminar = eliminar('cliente')
export const proyectoEliminar = eliminar('proyecto')
export const pagoEliminar = eliminar('pago')
export const gastoEliminar = eliminar('gasto')
export const tareaEliminar = eliminar('tarea')
export const interaccionEliminar = eliminar('interaccion')

export const papeleraListar = op(z.strictObject({ ...pageShape }), async (_a, i) => {
  const all = await listTrash()
  const slice = all.slice((i.page - 1) * i.per_page, i.page * i.per_page)
  return paged(
    slice.map((t) => ({
      id: t.id,
      tipo: t.entity,
      nombre: t.label,
      resumen: t.detail,
      eliminado_por: t.deletedBy,
      origen: t.via,
      eliminado_el: t.deletedAt,
      restaurable_hasta: t.expiresAt,
    })),
    all.length,
    i.page,
    i.per_page,
  )
})

export const papeleraRestaurar = op(z.strictObject({ id }), (_a, i) => restoreFromTrash(i.id))
