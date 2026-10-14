-- 034_version_1_8_1: la entrada del historial de versiones para v1.8.1 «Copiloto invisible». Solo datos (no cambia el esquema).
INSERT INTO app_versions (version, title, summary, changes, released_on) VALUES
('1.8.1', 'Copiloto invisible',
 'Correcciones de bugs y fixes.',
 ARRAY[
   'Feed: corrección de problemas con el reconocimiento automático de opciones. Las acciones sugeridas ya no proponen venderle a un cliente lo que ya tiene contratado, como la mensualidad, aunque solo conste por escrito en su proyecto.',
   'Feed: una oportunidad reconoce a su cliente aunque el nombre venga abreviado, y se retiró una que sugería venderle la mensualidad a una clienta que ya la tiene.',
   'Hub: brief matutino personalizado debajo del Feed. Cobros que vencen hoy y en los próximos 3 días, visitas agendadas, lo que se movió ayer y potenciales estancados, con cifras concretas.',
   'Brief: cada socio ve primero lo suyo (sus clientes, tareas y proyectos, según su rol). Se prepara una vez al día y se puede actualizar cuando quieras.'
 ], DATE '2026-10-14')
ON CONFLICT (version) DO NOTHING;
