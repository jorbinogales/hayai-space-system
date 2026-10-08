# hayai-space-system

Sistema interno de HAYAI: interfaz espacial (React + Three.js), API Express y Postgres.

## Desarrollo

```bash
npm install
npm run dev:all   # base de datos embebida + API (:3001) + web (:5173)
```

Usuarios iniciales: **Elis**, **Jorbi** y **Leandro**, todos con PIN `000000` (el sistema obliga a crear uno nuevo al entrar).

## Despliegue en un VPS con Docker

Requisitos: Docker con el plugin Compose, un dominio apuntando a la IP del VPS y los puertos 80 y 443 abiertos.

```bash
git clone https://github.com/jorbinogales/hayai-space-system.git && cd hayai-space-system
cp .env.production.example .env   # edita POSTGRES_PASSWORD (openssl rand -hex 24) y DOMAIN
docker compose -f docker-compose.prod.yml up -d --build
```

Levanta tres contenedores: `db` (Postgres 16, con volumen), `app` (API + web; aplica las migraciones al arrancar) y `caddy` (HTTPS automatico). Postgres no se expone a internet.

Cambia los tres PIN iniciales de inmediato: mientras sigan en `000000`, cualquiera con la URL puede entrar.

Actualizar: `git pull && docker compose -f docker-compose.prod.yml up -d --build`.

Copia de seguridad: `docker compose -f docker-compose.prod.yml exec db pg_dump -U hayai hayai > backup-$(date +%F).sql`.

## API REST v1 y servidor MCP (integraciones, p. ej. Growi)

Tres cosas nuevas, todas autenticadas con el header `X-API-Key` (no usan la cookie de la web):

- **REST**: `https://space.hayai.com.ve/api/v1/...`
- **MCP** (Streamable HTTP, sin estado): `POST https://space.hayai.com.ve/mcp`
- **Llaves**: cada llave pertenece a un socio; todo lo que haga queda atribuido a él. Cada socio crea y revoca las suyas desde la web (menú de la cuenta → **Integraciones**, pide el PIN) eligiendo nombre y permisos.

### Crear una llave

Lo normal es hacerlo desde la web (Integraciones). Por terminal, para la primera llave o en el VPS:

```bash
# local
npm run apikey -- create --user Leandro --name growi [--scopes read,write,delete]   # por defecto read,write
# VPS
docker compose -f docker-compose.prod.yml exec app node_modules/.bin/tsx server/src/apikey-cli.ts create --user Leandro --name growi
```

La llave (`hy_...`) se muestra **una sola vez**; en la base solo queda su hash SHA-256. También: `apikey list` y `apikey revoke <prefijo|id>`.

```bash
curl -H "X-API-Key: hy_..." https://space.hayai.com.ve/api/v1/me
```

### Contrato REST

Campos en español y snake_case, montos en USD como número, fechas `AAAA-MM-DD` (zona `APP_TZ`, por defecto America/Caracas). Listas: `{ "data": [...], "meta": { page, per_page, total, ... } }` con `?page=` y `?per_page=` (máx. 100). Errores: `{ "error": { "code", "message" } }` (`validation_error`, `unauthorized`, `not_found`, `conflict`, `rate_limited`...). Los esquemas son estrictos: un campo desconocido devuelve 400.

**Permisos por llave**: `read` (GET), `write` (POST/PATCH, también archivar y restaurar) y `delete` (DELETE). Sin el permiso: 403 `forbidden` con `required_scope`. En MCP, la llave solo ve las herramientas que sus permisos permiten. **Borrar nunca destruye**: manda a la papelera 30 días (ver abajo); el borrado definitivo no existe en la API.

| Recurso | Endpoints |
|---|---|
| Clientes (ficha y pipeline incluidos) | `GET /clientes` (filtros `estado`, `etapa`), `GET /clientes/:id`, `POST /clientes`, `PATCH /clientes/:id` |
| Bitácora | `GET /clientes/:cliente_id/interacciones`, `POST /clientes/:cliente_id/interacciones`, `PATCH /interacciones/:id` |
| Pipeline | `GET /pipeline` (por etapa: cantidad, valor total y ponderado; ganados, perdidos y fríos) |
| Alertas | `GET /notificaciones` (`estado=todas\|sin_leer`, `tipo`), `POST /notificaciones/leer` (`{claves:[...]}` o `{todas:true}`) |
| Búsqueda | `GET /buscar?q=` (`tipo`, `archivados`, `limite`) |
| Pagos | `GET /pagos`, `POST /clientes/:cliente_id/pagos`, `PATCH /pagos/:id` |
| Proyectos | `GET /proyectos`, `GET /proyectos/:id`, `POST /proyectos`, `PATCH /proyectos/:id` |
| Gastos | `GET /gastos`, `GET /gastos/:id`, `POST /gastos`, `PATCH /gastos/:id` |
| Tareas | `GET /tareas`, `GET /tareas/:id`, `POST /tareas`, `PATCH /tareas/:id` |
| Feed de oportunidades | `GET /feed` (`tipo`, `estado`, `fuente`, `categoria`, `guardado`, `q`), `GET /feed/:id`, `POST /feed` (uno o `items` hasta 50), `PATCH /feed/:id/estado`, `POST /feed/:id/guardar`, `POST /feed/:id/convertir`, `POST /feed/:id/deshacer` (ver sección «Feed de oportunidades») |
| Chat interno | `GET /chat` (keyset: `limite`, `antes_de` + `antes_de_id`), `GET /chat/:id`, `POST /chat`, `PATCH /chat/:id`, `POST /chat/leido`, `GET /chat/contadores`, `GET /chat/usuarios` (ver sección «Chat interno») |
| Finanzas | `GET /finanzas/resumen?periodo=mes\|anio\|todo` |
| Borrar (permiso `delete`) | `DELETE /clientes/:id`, `/pagos/:id`, `/proyectos/:id`, `/gastos/:id`, `/tareas/:id`, `/interacciones/:id`, `/chat/:id` (autor o ADMIN) |
| Papelera | `GET /papelera`, `POST /papelera/:id/restaurar` (escritura) |
| Archivo | `PATCH /clientes/:id` y `/proyectos/:id` con `{"archivado": true\|false}`; los listados aceptan `?archivados=excluir\|incluir\|solo` |

