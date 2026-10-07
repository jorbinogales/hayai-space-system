import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './ui'
import { addClient, money, todayISO, type Client, type Draft } from './store'
import { AVATAR_SEEDS, AvatarPicker } from './blob'
import { DraftBar } from './UpdateUI'
import { useFormGuard } from './updates'

interface Row {
  /** cobros: repetir cada mes */
  rep?: boolean
  /** cobros: cuantos meses (texto del input) */
  n?: string
  key: number
  a: string // concepto
  b: string // monto
  d: string // fecha (solo cobros)
}
let k = 0
const row = (a = '', d = ''): Row => ({ key: k++, a, b: '', d })

/** Alta de cliente: nombre, inicial desglosada en items (se pueden agregar los que hagan falta) y fechas de cobro. */
export default function NewClient({ onClose, onCreate }: { onClose: () => void; onCreate: (c: Client) => void }) {
  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState(() => AVATAR_SEEDS[Math.floor(Math.random() * AVATAR_SEEDS.length)])
  const [items, setItems] = useState<Row[]>(() => [row()])
  const [charges, setCharges] = useState<Row[]>(() => [row('Pago mensual')])
  const [iDate, setIDate] = useState(todayISO) // la inicial puede ser de una fecha anterior
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const first = useRef<HTMLInputElement>(null)
  // para el borrador y los cambios sin guardar: solo lo escrito (sin las llaves internas de cada fila)
  const flat = (rows: Row[]) => rows.map((r) => [r.a, r.b, r.d, r.rep ?? false, r.n ?? ''] as const)
  const unflat = (rows: ReturnType<typeof flat>): Row[] => rows.map(([a, b, d, rep, n]) => ({ key: k++, a, b, d, rep, n }))
  const start = useRef({ name: '', iDate: todayISO(), items: flat(items), charges: flat(charges) })
  const guard = useFormGuard({
    id: 'cliente:nuevo',
    label: 'Nuevo cliente',
    values: { name, iDate, items: flat(items), charges: flat(charges) },
    initial: start.current,
    labels: { name: 'nombre', iDate: 'fecha de la inicial', items: 'inicial', charges: 'cobros' },
    apply: (v) => {
      setName(v.name)
      setIDate(v.iDate)
      setItems(v.items.length ? unflat(v.items) : [row()])
      setCharges(v.charges.length ? unflat(v.charges) : [row('Pago mensual')])
    },
  })

  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    first.current?.focus()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close.current()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [])

  const set = (list: Row[], put: (r: Row[]) => void, key: number, f: Partial<Row>) => put(list.map((r) => (r.key === key ? { ...r, ...f } : r)))
  const total = items.reduce((s, r) => s + (Number(r.b) > 0 ? Number(r.b) : 0), 0)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return setError('Escribe el nombre del cliente.')
    const its: { concept: string; amount: number }[] = []
    for (const r of items) {
      if (!r.a.trim() && !r.b) continue
      if (!r.a.trim() || !(Number(r.b) > 0)) return setError('Cada ítem de la inicial necesita concepto y un monto mayor a 0.')
      its.push({ concept: r.a.trim(), amount: Number(r.b) })
    }
    const chs: Draft['charges'] = []
    for (const r of charges) {
      if (!r.d && !r.b) continue
      if (!r.d || !(Number(r.b) > 0)) return setError('Cada fecha de cobro necesita fecha y un monto mayor a 0.')
      const n = Number(r.n ?? 12)
      if (r.rep && !(Number.isInteger(n) && n >= 2 && n <= 36)) return setError('Los meses de repetición deben ser un número entre 2 y 36.')
      chs.push({ date: r.d, amount: Number(r.b), concept: r.a.trim() || 'Pago', ...(r.rep ? { repeatMonths: n } : {}) })
    }
    if (its.length > 0 && !iDate) return setError('Indica la fecha en que se cobró la inicial.')
    setBusy(true)
    try {
      const c = await addClient({ name, avatar, initialDate: iDate, items: its, charges: chs })
      guard.saved()
      onCreate(c)
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'No se pudo guardar el cliente.')
    }
  }

  // en un portal: la pantalla que lo contiene crea su propio contexto de apilado y quedaba bajo el oscurecido del viaje
  return createPortal(
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="sheet" role="dialog" aria-modal="true" aria-labelledby="nc-title" onSubmit={submit} noValidate>
        <header>
          <h2 id="nc-title">Nuevo cliente</h2>
          <button type="button" className="x" onClick={onClose} aria-label="Cerrar">
            <Icon name="close" size={18} />
          </button>
        </header>

        <DraftBar guard={guard} />
        <div className="sheet-body">
          <label className="field">
            <span>Nombre</span>
            <input ref={first} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Norte Studio" autoComplete="off" />
          </label>

          <div className="field">
            <span>Icono del cliente</span>
            <AvatarPicker value={avatar} onChange={setAvatar} label="Icono del cliente" />
          </div>

          <fieldset>
            <legend>Inicial cobrada (ítems)</legend>
            <label className="field inline">
              <span>Fecha</span>
              <input type="date" value={iDate} onChange={(e) => setIDate(e.target.value)} />
            </label>
            {items.map((r) => (
              <div className="line" key={r.key}>
                <input aria-label="Concepto del ítem" value={r.a} onChange={(e) => set(items, setItems, r.key, { a: e.target.value })} placeholder="Ítem (ej. Diseño web)" />
                <input aria-label="Monto del ítem" type="number" min="0" step="0.01" inputMode="decimal" value={r.b} onChange={(e) => set(items, setItems, r.key, { b: e.target.value })} placeholder="$ 0.00" />
                <button type="button" className="rm" aria-label="Quitar ítem" onClick={() => setItems(items.length > 1 ? items.filter((x) => x.key !== r.key) : [row()])}>
                  <Icon name="close" size={15} />
                </button>
              </div>
            ))}
            <div className="row-foot">
              <button type="button" className="add" onClick={() => setItems([...items, row()])}>
                <Icon name="plus" size={15} />
                Agregar ítem
              </button>
              <p>
                Total inicial <strong>{money(total)}</strong>
              </p>
            </div>
          </fieldset>

          <fieldset>
            <legend>Fechas de cobro</legend>
            {charges.map((r) => (
              <div className="line three" key={r.key}>
                <input aria-label="Fecha de cobro" type="date" value={r.d} onChange={(e) => set(charges, setCharges, r.key, { d: e.target.value })} />
                <input aria-label="Concepto del cobro" value={r.a} onChange={(e) => set(charges, setCharges, r.key, { a: e.target.value })} placeholder="Concepto" />
                <input aria-label="Monto del cobro" type="number" min="0" step="0.01" inputMode="decimal" value={r.b} onChange={(e) => set(charges, setCharges, r.key, { b: e.target.value })} placeholder="$ 0.00" />
                <button type="button" className="rm" aria-label="Quitar fecha" onClick={() => setCharges(charges.length > 1 ? charges.filter((x) => x.key !== r.key) : [row('Pago mensual')])}>
                  <Icon name="close" size={15} />
                </button>
                <label className="repeat">
                  <input type="checkbox" checked={!!r.rep} onChange={(e) => set(charges, setCharges, r.key, { rep: e.target.checked, n: r.n ?? '12' })} />
                  <span>Repetir cada mes</span>
                  {r.rep && (
                    <>
                      <span>durante</span>
                      <input aria-label="Meses de repetición" className="rep-n" type="number" min="2" max="36" inputMode="numeric" value={r.n ?? '12'} onChange={(e) => set(charges, setCharges, r.key, { n: e.target.value })} />
                      <span>meses{r.d ? `, el día ${Number(r.d.slice(8))} de cada mes` : ''}</span>
                    </>
                  )}
                </label>
              </div>
            ))}
            <div className="row-foot">
              <button type="button" className="add" onClick={() => setCharges([...charges, row('Pago mensual')])}>
                <Icon name="plus" size={15} />
                Agregar fecha de cobro
              </button>
            </div>
          </fieldset>
        </div>

        <footer>
          <p className="err" role="alert">
            {error}
          </p>
          <button type="button" className="ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="primary" disabled={busy}>
            Guardar cliente
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  )
}
