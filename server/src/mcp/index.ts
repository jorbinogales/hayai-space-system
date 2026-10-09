// Servidor MCP de HAYAI Space (Streamable HTTP, sin estado) montado en POST /mcp.
// Mismo X-API-Key que la API REST; cada herramienta llama a los MISMOS servicios que /api/v1 (no hay un segundo
// camino de datos ni un salto HTTP a si mismo), asi que validan y se atribuyen igual.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express, { Router } from 'express'
import { z } from 'zod'
import { withExpected } from '../concurrency.ts'
import type { SessionUser } from '../auth.ts'
import { exec, type Op } from '../services/common.ts'
import { clienteActualizar, clienteCrear, clientesListar, clienteVer, pagoActualizar, pagoMarcarCobrado, pagoRegistrar, pagosListar } from '../services/clientes.ts'
import { notificacionesLeer, notificacionesListar, pipelineEtapas, pipelineResumen } from '../services/alertas.ts'
import { actividadLeer, actividadListar } from '../services/actividad.ts'
import { buscar } from '../services/buscar.ts'
import { chatBorrar, chatEditar, chatListar, chatMarcarLeido, chatPublicar, chatUsuarios } from '../services/chat.ts'
import { feedBorrar, feedConvertir, feedDeshacer, feedGuardar, feedListar, feedMarcar, feedPublicar } from '../services/feed.ts'
import { interaccionActualizar, interaccionesListar, interaccionRegistrar } from '../services/interacciones.ts'
import { checklistEliminar, clienteEliminar, gastoEliminar, hitoEliminar, interaccionEliminar, pagoEliminar, papeleraListar, papeleraRestaurar, proyectoEliminar, tareaEliminar } from '../services/papelera.ts'
import { comprobanteDetectar, comprobanteSubir, comprobanteVer, pagoVer, receptorEliminar, receptorGuardar, receptoresListar } from '../services/cobros.ts'
import { acuerdoActualizar, acuerdoCrear, acuerdosListar, equipoActualizar, equipoVer, hubVer, marketingEmbudo } from '../services/hub.ts'
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
} from '../services/marketing.ts'
import { currentVersionString, versionesListar, versionHeader, versionPublicar, versionVer } from '../services/versiones.ts'
import { sistemaActualizar, sistemaCrear, sistemasListar, sistemaVer, sistemaVerificar } from '../services/sistemas.ts'
import { finanzasResumen } from '../services/finanzas.ts'
import { gastoRegistrar, gastosListar } from '../services/gastos.ts'
import { checklistActualizar, checklistAgregar, checklistOrdenar, hitoActualizar, hitoCrear, hitosOrdenar, proyectoActualizar, proyectoCrear, proyectoEstado, proyectosListar, proyectoVer } from '../services/proyectos.ts'
import { ofertaActualizar, ofertaCrear, ofertaDesactivar, ofertasListar, propuestaActualizar, propuestaCrear, propuestasListar, propuestaVer } from '../services/propuestas.ts'
import { tareaActualizar, tareaCompletar, tareaCrear, tareasListar } from '../services/tareas.ts'
import { HttpError } from '../util.ts'
import { apiKeyAuth, keyRateLimit, type Scope } from '../v1/apiKey.ts'
import { apiErrors, jsonOnly } from '../v1/index.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tool = { name: string; description: string; op: Op<any, any>; scope: Scope }

