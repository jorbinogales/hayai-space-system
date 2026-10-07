// Historial de versiones: qué cambió, cuándo y quién lo publicó (lo más nuevo arriba) y el formulario para publicar una nueva.
// Se abre desde el menú del astronauta, desde la alerta «Nueva actualización» de la campana y desde el banner («Ver cambios»).
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from './api'
import { useSession } from './session'
import { fmtDate, todayISO } from './store'
import { closeChangelog, isNewer, useFormGuard, useUpdates } from './updates'
import { DraftBar } from './UpdateUI'
import { Icon } from './ui'

export interface Release {
  id: string
  version: string
  titulo: string | null
  resumen: string | null
  cambios: string[]
  fecha: string
  autor: string
  actual: boolean
}

const SHOWN = 5

/** La versión que sigue a `v` (sube el parche): lo que se propone en el formulario. */
const nextPatch = (v: string) => {
  const [a, b, c] = v.split('.').map(Number)
  return `${a}.${b}.${(c ?? 0) + 1}`
}

const fmt = (iso: string) => {
  const [y] = iso.split('-')
  return `${fmtDate(iso)} ${y}`
}

function Entry({ r, focus }: { r: Release; focus: boolean }) {
  const [all, setAll] = useState(false)
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    if (focus) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [focus])
  const list = all ? r.cambios : r.cambios.slice(0, SHOWN)
  return (
    <article ref={ref} className={`ver-entry${r.actual ? ' is-current' : ''}${focus ? ' is-focus' : ''}`} aria-label={`Versión ${r.version}`}>
      <header>
        <b className="ver-num">{r.version}</b>
        {r.titulo && <span className="ver-title">{r.titulo}</span>}
        {r.actual && <span className="ver-tag">ACTUAL</span>}
      </header>
      <p className="ver-meta">
        {fmt(r.fecha)} · {r.autor}
      </p>
      {r.resumen && <p className="ver-sum">{r.resumen}</p>}
      <ul>
        {list.map((c, i) => (
          <li key={i}>
            <span aria-hidden="true">▸</span>
            {c}
          </li>
        ))}
      </ul>
      {!all && r.cambios.length > SHOWN && (
        <button type="button" className="ver-more" onClick={() => setAll(true)}>
          …y {r.cambios.length - SHOWN} {r.cambios.length - SHOWN === 1 ? 'cambio más' : 'cambios más'}
        </button>
      )}
    </article>
  )
}

