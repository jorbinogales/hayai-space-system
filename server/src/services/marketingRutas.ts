// Rutas de la Central de marketing, definidas UNA vez: la API v1 las monta tal cual y la web las monta bajo /api.
import type { Op } from './common.ts'
import {
  campanasVer,
  competidorActualizar,
  competidorCrear,
  competidorKeywords,
  competidoresListar,
  competidorVer,
  contenidoActualizar,
  contenidoCrear,
  contenidoMover,
  contenidosListar,
  contenidoVer,
  kwActualizar,
  kwContenido,
  kwGuardar,
  kwIdea,
  kwInvestigar,
  kwListar,
  kwSerp,
  kwSerpAviso,
  kwVer,
} from './marketing.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MkRuta = { method: 'get' | 'post' | 'patch'; path: string; op: Op<any, any>; status?: number | ((out: any) => number) }

export const MK_RUTAS: MkRuta[] = [
  { method: 'get', path: '/marketing/keywords/investigar', op: kwInvestigar },
  { method: 'get', path: '/marketing/keywords', op: kwListar },
  // 201 si se guardó alguna nueva; 200 si ya estaba (✓ Guardada)
  { method: 'post', path: '/marketing/keywords', op: kwGuardar, status: (o) => ((o.creada ?? o.creadas) ? 201 : 200) },
  { method: 'get', path: '/marketing/keywords/:id', op: kwVer },
  { method: 'patch', path: '/marketing/keywords/:id', op: kwActualizar },
  { method: 'get', path: '/marketing/keywords/:id/serp-aviso', op: kwSerpAviso },
  { method: 'post', path: '/marketing/keywords/:id/serp', op: kwSerp },
  { method: 'post', path: '/marketing/keywords/:id/idea', op: kwIdea, status: (o) => (o.creada ? 201 : 200) },
  { method: 'post', path: '/marketing/keywords/:id/contenido', op: kwContenido, status: (o) => (o.creado ? 201 : 200) },
  { method: 'get', path: '/marketing/competidores', op: competidoresListar },
  { method: 'post', path: '/marketing/competidores', op: competidorCrear, status: 201 },
  { method: 'get', path: '/marketing/competidores/:id', op: competidorVer },
  { method: 'patch', path: '/marketing/competidores/:id', op: competidorActualizar },
  { method: 'get', path: '/marketing/competidores/:id/keywords', op: competidorKeywords },
  { method: 'get', path: '/marketing/contenidos', op: contenidosListar },
  { method: 'post', path: '/marketing/contenidos', op: contenidoCrear, status: 201 },
  { method: 'get', path: '/marketing/contenidos/:id', op: contenidoVer },
  { method: 'patch', path: '/marketing/contenidos/:id', op: contenidoActualizar },
  { method: 'post', path: '/marketing/contenidos/:id/mover', op: contenidoMover },
  { method: 'get', path: '/marketing/campanas', op: campanasVer },
]
