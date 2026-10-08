import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './ui'
import { money } from './store'
import { ITEM_TIPO_LABEL, bumpProposals, createProposal, loadOfferings, type ItemTipo, type Offering, type Proposal } from './proposalData'
import './proposal.css'

interface Row {
  key: number
  tipo: ItemTipo
  concepto: string
  cantidad: string
  precio: string
  oferta: string
}
let seq = 0
const blank = (tipo: ItemTipo, concepto = ''): Row => ({ key: ++seq, tipo, concepto, cantidad: '1', precio: '', oferta: '' })
const num = (s: string) => Number(s.replace(',', '.'))
const dec2 = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6

/**
 * Nueva propuesta de un cliente (posible o activo): UNA mensualidad base + extras mensuales y únicos. Cada fila puede tomar nombre y
 * precio sugerido del catálogo de ofertas. Si nace de un ítem del feed viaja `feed_item_id` y el ítem queda enlazado («✓ Creada»).
 */
export default function NewProposal({
  clientId,
  clientName,
  feedItemId,
  concepto,
  notas: notasInicial,
  onClose,
  onCreated,
}: {
  clientId: string
  clientName: string
  feedItemId?: string
  concepto?: string
  notas?: string
  onClose: () => void
  onCreated: (p: Proposal) => void
}) {
  const [rows, setRows] = useState<Row[]>(() => [blank('mensualidad', concepto ?? '')])
  const [notas, setNotas] = useState(notasInicial ?? '')
  const [catalog, setCatalog] = useState<Offering[]>([])
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
  useEffect(() => {
    let live = true
    void loadOfferings()
      .then((o) => live && setCatalog(o.filter((x) => x.activa)))
      .catch(() => {}) // sin catálogo se arma a mano
    return () => {
      live = false
    }
  }, [])

  const set = (key: number, patch: Partial<Row>) => setRows((r) => r.map((x) => (x.key === key ? { ...x, ...patch } : x)))
  const pick = (row: Row, id: string) => {
    const o = catalog.find((x) => x.id === id)
    if (!o) return set(row.key, { oferta: '' })
    const sugerido = row.tipo === 'extra_unico' ? o.instalacion_sugerida : o.mensualidad_sugerida
    set(row.key, { oferta: id, concepto: o.nombre, ...(sugerido != null ? { precio: String(sugerido) } : {}) })
  }
  const totals = useMemo(() => {
    let mensual = 0
    let unico = 0
    for (const r of rows) {
      const sub = (Number.isFinite(num(r.precio)) ? num(r.precio) : 0) * (Number.isFinite(num(r.cantidad)) ? num(r.cantidad) : 0)
      if (r.tipo === 'extra_unico') unico += sub
      else mensual += sub
    }
    return { mensual, unico }
  }, [rows])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    for (const r of rows) {
      const label = ITEM_TIPO_LABEL[r.tipo].toLowerCase()
      if (!r.concepto.trim()) return setError(`Escribe el concepto de la fila «${label}».`)
      const p = num(r.precio)
      if (r.precio.trim() === '' || !Number.isFinite(p) || p < 0) return setError(`El precio de «${r.concepto.trim()}» no es válido.`)
      if (!dec2(p)) return setError(`El precio de «${r.concepto.trim()}» admite máximo 2 decimales.`)
      const q = num(r.cantidad)
      if (!Number.isInteger(q) || q < 1 || q > 999) return setError(`La cantidad de «${r.concepto.trim()}» es un entero de 1 a 999.`)
    }
    setBusy(true)
    setError('')
    try {
      const p = await createProposal(clientId, {
        items: rows.map((r) => ({ tipo: r.tipo, concepto: r.concepto.trim(), cantidad: num(r.cantidad), precio_unitario: num(r.precio), ...(r.oferta ? { oferta_id: r.oferta } : {}) })),
        ...(notas.trim() ? { notas: notas.trim() } : {}),
        ...(feedItemId ? { feed_item_id: feedItemId } : {}),
      })
      bumpProposals()
      onCreated(p)
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'No se pudo guardar la propuesta.')
    }
  }

  return createPortal(
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="sheet np-sheet" role="dialog" aria-modal="true" aria-labelledby="np-title" onSubmit={submit} noValidate>
        <header>
          <h2 id="np-title">Nueva propuesta</h2>
          <button type="button" className="x" onClick={onClose} aria-label="Cerrar">
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="sheet-body">
          <p className="np-for">
            Para <b>{clientName}</b>
            {feedItemId && <span> · nace de un hallazgo del feed</span>}
          </p>

          <div className="np-rows" role="list" aria-label="Ítems de la propuesta">
            {rows.map((r, i) => (
              <div className={`np-row${r.tipo === 'mensualidad' ? ' is-base' : ''}`} role="listitem" key={r.key}>
                <div className="np-kind">
                  <span>{ITEM_TIPO_LABEL[r.tipo]}</span>
                  {r.tipo !== 'mensualidad' && (
                    <button type="button" className="np-rm" aria-label={`Quitar ${r.concepto.trim() || ITEM_TIPO_LABEL[r.tipo]}`} onClick={() => setRows((x) => x.filter((y) => y.key !== r.key))}>
                      <Icon name="close" size={14} />
                    </button>
                  )}
                </div>
                {catalog.length > 0 && (
                  <label className="field">
                    <span>Del catálogo (opcional)</span>
                    <select value={r.oferta} onChange={(e) => pick(r, e.target.value)}>
                      <option value="">Escribir a mano</option>
                      {catalog.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.nombre}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="field">
                  <span>Concepto</span>
                  <input ref={i === 0 ? first : undefined} value={r.concepto} maxLength={160} onChange={(e) => set(r.key, { concepto: e.target.value })} placeholder={r.tipo === 'extra_unico' ? 'Ej. Impresora de tickets' : r.tipo === 'extra_mensual' ? 'Ej. Lector de barras (renta)' : 'Ej. Mostrador POS'} autoComplete="off" />
                </label>
                <div className="two">
                  <label className="field">
                    <span>Precio (US$)</span>
                    <input inputMode="decimal" value={r.precio} onChange={(e) => set(r.key, { precio: e.target.value })} placeholder="0" autoComplete="off" />
                  </label>
                  <label className="field">
                    <span>Cantidad</span>
                    <input inputMode="numeric" value={r.cantidad} onChange={(e) => set(r.key, { cantidad: e.target.value })} autoComplete="off" />
                  </label>
                </div>
              </div>
            ))}
          </div>

          <div className="np-add">
            <button type="button" className="ghost" onClick={() => setRows((r) => [...r, blank('extra_mensual')])}>
              <Icon name="plus" size={14} /> Extra mensual
            </button>
            <button type="button" className="ghost" onClick={() => setRows((r) => [...r, blank('extra_unico')])}>
              <Icon name="plus" size={14} /> Extra único
            </button>
          </div>

          <label className="field">
            <span>Notas (opcional)</span>
            <textarea className="np-notes" value={notas} rows={3} maxLength={4000} onChange={(e) => setNotas(e.target.value)} />
          </label>

          <dl className="np-total" aria-live="polite">
            <div>
              <dt>Por mes</dt>
              <dd>{money(Math.round(totals.mensual * 100) / 100)}</dd>
            </div>
            <div>
              <dt>Pago único</dt>
              <dd>{money(Math.round(totals.unico * 100) / 100)}</dd>
            </div>
          </dl>
        </div>
        <footer>
          <p className="err" role="alert">
            {error}
          </p>
          <button type="button" className="ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Guardando…' : 'Guardar propuesta'}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  )
}