const TOOLS: Tool[] = [
  { name: 'hayai_clientes_listar', op: clientesListar, scope: 'read', description: 'Lista clientes (paginado). estado: activo | posible (posible = aún no firmó); etapa: prospecto | visita_agendada | visita_realizada | propuesta_en_armado | propuesta_presentada | ganado | perdido (los nombres de la fase 1 se aceptan como alias). Cada cliente trae recaudado, por_cobrar, proximo_pago, cuotas_vencidas/monto_vencido, ficha básica (telefono, email, etiquetas, origen, redes, fecha_implementacion), pipeline (etapa, valor_estimado, probabilidad, valor_ponderado, dias_en_etapa, frio) y seguimiento (proxima_accion, proxima_accion_fecha, seguimiento_vencido); meta.resumen trae los totales de la cabecera de Clientes.' },
  { name: 'hayai_cliente_ver', op: clienteVer, scope: 'read', description: 'Detalle de un cliente: resumen, ficha completa (contacto, dirección, notas), pipeline, seguimiento, ítems de la inicial, movimientos (inicial y cuotas, cobradas y pendientes), proyectos, la propuesta vigente (con mensualidad y extras) y las 10 interacciones más recientes de su bitácora.' },
  { name: 'hayai_cliente_crear', op: clienteCrear, scope: 'write', description: 'Crea un cliente (estado activo por defecto) o un posible cliente (estado "posible": entra al pipeline en la etapa "prospecto", o en otra abierta si pasas etapa; no se crea directo en propuesta_presentada). items = desglose de la inicial (se registra cobrada en fecha_inicial, por defecto hoy); cobros = cuotas pendientes, con repetir_meses (2-36) para un pago mensual. Acepta la ficha: telefono, email, contacto_nombre, contacto_cargo, direccion, notas, etiquetas (máx. 10), redes ([{red, url}]; red: instagram | tiktok | facebook | x | youtube | linkedin | web | otra; en instagram, tiktok y x vale @usuario), fecha_implementacion, origen (referido | instagram | whatsapp | facebook | meta_ads | web | visita_frio | evento | otro) y, solo para posibles, valor_estimado (USD), probabilidad, cierre_previsto; más proxima_accion y proxima_accion_fecha.' },
  { name: 'hayai_cliente_actualizar', op: clienteActualizar, scope: 'write', description: 'Edita un cliente: nombre, avatar, estado (activo = ganado | posible = vuelve al pipeline en "prospecto"), archivado y la ficha (telefono, email, contacto_nombre, contacto_cargo, direccion, notas, etiquetas, redes, fecha_implementacion, origen). En un posible cliente también etapa (prospecto | visita_agendada | visita_realizada | propuesta_en_armado | propuesta_presentada | ganado | perdido), valor_estimado, probabilidad, cierre_previsto y motivo_perdida. Reglas: ganado exige fecha_implementacion (y esquema_cobro si hay propuesta vigente), fija la probabilidad en 100 y perdido en 0; perdido exige motivo_perdida; propuesta_presentada exige una propuesta armada (la marca presentada); en visita_agendada, fecha_visita crea la tarea de visita; en visita_realizada, resumen_visita queda en la bitácora; al ganar con propuesta vigente, esquema_cobro {inicio_cobro, meses (2-36, def. 12), unicos_cobrados} genera las mensualidades y los pagos únicos; cada cambio de etapa queda en la bitácora. valor_estimado sale de la mensualidad de la propuesta vigente (no se edita si hay propuesta). proxima_accion + proxima_accion_fecha programan el seguimiento. null borra un campo; omitirlo lo deja igual. archivado=true lo oculta de las pantallas de trabajo conservando su historial y sus números en Finanzas.' },
  { name: 'hayai_proyectos_listar', op: proyectosListar, scope: 'read', description: 'Lista proyectos (paginado). estado: activo | entrega | visita (visita = por visitar) | pausado | completado | entregado. Filtros cliente_id y sin_cliente=true (proyectos internos). Trae el avance de tareas, hitos y checklist.' },
  { name: 'hayai_proyecto_ver', op: proyectoVer, scope: 'read', description: 'Detalle de un proyecto: descripción, lista de tareas (con hito_id), hitos (roadmap con su avance) y checklist de accionables.' },
  { name: 'hayai_proyecto_crear', op: proyectoCrear, scope: 'write', description: 'Crea un proyecto, con cliente (cliente_id) o interno (sin cliente). descripcion opcional. Por defecto: icono "box", estado "visita" y responsable = el socio dueño de la llave.' },
  { name: 'hayai_proyecto_estado', op: proyectoEstado, scope: 'write', description: 'Cambia el estado de un proyecto: activo | entrega | visita | pausado | completado | entregado (entregado = terminal pero visible; ya no se marca como vencido).' },
  { name: 'hayai_gastos_listar', op: gastosListar, scope: 'read', description: 'Lista gastos (paginado), más recientes primero. Filtros: desde, hasta (AAAA-MM-DD), categoria, ambito. meta.total_monto es la suma de TODO el filtro, no solo de la página.' },
  { name: 'hayai_gasto_registrar', op: gastoRegistrar, scope: 'write', description: 'Registra un gasto en USD. ambito: general (por defecto) | cliente | proyecto; los dos últimos exigen referencia_id. fecha por defecto: hoy (hora de Caracas).' },
  { name: 'hayai_finanzas_resumen', op: finanzasResumen, scope: 'read', description: 'Resumen financiero. periodo: mes (por defecto) | anio | todo. Devuelve ingresos (cobrado), gastos, balance, por_cobrar del periodo, por_cobrar_total, vencido (la parte de por_cobrar que ya pasó de fecha) y vencido_total, tabla por cliente y serie de 6 meses.' },
  { name: 'hayai_tareas_listar', op: tareasListar, scope: 'read', description: 'Lista tareas (paginado). estado: pendiente | completada. Opcional proyecto_id y hito_id. Las tareas siempre pertenecen a un proyecto.' },
  { name: 'hayai_tarea_crear', op: tareaCrear, scope: 'write', description: 'Crea una tarea dentro de un proyecto (proyecto_id es obligatorio). vence opcional (AAAA-MM-DD); hito_id opcional (debe ser un hito del mismo proyecto).' },
  { name: 'hayai_tarea_actualizar', op: tareaActualizar, scope: 'write', description: 'Edita una tarea: titulo, estado (pendiente | completada), vence (null borra la fecha) y hito_id (null la suelta del hito).' },
  { name: 'hayai_tarea_completar', op: tareaCompletar, scope: 'write', description: 'Marca una tarea como completada.' },
  // Pagos: no estaban en el SPEC original, pero sin ellos no se puede mover lo recaudado.
  { name: 'hayai_pagos_listar', op: pagosListar, scope: 'read', description: 'Lista cobros ordenados por fecha. estado: pendiente | cobrado; filtros cliente_id, desde, hasta. Con estado=pendiente son los próximos cobros; "vencido" marca los que ya pasaron de fecha y vencido=true los filtra (solo lo pendiente con fecha anterior a hoy). meta.total_monto suma todo el filtro.' },
  { name: 'hayai_pago_registrar', op: pagoRegistrar, scope: 'write', description: 'Agrega un cobro a un cliente (pendiente por defecto). repetir_meses (2-36) crea un pago mensual como serie de cuotas pendientes.' },
  { name: 'hayai_pago_marcar_cobrado', op: pagoMarcarCobrado, scope: 'write', description: 'Marca un cobro (cuota) como cobrado. No aplica a la inicial.' },
  { name: 'hayai_proyecto_actualizar', op: proyectoActualizar, scope: 'write', description: 'Edita un proyecto: nombre, descripcion (null la borra), icono, cliente (cliente_id; null lo vuelve interno), responsable, estado, entrega (null borra la fecha) o archivado (true lo oculta de las pantallas de trabajo conservando su historial; false lo recupera).' },
  // Roadmap y checklist del proyecto.
  { name: 'hayai_hito_crear', op: hitoCrear, scope: 'write', description: 'Agrega un hito (roadmap) a un proyecto, al final: titulo, vence opcional (AAAA-MM-DD), estado pendiente (defecto) | en_curso | hecho.' },
  { name: 'hayai_hito_actualizar', op: hitoActualizar, scope: 'write', description: 'Edita un hito: titulo, vence (null borra la fecha) o estado (pendiente | en_curso | hecho).' },
  { name: 'hayai_hitos_ordenar', op: hitosOrdenar, scope: 'write', description: 'Reordena los hitos de un proyecto: ids con TODOS los hitos del proyecto en el orden nuevo.' },
  { name: 'hayai_checklist_agregar', op: checklistAgregar, scope: 'write', description: 'Agrega un accionable simple a la checklist de un proyecto (texto, hasta 200 caracteres).' },
  { name: 'hayai_checklist_actualizar', op: checklistActualizar, scope: 'write', description: 'Edita un elemento de la checklist: texto o hecho (true/false).' },
  { name: 'hayai_checklist_ordenar', op: checklistOrdenar, scope: 'write', description: 'Reordena la checklist de un proyecto: ids con TODOS los elementos en el orden nuevo.' },
  // Propuestas comerciales y catálogo de ofertas.
  { name: 'hayai_pipeline_etapas', op: pipelineEtapas, scope: 'read', description: 'Las etapas del pipeline con su probabilidad: prospecto 10, visita_agendada 20, visita_realizada 35, propuesta_en_armado 50, propuesta_presentada 70, ganado 100, perdido 0.' },
  { name: 'hayai_ofertas_listar', op: ofertasListar, scope: 'read', description: 'Catálogo de ofertas de HAYAI (Mostrador POS, El Chasis, Automatizaciones, Sistemas WhatsApp...) con precios sugeridos si los hay. Sirven de base para armar propuestas.' },
  { name: 'hayai_oferta_crear', op: ofertaCrear, scope: 'write', description: 'Agrega una oferta al catálogo: clave (minúscula, números, _), nombre, tipo (sistema | automatizacion | hardware | servicio), mensualidad_sugerida e instalacion_sugerida opcionales.' },
  { name: 'hayai_oferta_actualizar', op: ofertaActualizar, scope: 'write', description: 'Edita una oferta del catálogo (nombre, tipo, precios sugeridos, descripcion, activa). null quita un precio.' },
  { name: 'hayai_propuestas_listar', op: propuestasListar, scope: 'read', description: 'Propuestas de un posible cliente (todas las versiones, la más nueva primero) con sus ítems y totales (mensual y único).' },
  { name: 'hayai_propuesta_ver', op: propuestaVer, scope: 'read', description: 'Una propuesta con sus ítems: mensualidad base, extras mensuales y extras únicos, subtotales y totales.' },
  { name: 'hayai_propuesta_crear', op: propuestaCrear, scope: 'write', description: 'Arma una propuesta (versión nueva) para un posible cliente: items = exactamente una {tipo:"mensualidad"} + extras {tipo:"extra_mensual"|"extra_unico"}, cada uno con concepto, cantidad, precio_unitario (o oferta_id del catálogo para tomar nombre y precio sugerido). La versión anterior viva queda reemplazada. En un posible cliente, el valor_estimado pasa a ser la mensualidad; un cliente activo también puede tener propuesta (ampliación). feed_item_id opcional: enlaza la propuesta al ítem del feed del que nace (el ítem queda convertido y no se duplica).' },
  { name: 'hayai_propuesta_actualizar', op: propuestaActualizar, scope: 'write', description: 'Edita una propuesta en borrador o presentada: items (reemplaza todos) y/o notas. Una aceptada, rechazada o reemplazada no se edita: crea una versión nueva.' },
  // CRM: bitácora, pipeline, alertas y búsqueda.
  { name: 'hayai_interacciones_listar', op: interaccionesListar, scope: 'read', description: 'Bitácora de un cliente (paginada, lo más reciente primero): llamadas, visitas, WhatsApp y notas, más las entradas automáticas de cambio de etapa (automatica=true, con cambio {de, a, motivo}). Filtro opcional tipo.' },
  { name: 'hayai_interaccion_registrar', op: interaccionRegistrar, scope: 'write', description: 'Anota una interacción en la bitácora de un cliente. tipo: llamada | visita | whatsapp | nota ("etapa" lo escribe solo el sistema y se rechaza). resumen: qué pasó. fecha opcional (AAAA-MM-DD o con hora y zona; por defecto ahora; no puede ser futura: lo que viene va en proxima_accion).' },
  { name: 'hayai_interaccion_actualizar', op: interaccionActualizar, scope: 'write', description: 'Corrige el tipo, el resumen o la fecha de una interacción. Las de etapa (automáticas) no se editan.' },
  { name: 'hayai_pipeline_resumen', op: pipelineResumen, scope: 'read', description: 'Resumen del pipeline de ventas: por etapa abierta (prospecto, visita_agendada, visita_realizada, propuesta_en_armado, propuesta_presentada) cantidad, valor_total y valor_ponderado (valor x probabilidad); abiertos, ganados y perdidos; frios (posibles clientes sin contacto real hace más de 14 días) y seguimientos_vencidos.' },
  { name: 'hayai_notificaciones_listar', op: notificacionesListar, scope: 'read', description: 'Alertas vigentes del socio dueño de la llave: cuotas vencidas y seguimientos de hoy o atrasados (se derivan al consultar: pagar o reprogramar las quita). estado: todas | sin_leer; tipo: cuota_vencida | seguimiento | actualizacion | feed (ítems nuevos del feed de oportunidades). meta.sin_leer es lo que muestra la campana.' },
  { name: 'hayai_notificaciones_marcar_leidas', op: notificacionesLeer, scope: 'write', description: 'Marca alertas como leídas para el socio dueño de la llave: claves (las de hayai_notificaciones_listar) o todas=true.' },
  { name: 'hayai_actividad_listar', op: actividadListar, scope: 'read', description: 'Actividad del equipo: clientes nuevos, posibles clientes nuevos, tareas nuevas, tareas completadas, cobros cobrados, cambios de etapa, clientes ganados y perdidos, con el texto ya redactado ("Leandro añadió la tarea «X» en Y") y el socio que lo hizo. Lo más reciente primero. Para consultar solo lo nuevo desde la última vez: orden=asc y desde_id=<meta.ultimo_id que guardaste>. meta.sin_leer cuenta lo de otros socios posterior al "visto hasta" del dueño de la llave.' },
  { name: 'hayai_actividad_marcar_leida', op: actividadLeer, scope: 'write', description: 'Mueve el "visto hasta" de la actividad del dueño de la llave: hasta_id (nunca retrocede) o todas=true.' },
  { name: 'hayai_buscar', op: buscar, scope: 'read', description: 'Búsqueda global sin importar acentos ni mayúsculas, por palabras. Busca en clientes (nombre, teléfono, email, contacto, dirección, etiquetas, notas), proyectos y tareas. tipo opcional (cliente | proyecto | tarea); archivados: excluir (por defecto) | incluir | solo; limite por tipo (máx. 25).' },
  // Cobros: detalle completo, comprobante y mapeo de receptores.
  { name: 'hayai_pago_actualizar', op: pagoActualizar, scope: 'write', description: 'Edita un cobro: fecha, monto (USD, el campo principal de Finanzas), concepto, estado y el DETALLE de cómo entró: monto_bs (bolívares), tasa (Bs por USD; con monto y monto_bs se calcula sola, y si das uno de los dos se calcula el otro), fecha_tasa, referencia (bancaria; no se repite), banco_origen (vale "Bancrecer ****8017"), cuenta_origen_ultimos4, banco_destino, recibido_por (socio: Elis, Jorbi o Leandro), metodo (transferencia | pago_movil | efectivo | zelle | otro) y notas. null borra un dato. La inicial solo admite el detalle (su monto sale de sus ítems).' },
  { name: 'hayai_pago_ver', op: pagoVer, scope: 'read', description: 'Detalle de un cobro: monto USD, monto_bs, tasa y su fecha, referencia, bancos de origen (con últimos 4) y destino, recibido_por (y si lo asignó el comprobante), método, notas y si tiene comprobante.' },
  { name: 'hayai_comprobante_subir', op: comprobanteSubir, scope: 'write', description: 'Adjunta el comprobante (capture de la transferencia) a un cobro: imagen_base64 (PNG, JPEG o WebP, máx. 4 MB), nombre opcional y texto_ocr opcional (si ya leíste el texto de la imagen, pásalo y no se repite el OCR). Busca "DOCUMENTO V-..." y, si ese documento está en el mapeo, asigna recibido_por. Devuelve deteccion.estado: asignado | ya_asignado | difiere (el mapeo dice otro socio que el ya fijado; no se pisa) | sin_mapeo | no_detectado; con requiere_confirmacion=true pregunta a un socio quién recibió y fíjalo con hayai_pago_actualizar.' },
  { name: 'hayai_comprobante_ver', op: comprobanteVer, scope: 'read', description: 'Datos del comprobante de un cobro: nombre, tipo, tamaño, documento detectado (enmascarado) y el texto leído.' },
  { name: 'hayai_comprobante_detectar', op: comprobanteDetectar, scope: 'write', description: 'Vuelve a cruzar el documento ya leído del comprobante con el mapeo (úsalo después de agregar un documento al mapeo). No repite el OCR.' },
  { name: 'hayai_receptores_listar', op: receptoresListar, scope: 'read', description: 'Mapeo documento (cédula, enmascarada) -> socio que recibe los fondos. Se usa para asignar recibido_por al leer un comprobante.' },
  { name: 'hayai_receptor_guardar', op: receptorGuardar, scope: 'write', description: 'Agrega o cambia un documento del mapeo: documento (p. ej. V-12345678) y socio (Elis, Jorbi o Leandro).' },
  { name: 'hayai_receptor_eliminar', op: receptorEliminar, scope: 'delete', description: 'Quita un documento del mapeo por su id (de hayai_receptores_listar).' },
  // Barra superior: versión del sistema, tasa BCV e historial de versiones.
  { name: 'hayai_version_ver', op: versionVer, scope: 'read', description: 'Versión actual del sistema (p. ej. 1.5.0) con su título, resumen y cambios, y la tasa del dólar oficial BCV en Bs. con SU fecha (en fin de semana o feriado es la última publicada). Pasa desde=<la última versión que conocías> y devuelve en novedades qué cambió desde entonces (hay_cambios y las versiones nuevas): así te enteras de las actualizaciones sin que nadie te las cuente.' },
  { name: 'hayai_versiones_listar', op: versionesListar, scope: 'read', description: 'Historial de versiones (la más nueva primero), cada una con título, resumen, fecha, autor y la lista de cambios. Es el changelog del proyecto. Con desde=<versión> solo trae las posteriores a esa.' },
  { name: 'hayai_version_publicar', op: versionPublicar, scope: 'write', description: 'Publica una versión nueva en el historial: version (p. ej. 1.6.0, debe ser mayor que la actual), cambios (lista de textos, al menos uno), titulo, resumen y fecha (por defecto hoy) opcionales. El autor es el dueño de la llave. No se edita ni se borra después. Avisa al equipo.' },
  // Hub central (planeta HAYAI): lo interno de la empresa.
  { name: 'hayai_hub_ver', op: hubVer, scope: 'read', description: 'Hub central de HAYAI en una sola respuesta: pulso interno (gastos generales del mes, tareas internas pendientes y vencidas, proyectos internos activos), astronautas (Elis, Jorbi, Leandro con rol, responsabilidades y carga), bitácora interna, acuerdos abiertos, sistemas con su semáforo y el estado de la analítica.' },
  { name: 'hayai_equipo_ver', op: equipoVer, scope: 'read', description: 'Los socios con su rol, responsabilidades y carga de trabajo (tareas abiertas, vencidas, completadas en 7 días e internas). Una tarea es de quien tiene asignada o, sin asignar, del responsable de su proyecto.' },
  { name: 'hayai_equipo_actualizar', op: equipoActualizar, scope: 'write', description: 'Edita el rol y las responsabilidades de un socio (socio: Elis, Jorbi o Leandro). null borra un dato.' },
  { name: 'hayai_acuerdos_listar', op: acuerdosListar, scope: 'read', description: 'Acuerdos de la reunión semanal (abiertos primero). estado: abierto | cumplido | descartado.' },
  { name: 'hayai_acuerdo_crear', op: acuerdoCrear, scope: 'write', description: 'Registra un acuerdo de la reunión semanal: texto, fecha_reunion (por defecto hoy), responsable (socio, opcional) y vence (opcional). Avisa al equipo.' },
  { name: 'hayai_acuerdo_actualizar', op: acuerdoActualizar, scope: 'write', description: 'Edita un acuerdo o cámbiale el estado: cumplido o descartado lo cierra; abierto lo reabre. Los acuerdos no se borran.' },
  { name: 'hayai_sistemas_listar', op: sistemasListar, scope: 'read', description: 'Sistemas entregados a clientes con su semáforo (arriba | caido | desconocido), enlace, usuario de gestión (nunca contraseñas), datos del entorno y disponibilidad de 24 h. Filtros cliente_id, estado y activos. Los caídos salen primero.' },
  { name: 'hayai_sistema_ver', op: sistemaVer, scope: 'read', description: 'Un sistema con su estado de verificación actual.' },
  { name: 'hayai_sistema_crear', op: sistemaCrear, scope: 'write', description: 'Registra el sistema construido para un cliente: cliente_id, nombre, enlace, url_produccion, url_verificacion (por defecto la de producción o el enlace), repo, servidor, usuario_gestion (SIN contraseñas), notas y verificar (por defecto sí: se verifica cada ~10 minutos y avisa si cae).' },
  { name: 'hayai_sistema_actualizar', op: sistemaActualizar, scope: 'write', description: 'Edita un sistema (campos de hayai_sistema_crear; null borra un dato; activo=false lo oculta). Cambiar una URL reinicia su semáforo.' },
  { name: 'hayai_sistema_verificar', op: sistemaVerificar, scope: 'write', description: 'Verifica un sistema ahora (GET a su URL; 2xx/3xx = arriba). Un fallo se confirma con un segundo intento antes de declararlo caído.' },
  { name: 'hayai_marketing_embudo', op: marketingEmbudo, scope: 'read', description: 'Embudo del planeta Marketing: posibles clientes por etapa abierta con su valor mensual y ponderado, cierres (ganados, perdidos y tasa) de los últimos dias (7-365, def. 90), cohorte por origen y los leads de Meta Ads de 30 días.' },
  // Central de marketing (v1.7.5): keywords, competidores, contenido y campañas (solo lectura).
  { name: 'hayai_kw_investigar', op: kwInvestigar, scope: 'read', description: 'Investiga una palabra semilla con el autocompletado de Google (gratis, sin llave): devuelve sugerencias y preguntas tipo «la gente también pregunta», cada una con la intención sugerida (informacional | comercial | local | marca) y si ya está guardada. No guarda nada: usa hayai_kw_guardar con las que sirvan.' },
  { name: 'hayai_kw_guardar', op: kwGuardar, scope: 'write', description: 'Guarda una keyword (texto; intencion y fuente opcionales: autocompletado | serp | manual) o varias a la vez (items=[{texto, intencion?, fuente?}], hasta 100). Sin duplicados: si ya existe (sin importar mayúsculas ni acentos) devuelve la existente con creada=false (✓ Guardada). Estado inicial: por_atacar.' },
  { name: 'hayai_kw_listar', op: kwListar, scope: 'read', description: 'Keywords guardadas (paginado, más recientes primero). Filtros: q (busca en el texto), intencion, estado (por_atacar | en_contenido | posicionada | descartada) y fuente. meta.por_estado trae los conteos.' },
  { name: 'hayai_kw_ver', op: kwVer, scope: 'read', description: 'Una keyword con su último SERP consultado (posición, título, dominio y el competidor marcado si aparece) y las piezas de contenido vinculadas.' },
  { name: 'hayai_kw_actualizar', op: kwActualizar, scope: 'write', description: 'Cambia el estado (por_atacar | en_contenido | posicionada | descartada; descartar es estado=descartada), la intención o el texto de una keyword.' },
  { name: 'hayai_kw_serp_aviso', op: kwSerpAviso, scope: 'read', description: 'Antes de pedir el SERP real: devuelve el aviso «Esta consulta consume saldo de tu cuenta de Brightdata» con el costo estimado, si Brightdata está conectado y el último SERP guardado. No gasta nada.' },
  { name: 'hayai_kw_serp', op: kwSerp, scope: 'write', description: 'SERP real: top 10 de Google para la keyword vía Brightdata. CONSUME SALDO de Brightdata: sin confirmar_costo=true responde 409 con el costo estimado y no consulta nada. Guarda el resultado y marca los competidores que aparecen. Muéstrale el costo al usuario antes de confirmar.' },
  { name: 'hayai_kw_idea', op: kwIdea, scope: 'write', description: 'Crea una idea de contenido en el feed vinculada a la keyword, firmada por quien tiene la llave. Una sola por keyword (si ya existe, creada=false).' },
  { name: 'hayai_kw_contenido', op: kwContenido, scope: 'write', description: 'Mueve la keyword a contenido: crea una pieza en «Idea» (titulo, responsable, fecha_objetivo y notas opcionales; por defecto el responsable es quien tiene la llave) y pasa la keyword a «En contenido». Si ya tiene una pieza abierta, devuelve esa (creado=false).' },
  { name: 'hayai_competidores_listar', op: competidoresListar, scope: 'read', description: 'Competidores registrados a mano (paginado). Filtros: q y archivados (excluir | incluir | solo).' },
  { name: 'hayai_competidor_ver', op: competidorVer, scope: 'read', description: 'Un competidor con «lo que sabemos»: los hallazgos del espía de anuncios (feed, fuentes espia-…) que lo mencionan por nombre. Si no hay, la lista viene vacía.' },
  { name: 'hayai_competidor_crear', op: competidorCrear, scope: 'write', description: 'Registra un competidor. Solo nombre es obligatorio; web, instagram y notas son opcionales. La fecha de alta es la de hoy.' },
  { name: 'hayai_competidor_actualizar', op: competidorActualizar, scope: 'write', description: 'Edita un competidor (nombre, web, instagram, notas) o lo archiva/restaura con archivado=true|false.' },
  { name: 'hayai_competidor_keywords', op: competidorKeywords, scope: 'read', description: 'En qué keywords aparece el competidor según los SERP YA consultados (por su web o su Instagram). No consulta nada nuevo ni gasta saldo.' },
  { name: 'hayai_contenidos_listar', op: contenidosListar, scope: 'read', description: 'Tablero de contenido (Idea | En producción | Publicado), más cercano a vencer primero. Filtros: estado (idea | produccion | publicado), responsable, keyword_id, archivados. Cada pieza trae semaforo (vencida | proxima | en_plazo) mientras no esté publicada.' },
  { name: 'hayai_contenido_ver', op: contenidoVer, scope: 'read', description: 'Una pieza de contenido con su keyword, responsable, fecha objetivo y, si está publicada, dónde y el enlace.' },
  { name: 'hayai_contenido_crear', op: contenidoCrear, scope: 'write', description: 'Crea una pieza en «Idea»: titulo (obligatorio), keyword_id, responsable (por defecto quien tiene la llave), fecha_objetivo y notas.' },
  { name: 'hayai_contenido_actualizar', op: contenidoActualizar, scope: 'write', description: 'Edita una pieza (titulo, keyword_id, responsable, fecha_objetivo, notas; publicado_en y enlace solo si ya está publicada) o la archiva con archivado=true.' },
  { name: 'hayai_contenido_mover', op: contenidoMover, scope: 'write', description: 'Mueve la pieza en el tablero: estado = idea | produccion | publicado. Publicar EXIGE publicado_en (dónde se publicó) y enlace (http/https); sin ellos responde 400.' },
  { name: 'hayai_campanas_ver', op: campanasVer, scope: 'read', description: 'Campañas de Meta Ads en SOLO LECTURA: gasto, leads y costo por lead (CPL) de los últimos dias (7-90, def. 30) por campaña, con totales y filtro por cuenta. Si no hay credenciales en el servidor responde conectado=false con el motivo. Nada crea, edita ni pausa campañas.' },
  // Feed de oportunidades: lo que las máquinas y los agentes ENCONTRARON (la bitácora es lo que el equipo HIZO). Mismo servicio que POST /api/v1/feed.
  { name: 'hayai_feed_listar', op: feedListar, scope: 'read', description: 'Feed de oportunidades del planeta HAYAI (paginado, lo más reciente primero): ideas del radar, prospectos de Growi, alertas de competencia, noticias y propuestas manuales. Filtros: tipo (idea | prospecto | alerta | noticia | oportunidad | proyecto), estado (el que ve el socio dueño de la llave: nuevo | revisado | descartado | convertido), fuente (p. ej. growi, radar-hayai, muse-elis, manual), categoria (p. ej. restaurante, panaderia, salud; sin_categoria para los que no tienen), guardado=true (solo los que guardó este socio) y q (busca en título y resumen). Los ítems privados (visibilidad=privado) solo los ve quien los publicó; visibilidad=privado filtra a los míos. Revisado, descartado y guardado son PERSONALES de cada socio; convertido es global. Cada ítem trae mi_estado, guardado y datos (JSON libre: negocio, fugas, guion, contacto, origen_url, urls, métricas). meta.nuevos es el contador del hub; meta trae también guardados y los conteos por estado, tipo, fuente y categoría. Úsalo antes de publicar para no repetir lo que ya está.' },
  { name: 'hayai_feed_publicar', op: feedPublicar, scope: 'write', description: 'Publica en el feed de oportunidades. Un ítem: titulo (máx. 160), tipo, fuente (origen lógico en minúsculas: growi para lo que encuentra Growi, radar-hayai, muse-<socio>, manual), categoria opcional (restaurante, panaderia, salud, mercado, servicios…), resumen opcional (corto: dos frases), datos opcional (objeto JSON libre: negocio, fugas, guion, contacto {telefono, whatsapp, correo, web, instagram, facebook}, origen_url para noticias, urls, metricas, origen) y fecha opcional del hallazgo (no futura). clave_externa hace la publicación idempotente: la misma (fuente, clave_externa) no se duplica (devuelve el ítem existente con creado=false; si el ítem no tenía categoría, se la pone), así que reintentar es seguro; úsala siempre que la fuente tenga un id propio. Varios a la vez: items=[{…}] (hasta 50; una siembra de 20 negocios es una sola llamada). visibilidad opcional: equipo (por defecto, lo ven todos los socios) o privado (solo quien lo publica con su llave: no se lista ni avisa a nadie más; úsalo para clientes o asuntos personales de un socio). Quién publica se toma de la llave. Alerta, noticia y prospecto avisan en la campana (agrupados: un lote es un solo aviso).' },
  { name: 'hayai_feed_marcar', op: feedMarcar, scope: 'write', description: 'Marca un ítem del feed PARA EL SOCIO dueño de la llave: nuevo | revisado | descartado (motivo opcional y corto, solo al descartar). Es personal: no cambia lo que ven los demás socios. Un ítem ya convertido no cambia. "convertido" no se marca a mano: se logra con hayai_feed_convertir.' },
  { name: 'hayai_feed_guardar', op: feedGuardar, scope: 'write', description: 'Guarda (guardado=true, por defecto) o quita de guardados (guardado=false) un ítem del feed para el socio dueño de la llave. Es un marcador personal; hayai_feed_listar con guardado=true los trae.' },
  { name: 'hayai_feed_convertir', op: feedConvertir, scope: 'write', description: 'Convierte un ítem del feed en algo real. a=posible_cliente (solo si el ítem no está vinculado a un cliente: crea el posible cliente en "prospecto" pre-llenando nombre, origen, teléfono, correo y notas con lo que traiga el ítem: fugas, guion, enlaces; deja una nota en su bitácora), a=cliente (promueve a cliente activo al posible cliente vinculado: fecha_implementacion opcional, por defecto hoy; esquema_cobro {inicio_cobro, meses, unicos_cobrados} si tiene propuesta vigente), a=tarea (titulo y vence opcionales; responsable opcional: sin él es el socio dueño de la llave; proyecto_id opcional: sin él va al proyecto activo del cliente vinculado o al interno de HAYAI), a=seguimiento (tarea "Seguimiento: …" con vencimiento automático en 3 días) o a=proyecto (nombre, descripcion, cliente_id y responsable opcionales; hereda el cliente vinculado). Cada tipo se crea una sola vez por ítem (repetirlo da 409). Todo lo que pases pisa lo pre-llenado. Cada ítem expone vinculo {estado: sin_vinculo | posible_cliente | cliente, cliente_id, cliente} y creados {tarea, proyecto, propuesta, …} para saber qué ya existe. Se puede deshacer 2 minutos con hayai_feed_deshacer.' },
  { name: 'hayai_feed_borrar', op: feedBorrar, scope: 'delete', description: 'ELIMINA un ítem del feed (definitivo, no va a la papelera; lo ya creado desde él —cliente, tarea, proyecto— se conserva). Un ítem privado de otro socio no existe para ti: da 404. Úsalo para limpiar lo que no debía estar en el feed.' },
  { name: 'hayai_feed_deshacer', op: feedDeshacer, scope: 'write', description: 'Deshace una conversión reciente de un ítem del feed (a = posible_cliente | cliente | tarea | proyecto | seguimiento): manda a la papelera lo que se creó (o devuelve a posible cliente al cliente promovido) y el ítem vuelve a "nuevo". Solo quien lo convirtió y dentro de los 2 minutos siguientes. Con devolver=true (solo a=posible_cliente, mientras siga siendo posible cliente) se «devuelve al feed» sin límite de tiempo y por cualquier socio: el posible cliente va a la papelera (se puede restaurar) y el ítem queda nuevo.' },
  // Chat interno del equipo: un solo canal. Mismo servicio que /api/v1/chat.
  { name: 'hayai_chat_listar', op: chatListar, scope: 'read', description: 'Lee el chat interno del equipo (un solo canal de notas entre astronautas), el mensaje más reciente primero. Cada mensaje trae autor {id, nombre}, cuerpo, fuente, clave_externa, menciones [{id, nombre}], editado_el (null si nunca se editó), creado_el y actualizado_el. limite (1-100, def. 30). Para ir hacia atrás: pasa antes_de y antes_de_id con el creado_el y el id del mensaje MÁS VIEJO que ya tienes (meta.siguiente los trae; meta.hay_mas dice si quedan más). meta trae además sin_leer y menciones_sin_leer del dueño de la llave (mensajes de otros posteriores a su «leído hasta»; las menciones son las que lo nombran a él) y leido_hasta.' },
  { name: 'hayai_chat_publicar', op: chatPublicar, scope: 'write', description: 'Publica un mensaje en el chat interno del equipo. cuerpo (máx. 4000) y fuente (obligatoria: tu origen lógico en minúsculas, p. ej. muse-elis, growi, radar-hayai). El autor es el socio dueño de la llave, nunca se pasa. Para mencionar a alguien escribe @Nombre en el texto (Elis, Jorbi, Leandro; sin importar mayúsculas; un @ que no corresponde a nadie queda como texto) o pasa menciones=[id de astronauta] (ids con hayai_chat_usuarios; un id inexistente es un error). Se avisa en vivo a los conectados y a los mencionados se les marca en su icono de mensajes. clave_externa hace la publicación idempotente: la misma (fuente, clave_externa) no se duplica (devuelve el mensaje existente con creado=false), así que reintentar es seguro.' },
  { name: 'hayai_chat_editar', op: chatEditar, scope: 'write', description: 'Edita un mensaje PROPIO del chat (solo su autor; si es de otro, error). cuerpo nuevo: se recalculan las menciones a partir de sus @Nombre (y de menciones=[id] si las pasas) y queda marcado «(editado)». Manda actualizado_el (el de tu última lectura) para no pisar un cambio ajeno.' },
  { name: 'hayai_chat_borrar', op: chatBorrar, scope: 'delete', description: 'Manda un mensaje del chat A LA PAPELERA (solo su autor o un administrador). Restaurable 30 días con hayai_papelera_restaurar.' },
  { name: 'hayai_chat_marcar_leido', op: chatMarcarLeido, scope: 'write', description: 'Mueve el «leído hasta» del chat del dueño de la llave: hasta = creado_el del mensaje más nuevo que viste (nunca retrocede), o todos=true para marcar todo. Devuelve sin_leer, menciones_sin_leer y leido_hasta.' },
  { name: 'hayai_chat_usuarios', op: chatUsuarios, scope: 'read', description: 'Los astronautas a quienes se puede mencionar en el chat, con su id (para menciones=[id]); en el texto basta @Nombre.' },
  // Papelera: borrar nunca destruye, manda a la papelera 30 días y se puede restaurar.
  { name: 'hayai_papelera_listar', op: papeleraListar, scope: 'read', description: 'Lista lo que hay en la papelera (borrado en los últimos 30 días), con quién lo borró y hasta cuándo se puede restaurar.' },
  { name: 'hayai_papelera_restaurar', op: papeleraRestaurar, scope: 'write', description: 'Restaura algo de la papelera con su id de papelera (con todo lo que colgaba de ello). Falla si lo que lo contenía (p. ej. el cliente de un proyecto) sigue borrado: restaura eso primero.' },
  { name: 'hayai_cliente_eliminar', op: clienteEliminar, scope: 'delete', description: 'Manda un cliente A LA PAPELERA junto con TODO lo suyo: cobros, proyectos, tareas y gastos. Se puede restaurar 30 días con hayai_papelera_restaurar.' },
  { name: 'hayai_proyecto_eliminar', op: proyectoEliminar, scope: 'delete', description: 'Manda un proyecto a la papelera con sus tareas y gastos. Restaurable 30 días.' },
  { name: 'hayai_pago_eliminar', op: pagoEliminar, scope: 'delete', description: 'Manda un cobro a la papelera (la inicial no se puede borrar: se edita desde sus ítems). Restaurable 30 días.' },
  { name: 'hayai_gasto_eliminar', op: gastoEliminar, scope: 'delete', description: 'Manda un gasto a la papelera. Restaurable 30 días.' },
  { name: 'hayai_tarea_eliminar', op: tareaEliminar, scope: 'delete', description: 'Manda una tarea a la papelera. Restaurable 30 días.' },
  { name: 'hayai_hito_eliminar', op: hitoEliminar, scope: 'delete', description: 'Manda un hito a la papelera (sus tareas quedan sueltas y se vuelven a colgar al restaurar). Restaurable 30 días.' },
  { name: 'hayai_checklist_eliminar', op: checklistEliminar, scope: 'delete', description: 'Manda un elemento de la checklist a la papelera. Restaurable 30 días.' },
  { name: 'hayai_oferta_desactivar', op: ofertaDesactivar, scope: 'delete', description: 'Desactiva una oferta del catálogo (no se borra: las propuestas que ya la usan conservan su texto y precio).' },
  { name: 'hayai_interaccion_eliminar', op: interaccionEliminar, scope: 'delete', description: 'Manda una interacción de la bitácora a la papelera (las automáticas de etapa no se borran). Restaurable 30 días.' },
]

