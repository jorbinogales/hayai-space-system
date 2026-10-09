-- Estado «entregado» para proyectos: terminal (como archivado, pero el proyecto sigue visible en sus listas). Solo amplía el CHECK: ningún dato cambia
-- y «completado» sigue existiendo tal cual. Sin versionado: no agrega entrada al historial de versiones.
ALTER TABLE projects DROP CONSTRAINT projects_status_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_check CHECK (status IN ('activo', 'entrega', 'planeacion', 'pausado', 'completado', 'entregado'));
