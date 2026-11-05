-- 039_multitenant: el sistema pasa a ser multitenant. Un tenant es un espacio de trabajo aislado; hoy existe uno solo, «HAYAI»,
-- dueño de todo lo que ya había. Lo aplica server/db/migrate.mjs dentro de una transacción; no lo edites una vez aplicado (crea 040_*.sql).
--
-- Decisiones:
--  - tenant_id NOT NULL explícito en TODA tabla de negocio, también en las hijas (ítems, comprobantes, menciones, versiones del guión...):
--    cada consulta filtra por su propia columna, sin depender de un join al padre.
--  - Las FK entre tablas de negocio pasan a ser compuestas: (tenant_id, x_id) -> padre (tenant_id, id). Es la red de la BD contra el error
--    más probable al filtrar en la app: colgar algo de un tenant de un padre de OTRO (un id ajeno que llega por la API, el MCP o la papelera).
--    Con la FK compuesta ese INSERT/UPDATE falla (23503) en vez de mezclar datos. Cada FK conserva su nombre y su ON DELETE; las SET NULL
--    anulan solo la columna del padre (ON DELETE SET NULL (col), PG15+), nunca tenant_id.
--  - Acceso: user_tenants (socio, tenant, módulos text[]): una fila por membresía, con los módulos validados por CHECK igual que
--    api_keys.scopes. Sin fila = sin acceso a ese tenant. Los ADMIN (users.role) son globales: ven todos los tenants sin necesitar fila.
--  - Globales (sin tenant_id): users, sessions, tenants, user_tenants, app_versions, exchange_rates, schema_migrations y pipeline_stages
--    (catálogo de código: el servidor depende de sus 7 claves y nada lo edita por la API; si un tenant pide etapas propias, migración aparte).
--  - Relleno sin UPDATE: la columna se agrega con DEFAULT = id de HAYAI (PG11+: solo metadatos, no reescribe la tabla ni dispara triggers)
--    y enseguida se quita el DEFAULT. Equivale a nullable -> backfill -> SET NOT NULL, pero sin tocar updated_at (la versión del If-Match),
--    sin una ráfaga de NOTIFY 'proyecto' y sin chocar con el trigger que hace inmutable feed_guion_versiones (un UPDATE ahí abortaría la
--    migración). Sin DEFAULT final a propósito: un INSERT que olvide el tenant falla (23502) en vez de caer callado en HAYAI.
--  - Las unicidades que hoy son globales por nombre o por clave externa pasan a ser por tenant. Las que ya cuelgan de un id de negocio
--    (una inicial por cliente, posición en la serie de cobros, versión de propuesta, nro del guión) no cambian: ese id ya es de un solo tenant.
--  - Idempotente: correrla otra vez no cambia nada (IF NOT EXISTS, DROP IF EXISTS + ADD con el mismo nombre, ON CONFLICT DO NOTHING).

-- =====================================================================================================================
-- 1) Tenants y acceso
-- =====================================================================================================================
CREATE TABLE IF NOT EXISTS tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 80),
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 40), -- para URLs, scripts y variables de entorno
  active     boolean NOT NULL DEFAULT true,                       -- se desactiva, no se borra: es dueño de datos contables
  created_by uuid REFERENCES users (id) ON DELETE RESTRICT,        -- NULL = lo creó el sistema (HAYAI, en esta migración)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tenants_name_lower_uq ON tenants (lower(name)); -- «Hayai» y «HAYAI» son el mismo (como users)
CREATE OR REPLACE TRIGGER tenants_updated_at BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Módulos = las secciones de la interfaz que se pueden dar o quitar (y que la API debe exigir). Agregar uno: migración que reemplace el CHECK.
CREATE TABLE IF NOT EXISTS user_tenants (
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  modules    text[] NOT NULL DEFAULT '{}',                         -- vacío = entra al tenant pero no ve ningún módulo
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id),                                -- también es el índice de «mis tenants»
  CONSTRAINT user_tenants_modules_ck CHECK (modules <@ ARRAY[
    'hub', 'feed', 'clientes', 'crm', 'cobros', 'proyectos', 'tareas', 'finanzas', 'marketing', 'sistemas', 'chat', 'integraciones', 'papelera'
  ]::text[])
);
CREATE INDEX IF NOT EXISTS user_tenants_tenant_idx ON user_tenants (tenant_id); -- «quién entra a este tenant» (pantalla de accesos)
CREATE OR REPLACE TRIGGER user_tenants_updated_at BEFORE UPDATE ON user_tenants FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO tenants (name, slug) VALUES ('HAYAI', 'hayai') ON CONFLICT DO NOTHING;

