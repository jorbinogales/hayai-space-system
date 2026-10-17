-- 036_version_1_8_2: la entrada del historial de versiones para v1.8.2 «Radar de competidores». Solo datos (no cambia el esquema).
INSERT INTO app_versions (version, title, summary, changes, released_on) VALUES
('1.8.2', 'Radar de competidores',
 'El Feed estrena una sección para tener a la vista a quién le compite HAYAI.',
 ARRAY[
   'Feed: nuevo botón «Competidores» con una ficha por cada uno de los 12 competidores mapeados: qué vende, cuánto cuesta, su mensaje principal, a quién le habla y su fortaleza y debilidad frente a HAYAI.',
   'Competidores: buscador por nombre y filtro por grupo (SaaS venezolano, gratis y offline, software factory y tecnología para restaurantes).',
   'Competidores: las 3 oportunidades de HAYAI frente a ellos quedan siempre a la vista, arriba de las fichas.',
   'Competidores: la lista es viva. Se pueden agregar, editar y eliminar competidores desde la pantalla, y también por la API (GET, POST, PATCH y DELETE en /competidores).'
 ], DATE '2026-10-17')
ON CONFLICT (version) DO NOTHING;
