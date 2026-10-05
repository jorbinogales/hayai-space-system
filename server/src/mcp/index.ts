// Servidor MCP de HAYAI Space (Streamable HTTP, sin estado) montado en POST /mcp.
// Mismo X-API-Key que la API REST; cada herramienta llama a los MISMOS servicios que /api/v1 (no hay un segundo
// camino de datos ni un salto HTTP a si mismo), asi que validan y se atribuyen igual.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express, { Router } from 'express'
import type { SessionUser } from '../auth.ts'
import { exec, type Op } from '../services/common.ts'
import { clienteActualizar, clienteCrear, clientesListar, clienteVer, pagoMarcarCobrado, pagoRegistrar, pagosListar } from '../services/clientes.ts'
import { clienteEliminar, gastoEliminar, pagoEliminar, papeleraListar, papeleraRestaurar, proyectoEliminar, tareaEliminar } from '../services/papelera.ts'
import { finanzasResumen } from '../services/finanzas.ts'
import { gastoRegistrar, gastosListar } from '../services/gastos.ts'
import { proyectoActualizar, proyectoCrear, proyectoEstado, proyectosListar, proyectoVer } from '../services/proyectos.ts'
import { tareaCompletar, tareaCrear, tareasListar } from '../services/tareas.ts'
import { HttpError } from '../util.ts'
import { apiKeyAuth, keyRateLimit, type Scope } from '../v1/apiKey.ts'
import { apiErrors, jsonOnly } from '../v1/index.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tool = { name: string; description: string; op: Op<any, any>; scope: Scope }

const TOOLS: Tool[] = [
  { name: 'hayai_clientes_listar', op: clientesListar, scope: 'read', description: 'Lista clientes (paginado). estado: activo | posible (posible = aún no firmó). Cada cliente trae recaudado, por_cobrar y proximo_pago; meta.resumen trae los totales de la cabecera de Clientes.' },
  { name: 'hayai_cliente_ver', op: clienteVer, scope: 'read', description: 'Detalle de un cliente: resumen, ítems de la inicial, movimientos (inicial y cuotas, cobradas y pendientes) y proyectos.' },
  { name: 'hayai_cliente_crear', op: clienteCrear, scope: 'write', description: 'Crea un cliente activo. items = desglose de la inicial (se registra cobrada en fecha_inicial, por defecto hoy); cobros = cuotas pendientes, con repetir_meses (2-36) para un pago mensual. No existe campo de contacto (teléfono/email): el sistema no lo guarda.' },
  { name: 'hayai_cliente_actualizar', op: clienteActualizar, scope: 'write', description: 'Cambia nombre, avatar, estado (activo | posible) o archivado de un cliente. archivado=true lo oculta de las pantallas de trabajo conservando su historial y sus números en Finanzas; false lo recupera.' },
  { name: 'hayai_proyectos_listar', op: proyectosListar, scope: 'read', description: 'Lista proyectos (paginado). estado: activo | entrega | visita (visita = por visitar). Trae el avance de tareas (total/completadas).' },
  { name: 'hayai_proyecto_ver', op: proyectoVer, scope: 'read', description: 'Detalle de un proyecto con su lista de tareas.' },
  { name: 'hayai_proyecto_crear', op: proyectoCrear, scope: 'write', description: 'Crea un proyecto para un cliente existente. Por defecto: icono "box", estado "visita" y responsable = el socio dueño de la llave.' },
  { name: 'hayai_proyecto_estado', op: proyectoEstado, scope: 'write', description: 'Cambia el estado de un proyecto: activo | entrega | visita.' },
  { name: 'hayai_gastos_listar', op: gastosListar, scope: 'read', description: 'Lista gastos (paginado), más recientes primero. Filtros: desde, hasta (AAAA-MM-DD), categoria, ambito. meta.total_monto es la suma de TODO el filtro, no solo de la página.' },
  { name: 'hayai_gasto_registrar', op: gastoRegistrar, scope: 'write', description: 'Registra un gasto en USD. ambito: general (por defecto) | cliente | proyecto; los dos últimos exigen referencia_id. fecha por defecto: hoy (hora de Caracas).' },
  { name: 'hayai_finanzas_resumen', op: finanzasResumen, scope: 'read', description: 'Resumen financiero. periodo: mes (por defecto) | anio | todo. Devuelve ingresos (cobrado), gastos, balance, por_cobrar del periodo, por_cobrar_total, tabla por cliente y serie de 6 meses.' },
  { name: 'hayai_tareas_listar', op: tareasListar, scope: 'read', description: 'Lista tareas (paginado). estado: pendiente | completada. Opcional proyecto_id. Las tareas siempre pertenecen a un proyecto.' },
  { name: 'hayai_tarea_crear', op: tareaCrear, scope: 'write', description: 'Crea una tarea dentro de un proyecto (proyecto_id es obligatorio). vence opcional (AAAA-MM-DD).' },
  { name: 'hayai_tarea_completar', op: tareaCompletar, scope: 'write', description: 'Marca una tarea como completada.' },
  // Pagos: no estaban en el SPEC original, pero sin ellos no se puede mover lo recaudado.
  { name: 'hayai_pagos_listar', op: pagosListar, scope: 'read', description: 'Lista cobros ordenados por fecha. estado: pendiente | cobrado; filtros cliente_id, desde, hasta. Con estado=pendiente son los próximos cobros; "vencido" marca los que ya pasaron de fecha. meta.total_monto suma todo el filtro.' },
  { name: 'hayai_pago_registrar', op: pagoRegistrar, scope: 'write', description: 'Agrega un cobro a un cliente (pendiente por defecto). repetir_meses (2-36) crea un pago mensual como serie de cuotas pendientes.' },
  { name: 'hayai_pago_marcar_cobrado', op: pagoMarcarCobrado, scope: 'write', description: 'Marca un cobro (cuota) como cobrado. No aplica a la inicial.' },
  { name: 'hayai_proyecto_actualizar', op: proyectoActualizar, scope: 'write', description: 'Edita un proyecto: nombre, icono, cliente, responsable, estado, entrega (null borra la fecha) o archivado (true lo oculta de las pantallas de trabajo conservando su historial; false lo recupera).' },
  // Papelera: borrar nunca destruye, manda a la papelera 30 días y se puede restaurar.
  { name: 'hayai_papelera_listar', op: papeleraListar, scope: 'read', description: 'Lista lo que hay en la papelera (borrado en los últimos 30 días), con quién lo borró y hasta cuándo se puede restaurar.' },
  { name: 'hayai_papelera_restaurar', op: papeleraRestaurar, scope: 'write', description: 'Restaura algo de la papelera con su id de papelera (con todo lo que colgaba de ello). Falla si lo que lo contenía (p. ej. el cliente de un proyecto) sigue borrado: restaura eso primero.' },
  { name: 'hayai_cliente_eliminar', op: clienteEliminar, scope: 'delete', description: 'Manda un cliente A LA PAPELERA junto con TODO lo suyo: cobros, proyectos, tareas y gastos. Se puede restaurar 30 días con hayai_papelera_restaurar.' },
  { name: 'hayai_proyecto_eliminar', op: proyectoEliminar, scope: 'delete', description: 'Manda un proyecto a la papelera con sus tareas y gastos. Restaurable 30 días.' },
  { name: 'hayai_pago_eliminar', op: pagoEliminar, scope: 'delete', description: 'Manda un cobro a la papelera (la inicial no se puede borrar: se edita desde sus ítems). Restaurable 30 días.' },
  { name: 'hayai_gasto_eliminar', op: gastoEliminar, scope: 'delete', description: 'Manda un gasto a la papelera. Restaurable 30 días.' },
  { name: 'hayai_tarea_eliminar', op: tareaEliminar, scope: 'delete', description: 'Manda una tarea a la papelera. Restaurable 30 días.' },
]

