// Historial de versiones (solo lectura): qué cambió, cuándo y quién lo publicó, lo más nuevo arriba. Las versiones se publican por la API/MCP.
// Se abre desde el menú del astronauta, desde la alerta «Nueva actualización» de la campana y desde el banner («Ver cambios»).
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from './api'
import { fmtDate } from './store'
import { closeChangelog, useUpdates } from './updates'
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
            <p className="ver-lede">Qué cambió y cuándo. Lo más nuevo arriba.</p>
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
          </div>
        </div>
      </section>
    </div>,
    document.body,
  )
}
