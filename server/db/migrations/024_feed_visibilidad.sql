-- Visibilidad de los ítems del feed: «equipo» (todos los socios, como hasta ahora) o «privado» (solo quien lo publicó).
-- Los ítems que ya existían quedan en «equipo». Un privado no se lista, no se cuenta, no avisa y no se puede abrir ni tocar por otros socios.
ALTER TABLE feed_items ADD COLUMN visibility text NOT NULL DEFAULT 'equipo' CHECK (visibility IN ('equipo', 'privado'));
CREATE INDEX feed_items_privados_idx ON feed_items (published_by) WHERE visibility = 'privado';
