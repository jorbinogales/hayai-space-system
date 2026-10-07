// Servidor MCP de HAYAI Space (Streamable HTTP, sin estado) montado en POST /mcp.
// Mismo X-API-Key que la API REST; cada herramienta llama a los MISMOS servicios que /api/v1 (no hay un segundo
// camino de datos ni un salto HTTP a si mismo), asi que validan y se atribuyen igual.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express, { Router } from 'express'
import type { SessionUser } from '../auth.ts'
import { exec, type Op } from '../services/common.ts'
import { clienteActualizar, clienteCrear, clientesListar, clienteVer, pagoMarcarCobrado, pagoRegistrar, pagosListar } from '../services/clientes.ts'
import { notificacionesLeer, notificacionesListar, pipelineResumen } from '../services/alertas.ts'
import { actividadLeer, actividadListar } from '../services/actividad.ts'
import { buscar } from '../services/buscar.ts'
import { interaccionActualizar, interaccionesListar, interaccionRegistrar } from '../services/interacciones.ts'
import { clienteEliminar, gastoEliminar, interaccionEliminar, pagoEliminar, papeleraListar, papeleraRestaurar, proyectoEliminar, tareaEliminar } from '../services/papelera.ts'
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
  { name: 'hayai_clientes_listar', op: clientesListar, scope: 'read', description: 'Lista clientes (paginado). estado: activo | posible (posible = aún no firmó); etapa: prospecto | visita_agendada | visita_realizada | propuesta_en_armado | propuesta_presentada | ganado | perdido (los nombres de la fase 1 se aceptan como alias). Cada cliente trae recaudado, por_cobrar, proximo_pago, cuotas_vencidas/monto_vencido, ficha básica (telefono, email, etiquetas, origen), pipeline (etapa, valor_estimado, probabilidad, valor_ponderado, dias_en_etapa, frio) y seguimiento (proxima_accion, proxima_accion_fecha, seguimiento_vencido); meta.resumen trae los totales de la cabecera de Clientes.' },
  { name: 'hayai_cliente_ver', op: clienteVer, scope: 'read', description: 'Detalle de un cliente: resumen, ficha completa (contacto, dirección, notas), pipeline, seguimiento, ítems de la inicial, movimientos (inicial y cuotas, cobradas y pendientes), proyectos y las 10 interacciones más recientes de su bitácora.' },
  { name: 'hayai_cliente_crear', op: clienteCrear, scope: 'write', description: 'Crea un cliente (estado activo por defecto) o un posible cliente (estado "posible": entra al pipeline en la etapa "nuevo", o en otra abierta si pasas etapa). items = desglose de la inicial (se registra cobrada en fecha_inicial, por defecto hoy); cobros = cuotas pendientes, con repetir_meses (2-36) para un pago mensual. Acepta la ficha: telefono, email, contacto_nombre, contacto_cargo, direccion, notas, etiquetas (máx. 10), origen (referido | instagram | whatsapp | facebook | meta_ads | web | visita_frio | evento | otro) y, solo para posibles, valor_estimado (USD), probabilidad, cierre_previsto; más proxima_accion y proxima_accion_fecha.' },
  { name: 'hayai_cliente_actualizar', op: clienteActualizar, scope: 'write', description: 'Edita un cliente: nombre, avatar, estado (activo = ganado | posible = vuelve al pipeline en "prospecto"), archivado y la ficha (telefono, email, contacto_nombre, contacto_cargo, direccion, notas, etiquetas, origen). En un posible cliente también etapa (prospecto | visita_agendada | visita_realizada | propuesta_en_armado | propuesta_presentada | ganado | perdido), valor_estimado, probabilidad, cierre_previsto y motivo_perdida. Reglas: ganado exige fecha_implementacion (y esquema_cobro si hay propuesta vigente), fija la probabilidad en 100 y perdido en 0; perdido exige motivo_perdida; cada cambio de etapa queda en la bitácora. proxima_accion + proxima_accion_fecha programan el seguimiento. null borra un campo; omitirlo lo deja igual. archivado=true lo oculta de las pantallas de trabajo conservando su historial y sus números en Finanzas.' },
  { name: 'hayai_proyectos_listar', op: proyectosListar, scope: 'read', description: 'Lista proyectos (paginado). estado: activo | entrega | visita (visita = por visitar). Trae el avance de tareas (total/completadas).' },
  { name: 'hayai_proyecto_ver', op: proyectoVer, scope: 'read', description: 'Detalle de un proyecto con su lista de tareas.' },
  { name: 'hayai_proyecto_crear', op: proyectoCrear, scope: 'write', description: 'Crea un proyecto para un cliente existente. Por defecto: icono "box", estado "visita" y responsable = el socio dueño de la llave.' },
  { name: 'hayai_proyecto_estado', op: proyectoEstado, scope: 'write', description: 'Cambia el estado de un proyecto: activo | entrega | visita.' },
  { name: 'hayai_gastos_listar', op: gastosListar, scope: 'read', description: 'Lista gastos (paginado), más recientes primero. Filtros: desde, hasta (AAAA-MM-DD), categoria, ambito. meta.total_monto es la suma de TODO el filtro, no solo de la página.' },
  { name: 'hayai_gasto_registrar', op: gastoRegistrar, scope: 'write', description: 'Registra un gasto en USD. ambito: general (por defecto) | cliente | proyecto; los dos últimos exigen referencia_id. fecha por defecto: hoy (hora de Caracas).' },
  { name: 'hayai_finanzas_resumen', op: finanzasResumen, scope: 'read', description: 'Resumen financiero. periodo: mes (por defecto) | anio | todo. Devuelve ingresos (cobrado), gastos, balance, por_cobrar del periodo, por_cobrar_total, vencido (la parte de por_cobrar que ya pasó de fecha) y vencido_total, tabla por cliente y serie de 6 meses.' },
  { name: 'hayai_tareas_listar', op: tareasListar, scope: 'read', description: 'Lista tareas (paginado). estado: pendiente | completada. Opcional proyecto_id. Las tareas siempre pertenecen a un proyecto.' },
  { name: 'hayai_tarea_crear', op: tareaCrear, scope: 'write', description: 'Crea una tarea dentro de un proyecto (proyecto_id es obligatorio). vence opcional (AAAA-MM-DD).' },
  { name: 'hayai_tarea_completar', op: tareaCompletar, scope: 'write', description: 'Marca una tarea como completada.' },
  // Pagos: no estaban en el SPEC original, pero sin ellos no se puede mover lo recaudado.
  { name: 'hayai_pagos_listar', op: pagosListar, scope: 'read', description: 'Lista cobros ordenados por fecha. estado: pendiente | cobrado; filtros cliente_id, desde, hasta. Con estado=pendiente son los próximos cobros; "vencido" marca los que ya pasaron de fecha y vencido=true los filtra (solo lo pendiente con fecha anterior a hoy). meta.total_monto suma todo el filtro.' },
  { name: 'hayai_pago_registrar', op: pagoRegistrar, scope: 'write', description: 'Agrega un cobro a un cliente (pendiente por defecto). repetir_meses (2-36) crea un pago mensual como serie de cuotas pendientes.' },
  { name: 'hayai_pago_marcar_cobrado', op: pagoMarcarCobrado, scope: 'write', description: 'Marca un cobro (cuota) como cobrado. No aplica a la inicial.' },
  { name: 'hayai_proyecto_actualizar', op: proyectoActualizar, scope: 'write', description: 'Edita un proyecto: nombre, icono, cliente, responsable, estado, entrega (null borra la fecha) o archivado (true lo oculta de las pantallas de trabajo conservando su historial; false lo recupera).' },
  // CRM: bitácora, pipeline, alertas y búsqueda.
  { name: 'hayai_interacciones_listar', op: interaccionesListar, scope: 'read', description: 'Bitácora de un cliente (paginada, lo más reciente primero): llamadas, visitas, WhatsApp y notas, más las entradas automáticas de cambio de etapa (automatica=true, con cambio {de, a, motivo}). Filtro opcional tipo.' },
  { name: 'hayai_interaccion_registrar', op: interaccionRegistrar, scope: 'write', description: 'Anota una interacción en la bitácora de un cliente. tipo: llamada | visita | whatsapp | nota ("etapa" lo escribe solo el sistema y se rechaza). resumen: qué pasó. fecha opcional (AAAA-MM-DD o con hora y zona; por defecto ahora; no puede ser futura: lo que viene va en proxima_accion).' },
  { name: 'hayai_interaccion_actualizar', op: interaccionActualizar, scope: 'write', description: 'Corrige el tipo, el resumen o la fecha de una interacción. Las de etapa (automáticas) no se editan.' },
  { name: 'hayai_pipeline_resumen', op: pipelineResumen, scope: 'read', description: 'Resumen del pipeline de ventas: por etapa abierta (prospecto, visita_agendada, visita_realizada, propuesta_en_armado, propuesta_presentada) cantidad, valor_total y valor_ponderado (valor x probabilidad); abiertos, ganados y perdidos; frios (posibles clientes sin contacto real hace más de 14 días) y seguimientos_vencidos.' },
  { name: 'hayai_notificaciones_listar', op: notificacionesListar, scope: 'read', description: 'Alertas vigentes del socio dueño de la llave: cuotas vencidas y seguimientos de hoy o atrasados (se derivan al consultar: pagar o reprogramar las quita). estado: todas | sin_leer; tipo: cuota_vencida | seguimiento. meta.sin_leer es lo que muestra la campana.' },
  { name: 'hayai_notificaciones_marcar_leidas', op: notificacionesLeer, scope: 'write', description: 'Marca alertas como leídas para el socio dueño de la llave: claves (las de hayai_notificaciones_listar) o todas=true.' },
  { name: 'hayai_actividad_listar', op: actividadListar, scope: 'read', description: 'Actividad del equipo: clientes nuevos, posibles clientes nuevos, tareas nuevas, tareas completadas, cobros cobrados, cambios de etapa, clientes ganados y perdidos, con el texto ya redactado ("Leandro añadió la tarea «X» en Y") y el socio que lo hizo. Lo más reciente primero. Para consultar solo lo nuevo desde la última vez: orden=asc y desde_id=<meta.ultimo_id que guardaste>. meta.sin_leer cuenta lo de otros socios posterior al "visto hasta" del dueño de la llave.' },
  { name: 'hayai_actividad_marcar_leida', op: actividadLeer, scope: 'write', description: 'Mueve el "visto hasta" de la actividad del dueño de la llave: hasta_id (nunca retrocede) o todas=true.' },
  { name: 'hayai_buscar', op: buscar, scope: 'read', description: 'Búsqueda global sin importar acentos ni mayúsculas, por palabras. Busca en clientes (nombre, teléfono, email, contacto, dirección, etiquetas, notas), proyectos y tareas. tipo opcional (cliente | proyecto | tarea); archivados: excluir (por defecto) | incluir | solo; limite por tipo (máx. 25).' },
  // Papelera: borrar nunca destruye, manda a la papelera 30 días y se puede restaurar.
  { name: 'hayai_papelera_listar', op: papeleraListar, scope: 'read', description: 'Lista lo que hay en la papelera (borrado en los últimos 30 días), con quién lo borró y hasta cuándo se puede restaurar.' },
  { name: 'hayai_papelera_restaurar', op: papeleraRestaurar, scope: 'write', description: 'Restaura algo de la papelera con su id de papelera (con todo lo que colgaba de ello). Falla si lo que lo contenía (p. ej. el cliente de un proyecto) sigue borrado: restaura eso primero.' },
  { name: 'hayai_cliente_eliminar', op: clienteEliminar, scope: 'delete', description: 'Manda un cliente A LA PAPELERA junto con TODO lo suyo: cobros, proyectos, tareas y gastos. Se puede restaurar 30 días con hayai_papelera_restaurar.' },
  { name: 'hayai_proyecto_eliminar', op: proyectoEliminar, scope: 'delete', description: 'Manda un proyecto a la papelera con sus tareas y gastos. Restaurable 30 días.' },
  { name: 'hayai_pago_eliminar', op: pagoEliminar, scope: 'delete', description: 'Manda un cobro a la papelera (la inicial no se puede borrar: se edita desde sus ítems). Restaurable 30 días.' },
  { name: 'hayai_gasto_eliminar', op: gastoEliminar, scope: 'delete', description: 'Manda un gasto a la papelera. Restaurable 30 días.' },
  { name: 'hayai_tarea_eliminar', op: tareaEliminar, scope: 'delete', description: 'Manda una tarea a la papelera. Restaurable 30 días.' },
  { name: 'hayai_interaccion_eliminar', op: interaccionEliminar, scope: 'delete', description: 'Manda una interacción de la bitácora a la papelera (las automáticas de etapa no se borran). Restaurable 30 días.' },
]

const INSTRUCTIONS =
  'HAYAI Space: sistema interno de HAYAI (clientes y posibles clientes con su pipeline de ventas y bitácora, cobros, proyectos, gastos, tareas, finanzas, alertas y búsqueda). ' +
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
