-- 007_crm_fase1: ficha completa del cliente, pipeline de posibles clientes, bitacora de interacciones y alertas (leidas).
-- Lo aplica server/db/migrate.mjs dentro de una transaccion; no lo edites una vez aplicado (crea 008_*.sql).
--
-- Decisiones (ver el diseno aprobado):
--  - Un "posible cliente" sigue siendo una fila de clients (is_prospect) + su proyecto en planeacion + su tarea de visita.
--    El pipeline vive en columnas de clients (una oportunidad por posible cliente), no en una tabla aparte.
--  - pipeline_stage: nuevo, contactado, propuesta, negociacion, perdido (solo posibles) y ganado (= ya es cliente).
--    NULL = cliente de antes del pipeline: no conocemos su historia, y no se inventa.
--  - Las alertas (cuotas vencidas, seguimientos) NO se guardan: se derivan al consultar. Solo se guarda quien las leyo.
-- ADD COLUMN sin default (o con constante): solo metadatos, no reescribe la tabla.

-- fold(): minuscula y sin acentos, para buscar "panaderia" y encontrar "Panadería". Sin extensiones (unaccent pide permisos).
-- Funciona porque la base es UTF-8; translate() empareja caracter con caracter, las dos listas miden lo mismo.
CREATE FUNCTION fold(t text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT lower(translate(t, 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN'))
$$;

ALTER TABLE clients
  -- ficha
  ADD COLUMN phone        text,
  ADD COLUMN email        text,
  ADD COLUMN contact_name text,
  ADD COLUMN contact_role text,
  ADD COLUMN address      text,
  ADD COLUMN notes        text,
  ADD COLUMN tags         text[] NOT NULL DEFAULT '{}',
  ADD COLUMN lead_source  text,
  -- pipeline (est_value en USD, como todo el sistema)
  ADD COLUMN pipeline_stage   text,
  ADD COLUMN est_value        numeric(14,2),
  ADD COLUMN probability      smallint,
  ADD COLUMN expected_close   date,
  ADD COLUMN lost_reason      text,
  ADD COLUMN stage_changed_at timestamptz,
  -- seguimiento: la proxima accion y su fecha
  ADD COLUMN next_action      text,
  ADD COLUMN next_action_date date;

-- Los posibles clientes de hoy entran al pipeline en "nuevo" (10 %), contando desde que se crearon.
UPDATE clients SET pipeline_stage = 'nuevo', probability = 10, stage_changed_at = created_at WHERE is_prospect;

ALTER TABLE clients
  ADD CONSTRAINT clients_phone_ck   CHECK (phone IS NULL OR (phone = btrim(phone) AND phone <> '' AND length(phone) <= 40)),
  -- Basura fuera: algo@algo.algo, sin espacios. La validacion fina (zod) esta en la API.
  ADD CONSTRAINT clients_email_ck   CHECK (email IS NULL OR (length(email) <= 120 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  ADD CONSTRAINT clients_contact_ck CHECK (
        (contact_name IS NULL OR (contact_name = btrim(contact_name) AND contact_name <> '' AND length(contact_name) <= 80))
    AND (contact_role IS NULL OR (contact_role = btrim(contact_role) AND contact_role <> '' AND length(contact_role) <= 80))
  ),
  ADD CONSTRAINT clients_address_ck CHECK (address IS NULL OR (address = btrim(address) AND address <> '' AND length(address) <= 300)),
  ADD CONSTRAINT clients_notes_ck   CHECK (notes IS NULL OR (notes = btrim(notes) AND notes <> '' AND length(notes) <= 4000)),
  -- Cada etiqueta (<= 30) la valida la API; aqui el tope de cuantas y de largo total.
  ADD CONSTRAINT clients_tags_ck    CHECK (cardinality(tags) <= 10 AND length(array_to_string(tags, ',')) <= 330),
  ADD CONSTRAINT clients_source_ck  CHECK (lead_source IS NULL OR lead_source IN
    ('referido', 'instagram', 'whatsapp', 'facebook', 'meta_ads', 'web', 'visita_frio', 'evento', 'otro')),

  -- Un posible cliente siempre esta en una etapa abierta o perdido; ganado equivale a ser cliente; NULL = cliente de antes.
  ADD CONSTRAINT clients_stage_ck CHECK (
       (is_prospect     AND pipeline_stage IN ('nuevo', 'contactado', 'propuesta', 'negociacion', 'perdido'))
    OR (NOT is_prospect AND (pipeline_stage IS NULL OR pipeline_stage = 'ganado'))
  ),
  ADD CONSTRAINT clients_stage_at_ck   CHECK (pipeline_stage IS NULL OR stage_changed_at IS NOT NULL),
  ADD CONSTRAINT clients_value_ck      CHECK (est_value IS NULL OR est_value > 0),
  ADD CONSTRAINT clients_prob_ck       CHECK (probability IS NULL OR probability BETWEEN 0 AND 100),
  -- Al ganar la probabilidad es 100 y al perder 0: si quedara la de la ultima etapa, el valor ponderado saldria distorsionado.
  ADD CONSTRAINT clients_prob_final_ck CHECK (
        (pipeline_stage IS DISTINCT FROM 'ganado'  OR probability IS NOT DISTINCT FROM 100)
    AND (pipeline_stage IS DISTINCT FROM 'perdido' OR probability IS NOT DISTINCT FROM 0)
  ),
  -- El motivo existe si y solo si se perdio.
  ADD CONSTRAINT clients_lost_ck CHECK (
    (pipeline_stage IS NOT DISTINCT FROM 'perdido') = (lost_reason IS NOT NULL)
    AND (lost_reason IS NULL OR (lost_reason = btrim(lost_reason) AND lost_reason <> '' AND length(lost_reason) <= 300))
  ),
  ADD CONSTRAINT clients_next_ck CHECK (
        (next_action IS NULL OR (next_action = btrim(next_action) AND next_action <> '' AND length(next_action) <= 160))
    AND (next_action_date IS NULL OR next_action IS NOT NULL) -- una fecha de seguimiento siempre dice que hay que hacer
  );

CREATE INDEX clients_tags_idx        ON clients USING gin (tags);                            -- filtro por etiqueta (fase 2)
CREATE INDEX clients_next_action_idx ON clients (next_action_date) WHERE next_action_date IS NOT NULL; -- alertas de seguimiento

-- Bitacora del cliente: llamadas, visitas, WhatsApp y notas escritas por un socio, mas las entradas de 'etapa' que escribe
-- SOLO el servidor en cada cambio de etapa (la API no las crea, edita ni borra: si pudieran, el historial se falsificaria).
-- Mueren con su cliente (como tasks); la papelera las guarda en la foto del cliente y las restaura con el.
CREATE TABLE interactions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('llamada', 'visita', 'whatsapp', 'nota', 'etapa')),
  occurred_at timestamptz NOT NULL DEFAULT now(),   -- cuando ocurrio (se puede poner una fecha pasada)
  summary     text NOT NULL CHECK (summary = btrim(summary) AND summary <> '' AND length(summary) <= 2000),
  meta        jsonb,                                -- solo 'etapa': { de, a, motivo }
  created_by  uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT interactions_meta_ck CHECK ((kind = 'etapa') = (meta IS NOT NULL))
);
CREATE INDEX interactions_client_idx ON interactions (client_id, occurred_at DESC, id); -- feed del cliente, lo reciente primero
CREATE TRIGGER interactions_updated_at BEFORE UPDATE ON interactions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Quien leyo cada alerta. La clave es determinista: 'cuota:<id>' o 'seguimiento:<cliente>:<fecha>' (reprogramar el
-- seguimiento cambia la clave y la alerta vuelve a aparecer). Pagar la cuota la quita sola: no hay nada que limpiar a mano;
-- las lecturas viejas se purgan al consultar.
CREATE TABLE notification_reads (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key     text NOT NULL CHECK (key = btrim(key) AND key <> '' AND length(key) <= 120),
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX notification_reads_at_idx ON notification_reads (read_at);

-- La papelera tambien guarda interacciones sueltas (borrar una llamada se puede deshacer 30 dias, como todo).
ALTER TABLE trash DROP CONSTRAINT trash_entity_check;
ALTER TABLE trash ADD CONSTRAINT trash_entity_check CHECK (entity IN ('cliente', 'proyecto', 'pago', 'gasto', 'tarea', 'interaccion'));
