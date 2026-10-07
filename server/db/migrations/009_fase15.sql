-- 009_fase15: CRM fase 1.5 — pipeline real (etapas en tabla), propuestas con items, catalogo de ofertas, redes y dia de
-- implementacion del cliente, proyectos sin cliente (+ descripcion, hitos y checklist), estados de proyecto nuevos y la
-- ingesta de leads de Meta. Lo aplica server/db/migrate.mjs dentro de una transaccion; no lo edites una vez aplicado.
-- Diseno aprobado: "claude/space-crm-fase1-5-diseno.md" del proyecto Hayai.
-- Todo ADD COLUMN es nullable o con constante: no reescribe tablas.

-- =====================================================================================================================
-- 1) Pipeline: etapas en tabla (editables sin migracion). Fijas en codigo solo 'ganado' y 'perdido' (tienen logica propia).
-- =====================================================================================================================
CREATE TABLE pipeline_stages (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z][a-z_]{2,29}$'),
  label       text NOT NULL CHECK (label = btrim(label) AND label <> '' AND length(label) <= 40),
  position    smallint NOT NULL,
  probability smallint NOT NULL CHECK (probability BETWEEN 0 AND 100),
  kind        text NOT NULL CHECK (kind IN ('abierta', 'ganada', 'perdida')),
  active      boolean NOT NULL DEFAULT true,
  -- 'ganado' y 'perdido' son las unicas etapas de su tipo, con su probabilidad fija.
  CONSTRAINT pipeline_stages_won_ck  CHECK ((key = 'ganado')  = (kind = 'ganada')  AND (kind <> 'ganada'  OR probability = 100)),
  CONSTRAINT pipeline_stages_lost_ck CHECK ((key = 'perdido') = (kind = 'perdida') AND (kind <> 'perdida' OR probability = 0))
);
CREATE UNIQUE INDEX pipeline_stages_position_uq ON pipeline_stages (position);

INSERT INTO pipeline_stages (key, label, position, probability, kind) VALUES
  ('prospecto',            'Prospecto',            1, 10,  'abierta'),
  ('visita_agendada',      'Visita agendada',      2, 20,  'abierta'),
  ('visita_realizada',     'Visita realizada',     3, 35,  'abierta'),
  ('propuesta_en_armado',  'Propuesta en armado',  4, 50,  'abierta'),
  ('propuesta_presentada', 'Propuesta presentada', 5, 70,  'abierta'),
  ('ganado',               'Ganado',               6, 100, 'ganada'),
  ('perdido',              'Perdido',              7, 0,   'perdida');

-- El CHECK viejo listaba las etapas de texto: se quita, se traducen los valores y se reemplaza por FK + regla sin lista.
ALTER TABLE clients DROP CONSTRAINT clients_stage_ck;

CREATE TEMP TABLE _stage_map (old text PRIMARY KEY, new text NOT NULL, new_label text NOT NULL) ON COMMIT DROP;
INSERT INTO _stage_map VALUES
  ('nuevo',       'prospecto',            'Prospecto'),
  ('contactado',  'visita_agendada',      'Visita agendada'),
  ('propuesta',   'propuesta_en_armado',  'Propuesta en armado'),
  ('negociacion', 'propuesta_presentada', 'Propuesta presentada'),
  ('ganado',      'ganado',               'Ganado'),
  ('perdido',     'perdido',              'Perdido');

UPDATE clients c SET pipeline_stage = m.new FROM _stage_map m WHERE m.old = c.pipeline_stage;
-- La probabilidad de lo abierto vuelve a la de su etapa (10/20/35/50/70); ganado y perdido ya eran 100 y 0.
UPDATE clients c SET probability = s.probability FROM pipeline_stages s WHERE s.key = c.pipeline_stage AND s.kind = 'abierta';

-- La bitacora no debe mostrar etapas que ya no existen: se reescribe meta (de/a) y el texto de cada entrada de etapa.
UPDATE interactions i SET
  meta = i.meta
    || jsonb_build_object('a', (SELECT new FROM _stage_map WHERE old = i.meta->>'a'))
    || CASE WHEN i.meta->>'de' IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('de', (SELECT new FROM _stage_map WHERE old = i.meta->>'de')) END,
  summary = COALESCE((SELECT new_label FROM _stage_map WHERE old = i.meta->>'de'), 'Sin etapa')
            || ' → ' || (SELECT new_label FROM _stage_map WHERE old = i.meta->>'a')
