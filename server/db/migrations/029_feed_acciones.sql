-- Acciones sugeridas por IA en los ítems del feed (oportunidades e ideas). Se generan en segundo plano al publicar (o a pedido) y se guardan
-- con el ítem para todo el equipo: cada acción es un botón concreto (crear tarea, agendar cobro, crear propuesta…) que se ejecuta contra la
-- API real, con confirmación. Esta migración NO siembra versión ni entrada al historial.
ALTER TABLE feed_items
  ADD COLUMN actions        jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(actions) = 'array' AND pg_column_size(actions) <= 32768),
  ADD COLUMN actions_status text        CHECK (actions_status IN ('pendiente', 'listo', 'error')),  -- NULL = nunca se generaron
  ADD COLUMN actions_at     timestamptz,                                                           -- cuándo se pidió (pendiente) o terminó (listo / error)
  ADD COLUMN actions_error  text        CHECK (actions_error IS NULL OR length(actions_error) <= 300),
  ADD COLUMN actions_model  text        CHECK (actions_model IS NULL OR length(actions_model) <= 80);
