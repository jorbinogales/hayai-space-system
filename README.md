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
- **Llaves**: cada llave pertenece a un socio; todo lo que escriba queda atribuido a él.

### Crear una llave

```bash
# local
npm run apikey -- create --user Leandro --name growi
# VPS
docker compose -f docker-compose.prod.yml exec app node_modules/.bin/tsx server/src/apikey-cli.ts create --user Leandro --name growi
```

La llave (`hy_...`) se muestra **una sola vez**; en la base solo queda su hash SHA-256. También: `apikey list` y `apikey revoke <prefijo|id>`.

```bash
curl -H "X-API-Key: hy_..." https://space.hayai.com.ve/api/v1/me
```

### Contrato REST

Campos en español y snake_case, montos en USD como número, fechas `AAAA-MM-DD` (zona `APP_TZ`, por defecto America/Caracas). Listas: `{ "data": [...], "meta": { page, per_page, total, ... } }` con `?page=` y `?per_page=` (máx. 100). Errores: `{ "error": { "code", "message" } }` (`validation_error`, `unauthorized`, `not_found`, `conflict`, `rate_limited`...). Los esquemas son estrictos: un campo desconocido devuelve 400. No existe DELETE.

| Recurso | Endpoints |
|---|---|
| Clientes | `GET /clientes`, `GET /clientes/:id`, `POST /clientes`, `PATCH /clientes/:id` |
| Pagos | `GET /pagos`, `POST /clientes/:cliente_id/pagos`, `PATCH /pagos/:id` |
| Proyectos | `GET /proyectos`, `GET /proyectos/:id`, `POST /proyectos`, `PATCH /proyectos/:id` |
| Gastos | `GET /gastos`, `GET /gastos/:id`, `POST /gastos`, `PATCH /gastos/:id` |
| Tareas | `GET /tareas`, `GET /tareas/:id`, `POST /tareas`, `PATCH /tareas/:id` |
| Finanzas | `GET /finanzas/resumen?periodo=mes\|anio\|todo` |

### MCP

17 herramientas (`hayai_clientes_listar`, `hayai_cliente_crear`, `hayai_proyecto_estado`, `hayai_gasto_registrar`, `hayai_finanzas_resumen`, `hayai_tarea_crear`, `hayai_pago_marcar_cobrado`...). Llaman a los mismos servicios que la REST, así que validan y atribuyen igual. Los errores de negocio vuelven como resultado con `isError`. Las peticiones deben llevar `Accept: application/json, text/event-stream`.

Conectar Growi: conector personalizado `custom.hayai-space` → URL `https://space.hayai.com.ve/mcp`, header `X-API-Key` con la llave guardada en su Secure Vault. Probar con `hayai_finanzas_resumen` y `hayai_tareas_listar`.

### Variables de entorno

`V1_RATE_MAX` (peticiones/min por llave, 120), `V1_AUTH_FAIL_MAX` (intentos fallidos por IP cada 15 min, 30), `APP_TZ` (America/Caracas). Si hay un proxy delante, `/api/v1` y `/mcp` deben pasar tal cual (Caddy lo hace con la configuración actual).

### Diferencias con el SPEC (decididas y documentadas)

- No hay campo `contacto` (el sistema no lo guarda): se rechaza con 400 en vez de ignorarlo.
- Estado de proyecto `visita` ↔ `planeacion` interno.
- Las tareas pertenecen siempre a un proyecto (`proyecto_id` obligatorio) y no tienen asignado: se devuelve `creada_por`.
- Sin DELETE ni archivado.
- Añadidos fuera del SPEC: pagos (REST y MCP) y los GET de detalle. No se exponen los endpoints de prospectos.
