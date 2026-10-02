-- 003_drop_expense_status: un gasto es dinero que ya salio; no existe "pagado"/"pendiente". Se elimina expenses.status.
-- Unica dependencia en 001: el CHECK en linea (expenses_status_check), que cae con la columna. No hay indice sobre
-- ella (payments_pending_date_idx es de payments y se queda). Sin CASCADE a proposito: si algo creado fuera de las
-- migraciones dependiera de la columna, que falle en vez de borrarlo en silencio.
-- DROP COLUMN solo toca el catalogo (no reescribe la tabla): las filas existentes se conservan.

ALTER TABLE expenses DROP COLUMN status;
