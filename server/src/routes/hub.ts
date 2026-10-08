// Rutas de la web (sesion + CSRF) para el hub central y los cobros. Sin logica propia: mismos servicios que /api/v1 y el MCP.
import { Router, type Request } from 'express'
import { exec } from '../services/common.ts'
import { comprobanteArchivo, comprobanteDetectar, comprobanteSubir, comprobanteVer, pagoVer, receptorEliminar, receptorGuardar, receptoresListar } from '../services/cobros.ts'
import { pagoActualizar } from '../services/clientes.ts'
import { acuerdoActualizar, acuerdoCrear, acuerdosListar, equipoActualizar, equipoVer, hubVer, marketingEmbudo } from '../services/hub.ts'
import { feedConvertir, feedDeshacer, feedGuardar, feedListar, feedMarcar, feedPublicar, feedVer } from '../services/feed.ts'
import { sistemaActualizar, sistemaCrear, sistemasListar, sistemaVer, sistemaVerificar } from '../services/sistemas.ts'

import { versionesListar, versionPublicar, versionVer } from '../services/versiones.ts'

export const hubRouter = Router()

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const body = (req: Request) => (isObject(req.body) ? req.body : {})
const query = (req: Request) => {
  const o: Record<string, unknown> = { ...req.query }
  for (const k of ['page', 'per_page', 'dias']) if (typeof o[k] === 'string') o[k] = Number(o[k])
  return o
}

hubRouter.get('/version', async (req, res) => void res.json(await exec(versionVer, req.user!, query(req))))
hubRouter.get('/versions', async (req, res) => void res.json(await exec(versionesListar, req.user!, query(req))))
hubRouter.post('/versions', async (req, res) => void res.status(201).json(await exec(versionPublicar, req.user!, body(req))))
hubRouter.get('/hub', async (req, res) => void res.json(await exec(hubVer, req.user!, {})))
hubRouter.get('/team', async (req, res) => void res.json(await exec(equipoVer, req.user!, {})))
hubRouter.patch('/team/:socio', async (req, res) => void res.json(await exec(equipoActualizar, req.user!, { ...body(req), socio: req.params.socio })))
hubRouter.get('/agreements', async (req, res) => void res.json(await exec(acuerdosListar, req.user!, query(req))))
hubRouter.post('/agreements', async (req, res) => void res.status(201).json(await exec(acuerdoCrear, req.user!, body(req))))
hubRouter.patch('/agreements/:id', async (req, res) => void res.json(await exec(acuerdoActualizar, req.user!, { ...body(req), id: req.params.id })))
hubRouter.get('/systems', async (req, res) => void res.json(await exec(sistemasListar, req.user!, query(req))))
hubRouter.get('/systems/:id', async (req, res) => void res.json(await exec(sistemaVer, req.user!, { id: req.params.id })))
hubRouter.post('/systems', async (req, res) => void res.status(201).json(await exec(sistemaCrear, req.user!, body(req))))
hubRouter.patch('/systems/:id', async (req, res) => void res.json(await exec(sistemaActualizar, req.user!, { ...body(req), id: req.params.id })))
hubRouter.post('/systems/:id/check', async (req, res) => void res.json(await exec(sistemaVerificar, req.user!, { id: req.params.id })))
hubRouter.get('/marketing/funnel', async (req, res) => void res.json(await exec(marketingEmbudo, req.user!, query(req))))

// Cobros: detalle, comprobante y mapeo de documentos.
hubRouter.get('/cobros/:id', async (req, res) => void res.json(await exec(pagoVer, req.user!, { id: req.params.id })))
hubRouter.patch('/cobros/:id', async (req, res) => {
  await exec(pagoActualizar, req.user!, { ...body(req), id: req.params.id })
  res.json(await exec(pagoVer, req.user!, { id: req.params.id }))
})
hubRouter.post('/cobros/:id/comprobante', async (req, res) => void res.json(await exec(comprobanteSubir, req.user!, { ...body(req), id: req.params.id })))
hubRouter.get('/cobros/:id/comprobante', async (req, res) => void res.json(await exec(comprobanteVer, req.user!, { id: req.params.id })))
hubRouter.post('/cobros/:id/comprobante/detectar', async (req, res) => void res.json(await exec(comprobanteDetectar, req.user!, { id: req.params.id })))
hubRouter.get('/cobros/:id/comprobante/archivo', async (req, res) => {
  const f = await comprobanteArchivo(String(req.params.id))
  res.setHeader('Content-Type', f.mime)
  res.setHeader('Content-Disposition', `inline; filename="${f.filename}"`)
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
  res.send(f.data)
})
hubRouter.get('/receptores', async (req, res) => void res.json(await exec(receptoresListar, req.user!, {})))
hubRouter.post('/receptores', async (req, res) => void res.json(await exec(receptorGuardar, req.user!, body(req))))
hubRouter.delete('/receptores/:id', async (req, res) => void res.json(await exec(receptorEliminar, req.user!, { id: req.params.id })))

// Feed de oportunidades (lo que encontraron las máquinas y los agentes). La web publica con fuente "manual" o la que mande la pantalla.
hubRouter.get('/feed', async (req, res) => void res.json(await exec(feedListar, req.user!, query(req))))
hubRouter.get('/feed/:id', async (req, res) => void res.json(await exec(feedVer, req.user!, { id: req.params.id })))
hubRouter.post('/feed', async (req, res) => {
  const out = (await exec(feedPublicar, req.user!, body(req))) as { creado?: boolean; creados?: number }
  res.status(out.creado ?? out.creados ? 201 : 200).json(out)
})
hubRouter.patch('/feed/:id/estado', async (req, res) => void res.json(await exec(feedMarcar, req.user!, { ...body(req), id: req.params.id })))
hubRouter.post('/feed/:id/guardar', async (req, res) => void res.json(await exec(feedGuardar, req.user!, { ...body(req), id: req.params.id })))
hubRouter.post('/feed/:id/convertir', async (req, res) => void res.json(await exec(feedConvertir, req.user!, { ...body(req), id: req.params.id })))
hubRouter.post('/feed/:id/deshacer', async (req, res) => void res.json(await exec(feedDeshacer, req.user!, { ...body(req), id: req.params.id })))
