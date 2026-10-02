-- 001_init: esquema base de HAYAI (socios, sesiones, clientes, cobros, proyectos, gastos, tareas).
-- Lo aplica server/db/migrate.mjs dentro de una transaccion; no lo edites una vez aplicado (crea 002_*.sql).
-- Convenciones: PK uuid (gen_random_uuid, nativo desde PG13), dinero numeric(14,2) > 0, dominios con CHECK (no enums),
-- timestamps timestamptz, fechas de negocio como date. Lo contable nunca se borra en cascada (ON DELETE RESTRICT).

-- updated_at lo pone la BD, no la app.
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Socios ("astronautas"). Se desactivan (active=false), no se borran: son autores de datos contables.
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL CHECK (name = btrim(name) AND name <> ''),
  avatar          text NOT NULL,                       -- semilla del blob
  role            text NOT NULL DEFAULT 'SOCIO' CHECK (role IN ('ADMIN', 'SOCIO')),
  pin_hash        text NOT NULL,                       -- scrypt generado por la app (incluye sal/parametros); nunca el PIN
  must_change_pin boolean NOT NULL DEFAULT true,       -- PIN inicial 000000
  active          boolean NOT NULL DEFAULT true,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_name_lower_uq ON users (lower(name));

-- Sesiones: solo el hash del token opaco (si se filtra la tabla, los tokens no sirven).
CREATE TABLE sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,                     -- el UNIQUE es el indice de busqueda por token
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_idx ON sessions (user_id);  -- "cerrar todas las sesiones" de un socio
CREATE INDEX sessions_expires_idx ON sessions (expires_at); -- limpieza de expiradas

CREATE TABLE clients (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (name = btrim(name) AND name <> ''),
  avatar     text NOT NULL,
  created_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Desglose de la inicial. Es detalle del cliente: si algun dia se borra un cliente (sin cobros), sus items se van con el.
CREATE TABLE client_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  concept    text NOT NULL CHECK (btrim(concept) <> ''),
  amount     numeric(14,2) NOT NULL CHECK (amount > 0),
  currency   char(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX client_items_client_idx ON client_items (client_id);

-- Movimientos de cobro del cliente (la inicial cobrada y los pagos cobrados/pendientes).
CREATE TABLE payments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  uuid NOT NULL REFERENCES clients (id) ON DELETE RESTRICT,
  date       date NOT NULL,
  concept    text NOT NULL CHECK (btrim(concept) <> ''),
  amount     numeric(14,2) NOT NULL CHECK (amount > 0),
  currency   char(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  kind       text NOT NULL CHECK (kind IN ('inicial', 'pago')),
  status     text NOT NULL CHECK (status IN ('cobrado', 'pendiente')),
  created_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_client_date_idx ON payments (client_id, date);              -- timeline del cliente
CREATE INDEX payments_pending_date_idx ON payments (date) WHERE status = 'pendiente'; -- "proximos cobros" de todos
CREATE UNIQUE INDEX payments_one_initial_uq ON payments (client_id) WHERE kind = 'inicial'; -- una inicial por cliente

CREATE TABLE projects (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (name = btrim(name) AND name <> ''),
  icon       text NOT NULL CHECK (icon IN ('globe', 'phone', 'chart', 'cart', 'palette', 'box', 'code')),
  client_id  uuid NOT NULL REFERENCES clients (id) ON DELETE RESTRICT,
  owner_id   uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT, -- responsable
  status     text NOT NULL DEFAULT 'planeacion' CHECK (status IN ('activo', 'entrega', 'planeacion')), -- planeacion = "Por visitar"
  due_date   date,
  created_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_client_idx ON projects (client_id);
CREATE INDEX projects_owner_idx ON projects (owner_id);

CREATE TABLE expenses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date       date NOT NULL,
  concept    text NOT NULL CHECK (btrim(concept) <> ''),
  amount     numeric(14,2) NOT NULL CHECK (amount > 0),
  currency   char(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  category   text NOT NULL CHECK (category IN ('Herramientas', 'Infraestructura', 'Operación', 'Marketing', 'Equipos', 'Otros')),
  scope      text NOT NULL CHECK (scope IN ('general', 'cliente', 'proyecto')),
  client_id  uuid REFERENCES clients (id) ON DELETE RESTRICT,
  project_id uuid REFERENCES projects (id) ON DELETE RESTRICT,
  status     text NOT NULL CHECK (status IN ('pagado', 'pendiente')),
  created_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expenses_scope_ref_ck CHECK (
       (scope = 'general'  AND client_id IS NULL     AND project_id IS NULL)
    OR (scope = 'cliente'  AND client_id IS NOT NULL AND project_id IS NULL)
    OR (scope = 'proyecto' AND project_id IS NOT NULL AND client_id IS NULL)
  )
);
CREATE INDEX expenses_date_idx ON expenses (date);
CREATE INDEX expenses_client_idx ON expenses (client_id) WHERE client_id IS NOT NULL;
CREATE INDEX expenses_project_idx ON expenses (project_id) WHERE project_id IS NOT NULL;

-- Tareas: checklist del proyecto, no contable; mueren con el proyecto.
CREATE TABLE tasks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  title      text NOT NULL CHECK (btrim(title) <> ''),
  done       boolean NOT NULL DEFAULT false,
  done_at    timestamptz,
  created_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (done OR done_at IS NULL)
);
CREATE INDEX tasks_project_idx ON tasks (project_id, created_at);

CREATE TRIGGER users_updated_at    BEFORE UPDATE ON users    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER clients_updated_at  BEFORE UPDATE ON clients  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER payments_updated_at BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER projects_updated_at BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER expenses_updated_at BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tasks_updated_at    BEFORE UPDATE ON tasks    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