// Herramientas que editan un registro con fecha de actualización: aceptan `actualizado_el` (el que devolvió la lectura) y, si el
// registro ya cambió, responden con conflicto en vez de pisarlo. Opcional: sin él se guarda como siempre.
const CONFLICT_AWARE = new Set([
  'hayai_cliente_actualizar',
  'hayai_proyecto_actualizar',
  'hayai_proyecto_estado',
  'hayai_tarea_actualizar',
  'hayai_tarea_completar',
  'hayai_pago_actualizar',
  'hayai_pago_marcar_cobrado',
  'hayai_propuesta_actualizar',
  'hayai_acuerdo_actualizar',
  'hayai_chat_editar',
])
const actualizadoEl = z
  .string()
  .optional()
  .describe('Opcional. El actualizado_el que devolvió la última lectura de este registro: si cambió desde entonces, la herramienta responde conflicto en vez de sobrescribir. Vuelve a leerlo y reintenta.')

const INSTRUCTIONS =
  'HAYAI Space: sistema interno de HAYAI (clientes y posibles clientes con su pipeline de ventas y bitácora, cobros, proyectos, gastos, tareas, finanzas, alertas, búsqueda, el feed de oportunidades que alimentan las máquinas y los agentes, y el chat interno del equipo). ' +
  'Montos en USD como número; fechas AAAA-MM-DD; zona horaria de Caracas. ' +
  'Lo que se escriba queda atribuido al socio dueño de la llave de API. Solo ves las herramientas que los permisos de tu llave permiten (lectura, escritura, borrado). Borrar manda a la papelera 30 días: nada se pierde al instante.'

