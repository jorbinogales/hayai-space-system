-- 002_payment_series: pagos mensuales recurrentes como serie materializada (N filas en payments, no una regla).
-- Columnas y no tabla payment_schedules: la serie es finita (2..36) y se crea completa en una transaccion, asi que
-- no hay estado propio que guardar. payment_schedules llegara cuando exista recurrencia abierta/sin fin.
-- series_id lo genera la app (gen_random_uuid) al crear la serie; no hay FK porque no hay tabla padre.
-- ADD COLUMN nullable sin default: solo metadatos, no reescribe la tabla; las filas existentes quedan sin serie.

ALTER TABLE payments
  ADD COLUMN series_id    uuid,
  ADD COLUMN series_index smallint,   -- posicion 1..series_total ("Pago 3/12")
  ADD COLUMN series_total smallint,   -- copiado en cada fila para mostrar N/M sin agregar
  -- los tres juntos o ninguno; una serie solo contiene pagos (la inicial es unica por cliente).
  ADD CONSTRAINT payments_series_ck CHECK (
       (series_id IS NULL AND series_index IS NULL AND series_total IS NULL)
    OR (series_id IS NOT NULL AND series_index IS NOT NULL AND series_total IS NOT NULL AND kind = 'pago')
  ),
  ADD CONSTRAINT payments_series_range_ck CHECK (
    series_total BETWEEN 2 AND 36 AND series_index BETWEEN 1 AND series_total
  );

-- Cuotas de una serie por fecha (mostrar la serie, cancelar las pendientes desde hoy).
CREATE INDEX payments_series_date_idx ON payments (series_id, date) WHERE series_id IS NOT NULL;
-- Un POST repetido con el mismo series_id no duplica posiciones.
CREATE UNIQUE INDEX payments_series_index_uq ON payments (series_id, series_index) WHERE series_id IS NOT NULL;
