-- 004_prospects_task_due: "posible cliente" (prospecto) y fecha agendada en tareas (p.ej. la visita al prospecto).
-- Prospecto = cliente que aun no firmo: puede no tener inicial ni cobros; al convertirse pasa a false. Su proyecto usa
-- projects.status = 'planeacion' (ya existe) y la visita es una fila normal de tasks con due_date.
-- boolean y no status de texto: hoy solo hay dos estados (prospecto/cliente). Si llegan mas (perdido, en negociacion),
-- migrar a text NOT NULL CHECK (...) rellenando desde este boolean.
-- Sin indice en clients.is_prospect: la tabla es pequena (decenas de filas) y se lista completa; seria peso muerto.
-- ADD COLUMN con default constante (PG11+) y nullable sin default: solo metadatos, no reescribe; las filas existentes
-- quedan is_prospect = false y due_date NULL.

ALTER TABLE clients ADD COLUMN is_prospect boolean NOT NULL DEFAULT false;

ALTER TABLE tasks ADD COLUMN due_date date; -- fecha de negocio agendada; NULL = sin agenda

-- Agenda: tareas pendientes con fecha, de todos los proyectos, por fecha.
CREATE INDEX tasks_due_open_idx ON tasks (due_date) WHERE NOT done AND due_date IS NOT NULL;