WHERE i.kind = 'etapa' AND EXISTS (SELECT 1 FROM _stage_map WHERE old = i.meta->>'a');

ALTER TABLE clients
  ADD CONSTRAINT clients_stage_fk FOREIGN KEY (pipeline_stage) REFERENCES pipeline_stages (key) ON UPDATE CASCADE,
  -- Un posible cliente siempre tiene una etapa y no es 'ganado' (ganado = ya es cliente); un cliente: sin etapa (anterior al
  -- pipeline) o 'ganado'. Que la etapa sea valida lo garantiza la FK, asi agregar etapas no exige tocar este CHECK.
  ADD CONSTRAINT clients_stage_ck CHECK (
       (is_prospect     AND pipeline_stage IS NOT NULL AND pipeline_stage <> 'ganado')
    OR (NOT is_prospect AND (pipeline_stage IS NULL OR pipeline_stage = 'ganado'))
  );

-- =====================================================================================================================
-- 2) Ficha: redes sociales y dia de implementacion.
-- =====================================================================================================================
ALTER TABLE clients
  ADD COLUMN socials             jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{ "red": "instagram", "url": "https://..." }]
  ADD COLUMN implementation_date date;
ALTER TABLE clients ADD CONSTRAINT clients_socials_ck CHECK (jsonb_typeof(socials) = 'array' AND jsonb_array_length(socials) <= 8);

-- =====================================================================================================================
-- 3) Catalogo de ofertas de HAYAI y propuestas con items (mensualidad base + extras).
-- =====================================================================================================================
CREATE TABLE offerings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key             text NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9_]{2,40}$'),
  name            text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 80),
  kind            text NOT NULL CHECK (kind IN ('sistema', 'automatizacion', 'hardware', 'servicio')),
  default_monthly numeric(14,2) CHECK (default_monthly IS NULL OR default_monthly >= 0),
  default_setup   numeric(14,2) CHECK (default_setup IS NULL OR default_setup >= 0),
  description     text CHECK (description IS NULL OR (description = btrim(description) AND description <> '' AND length(description) <= 500)),
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER offerings_updated_at BEFORE UPDATE ON offerings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- Sin precios: los pone el equipo. Es un catalogo de sugerencias; el precio final se edita en cada propuesta.
INSERT INTO offerings (key, name, kind) VALUES
  ('mostrador_pos',     'Mostrador POS',      'sistema'),
  ('el_chasis',         'El Chasis',          'sistema'),
  ('automatizaciones',  'Automatizaciones',   'automatizacion'),
  ('sistemas_whatsapp', 'Sistemas WhatsApp',  'sistema');

CREATE TABLE proposals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  version      smallint NOT NULL CHECK (version >= 1),   -- una por ronda de negociacion
  status       text NOT NULL CHECK (status IN ('borrador', 'presentada', 'aceptada', 'rechazada', 'reemplazada')),
  notes        text CHECK (notes IS NULL OR (notes = btrim(notes) AND notes <> '' AND length(notes) <= 4000)),
  presented_at timestamptz,
  created_by   uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proposals_version_uq UNIQUE (client_id, version)
);
-- A lo sumo una propuesta "viva" (borrador o presentada) por cliente: una nueva version reemplaza a la anterior.
CREATE UNIQUE INDEX proposals_live_uq ON proposals (client_id) WHERE status IN ('borrador', 'presentada');
CREATE TRIGGER proposals_updated_at BEFORE UPDATE ON proposals FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE proposal_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES proposals (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('mensualidad', 'extra_mensual', 'extra_unico')),
  concept     text NOT NULL CHECK (concept = btrim(concept) AND concept <> '' AND length(concept) <= 120),
  qty         smallint NOT NULL DEFAULT 1 CHECK (qty BETWEEN 1 AND 999),
  unit_price  numeric(14,2) NOT NULL CHECK (unit_price >= 0),  -- USD, como todo el sistema
  offering_id uuid REFERENCES offerings (id) ON DELETE SET NULL,
  position    smallint NOT NULL
);
CREATE INDEX proposal_items_proposal_idx ON proposal_items (proposal_id, position);
CREATE UNIQUE INDEX proposal_items_base_uq ON proposal_items (proposal_id) WHERE kind = 'mensualidad';

