// Rutas de la web (sesión + CSRF) para el chat interno. Sin lógica propia: mismos servicios que /api/v1 y el MCP.
// Lo que escribe un socio desde la web lleva fuente «manual»; quién escribe sale de la sesión.
import { Router, type Request } from 'express'
import { chatBorrar, chatContadores, chatEditar, chatListar, chatMarcarLeido, chatPublicar, chatUsuarios, chatVer } from '../services/chat.ts'
import { exec } from '../services/common.ts'

export const chatRouter = Router()

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const body = (req: Request) => (isObject(req.body) ? req.body : {})
const query = (req: Request) => {
  const o: Record<string, unknown> = { ...req.query }
  if (typeof o.limite === 'string') o.limite = Number(o.limite)
  return o
}

chatRouter.get('/usuarios', async (req, res) => void res.json(await exec(chatUsuarios, req.user!, {})))
chatRouter.get('/contadores', async (req, res) => void res.json(await exec(chatContadores, req.user!, {})))
chatRouter.get('/', async (req, res) => void res.json(await exec(chatListar, req.user!, query(req))))
chatRouter.get('/:id', async (req, res) => void res.json(await exec(chatVer, req.user!, { id: req.params.id })))
chatRouter.post('/', async (req, res) => {
  const out = (await exec(chatPublicar, req.user!, { ...body(req), fuente: 'manual' })) as { creado: boolean }
  res.status(out.creado ? 201 : 200).json(out)
})
chatRouter.post('/leido', async (req, res) => void res.json(await exec(chatMarcarLeido, req.user!, body(req))))
chatRouter.patch('/:id', async (req, res) => void res.json(await exec(chatEditar, req.user!, { ...body(req), id: req.params.id })))
chatRouter.delete('/:id', async (req, res) => void res.json(await exec(chatBorrar, req.user!, { id: req.params.id })))