### MCP

88 herramientas (77 sin borrado: la llave solo ve las de sus permisos; seis son del feed de oportunidades y seis del chat interno) (`hayai_clientes_listar`, `hayai_cliente_crear`, `hayai_proyecto_estado`, `hayai_gasto_registrar`, `hayai_finanzas_resumen`, `hayai_papelera_restaurar`, `hayai_cliente_eliminar`...). Las del CRM: `hayai_interacciones_listar`, `hayai_interaccion_registrar`, `hayai_interaccion_actualizar`, `hayai_interaccion_eliminar`, `hayai_pipeline_resumen`, `hayai_notificaciones_listar`, `hayai_notificaciones_marcar_leidas`, `hayai_actividad_listar`, `hayai_actividad_marcar_leida` y `hayai_buscar`. Llaman a los mismos servicios que la REST, así que validan y atribuyen igual. Los errores de negocio vuelven como resultado con `isError`. Las peticiones deben llevar `Accept: application/json, text/event-stream`.

Conectar Growi: conector personalizado `custom.hayai-space` → URL `https://space.hayai.com.ve/mcp`, header `X-API-Key` con la llave guardada en su Secure Vault. Probar con `hayai_finanzas_resumen` y `hayai_tareas_listar`.

### Variables de entorno

`V1_RATE_MAX` (peticiones/min por llave, 120), `V1_AUTH_FAIL_MAX` (intentos fallidos por IP cada 15 min, 30), `APP_TZ` (America/Caracas). Si hay un proxy delante, `/api/v1` y `/mcp` deben pasar tal cual (Caddy lo hace con la configuración actual).

### Diferencias con el SPEC (decididas y documentadas)

- El SPEC tenía un solo campo `contacto`: ahora la ficha guarda `telefono`, `email`, `contacto_nombre` y `contacto_cargo`. `contacto` a secas se rechaza con 400.
- Estado de proyecto `visita` ↔ `planeacion` interno.
- Las tareas pertenecen siempre a un proyecto (`proyecto_id` obligatorio) y no tienen asignado: se devuelve `creada_por`.
- El SPEC no tenía DELETE: se añadió con permiso propio y siempre a la papelera (recuperable 30 días).
- Añadidos fuera del SPEC: pagos, papelera, archivo y los GET de detalle. No se exponen los endpoints de prospectos.

## CRM: ficha, pipeline, bitácora y alertas

Todo lo que hace la web existe igual en la API y el MCP (los tres llaman a los mismos servicios). La web habla en camelCase (`phone`, `nextActionDate`...) y la API/MCP en español (`telefono`, `proxima_accion_fecha`...); `PATCH /api/clients/:id/ficha` traduce y rechaza campos desconocidos.

- **Ficha** (`POST`/`PATCH /clientes`): `telefono`, `email`, `contacto_nombre`, `contacto_cargo`, `direccion`, `notas`, `etiquetas` (máx. 10, se guardan en minúscula y sin repetir), `origen` (`referido`, `instagram`, `whatsapp`, `facebook`, `meta_ads`, `web`, `visita_frio`, `evento`, `otro`). `null` borra un campo; omitirlo lo deja igual. El email se valida en la API (zod) y en la BD (CHECK).
- **Pipeline** (solo posibles clientes): `etapa` (`prospecto` 10 → `visita_agendada` 20 → `visita_realizada` 35 → `propuesta_en_armado` 50 → `propuesta_presentada` 70 → `ganado` 100 / `perdido` 0; viven en la tabla `pipeline_stages`), `valor_estimado` (USD mensual), `probabilidad` (0–100), `cierre_previsto`, `motivo_perdida`. Los nombres de la fase 1 (`nuevo`, `contactado`, `propuesta`, `negociacion`) se siguen aceptando al ENTRAR (transitorio); la salida usa siempre los nuevos. Un posible entra en `prospecto` (10 %) y cada etapa trae su probabilidad (se puede pisar a mano). Ganar exige `fecha_implementacion` (y, con propuesta vigente, `esquema_cobro`), fija la probabilidad en 100 y lo vuelve cliente (`estado: "activo"` equivale a `etapa: "ganado"`); perder exige `motivo_perdida` y fija 0. `valor_ponderado` = valor × probabilidad (null si no hay valor). Un cliente de antes del pipeline tiene `etapa: null`.
- **Próxima acción**: `proxima_accion` + `proxima_accion_fecha` (la fecha exige acción; borrar la acción borra la fecha).
- **Bitácora**: llamadas, visitas, WhatsApp y notas (`tipo`), con `fecha` opcional (solo día = mediodía de Caracas; no puede ser futura). Cada cambio de etapa deja una entrada `tipo: "etapa"` escrita **solo por el servidor**: la API no las crea, edita ni borra (400/409). Una interacción borrada va a la papelera.
- **Frío**: un posible abierto sin llamada/visita/WhatsApp/nota hace más de **14 días** (las entradas de etapa no cuentan; sin interacciones se cuenta desde que se creó). Sale en `GET /pipeline` y como `frio` en el cliente.
- **Alertas** (se derivan al consultar, no hay tareas programadas): `cuota_vencida` = cuota pendiente con fecha anterior a hoy (hora de Caracas) de un cliente activo y no archivado; `seguimiento` = `proxima_accion_fecha` de hoy o anterior en un cliente no archivado ni perdido. La lectura es por socio y la clave es determinista (`cuota:<id>`, `seguimiento:<cliente>:<fecha>`): pagar la cuota la quita, y reprogramar el seguimiento la vuelve a mostrar. Finanzas y los clientes traen `vencido`/`cuotas_vencidas`/`monto_vencido`; `por_cobrar` no cambia (el vencido sigue dentro).
- **Búsqueda**: sin acentos ni mayúsculas, por palabras (todas deben aparecer), y por dígitos del teléfono. Busca en nombre, teléfono, email, contacto, dirección, etiquetas y notas de clientes, y en nombres de proyectos y tareas.

