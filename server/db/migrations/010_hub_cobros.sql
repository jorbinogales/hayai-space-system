-- 010_hub_cobros: hub central interno + registro completo de cobros.
-- Lo aplica server/db/migrate.mjs dentro de una transaccion; no lo edites una vez aplicado (crea 011_*.sql).
--
-- Decisiones:
--  - "Interno" NO es una columna: un proyecto sin cliente (client_id NULL) ES interno, y sus tareas y gastos tambien.
--    Una columna aparte podria contradecirse con client_id; asi el dato es uno solo y la API lo expone como `es_interno`.
--  - Tablas nuevas solo las necesarias: sistemas y sus verificaciones, acuerdos, comprobantes y el mapeo documento -> socio.
--  - Los documentos (cedulas) del mapeo NO viajan en el repo: se siembran desde RECEIVER_DOCUMENTS en el servidor.
--  - Sin contrasenas en `systems`: solo el usuario de gestion (texto) y las URLs.

-- =====================================================================================================================
-- 1) Cobros: bolivares, tasa, referencia, bancos, quien recibio, metodo y notas. monto (USD) sigue siendo el principal.
-- =====================================================================================================================
ALTER TABLE payments
  ADD COLUMN amount_bs          numeric(18,2) CHECK (amount_bs > 0),
  ADD COLUMN exchange_rate      numeric(14,4) CHECK (exchange_rate > 0),   -- Bs por USD
  ADD COLUMN rate_date          date,                                      -- fecha de la tasa (auditoria)
  ADD COLUMN bank_reference     text CHECK (bank_reference IS NULL OR (bank_reference = btrim(bank_reference) AND bank_reference <> '')),
  ADD COLUMN bank_origin        text CHECK (bank_origin IS NULL OR (bank_origin = btrim(bank_origin) AND bank_origin <> '')),
  ADD COLUMN origin_last4       char(4) CHECK (origin_last4 ~ '^[0-9]{4}$'),
  ADD COLUMN bank_destination   text CHECK (bank_destination IS NULL OR (bank_destination = btrim(bank_destination) AND bank_destination <> '')),
  ADD COLUMN received_by        uuid REFERENCES users (id) ON DELETE RESTRICT,
  ADD COLUMN received_by_source text CHECK (received_by_source IN ('manual', 'comprobante')),
  ADD COLUMN method             text CHECK (method IN ('transferencia', 'pago_movil', 'efectivo', 'zelle', 'otro')),
  ADD COLUMN notes              text CHECK (notes IS NULL OR (notes = btrim(notes) AND notes <> ''));
-- Los bolivares y la tasa viajan juntos (con una se calcula la otra) y la tasa siempre trae su fecha.
ALTER TABLE payments
  ADD CONSTRAINT payments_bs_rate_ck CHECK ((amount_bs IS NULL) = (exchange_rate IS NULL) AND (exchange_rate IS NULL) = (rate_date IS NULL)),
  ADD CONSTRAINT payments_source_ck  CHECK (received_by_source IS NULL OR received_by IS NOT NULL);
CREATE INDEX payments_received_by_idx ON payments (received_by) WHERE received_by IS NOT NULL;

-- Comprobante: la imagen del capture, a lo sumo uno por cobro (subir otro lo reemplaza). Vive en la BD: sin volumenes que respaldar.
CREATE TABLE payment_receipts (
  payment_id        uuid PRIMARY KEY REFERENCES payments (id) ON DELETE CASCADE,
  filename          text NOT NULL CHECK (btrim(filename) <> ''),
  mime              text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
  size              integer NOT NULL CHECK (size > 0 AND size <= 4194304),
  data              bytea NOT NULL,
  ocr_text          text,
  detected_document text,                                -- 'V26358692' (solo letra y digitos), si se leyo
  uploaded_by       uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  uploaded_at       timestamptz NOT NULL DEFAULT now()
);

