import { Router } from 'express'
import { listTrash, purgeFromTrash, restoreFromTrash } from '../trash.ts'
import { idParam } from '../util.ts'

export const trashRouter = Router()

trashRouter.get('/', async (_req, res) => {
  res.json(await listTrash())
})

trashRouter.post('/:id/restore', async (req, res) => {
  res.json(await restoreFromTrash(idParam(req.params.id)))
})

// Borrado definitivo: solo desde la web, nunca por la API de integraciones.
trashRouter.delete('/:id', async (req, res) => {
  await purgeFromTrash(idParam(req.params.id))
  res.status(204).end()
})