-- =====================================================================================================================
-- 2) tenant_id en las 37 tablas de negocio (todo lo existente queda en HAYAI)
-- =====================================================================================================================
DO $$
DECLARE
  hayai uuid := (SELECT id FROM tenants WHERE slug = 'hayai');
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- clientes, CRM y cobros
    'clients', 'client_items', 'client_logos', 'interactions', 'proposals', 'proposal_items', 'offerings', 'meta_leads',
    'payments', 'payment_receipts', 'receiver_documents',
    -- proyectos, tareas y gastos
    'projects', 'project_milestones', 'project_checklist', 'tasks', 'expenses',
    -- hub
    'systems', 'system_checks', 'agreements', 'activity', 'activity_seen', 'notification_reads', 'briefs', 'trash', 'api_keys',
    -- feed, chat y marketing
    'feed_items', 'feed_item_usuarios', 'feed_item_vinculos', 'feed_guion_versiones', 'competidores',
    'chat_messages', 'chat_mentions', 'chat_reads',
    'mk_keywords', 'mk_serp', 'mk_competidores', 'mk_contenidos'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT %L REFERENCES tenants (id) ON DELETE RESTRICT', t, hayai);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id DROP DEFAULT', t);
  END LOOP;
END $$;

-- =====================================================================================================================
-- 3) FK compuestas: un hijo solo puede colgar de un padre de su mismo tenant
-- =====================================================================================================================
-- Destino de las FK: (tenant_id, id) único en cada tabla padre. De paso es el índice de «todo lo de este tenant».
CREATE UNIQUE INDEX IF NOT EXISTS clients_tenant_uq            ON clients (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS payments_tenant_uq           ON payments (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS projects_tenant_uq           ON projects (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS project_milestones_tenant_uq ON project_milestones (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS proposals_tenant_uq          ON proposals (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS offerings_tenant_uq          ON offerings (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS systems_tenant_uq            ON systems (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS feed_items_tenant_uq         ON feed_items (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_tenant_uq      ON chat_messages (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS mk_keywords_tenant_uq        ON mk_keywords (tenant_id, id);

-- de clients
ALTER TABLE client_items DROP CONSTRAINT IF EXISTS client_items_client_id_fkey,
  ADD CONSTRAINT client_items_client_id_fkey FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE client_logos DROP CONSTRAINT IF EXISTS client_logos_client_id_fkey,
  ADD CONSTRAINT client_logos_client_id_fkey FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE interactions DROP CONSTRAINT IF EXISTS interactions_client_id_fkey,
  ADD CONSTRAINT interactions_client_id_fkey FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_client_id_fkey,
  ADD CONSTRAINT proposals_client_id_fkey FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE systems DROP CONSTRAINT IF EXISTS systems_client_id_fkey,
  ADD CONSTRAINT systems_client_id_fkey FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_client_id_fkey,
  ADD CONSTRAINT payments_client_id_fkey FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_client_id_fkey,
  ADD CONSTRAINT projects_client_id_fkey FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_client_id_fkey,
  ADD CONSTRAINT expenses_client_id_fkey FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE meta_leads DROP CONSTRAINT IF EXISTS meta_leads_client_id_fkey,
  ADD CONSTRAINT meta_leads_client_id_fkey FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id) ON DELETE SET NULL (client_id);

-- de payments, projects, milestones, proposals, offerings, systems
ALTER TABLE payment_receipts DROP CONSTRAINT IF EXISTS payment_receipts_payment_id_fkey,
  ADD CONSTRAINT payment_receipts_payment_id_fkey FOREIGN KEY (tenant_id, payment_id) REFERENCES payments (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_project_id_fkey,
  ADD CONSTRAINT expenses_project_id_fkey FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_project_id_fkey,
  ADD CONSTRAINT tasks_project_id_fkey FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE project_milestones DROP CONSTRAINT IF EXISTS project_milestones_project_id_fkey,
  ADD CONSTRAINT project_milestones_project_id_fkey FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE project_checklist DROP CONSTRAINT IF EXISTS project_checklist_project_id_fkey,
  ADD CONSTRAINT project_checklist_project_id_fkey FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_milestone_id_fkey,
  ADD CONSTRAINT tasks_milestone_id_fkey FOREIGN KEY (tenant_id, milestone_id) REFERENCES project_milestones (tenant_id, id) ON DELETE SET NULL (milestone_id);
ALTER TABLE proposal_items DROP CONSTRAINT IF EXISTS proposal_items_proposal_id_fkey,
  ADD CONSTRAINT proposal_items_proposal_id_fkey FOREIGN KEY (tenant_id, proposal_id) REFERENCES proposals (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE proposal_items DROP CONSTRAINT IF EXISTS proposal_items_offering_id_fkey,
  ADD CONSTRAINT proposal_items_offering_id_fkey FOREIGN KEY (tenant_id, offering_id) REFERENCES offerings (tenant_id, id) ON DELETE SET NULL (offering_id);
ALTER TABLE system_checks DROP CONSTRAINT IF EXISTS system_checks_system_id_fkey,
  ADD CONSTRAINT system_checks_system_id_fkey FOREIGN KEY (tenant_id, system_id) REFERENCES systems (tenant_id, id) ON DELETE CASCADE;

-- de feed_items, chat_messages, mk_keywords
ALTER TABLE feed_item_usuarios DROP CONSTRAINT IF EXISTS feed_item_usuarios_item_id_fkey,
  ADD CONSTRAINT feed_item_usuarios_item_id_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES feed_items (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE feed_item_vinculos DROP CONSTRAINT IF EXISTS feed_item_vinculos_item_id_fkey,
  ADD CONSTRAINT feed_item_vinculos_item_id_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES feed_items (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE feed_guion_versiones DROP CONSTRAINT IF EXISTS feed_guion_versiones_item_id_fkey,
  ADD CONSTRAINT feed_guion_versiones_item_id_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES feed_items (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE mk_keywords DROP CONSTRAINT IF EXISTS mk_keywords_idea_item_id_fkey,
  ADD CONSTRAINT mk_keywords_idea_item_id_fkey FOREIGN KEY (tenant_id, idea_item_id) REFERENCES feed_items (tenant_id, id) ON DELETE SET NULL (idea_item_id);
ALTER TABLE mk_contenidos DROP CONSTRAINT IF EXISTS mk_contenidos_feed_item_id_fkey,
  ADD CONSTRAINT mk_contenidos_feed_item_id_fkey FOREIGN KEY (tenant_id, feed_item_id) REFERENCES feed_items (tenant_id, id) ON DELETE SET NULL (feed_item_id);
ALTER TABLE chat_mentions DROP CONSTRAINT IF EXISTS chat_mentions_message_id_fkey,
  ADD CONSTRAINT chat_mentions_message_id_fkey FOREIGN KEY (tenant_id, message_id) REFERENCES chat_messages (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE mk_serp DROP CONSTRAINT IF EXISTS mk_serp_keyword_id_fkey,
  ADD CONSTRAINT mk_serp_keyword_id_fkey FOREIGN KEY (tenant_id, keyword_id) REFERENCES mk_keywords (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE mk_contenidos DROP CONSTRAINT IF EXISTS mk_contenidos_keyword_id_fkey,
  ADD CONSTRAINT mk_contenidos_keyword_id_fkey FOREIGN KEY (tenant_id, keyword_id) REFERENCES mk_keywords (tenant_id, id) ON DELETE SET NULL (keyword_id);

-- =====================================================================================================================
-- 4) Unicidades globales -> por tenant (mismo nombre: los ON CONFLICT de la app deben sumar tenant_id a su lista de columnas)
-- =====================================================================================================================
ALTER TABLE offerings DROP CONSTRAINT IF EXISTS offerings_key_key,
  ADD CONSTRAINT offerings_key_key UNIQUE (tenant_id, key);
ALTER TABLE receiver_documents DROP CONSTRAINT IF EXISTS receiver_documents_document_key,
  ADD CONSTRAINT receiver_documents_document_key UNIQUE (tenant_id, document);
ALTER TABLE mk_keywords DROP CONSTRAINT IF EXISTS mk_keywords_texto_norm_key,
  ADD CONSTRAINT mk_keywords_texto_norm_key UNIQUE (tenant_id, texto_norm);
DROP INDEX IF EXISTS feed_items_source_key_uq;
CREATE UNIQUE INDEX feed_items_source_key_uq ON feed_items (tenant_id, source, external_key) WHERE external_key IS NOT NULL;
DROP INDEX IF EXISTS chat_messages_source_key_uq;
CREATE UNIQUE INDEX chat_messages_source_key_uq ON chat_messages (tenant_id, source, external_key) WHERE external_key IS NOT NULL;
DROP INDEX IF EXISTS mk_competidores_nombre_idx;
CREATE UNIQUE INDEX mk_competidores_nombre_idx ON mk_competidores (tenant_id, nombre_norm) WHERE archived_at IS NULL;
DROP INDEX IF EXISTS competidores_nombre_idx;
CREATE UNIQUE INDEX competidores_nombre_idx ON competidores (tenant_id, nombre_norm);

-- Estado personal (cursor de avisos, leído del chat, brief del día, alertas leídas): ahora es por socio Y por tenant. Las claves de alerta
-- del feed (feed:<tipo>:<fuente>:<fecha>:<n>) no llevan ids, así que sin tenant_id leer en uno las marcaría leídas en otro.
ALTER TABLE activity_seen DROP CONSTRAINT IF EXISTS activity_seen_pkey,
  ADD CONSTRAINT activity_seen_pkey PRIMARY KEY (user_id, tenant_id);
ALTER TABLE chat_reads DROP CONSTRAINT IF EXISTS chat_reads_pkey,
  ADD CONSTRAINT chat_reads_pkey PRIMARY KEY (user_id, tenant_id);
ALTER TABLE briefs DROP CONSTRAINT IF EXISTS briefs_pkey,
  ADD CONSTRAINT briefs_pkey PRIMARY KEY (user_id, tenant_id, day);
ALTER TABLE notification_reads DROP CONSTRAINT IF EXISTS notification_reads_pkey,
  ADD CONSTRAINT notification_reads_pkey PRIMARY KEY (user_id, tenant_id, key);

-- =====================================================================================================================
-- 5) Índices de listado: los que servían a «listar todo» pasan a empezar por tenant_id (mismo nombre, misma cantidad de índices).
--    Se quedan globales los de limpieza y colas que recorren todos los tenants: activity_created_idx, notification_reads_at_idx,
--    meta_leads_pending_idx, sessions_expires_idx.
-- =====================================================================================================================
DROP INDEX IF EXISTS payments_pending_date_idx;
CREATE INDEX payments_pending_date_idx ON payments (tenant_id, date) WHERE status = 'pendiente';
DROP INDEX IF EXISTS expenses_date_idx;
CREATE INDEX expenses_date_idx ON expenses (tenant_id, date);
DROP INDEX IF EXISTS tasks_due_open_idx;
CREATE INDEX tasks_due_open_idx ON tasks (tenant_id, due_date) WHERE NOT done AND due_date IS NOT NULL;
DROP INDEX IF EXISTS clients_next_action_idx;
CREATE INDEX clients_next_action_idx ON clients (tenant_id, next_action_date) WHERE next_action_date IS NOT NULL;
DROP INDEX IF EXISTS trash_deleted_at_idx;
CREATE INDEX trash_deleted_at_idx ON trash (tenant_id, deleted_at DESC);
DROP INDEX IF EXISTS agreements_status_date_idx;
CREATE INDEX agreements_status_date_idx ON agreements (tenant_id, status, meeting_date DESC);
DROP INDEX IF EXISTS feed_items_status_found_idx;
CREATE INDEX feed_items_status_found_idx ON feed_items (tenant_id, status, found_at DESC);
DROP INDEX IF EXISTS feed_items_kind_idx;
CREATE INDEX feed_items_kind_idx ON feed_items (tenant_id, kind, found_at DESC);
DROP INDEX IF EXISTS feed_items_source_idx;
CREATE INDEX feed_items_source_idx ON feed_items (tenant_id, source, found_at DESC);
DROP INDEX IF EXISTS feed_items_category_idx;
CREATE INDEX feed_items_category_idx ON feed_items (tenant_id, category, found_at DESC) WHERE category IS NOT NULL;
DROP INDEX IF EXISTS chat_messages_created_idx;
CREATE INDEX chat_messages_created_idx ON chat_messages (tenant_id, created_at DESC, id DESC);
DROP INDEX IF EXISTS mk_keywords_estado_idx;
CREATE INDEX mk_keywords_estado_idx ON mk_keywords (tenant_id, estado, intencion);
DROP INDEX IF EXISTS mk_contenidos_estado_idx;
CREATE INDEX mk_contenidos_estado_idx ON mk_contenidos (tenant_id, estado, fecha_objetivo) WHERE archived_at IS NULL;
DROP INDEX IF EXISTS competidores_grupo_idx;
CREATE INDEX competidores_grupo_idx ON competidores (tenant_id, grupo, orden);
-- La actividad se lee por cursor de id ("lo posterior a N") dentro de un tenant.
CREATE INDEX IF NOT EXISTS activity_tenant_idx ON activity (tenant_id, id);

-- =====================================================================================================================
-- 6) Administradores y accesos iniciales
-- =====================================================================================================================
-- Los tres socios fundadores son ADMIN (globales). En una BD nueva aún no existen: los crea el seed de la app, que debe crearlos ADMIN.
UPDATE users SET role = 'ADMIN' WHERE lower(name) IN ('jorbi', 'elis', 'leandro') AND role <> 'ADMIN';

-- Todo socio existente (activo o no) entra a HAYAI con todos los módulos: nadie pierde nada de lo que veía.
INSERT INTO user_tenants (user_id, tenant_id, modules)
SELECT u.id, t.id, ARRAY[
  'hub', 'feed', 'clientes', 'crm', 'cobros', 'proyectos', 'tareas', 'finanzas', 'marketing', 'sistemas', 'chat', 'integraciones', 'papelera'
]
FROM users u CROSS JOIN tenants t
WHERE t.slug = 'hayai'
ON CONFLICT (user_id, tenant_id) DO NOTHING;

-- =====================================================================================================================
-- 7) Papelera: las fotos guardadas antes de hoy no traen tenant_id y restaurar las reinserta con jsonb_populate_recordset (un tenant_id
--    ausente sería NULL y violaría el NOT NULL). Se les agrega el tenant de su fila de trash a la raíz y a cada hijo. Solo datos.
-- =====================================================================================================================
UPDATE trash t SET data = t.data || jsonb_build_object(
  'root', (t.data -> 'root') || jsonb_build_object('tenant_id', t.tenant_id),
  'children', coalesce((
    SELECT jsonb_object_agg(c.k, (SELECT coalesce(jsonb_agg(r || jsonb_build_object('tenant_id', t.tenant_id)), '[]'::jsonb)
                                  FROM jsonb_array_elements(c.v) AS r))
    FROM jsonb_each(coalesce(t.data -> 'children', '{}'::jsonb)) AS c (k, v)
  ), '{}'::jsonb))
WHERE NOT (t.data -> 'root' ? 'tenant_id');

-- =====================================================================================================================
-- 8) Proyectos en vivo: el aviso lleva el tenant, para que el servidor lo reparta solo a las pestañas de ese tenant (la 026 sin más cambios).
-- =====================================================================================================================
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
    ids := ARRAY[nw->>'project_id', ol->>'project_id']; -- si una tarea cambia de proyecto, avisa a los dos (la FK compuesta los deja en el mismo tenant)
  END IF;
  IF sec = 'tareas' THEN
    hito := coalesce(nw->>'milestone_id', ol->>'milestone_id') IS NOT NULL; -- la hoja de ruta cuenta las tareas de cada hito
  END IF;
  FOREACH pid IN ARRAY ids LOOP
    IF pid IS NOT NULL THEN
      -- Avisos identicos dentro de una misma transaccion se funden en uno (reordenar 20 hitos = un solo aviso).
      PERFORM pg_notify('proyecto', json_build_object(
        'op', CASE TG_OP WHEN 'INSERT' THEN 'nuevo' WHEN 'DELETE' THEN 'borrado' ELSE 'editado' END,
        'seccion', sec, 'proyecto_id', pid, 'hito', hito,
        'tenant_id', coalesce(nw->>'tenant_id', ol->>'tenant_id'))::text);
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

-- =====================================================================================================================
-- 9) Comprobación: si algo de lo anterior quedó a medias, la migración entera se deshace.
-- =====================================================================================================================
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM users u WHERE NOT EXISTS (
    SELECT 1 FROM user_tenants ut JOIN tenants t ON t.id = ut.tenant_id WHERE ut.user_id = u.id AND t.slug = 'hayai');
  IF n > 0 THEN RAISE EXCEPTION '039: % socio(s) sin acceso a HAYAI', n; END IF;
  SELECT count(*) INTO n FROM trash WHERE NOT (data -> 'root' ? 'tenant_id');
  IF n > 0 THEN RAISE EXCEPTION '039: % foto(s) de la papelera sin tenant_id', n; END IF;
END $$;
