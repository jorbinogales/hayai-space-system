-- 039_version_1_8_3: la entrada del historial de versiones para v1.8.3 «Órbita fina IV».
-- La 1.8.3 tiene tres piezas: (1) el flujo de contacto del prospecto en el Feed;
-- (2) el webhook de tareas asignadas a Leandro; (3) las tareas delegables.
-- Esta migración siembra la entrada con las tres piezas. Si otra pieza de la 1.8.3
-- aterrizó antes (p. ej. la 038 de tareas delegables, que siembra solo su pieza),
-- el ON CONFLICT DO UPDATE la completa a las tres, así la entrada vigente siempre
-- lista el release entero, sin importar el orden de fusión. Idempotente.
INSERT INTO app_versions (version, title, summary, changes, released_on) VALUES
('1.8.3', 'Órbita fina IV',
 'El prospecto del Feed ya tiene su propio flujo de contacto; las tareas se pueden delegar y editar; y Space avisa cuando a Leandro le cae una tarea.',
 ARRAY[
   'Feed: el prospecto (tipo potencial) ya lleva su estado de contacto global —sin contactar, contactado, sin respuesta, respondió positivo, respondió negativo— con días desde el envío y próxima acción; la respuesta positiva crea el cliente potencial en el pipeline y la negativa va a una bandeja de descarte restaurable.',
   'Tareas: cada tarea muestra a quien la lleva (asignado o, sin asignar, el responsable del proyecto) y se puede editar título, responsable, fecha y estado en Tareas y en Proyectos, con el mismo dato en ambos lados.',
   'Webhook: cuando a Leandro le cae una tarea (creada con él como responsable o reasignada a él), Space avisa de inmediato con un POST firmado a un receptor externo.'
 ], DATE '2026-10-26')
ON CONFLICT (version) DO UPDATE SET
  summary = EXCLUDED.summary,
  changes = EXCLUDED.changes;
