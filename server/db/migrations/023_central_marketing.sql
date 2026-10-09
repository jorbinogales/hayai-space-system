-- 023_central_marketing (v1.7.5): el planeta Marketing pasa de una pantalla de embudo a una mini plataforma por pestañas:
-- Panel, Keywords, Competidores, Contenido y Campañas. Lo aplica server/db/migrate.mjs dentro de una transacción; no lo edites
-- una vez aplicado (crea 024_*.sql).

-- ---------- leads: utm_source (el origen ya existe: clients.lead_source) ----------
ALTER TABLE clients ADD COLUMN utm_source text CHECK (utm_source IS NULL OR char_length(utm_source) BETWEEN 1 AND 80);

-- ---------- keywords ----------
CREATE TABLE mk_keywords (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  texto         text NOT NULL CHECK (char_length(texto) BETWEEN 1 AND 120),
  -- minúsculas, sin acentos y sin espacios dobles: la llave contra duplicados
  texto_norm    text NOT NULL CHECK (char_length(texto_norm) BETWEEN 1 AND 120),
  intencion     text NOT NULL CHECK (intencion IN ('informacional', 'comercial', 'local', 'marca')),
  estado        text NOT NULL DEFAULT 'por_atacar' CHECK (estado IN ('por_atacar', 'en_contenido', 'posicionada', 'descartada')),
  fuente        text NOT NULL CHECK (fuente IN ('autocompletado', 'serp', 'manual')),
  semilla       text CHECK (semilla IS NULL OR char_length(semilla) <= 120),
  -- la idea de contenido que se creó en el feed a partir de esta keyword (una sola)
  idea_item_id  uuid REFERENCES feed_items (id) ON DELETE SET NULL,
  created_by    uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (texto_norm)
);
CREATE INDEX mk_keywords_estado_idx ON mk_keywords (estado, intencion);

-- SERP consultados (Brightdata): se guardan para cruzarlos con los competidores sin volver a gastar saldo.
CREATE TABLE mk_serp (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword_id     uuid NOT NULL REFERENCES mk_keywords (id) ON DELETE CASCADE,
  consultado_el  timestamptz NOT NULL DEFAULT now(),
  consultado_por uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  costo_estimado numeric(10, 5) NOT NULL DEFAULT 0 CHECK (costo_estimado >= 0),
  -- [{ posicion, titulo, dominio, url }]
  resultados     jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX mk_serp_keyword_idx ON mk_serp (keyword_id, consultado_el DESC);

-- ---------- competidores ----------
CREATE TABLE mk_competidores (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      text NOT NULL CHECK (char_length(nombre) BETWEEN 1 AND 120),
  nombre_norm text NOT NULL,
  web         text CHECK (web IS NULL OR char_length(web) <= 300),
  instagram   text CHECK (instagram IS NULL OR char_length(instagram) <= 120),
  notas       text CHECK (notas IS NULL OR char_length(notas) <= 4000),
  created_by  uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(), -- «fecha de alta»
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX mk_competidores_nombre_idx ON mk_competidores (nombre_norm) WHERE archived_at IS NULL;

-- ---------- contenido (kanban: idea → producción → publicado) ----------
CREATE TABLE mk_contenidos (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo         text NOT NULL CHECK (char_length(titulo) BETWEEN 1 AND 160),
  keyword_id     uuid REFERENCES mk_keywords (id) ON DELETE SET NULL,
  responsable_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  fecha_objetivo date,
  notas          text CHECK (notas IS NULL OR char_length(notas) <= 4000),
  estado         text NOT NULL DEFAULT 'idea' CHECK (estado IN ('idea', 'produccion', 'publicado')),
  publicado_en   text CHECK (publicado_en IS NULL OR char_length(publicado_en) <= 120),
  enlace         text CHECK (enlace IS NULL OR char_length(enlace) <= 500),
  publicado_el   timestamptz,
  feed_item_id   uuid REFERENCES feed_items (id) ON DELETE SET NULL,
  created_by     uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  archived_at    timestamptz,
  -- publicar exige saber dónde y con qué enlace
  CONSTRAINT mk_contenidos_publicado_ck CHECK (estado <> 'publicado' OR (publicado_en IS NOT NULL AND enlace IS NOT NULL))
);
CREATE INDEX mk_contenidos_estado_idx ON mk_contenidos (estado, fecha_objetivo) WHERE archived_at IS NULL;
CREATE INDEX mk_contenidos_keyword_idx ON mk_contenidos (keyword_id);

-- ---------- vínculos del feed: ahora también «contenido» (mismo patrón de la 1.6.6) ----------
ALTER TABLE feed_item_vinculos DROP CONSTRAINT feed_item_vinculos_kind_check;
ALTER TABLE feed_item_vinculos ADD CONSTRAINT feed_item_vinculos_kind_check
  CHECK (kind IN ('posible_cliente', 'cliente', 'tarea', 'proyecto', 'propuesta', 'seguimiento', 'contenido'));
ALTER TABLE feed_items DROP CONSTRAINT feed_items_converted_to_check;
ALTER TABLE feed_items ADD CONSTRAINT feed_items_converted_to_check
  CHECK (converted_to IN ('posible_cliente', 'cliente', 'tarea', 'proyecto', 'propuesta', 'seguimiento', 'contenido'));

-- ---------- versión ----------
INSERT INTO app_versions (version, title, summary, changes, released_on) VALUES
('1.7.5', 'Central de marketing',
 'Marketing pasa a ser una mini plataforma por pestañas (Panel, Keywords, Competidores, Contenido y Campañas) y el Panel queda más claro.',
 ARRAY[
   'Panel: «De dónde llegan» muestra siempre el desglose completo (abiertos, ganados, perdidos y alta directa) y la barra dice qué representa.',
   'Origen obligatorio al crear un lead (por defecto «Otro») y campo utm_source; los históricos quedan como «Sin origen (histórico)».',
   'Panel: la nota del embudo se vuelve tres viñetas y un «¿Cómo se calcula?»; «Perdido» es una métrica del período, sin contradicciones.',
   'Panel: «Abierto» y «Ponderado (por probabilidad)» con su explicación; «Meta Ads» dice «Pendiente de conexión» mientras no hay conexión.',
   'Panel: nombres unificados (período, Tasa de cierre) y pie sin columnas vacías.',
   'Keywords: investiga una palabra semilla con el autocompletado de Google (gratis), guarda en lote, filtra por intención y estado, sin duplicados.',
   'Keywords: «Ver SERP real» (top 10 vía Brightdata) con aviso de costo antes de gastar saldo, y marca a los competidores.',
   'Keywords: «Crear idea de contenido» (al feed) y «Mover a contenido».',
   'Competidores: alta, edición y archivo; «Lo que sabemos» con los hallazgos del espía de anuncios y cruce con los SERP ya consultados.',
   'Contenido: tablero Idea, En producción y Publicado (en móvil, una lista); publicar pide dónde y el enlace; las ideas del feed se mueven a contenido y quedan vinculadas.',
   'Campañas: solo lectura de Meta (gasto, leads y costo por lead de 30 días) con las credenciales solo en el servidor; mientras no estén, la pestaña dice «Pendiente de conexión».',
   'La tarjeta del Hub va encima del núcleo y «Finanzas 2026» pasa a «Finanzas».'
 ], DATE '2026-10-08')
ON CONFLICT (version) DO NOTHING;
