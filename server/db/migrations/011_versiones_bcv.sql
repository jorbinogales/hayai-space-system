-- Barra superior: versión del sistema (con su historial tipo "releases") y tasa BCV en caché.

-- Historial de versiones. Solo se agrega: nadie edita ni borra lo publicado. La versión actual es la más alta.
-- author_id queda NULL en las entradas históricas anteriores a este registro (se muestran como "Equipo HAYAI").
CREATE TABLE app_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version     text NOT NULL UNIQUE CHECK (version ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$'),
  title       text CHECK (title IS NULL OR (title = btrim(title) AND title <> '' AND char_length(title) <= 80)),
  summary     text CHECK (summary IS NULL OR (summary = btrim(summary) AND summary <> '' AND char_length(summary) <= 600)),
  changes     text[] NOT NULL CHECK (cardinality(changes) BETWEEN 1 AND 60),
  released_on date NOT NULL,
  author_id   uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- Orden por número de versión (no alfabético: 1.10.0 va después de 1.9.0).
CREATE INDEX app_versions_order_idx ON app_versions (((string_to_array(version, '.'))[1]::int) DESC, ((string_to_array(version, '.'))[2]::int) DESC, ((string_to_array(version, '.'))[3]::int) DESC);

INSERT INTO app_versions (version, title, summary, changes, released_on) VALUES
('1.0.0', 'Versión de mierda',
 'La primera versión de HAYAI Space: lo básico para llevar clientes, proyectos y plata, sin seguimiento comercial ni integraciones.',
 ARRAY[
   'Escena espacial con los planetas de cada área y sesión con PIN personal para los tres socios.',
   'Clientes y posibles clientes con sus ítems de servicio, la inicial y los cobros por cuota.',
   'Proyectos con responsable, estado y fecha de entrega; tareas por proyecto con calendario.',
   'Gastos (generales, de cliente y de proyecto) y Finanzas con ingresos, gastos, balance y por cobrar.',
   'Historial de movimientos y factura imprimible del cliente.'
 ], COALESCE((SELECT (min(created_at) AT TIME ZONE 'America/Caracas')::date FROM users), DATE '2026-10-07')), -- fecha aproximada: la del primer socio creado
('1.5.0', 'Del pipeline al hub',
 'El salto comercial y operativo: seguimiento de ventas, propuestas, cobros con comprobante, integraciones para los agentes y el hub central.',
 ARRAY[
   'Actividad del equipo en vivo: campana, avisos laterales y paleta de búsqueda global.',
   'Pipeline de 7 etapas (prospecto, visita agendada, visita realizada, propuesta en armado, propuesta presentada, ganado, perdido) con probabilidad y valor ponderado.',
   'Ficha del cliente con contacto, redes, próxima acción, bitácora de interacciones y alertas de cuotas vencidas y seguimientos.',
   'Propuestas versionadas (mensualidad base, extras mensuales y únicos) con catálogo de ofertas; al ganar se genera el esquema de cobro en la misma operación.',
   'Proyectos con hitos, checklist y tareas por hito; proyectos internos sin cliente; estados pausado y completado.',
   'Cobros con detalle: bolívares, tasa, referencia bancaria, bancos, quién recibió y método; comprobante con lectura automática de la cédula para asignar al socio que recibió.',
   'Factura del cliente con su teléfono de WhatsApp.',
   'Ingesta automática de leads de Meta Ads (webhook firmado, idempotente) con reparto equitativo entre los socios.',
   'API REST v1 y servidor MCP con llaves por socio y permisos (lectura, escritura, borrado) para Muse y Growi.',
   'Papelera de 30 días y archivo de clientes y proyectos.',
   'Hub central del planeta HAYAI: pulso interno, astronautas con su carga, bitácora interna, acuerdos de la reunión semanal y semáforo de los sistemas de los clientes.',
   'Embudo de Marketing con cohorte por origen y estado de Meta Ads.',
   'Barra superior con la versión, la tasa BCV del día e historial de versiones.'
 ], DATE '2026-10-07');

-- Tasa BCV (dólar oficial), una fila por día de la tasa. La caché vive en la BD para sobrevivir reinicios y para que
-- la barra nunca quede en blanco si la fuente no responde: se muestra la última disponible con su fecha.
CREATE TABLE exchange_rates (
  rate_date  date NOT NULL,
  source     text NOT NULL CHECK (source <> ''),
  rate       numeric(14,4) NOT NULL CHECK (rate > 0),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rate_date, source)
);

-- Aviso al equipo cuando alguien publica una versión.
ALTER TABLE activity DROP CONSTRAINT activity_kind_check;
ALTER TABLE activity ADD CONSTRAINT activity_kind_check CHECK (kind IN
  ('cliente_nuevo', 'posible_nuevo', 'tarea_nueva', 'tarea_completada', 'cobro_cobrado', 'cambio_etapa', 'cliente_ganado', 'cliente_perdido', 'lead_meta',
   'acuerdo_nuevo', 'sistema_caido', 'sistema_recuperado', 'version_nueva'));
