-- Proyectos en vivo: cada cambio confirmado en un proyecto, sus hitos, su checklist o sus tareas avisa por el canal 'proyecto' de Postgres
-- (NOTIFY se entrega al confirmar la transaccion, nunca antes) y el servidor lo reparte por el stream SSE. Es un trigger y no codigo en cada ruta
-- a proposito: asi tambien avisa lo que entra por la API publica, el MCP, la papelera o un borrado en cascada, sin que nadie tenga que acordarse.
-- El aviso NO lleva datos (solo que cambio y de que proyecto): la pantalla vuelve a pedir esa seccion por la API, con los permisos de siempre.
-- Dato y funcion, sin versionado: no toca ninguna tabla ni agrega entrada al historial de versiones.
CREATE OR REPLACE FUNCTION notify_proyecto() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sec text := TG_ARGV[0];
  nw jsonb;
  ol jsonb;
  ids text[];
  pid text;
  hito boolean := false;
BEGIN
  IF TG_OP <> 'DELETE' THEN nw := to_jsonb(NEW); END IF;
  IF TG_OP <> 'INSERT' THEN ol := to_jsonb(OLD); END IF;
  IF sec = 'proyecto' THEN
    ids := ARRAY[coalesce(nw->>'id', ol->>'id')];
  ELSE
    ids := ARRAY[nw->>'project_id', ol->>'project_id']; -- si una tarea cambia de proyecto, avisa a los dos
  END IF;
  IF sec = 'tareas' THEN
    hito := coalesce(nw->>'milestone_id', ol->>'milestone_id') IS NOT NULL; -- la hoja de ruta cuenta las tareas de cada hito
  END IF;
  FOREACH pid IN ARRAY ids LOOP
    IF pid IS NOT NULL THEN
      -- Avisos identicos dentro de una misma transaccion se funden en uno (reordenar 20 hitos = un solo aviso).
      PERFORM pg_notify('proyecto', json_build_object(
        'op', CASE TG_OP WHEN 'INSERT' THEN 'nuevo' WHEN 'DELETE' THEN 'borrado' ELSE 'editado' END,
        'seccion', sec, 'proyecto_id', pid, 'hito', hito)::text);
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE TRIGGER proyectos_en_vivo AFTER UPDATE OR DELETE ON projects
  FOR EACH ROW EXECUTE FUNCTION notify_proyecto('proyecto');
CREATE TRIGGER hitos_en_vivo AFTER INSERT OR UPDATE OR DELETE ON project_milestones
  FOR EACH ROW EXECUTE FUNCTION notify_proyecto('hitos');
CREATE TRIGGER checklist_en_vivo AFTER INSERT OR UPDATE OR DELETE ON project_checklist
  FOR EACH ROW EXECUTE FUNCTION notify_proyecto('checklist');
CREATE TRIGGER tareas_en_vivo AFTER INSERT OR UPDATE OR DELETE ON tasks
  FOR EACH ROW EXECUTE FUNCTION notify_proyecto('tareas');
