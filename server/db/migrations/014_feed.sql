-- 014_feed: Feed de oportunidades (planeta HAYAI / hub). La Bitácora cuenta lo que el equipo HIZO; el Feed trae lo que la máquina
-- y los agentes ENCONTRARON: ideas del radar, prospectos del cazador, negocios de las video-auditorías, alertas de competencia,
-- leads tibios, noticias y propuestas manuales de cualquier socio.
-- Lo aplica server/db/migrate.mjs dentro de una transacción; no lo edites una vez aplicado (crea 015_*.sql).
--
-- Decisiones:
--  - Varias vías de publicación al MISMO endpoint (crons de Growi, el Muse de cada socio con su llave, a futuro Gumloop directo):
--    por eso nada asume un único publicador. published_by sale de la llave (atribución por socio, como el resto del sistema) y
--    source es el origen lógico (qué automatización o qué Muse; 'manual' si lo escribió un socio a mano).
--  - Idempotencia: (source, external_key) es único cuando hay clave externa; volver a publicar lo mismo no duplica.
--  - data es JSON libre (negocio, fugas, guion, URLs, métricas): el feed no impone la forma de cada fuente.
--  - Convertir un ítem (a posible cliente, tarea o proyecto) deja constancia de en qué y quién; un ítem convertido ya no cambia.
CREATE TABLE feed_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title          text NOT NULL CHECK (title = btrim(title) AND title <> '' AND length(title) <= 160),
  summary        text CHECK (summary IS NULL OR (summary = btrim(summary) AND summary <> '' AND length(summary) <= 2000)),
  kind           text NOT NULL CHECK (kind IN ('idea', 'prospecto', 'alerta', 'noticia', 'oportunidad', 'proyecto')),
  source         text NOT NULL CHECK (source ~ '^[a-z0-9][a-z0-9._-]{0,59}$'),
  external_key   text CHECK (external_key IS NULL OR (external_key = btrim(external_key) AND external_key <> '' AND length(external_key) <= 200)),
  published_by   uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  status         text NOT NULL DEFAULT 'nuevo' CHECK (status IN ('nuevo', 'revisado', 'descartado', 'convertido')),
  discard_reason text CHECK (discard_reason IS NULL OR (discard_reason = btrim(discard_reason) AND discard_reason <> '' AND length(discard_reason) <= 200)),
  data           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object' AND pg_column_size(data) <= 65536),
  found_at       timestamptz NOT NULL DEFAULT now(),          -- fecha del hallazgo (por defecto, la de publicación)
  status_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  status_at      timestamptz,
  converted_to   text CHECK (converted_to IN ('posible_cliente', 'tarea', 'proyecto')),
  converted_id   uuid,                                         -- sin FK a propósito: si luego borran lo creado, el ítem conserva el rastro
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feed_discard_ck CHECK (discard_reason IS NULL OR status = 'descartado'),
  CONSTRAINT feed_converted_ck CHECK ((status = 'convertido') = (converted_to IS NOT NULL))
);
CREATE UNIQUE INDEX feed_items_source_key_uq ON feed_items (source, external_key) WHERE external_key IS NOT NULL;
CREATE INDEX feed_items_status_found_idx ON feed_items (status, found_at DESC);
CREATE INDEX feed_items_kind_idx ON feed_items (kind, found_at DESC);
CREATE INDEX feed_items_source_idx ON feed_items (source, found_at DESC);
CREATE TRIGGER feed_items_updated_at BEFORE UPDATE ON feed_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Aviso en vivo cuando llega una alerta, noticia o prospecto (lo trae el sistema o un agente: avisa a TODOS los socios).
ALTER TABLE activity DROP CONSTRAINT activity_kind_check;
ALTER TABLE activity ADD CONSTRAINT activity_kind_check CHECK (kind IN
  ('cliente_nuevo', 'posible_nuevo', 'tarea_nueva', 'tarea_completada', 'cobro_cobrado', 'cambio_etapa', 'cliente_ganado', 'cliente_perdido', 'lead_meta',
   'acuerdo_nuevo', 'sistema_caido', 'sistema_recuperado', 'version_nueva', 'feed_nuevo'));
