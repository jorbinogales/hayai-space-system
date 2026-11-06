-- 040_tablero: módulo «tablero» (kanban tipo Trello): columnas, tarjetas y comentarios por tenant. Una tarjeta NO depende de un cliente,
-- pero puede enlazarse a uno. Lo aplica server/db/migrate.mjs dentro de una transacción; no lo edites una vez aplicado (crea 041_*.sql).
--
-- Decisiones:
--  - Tabla `boards` aunque hoy haya UN tablero por tenant (boards_one_per_tenant_uq lo garantiza y hace inequívoco «el tablero»). Abrir
--    varios = DROP de ese índice, nada más: las columnas ya cuelgan de board_id. Colgarlas directo del tenant ahorraría una tabla de una
--    fila, pero pasar luego a varios tableros obligaría a agregar board_id, rellenarlo y cambiar FKs y consultas.
--  - Las tarjetas no llevan board_id: su tablero es el de su columna (un solo dato, nada que se contradiga).
--  - Mismas reglas que la 039: tenant_id NOT NULL sin DEFAULT en las 4 tablas y FK compuestas (tenant_id, x_id) -> padre (tenant_id, id).
--    El cliente de una tarjeta va por FK compuesta: no se puede enlazar uno de otro tenant. El responsable es un socio (users es global):
--    que sea miembro del tenant (o ADMIN) lo valida la app contra user_tenants; la BD solo garantiza que el socio existe.
--  - Orden (columnas y tarjetas): `position numeric` fraccionaria, sin UNIQUE. El servidor calcula la posición con los vecinos que hay en la
--    BD (nunca la manda el navegador) bloqueando la fila del padre (la columna destino o el tablero) con FOR NO KEY UPDATE, así dos
--    arrastres al mismo lugar se serializan y no empatan. Entre a y b: trim_scale((a + b) * 0.5) (exacto en numeric); arriba: primera - 1024;
--    abajo: última + 1024; vacía: 1024. Si la nueva posición queda con scale() > 10 se renumera esa columna (1024, 2048, ...) en la misma
--    transacción. Sin UNIQUE a propósito: renumerar en un solo UPDATE y restaurar de la papelera (que reinserta la posición vieja) no
--    pueden chocar con 23505. Desempate estable: ORDER BY position, id.
--  - Borrar una tarjeta o una columna = papelera (entidades 'tarjeta' y 'columna'; la columna se lleva sus tarjetas, archivadas incluidas,
--    y los comentarios). La FK tarjeta -> columna es RESTRICT: la BD no deja borrar una columna con tarjetas sin pasar por la foto.
--    Archivar una tarjeta (archived_at) la saca del tablero sin borrarla (como clientes y proyectos). Los comentarios se borran de verdad
--    (solo su autor o un ADMIN, lo valida la app) y viajan en la foto de su tarjeta.
--  - updated_at de board_cards es la versión del CONTENIDO (If-Match): solo cambia al editar título, descripción, prioridad, responsable,
--    cliente o fecha. Mover, reordenar, renumerar o archivar no la tocan, así arrastrar una tarjeta no le da un 409 a quien la está editando.
--  - Cada tenant tiene su tablero con 4 columnas por defecto: esta migración siembra los que ya existen y un trigger en tenants siembra los
--    nuevos (cualquier camino que cree un tenant: admin, seed, pruebas). La app nunca tiene que crearlo.
--  - En vivo: un trigger avisa por el canal 'tablero' (como 'proyecto' de la 026) con { op, seccion, id, tenant_id }, sin datos. Así también
--    avisa lo que entre por la API, el MCP, la papelera o un borrado en cascada.
--  - Idempotente: correrla otra vez no cambia nada.

