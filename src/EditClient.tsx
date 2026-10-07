import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './ui'
import { AvatarPicker } from './blob'
import { DraftBar } from './UpdateUI'
import { saveGuarded, show, useFormGuard } from './updates'
import { addPayment, archiveClient, deletePayment, money, moveLabel, removeClient, saveInitial, todayISO, updateClient, updatePayment, useAllClients, loadClients, movementNow, clientNow, type Movement } from './store'

/** Cuota o cobro editable: fecha, concepto, monto y estado se guardan al salir del campo o al pulsar; borrar es inmediato. */
function PayRow({ m, onError }: { m: Movement; onError: (s: string) => void }) {
  const [date, setDate] = useState(m.date)
  const [concept, setConcept] = useState(m.concept)
  const [amount, setAmount] = useState(String(m.amount))
  const [busy, setBusy] = useState(false)
  // la marca que se vio al abrir/guardar la fila: si otro socio la cambió mientras tanto, se avisa en vez de pisarla
  const base = useRef(m.updatedAt)

  const save = async (d: Parameters<typeof updatePayment>[1], mine: Record<string, unknown>) => {
    const r = await saveGuarded({
      title: 'Alguien cambió esta cuota mientras la editabas',
      base: base.current,
      save: (ifMatch) => updatePayment(m.id, d, ifMatch),
      fresh: async () => {
        await loadClients()
        const f = movementNow(m.id)
        return { stamp: f?.updatedAt, values: { date: f?.date, concept: f?.concept, amount: f?.amount, status: f?.status } }
      },
      mine,
      labels: { date: 'Fecha', concept: 'Concepto', amount: 'Monto', status: 'Estado' },
    })
    if (r.kind === 'saved') {
      base.current = r.value.movements.find((x) => x.id === m.id)?.updatedAt ?? base.current
    } else {
      base.current = r.stamp
      setDate(String(r.values.date ?? m.date))
      setConcept(String(r.values.concept ?? m.concept))
      setAmount(String(r.values.amount ?? m.amount))
    }
  }

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    onError('')
    try {
      await fn()
    } catch (e) {
      onError(e instanceof Error ? e.message : 'No se pudo guardar el cambio.')
      // vuelve a los valores guardados
      setDate(m.date)
      setConcept(m.concept)
      setAmount(String(m.amount))
    } finally {
      setBusy(false)
    }
  }
  const commit = () => {
    const n = Number(amount)
    if (date === m.date && concept.trim() === m.concept && n === m.amount) return
    if (!date || !concept.trim() || !(n > 0)) return void onError('Cada cuota necesita fecha, concepto y un monto mayor a 0.')
    void run(() => save({ date, concept: concept.trim(), amount: n }, { date, concept: concept.trim(), amount: n, status: m.status }))
  }
  const paid = m.status === 'cobrado'

  return (
    <div className={`erow${busy ? ' is-busy' : ''}`}>
      <input aria-label="Fecha de la cuota" type="date" value={date} onChange={(e) => setDate(e.target.value)} onBlur={commit} />
      <input aria-label="Concepto de la cuota" value={concept} onChange={(e) => setConcept(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
      <input aria-label="Monto de la cuota" type="number" min="0" step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
      <button type="button" className={`state ${paid ? 'paid' : 'due'}`} aria-pressed={paid} title={paid ? 'Marcar como pendiente' : 'Marcar como cobrada'} onClick={() => void run(() => save({ status: paid ? 'pendiente' : 'cobrado' }, { date, concept, amount: Number(amount), status: paid ? 'pendiente' : 'cobrado' }))}>
        {paid ? 'Cobrada' : m.date < todayISO() ? 'Vencida' : 'Pendiente'}
      </button>
      <button type="button" className="rm" aria-label={`Eliminar ${moveLabel(m)}`} onClick={() => void run(() => deletePayment(m.id))}>
        <Icon name="close" size={15} />
      </button>
      {m.series && <span className="serie">{moveLabel(m).replace(m.concept, '').trim()} de la serie mensual</span>}
    </div>
  )
}

/** Editar un cliente: datos, inicial (con fecha anterior si hace falta), y todas sus cuotas/cobros. Mismo estilo oscuro que los demas formularios. */
export default function EditClient({ clientId, onClose }: { clientId: string; onClose: () => void }) {
  const client = useAllClients().find((c) => c.id === clientId)
  const [name, setName] = useState(client?.name ?? '')
  const [avatar, setAvatar] = useState(client?.avatar ?? '')
  const initial = client?.movements.find((m) => m.kind === 'inicial')
  const [iDate, setIDate] = useState(initial?.date ?? todayISO())
  const [items, setItems] = useState(() => (client?.items.length ? client.items.map((i) => ({ concept: i.concept, amount: String(i.amount) })) : [{ concept: '', amount: '' }]))
  const [nd, setNd] = useState({ date: todayISO(), concept: 'Pago mensual', amount: '', rep: false, n: '12', paid: false })
  const [msg, setMsg] = useState('')
  const [saved, setSaved] = useState('')
  const [busy, setBusy] = useState(false)
  // la marca del cliente que se vio al abrir (o al guardar): se manda como If-Match para no pisar a otro socio
  const base = useRef(client?.updatedAt)
  const guard = useFormGuard({
    id: `cliente:${clientId}`,
    label: `Cliente · ${client?.name ?? ''}`,
    values: { name, avatar },
    initial: { name: client?.name ?? '', avatar: client?.avatar ?? '' },
    labels: { name: 'nombre', avatar: 'icono' },
    apply: (v) => {
      setName(v.name)
      setAvatar(v.avatar)
    },
  })

  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close.current()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [])

  if (!client) return null

  const flash = (s: string) => {
    setSaved(s)
    window.setTimeout(() => setSaved(''), 2200)
  }
  const wrap = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    setMsg('')
    try {
      const said = await fn()
      flash(typeof said === 'string' ? said : ok)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'No se pudo guardar.')
    } finally {
      setBusy(false)
    }
  }

  const saveData = () => {
    if (!name.trim()) return setMsg('El cliente necesita un nombre.')
    void wrap(async () => {
      const mine = { name: name.trim(), avatar }
      const r = await saveGuarded({
        title: 'Alguien cambió este cliente mientras lo editabas',
        base: base.current,
        save: (ifMatch) => updateClient(client.id, mine, ifMatch),
        fresh: async () => {
          await loadClients()
          const f = clientNow(client.id)
          return { stamp: f?.updatedAt, values: { name: f?.name, avatar: f?.avatar } }
        },
        mine,
        labels: { name: 'Nombre' },
      })
      guard.saved()
      if (r.kind === 'saved') {
        base.current = r.value.updatedAt
        return
      }
      base.current = r.stamp
      setName(show(r.values.name) === '—' ? '' : String(r.values.name))
      setAvatar(String(r.values.avatar ?? ''))
      return 'Se quedó la versión guardada'
    }, 'Datos guardados')
  }
  const saveIni = () => {
    const its: { concept: string; amount: number }[] = []
    for (const r of items) {
      if (!r.concept.trim() && !r.amount) continue
      if (!r.concept.trim() || !(Number(r.amount) > 0)) return setMsg('Cada ítem de la inicial necesita concepto y un monto mayor a 0.')
      its.push({ concept: r.concept.trim(), amount: Number(r.amount) })
    }
    if (its.length > 0 && !iDate) return setMsg('Indica la fecha de la inicial.')
    void wrap(() => saveInitial(client.id, { date: iDate, items: its }), its.length ? 'Inicial guardada' : 'Inicial eliminada')
  }
  const addCuota = () => {
    const n = Number(nd.n)
    if (!nd.date || !nd.concept.trim() || !(Number(nd.amount) > 0)) return setMsg('La cuota necesita fecha, concepto y un monto mayor a 0.')
    if (nd.rep && !(Number.isInteger(n) && n >= 2 && n <= 36)) return setMsg('Los meses de repetición deben ser un número entre 2 y 36.')
    void wrap(
      async () => {
        await addPayment(client.id, { date: nd.date, concept: nd.concept.trim(), amount: Number(nd.amount), ...(nd.rep ? { repeatMonths: n } : { status: nd.paid ? 'cobrado' : 'pendiente' }) })
        setNd((x) => ({ ...x, amount: '' }))
      },
      nd.rep ? 'Cuotas agregadas' : 'Cuota agregada',
    )
  }

  const removeThis = () => {
    if (!window.confirm(`¿Eliminar a "${client.name}" con sus proyectos, tareas, cobros y gastos?\n\nIrá a la papelera y podrás restaurarlo durante 30 días.`)) return
    void wrap(async () => {
      await removeClient(client.id)
      onClose()
    }, 'Cliente eliminado')
  }

  const archiveThis = () =>
    void wrap(async () => {
      await archiveClient(client.id, true)
      onClose()
    }, 'Cliente archivado')

  const cuotas = client.movements.filter((m) => m.kind !== 'inicial')
  const total = items.reduce((s, r) => s + (Number(r.amount) > 0 ? Number(r.amount) : 0), 0)

  return createPortal(
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet edit-sheet" role="dialog" aria-modal="true" aria-labelledby="ec-title">
        <header>
          <h2 id="ec-title">Editar cliente</h2>
          <button type="button" className="x" onClick={onClose} aria-label="Cerrar">
            <Icon name="close" size={18} />
          </button>
        </header>

        <DraftBar guard={guard} />
        <div className="sheet-body">
          <fieldset>
            <legend>Datos</legend>
            <label className="field">
              <span>Nombre</span>
              <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
            </label>
            <div className="field">
              <span>Icono del cliente</span>
              <AvatarPicker value={avatar} onChange={setAvatar} label="Icono del cliente" />
            </div>
            <div className="row-foot">
              <span />
              <button type="button" className="add" onClick={saveData} disabled={busy}>
                Guardar datos
              </button>
            </div>
          </fieldset>

          <fieldset>
            <legend>Inicial cobrada</legend>
            <label className="field inline">
              <span>Fecha</span>
              <input type="date" value={iDate} onChange={(e) => setIDate(e.target.value)} />
            </label>
            {items.map((r, i) => (
              <div className="line" key={i}>
                <input aria-label="Concepto del ítem" value={r.concept} onChange={(e) => setItems(items.map((x, k) => (k === i ? { ...x, concept: e.target.value } : x)))} placeholder="Ítem (ej. Diseño web)" />
                <input aria-label="Monto del ítem" type="number" min="0" step="0.01" inputMode="decimal" value={r.amount} onChange={(e) => setItems(items.map((x, k) => (k === i ? { ...x, amount: e.target.value } : x)))} placeholder="$ 0.00" />
                <button type="button" className="rm" aria-label="Quitar ítem" onClick={() => setItems(items.length > 1 ? items.filter((_, k) => k !== i) : [{ concept: '', amount: '' }])}>
                  <Icon name="close" size={15} />
                </button>
              </div>
            ))}
            <div className="row-foot">
              <button type="button" className="add" onClick={() => setItems([...items, { concept: '', amount: '' }])}>
                <Icon name="plus" size={15} />
                Agregar ítem
              </button>
              <p>
                Total inicial <strong>{money(total)}</strong>
              </p>
            </div>
            <div className="row-foot">
              <span />
              <button type="button" className="add" onClick={saveIni} disabled={busy}>
                Guardar inicial
              </button>
            </div>
          </fieldset>

          <fieldset>
            <legend>Cuotas y cobros</legend>
            {cuotas.length === 0 && <p className="none">Aún no hay cuotas. Agrega la primera abajo.</p>}
            {cuotas.map((m) => (
              <PayRow key={`${m.id}|${m.date}|${m.concept}|${m.amount}|${m.status}`} m={m} onError={setMsg} />
            ))}
            <div className="erow new-row">
              <input aria-label="Fecha de la nueva cuota" type="date" value={nd.date} onChange={(e) => setNd({ ...nd, date: e.target.value })} />
              <input aria-label="Concepto de la nueva cuota" value={nd.concept} onChange={(e) => setNd({ ...nd, concept: e.target.value })} placeholder="Concepto" />
              <input aria-label="Monto de la nueva cuota" type="number" min="0" step="0.01" inputMode="decimal" value={nd.amount} onChange={(e) => setNd({ ...nd, amount: e.target.value })} placeholder="$ 0.00" />
              <button type="button" className="add" onClick={addCuota} disabled={busy}>
                <Icon name="plus" size={15} />
                Agregar
              </button>
              <label className="repeat">
                <input type="checkbox" checked={nd.rep} onChange={(e) => setNd({ ...nd, rep: e.target.checked })} />
                <span>Repetir cada mes</span>
                {nd.rep && (
                  <>
                    <span>durante</span>
                    <input aria-label="Meses de repetición" className="rep-n" type="number" min="2" max="36" inputMode="numeric" value={nd.n} onChange={(e) => setNd({ ...nd, n: e.target.value })} />
                    <span>meses</span>
                  </>
                )}
                {!nd.rep && (
                  <>
                    <input type="checkbox" checked={nd.paid} onChange={(e) => setNd({ ...nd, paid: e.target.checked })} />
                    <span>Ya cobrada</span>
                  </>
                )}
              </label>
            </div>
          </fieldset>
        </div>

        <footer>
          <p className={msg ? 'err' : 'ok-note'} role="alert">
            {msg || saved}
          </p>
          <button type="button" className="ghost" disabled={busy} onClick={archiveThis} title="Lo oculta de las pantallas de trabajo; su historial sigue contando en Finanzas">
            Archivar
          </button>
          <button type="button" className="ghost danger" disabled={busy} onClick={removeThis}>
            Eliminar cliente
          </button>
          <button type="button" className="primary" onClick={onClose}>
            Listo
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
