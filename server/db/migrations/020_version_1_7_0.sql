-- Versión 1.7.0 «Chat interno»: el canal de notas entre astronautas, junto a la campana. Se siembra aquí (como la 1.6.0) para que salga con el
-- despliegue, sin pasos manuales. author_id queda NULL («Equipo HAYAI»); announced_at también: al arrancar el sistema ya desplegado el
-- servidor avisa al equipo UNA vez (campana + banner «Nueva actualización v1.7.0»). Idempotente: si alguien ya publicó la 1.7.0 a mano, no se toca.
INSERT INTO app_versions (version, title, summary, changes, released_on) VALUES
('1.7.0', 'Chat interno',
 'Un canal de notas para todo el equipo, junto a la campana: escribes, etiquetas con @ y a quien mencionas se le marca en su icono. Las apps externas también pueden escribir por la API y el MCP.',
 ARRAY[
   'Icono de mensajes junto a la campana, con contador de no leídos; cambia de color si alguien te mencionó y aún no lo viste.',
   'Panel de chat de un solo canal: cada nota muestra el nombre del astronauta, la hora y «(editado)» si se corrigió. Llega en vivo, sin recargar.',
   'Menciones con @: al escribir @ aparece el selector de astronautas; el mensaje resalta a quien mencionas y a esa persona se le avisa.',
   'Editas y borras tus propias notas (un administrador puede borrar cualquiera); lo borrado va a la Papelera y se restaura 30 días.',
   'API v1 y MCP: las apps externas leen y publican con su llave (autor = dueño de la llave, fuente y clave_externa para no duplicar), editan y borran según sus permisos y marcan leído.'
 ], DATE '2026-10-08')
ON CONFLICT (version) DO NOTHING;
