import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './ui'
import { todayISO, useClients } from './store'
import { useProjects } from './projectData'
import { addExpense, EXPENSE_CATEGORIES, SCOPE_LABEL, type Expense, type ExpenseScope, type ExpenseStatus } from './expenseData'

const SCOPES: ExpenseScope[] = ['general', 'cliente', 'proyecto']

/** Alta de gasto: concepto, monto, fecha, categoria, a quien se imputa (HAYAI, cliente o proyecto) y estado. Mismo estilo que los demas formularios. */
export default function NewExpense({ onClose, onCreate }: { onClose: () => void; onCreate: (x: Expense) => void }) {
  const clients = useClients()
  const projects = useProjects()
  const [concept, setConcept] = useState('')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(todayISO)
  const [category, setCategory] = useState(EXPENSE_CATEGORIES[0])
  const [scope, setScope] = useState<ExpenseScope>('general')
  const [ref, setRef] = useState('')
  const [status, setStatus] = useState<ExpenseStatus>('pagado')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const first = useRef<HTMLInputElement>(null)

  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    first.current?.focus()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close.current()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!concept.trim()) return setError('Escribe el concepto del gasto.')
    if (!(Number(amount) > 0)) return setError('El monto debe ser mayor a 0.')
    if (!date) return setError('Indica la fecha del gasto.')
    if (scope !== 'general' && !ref) return setError(scope === 'cliente' ? 'Elige el cliente al que se imputa.' : 'Elige el proyecto al que se imputa.')
    setBusy(true)
    try {
      onCreate(await addExpense({ concept, amount: Number(amount), date, category, scope, refId: scope === 'general' ? undefined : ref, status }))
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'No se pudo guardar el gasto.')
    }
  }

  const options = scope === 'cliente' ? clients.map((c) => ({ id: c.id, name: c.name })) : projects.map((p) => ({ id: p.id, name: p.name }))

  return createPortal(
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="sheet" role="dialog" aria-modal="true" aria-labelledby="nx-title" onSubmit={submit} noValidate>
        <header>
          <h2 id="nx-title">Nuevo gasto</h2>
          <button type="button" className="x" onClick={onClose} aria-label="Cerrar">
            <Icon name="close" size={18} />
          </button>
        </header>

        <div className="sheet-body">
          <label className="field">
            <span>Concepto</span>
            <input ref={first} value={concept} onChange={(e) => setConcept(e.target.value)} placeholder="Ej. Hosting, publicidad, equipo" autoComplete="off" />
          </label>

          <div className="two">
            <label className="field">
              <span>Monto</span>
              <input type="number" min="0" step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="$ 0.00" />
            </label>
            <label className="field">
              <span>Fecha</span>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
          </div>

          <div className="field">
            <span>Categoría</span>
            <div className="chips" role="radiogroup" aria-label="Categoría">
              {EXPENSE_CATEGORIES.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={category === c} className={category === c ? 'is-on' : ''} onClick={() => setCategory(c)}>
                  {c}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span>Se imputa a</span>
            <div className="chips" role="radiogroup" aria-label="Se imputa a">
              {SCOPES.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={scope === s}
                  className={scope === s ? 'is-on' : ''}
                  onClick={() => {
                    setScope(s)
                    setRef('')
                  }}
                >
                  {SCOPE_LABEL[s]}
                </button>
              ))}
            </div>
            {scope !== 'general' && (
              <select value={ref} onChange={(e) => setRef(e.target.value)} aria-label={scope === 'cliente' ? 'Cliente' : 'Proyecto'}>
                <option value="">{scope === 'cliente' ? 'Selecciona un cliente' : 'Selecciona un proyecto'}</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="field">
            <span>Estado</span>
            <div className="chips" role="radiogroup" aria-label="Estado">
              {(['pagado', 'pendiente'] as const).map((s) => (
                <button key={s} type="button" role="radio" aria-checked={status === s} className={status === s ? 'is-on' : ''} onClick={() => setStatus(s)}>
                  {s === 'pagado' ? 'Pagado' : 'Pendiente'}
                </button>
              ))}
            </div>
          </div>
        </div>

        <footer>
          <p className="err" role="alert">
            {error}
          </p>
          <button type="button" className="ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="primary" disabled={busy}>
            Guardar gasto
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  )
}
