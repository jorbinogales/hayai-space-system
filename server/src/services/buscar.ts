// Busqueda global (clientes, proyectos, tareas). UN servicio para la web, la API v1 y el MCP.
// Sin acentos ni mayusculas (fold() de la migracion 007) y por palabras: "panaderia estrella" encuentra "Panadería La Estrella".
// Con las tablas actuales (decenas de filas) basta un recorrido completo; si algun dia pasan de unos miles, indice sobre fold(...).
import { z } from 'zod'
import { pool } from '../db.ts'
import { archivadosParam, op, projectStateOut } from './common.ts'

const MAX_TERMS = 5

export const buscar = op(
  z.strictObject({
    q: z.string().trim().min(2, 'Escribe al menos 2 caracteres').max(80, 'Máximo 80 caracteres'),
    tipo: z.enum(['cliente', 'proyecto', 'tarea'], 'Tipo inválido (cliente, proyecto o tarea)').optional(),
    archivados: archivadosParam,
    limite: z.number().int().min(1).max(25).default(8), // resultados por tipo
  }),
  async (_a, i) => {
    const terms = i.q.split(/\s+/).slice(0, MAX_TERMS)

    /** WHERE a mano con parametros posicionales (nunca se concatena lo escrito). Cada palabra debe aparecer en el texto;
     *  si tiene 3+ digitos tambien vale contra los digitos del telefono ("0414 123" encuentra "0414-1234567"). */
    const where = (hay: string, phone: string | null, hide: string) => {
      const args: unknown[] = []
      const conds: string[] = []
      for (const t of terms) {
        args.push(t)
        const k = args.length
        const digits = t.replace(/\D/g, '')
        if (phone && digits.length >= 3) {
          args.push(digits)
          conds.push(`(strpos(fold(${hay}), fold($${k})) > 0 OR strpos(regexp_replace(coalesce(${phone}, ''), '\\D', '', 'g'), $${args.length}) > 0)`)
        } else conds.push(`strpos(fold(${hay}), fold($${k})) > 0`)
      }
      if (hide) conds.push(hide)
      return { sql: conds.join(' AND '), args }
    }
    const hideOf = (cond: string, notCond: string) => (i.archivados === 'excluir' ? cond : i.archivados === 'solo' ? notCond : '')
    // El nombre que empieza por lo escrito va primero; despues, por nombre.
    const first = (col: string) => `(strpos(fold(${col}), fold($1)) = 1) DESC`

    const want = (t: string) => !i.tipo || i.tipo === t

    const [clientes, proyectos, tareas] = await Promise.all([
      want('cliente')
        ? (() => {
            const w = where(
              "concat_ws(' ', c.name, c.phone, c.email, c.contact_name, c.contact_role, c.address, array_to_string(c.tags, ' '), c.notes)",
              'c.phone',
              hideOf('c.archived_at IS NULL', 'c.archived_at IS NOT NULL'),
            )
            return pool.query(
              `SELECT c.id, c.name, c.is_prospect, c.pipeline_stage, c.phone, c.tags, (c.archived_at IS NOT NULL) AS archived
               FROM clients c WHERE ${w.sql} ORDER BY ${first('c.name')}, c.name, c.id LIMIT ${i.limite}`,
              w.args,
            )
          })()
        : null,
      want('proyecto')
        ? (() => {
            const w = where("concat_ws(' ', p.name, c.name)", null, hideOf('p.archived_at IS NULL AND c.archived_at IS NULL', '(p.archived_at IS NOT NULL OR c.archived_at IS NOT NULL)'))
            return pool.query(
              `SELECT p.id, p.name, p.status, p.client_id, c.name AS client, (p.archived_at IS NOT NULL OR c.archived_at IS NOT NULL) AS archived
               FROM projects p LEFT JOIN clients c ON c.id = p.client_id WHERE ${w.sql} ORDER BY ${first('p.name')}, p.name, p.id LIMIT ${i.limite}`,
              w.args,
            )
          })()
        : null,
      want('tarea')
        ? (() => {
            const w = where("concat_ws(' ', t.title, p.name, c.name)", null, hideOf('p.archived_at IS NULL AND c.archived_at IS NULL', '(p.archived_at IS NOT NULL OR c.archived_at IS NOT NULL)'))
            return pool.query(
              `SELECT t.id, t.title, t.done, t.due_date, t.project_id, p.name AS project
               FROM tasks t JOIN projects p ON p.id = t.project_id LEFT JOIN clients c ON c.id = p.client_id
               WHERE ${w.sql} ORDER BY ${first('t.title')}, t.done, t.due_date NULLS LAST, t.id LIMIT ${i.limite}`,
              w.args,
            )
          })()
        : null,
    ])

    const out = {
      q: i.q,
      clientes: (clientes?.rows ?? []).map((r) => ({
        id: r.id as string,
        nombre: r.name as string,
        estado: r.is_prospect ? 'potencial' : 'activo',
        etapa: r.pipeline_stage as string | null,
        telefono: r.phone as string | null,
        etiquetas: r.tags as string[],
        archivado: r.archived as boolean,
      })),
      proyectos: (proyectos?.rows ?? []).map((r) => ({
        id: r.id as string,
        nombre: r.name as string,
        cliente: r.client as string | null,
        cliente_id: r.client_id as string | null,
        estado: projectStateOut(r.status),
        archivado: r.archived as boolean,
      })),
      tareas: (tareas?.rows ?? []).map((r) => ({
        id: r.id as string,
        titulo: r.title as string,
        proyecto: r.project as string,
        proyecto_id: r.project_id as string,
        estado: r.done ? 'completada' : 'pendiente',
        vence: r.due_date as string | null,
      })),
    }
    return { ...out, total: out.clientes.length + out.proyectos.length + out.tareas.length }
  },
)