-- Documento (cedula) -> socio que recibe. Editable desde la interfaz, la API y el MCP.
CREATE TABLE receiver_documents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document   text NOT NULL UNIQUE CHECK (document ~ '^[VEJGP][0-9]{5,10}$'),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================================================================
-- 2) Hub: equipo (rol y responsabilidades), carga por persona, sistemas por cliente y acuerdos de la reunion semanal.
-- =====================================================================================================================
ALTER TABLE users
  ADD COLUMN role_title        text CHECK (role_title IS NULL OR (role_title = btrim(role_title) AND role_title <> '')),
  ADD COLUMN responsibilities  text CHECK (responsibilities IS NULL OR (responsibilities = btrim(responsibilities) AND responsibilities <> ''));
UPDATE users SET role_title = 'Gerencia y administración', responsibilities = 'Operación del negocio, relación con clientes, visitas en campo, cobranza y administración.' WHERE lower(name) = 'elis';
UPDATE users SET role_title = 'Backend e IA', responsibilities = 'Arquitectura y backend de los sistemas, automatización con IA, despliegues y servidores.' WHERE lower(name) = 'jorbi';
UPDATE users SET role_title = 'Marketing digital', responsibilities = 'Vibe marketing: contenido, campañas de Meta Ads, embudo y comunicación de la marca.' WHERE lower(name) = 'leandro';

-- Quien lleva cada tarea. NULL = la lleva el responsable del proyecto (la carga por persona usa ese respaldo).
ALTER TABLE tasks ADD COLUMN assignee_id uuid REFERENCES users (id) ON DELETE SET NULL;
CREATE INDEX tasks_assignee_idx ON tasks (assignee_id) WHERE assignee_id IS NOT NULL AND NOT done;

CREATE TABLE systems (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,   -- viaja en la foto de la papelera del cliente
  name          text NOT NULL CHECK (name = btrim(name) AND name <> ''),
  app_url       text CHECK (app_url ~ '^https?://[^/@\s]+(/\S*)?$'),         -- enlace al sistema construido (sin usuario:clave@)
  prod_url      text CHECK (prod_url ~ '^https?://[^/@\s]+(/\S*)?$'),
  check_url     text CHECK (check_url ~ '^https?://[^/@\s]+(/\S*)?$'),       -- lo que se verifica; por defecto prod_url y luego app_url
  repo_url      text CHECK (repo_url ~ '^https?://[^/@\s]+(/\S*)?$'),
  server        text CHECK (server IS NULL OR (server = btrim(server) AND server <> '')),
  admin_user    text CHECK (admin_user IS NULL OR (admin_user = btrim(admin_user) AND admin_user <> '')),  -- usuario interno de gestion; NUNCA la clave
  notes         text CHECK (notes IS NULL OR (notes = btrim(notes) AND notes <> '')),
  monitor       boolean NOT NULL DEFAULT true,
  active        boolean NOT NULL DEFAULT true,
  status        text NOT NULL DEFAULT 'desconocido' CHECK (status IN ('desconocido', 'arriba', 'caido')),
  status_since  timestamptz,
  last_check_at timestamptz,
  last_ok_at    timestamptz,
  last_code     integer,
  last_ms       integer,
  last_error    text,
  fail_streak   integer NOT NULL DEFAULT 0 CHECK (fail_streak >= 0),
  created_by    uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX systems_client_idx ON systems (client_id);
CREATE TRIGGER systems_updated_at BEFORE UPDATE ON systems FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Historial corto de verificaciones (se poda a 7 dias al verificar): sirve para el semaforo y para ver cuando cayo.
CREATE TABLE system_checks (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  system_id uuid NOT NULL REFERENCES systems (id) ON DELETE CASCADE,
  at        timestamptz NOT NULL DEFAULT now(),
  ok        boolean NOT NULL,
  code      integer,
  ms        integer,
  error     text
);
CREATE INDEX system_checks_system_at_idx ON system_checks (system_id, at DESC);

-- Acuerdos de la reunion semanal: log liviano. No se borran: se marcan cumplidos o descartados.
CREATE TABLE agreements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_date date NOT NULL DEFAULT ((now() AT TIME ZONE 'America/Caracas')::date),
  body         text NOT NULL CHECK (body = btrim(body) AND body <> '' AND length(body) <= 1000),
  owner_id     uuid REFERENCES users (id) ON DELETE SET NULL,          -- quien se compromete (opcional)
  due_date     date,
  status       text NOT NULL DEFAULT 'abierto' CHECK (status IN ('abierto', 'cumplido', 'descartado')),
  closed_at    timestamptz,
  created_by   uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agreements_closed_ck CHECK ((status = 'abierto') = (closed_at IS NULL))
);
CREATE INDEX agreements_status_date_idx ON agreements (status, meeting_date DESC);
CREATE TRIGGER agreements_updated_at BEFORE UPDATE ON agreements FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Avisos del hub: acuerdos nuevos y sistemas que caen o se recuperan (estos dos los trae el sistema, no un socio).
ALTER TABLE activity DROP CONSTRAINT activity_kind_check;
ALTER TABLE activity ADD CONSTRAINT activity_kind_check CHECK (kind IN
  ('cliente_nuevo', 'posible_nuevo', 'tarea_nueva', 'tarea_completada', 'cobro_cobrado', 'cambio_etapa', 'cliente_ganado', 'cliente_perdido', 'lead_meta',
   'acuerdo_nuevo', 'sistema_caido', 'sistema_recuperado'));