function PublishForm({ current, onDone }: { current: string | null; onDone: () => void }) {
  const me = useSession()
  const suggested = current ? nextPatch(current) : '1.0.0'
  const [version, setVersion] = useState(suggested)
  const [title, setTitle] = useState('')
  const [date, setDate] = useState(todayISO)
  const [changes, setChanges] = useState([''])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const values = { version, title, date, changes }
  const initial = { version: suggested, title: '', date: todayISO(), changes: [''] }
  const guard = useFormGuard({
    id: 'version:nueva',
    label: 'Nueva versión',
    values,
    initial,
    labels: { version: 'versión', title: 'título', changes: 'cambios' },
    apply: (v) => {
      setVersion(v.version)
      setTitle(v.title)
      setDate(v.date)
      setChanges(v.changes.length ? v.changes : [''])
    },
  })

  const clean = changes.map((c) => c.trim()).filter(Boolean)
  const tooLow = !!current && /^\d+\.\d+\.\d+$/.test(version.trim()) && !isNewer(version.trim(), current)
  const bad = !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version.trim()) ? 'La versión va como 1.6.0 (mayor.menor.parche).' : tooLow ? `Debe ser mayor que ${current}.` : date > todayISO() ? 'La fecha no puede ser futura.' : ''
  const can = !bad && clean.length > 0 && !busy

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!can) return
    setBusy(true)
    setError('')
    try {
      await api.post('/versions', { version: version.trim(), titulo: title.trim() || null, cambios: clean, fecha: date })
      guard.saved()
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo publicar la versión.')
      setBusy(false)
    }
  }

  return (
    <form className="ver-form" onSubmit={submit} noValidate>
      <p className="ver-kicker">PUBLICAR VERSIÓN</p>
      <DraftBar guard={guard} />
      <label className="ver-field">
        <span>Versión</span>
        <input value={version} onChange={(e) => setVersion(e.target.value)} inputMode="decimal" autoComplete="off" aria-invalid={!!bad} className={bad ? 'is-bad' : ''} />
        <small className={bad ? 'is-bad' : ''}>{bad || (current ? `Debe ser mayor que ${current}.` : 'La primera versión.')}</small>
      </label>
      <label className="ver-field">
        <span>
          Título <i>(opcional)</i>
        </span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ej. Ajustes del cobro" maxLength={80} autoComplete="off" />
      </label>
      <label className="ver-field">
        <span>Fecha</span>
        <input type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
      </label>
      <div className="ver-field" role="group" aria-label="Cambios">
        <span>Cambios</span>
        {changes.map((c, i) => (
          <input key={i} aria-label={`Cambio ${i + 1}`} value={c} placeholder="Un cambio por línea" maxLength={300} autoComplete="off" onChange={(e) => setChanges((cur) => cur.map((x, j) => (j === i ? e.target.value : x)))} />
        ))}
        <button type="button" className="ver-add" onClick={() => setChanges((cur) => (cur.length < 60 ? [...cur, ''] : cur))}>
          + Agregar otro cambio
        </button>
      </div>
      <p className="ver-by">
        Se firma como <b>{me?.name ?? 'tu usuario'}</b>
      </p>
      {error && (
        <p className="ver-err" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="primary" disabled={!can}>
        Publicar v{version.trim() || '…'}
      </button>
    </form>
  )
}

/** Popup del historial. Lo abre y lo cierra el estado de updates.ts (changelog). */
export default function Versions() {
  const { changelog } = useUpdates()
  const [list, setList] = useState<Release[] | null>(null)
  const [failed, setFailed] = useState(false)
  const close = useRef(closeChangelog)

  const load = () =>
    api
      .get<{ data: Release[] }>('/versions')
      .then((r) => {
        setList(r.data)
        setFailed(false)
      })
      .catch(() => setFailed(true))

  useEffect(() => {
    if (!changelog.open) return
    void load()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close.current()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [changelog.open])

  if (!changelog.open) return null
  const current = list?.find((r) => r.actual)?.version ?? null
  return createPortal(
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && closeChangelog()}>
      <section className="sheet ver" role="dialog" aria-modal="true" aria-labelledby="ver-h">
        <header>
          <div>
            <p className="ver-kicker">HAYAI SPACE</p>
            <h2 id="ver-h">Historial de versiones</h2>
            <p className="ver-lede">Qué cambió, cuándo y quién lo publicó. Lo más nuevo arriba.</p>
          </div>
          {current && <span className="ver-now">Actual · v{current}</span>}
          <button type="button" className="x" onClick={closeChangelog} aria-label="Cerrar">
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="ver-grid">
          <div className="ver-list">
            {failed && (
              <p className="ver-note">
                No se pudo cargar el historial.{' '}
                <button type="button" onClick={() => void load()}>
                  Reintentar
                </button>
              </p>
            )}
            {!list && !failed && <p className="ver-note">Cargando…</p>}
            {list?.length === 0 && <p className="ver-note">Aún no hay versiones publicadas.</p>}
            {list?.map((r) => (
              <Entry key={r.id} r={r} focus={r.version === changelog.version} />
            ))}
            <p className="ver-foot">El historial solo se agrega: una versión publicada no se edita ni se borra.</p>
          </div>
          {list && <PublishForm key={current ?? 'ninguna'} current={current} onDone={() => void load()} />}
        </div>
      </section>
    </div>,
    document.body,
  )
}
