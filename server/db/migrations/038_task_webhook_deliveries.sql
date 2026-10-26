-- 038_task_webhook_deliveries: registro de entregas del webhook saliente de tareas
-- asignadas a Leandro (Release 1.8.3 «Órbita fina IV»). Una fila por evento `tarea.asignada`
-- encolado; el worker la reintenta con espera creciente hasta 3 intentos.
CREATE TABLE task_webhook_deliveries (
  event_id      uuid PRIMARY KEY,
  event         text NOT NULL CHECK (event = 'tarea.asignada'),
  task_id       uuid NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'enviado', 'error')),
  attempts      integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX task_webhook_deliveries_pending_idx ON task_webhook_deliveries (next_attempt_at)
  WHERE status IN ('pendiente', 'error');