## Propuestas, proyectos con hitos y checklist (fase 1.5)

- **Propuestas** (`GET`/`POST /clientes/:id/propuestas`, `GET`/`PATCH /propuestas/:id`; MCP `hayai_propuestas_listar`, `hayai_propuesta_crear`, `hayai_propuesta_ver`, `hayai_propuesta_actualizar`): de posibles clientes y también de clientes activos (venta adicional / *upsell*; solo en los posibles mueve el `valor_estimado`). Cada propuesta es una **versión** (`version` 1, 2…); crear una nueva reemplaza a la vigente. Los ítems llevan `tipo`: exactamente una `mensualidad` (la base) más `extra_mensual` y `extra_unico` opcionales, con `cantidad` y `precio_unitario`, y pueden salir del catálogo (`oferta_id`). `totales` = `{ mensual, unico }`. El `valor_estimado` del posible cliente es siempre la mensualidad de la propuesta vigente (y el pipeline pondera esa mensualidad). Pasar a `propuesta_presentada` exige una propuesta y la marca presentada; no hay endpoint de estado aparte: se rechaza con `perdido` o con una versión nueva.
- **Ganar**: `etapa: "ganado"` con `fecha_implementacion`; con propuesta vigente exige además `esquema_cobro { inicio_cobro, meses (2–36, por defecto 12), unicos_cobrados }`, y genera las mensualidades y los pagos únicos (los únicos cobrados entran como la inicial). La propuesta queda `aceptada`. Sin propuesta no se admite `esquema_cobro`.
- **Catálogo de ofertas** (`GET`/`POST /ofertas`, `PATCH`/`DELETE /ofertas/:id`; `hayai_ofertas_*`): sembrado con las ofertas base; `DELETE` solo desactiva, las propuestas ya armadas conservan texto y precio. `GET /pipeline/etapas` (`hayai_pipeline_etapas`) lista las 7 etapas con su probabilidad.
- **Visitas**: `fecha_visita` al mover a `visita_agendada` crea la tarea de la visita (con su proyecto interno) y reprogramar no duplica; `resumen_visita` con `visita_realizada` queda en la bitácora como una visita.
- **Redes**: `redes: [{ red, url }]` en la ficha (una por red, máx. 8; `@usuario` se normaliza a la URL https; `[]` las quita).
- **Proyectos** pueden no tener cliente (`cliente_id: null`, internos de la agencia), llevan `descripcion` y los estados `pendiente`, `en_curso`, `pausado`, `completado`. `GET /proyectos?sin_cliente=true` los filtra.
- **Hitos** (`POST /proyectos/:id/hitos`, `POST .../hitos/orden`, `PATCH`/`DELETE /hitos/:id`) y **checklist** (`POST /proyectos/:id/checklist`, `POST .../checklist/orden`, `PATCH`/`DELETE /checklist/:id`): el reordenamiento es todo o nada (la lista debe traer todos los ids, sin repetir). Las tareas se cuelgan de un hito con `hito_id` (mismo proyecto; filtro `GET /tareas?hito_id=`). Borrar un hito o un ítem va a la papelera; restaurar un hito vuelve a colgar sus tareas. MCP: `hayai_hito_*`, `hayai_hitos_ordenar`, `hayai_checklist_*`.

## Meta Lead Ads (ingesta automática de leads)

APAGADO por defecto: con `META_LEADS_ENABLED` distinto de `true`, las rutas responden 404 y no se crea nada. Cuando Meta avisa de un lead, el servidor pide el detalle a la Graph API, crea un **posible cliente** (`origen: meta_ads`, etiqueta `meta ads`, etapa `prospecto`) y avisa al equipo («Llegó un posible cliente de Meta Ads: …»; llega como no leído a todos los socios). **No** crea proyecto ni tarea.

Requisitos para encenderlo:

1. Una **app de Meta** con el producto Webhooks y el campo `leadgen` de la Página suscrito.
2. Un **token de Página** con el permiso `leads_retrieval` (requiere revisión de Meta; hasta entonces solo funciona con roles de la app).
3. Un **endpoint público HTTPS**: `https://space.hayai.com.ve/api/webhooks/meta` (el `GET` responde el desafío de verificación; el `POST` exige la firma `X-Hub-Signature-256`).
4. Variables en el servidor: `META_LEADS_ENABLED=true`, `META_APP_SECRET`, `META_VERIFY_TOKEN` (texto que tú eliges y pegas en Meta), `META_PAGE_TOKEN`, `META_LEADS_OWNER` (por defecto `Elis,Jorbi,Leandro`; suma a quien quieras) y, opcional, `META_GRAPH_VERSION` (por defecto `v21.0`).

Comportamiento: la firma se valida sobre el cuerpo crudo (401 si falla); es **idempotente** por `leadgen_id` (Meta puede reintentar sin duplicar); si Graph falla el lead queda en `error` y se reintenta con espera creciente (hasta 6 intentos); un lead con el mismo teléfono o email que un cliente existente **no crea otro**: se anota en la bitácora del existente; un teléfono o email inválido no rompe el alta, queda en las notas. El **responsable** se reparte de forma equitativa entre los nombres de `META_LEADS_OWNER` (el que menos leads de Meta lleva).

## Hub central, cobros y sistemas de los clientes