const INSTRUCTIONS =
  'HAYAI Space: sistema interno de HAYAI (clientes, cobros, proyectos, gastos, tareas, finanzas). ' +
  'Montos en USD como número; fechas AAAA-MM-DD; zona horaria de Caracas. ' +
  'Lo que se escriba queda atribuido al socio dueño de la llave de API. Solo ves las herramientas que los permisos de tu llave permiten (lectura, escritura, borrado). Borrar manda a la papelera 30 días: nada se pierde al instante.'

function buildServer(actor: SessionUser) {
  const server = new McpServer({ name: 'hayai-space', version: '1.0.0' }, { instructions: INSTRUCTIONS })
  // Solo se ofrecen las herramientas que los permisos de la llave permiten: el agente no ve lo que no puede usar.
  for (const t of TOOLS.filter((x) => actor.scopes?.includes(x.scope))) {
    server.registerTool(
      t.name,
      {
        description: t.description,
        inputSchema: t.op.schema.shape,
        annotations: { readOnlyHint: t.scope === 'read', destructiveHint: t.scope === 'delete' },
      },
      async (args: unknown) => {
        try {
          const data = await exec(t.op, actor, args)
          return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
        } catch (e) {
          // Los errores de negocio (validación, 404...) vuelven como resultado de la herramienta para que el agente los lea y corrija.
          if (e instanceof HttpError) return { isError: true, content: [{ type: 'text' as const, text: e.message }] }
          console.error(e)
          return { isError: true, content: [{ type: 'text' as const, text: 'Error interno del servidor' }] }
        }
      },
    )
  }
  return server
}

export const mcpRouter = Router()

// Sin estado: no hay sesiones MCP ni stream de servidor, asi que GET/DELETE no aplican.
mcpRouter.all('/', (req, res, next) => {
  if (req.method === 'POST') return next()
  res.setHeader('Allow', 'POST')
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null })
})

mcpRouter.post('/', apiKeyAuth, keyRateLimit(), jsonOnly, express.json({ limit: '100kb' }), async (req, res) => {
  const server = buildServer(req.user!)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
})

mcpRouter.use(apiErrors)
