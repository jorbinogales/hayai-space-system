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
| Clientes | `GET /clientes`, `GET /clientes/:id`, `POST /clientes`, `PATCH /clientes/:id` |
| Pagos | `GET /pagos`, `POST /clientes/:cliente_id/pagos`, `PATCH /pagos/:id` |
| Proyectos | `GET /proyectos`, `GET /proyectos/:id`, `POST /proyectos`, `PATCH /proyectos/:id` |
| Gastos | `GET /gastos`, `GET /gastos/:id`, `POST /gastos`, `PATCH /gastos/:id` |
| Tareas | `GET /tareas`, `GET /tareas/:id`, `POST /tareas`, `PATCH /tareas/:id` |
| Finanzas | `GET /finanzas/resumen?periodo=mes\|anio\|todo` |
| Borrar (permiso `delete`) | `DELETE /clientes/:id`, `/pagos/:id`, `/proyectos/:id`, `/gastos/:id`, `/tareas/:id` |
| Papelera | `GET /papelera`, `POST /papelera/:id/restaurar` (escritura) |
| Archivo | `PATCH /clientes/:id` y `/proyectos/:id` con `{"archivado": true\|false}`; los listados aceptan `?archivados=excluir\|incluir\|solo` |

### MCP

25 herramientas: 9 de lectura, 11 de escritura y 5 de borrado (`hayai_clientes_listar`, `hayai_cliente_crear`, `hayai_proyecto_estado`, `hayai_gasto_registrar`, `hayai_finanzas_resumen`, `hayai_papelera_restaurar`, `hayai_cliente_eliminar`...). Llaman a los mismos servicios que la REST, así que validan y atribuyen igual. Los errores de negocio vuelven como resultado con `isError`. Las peticiones deben llevar `Accept: application/json, text/event-stream`.

Conectar Growi: conector personalizado `custom.hayai-space` → URL `https://space.hayai.com.ve/mcp`, header `X-API-Key` con la llave guardada en su Secure Vault. Probar con `hayai_finanzas_resumen` y `hayai_tareas_listar`.

### Variables de entorno

`V1_RATE_MAX` (peticiones/min por llave, 120), `V1_AUTH_FAIL_MAX` (intentos fallidos por IP cada 15 min, 30), `APP_TZ` (America/Caracas). Si hay un proxy delante, `/api/v1` y `/mcp` deben pasar tal cual (Caddy lo hace con la configuración actual).

### Diferencias con el SPEC (decididas y documentadas)

- No hay campo `contacto` (el sistema no lo guarda): se rechaza con 400 en vez de ignorarlo.
- Estado de proyecto `visita` ↔ `planeacion` interno.
- Las tareas pertenecen siempre a un proyecto (`proyecto_id` obligatorio) y no tienen asignado: se devuelve `creada_por`.
- El SPEC no tenía DELETE: se añadió con permiso propio y siempre a la papelera (recuperable 30 días).
- Añadidos fuera del SPEC: pagos, papelera, archivo y los GET de detalle. No se exponen los endpoints de prospectos.

## Papelera y archivo

- **Papelera**: borrar (desde la web, la API o el MCP) no destruye. La fila y todo lo que cuelga de ella (un cliente se lleva sus cobros, proyectos, tareas y gastos) se guardan en la tabla `trash` y se restauran con los mismos ids. Se vacía sola a los 30 días. Desde la web: menú de la cuenta → **Papelera y archivo** (restaurar, o eliminar definitivamente). Restaurar un proyecto cuyo cliente sigue borrado da 409: restaura primero el cliente. La inicial no se borra como un cobro: se edita desde sus ítems.
- **Archivo**: archivar un cliente o proyecto lo oculta de las pantallas de trabajo (Clientes, Proyectos, Tareas, calendario) sin tocar su historial: **Finanzas sigue contando todo**. Se archiva desde la ficha de edición y se recupera en Papelera y archivo. Los proyectos y tareas de un cliente archivado se ocultan con él.
