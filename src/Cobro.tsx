import { useCallback, useEffect, useId, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Blobvatar } from './blob'
import {
  METODOS,
  METODO_LABEL,
  comprobanteUrl,
  deleteReceptor,
  detectarComprobante,
  fmtBsNum,
  fmtBytes,
  fmtRate,
  fmtUsd,
  getCobro,
  getComprobante,
  inputNum,
  listReceptores,
  parseNum,
  patchCobro,
  readBase64,
  receiptProblem,
  round2,
  round4,
  saveReceptor,
  uploadComprobante,
  type Cobro as CobroT,
  type CobroPatch,
  type Deteccion,
  type Metodo,
  type Receptor,
} from './cobroData'
import { fmtDate, todayISO } from './store'
import { Icon } from './ui'
import { saveGuarded, useFormGuard } from './updates'
import { DraftBar } from './UpdateUI'
import { avatarFor, loadUsers, useUsers } from './users'
import './cobro.css'

const msgOf = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)

// ---------- formulario ----------
type Form = {
  bs: string
  tasa: string
  fechaTasa: string
  metodo: string
  referencia: string
  bancoOrigen: string
  last4: string
  bancoDestino: string
  recibido: string
  notas: string
}
const formOf = (c: CobroT | null): Form => ({
  bs: inputNum(c?.monto_bs),
  tasa: inputNum(c?.tasa, 4),
  fechaTasa: c?.fecha_tasa ?? '',
  metodo: c?.metodo ?? '',
  referencia: c?.referencia ?? '',
  bancoOrigen: c?.banco_origen ?? '',
  last4: c?.cuenta_origen_ultimos4 ?? '',
  bancoDestino: c?.banco_destino ?? '',
  recibido: c?.recibido_por?.nombre ?? '',
  notas: c?.notas ?? '',
})
const LABELS: Record<keyof Form, string> = {
  bs: 'Bolívares',
  tasa: 'Tasa',
  fechaTasa: 'Fecha de la tasa',
  metodo: 'Método',
  referencia: 'Referencia',
  bancoOrigen: 'Banco de origen',
  last4: 'Últimos 4 de la cuenta',
  bancoDestino: 'Banco destino',
  recibido: 'Quién recibió',
  notas: 'Notas',
}
const GUARD_LABELS: Partial<Record<keyof Form, string>> = {
  bs: 'bolívares',
  tasa: 'tasa',
  fechaTasa: 'fecha de la tasa',
  metodo: 'método',
  referencia: 'referencia',
  bancoOrigen: 'banco de origen',
  last4: 'últimos 4',
  bancoDestino: 'banco destino',
  recibido: 'quién recibió',
  notas: 'notas',
}

const nul = (s: string) => (s.trim() === '' ? null : s.trim())

/** Solo lo que cambió, en la forma que acepta PATCH /cobros/:id. Lanza Error con un mensaje en español si algo no sirve. */
function toPatch(f: Form, i: Form, usd: number): CobroPatch {
  const p: CobroPatch = {}
  const bs = nul(f.bs)
  const tasa = nul(f.tasa)
  const bsN = bs == null ? null : parseNum(bs)
  const tasaN = tasa == null ? null : parseNum(tasa)
  if (bs != null && (bsN == null || bsN <= 0)) throw new Error('Los bolívares tienen que ser un número mayor que 0 (ej. 65.540,25).')
  if (tasa != null && (tasaN == null || tasaN <= 0)) throw new Error('La tasa tiene que ser un número mayor que 0 (ej. 873,87).')
  // el servidor calcula la que falta a partir del monto en USD; pero vaciar solo una de las dos de un cobro que ya tenía ambas es ambiguo
  if ((tasa == null && i.tasa !== '') || (bs == null && i.bs !== '')) {
    if (bs !== tasa && (bs == null || tasa == null)) throw new Error('Para quitar los bolívares vacía los dos campos (bolívares y tasa); si no, llena los dos.')
  }
  if (f.bs !== i.bs || f.tasa !== i.tasa) {
    if (bs == null && tasa == null) p.monto_bs = null // quitar uno quita ambos
    else {
      if (f.bs !== i.bs && bsN != null) p.monto_bs = bsN
      if (f.tasa !== i.tasa && tasaN != null) p.tasa = tasaN
      if (bsN != null && tasaN != null && p.monto_bs != null && p.tasa != null && Math.abs(bsN / tasaN - usd) > Math.max(0.01, usd * 0.005))
        throw new Error(`Los bolívares y la tasa no cuadran con $ ${usd.toFixed(2).replace('.', ',')}: ${fmtBsNum(bsN)} ÷ ${fmtRate(tasaN)} = ${fmtUsd(round2(bsN / tasaN))}.`)
    }
  }
  if (f.fechaTasa !== i.fechaTasa) {
    if (f.fechaTasa && bs == null && tasa == null) throw new Error('La fecha de la tasa solo aplica si hay bolívares o tasa.')
    p.fecha_tasa = nul(f.fechaTasa)
  }
  if (f.metodo !== i.metodo) p.metodo = (nul(f.metodo) as Metodo | null) ?? null
  if (f.referencia !== i.referencia) p.referencia = nul(f.referencia)
  if (f.bancoOrigen !== i.bancoOrigen) p.banco_origen = nul(f.bancoOrigen)
  if (f.last4 !== i.last4) {
    if (f.last4.trim() && !/^\d{4}$/.test(f.last4.trim())) throw new Error('Los últimos dígitos de la cuenta son exactamente 4 números.')
    p.cuenta_origen_ultimos4 = nul(f.last4)
  }
  if (f.bancoDestino !== i.bancoDestino) p.banco_destino = nul(f.bancoDestino)
  if (f.recibido !== i.recibido) p.recibido_por = nul(f.recibido)
  if (f.notas !== i.notas) p.notas = nul(f.notas)
  return p
}