-- =====================================================================================================================
-- 1) Tablas
-- =====================================================================================================================
CREATE TABLE IF NOT EXISTS boards (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  name       text NOT NULL DEFAULT 'Tablero' CHECK (name = btrim(name) AND name <> '' AND length(name) <= 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS boards_tenant_uq ON boards (tenant_id, id);            -- destino de las FK compuestas
CREATE UNIQUE INDEX IF NOT EXISTS boards_one_per_tenant_uq ON boards (tenant_id);       -- regla de hoy: un tablero por tenant
CREATE OR REPLACE TRIGGER boards_updated_at BEFORE UPDATE ON boards FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS board_columns (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  board_id   uuid NOT NULL,
  name       text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 60),
  position   numeric NOT NULL CONSTRAINT board_columns_position_ck CHECK (position > '-Infinity' AND position < 'Infinity'), -- fuera NaN e infinitos
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT board_columns_board_id_fkey FOREIGN KEY (tenant_id, board_id) REFERENCES boards (tenant_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS board_columns_tenant_uq ON board_columns (tenant_id, id);
CREATE INDEX IF NOT EXISTS board_columns_board_idx ON board_columns (tenant_id, board_id, position); -- columnas del tablero en orden
CREATE OR REPLACE TRIGGER board_columns_updated_at BEFORE UPDATE ON board_columns FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS board_cards (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  column_id   uuid NOT NULL,
  position    numeric NOT NULL CONSTRAINT board_cards_position_ck CHECK (position > '-Infinity' AND position < 'Infinity'),
  title       text NOT NULL CHECK (title = btrim(title) AND title <> '' AND length(title) <= 200),
  description text CHECK (description IS NULL OR (description = btrim(description) AND description <> '' AND length(description) <= 4000)),
  priority    text NOT NULL DEFAULT 'media' CHECK (priority IN ('baja', 'media', 'alta', 'urgente')),
  assignee_id uuid REFERENCES users (id) ON DELETE SET NULL,  -- opcional; la app exige que sea miembro del tenant con 'tablero' (o ADMIN)
  client_id   uuid,                                            -- opcional; FK compuesta: solo un cliente del mismo tenant
  due_date    date,
  archived_at timestamptz,                                     -- NULL = en el tablero
  created_by  uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),              -- versión del contenido (If-Match): ver el trigger de abajo
  CONSTRAINT board_cards_column_id_fkey FOREIGN KEY (tenant_id, column_id) REFERENCES board_columns (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT board_cards_client_id_fkey FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id) ON DELETE SET NULL (client_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS board_cards_tenant_uq ON board_cards (tenant_id, id);
-- Tablero completo (WHERE archived_at IS NULL ORDER BY column_id, position, id); también cubre la FK RESTRICT y vaciar una columna.
CREATE INDEX IF NOT EXISTS board_cards_column_idx ON board_cards (tenant_id, column_id, position);
CREATE INDEX IF NOT EXISTS board_cards_assignee_idx ON board_cards (tenant_id, assignee_id) WHERE assignee_id IS NOT NULL AND archived_at IS NULL; -- «mis tarjetas»
CREATE INDEX IF NOT EXISTS board_cards_client_idx ON board_cards (tenant_id, client_id) WHERE client_id IS NOT NULL; -- ficha del cliente y su FK
CREATE OR REPLACE TRIGGER board_cards_updated_at BEFORE UPDATE OF title, description, priority, assignee_id, client_id, due_date ON board_cards
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS board_card_comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  card_id    uuid NOT NULL,
  author_id  uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  body       text NOT NULL CHECK (body = btrim(body) AND body <> '' AND length(body) <= 4000),
  edited_at  timestamptz,                                      -- NULL = nunca editado (para el «(editado)», como el chat)
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT board_card_comments_edited_ck CHECK (edited_at IS NULL OR edited_at >= created_at),
  CONSTRAINT board_card_comments_card_id_fkey FOREIGN KEY (tenant_id, card_id) REFERENCES board_cards (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS board_card_comments_card_idx ON board_card_comments (tenant_id, card_id, created_at); -- hilo, contador y su FK

-- =====================================================================================================================
-- 2) Catálogos: módulo, actividad y papelera
-- =====================================================================================================================
ALTER TABLE user_tenants DROP CONSTRAINT IF EXISTS user_tenants_modules_ck,
  ADD CONSTRAINT user_tenants_modules_ck CHECK (modules <@ ARRAY[
    'hub', 'feed', 'clientes', 'crm', 'cobros', 'proyectos', 'tareas', 'tablero', 'finanzas', 'marketing', 'sistemas', 'chat', 'integraciones', 'papelera'
  ]::text[]);

-- Actividad: creada, movida de columna (reordenar dentro de la misma no cuenta), comentada y asignada. Editar, archivar o borrar no avisan.
-- card_id sin FK, como client_id/project_id/task_id (008): el aviso sobrevive a la tarjeta.
ALTER TABLE activity ADD COLUMN IF NOT EXISTS card_id uuid;
ALTER TABLE activity DROP CONSTRAINT IF EXISTS activity_kind_check,
  ADD CONSTRAINT activity_kind_check CHECK (kind IN
  ('cliente_nuevo', 'posible_nuevo', 'tarea_nueva', 'tarea_completada', 'tarea_reasignada', 'cobro_cobrado', 'cambio_etapa', 'cliente_ganado',
   'cliente_perdido', 'lead_meta', 'acuerdo_nuevo', 'sistema_caido', 'sistema_recuperado', 'version_nueva', 'feed_nuevo',
   'tarjeta_nueva', 'tarjeta_movida', 'tarjeta_comentada', 'tarjeta_asignada'));

ALTER TABLE trash DROP CONSTRAINT IF EXISTS trash_entity_check,
  ADD CONSTRAINT trash_entity_check CHECK (entity IN
  ('cliente', 'proyecto', 'pago', 'gasto', 'tarea', 'interaccion', 'propuesta', 'hito', 'checklist_item', 'mensaje', 'tarjeta', 'columna'));

-- =====================================================================================================================
-- 3) Tablero inicial de cada tenant: los existentes aquí, los nuevos por trigger. Si el tenant ya tiene tablero, no hace nada.
-- =====================================================================================================================
CREATE OR REPLACE FUNCTION seed_tenant_board(t uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE b uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM boards WHERE tenant_id = t) THEN RETURN; END IF;
  INSERT INTO boards (tenant_id) VALUES (t) RETURNING id INTO b;
  INSERT INTO board_columns (tenant_id, board_id, name, position)
  SELECT t, b, v.name, v.pos FROM (VALUES ('Por hacer', 1024), ('En curso', 2048), ('En revisión', 3072), ('Hecho', 4096)) AS v (name, pos);
END $$;

CREATE OR REPLACE FUNCTION tenants_seed_board() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM seed_tenant_board(NEW.id);
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER tenants_seed_board AFTER INSERT ON tenants FOR EACH ROW EXECUTE FUNCTION tenants_seed_board();

SELECT seed_tenant_board(id) FROM tenants; -- todos, también los inactivos: si se reactivan, su tablero ya está

-- Acceso: los miembros actuales de HAYAI reciben 'tablero'. En los demás tenants nadie lo gana solo (tener 'tareas' no basta: es otro
-- módulo y lo da un ADMIN). Los ADMIN lo ven siempre, sin fila, en cuanto el catálogo MODULES de la app incluya 'tablero'.
UPDATE user_tenants ut SET modules = array_append(ut.modules, 'tablero')
FROM tenants t
WHERE t.id = ut.tenant_id AND t.slug = 'hayai' AND NOT ('tablero' = ANY (ut.modules));

-- =====================================================================================================================
-- 4) En vivo: canal 'tablero'. id = la columna (seccion 'columnas') o la tarjeta (secciones 'tarjetas' y 'comentarios').
--    Avisos idénticos dentro de una transacción se funden en uno. Se crea después de sembrar: la siembra no dispara avisos.
-- =====================================================================================================================
CREATE OR REPLACE FUNCTION notify_tablero() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN r := to_jsonb(OLD); ELSE r := to_jsonb(NEW); END IF;
  PERFORM pg_notify('tablero', json_build_object(
    'op', CASE TG_OP WHEN 'INSERT' THEN 'nuevo' WHEN 'DELETE' THEN 'borrado' ELSE 'editado' END,
    'seccion', TG_ARGV[0],
    'id', CASE TG_ARGV[0] WHEN 'comentarios' THEN r->>'card_id' ELSE r->>'id' END,
    'tenant_id', r->>'tenant_id')::text);
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER board_columns_en_vivo AFTER INSERT OR UPDATE OR DELETE ON board_columns
  FOR EACH ROW EXECUTE FUNCTION notify_tablero('columnas');
CREATE OR REPLACE TRIGGER board_cards_en_vivo AFTER INSERT OR UPDATE OR DELETE ON board_cards
  FOR EACH ROW EXECUTE FUNCTION notify_tablero('tarjetas');
CREATE OR REPLACE TRIGGER board_card_comments_en_vivo AFTER INSERT OR UPDATE OR DELETE ON board_card_comments
  FOR EACH ROW EXECUTE FUNCTION notify_tablero('comentarios');

-- =====================================================================================================================
-- 5) Comprobación: si algo quedó a medias, la migración entera se deshace.
-- =====================================================================================================================
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM tenants t WHERE NOT EXISTS (SELECT 1 FROM boards b WHERE b.tenant_id = t.id);
  IF n > 0 THEN RAISE EXCEPTION '040: % tenant(s) sin tablero', n; END IF;
  SELECT count(*) INTO n FROM user_tenants ut JOIN tenants t ON t.id = ut.tenant_id WHERE t.slug = 'hayai' AND NOT ('tablero' = ANY (ut.modules));
  IF n > 0 THEN RAISE EXCEPTION '040: % miembro(s) de HAYAI sin el módulo tablero', n; END IF;
END $$;
