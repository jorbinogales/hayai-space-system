import { z } from 'zod'
import { pool } from '../db.ts'
import { cents, op, todayISO } from './common.ts'

// Port al servidor de src/finance.ts (la web lo calcula en el navegador). Diferencias a proposito:
//  - cruza gastos con clientes por ID (la web lo hace por nombre: dos clientes con el mismo nombre se mezclarian);
//  - "hoy" es la fecha de Caracas, no la del navegador;
//  - suma en centavos enteros para que 0.1 + 0.2 sea 0.3.
// Ojo: la moneda no se convierte. Hoy toda la API escribe USD (columna currency = 'USD' por defecto).

export const finanzasResumen = op(
  z.strictObject({ periodo: z.enum(['mes', 'anio', 'todo'], 'Periodo inválido (mes, anio o todo)').default('mes') }),
  async (_a, i) => {
    const hoy = todayISO()
    const prefijo = i.periodo === 'mes' ? hoy.slice(0, 7) : hoy.slice(0, 4)
    const inPeriod = (d: string) => i.periodo === 'todo' || d.startsWith(prefijo)

    const [clientes, pagos, gastos] = await Promise.all([
      pool.query('SELECT id, name, is_prospect FROM clients ORDER BY created_at, id'),
      pool.query('SELECT client_id, date, amount, status FROM payments'),
      pool.query(
        `SELECT e.date, e.amount, e.client_id, p.client_id AS project_client
         FROM expenses e LEFT JOIN projects p ON p.id = e.project_id`,
      ),
    ])

    const filas = clientes.rows.map((c) => {
      let recaudado = 0
      let porCobrar = 0
      let vencido = 0
      for (const p of pagos.rows) {
        if (p.client_id !== c.id || !inPeriod(p.date)) continue
        if (p.status === 'cobrado') recaudado += cents(p.amount)
        else {
          porCobrar += cents(p.amount)
          if (p.date < hoy) vencido += cents(p.amount) // vencido siempre es parte de por cobrar, nunca algo aparte
        }
      }
      let g = 0
      for (const e of gastos.rows) if (inPeriod(e.date) && (e.client_id === c.id || e.project_client === c.id)) g += cents(e.amount)
      return { id: c.id as string, nombre: c.name as string, recaudado, gastos: g, por_cobrar: porCobrar, vencido, utilidad: recaudado - g }
    })
    filas.sort((a, b) => b.recaudado - a.recaudado)

    // Gastos generales de HAYAI: los que no se imputan a ningun cliente (ni directo ni por proyecto).
    let generales = 0
    for (const e of gastos.rows) if (inPeriod(e.date) && !e.client_id && !e.project_client) generales += cents(e.amount)

    const ingresos = filas.reduce((s, r) => s + r.recaudado, 0)
    const gastosTotal = filas.reduce((s, r) => s + r.gastos, 0) + generales
    const porCobrar = filas.reduce((s, r) => s + r.por_cobrar, 0)
    const vencido = filas.reduce((s, r) => s + r.vencido, 0)

    // Todo lo pendiente sin importar el periodo y sin contar posibles clientes: lo que muestra la cabecera de Clientes.
    const prospectos = new Set(clientes.rows.filter((c) => c.is_prospect).map((c) => c.id))
    const porCobrarTotal = pagos.rows
      .filter((p) => p.status === 'pendiente' && !prospectos.has(p.client_id))
      .reduce((s, p) => s + cents(p.amount), 0)
    const vencidoTotal = pagos.rows
      .filter((p) => p.status === 'pendiente' && p.date < hoy && !prospectos.has(p.client_id))
      .reduce((s, p) => s + cents(p.amount), 0)

    // Ultimos 6 meses terminando en el actual (para la grafica).
    const [y, m] = hoy.split('-').map(Number)
    const serie = Array.from({ length: 6 }, (_, idx) => {
      const t = m - 1 - (5 - idx)
      const yy = y + Math.floor(t / 12)
      const mes = `${yy}-${String(((t % 12) + 12) % 12 + 1).padStart(2, '0')}`
      return {
        mes,
        ingresos: pagos.rows.filter((p) => p.status === 'cobrado' && p.date.startsWith(mes)).reduce((s, p) => s + cents(p.amount), 0) / 100,
        gastos: gastos.rows.filter((e) => e.date.startsWith(mes)).reduce((s, e) => s + cents(e.amount), 0) / 100,
      }
    })

    return {
      periodo: i.periodo,
      hoy,
      ingresos: ingresos / 100,
      gastos: gastosTotal / 100,
      balance: (ingresos - gastosTotal) / 100,
      por_cobrar: porCobrar / 100,
      por_cobrar_total: porCobrarTotal / 100,
      // De lo por cobrar, lo que ya paso de fecha (del periodo / de todo el tiempo sin contar posibles clientes).
      vencido: vencido / 100,
      vencido_total: vencidoTotal / 100,
      gastos_generales: generales / 100,
      clientes: filas.map((r) => ({
        id: r.id,
        nombre: r.nombre,
        recaudado: r.recaudado / 100,
        gastos: r.gastos / 100,
        por_cobrar: r.por_cobrar / 100,
        vencido: r.vencido / 100,
        utilidad: r.utilidad / 100,
      })),
      serie,
    }
  },
)