// ---------- foco atrapado, Esc y foco devuelto ----------
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])'
function useModal(ref: React.RefObject<HTMLElement | null>, onEscape: () => void) {
  const esc = useRef(onEscape)
  esc.current = onEscape
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const el = ref.current
    el?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (e.defaultPrevented) return
        e.stopPropagation() // no cierra también la factura o el cajón que hay debajo
        e.preventDefault()
        esc.current()
        return
      }
      if (e.key !== 'Tab' || !el) return
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement)
      if (!items.length) return e.preventDefault()
      const first = items[0]
      const last = items[items.length - 1]
      const at = document.activeElement
      if (e.shiftKey && (at === first || at === el)) (e.preventDefault(), last.focus())
      else if (!e.shiftKey && at === last) (e.preventDefault(), first.focus())
      else if (!el.contains(at)) (e.preventDefault(), first.focus())
    }
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('keydown', key, true)
      prev?.focus?.()
    }
  }, [ref])
}

/** «hoy 10:42», «5 oct 10:42» */
function when(iso: string) {
  const d = new Date(iso)
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const h = d.toLocaleTimeString('es', { hour: 'numeric', minute: '2-digit' })
  return `${day === todayISO() ? 'hoy' : fmtDate(day)} ${h}`
}

const Dash = () => <span className="cobro-none">—</span>