- **Hub (planeta HAYAI)**: `GET /hub` (MCP `hayai_hub_ver`; web `GET /api/hub`) junta en una llamada el **pulso interno** (gastos generales del mes, tareas y proyectos internos), los **astronautas** (cada socio con su rol y su carga), la **bitácora interna** (últimos 15 avisos que no son de clientes), los **acuerdos abiertos**, el **semáforo de sistemas** y el hueco de `analytics` (`disponible: false`: las fuentes se conectan después y viven en el planeta Marketing). *Interno* = lo que no se imputa a ningún cliente: proyectos sin cliente, sus tareas y los gastos generales. No hay un campo guardado: `es_interno` se **deriva** (así no se desincroniza al re-vincular un proyecto).
- **Filtros internos**: `?interno=true|false` en `GET /tareas`, `/proyectos` y `/gastos`; `GET /finanzas/resumen?interno=true` (solo gastos generales, sin ingresos ni tabla de clientes); `GET /actividad?alcance=interno`. `GET /tareas?responsable=` filtra por quien la lleva.
- **Equipo**: `GET /equipo`, `PATCH /equipo/:socio` (`rol`, `responsabilidades`). La **carga** de cada socio cuenta las tareas abiertas que tiene asignadas y, las que no tienen asignado, las de los proyectos donde es responsable. Las tareas ganaron `responsable` (nombre del socio; `null` la devuelve al responsable del proyecto); la salida trae `responsable`, `asignada` y `es_interno`.
- **Acuerdos de la reunión semanal**: `GET`/`POST /acuerdos`, `PATCH /acuerdos/:id` (`texto`, `fecha_reunion`, `responsable`, `vence`, `estado`: `abierto`, `cumplido`, `descartado`). Crear uno avisa al equipo (`acuerdo_nuevo`).
- **Embudo de Marketing**: `GET /marketing/embudo?dias=90` (MCP `hayai_marketing_embudo`): posibles y valor mensual (total y ponderado) por etapa abierta, cierres y tasa de cierre del periodo, cohorte por origen (qué terminó pasando con lo que entró) y el estado de los leads de Meta Ads. **Analytics** (visitas, campañas) NO existe todavía: se propone GA4 + Cloudflare Web Analytics + Meta Graph API, solo lectura y con credenciales en el servidor.
- **Decisión 3 (versión de la propuesta)**: al presentar o ganar, la entrada de etapa de la bitácora guarda `propuesta_version` (y `propuesta_id` en `meta`) y su resumen dice «(propuesta v2)». La propuesta de cada cliente es la *vigente* en ese momento.

### Detalle del cobro y comprobante

- **Campos nuevos del cobro** (en `POST /clientes/:id/pagos` y `PATCH /pagos/:id`; `GET /pagos/:id`; `GET /pagos?recibido_por=&metodo=`): `monto_bs`, `tasa` (Bs por USD), `fecha_tasa`, `referencia`, `banco_origen`, `cuenta_origen_ultimos4`, `banco_destino`, `recibido_por`, `metodo` (`transferencia`, `pago_movil`, `efectivo`, `zelle`, `otro`) y `notas`. El `monto` en USD sigue siendo el de Finanzas; esto documenta cómo entró el dinero.
- **Reglas**: con `monto_bs` la `tasa` se calcula (`monto_bs / monto`, 4 decimales); con `tasa` los bolívares son `monto × tasa`; si llegan los dos deben cuadrar (0,5 %) o es un 400. Si cambia el monto en USD, la tasa se recalcula y los bolívares recibidos no cambian. Quitar uno (`null`) quita ambos. `banco_origen: "Bancrecer ****8017"` se separa en banco y últimos 4. **Una referencia bancaria no se registra dos veces** (409). La inicial acepta detalle pero no cambia sus campos de fondo.
- **Comprobante**: `POST /pagos/:id/comprobante` con `imagen_base64` (PNG, JPEG o WebP, máx. 4 MB, validado por los bytes), `nombre` y, opcional, `texto_ocr` (si quien llama ya leyó la imagen, se usa en vez del OCR del servidor); `GET /pagos/:id/comprobante` (texto leído) y `GET /pagos/:id/comprobante/archivo` (la imagen; con CSP `sandbox`). Web: `/api/cobros/:id/...`. MCP: `hayai_comprobante_subir/ver/detectar`.
- **Receptor por defecto**: al crear un cobro ya cobrado (API, MCP o pantalla) —o al marcar uno pendiente como cobrado— `recibido_por` es **quien lo registra** (dueño de la llave o de la sesión); se cambia con `recibido_por` (un nombre, o `null` para dejarlo sin receptor). Un pendiente no lleva receptor hasta que se cobra. `RECEIVER_DOCUMENTS` ya no hace falta para esto; la detección por cédula del comprobante sigue siendo opcional.
- **OCR → recibido por**: el servidor lee el texto del capture (tesseract.js, sin servicios externos; ~1–5 s), busca `DOCUMENTO V-…` y cruza esa cédula con el **mapeo documento → socio**. Estados de `deteccion`: `asignado` (se asignó `recibido_por`, origen `comprobante`), `ya_asignado`, `difiere` (había otro receptor fijado a mano: **no se pisa**, pide confirmar), `sin_mapeo` y `no_detectado` (**no se inventa nada**: confirmar a mano). `POST /pagos/:id/comprobante/detectar` vuelve a cruzar sin repetir el OCR. Si el OCR falla, la imagen igual se guarda.
- **Mapeo de cédulas**: `GET`/`POST /receptores`, `DELETE /receptores/:id` (borrar exige permiso `delete`). Siempre se **lista enmascarado** (`V-263•••92`) y el texto leído también sale enmascarado: las cédulas completas no viajan por la API. Se siembra al arrancar desde `RECEIVER_DOCUMENTS="V-111=Elis,V-222=Jorbi"` (solo agrega las que faltan; lo editado en la app manda). **Esa variable va solo en el `.env` del VPS.**

### Sistemas de los clientes (semáforo)

- `GET`/`POST /sistemas`, `GET`/`PATCH /sistemas/:id`, `POST /sistemas/:id/verificar` (MCP `hayai_sistema(s)_*`; web `/api/systems`). Cada sistema guarda `enlace`, `url_produccion`, `url_verificacion`, `repo`, `servidor`, `usuario_gestion` y `notas`: **nunca contraseñas** (las URLs con `usuario:clave@` se rechazan y no hay campo para claves).
- **Semáforo** `estado`: `arriba`, `caido`, `desconocido`. Un vigilante pide la URL (verificación → producción → enlace) cada `SYSTEMS_CHECK_MS` (por defecto 10 min; `0` lo apaga) de los sistemas activos con `verificar`. HTTP 2xx/3xx = arriba. **Un fallo aislado no alarma**: se confirma con un segundo intento (`SYSTEMS_RETRY_MS`, 20 s). Solo al **cambiar** de estado se avisa al equipo (`sistema_caido`, `sistema_recuperado`), a todos los socios; arrancar en «arriba» no avisa. Cambiar la URL reinicia el semáforo. Se guardan 7 días de verificaciones (`disponibilidad_24h`).
- **Seguridad (SSRF)**: solo `http`/`https`, nunca hacia direcciones privadas, locales o de enlace local (tampoco en las 3 redirecciones que sigue); es solo lectura (GET sin cookies ni credenciales). `SYSTEMS_ALLOW_PRIVATE=true` lo desactiva (solo pruebas locales).