-- =====================================================================================================================
-- 4) Proyectos: sin cliente, descripcion, estados nuevos, hitos (roadmap) y checklist de accionables.
-- =====================================================================================================================
ALTER TABLE projects ALTER COLUMN client_id DROP NOT NULL;   -- la FK (RESTRICT) se queda
ALTER TABLE projects ADD COLUMN description text;
ALTER TABLE projects ADD CONSTRAINT projects_description_ck CHECK (description IS NULL OR (description = btrim(description) AND description <> '' AND length(description) <= 4000));
ALTER TABLE projects DROP CONSTRAINT projects_status_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_check CHECK (status IN ('activo', 'entrega', 'planeacion', 'pausado', 'completado'));

CREATE TABLE project_milestones (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  title      text NOT NULL CHECK (title = btrim(title) AND title <> '' AND length(title) <= 120),
  due_date   date,
  status     text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'en_curso', 'hecho')),
  position   smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_milestones_project_idx ON project_milestones (project_id, position);
CREATE TRIGGER project_milestones_updated_at BEFORE UPDATE ON project_milestones FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE project_checklist (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  text       text NOT NULL CHECK (text = btrim(text) AND text <> '' AND length(text) <= 200),
  done       boolean NOT NULL DEFAULT false,
  done_at    timestamptz,
  position   smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (done OR done_at IS NULL)
);
CREATE INDEX project_checklist_project_idx ON project_checklist (project_id, position);
CREATE TRIGGER project_checklist_updated_at BEFORE UPDATE ON project_checklist FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Una tarea puede colgar de un hito (el servicio exige que sea del mismo proyecto). Borrar el hito la deja suelta.
ALTER TABLE tasks ADD COLUMN milestone_id uuid REFERENCES project_milestones (id) ON DELETE SET NULL;
CREATE INDEX tasks_milestone_idx ON tasks (milestone_id) WHERE milestone_id IS NOT NULL;

-- =====================================================================================================================
-- 5) Leads de Meta (ingesta por webhook, apagada por flag hasta que existan las credenciales).
-- =====================================================================================================================
CREATE TABLE meta_leads (
  leadgen_id    text PRIMARY KEY,                 -- idempotencia: el mismo lead nunca se procesa dos veces
  page_id       text,
  form_id       text,
  ad_id         text,
  ad_name       text,
  adset_id      text,
  adset_name    text,
  campaign_id   text,                             -- base del costo por lead (el gasto se cruza luego, en Marketing)
  campaign_name text,
  status        text NOT NULL DEFAULT 'recibido' CHECK (status IN ('recibido', 'procesado', 'duplicado', 'error')),
  attempts      smallint NOT NULL DEFAULT 0,
  error         text,
  client_id     uuid REFERENCES clients (id) ON DELETE SET NULL,
  raw           jsonb,                            -- respuesta de Graph, para depurar
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz
);
CREATE INDEX meta_leads_pending_idx ON meta_leads (received_at) WHERE status IN ('recibido', 'error');
CREATE INDEX meta_leads_campaign_idx ON meta_leads (campaign_id) WHERE campaign_id IS NOT NULL;

-- =====================================================================================================================
-- 6) Actividad del equipo: tambien avisa de cobros cobrados y de cambios de etapa (decision 1B).
-- =====================================================================================================================
ALTER TABLE activity DROP CONSTRAINT activity_kind_check;
ALTER TABLE activity ADD CONSTRAINT activity_kind_check CHECK (kind IN
  ('cliente_nuevo', 'posible_nuevo', 'tarea_nueva', 'tarea_completada', 'cobro_cobrado', 'cambio_etapa', 'cliente_ganado', 'cliente_perdido'));

-- =====================================================================================================================
-- 7) Papelera: tambien guarda propuestas, hitos e items de checklist sueltos.
-- =====================================================================================================================
ALTER TABLE trash DROP CONSTRAINT trash_entity_check;
ALTER TABLE trash ADD CONSTRAINT trash_entity_check CHECK (entity IN
  ('cliente', 'proyecto', 'pago', 'gasto', 'tarea', 'interaccion', 'propuesta', 'hito', 'checklist_item'));
