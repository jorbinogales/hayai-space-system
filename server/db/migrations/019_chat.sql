-- 019_chat: chat interno entre astronautas (socios de users), icono de mensajes junto a la campana.
-- Lo aplica server/db/migrate.mjs dentro de una transacción; no lo edites una vez aplicado (crea 019_*.sql).
--
-- Decisiones:
--  - Un solo canal (todo el equipo). Autor = users.id; si escribe una app externa (API v1 / MCP), el autor es el DUEÑO de la llave
--    (como published_by en feed) y `source` es el origen lógico ('manual' si lo escribió un socio en la web).
--  - Idempotencia como en feed: (source, external_key) único cuando hay clave externa; reenviar lo mismo no duplica.
--  - Borrar = papelera (trash, entidad 'mensaje'): la fila sale de la tabla, así nada necesita "WHERE deleted_at IS NULL" y los
--    contadores de no leídos la descuentan solos. Las menciones van como hijas en la foto y vuelven al restaurar.
--  - Editar: edited_at (NULL = nunca editado) para mostrar "(editado)"; updated_at sigue siendo la versión del If-Match.
--  - Menciones normalizadas (mensaje, usuario): la app las resuelve al guardar (@Nombre -> users.id), no se parsean en SQL.
--  - Lectura: un "leído hasta" por socio (como activity_seen, pero por instante porque el id es uuid por la papelera).
--    Sin leer = mensajes de OTROS posteriores a read_at; menciones sin leer = las mías en esos mismos mensajes. Abrir el chat
--    avanza el cursor y apaga ambos contadores (un solo canal: verlo es leerlo).
CREATE TABLE chat_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id    uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  body         text NOT NULL CHECK (body = btrim(body) AND body <> '' AND length(body) <= 4000),
  source       text NOT NULL DEFAULT 'manual' CHECK (source ~ '^[a-z0-9][a-z0-9._-]{0,59}$'),
  external_key text CHECK (external_key IS NULL OR (external_key = btrim(external_key) AND external_key <> '' AND length(external_key) <= 200)),
  edited_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_messages_edited_ck CHECK (edited_at IS NULL OR edited_at >= created_at)
);
CREATE UNIQUE INDEX chat_messages_source_key_uq ON chat_messages (source, external_key) WHERE external_key IS NOT NULL;
-- Lista (lo más reciente primero, keyset por (created_at, id)) y contador de no leídos (created_at > read_at).
CREATE INDEX chat_messages_created_idx ON chat_messages (created_at DESC, id DESC);
CREATE TRIGGER chat_messages_updated_at BEFORE UPDATE ON chat_messages FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE chat_mentions (
  message_id uuid NOT NULL REFERENCES chat_messages (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX chat_mentions_user_idx ON chat_mentions (user_id, message_id); -- "mis menciones (sin leer)"

-- "Leído hasta" de cada socio. Se crea al primer acceso en now(), para que nadie arranque con todo el historial sin leer.
CREATE TABLE chat_reads (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE trash DROP CONSTRAINT trash_entity_check;
ALTER TABLE trash ADD CONSTRAINT trash_entity_check CHECK (entity IN
  ('cliente', 'proyecto', 'pago', 'gasto', 'tarea', 'interaccion', 'propuesta', 'hito', 'checklist_item', 'mensaje'));
