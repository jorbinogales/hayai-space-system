-- 030_feed_guion_versiones: el guión de un prospecto del feed (datos.guion) pasa a ser versionado.
-- Lo aplica server/db/migrate.mjs dentro de una transacción; no lo edites una vez aplicado (crea 031_*.sql).
--
-- Decisiones:
--  - Una fila por versión. NADA se borra ni se pisa: editar o «restablecer al original» agrega una versión nueva.
--    El guión vigente es la versión con el nro más alto; el original es la fila tipo 'original' (una sola por ítem).
--  - Tipos: 'original' (como lo publicó la fuente; inmutable) · 'previo' (versión 0: respaldo del guión anterior cuando se reescribe
--    el original, ver server/src/feed-guiones.ts) · 'edicion' (la guardó un socio) · 'restablecido' (volvió al original).
--  - base_nro: sobre qué versión estaba mirando quien guardó (si hay otra más nueva, pisó a alguien y quedó dicho).
--  - editado_por es NULL cuando lo hizo el sistema (la reescritura masiva); si no, el socio.
--  - El trigger garantiza la inmutabilidad en la base y no solo en el código: ni UPDATE ni DELETE, salvo (1) el borrado en cascada
--    cuando se elimina el ítem entero y (2) la reescritura del original, que el script de mantenimiento declara con
--    SET LOCAL hayai.guion_reescritura = 'on' y solo puede tocar contenido, autor y fecha de la fila 'original'.
CREATE TABLE feed_guion_versiones (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid NOT NULL REFERENCES feed_items (id) ON DELETE CASCADE,
  nro         integer NOT NULL CHECK (nro >= 0),
  contenido   text NOT NULL CHECK (btrim(contenido) <> '' AND length(contenido) <= 4000),
  tipo        text NOT NULL CHECK (tipo IN ('original', 'previo', 'edicion', 'restablecido')),
  editado_por uuid REFERENCES users (id) ON DELETE RESTRICT,
  editado_en  timestamptz NOT NULL DEFAULT now(),
  base_nro    integer CHECK (base_nro IS NULL OR base_nro >= 0),
  CONSTRAINT feed_guion_nro_uq UNIQUE (item_id, nro)
);
CREATE UNIQUE INDEX feed_guion_original_uq ON feed_guion_versiones (item_id) WHERE tipo = 'original';

CREATE FUNCTION feed_guion_inmutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- En el borrado en cascada el ítem ya no existe; borrar versiones sueltas de un ítem vivo no se permite.
    IF EXISTS (SELECT 1 FROM feed_items WHERE id = OLD.item_id) THEN
      RAISE EXCEPTION 'Las versiones del guion no se borran' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF current_setting('hayai.guion_reescritura', true) = 'on' AND OLD.tipo = 'original' AND NEW.tipo = 'original'
     AND NEW.item_id = OLD.item_id AND NEW.nro = OLD.nro AND NEW.id = OLD.id THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Las versiones del guion no se modifican: guarda una versión nueva' USING ERRCODE = 'integrity_constraint_violation';
END $$;
CREATE TRIGGER feed_guion_inmutable BEFORE UPDATE OR DELETE ON feed_guion_versiones FOR EACH ROW EXECUTE FUNCTION feed_guion_inmutable();

-- Los guiones que ya existen quedan como versión 1 (original), a nombre de quien publicó el ítem y con la fecha de publicación.
INSERT INTO feed_guion_versiones (item_id, nro, contenido, tipo, editado_por, editado_en)
SELECT id, 1, btrim(data ->> 'guion'), 'original', published_by, created_at
  FROM feed_items
 WHERE jsonb_typeof(data -> 'guion') = 'string' AND btrim(data ->> 'guion') <> '' AND length(btrim(data ->> 'guion')) <= 4000;
