# Tablero (kanban): contrato para el frontend

Esquema: `server/db/migrations/040_tablero.sql`. Módulo `tablero`. Un tablero por tenant, con 4 columnas por defecto (las siembra la BD).
Todas las rutas van bajo `/api/board`, con `X-Tenant-Id` (ver `MULTITENANT.md`). Sin el módulo: `403 {codigo:'modulo_sin_acceso', modulo:'tablero'}`.
Un id de otro tenant (tarjeta, columna, cliente) responde **404**. Errores: `{ error, codigo? }`.

## Formas

```ts
Board   = { id, name, columns: Column[] }                       // columnas en orden; cada una con sus tarjetas NO archivadas en orden
Column  = { id, name, position, cards?: Card[] }                // cards solo en GET /board
Card    = { id, columnId, position, title, description: string|null, priority: 'baja'|'media'|'alta'|'urgente', dueDate: 'AAAA-MM-DD'|null,
            archivedAt: ISO|null, assignee: {id, name, avatar}|null, client: {id, name}|null, comments: number,
            createdBy: {id, name}, createdAt: ISO, updatedAt: ISO }   // updatedAt = versión del CONTENIDO (If-Match)
Comment = { id, cardId, author: {id, name, avatar}, body, editedAt: ISO|null, createdAt: ISO }
```

`position` es informativo: el orden es el de los arrays. Nunca lo mande el navegador.

## Orden: `afterId`

Crear o mover recibe `afterId` = el id del elemento (de la columna destino / del tablero) tras el que va:
- `afterId: null` → arriba (la primera); **sin `afterId`** → al final; `afterId: <id>` → justo después de ese.
- El servidor calcula la posición en la transacción, con los vecinos reales de la BD (dos arrastres al mismo hueco no empatan).
- `afterId` que no está en la columna destino (o en el tablero) → 400; igual al propio id → 400.
- Tras soltar, lo más simple es aplicar el cambio optimista y re-leer `GET /board` cuando llegue el SSE.

## Rutas

| Método y ruta | Cuerpo | Respuesta |
|---|---|---|
| `GET /board` | — | `Board` |
| `GET /board/members` | — | `[{id, name, avatar}]`: quienes pueden ser responsables (socios activos con el módulo, y los ADMIN) |
| `POST /board/columns` | `{name (≤60), afterId?}` | 201 `Column` |
| `PATCH /board/columns/:id` | `{name?, afterId?}` (al menos uno; `afterId` reordena) | `Column` |
| `DELETE /board/columns/:id` | — | 204. A la papelera (`columna`) con TODAS sus tarjetas (archivadas incluidas) y comentarios |
| `GET /board/cards/archived` | — | `Card[]` (lo último archivado primero) |
| `POST /board/cards` | `{columnId, title (≤200), description? (≤4000), priority? ='media', assigneeId?, clientId?, dueDate?, afterId?}` | 201 `Card` |
| `GET /board/cards/:id` | — | `Card` (también archivada) |
| `PATCH /board/cards/:id` | `{title?, description?, priority?, assigneeId?, clientId?, dueDate?}` + cabecera `If-Match: <updatedAt>` | `Card` · 409 `{codigo:'conflicto', actualizado_el}` si cambió |
| `POST /board/cards/:id/move` | `{columnId, afterId?}` (sirve para reordenar en la misma columna) | `Card` |
| `POST /board/cards/:id/archive` · `/unarchive` | `{}` | `Card` (vuelve a su lugar) |
| `DELETE /board/cards/:id` | — | 204. A la papelera (`tarjeta`) con sus comentarios |
| `GET /board/cards/:id/comments` | — | `Comment[]` (del más viejo al más nuevo) |
| `POST /board/cards/:id/comments` | `{body (≤4000)}` | 201 `Comment` |
| `PATCH /board/comments/:id` | `{body}` | `Comment` (marca `editedAt`) · 403 si no es el autor ni ADMIN |
| `DELETE /board/comments/:id` | — | 204 (definitivo) · 403 si no es el autor ni ADMIN |

Notas:
- En PATCH, campo ausente = no cambia; `null` = lo borra (`description`, `assigneeId`, `clientId`, `dueDate`). `description: ''` = sin descripción.
- `If-Match` es opcional (sin él se guarda igual). Mover, reordenar y archivar **no** cambian `updatedAt`: arrastrar no le da 409 a quien edita.
- `assigneeId` debe ser un socio activo del tenant con el módulo `tablero` (o ADMIN): si no, `400 {codigo:'responsable_invalido'}`.
  Los candidatos salen de `GET /board/members`.
- `clientId` de otro tenant o inexistente → 404 `Cliente no encontrado`.
- Papelera (`/api/trash`): entidades `tarjeta` y `columna`. Restaurar una tarjeta cuya columna ya no existe → 409 (restaura antes la columna).
  Si su cliente ya no existe vuelve sin cliente; restaurar un cliente vuelve a enlazar sus tarjetas.

## Actividad

Tipos nuevos (módulo `tablero`), con `tarjeta_id` en cada aviso: `tarjeta_nueva` («X añadió la tarjeta «T» en Columna»),
`tarjeta_movida` (solo al cambiar de columna: «… a Columna»), `tarjeta_comentada`, `tarjeta_asignada` («… a Socio», solo si cambia).
Editar, reordenar, archivar o borrar no avisan.

## En vivo (SSE)

En el mismo `GET /api/events?tenant=<id>`, solo para quien tiene el módulo `tablero`:

```
event: tablero
data: {"op":"nuevo"|"editado"|"borrado","seccion":"columnas"|"tarjetas"|"comentarios","id":"<uuid>"}
```

`id` = la columna (`columnas`) o la tarjeta (`tarjetas` y `comentarios`). Sin datos: re-lee `GET /board` (con un debounce corto: un
renumerado manda un aviso por tarjeta) o, si está abierta, la tarjeta y sus comentarios. Sin `id:` en el frame (no toca `Last-Event-ID`):
al reconectar, re-lee el tablero.

## API v1 y MCP (llave)

`GET /api/v1/tablero` · `POST /api/v1/tablero/tarjetas {columna_id, titulo, descripcion?, prioridad?, responsable? (nombre), cliente_id?, vence?, despues_de?}` ·
`POST /api/v1/tablero/tarjetas/:id/mover {columna_id, despues_de?}` · `POST /api/v1/tablero/tarjetas/:id/comentarios {texto}`.
MCP: `hayai_tablero_ver`, `hayai_tarjeta_crear`, `hayai_tarjeta_mover`, `hayai_tarjeta_comentar`.
