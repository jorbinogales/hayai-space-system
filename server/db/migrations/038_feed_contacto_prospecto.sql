-- 038_feed_contacto_prospecto: estado de contacto del prospecto en el Feed (Release 1.8.3 «Órbita fina IV»).
-- Un potencial del feed ya no es solo «nuevo»: el equipo marca qué pasó al escribirle y el estado es GLOBAL
-- (lo ve todo el equipo), a diferencia de revisar/descartar, que son personales.
--   sin_contactar: nadie le escribió todavía (así nacen todos los ítems).
--   contactado: se marcó «Marcar contactado»; esperando respuesta.
--   contactado_sin_respuesta: se marcó «Sin respuesta»; queda en seguimiento con próxima acción y fecha.
--   respondio_positivo: respondió bien; al convertirlo en cliente potencial queda también «convertido».
--   respondio_negativo: respondió que no; va a la bandeja de descarte (filtro contacto=respondio_negativo),
--     con motivo, y se restaura a sin_contactar.
-- La máquina de estados vive en el servidor (feedMarcarContacto); aquí solo van las columnas y el CHECK.
ALTER TABLE feed_items ADD COLUMN estado_contacto text NOT NULL DEFAULT 'sin_contactar'
  CHECK (estado_contacto IN ('sin_contactar', 'contactado', 'contactado_sin_respuesta', 'respondio_positivo', 'respondio_negativo'));
-- Cuándo se marcó contactado (de ahí salen los «días desde el envío» de la tarjeta).
ALTER TABLE feed_items ADD COLUMN contactado_el timestamptz;
-- Motivo de la respuesta negativa (la bandeja de descarte lo muestra). Solo vale en respondio_negativo.
ALTER TABLE feed_items ADD COLUMN contacto_motivo text
  CHECK (contacto_motivo IS NULL OR (contacto_motivo = btrim(contacto_motivo) AND contacto_motivo <> '' AND length(contacto_motivo) <= 200));
-- Próxima acción y fecha del seguimiento cuando no hubo respuesta (por defecto «Volver a escribir», hoy + 3 días).
ALTER TABLE feed_items ADD COLUMN seguimiento_accion text
  CHECK (seguimiento_accion IS NULL OR (seguimiento_accion = btrim(seguimiento_accion) AND seguimiento_accion <> '' AND length(seguimiento_accion) <= 120));
ALTER TABLE feed_items ADD COLUMN seguimiento_fecha date;
ALTER TABLE feed_items
  ADD CONSTRAINT feed_contacto_motivo_ck CHECK (contacto_motivo IS NULL OR estado_contacto = 'respondio_negativo'),
  ADD CONSTRAINT feed_contacto_seguimiento_ck CHECK ((seguimiento_accion IS NULL AND seguimiento_fecha IS NULL) OR estado_contacto = 'contactado_sin_respuesta');

-- El filtro de la bandeja y los contadores por_contacto solo miran potenciales.
CREATE INDEX feed_items_estado_contacto_idx ON feed_items (estado_contacto) WHERE kind = 'potencial';