### Variables de entorno de esta fase

`RECEIVER_DOCUMENTS`, `SYSTEMS_CHECK_MS`, `SYSTEMS_RETRY_MS`, `SYSTEMS_TIMEOUT_MS` (10 s), `SYSTEMS_ALLOW_PRIVATE`, `OCR_TIMEOUT_MS` (25 s).

### Migración 010 (datos)

Archiva el cliente ficticio «HAYAI (interno)»: sus proyectos pasan a internos (sin cliente), sus gastos directos a generales; el **total de Finanzas no cambia** y un cliente archivado sin movimientos ya no ocupa fila. Completa el cobro de **Super Miga** del 07/10/2026 ($75 · Bs. 65.540,25 · tasa 873,87 · ref. 071026007463 · Bancrecer ****8017 → Mercantil · Elis · transferencia) **solo si hay exactamente un candidato**; si no lo hay (o hay varios) no toca nada: se registra por la app. Ambos bloques son idempotentes.

## Feed de oportunidades (planeta HAYAI)

**Bitácora = lo que el equipo HIZO. Feed = lo que las máquinas y los agentes ENCONTRARON** (ideas del radar, prospectos del cazador, negocios de las video-auditorías con sus fugas y guion, alertas de competencia, noticias, propuestas manuales de cualquier socio). No se mezclan: el feed no aparece en la bitácora interna del hub.

