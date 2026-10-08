-- v1.6.7 «Órbita fina III»: red de seguridad del feed (devolver al feed) y notas de conversión ordenadas.
-- No cambia tablas: solo siembra la versión. Queda debajo de la 1.7.0 (el historial se ordena por número).
INSERT INTO app_versions (version, title, summary, changes, released_on) VALUES
('1.6.7', 'Órbita fina III',
 'Devolver al feed desde la ficha del posible cliente y notas de conversión ordenadas, con enlace al hallazgo.',
 ARRAY[
   'Devolver al feed: en la ficha de un posible cliente que salió del feed, un botón lo manda a la papelera y el hallazgo vuelve a Nuevos. Sin límite de tiempo y para cualquier socio.',
   'Notas de conversión en tres bloques: «Del feed: fuente · fecha» con enlace al ítem original, Resumen corto y Contacto en líneas.',
   'El enlace «Ver en el feed» de la nota abre el feed con ese hallazgo enfocado (#hub/feed/<id>).',
   'La ficha muestra de qué hallazgo salió el cliente, con «Ver el hallazgo».'
 ], DATE '2026-10-08')
ON CONFLICT (version) DO NOTHING;
