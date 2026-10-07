-- 013_bitacora_nombres_etapas: las entradas viejas de cambio de etapa (bitácora del cliente y avisos del equipo) llevan escrito el
-- nombre que la etapa tenía al registrarlas ("Prospecto", "Propuesta presentada"). La migración 012 renombró las etapas
-- (Prospecto captado, Segunda visita): aquí se reescribe SOLO ese texto con los nombres vigentes. Cosmético: no cambia ningún
-- dato (ni etapas, ni probabilidades, ni fechas, ni montos) y es idempotente (correrla otra vez no cambia nada).

-- Bitácora del cliente: el texto se rearma con las claves de etapa que cada entrada ya guarda en meta (de → a),
-- conservando el sufijo " (propuesta vN)" si lo trae.
UPDATE interactions i SET summary =
    COALESCE((SELECT label FROM pipeline_stages WHERE key = i.meta->>'de'), 'Sin etapa')
    || ' → ' || (SELECT label FROM pipeline_stages WHERE key = i.meta->>'a')
    || COALESCE(substring(i.summary FROM ' \(propuesta v[0-9]+\)$'), '')
WHERE i.kind = 'etapa'
  AND EXISTS (SELECT 1 FROM pipeline_stages WHERE key = i.meta->>'a')
  AND i.summary IS DISTINCT FROM (
    COALESCE((SELECT label FROM pipeline_stages WHERE key = i.meta->>'de'), 'Sin etapa')
    || ' → ' || (SELECT label FROM pipeline_stages WHERE key = i.meta->>'a')
    || COALESCE(substring(i.summary FROM ' \(propuesta v[0-9]+\)$'), ''));

-- Avisos del equipo ("movió a X (De → A)"): solo guardan texto, así que se reemplazan los dos nombres que cambiaron,
-- únicamente en el origen o el destino de la flecha (nunca dentro de otras palabras).
UPDATE activity SET detail =
  regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(detail, '^Prospecto(?= →)', 'Prospecto captado'),
        '(→ )Prospecto(?=$| ·)', '\1Prospecto captado'),
      '^Propuesta presentada(?= →)', 'Segunda visita'),
    '(→ )Propuesta presentada(?=$| ·)', '\1Segunda visita')
WHERE kind = 'cambio_etapa' AND detail LIKE '%→%' AND (detail ~ '^(Prospecto|Propuesta presentada) →' OR detail ~ '→ (Prospecto|Propuesta presentada)($| ·)');
