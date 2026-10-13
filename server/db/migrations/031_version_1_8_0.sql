-- 031_version_1_8_0: la entrada del historial de versiones para v1.8 «Mapa y Mensaje». Solo datos (no cambia el esquema).
INSERT INTO app_versions (version, title, summary, changes, released_on) VALUES
('1.8.0', 'Mapa y Mensaje',
 'El Feed gana un mapa con los hallazgos ubicados, el guión de cada potencial queda versionado y se puede mandar por WhatsApp, y el feed sugiere acciones concretas.',
 ARRAY[
   'Feed: selector Lista | Mapa. Los hallazgos con dirección aparecen como pines (color por estado) y al tocar uno se abre la misma tarjeta de la lista.',
   'Mapa: «Sin ubicación» agrupa lo que no se pudo ubicar, con el motivo; desde ahí se corrige la dirección o se fija el pin a mano.',
   'Mapa: las direcciones se buscan solas al publicar, nunca se inventan coordenadas, y el proveedor (OpenStreetMap o Mapbox) se elige desde la configuración del servidor.',
   'Guión: cada potencial tiene su guión versionado (original, ediciones y restablecidos) con quién y cuándo; si dos socios editan a la vez, se avisa el conflicto en vez de pisar.',
   'Guión: botón «Ver guión» para leerlo, editarlo, restablecerlo al original y mandarlo por WhatsApp con el enlace listo.',
   'Guiones nuevos en PAS + BAB (problema real del negocio, agitación, transformación y solución con cierre suave).',
   'Feed: acciones sugeridas por IA en oportunidades e ideas, con confirmación en pantalla antes de ejecutar (se activan cuando el servidor tiene la IA configurada).',
   'Vocabulario: «prospecto» pasa a «potencial» en todo el sistema, y el Instagram de un potencial se puede corregir a mano.'
 ], DATE '2026-10-12')
ON CONFLICT (version) DO NOTHING;
