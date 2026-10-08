-- 018_orbita_fina (v1.6.5): feed por socio (estados personales, guardados, categoría), sello Growi, historial de versiones y su entrada.
-- Lo aplica server/db/migrate.mjs dentro de una transacción; no lo edites una vez aplicado (crea 019_*.sql).

-- ---------- Historial de versiones ----------
-- La 1.0.0 deja de llamarse «Versión de mierda» (dato, no esquema: solo se renombra esa entrada si conserva ese título).
UPDATE app_versions SET title = 'Lanzamiento inicial' WHERE version = '1.0.0' AND title = 'Versión de mierda';

-- La 1.6.5 se siembra aquí (como la 1.5.0 y la 1.6.0): sale con el despliegue y el servidor la anuncia una vez al arrancar.
INSERT INTO app_versions (version, title, summary, changes, released_on) VALUES
('1.6.5', 'Órbita fina',
 'El feed pasa a ser de cada socio, con scroll infinito, guardados, categorías y contactos de un toque. Los cobros se firman solos y las pantallas hablan más corto y con números venezolanos.',
 ARRAY[
   'Feed por socio: revisar, descartar y guardar son personales y no afectan a los demás; convertir en posible cliente o crear tareas lo ve todo el equipo.',
   'Feed con scroll infinito y carga por tandas, filtros de Guardados y por categoría, y el sello Growi en lo que encuentra.',
   'Prospectos con WhatsApp, Llamar o Email según el contacto que haya; sitio web y redes clicables. Noticias con resumen y «Ver origen».',
   'Crear tarea desde el feed eligiendo responsable (por defecto, tú). Botones «Convertir» y «Convertir con ajustes».',
   'El feed tiene su propia sección dentro del Hub de HAYAI.',
   'Cobros: «Recibido por» es, por defecto, quien lo registra (se puede cambiar). Etiquetas «Pagado por el cliente (Bs.)» y «Neto recibido ($)».',
   'Finanzas › Gastos con los filtros Este mes, Este año y Todo; sin chip «Solo internos» repetido.',
   'Campana con contador real; al instalar una versión, su aviso se marca como leído.',
   '«Por cobrar» del planeta Clientes cuadra con Finanzas; plurales y concordancias corregidos.',
   'Textos más cortos y directos en todo el sistema; números con coma decimal.',
   'El núcleo HAYAI tiene su tarjeta informativa, como los planetas.',
   'El historial de versiones queda de solo lectura.'
 ], DATE '2026-10-08')
ON CONFLICT (version) DO NOTHING;

-- ---------- Feed: categoría por ítem ----------
ALTER TABLE feed_items ADD COLUMN category text
  CHECK (category IS NULL OR (category = btrim(category) AND category = lower(category) AND category <> '' AND length(category) <= 40));
CREATE INDEX feed_items_category_idx ON feed_items (category, found_at DESC) WHERE category IS NOT NULL;

-- ---------- Feed: estado personal por socio ----------
-- feed_items.status pasa a ser lo GLOBAL: 'nuevo' o 'convertido' (convertir y las tareas creadas las ve todo el equipo).
-- Revisar, descartar y guardar son de cada socio y viven aquí; sin fila (o sin status) = «nuevo» para ese socio.
CREATE TABLE feed_item_usuarios (
  item_id        uuid NOT NULL REFERENCES feed_items (id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status         text CHECK (status IN ('revisado', 'descartado')),
  discard_reason text CHECK (discard_reason IS NULL OR (discard_reason = btrim(discard_reason) AND discard_reason <> '' AND length(discard_reason) <= 200)),
  saved          boolean NOT NULL DEFAULT false,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, user_id),
  CONSTRAINT feed_user_reason_ck CHECK (discard_reason IS NULL OR status = 'descartado')
);
CREATE INDEX feed_item_usuarios_user_idx ON feed_item_usuarios (user_id, item_id);

-- Lo revisado o descartado hasta hoy era global: pasa a ser personal de quien lo marcó; para el resto vuelve a «nuevo».
INSERT INTO feed_item_usuarios (item_id, user_id, status, discard_reason)
SELECT id, status_by, status, discard_reason FROM feed_items WHERE status IN ('revisado', 'descartado') AND status_by IS NOT NULL
ON CONFLICT DO NOTHING;
UPDATE feed_items SET status = 'nuevo', discard_reason = NULL, status_by = NULL, status_at = NULL WHERE status IN ('revisado', 'descartado');

-- ---------- Sello Growi ----------
-- Lo que traía la fuente «gumloop-video-auditorias» (los prospectos de las video-auditorías) pasa a la fuente «growi».
-- Si ya existiera el mismo (growi, clave_externa) no se renombra ese ítem (la clave es única por fuente).
UPDATE feed_items f SET source = 'growi'
WHERE f.source = 'gumloop-video-auditorias'
  AND NOT (f.external_key IS NOT NULL AND EXISTS (SELECT 1 FROM feed_items g WHERE g.source = 'growi' AND g.external_key = f.external_key));
-- Las alertas de la campana llevan la fuente en su clave: se trasladan las lecturas para que no reaparezcan sin leer.
UPDATE notification_reads SET key = replace(key, ':gumloop-video-auditorias:', ':growi:')
WHERE key LIKE 'feed:%:gumloop-video-auditorias:%'
  AND NOT EXISTS (SELECT 1 FROM notification_reads n2 WHERE n2.user_id = notification_reads.user_id AND n2.key = replace(notification_reads.key, ':gumloop-video-auditorias:', ':growi:'));
