# Multitenant: contrato para el frontend

Esquema: `server/db/migrations/039_multitenant.sql`. Un tenant es un espacio de trabajo aislado; hoy existe «HAYAI» (slug `hayai`).
ADMIN (`users.role = 'ADMIN'`; los 3 fundadores) es global: entra a todo tenant activo con todos los módulos, sin fila en `user_tenants`.
Un SOCIO entra solo a los tenants que tiene asignados, y en cada uno solo a sus módulos.

## Tenant activo: en cada petición, no en la sesión

- Todas las rutas `/api/*` (salvo `/api/auth/*` y `/api/admin/*`) exigen la cabecera **`X-Tenant-Id: <uuid del tenant>`**.
- El servidor valida en cada petición: que el tenant exista y esté activo, y que el usuario sea ADMIN o miembro. Después valida el módulo de la ruta.
- El tenant jamás se lee del cuerpo. Un id de otro tenant responde **404**, igual que uno que no existe.
- El frontend guarda el tenant elegido (por ejemplo en localStorage) y lo manda siempre. Si recibe `tenant_sin_acceso`, debe volver al selector de tenants.

## Login, `/auth/me` y `/auth/change-pin`

La misma forma de siempre, más `tenants`:

```json
{ "id": "uuid", "name": "Elis", "avatar": "nova", "role": "ADMIN" | "SOCIO", "mustChangePin": false,
  "tenants": [ { "id": "uuid", "name": "HAYAI", "slug": "hayai", "modules": ["hub", "feed", "..."] } ] }
```

- `tenants` trae solo los tenants activos a los que entra el usuario. Para un ADMIN son todos, con los 13 módulos.
- Un usuario puede tener `tenants: []`: el frontend debe mostrar «sin acceso».
- Usuario nuevo: entra con nombre y PIN `000000`, y recibe `mustChangePin: true`. Con eso, todo lo demás responde `403 {error:"pin_change_required"}` hasta que llame a `POST /auth/change-pin {currentPin:"000000", newPin}`.
- Módulos: `hub, feed, clientes, crm, cobros, proyectos, tareas, finanzas, marketing, sistemas, chat, integraciones, papelera`.

## Códigos de error

| HTTP | `codigo` | Cuándo |
|---|---|---|
| 400 | `tenant_requerido` | Falta `X-Tenant-Id` (o `?tenant=` en el SSE) |
| 403 | `tenant_sin_acceso` | El tenant no existe, está inactivo o el usuario no es miembro (una sola respuesta, sin pistas) |
| 403 | `modulo_sin_acceso` (+ `modulo`) | El usuario es miembro pero no tiene el módulo de la ruta |
| 403 | `solo_admin` | Un SOCIO llama a `/api/admin/*` o publica una versión (`POST /versions`) |
| 404 | — | El id es de otro tenant o no existe |

En la web el cuerpo es `{ error, codigo, modulo? }`. En v1 es `{ error: { code: 'forbidden', message, codigo, modulo? } }`.

## Mapa de módulo a rutas (web `/api`)

| Módulo | Rutas |
|---|---|
| hub | `/hub`, `/hub/brief`, `/team`, `/agreements` |
| feed | `/feed/*`, `/competidores` (radar) |
| clientes | `/clients` y `/clients/:id/*` (ficha, logo, archivo, convert), `/interactions` |
| crm | `/clients/:id/proposals`, `/proposals`, `/offerings`, `/pipeline`, `/prospects` |
| cobros | `/clients/:id/payments`, `/clients/:id/initial`, `/payments`, `/cobros/*`, `/receptores` |
| proyectos | `/projects/*`, `/milestones`, `/checklist` |
| tareas | `/tasks` |
| finanzas | `/expenses` |
| marketing | `/marketing/*` |
| sistemas | `/systems` |
| chat | `/chat` |
| integraciones | `/keys` |
| papelera | `/trash` |
| (solo membresía) | `/users`, `/version`, `/versions`, `/notifications`, `/search`, `/activity`, `/events` |

Las rutas de solo membresía filtran por módulo por dentro:

- alertas: las cuotas piden `cobros`, los seguimientos `clientes` y el feed `feed`;
- búsqueda: clientes, proyectos y tareas, cada uno con su módulo;
- actividad y SSE: cada tipo de aviso con su módulo (`version_nueva` le llega a todos).

Las conversiones desde el feed exigen el módulo de lo que crean.

La API v1 (`/api/v1`) y el MCP usan el mismo mapa con sus nombres: `clientes`, `pagos`, `gastos`, `tareas`, etc. El tenant sale de la llave, que es de un solo tenant: en v1 la cabecera `X-Tenant-Id` se ignora. `GET /api/v1/me` incluye `tenant {id, nombre, slug, modulos}`. Las herramientas MCP que se listan son las de los módulos del dueño de la llave.

## Llaves de API

`/api/keys` (módulo `integraciones`) lista, crea y revoca las llaves del usuario **en el tenant de la cabecera**. Cada llamada con la llave vuelve a comprobar que su dueño siga entrando a ese tenant (si no, 403).

Desde la terminal: `npm run apikey -- create --user X --name Y [--tenant slug]` (por defecto `hayai`).

## SSE (`GET /api/events`)

`EventSource` no manda cabeceras, así que el tenant va en la query:

```js
new EventSource(`/api/events?tenant=${tenantId}`, { withCredentials: true })
```

- Se valida igual que la cabecera (400 sin él, 403 sin acceso).
- La pestaña recibe solo los eventos de ese tenant: `actividad` (filtrada por módulos), `chat` (solo con el módulo chat) y `proyecto` (solo con el módulo proyectos).
- Al cambiar de tenant, cierra el EventSource y abre otro. `Last-Event-ID` reenvía solo la actividad del tenant.
- Si se quitan los accesos con un stream abierto, ese stream sigue abierto hasta que reconecte (máximo 25 minutos).

## Administración `/api/admin` (solo ADMIN; sin `X-Tenant-Id`)

| Método y ruta | Cuerpo | Respuesta |
|---|---|---|
| `GET /admin/tenants` | — | `[{id, name, slug, active, members, createdAt}]` |
| `POST /admin/tenants` | `{name}` (el slug se genera único: `otra-empresa`, `otra-empresa-2`…) | 201 tenant · 409 si el nombre ya existe |
| `PATCH /admin/tenants/:id` | `{name?, active?}` (desactivar = nadie entra, ni el ADMIN; no se borra) | tenant |
| `GET /admin/users` | — | `[{id, name, avatar, role, active, mustChangePin, createdAt, tenants:[{tenantId, name, slug, active, modules}]}]` |
| `POST /admin/users` | `{name, avatar?, role?='SOCIO', tenants?: [{tenantId, modules}]}`, PIN inicial `000000` | 201 usuario · 409 si el nombre ya existe |
| `PATCH /admin/users/:id` | `{active?, role?, avatar?}` (desactivar cierra sus sesiones; un admin no puede desactivarse ni quitarse el rol a sí mismo: 409) | usuario |
| `POST /admin/users/:id/reset-pin` | `{}`: vuelve a `000000` y `mustChangePin`, desbloquea y cierra sus sesiones | usuario |
| `PUT /admin/users/:id/tenants/:tenantId` | `{modules: [...]}` (asigna o reemplaza; `[]` = entra sin módulos) | usuario |
| `DELETE /admin/users/:id/tenants/:tenantId` | — | usuario · 404 si no tenía acceso |

Las filas `tenants` de un ADMIN son solo las explícitas: un ADMIN entra a todo de todas formas.
