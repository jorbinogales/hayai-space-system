-- 006_papelera_archivo_permisos: tres cosas que comparten un objetivo, que nada se pierda por accidente.
--
-- 1) api_keys.scopes: permisos por llave. read = consultar, write = crear y editar, delete = borrar (a la papelera).
--    Las llaves que ya existian conservan lo que podian hacer hasta ahora: leer y escribir, sin borrar.
-- 2) trash: papelera. Borrar ya no destruye: la fila y todo lo que cuelga de ella (cobros, proyectos, tareas, gastos)
--    se guardan como una foto jsonb y se restauran con jsonb_populate_recordset, asi que no depende de la lista de
--    columnas y el resto de las consultas del sistema no necesita un "WHERE deleted_at IS NULL". Se vacia sola a los 30 dias.
--    entity_id no tiene FK a proposito: apunta a algo que ya no existe en su tabla.
-- 3) archived_at en clientes y proyectos: archivar oculta de las pantallas de trabajo pero conserva el historial
--    (Finanzas sigue contando lo cobrado). NULL = no archivado.

ALTER TABLE api_keys
  ADD COLUMN scopes text[] NOT NULL DEFAULT ARRAY['read', 'write'],
  ADD CONSTRAINT api_keys_scopes_ck CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['read', 'write', 'delete']);

CREATE TABLE trash (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity     text NOT NULL CHECK (entity IN ('cliente', 'proyecto', 'pago', 'gasto', 'tarea')),
  entity_id  uuid NOT NULL,                                 -- id que tenia al borrarse (se conserva al restaurar)
  label      text NOT NULL,                                 -- como se llamaba, para reconocerlo en la lista
  detail     text,                                          -- "3 cobros, 1 proyecto"
  data       jsonb NOT NULL,                                -- { root: fila, children: { tabla: [filas] } }
  via        text NOT NULL DEFAULT 'web',                   -- 'web' o 'api:<nombre de la llave>'
  deleted_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trash_deleted_at_idx ON trash (deleted_at DESC);

ALTER TABLE clients  ADD COLUMN archived_at timestamptz;
ALTER TABLE projects ADD COLUMN archived_at timestamptz;
