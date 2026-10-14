-- 033_feed_supermigas_mensualidad: se retira la oportunidad «Upsell Supermigas: ofrecer soporte mensual a Yamilka» (publicada por Growi el 8 oct 2026).
-- Le sugería venderle un plan mensual a una clienta que YA tiene la mensualidad contratada (consta en el esquema de su proyecto). Lo de módulos
-- extra ya lo cubre la oportunidad del lector de código de barras, que se queda. Solo datos; si el ítem no existe (otra BD), no hace nada.
DELETE FROM feed_items
WHERE id = 'ce043bdb-247e-44b0-811c-4eec2e3b3f93'
  AND title = 'Upsell Supermigas: ofrecer soporte mensual a Yamilka';