function buildServer(actor: SessionUser, version: string | null) {
  // La versión vigente va en las instrucciones y en serverInfo: el agente se entera de un cambio en cuanto se conecta, sin preguntar.
  const aviso = version
    ? ` Versión actual del sistema: v${version}. Si es distinta de la última que conocías, llama a hayai_version_ver con desde=<tu última versión> para ver qué cambió (nuevas herramientas, campos o reglas) antes de escribir. Al editar un registro, manda actualizado_el (el de tu última lectura) para no pisar cambios de otros.`
    : ''
  const server = new McpServer({ name: 'hayai-space', version: version ?? '1.0.0' }, { instructions: INSTRUCTIONS + aviso })
  // Solo se ofrecen las herramientas que los permisos de la llave permiten: el agente no ve lo que no puede usar.
  for (const t of TOOLS.filter((x) => actor.scopes?.includes(x.scope))) {
    server.registerTool(
      t.name,
      {
        description: t.description,
        inputSchema: CONFLICT_AWARE.has(t.name) ? { ...t.op.schema.shape, actualizado_el: actualizadoEl } : t.op.schema.shape,
        annotations: { readOnlyHint: t.scope === 'read', destructiveHint: t.scope === 'delete' },
      },
      async (args: unknown) => {
        try {
          let input = args
          let expected: unknown
          if (CONFLICT_AWARE.has(t.name) && args && typeof args === 'object') {
            const { actualizado_el, ...rest } = args as Record<string, unknown>
            input = rest
            expected = actualizado_el
          }
          const data = await withExpected(expected, () => exec(t.op, actor, input))
          return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
        } catch (e) {
          // Los errores de negocio (validación, 404...) vuelven como resultado de la herramienta para que el agente los lea y corrija.
          if (e instanceof HttpError) {
            const now = e.extra.codigo === 'conflicto' ? ` (actualizado_el actual: ${String(e.extra.actualizado_el)})` : ''
            return { isError: true, content: [{ type: 'text' as const, text: e.message + now }] }
          }
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

mcpRouter.post('/', apiKeyAuth, keyRateLimit(), versionHeader, jsonOnly, express.json({ limit: '6mb' }), async (req, res) => { // 6 MB: el comprobante de un cobro viaja en base64
  const server = buildServer(req.user!, await currentVersionString())
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
})

mcpRouter.use(apiErrors)