-- =====================================================================================================================
-- 3) Migracion de datos: se acaban los hacks. El cliente ficticio "HAYAI (interno)" se archiva y su(s) proyecto(s) pasan a ser
--    internos (sin cliente). Lo que esos proyectos gastaron cae en "Gastos generales de HAYAI" (la fila de Finanzas se mantiene):
--    el total no cambia. Si no existe ese cliente (BD de desarrollo, pruebas), no pasa nada.
-- =====================================================================================================================
DO $$
DECLARE fake uuid[];
BEGIN
  SELECT coalesce(array_agg(id), '{}') INTO fake FROM clients WHERE lower(btrim(name)) IN ('hayai (interno)', 'hayai interno', 'hayai - interno');
  IF cardinality(fake) = 0 THEN RETURN; END IF;
  UPDATE projects SET client_id = NULL WHERE client_id = ANY (fake);
  -- Gastos imputados directamente al cliente ficticio: pasan a generales (los de proyecto ya quedan generales al soltar el cliente).
  UPDATE expenses SET scope = 'general', client_id = NULL WHERE client_id = ANY (fake) AND scope = 'cliente';
  UPDATE clients SET archived_at = coalesce(archived_at, now()) WHERE id = ANY (fake);
END $$;

-- =====================================================================================================================
-- 4) Migracion de datos: el cobro de Super Miga del 07/10/2026 (primera parte, $75 en bolivares por transferencia).
--    Solo si hay UN candidato claro (cliente "Super Miga", $75, sin referencia aun, cobrado o fechado ese dia): si no, no toca nada.
-- =====================================================================================================================
DO $$
DECLARE pid uuid; n int; uid uuid;
BEGIN
  SELECT id INTO uid FROM users WHERE lower(name) = 'elis';
  SELECT count(*), min(p.id::text)::uuid INTO n, pid
    FROM payments p JOIN clients c ON c.id = p.client_id
   WHERE lower(c.name) LIKE '%super miga%' AND p.amount = 75 AND p.bank_reference IS NULL AND p.received_by IS NULL
     AND (p.status = 'cobrado' OR p.date = DATE '2026-10-07');
  IF n = 1 AND uid IS NOT NULL THEN
    UPDATE payments SET status = 'cobrado', amount_bs = 65540.25, exchange_rate = 873.87, rate_date = DATE '2026-10-07',
      bank_reference = '071026007463', bank_origin = 'Bancrecer', origin_last4 = '8017', bank_destination = 'Mercantil',
      received_by = uid, received_by_source = 'manual', method = 'transferencia'
     WHERE id = pid;
  END IF;
END $$;
