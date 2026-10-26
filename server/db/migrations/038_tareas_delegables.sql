-- 038_tareas_delegables: tareas delegables y editables (1.8.3 «Órbita fina IV»).
-- El responsable de una tarea ya existía en la API/MCP (assignee_id, migración 010):
-- NULL = la lleva el responsable del proyecto. Lo que faltaba era exponerlo y editarlo
-- en la web, en Tareas y en Proyectos, sobre la misma fuente de verdad (la lista de
-- tareas del servidor). Este cambio solo añade la constancia de reasignación en la
-- actividad del equipo (nuevo tipo 'tarea_reasignada') y la entrada de la versión
-- 1.8.3; no cambia el esquema de tareas ni el pipeline. No hay comentarios en tareas
-- (pendiente fuera de 1.8.3).
ALTER TABLE activity DROP CONSTRAINT activity_kind_check;
ALTER TABLE activity ADD CONSTRAINT activity_kind_check CHECK (kind IN
  ('cliente_nuevo', 'posible_nuevo', 'tarea_nueva', 'tarea_completada', 'tarea_reasignada', 'cobro_cobrado', 'cambio_etapa', 'cliente_ganado', 'cliente_perdido', 'lead_meta', 'acuerdo_nuevo', 'sistema_caido', 'sistema_recuperado', 'version_nueva', 'feed_nuevo'));

-- Nota para el merge de la 1.8.3: las otras dos ramas de la release (flujo del Feed y
-- webhook de tareas) también siembran la versión 1.8.3. El ON CONFLICT DO NOTHING hace
-- que gane la primera que se fusione; al juntar las tres, la entrada debe listar los
-- tres cambios (Feed, webhook y tareas delegables) y renumerar esta migración si otra
-- rama ya tomó el 038.
INSERT INTO app_versions (version, title, summary, changes, released_on) VALUES
('1.8.3', 'Órbita fina IV',
 'Las tareas se pueden delegar y editar en Tareas y en Proyectos, con el mismo dato en ambos lados.',
 ARRAY[
   'Tareas: cada tarea muestra a quien la lleva (asignado o, sin asignar, el responsable del proyecto) y se puede editar título, responsable, fecha y estado sin salir de la pantalla.',
   'Proyectos: el general de tareas refleja los mismos cambios al instante, porque ambas pantallas leen la misma lista de tareas del servidor.',
   'Delegar: cambiar el responsable de una tarea no cambia el responsable del proyecto, y queda constancia en la actividad del equipo («reasignó la tarea»).'
 ], DATE '2026-10-26')
ON CONFLICT (version) DO NOTHING;
