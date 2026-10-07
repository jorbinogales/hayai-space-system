-- 008_actividad: lo que hace cada socio (cliente nuevo, tarea nueva, tarea completada) para avisar al resto en vivo.
-- Lo aplica server/db/migrate.mjs dentro de una transaccion; no lo edites una vez aplicado (crea 009_*.sql).
--
-- Decisiones (ver el diseno aprobado):
--  - Se escribe en la MISMA transaccion que el cambio (web, API o MCP) y la misma transaccion hace pg_notify: el aviso solo
--    sale si el cambio se confirma. El texto del aviso nombra al DUENO de la llave ("Leandro anadio..."), nunca a la herramienta;
--    la via ('web', 'api:<llave>') se guarda solo como dato de auditoria.
--  - client_id / project_id / task_id NO tienen FK a proposito: si despues borran el cliente, el aviso se conserva y solo pierde el enlace.
--  - El id (identity) es el cursor de lectura y de reenvio: "dame lo posterior a N".
CREATE TABLE activity (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('cliente_nuevo', 'posible_nuevo', 'tarea_nueva', 'tarea_completada')),
  actor_id   uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  client_id  uuid,
  project_id uuid,
  task_id    uuid,
  subject    text NOT NULL CHECK (btrim(subject) <> ''),  -- nombre del cliente o titulo de la tarea, tal como estaba
  detail     text,                                         -- tareas: el proyecto al que pertenecen
  via        text NOT NULL DEFAULT 'web' CHECK (btrim(via) <> ''),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_created_idx ON activity (created_at);

-- "Visto hasta" de cada socio: lo posterior a seen_id y hecho por otro cuenta como sin leer. Se crea al primer acceso
-- (en el ultimo id de ese momento, para que nadie arranque con un monton de avisos viejos).
CREATE TABLE activity_seen (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  seen_id bigint NOT NULL DEFAULT 0 CHECK (seen_id >= 0)
);