- **Ítem** (`feed_items`): `titulo` (≤160), `resumen`, `tipo` (`idea | prospecto | alerta | noticia | oportunidad | proyecto`), `fuente` (origen lógico en minúsculas: `radar-hayai`, `cazador-summit`, `video-auditorias`, `espia-pos`, `leads-tibios`, `demo-first`, `muse-elis`, `muse-jorbi`, `muse-leandro`, `manual`…), `clave_externa` (idempotencia por fuente), `publicado_por` (**sale siempre de la llave**, no del cuerpo), `categoria` (opcional, minúsculas ≤40: restaurante, ferretería…), `estado` (GLOBAL: `nuevo | convertido`) junto a `mi_estado` (`nuevo | revisado | descartado`) y `guardado`, que son PERSONALES de quien consulta, `datos` (objeto JSON libre ≤ ~60 KB: `negocio`, `fugas`, `guion`, `urls`, `metricas`, `contacto { telefono, whatsapp, correo, web, instagram, facebook }`, `origen_url` (noticias), `telefono`, `email`, `origen`…) y `fecha` del hallazgo (no futura; por defecto ahora). Trae `actualizado_el` (If-Match / `actualizado_el` como en el resto).
- **Publicar**: `POST /feed` (MCP `hayai_feed_publicar`; web `POST /api/feed`). Con `clave_externa`, la misma `(fuente, clave_externa)` **no se duplica**: devuelve el ítem existente con `creado: false` (200 en vez de 201), así que reintentar es seguro. Varios a la vez: `{ "items": [ {…}, … ] }` (hasta 50) → `{ recibidos, creados, duplicados, data[] }` (201 si se creó alguno). Una siembra de 20 negocios es **una** llamada.
- **Consultar**: `GET /feed` (MCP `hayai_feed_listar`; web `GET /api/feed`), más reciente primero; filtros `tipo`, `estado` (el que ves tú: `nuevo | revisado | descartado | convertido`), `fuente`, `categoria` (o `sin_categoria`), `guardado=true` y `q` (título y resumen, sin acentos). `meta` trae `nuevos` (tuyos: el contador del hub), `guardados`, `por_estado`, `por_tipo`, `fuentes`, `categorias` y `sin_categoria`, que **no dependen del filtro**. `GET /hub` trae `feed: { nuevos, total }`.
- **Marcar** (personal): `PATCH /feed/:id/estado` (MCP `hayai_feed_marcar`) con `estado` = `nuevo | revisado | descartado` y `motivo` corto opcional (solo al descartar). Es **de cada socio** (tabla `feed_item_usuarios`): lo que Leandro descarta, Jorbi lo sigue viendo nuevo. `convertido` no se marca a mano. **Guardar** (personal): `POST /feed/:id/guardar` (MCP `hayai_feed_guardar`, `guardado` por defecto `true`; `false` lo quita).
- **Convertir** (una sola vez): `POST /feed/:id/convertir` (MCP `hayai_feed_convertir`) con `a` = `posible_cliente` (crea el posible cliente en «Prospecto captado» pre-llenando nombre, origen, teléfono y correo; las notas quedan **ordenadas y cortas**: `Del feed: <fuente> · <fecha>` + `Ítem original: #hub/feed/<id>` (enlace al hallazgo, donde siguen las fugas, el guion y los enlaces), `Resumen` (≤ 280 caracteres) y `Contacto` en líneas —de `datos.contacto` (`telefono`, `whatsapp`, `correo`, `web`, `instagram`, `facebook`) o, si no, `datos.telefono` / `datos.email`—; deja una nota en su bitácora de dónde salió), `tarea` (`titulo`, `vence`, `responsable`, `proyecto_id`; sin `proyecto_id` va al proyecto interno de HAYAI, que se crea si no existe) o `proyecto` (`nombre`, `descripcion`, `cliente_id`, `responsable`). Todo lo que envíes pisa lo pre-llenado; un teléfono o correo sucio del ítem no rompe la conversión. El ítem se **reclama antes de crear** (dos socios tocando «Convertir» a la vez no duplican nada: el segundo recibe 409) y, si la creación falla, vuelve a su estado anterior. Convertir es **global** (todos lo ven convertido, con quién y cuándo); la tarea queda con el `responsable` que elijas o, por defecto, con quien la crea.
- **Botones inteligentes (v1.6.6 «Órbita fina II»)**: cada ítem expone `vinculo { estado: sin_vinculo | posible_cliente | cliente, cliente_id, cliente, origen: conversion | datos | nombre }` (a qué cliente apunta, por conversión previa, por `datos.cliente_id` o por nombre exacto) y `creados { <kind>: { id, por, el } }` con lo ya creado desde el ítem. `POST /feed/:id/convertir` acepta además `a` = `cliente` (promueve el posible cliente vinculado a activo; `fecha_implementacion` por defecto hoy; si tiene propuesta vigente exige `esquema_cobro`, si no 400) y `seguimiento` (tarea «Seguimiento: …» que vence hoy + 3 días, hora de Caracas). Las tareas heredan el proyecto del cliente y los proyectos su `cliente_id`. **Sin duplicados**: cada `(ítem, kind)` se crea una sola vez (tabla `feed_item_vinculos`, `kind` = `posible_cliente | cliente | tarea | proyecto | propuesta | seguimiento`; segundo intento = 409 y la web abre lo ya creado). **Deshacer**: `POST /feed/:id/deshacer` (MCP `hayai_feed_deshacer`) con `kind` revierte la conversión (a la papelera, 30 días) **solo quien la hizo y dentro de 120 s**; responde `{ item, deshecho }`. Las propuestas no se deshacen (400). **Devolver al feed** (la red de seguridad cuando la ventana de 120 s ya pasó): `POST /feed/:id/deshacer` con `{ a: "posible_cliente", devolver: true }` (también por MCP) lo hace sin límite de tiempo y por cualquier socio, pero solo mientras el cliente siga siendo posible cliente (ya promovido: 409). El posible cliente se va a la papelera con lo que colgaba de él (bitácora, proyectos, propuestas), el ítem vuelve a `nuevo` / `sin_vinculo` y se puede convertir otra vez. La ficha (`GET /clientes/:id`, web `delFeed` en `GET /api/clients`) trae `del_feed { id, titulo, fuente, fecha }` —solo si salió de una conversión— y la web muestra «Del feed» con «Ver el hallazgo» y «Devolver al feed»; el enlace `#hub/feed/<id>` abre el feed con ese ítem enfocado. `POST /clientes/:id/propuestas` acepta `feed_item_id` para vincular la propuesta al ítem. Migración `021_orbita_fina_ii.sql` (tabla `feed_item_vinculos`, nuevos `converted_to`, relleno de lo ya convertido y la versión 1.6.6).
- **Growi**: la fuente `growi` es el sello de lo que encuentra Growi; el nombre anterior `gumloop-video-auditorias` se acepta pero se guarda como `growi`. Si se vuelve a publicar un ítem que no traía categoría, la categoría se completa.
- **Avisos**: solo `alerta`, `noticia` y `prospecto` avisan. En vivo (SSE) se emite **un** aviso `feed_nuevo` por `(fuente, tipo)` y lote, y ninguno si esa fuente ya avisó de ese tipo en los últimos 10 min (una siembra de 20 no inunda). En la campana es una alerta derivada de tipo `feed` por ítem nuevo sin revisar de los últimos 14 días; varios del mismo tipo, fuente y día se juntan en una sola («21 prospectos nuevos en el feed») cuya clave lleva la cuenta, así que si llegan más vuelve a salir sin leer. Revisar o descartar quita la alerta **a quien lo hizo**; convertir la quita a todos.
- **Vías de publicación al mismo endpoint** (cada una con su llave; el alta de llaves es la de siempre, `apikey-cli`): (1) los **crons de Growi** tras cada corrida de Gumloop (puente, sin tocar los flujos): leen el resultado y llaman a `hayai_feed_publicar` con `items`; (2) el **Muse de cada socio** con su propia llave (`fuente: muse-<socio>`); (3) **futuro: directo desde Gumloop**, con un conector MCP personalizado o un nodo HTTP a `POST /api/v1/feed` (header `X-API-Key`). Esta tercera vía **no necesita código nuevo**: es el mismo contrato; solo hace falta una llave de escritura y que la fuente mande su `clave_externa`.
- Migración `018_orbita_fina.sql`: `categoria` en los ítems, tabla `feed_item_usuarios`, los revisados/descartados globales pasan a ser de quien los marcó, los prospectos de `gumloop-video-auditorias` pasan a `growi`, 1.0.0 → «Lanzamiento inicial» y la entrada v1.6.5. Migración `014_feed.sql`: tabla `feed_items` (con las reglas también en la base: `convertido` exige a qué, el motivo solo al descartar, `fuente` en slug), índice único `(fuente, clave_externa)` y el tipo de actividad `feed_nuevo`. Migración `013`: reescribe los nombres de etapa viejos en las bitácoras ya escritas (solo texto).

## Chat interno (icono de mensajes junto a la campana)

Un solo canal de notas para todo el equipo (los astronautas = `users`). Cada mensaje muestra el **nombre del autor**, el texto, la hora y «(editado)» si se corrigió; `@Nombre` etiqueta a alguien y a esa persona se le marca en su icono. Las apps externas (API v1 y MCP) **reciben y envían** con la misma llave `X-API-Key` y los mismos permisos de siempre.

