-- 019_orbita_fina_ii (v1.6.6): lo que se crea desde un ítem del feed (posible cliente, cliente, tarea, proyecto, propuesta, seguimiento) queda
-- vinculado al ítem: sin duplicados («✓ Creada») y con «Deshacer». Lo aplica server/db/migrate.mjs dentro de una transacción; no lo edites
-- una vez aplicado (crea 020_*.sql).

CREATE TABLE feed_item_vinculos (
  item_id    uuid NOT NULL REFERENCES feed_items (id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('posible_cliente', 'cliente', 'tarea', 'proyecto', 'propuesta', 'seguimiento')),
  -- NULL mientras se está creando (el reclamo evita que dos socios dupliquen); sin FK a propósito: si luego mandan lo creado a la papelera, el rastro queda
  ref_id     uuid,
  created_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, kind)
);

-- Un ítem puede dar varias cosas (una de cada clase): converted_to sigue siendo la primera.
ALTER TABLE feed_items DROP CONSTRAINT feed_items_converted_to_check;
ALTER TABLE feed_items ADD CONSTRAINT feed_items_converted_to_check
  CHECK (converted_to IN ('posible_cliente', 'cliente', 'tarea', 'proyecto', 'propuesta', 'seguimiento'));

-- Lo ya convertido hasta hoy queda como su vínculo.
INSERT INTO feed_item_vinculos (item_id, kind, ref_id, created_by, created_at)
SELECT id, converted_to, converted_id, COALESCE(status_by, published_by), COALESCE(status_at, updated_at)
FROM feed_items WHERE status = 'convertido' AND converted_to IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO app_versions (version, title, summary, changes, released_on) VALUES
('1.6.6', 'Órbita fina II',
 'Los botones del feed se vuelven inteligentes: cada tarjeta propone su acción principal, convierte según el vínculo con el cliente y deja deshacer.',
 ARRAY[
   'Convertir según el vínculo: sin vincular, posible cliente; vinculado a un posible cliente, cliente; vinculado a un cliente, sin botón. Solo en prospectos y oportunidades.',
   'Aviso «Listo ✓» con «Deshacer» al convertir o crear: revierte en unos segundos.',
   'Una acción principal destacada por tarjeta: WhatsApp, Convertir, Crear propuesta, Crear proyecto, Registrar cobro o Ver origen.',
   'Crear propuesta desde una oportunidad vinculada, con el concepto precargado.',
   'Tarea, proyecto y propuesta nacen con el título, el resumen y el cliente del ítem.',
   'Sin duplicados: lo ya creado se muestra como «✓ Creada» y abre su detalle.',
   'Seguimiento en 3 días: una tarea con su fecha puesta.'
 ], DATE '2026-10-08')
ON CONFLICT (version) DO NOTHING;
