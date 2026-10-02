import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './ui'
import { addClient, money, todayISO, type Client } from './store'
import { AVATAR_SEEDS, AvatarPicker } from './blob'

interface Row {
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
    const chs: { date: string; amount: number; concept: string }[] = []
    for (const r of charges) {
      if (!r.d && !r.b) continue
      if (!r.d || !(Number(r.b) > 0)) return setError('Cada fecha de cobro necesita fecha y un monto mayor a 0.')
      chs.push({ date: r.d, amount: Number(r.b), concept: r.a.trim() || 'Pago' })
    }
    setBusy(true)
    try {
      onCreate(await addClient({ name, avatar, initialDate: todayISO(), items: its, charges: chs }))
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
