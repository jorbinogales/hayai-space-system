-- 028_potencial: «prospecto» pasa a llamarse «potencial». Un prospecto es alguien con quien aún no pasa nada; un potencial ya hizo contacto y sabe
-- que existimos. Solo cambian nombres: ningún dato, probabilidad, fecha ni monto se mueve. Sin versionado: no agrega entrada al historial de versiones.
-- Idempotente: correrla otra vez no cambia nada.

-- 1) La etapa del pipeline: clave `prospecto` → `potencial`, nombre «Potencial captado». clients.pipeline_stage la sigue por la FK (ON UPDATE CASCADE).
UPDATE pipeline_stages SET key = 'potencial', label = 'Potencial captado' WHERE key = 'prospecto';

-- 2) Lo que la bitácora y los avisos del equipo ya tenían escrito de esa etapa (claves en meta, nombres en el texto).
UPDATE interactions SET meta = jsonb_set(meta, '{a}', '"potencial"') WHERE kind = 'etapa' AND meta->>'a' = 'prospecto';
UPDATE interactions SET meta = jsonb_set(meta, '{de}', '"potencial"') WHERE kind = 'etapa' AND meta->>'de' = 'prospecto';
UPDATE interactions SET summary = regexp_replace(regexp_replace(summary, '^Prospecto captado(?= →)', 'Potencial captado'), '(→ )Prospecto captado(?=$| \()', '\1Potencial captado')
  WHERE kind = 'etapa' AND summary ~ 'Prospecto captado';
UPDATE activity SET detail = regexp_replace(regexp_replace(detail, '^Prospecto captado(?= →)', 'Potencial captado'), '(→ )Prospecto captado(?=$| ·)', '\1Potencial captado')
  WHERE kind = 'cambio_etapa' AND detail ~ 'Prospecto captado';

UPDATE activity SET detail = 'potencial' WHERE kind = 'feed_nuevo' AND detail = 'prospecto';

-- 3) El tipo de ítem del feed: `prospecto` → `potencial` (el CHECK se reemplaza y los ítems se traducen).
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'feed_items'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%prospecto%' LOOP
    EXECUTE format('ALTER TABLE feed_items DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
UPDATE feed_items SET kind = 'potencial' WHERE kind = 'prospecto';
ALTER TABLE feed_items DROP CONSTRAINT IF EXISTS feed_items_kind_check;
ALTER TABLE feed_items ADD CONSTRAINT feed_items_kind_check CHECK (kind IN ('idea', 'potencial', 'alerta', 'noticia', 'oportunidad', 'proyecto'));

-- 4) Las notas del historial de versiones que decían «prospecto(s)» (texto visible): se reescriben con el nombre nuevo.
CREATE FUNCTION pg_temp.potencializa(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT regexp_replace(regexp_replace(regexp_replace(regexp_replace(t,
    '\mProspectos\M', 'Potenciales', 'g'), '\mprospectos\M', 'potenciales', 'g'), '\mProspecto\M', 'Potencial', 'g'), '\mprospecto\M', 'potencial', 'g')
$f$;
UPDATE app_versions SET
  title = pg_temp.potencializa(title),
  summary = pg_temp.potencializa(summary),
  changes = ARRAY(SELECT pg_temp.potencializa(x) FROM unnest(changes) WITH ORDINALITY AS u(x, n) ORDER BY n)
WHERE title ~* 'prospecto' OR summary ~* 'prospecto' OR array_to_string(changes, E'\n') ~* 'prospecto';
