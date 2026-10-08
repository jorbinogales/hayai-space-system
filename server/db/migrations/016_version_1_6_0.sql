-- Versión 1.6.0 «Feed de oportunidades»: cierra la fase 2. Se siembra aquí (como la 1.5.0) porque publicar por la API exige una llave
-- de producción: así la versión sale con el despliegue, sin pasos manuales. author_id queda NULL («Equipo HAYAI»); announced_at también:
-- al arrancar el sistema ya desplegado el servidor avisa al equipo UNA vez (campana + banner «Nueva actualización v1.6.0»).
-- Idempotente: si alguien ya publicó la 1.6.0 a mano, no se toca.
INSERT INTO app_versions (version, title, summary, changes, released_on) VALUES
('1.6.0', 'Feed de oportunidades',
 'Las oportunidades que encuentran Muse y Growi llegan a una bandeja del Hub, y las pantallas avisan y se reordenan: banner de actualización en vivo, campana con contador, planeta Marketing en el home.',
 ARRAY[
   'Feed de oportunidades: prospectos, ideas y noticias que publican los agentes (API, MCP), con aviso en la campana y su pantalla en el Hub para revisarlos, proponerlos y convertirlos en cliente o tarea de un toque.',
   'Banner de actualización en vivo: cuando sale una versión nueva aparece arriba, por encima de todo, con «Ver cambios» y el botón para recargar.',
   'Campana con contador en la barra superior y la pestaña Equipo separada de Alertas: Equipo muestra solo la actividad del equipo.',
   'Backfill del cobro de Super Miga con los datos del comprobante: monto en bolívares, tasa, referencia, bancos, quién lo recibió y método.',
   'Planeta Marketing en el home, con el embudo comercial; Gastos pasa a vivir dentro de Finanzas (vista Resumen | Gastos).',
   'El núcleo HAYAI completo es clickeable y se anima al pasar el cursor, como los demás planetas.'
 ], DATE '2026-10-08')
ON CONFLICT (version) DO NOTHING;