- **Mensaje** (`chat_messages`): `{ id, autor: {id, nombre}, cuerpo, fuente, clave_externa | null, menciones: [{id, nombre}], editado_el | null, creado_el, actualizado_el }`. El **autor sale siempre de la sesión o de la llave** (nunca del cuerpo: un `autor` se rechaza con 400). `fuente` es el origen lógico: la web escribe `manual`; la API/MCP **la exigen** (mismo formato que en el feed: `muse-elis`, `growi`, `radar-hayai`…). `creado_el` trae **microsegundos** (`2026-10-08T21:12:03.123456Z`): es el cursor del keyset y del «leído hasta», se manda de vuelta **tal cual**.
- **Publicar** (permiso `write`): `POST /chat` (MCP `hayai_chat_publicar`; web `POST /api/chat`, siempre con `fuente: manual`) con `cuerpo` (1-4000, recortado), `fuente`, `clave_externa` opcional y `menciones` opcional (lista de ids). Con `clave_externa`, la misma `(fuente, clave_externa)` **no se duplica**: devuelve el mensaje existente con `creado: false` (200 en vez de 201), así que reintentar es seguro. Todo ocurre en **una** transacción (mensaje, menciones y aviso en vivo).
- **Menciones**: se resuelven en el servidor al guardar. Cada `@Nombre` del texto que coincide (sin importar mayúsculas, con límite de palabra: `@Elisabeth` no es `@Elis`, un correo `a@jorbi.com` tampoco) con un astronauta **activo** lo menciona; además se aceptan ids en `menciones` (`GET /chat/usuarios` los lista). Sin repetidos y **sin el propio autor**. **Un `@` que no corresponde a nadie se ignora** (queda como texto: puede ser un correo o «@todos»); **un id explícito que no existe o está inactivo es 400** (es un error del cliente, no texto).
- **Listar** (permiso `read`): `GET /chat` (MCP `hayai_chat_listar`), el más reciente primero, **keyset** (`ORDER BY created_at DESC, id DESC`, sin OFFSET): `limite` (1-100, def. 30) y, para ir hacia atrás, `antes_de` + `antes_de_id` = el `creado_el` y el `id` del mensaje **más viejo** que ya tienes (`meta.siguiente` los trae; `meta.hay_mas` dice si quedan más; sin saltos ni repetidos aunque lleguen mensajes nuevos). `meta` incluye además los contadores del dueño de la llave.
- **Contadores y leído**: cada socio tiene un «leído hasta» (`chat_reads`, nace al primer acceso en ese instante: nadie arranca con todo el historial sin leer). `sin_leer` = mensajes **de otros** posteriores a él; `menciones_sin_leer` = los que **lo nombran** (subconjunto). `GET /chat/contadores` los trae con `leido_hasta`; `POST /chat/leido` (permiso `write`; MCP `hayai_chat_marcar_leido`) lo mueve con `hasta` = `creado_el` del mensaje más nuevo **mostrado** (no «ahora»: lo que llegó después sigue sin leer) o `todos: true`; nunca retrocede ni pasa de «ahora». El icono de mensajes de la web cambia de color y lleva `@` cuando hay menciones sin leer.
- **Editar** (permiso `write`): `PATCH /chat/:id` (MCP `hayai_chat_editar`) con `cuerpo` (y `menciones` opcional), **solo el autor** (403 si no). Lleva `If-Match` / `actualizado_el` como el resto (409 si cambió). Recalcula las menciones desde el texto nuevo, fija `editado_el` y deja la hora original; si el texto no cambia, no se marca como editado.
- **Borrar** (permiso `delete`): `DELETE /chat/:id` (MCP `hayai_chat_borrar`), **solo el autor o un `ADMIN`**. Va a la papelera 30 días (entidad `mensaje`, etiqueta = primeros 80 caracteres, sus menciones viajan en la foto) y se restaura con `POST /papelera/:id/restaurar` o desde la Papelera de la web, con su hora original.
- **En vivo**: el servidor avisa por `pg_notify('chat', …)` **dentro de la transacción** y `GET /api/events` reparte un evento SSE `chat` a todas las pestañas: `{ op: "nuevo" | "editado", mensaje }` o `{ op: "borrado", id }` (restaurar es un `nuevo`). Sin `id:` en el frame (no pisa el `Last-Event-ID` de la actividad); al reconectar el panel vuelve a pedir lo último y un sondeo de 30 s cubre un proxy que retenga el stream. No usa la tabla `activity`.
- Web: `GET/POST /api/chat`, `GET /api/chat/:id`, `PATCH`/`DELETE /api/chat/:id`, `POST /api/chat/leido`, `GET /api/chat/contadores`, `GET /api/chat/usuarios`. Migración `018_chat.sql` (tablas `chat_messages`, `chat_mentions`, `chat_reads` y la entidad `mensaje` de la papelera); la `019` siembra la versión 1.7.0.

## Barra superior: versión, tasa BCV e historial de versiones

