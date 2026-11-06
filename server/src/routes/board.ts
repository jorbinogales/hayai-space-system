// Tablero (módulo «tablero»): contrato en server/TABLERO.md. La lógica vive en services/tablero.ts (la misma de la API v1 y el MCP).
import { Router } from 'express'
import { z } from 'zod'
import {
  addComment, archivedCards, board, boardMembers, card, createCard, createColumn, deleteComment, description, editComment, listComments, moveCard, priority, setArchived, updateCard, updateColumn,
} from '../services/tablero.ts'
import { pool } from '../db.ts'
import { sendToTrash } from '../trash.ts'
import { id, idParam, isoDate, parse, text } from '../util.ts'

export const boardRouter = Router()

const afterId = id.nullable().optional() // null = arriba (la primera); sin él = al final
const body = z.object({ body: text(4000) })

boardRouter.get('/', async (_req, res) => {
  res.json(await board())
})

boardRouter.get('/members', async (_req, res) => {
  res.json(await boardMembers()) // candidatos a responsable: [{id, name, avatar}]
})

// ---------- columnas ----------
boardRouter.post('/columns', async (req, res) => {
  const b = parse(z.object({ name: text(60), afterId }), req.body)
  res.status(201).json(await createColumn(b))
})

boardRouter.patch('/columns/:id', async (req, res) => {
  const b = parse(z.object({ name: text(60).optional(), afterId }).refine((v) => v.name !== undefined || v.afterId !== undefined, 'Envía name o afterId'), req.body)
  res.json(await updateColumn(idParam(req.params.id), b))
})

boardRouter.delete('/columns/:id', async (req, res) => {
  await sendToTrash('columna', idParam(req.params.id), req.user!.id) // se lleva sus tarjetas (archivadas incluidas) y comentarios
  res.status(204).end()
})

// ---------- tarjetas ----------
const content = {
  description: description.nullable().optional(),
  priority: priority.optional(),
  assigneeId: id.nullable().optional(),
  clientId: id.nullable().optional(),
  dueDate: isoDate.nullable().optional(),
}

boardRouter.get('/cards/archived', async (_req, res) => {
  res.json(await archivedCards())
})

boardRouter.post('/cards', async (req, res) => {
  const b = parse(z.object({ columnId: id, title: text(200), ...content, afterId }), req.body)
  res.status(201).json(await createCard(req.user!, b))
})

boardRouter.get('/cards/:id', async (req, res) => {
  res.json(await card(pool, idParam(req.params.id)))
})

boardRouter.patch('/cards/:id', async (req, res) => {
  const b = parse(
    z.object({ title: text(200).optional(), ...content }).refine((v) => Object.values(v).some((x) => x !== undefined), 'Envía title, description, priority, assigneeId, clientId o dueDate'),
    req.body,
  )
  res.json(await updateCard(req.user!, idParam(req.params.id), b))
})

boardRouter.post('/cards/:id/move', async (req, res) => {
  const b = parse(z.object({ columnId: id, afterId }), req.body)
  res.json(await moveCard(req.user!, idParam(req.params.id), b.columnId, b.afterId))
})

boardRouter.post('/cards/:id/archive', async (req, res) => {
  res.json(await setArchived(idParam(req.params.id), true))
})
boardRouter.post('/cards/:id/unarchive', async (req, res) => {
  res.json(await setArchived(idParam(req.params.id), false))
})

boardRouter.delete('/cards/:id', async (req, res) => {
  await sendToTrash('tarjeta', idParam(req.params.id), req.user!.id)
  res.status(204).end()
})

// ---------- comentarios ----------
boardRouter.get('/cards/:id/comments', async (req, res) => {
  res.json(await listComments(idParam(req.params.id)))
})
boardRouter.post('/cards/:id/comments', async (req, res) => {
  res.status(201).json(await addComment(req.user!, idParam(req.params.id), parse(body, req.body).body))
})
boardRouter.patch('/comments/:id', async (req, res) => {
  res.json(await editComment(req.user!, idParam(req.params.id), parse(body, req.body).body))
})
boardRouter.delete('/comments/:id', async (req, res) => {
  await deleteComment(req.user!, idParam(req.params.id))
  res.status(204).end()
})