function Fact({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`cobro-fact${wide ? ' is-wide' : ''}`}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/** Quién recibió: un círculo con el avatar del socio y de dónde salió el dato. */
function Receiver({ c, onPick }: { c: CobroT; onPick: () => void }) {
  if (!c.recibido_por)
    return (
      <p className="cobro-recv is-none">
        <span>Todavía no se sabe quién recibió.</span>
        <button type="button" className="cobro-link" onClick={onPick}>
          Elegir receptor
        </button>
      </p>
    )
  return (
    <p className="cobro-recv">
      <span className="cobro-av" aria-hidden="true">
        <Blobvatar seed={avatarFor(c.recibido_por.nombre)} size={28} />
      </span>
      <span>
        Recibió <strong>{c.recibido_por.nombre}</strong>
        {c.recibido_por_origen === 'comprobante' ? ', asignado por el comprobante' : ', anotado a mano'}
      </span>
    </p>
  )
}

// ---------- receptores (cédula -> socio) ----------
function ReceptorForm({ onSaved, compact }: { onSaved: () => Promise<void> | void; compact?: boolean }) {
  const users = useUsers()
  const [doc, setDoc] = useState('')
  const [who, setWho] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const uid = useId()
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!doc.trim() || !who) return setErr('Escribe la cédula completa y elige a qué socio pertenece.')
    setBusy(true)
    setErr('')
    try {
      await saveReceptor(doc.trim(), who)
      setDoc('') // la cédula completa solo vive en este input: nunca se vuelve a mostrar
      setWho('')
      await onSaved()
    } catch (x) {
      setErr(msgOf(x, 'No se pudo guardar la cédula.'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className={`cobro-rform${compact ? ' is-compact' : ''}`} onSubmit={(e) => void submit(e)} autoComplete="off">
      <label className="cobro-field">
        <span>Cédula completa</span>
        <input id={`${uid}-doc`} value={doc} onChange={(e) => setDoc(e.target.value)} placeholder="V-12345678" autoComplete="off" spellCheck={false} maxLength={20} />
      </label>
      <label className="cobro-field">
        <span>Socio</span>
        <select value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">Elige un socio</option>
          {users.map((u) => (
            <option key={u.id} value={u.name}>
              {u.name}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="primary cobro-btn" disabled={busy}>
        {busy ? 'Guardando…' : compact ? 'Guardar y volver a cruzar' : 'Guardar cédula'}
      </button>
      {err && (
        <p className="cobro-err" role="alert">
          {err}
        </p>
      )}
    </form>
  )
}

function Receptores({ list, state, reload }: { list: Receptor[]; state: 'loading' | 'ok' | 'error'; reload: () => Promise<void> }) {
  const [ask, setAsk] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [adding, setAdding] = useState(false)
  const quitar = async (r: Receptor) => {
    setErr('')
    try {
      await deleteReceptor(r.id)
      setAsk(null)
      await reload()
    } catch (x) {
      setErr(msgOf(x, 'No se pudo quitar la cédula.'))
    }
  }
  return (
    <section className="cobro-block" aria-labelledby="cobro-rec-t">
      <h3 id="cobro-rec-t">Cédulas registradas</h3>
      <div className="cobro-card is-dark">
        {state === 'loading' && <p className="cobro-muted">Cargando…</p>}
        {state === 'error' && (
          <p className="cobro-muted">
            No se pudieron cargar.{' '}
            <button type="button" className="cobro-link" onClick={() => void reload()}>
              Reintentar
            </button>
          </p>
        )}
        {state === 'ok' && list.length === 0 && <p className="cobro-muted">Todavía no hay cédulas registradas. Sin ellas el comprobante no sabe a quién asignar el cobro.</p>}
        {state === 'ok' && list.length > 0 && (
          <ul className="cobro-recs">
            {list.map((r) => (
              <li key={r.id}>
                <span className="cobro-doc">{r.documento}</span>
                <strong>{r.socio.nombre}</strong>
                {ask === r.id ? (
                  <span className="cobro-confirm">
                    <button type="button" className="cobro-link is-bad" onClick={() => void quitar(r)}>
                      Quitar
                    </button>
                    <button type="button" className="cobro-link" onClick={() => setAsk(null)}>
                      No
                    </button>
                  </span>
                ) : (
                  <button type="button" className="cobro-x" aria-label={`Quitar la cédula ${r.documento} de ${r.socio.nombre}`} onClick={() => setAsk(r.id)}>
                    <Icon name="close" size={13} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {err && (
          <p className="cobro-err" role="alert">
            {err}
          </p>
        )}
        {adding ? (
          <ReceptorForm
            onSaved={async () => {
              await reload()
              setAdding(false)
            }}
          />
        ) : (
          <button type="button" className="cobro-link" onClick={() => setAdding(true)}>
            + Registrar una cédula
          </button>
        )}
      </div>
      <p className="cobro-note">Solo se ve enmascarada: la cédula completa se escribe una vez y no vuelve a mostrarse.</p>
    </section>
  )
}

// ---------- el modal ----------
/** Detalle de un cobro: dólares y bolívares con la tasa, banco, quién recibió y el comprobante con su detección de receptor. */
export default function Cobro({ id, onClose }: { id: string; onClose: () => void }) {
  const users = useUsers()
  const [cobro, setCobro] = useState<CobroT | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ok' | 'error'>('loading')
  const [loadErr, setLoadErr] = useState('')
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<Form>(formOf(null))
  const [msg, setMsg] = useState('')
  const [flash, setFlash] = useState('')
  const [busy, setBusy] = useState(false)
  // comprobante
  const [det, setDet] = useState<Deteccion | null>(null)
  const [info, setInfo] = useState<{ documento: string | null; texto: string } | null>(null)
  const [upBusy, setUpBusy] = useState(false)
  const [upErr, setUpErr] = useState('')
  const [over, setOver] = useState(false)
  const [zoom, setZoom] = useState(false)
  const [imgBad, setImgBad] = useState(false)
  const [resolved, setResolved] = useState('')
  // receptores
  const [recs, setRecs] = useState<Receptor[]>([])
  const [recState, setRecState] = useState<'loading' | 'ok' | 'error'>('loading')

  const root = useRef<HTMLDivElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const firstField = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const live = useRef(0)

  const initial = useMemo(() => formOf(cobro), [cobro])
  const guard = useFormGuard<Form>({
    id: `cobro:${id}`,
    label: `Cobro · ${cobro?.cliente ?? ''}`,
    values: editing ? form : initial,
    initial,
    labels: GUARD_LABELS,
    apply: (v) => {
      setForm(v)
      setEditing(true)
    },
  })

  const say = (s: string) => {
    setFlash(s)
    const n = ++live.current
    window.setTimeout(() => live.current === n && setFlash(''), 3200)
  }

  // ---- carga
  const load = useCallback(async () => {
    setPhase('loading')
    try {
      const c = await getCobro(id)
      setCobro(c)
      setPhase('ok')
      setImgBad(false)
      if (c.comprobante) {
        try {
          const r = await getComprobante(id)
          setInfo({ documento: r.documento_detectado, texto: r.texto_ocr })
        } catch {
          setInfo(null)
        }
      }
    } catch (e) {
      setLoadErr(msgOf(e, 'No se pudo cargar el cobro.'))
      setPhase('error')
    }
  }, [id])
  const loadRecs = useCallback(async () => {
    try {
      setRecs(await listReceptores())
      setRecState('ok')
    } catch {
      setRecState('error')
    }
  }, [])
  useEffect(() => {
    void load()
    void loadRecs()
    if (!users.length) void loadUsers().catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // ---- cierre
  const close = () => {
    if (editing && guard.changed.length && !window.confirm(`Tienes cambios sin guardar (${guard.changed.join(', ')}). ¿Cerrar de todos modos?\n\nGuardamos un borrador en este navegador por si vuelves.`)) return
    onClose()
  }
  const closeRef = useRef(close)
  closeRef.current = close
  useModal(root, () => (zoom ? setZoom(false) : closeRef.current()))

  // ---- edición
  const startEdit = (focusReceiver = false) => {
    if (!cobro) return
    setForm(formOf(cobro))
    setMsg('')
    setEditing(true)
    window.setTimeout(() => (focusReceiver ? root.current?.querySelector<HTMLElement>('[data-recv]') : firstField.current)?.focus(), 30)
  }
  const cancelEdit = () => {
    if (guard.changed.length && !window.confirm('¿Descartar los cambios de este cobro?')) return
    guard.discard()
    setEditing(false)
    setMsg('')
  }
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }))

  /** Guarda un parche con la marca que vio quien edita; si alguien guardó antes, deja elegir. Devuelve el cobro resultante (o null si se adoptó el guardado). */
  const commit = async (patch: CobroPatch, mine: Form): Promise<{ cobro: CobroT; adopted: boolean }> => {
    if (!cobro) throw new Error('El cobro no está cargado.')
    const box: { v: CobroT | null } = { v: null }
    const r = await saveGuarded({
      title: 'Alguien cambió este cobro mientras lo editabas',
      base: cobro.actualizado_el ?? undefined,
      save: (ifMatch) => patchCobro(id, patch, ifMatch),
      fresh: async () => {
        const t = await getCobro(id)
        box.v = t
        return { stamp: t.actualizado_el ?? undefined, values: formOf(t) }
      },
      mine,
      labels: LABELS,
    })
    return r.kind === 'saved' ? { cobro: r.value, adopted: false } : { cobro: box.v ?? (await getCobro(id)), adopted: true }
  }

  const save = async () => {
    if (!cobro) return
    let patch: CobroPatch
    try {
      patch = toPatch(form, initial, cobro.monto)
    } catch (e) {
      return setMsg(msgOf(e, 'Revisa los datos.'))
    }
    if (!Object.keys(patch).length) {
      guard.discard()
      setEditing(false)
      return
    }
    setBusy(true)
    setMsg('')
    try {
      const r = await commit(patch, form)
      guard.discard()
      setCobro(r.cobro)
      setEditing(false)
      say(r.adopted ? 'Se quedó la versión guardada' : 'Cobro guardado')
    } catch (e) {
      setMsg(msgOf(e, 'No se pudo guardar.'))
    } finally {
      setBusy(false)
    }
  }

  /** Cambia solo quién recibió (desde la detección o el selector): mismo guardado con conflicto. */
  const setReceiver = async (name: string | null, note: string) => {
    if (!cobro) return
    setBusy(true)
    setMsg('')
    try {
      const r = await commit({ recibido_por: name }, { ...initial, recibido: name ?? '' })
      setCobro(r.cobro)
      setResolved(r.adopted ? 'Se quedó la versión guardada.' : note)
      say(note)
    } catch (e) {
      setResolved('')
      setUpErr(msgOf(e, 'No se pudo guardar el receptor.'))
    } finally {
      setBusy(false)
    }
  }

  // ---- comprobante
  const send = useCallback(
    async (f: File) => {
      setUpErr('')
      const bad = receiptProblem(f)
      if (bad) return setUpErr(bad)
      setUpBusy(true)
      setResolved('')
      try {
        const r = await uploadComprobante(id, await readBase64(f), f.name)
        const untouched = form.recibido === initial.recibido
        setCobro(r.cobro)
        setForm((x) => (untouched ? { ...x, recibido: formOf(r.cobro).recibido } : x))
        setDet(r.deteccion)
        setInfo({ documento: r.deteccion.documento, texto: r.deteccion.texto_ocr ?? '' })
        setImgBad(false)
        say('Comprobante guardado')
      } catch (e) {
        setUpErr(msgOf(e, 'No se pudo subir el comprobante.'))
      } finally {
        setUpBusy(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, form.recibido, initial.recibido],
  )
  const sendRef = useRef(send)
  sendRef.current = send
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/'))
      if (!f) return
      e.preventDefault()
      void sendRef.current(f)
    }
    window.addEventListener('paste', paste)
    return () => window.removeEventListener('paste', paste)
  }, [])
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f) void send(f)
  }
  const cross = async () => {
    setUpErr('')
    setResolved('')
    setUpBusy(true)
    try {
      const r = await detectarComprobante(id)
      setCobro(r.cobro)
      setDet(r.deteccion)
    } catch (e) {
      setUpErr(msgOf(e, 'No se pudo volver a detectar.'))
    } finally {
      setUpBusy(false)
    }
  }

  const stateLabel = !cobro ? '' : cobro.estado === 'cobrado' ? 'Pagado' : cobro.vencido ? 'Vencido' : 'Pendiente'
  const stateCls = !cobro ? '' : cobro.estado === 'cobrado' ? 'ok' : cobro.vencido ? 'late' : 'due'
  const usdTitle = cobro ? fmtUsd(cobro.monto).replace(/,00$/, '') : ''
  const bsN = parseNum(form.bs)
  const tasaN = parseNum(form.tasa)
  const hintBs = editing && cobro && form.bs !== initial.bs && form.tasa === initial.tasa && bsN != null && bsN > 0 ? round4(bsN / cobro.monto) : null
  const hintTasa = editing && cobro && form.tasa !== initial.tasa && form.bs === initial.bs && tasaN != null && tasaN > 0 ? round2(cobro.monto * tasaN) : null
  const mismatch =
    editing && cobro && form.bs !== initial.bs && form.tasa !== initial.tasa && bsN != null && tasaN != null && tasaN > 0 && Math.abs(bsN / tasaN - cobro.monto) > Math.max(0.01, cobro.monto * 0.005)
      ? round2(bsN / tasaN)
      : null

  return createPortal(
    <div className="modal cobro-modal" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={root} className="sheet cobro-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={phase === 'loading'} tabIndex={-1}>
        <header>
          <div className="cobro-head">
            <p className="cobro-eyebrow">Finanzas · cobro</p>
            <h2 id={titleId}>{cobro ? `Cobro de ${usdTitle}` : phase === 'error' ? 'No se pudo abrir el cobro' : 'Cobro'}</h2>
            {cobro && (
              <p className="cobro-sub">
                {cobro.cliente} · {cobro.concepto} · {fmtDate(cobro.fecha, true)}
              </p>
            )}
          </div>
          {cobro && <span className={`cobro-pill ${stateCls}`}>{stateLabel}</span>}
          <button type="button" className="x" onClick={close} aria-label="Cerrar">
            <Icon name="close" size={18} />
          </button>
        </header>

        <p className="cobro-live" role="status" aria-live="polite">
          {flash}
        </p>

        {phase === 'loading' && (
          <div className="cobro-state" aria-live="polite">
            <i className="cobro-spin" aria-hidden="true" />
            <p>Abriendo el cobro…</p>
          </div>
        )}
        {phase === 'error' && (
          <div className="cobro-state">
            <p className="cobro-err" role="alert">
              {loadErr}
            </p>
            <button type="button" className="primary cobro-btn" onClick={() => void load()}>
              Reintentar
            </button>
          </div>
        )}

        {cobro && phase === 'ok' && (
          <>
            {!editing && <DraftBar guard={guard} />}
            <div className="cobro-body">
              <div className="cobro-main">
                {/* ---------------- detalle ---------------- */}
                <section className="cobro-card is-detail" aria-labelledby="cobro-det-t">
                  <h3 id="cobro-det-t">Detalle del pago</h3>
                  {!editing ? (
                    <>
                      <dl className="cobro-facts">
                        <Fact label="Monto en dólares">
                          <b className="cobro-usd">{fmtUsd(cobro.monto)}</b>
                        </Fact>
                        <Fact label="Monto en bolívares">{cobro.monto_bs != null ? <b className="cobro-bs">Bs. {fmtBsNum(cobro.monto_bs)}</b> : <Dash />}</Fact>
                        <Fact label="Tasa del día">
                          {cobro.tasa != null ? (
                            <>
                              {fmtRate(cobro.tasa)}
                              {cobro.fecha_tasa ? ` · ${fmtDate(cobro.fecha_tasa)}` : ''}
                            </>
                          ) : (
                            <Dash />
                          )}
                        </Fact>
                        <Fact label="Método">{cobro.metodo ? METODO_LABEL[cobro.metodo] : <Dash />}</Fact>
                        <Fact label="Referencia">{cobro.referencia ? <span className="cobro-num">{cobro.referencia}</span> : <Dash />}</Fact>
                        <Fact label="Fecha del pago">{fmtDate(cobro.fecha, true)}</Fact>
                      </dl>
                      {cobro.monto_bs != null && cobro.tasa != null && (
                        <p className="cobro-calc">
                          Bs. {fmtBsNum(cobro.monto_bs)} · tasa {fmtRate(cobro.tasa)}
                          {cobro.fecha_tasa ? ` del ${fmtDate(cobro.fecha_tasa)}` : ''}
                        </p>
                      )}
                      <hr />
                      <div className="cobro-route">
                        <div>
                          <span>Sale de</span>
                          <strong>
                            {cobro.banco_origen ?? <Dash />}
                            {cobro.cuenta_origen_ultimos4 && (
                              <span className="cobro-mask" aria-label={`terminada en ${cobro.cuenta_origen_ultimos4}`}>
                                {' '}
                                ····{cobro.cuenta_origen_ultimos4}
                              </span>
                            )}
                          </strong>
                        </div>
                        <i aria-hidden="true">→</i>
                        <div>
                          <span>Llega a</span>
                          <strong>{cobro.banco_destino ?? <Dash />}</strong>
                        </div>
                      </div>
                      <Receiver c={cobro} onPick={() => startEdit(true)} />
                      {cobro.notas && (
                        <p className="cobro-notes">
                          <span>Notas</span>
                          {cobro.notas}
                        </p>
                      )}
                    </>
                  ) : (
                    <form
                      className="cobro-form"
                      onSubmit={(e) => {
                        e.preventDefault()
                        void save()
                      }}
                      autoComplete="off"
                    >
                      <p className="cobro-usd-row">
                        Monto en dólares <b>{fmtUsd(cobro.monto)}</b> <small>lo maneja Finanzas; aquí no se cambia</small>
                      </p>
                      <label className="cobro-field">
                        <span>Bolívares recibidos</span>
                        <input ref={firstField} inputMode="decimal" value={form.bs} onChange={(e) => set('bs', e.target.value)} placeholder="65.540,25" />
                        {hintBs != null && <small>La tasa quedará en {fmtRate(hintBs)} al guardar.</small>}
                      </label>
                      <label className="cobro-field">
                        <span>Tasa (Bs por USD)</span>
                        <input inputMode="decimal" value={form.tasa} onChange={(e) => set('tasa', e.target.value)} placeholder="873,87" />
                        {hintTasa != null && <small>Los bolívares quedarán en Bs. {fmtBsNum(hintTasa)} al guardar.</small>}
                        {mismatch != null && (
                          <small className="is-bad">
                            No cuadra: eso da {fmtUsd(mismatch)} y el cobro es de {fmtUsd(cobro.monto)}.
                          </small>
                        )}
                      </label>
                      <label className="cobro-field">
                        <span>Fecha de la tasa</span>
                        <input type="date" value={form.fechaTasa} onChange={(e) => set('fechaTasa', e.target.value)} />
                        <small>Vacía = la fecha del cobro.</small>
                      </label>
                      <label className="cobro-field">
                        <span>Método</span>
                        <select value={form.metodo} onChange={(e) => set('metodo', e.target.value)}>
                          <option value="">Sin indicar</option>
                          {METODOS.map((m) => (
                            <option key={m} value={m}>
                              {METODO_LABEL[m]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="cobro-field">
                        <span>Referencia</span>
                        <input value={form.referencia} onChange={(e) => set('referencia', e.target.value)} maxLength={60} placeholder="071026007463" />
                      </label>
                      <div className="cobro-pair">
                        <label className="cobro-field">
                          <span>Banco de origen</span>
                          <input value={form.bancoOrigen} onChange={(e) => set('bancoOrigen', e.target.value)} maxLength={60} placeholder="Bancrecer" />
                        </label>
                        <label className="cobro-field is-short">
                          <span>Últimos 4</span>
                          <input inputMode="numeric" value={form.last4} onChange={(e) => set('last4', e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="8017" />
                        </label>
                      </div>
                      <label className="cobro-field">
                        <span>Banco destino</span>
                        <input value={form.bancoDestino} onChange={(e) => set('bancoDestino', e.target.value)} maxLength={60} placeholder="Mercantil" />
                      </label>
                      <label className="cobro-field">
                        <span>Recibió</span>
                        <select data-recv="" value={form.recibido} onChange={(e) => set('recibido', e.target.value)}>
                          <option value="">Sin asignar</option>
                          {users.map((u) => (
                            <option key={u.id} value={u.name}>
                              {u.name}
                            </option>
                          ))}
                          {form.recibido && !users.some((u) => u.name === form.recibido) && <option value={form.recibido}>{form.recibido}</option>}
                        </select>
                        {cobro.recibido_por_origen === 'comprobante' && form.recibido === initial.recibido && <small>Asignado desde el comprobante; si lo cambias queda como anotado a mano.</small>}
                      </label>
                      <label className="cobro-field is-wide">
                        <span>Notas</span>
                        <textarea value={form.notas} onChange={(e) => set('notas', e.target.value)} rows={3} maxLength={1000} />
                      </label>
                      <button type="submit" hidden />
                    </form>
                  )}
                </section>

                {/* ---------------- comprobante ---------------- */}
                <section className="cobro-block" aria-labelledby="cobro-cmp-t">
                  <h3 id="cobro-cmp-t">{cobro.comprobante ? 'Comprobante' : 'Sin comprobante todavía'}</h3>
                  <input
                    ref={file}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      e.target.value = ''
                      if (f) void send(f)
                    }}
                  />
                  {upBusy ? (
                    <div className="cobro-card cobro-reading" role="status">
                      <i className="cobro-spin" aria-hidden="true" />
                      <div>
                        <strong>Leyendo el comprobante…</strong>
                        <p>Se guarda la foto y se busca la cédula de quien recibió. Puede tardar unos segundos.</p>
                      </div>
                    </div>
                  ) : cobro.comprobante ? (
                    <div className="cobro-card cobro-file">
                      <button type="button" className="cobro-thumb" onClick={() => setZoom(true)} aria-label="Ver la imagen del comprobante en grande" disabled={imgBad}>
                        {imgBad ? <span>No se pudo cargar la imagen</span> : <img src={comprobanteUrl(id, cobro.comprobante.subido_el)} alt={`Comprobante ${cobro.comprobante.nombre}`} onError={() => setImgBad(true)} />}
                      </button>
                      <div className="cobro-fileinfo">
                        <strong title={cobro.comprobante.nombre}>{cobro.comprobante.nombre}</strong>
                        <small>
                          {fmtBytes(cobro.comprobante.tamano)} · subido {when(cobro.comprobante.subido_el)}
                        </small>
                        <p>La foto se lee en el servidor. La cédula nunca se muestra completa: solo las primeras tres cifras y las últimas dos.</p>
                        <div className="cobro-actions">
                          <button type="button" className="primary cobro-btn" onClick={() => setZoom(true)} disabled={imgBad}>
                            Ver imagen
                          </button>
                          <button type="button" className="ghost cobro-btn" onClick={() => file.current?.click()}>
                            Reemplazar
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className={`cobro-drop${over ? ' is-over' : ''}`}
                      onClick={() => file.current?.click()}
                      onDragOver={(e) => (e.preventDefault(), setOver(true))}
                      onDragLeave={() => setOver(false)}
                      onDrop={onDrop}
                    >
                      <span className="cobro-drop-ico" aria-hidden="true">
                        <Icon name="share" size={26} />
                      </span>
                      <strong>Suelta la foto del comprobante aquí</strong>
                      <small>JPG, PNG o WebP, hasta 4 MB. También sirve pegarla con Ctrl+V.</small>
                    </button>
                  )}
                  {upErr && (
                    <p className="cobro-err" role="alert">
                      {upErr}
                    </p>
                  )}
                </section>
              </div>

              <aside className="cobro-side">
                <Detection
                  cobro={cobro}
                  det={det}
                  info={info}
                  resolved={resolved}
                  busy={busy || upBusy}
                  onSet={(n, note) => void setReceiver(n, note)}
                  onKeep={(n) => setResolved(`Se dejó a ${n} como receptor.`)}
                  onCross={() => void cross()}
                  onMapped={async () => {
                    await loadRecs()
                    await cross()
                  }}
                />
                <Receptores list={recs} state={recState} reload={loadRecs} />
              </aside>
            </div>

            <footer>
              <p className={msg ? 'err' : 'ok-note'} role="alert">
                {msg}
              </p>
              {editing ? (
                <>
                  <button type="button" className="ghost" onClick={cancelEdit} disabled={busy}>
                    Cancelar
                  </button>
                  <button type="button" className="primary" onClick={() => void save()} disabled={busy}>
                    {busy ? 'Guardando…' : 'Guardar'}
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="ghost" onClick={close}>
                    Cerrar
                  </button>
                  <button type="button" className="primary" onClick={() => startEdit()}>
                    <Icon name="edit" size={15} /> Editar detalle
                  </button>
                </>
              )}
            </footer>
          </>
        )}

        {zoom && cobro?.comprobante && (
          <div className="cobro-zoom" role="dialog" aria-modal="true" aria-label="Comprobante en grande" onMouseDown={(e) => e.target === e.currentTarget && setZoom(false)}>
            <button type="button" className="x" onClick={() => setZoom(false)} aria-label="Cerrar la imagen" autoFocus>
              <Icon name="close" size={18} />
            </button>
            <img src={comprobanteUrl(id, cobro.comprobante.subido_el)} alt={`Comprobante ${cobro.comprobante.nombre}`} />
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

// ---------- qué dice la detección ----------
const TONE: Record<Deteccion['estado'], 'ok' | 'warn' | 'bad'> = { asignado: 'ok', ya_asignado: 'ok', difiere: 'warn', sin_mapeo: 'warn', no_detectado: 'bad' }
const TITLE: Record<Deteccion['estado'], string> = { asignado: 'Asignado', ya_asignado: 'Ya asignado', difiere: 'Difiere', sin_mapeo: 'Sin mapeo', no_detectado: 'No detectado' }

function Detection({
  cobro,
  det,
  info,
  resolved,
  busy,
  onSet,
  onKeep,
  onCross,
  onMapped,
}: {
  cobro: CobroT
  det: Deteccion | null
  info: { documento: string | null; texto: string } | null
  resolved: string
  busy: boolean
  onSet: (name: string | null, note: string) => void
  onKeep: (current: string) => void
  onCross: () => void
  onMapped: () => Promise<void>
}) {
  const users = useUsers()
  const [pick, setPick] = useState('')
  const [assoc, setAssoc] = useState(false)
  const [manual, setManual] = useState(false)
  useEffect(() => {
    setPick('')
    setAssoc(false)
    setManual(false)
  }, [det])

  // Sin resultado en vivo: lo que se sabe del comprobante ya guardado, sin volver a cruzar nada por su cuenta.
  const doc = det ? det.documento : info?.documento ?? null
  const state: Deteccion['estado'] | 'leida' | null = det
    ? det.estado
    : !cobro.comprobante
      ? null
      : !doc
        ? 'no_detectado'
        : cobro.recibido_por_origen === 'comprobante'
          ? 'asignado'
          : 'leida'
  const socio = det?.socio ?? (state === 'asignado' ? cobro.recibido_por : null)
  const needs = det ? det.requiere_confirmacion : state === 'no_detectado' && !cobro.recibido_por

  const body = (): ReactNode => {
    switch (state) {
      case 'asignado':
        return (
          <p>
            Se leyó la cédula <span className="cobro-doc">{doc}</span> y coincide con <b>{socio?.nombre}</b>. El receptor queda puesto solo.
          </p>
        )
      case 'ya_asignado':
        return (
          <p>
            El cobro ya tenía a <b>{socio?.nombre}</b> como receptor y coincide con el comprobante (<span className="cobro-doc">{doc}</span>). No se cambia nada.
          </p>
        )
      case 'difiere':
        return (
          <p>
            El cobro dice <b>{cobro.recibido_por?.nombre ?? 'otro socio'}</b>, el comprobante (<span className="cobro-doc">{doc}</span>) apunta a <b>{socio?.nombre}</b>. No se cambia sin preguntar.
          </p>
        )
      case 'sin_mapeo':
        return (
          <p>
            Se leyó la cédula <span className="cobro-doc">{doc}</span>, pero ningún socio la tiene registrada.
          </p>
        )
      case 'no_detectado':
        return <p>La foto no dejó leer ninguna cédula.{needs ? ' Se elige el receptor a mano.' : ` El receptor (${cobro.recibido_por?.nombre}) se anotó ${cobro.recibido_por_origen === 'comprobante' ? 'antes' : 'a mano'}.`}</p>
      case 'leida':
        return (
          <p>
            El comprobante trae la cédula <span className="cobro-doc">{doc}</span>. Cruzarla con los socios la compara con las registradas; si el cobro ya tiene receptor, no lo cambia.
          </p>
        )
      default:
        return <p>Sube la foto del comprobante y aquí aparece qué se leyó y a quién se asignó el cobro.</p>
    }
  }

  const tone = state && state !== 'leida' ? TONE[state] : 'neutral'
  return (
    <section className="cobro-block" aria-labelledby="cobro-det2-t">
      <h3 id="cobro-det2-t">Qué dice la detección</h3>
      <div className={`cobro-detect is-${tone}`} aria-live="polite">
        <strong>{state && state !== 'leida' ? TITLE[state] : state === 'leida' ? 'Cédula leída' : 'Todavía nada'}</strong>
        {body()}
        {resolved && <p className="cobro-resolved">{resolved}</p>}

        {!resolved && state === 'difiere' && socio && (
          <div className="cobro-actions">
            <button type="button" className="primary cobro-btn is-sm" disabled={busy} onClick={() => onSet(socio.nombre, `Receptor cambiado a ${socio.nombre}.`)}>
              Cambiar a {socio.nombre}
            </button>
            <button type="button" className="ghost cobro-btn is-sm" disabled={busy} onClick={() => onKeep(cobro.recibido_por?.nombre ?? 'el actual')}>
              Dejar a {cobro.recibido_por?.nombre ?? 'el actual'}
            </button>
          </div>
        )}
        {!resolved && state === 'sin_mapeo' && !assoc && (
          <div className="cobro-actions">
            <button type="button" className="primary cobro-btn is-sm" onClick={() => setAssoc(true)}>
              Asociar a un socio
            </button>
          </div>
        )}
        {!resolved && state === 'sin_mapeo' && assoc && <ReceptorForm compact onSaved={onMapped} />}
        {!resolved && state === 'leida' && (
          <div className="cobro-actions">
            <button type="button" className="primary cobro-btn is-sm" disabled={busy} onClick={onCross}>
              Cruzar con los socios
            </button>
          </div>
        )}
        {!resolved && needs && !assoc && !manual && cobro.recibido_por && (
          <button type="button" className="cobro-link" onClick={() => setManual(true)}>
            Elegir otro receptor a mano
          </button>
        )}
        {!resolved && needs && !assoc && (manual || !cobro.recibido_por) && (
          <div className="cobro-confirm-row">
            <label className="cobro-field">
              <span>Confirmar receptor a mano</span>
              <select value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">Elige un socio</option>
                {users.map((u) => (
                  <option key={u.id} value={u.name}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="ghost cobro-btn is-sm" disabled={!pick || busy} onClick={() => onSet(pick, `Receptor confirmado a mano: ${pick}.`)}>
              Confirmar
            </button>
          </div>
        )}
        {cobro.comprobante && (det || info) && (det?.texto_ocr || info?.texto) ? (
          <details className="cobro-ocr">
            <summary>Ver el texto que se leyó</summary>
            <pre>{det?.texto_ocr ?? info?.texto}</pre>
          </details>
        ) : null}
      </div>
    </section>
  )
}