- **Versión actual + tasa BCV**: `GET /version` (MCP `hayai_version_ver`; web `GET /api/version`) devuelve `version` (la más alta publicada), `titulo`, `fecha_version`, `hoy` y `bcv { tasa, fecha, es_de_hoy, fuente, actualizada_el }`. La barra muestra *fecha / v1.6.0 / BCV Bs. 873,87*; `bcv.fecha` es **el día de la tasa** (fin de semana o feriado = la última publicada, con su fecha).
- **Tasa BCV**: la consulta el **servidor** (nunca el navegador) a `ve.dolarapi.com/v1/dolares/oficial` y, de respaldo, a `ve.dolarapi.com/v1/dolares` (se toma la fuente `oficial`). Se guarda en la tabla `exchange_rates` (una fila por día de la tasa): sobrevive a reinicios y, si ninguna fuente responde, se sigue mostrando **la última guardada** (`bcv` solo es `null` si nunca respondió). La respuesta sale siempre de la caché; pasados `BCV_TTL_MS` (30 min) la siguiente consulta dispara la actualización en segundo plano, y `BCV_REFRESH_MS` (30 min; `0` la apaga) la mantiene al día aunque nadie consulte. Una tasa con fecha más vieja no pisa a la más reciente; una fecha absurda (más de 4 días en el futuro) se descarta. `BCV_SOURCES="url1,url2"` cambia las fuentes (acepta el formato de DolarAPI: objeto, o lista con `fuente: "oficial"`).
- **Historial de versiones** (`GET`/`POST /versiones`; MCP `hayai_versiones_listar`, `hayai_version_publicar`; web `/api/versions`): changelog tipo releases. Cada entrada: `version` (mayor.menor.parche), `titulo`, `resumen`, `cambios` (lista), `fecha` (por defecto hoy, no futura) y `autor`, que sale **de la llave API o de la sesión**, nunca del cuerpo. Reglas: la versión nueva debe ser **mayor que la actual** (409; el orden es numérico: 1.10.0 va después de 1.9.0), no se repite (409) y **solo se agrega**: no hay editar ni borrar. Publicar avisa al equipo (`version_nueva`). La migración 011 deja publicadas la `1.0.0` («Lanzamiento inicial», sin autor individual: «Equipo HAYAI») y la `1.5.0`; la 016 siembra la `1.6.0` «Feed de oportunidades» y la 018 la `1.6.5` «Órbita fina» y la 020 la `1.7.0` «Chat interno» la 021 la `1.6.6` «Órbita fina II» y la 022 la `1.6.7` «Órbita fina III» (ambas quedan debajo de la 1.7.0: el historial se ordena por número) (el servidor las anuncia una vez al arrancar). La 018 renombró la `1.0.0` (antes con otro título). En la pantalla el historial es de solo lectura: las versiones se publican por la API o el MCP.
- Variables: `BCV_SOURCES`, `BCV_TTL_MS`, `BCV_REFRESH_MS`, `BCV_TIMEOUT_MS` (8 s).
- **Aviso de actualización** (una sola fuente de verdad: la versión más alta de `app_versions`). Se avisa **una vez por versión** (`anunciada_el`): al publicarla (web, API o MCP) o, si la sembró una migración, al arrancar el sistema ya desplegado (`ANNOUNCE_VERSION=false` lo apaga en desarrollo/pruebas). De ahí salen: (1) la alerta «Nueva actualización vX.Y.Z disponible» en la campana (tipo `actualizacion`, `version`, visible 14 días, leída por socio) con «Ver cambios»; (2) el evento en vivo `version_nueva` (SSE) que dispara el banner «Recargar página»; (3) lo que consultan los agentes: cabecera **`X-Hayai-Version`** en cada respuesta de `/api`, `/api/v1` y `/mcp`, `GET /version?desde=<tu última versión>` (trae `novedades.hay_cambios` y las versiones nuevas), `GET /versiones?desde=` y las instrucciones del MCP. **Despliegue:** publica la versión después de desplegar, o siémbrala en una migración.
- **Conflictos al guardar** (aditivo: sin versión enviada, todo funciona como antes). Las lecturas traen `actualizado_el` (web: `updatedAt`). Para guardar solo si nadie cambió el registro, envía esa marca como cabecera **`If-Match`** o como campo `actualizado_el` en el PATCH/PUT (en MCP, el parámetro opcional `actualizado_el`). Si cambió: **409** `{ codigo: "conflicto", actualizado_el: <marca actual> }` y no se guarda nada. Cubre clientes, proyectos, tareas, cobros, gastos, acuerdos y propuestas; no cubre (por ahora) interacciones, hitos, checklist ni sistemas.
- Etapas del pipeline (nombres aprobados; claves y probabilidades no cambian): `prospecto` Prospecto captado 10 % · `visita_agendada` 20 % · `visita_realizada` 35 % · `propuesta_en_armado` 50 % · `propuesta_presentada` Segunda visita 70 % · `ganado` 100 % · `perdido` 0 %. Fuente única: `GET /pipeline/etapas`.

## Papelera y archivo

- **Papelera**: borrar (desde la web, la API o el MCP) no destruye. La fila y todo lo que cuelga de ella (un cliente se lleva sus cobros, proyectos, tareas, gastos e interacciones) se guardan en la tabla `trash` y se restauran con los mismos ids. Se vacía sola a los 30 días. Desde la web: menú de la cuenta → **Papelera y archivo** (restaurar, o eliminar definitivamente). Restaurar un proyecto cuyo cliente sigue borrado da 409: restaura primero el cliente. La inicial no se borra como un cobro: se edita desde sus ítems.
- **Archivo**: archivar un cliente o proyecto lo oculta de las pantallas de trabajo (Clientes, Proyectos, Tareas, calendario) sin tocar su historial: **Finanzas sigue contando todo**. Se archiva desde la ficha de edición y se recupera en Papelera y archivo. Los proyectos y tareas de un cliente archivado se ocultan con él.

## Actividad del equipo, avisos en vivo y búsqueda

- **Qué se avisa** (solo esto): cliente nuevo, posible cliente nuevo, tarea nueva, tarea completada (solo al pasar a hecha), cobro cobrado (solo al pasar de pendiente a cobrado, venga de la web, la API o el MCP: «Leandro registró el cobro de $120 a X»), cambio de etapa («Leandro movió a X (Prospecto → Visita agendada)»), cliente ganado y posible marcado como perdido (con su motivo). Se guarda en la tabla `activity` dentro de la misma transacción del cambio y se purga a los 60 días.
- **Quién figura**: el nombre del socio, nunca el de la herramienta. Si una llave de API (Muse, Growi) crea algo, el aviso dice «Leandro añadió…» si la llave es de Leandro; la llave solo queda en `via`.
- **Web**: campana con dos pestañas (Alertas · Equipo), contador de no leídos y popup lateral para todos menos para quien hizo el cambio. Llega por SSE (`GET /api/events`, con `Last-Event-ID`/`desde_id` para recuperar lo perdido) y, si un proxy retiene el stream, por un sondeo cada 30 s. «Visto hasta» es por socio (tabla `activity_seen`).
- **Búsqueda**: Ctrl/Cmd+K o `/` abre la paleta (clientes, proyectos, tareas); al elegir un cliente se abre su cajón con el enlace `#clientes/<id>`.
- **API**: `GET /api/v1/actividad` (`tipo`, `desde_id`, `orden=asc|desc`, `page`, `per_page`; devuelve `meta.sin_leer`, `visto_hasta`, `ultimo_id`) y `POST /api/v1/actividad/leer` (`hasta_id` o `todas:true`; nunca retrocede). Lectura: `GET /api/v1/notificaciones` y `GET /api/v1/buscar?q=`. MCP: `hayai_actividad_listar`, `hayai_actividad_marcar_leida`.
