-- 039_version_1_8_3: la entrada del historial de versiones para v1.8.3 «Órbita fina IV». Solo datos (no cambia el esquema).
-- OJO: las otras dos piezas de la 1.8.3 (flujo Contactado del Feed y tareas delegables) van en ramas aparte;
-- si alguna también añade este archivo, hay que deduplicarlo al fusionar.
INSERT INTO app_versions (version, title, summary, changes, released_on) VALUES
('1.8.3', 'Órbita fina IV',
 'Tres ajustes finos: el Feed distingue prospectos contactados, las tareas avisan a Leandro al asignárselas y las tareas se pueden delegar.',
 ARRAY[
   'Feed: flujo Contactado para prospectos, con respuesta Positiva (pasa al pipeline como potencial), Negativa (bandeja de descarte) y Sin respuesta (seguimiento).',
   'Tareas: webhook saliente `tarea.asignada` — cuando una tarea queda con responsable Leandro, Space avisa de inmediato con un POST firmado (HMAC-SHA256) al receptor configurado, con reintentos y registro de entregas.',
   'Tareas: las tareas se pueden delegar a distintos responsables y se editan en la sección Tareas (título, responsable, vence, proyecto/hito, estado), en ambos sentidos con Proyectos.'
 ], DATE '2026-10-26')
ON CONFLICT (version) DO NOTHING;
