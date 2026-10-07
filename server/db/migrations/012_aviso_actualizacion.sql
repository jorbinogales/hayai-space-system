-- Aviso de actualización. La versión más alta de app_versions es la única fuente de verdad: de ella salen el aviso en la campana,
-- el banner de la web y lo que consultan los agentes (/version). announced_at marca cuándo se avisó al equipo de esa versión:
-- así el aviso sale UNA sola vez (al publicarla o, si la siembra una migración, al arrancar el sistema ya desplegado) y no se
-- repite cada vez que el servidor reinicia ni cuando la actividad vieja se limpia.
ALTER TABLE app_versions ADD COLUMN announced_at timestamptz;

-- Las versiones anteriores ya no se anuncian. La vigente (hoy 1.5.0) queda sin anunciar a propósito: sale con este despliegue.
UPDATE app_versions SET announced_at = created_at
WHERE id IS DISTINCT FROM (
  SELECT id FROM app_versions
  ORDER BY (string_to_array(version, '.'))[1]::int DESC, (string_to_array(version, '.'))[2]::int DESC, (string_to_array(version, '.'))[3]::int DESC
  LIMIT 1
);

-- Nombres de etapa del pipeline aprobados (las probabilidades y las claves no cambian): la API (/pipeline/etapas) es la fuente
-- única y todas las pantallas (columnas del pipeline, vista orbital, buscador) leen el nombre de ahí.
UPDATE pipeline_stages SET label = 'Prospecto captado' WHERE key = 'prospecto';
UPDATE pipeline_stages SET label = 'Segunda visita' WHERE key = 'propuesta_presentada';
