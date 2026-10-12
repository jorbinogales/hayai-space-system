// «Ver guión» de un prospecto del Feed: el guión vigente, editarlo, mandarlo por WhatsApp, restablecerlo al original y el historial de
// versiones (de quién y cuándo). Lo ven y lo editan los tres socios; si dos editan a la vez, el servidor avisa en vez de pisar.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ApiError } from './api'
import {
  GUION_MAX,
  GUION_SUGERIDO,
  accionPrincipal,
  conGuion,
  conflictoGuion,
  contactoDe,
  editarGuion,
  fmtN,
  loadGuion,
  restablecerGuion,
  type FeedItem,
  type GuionDetalle,
  type GuionOut,
  type GuionTipo,
  type GuionVersion,
} from './feedData'
import { pushToast } from './toast'
import { ago } from './time'
import { Icon } from './ui'
import { useModal } from './useModal'
import './feedGuion.css'

const POLL_MS = 15_000

const TIPO_LABEL: Record<GuionTipo, string> = {
  original: 'Original',
  previo: 'Versión anterior (respaldo)',
  edicion: 'Edición',
  restablecido: 'Restablecido al original',
}
/** Quién la guardó: el nombre, o «Sistema» cuando la escribió una reescritura y no una persona. */
const quien = (por: string | null) => por ?? 'Sistema'
const fecha = (iso: string) => new Date(iso).toLocaleString('es', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
const msgOf = (e: unknown, fallback: string) => (e instanceof ApiError || e instanceof Error ? e.message : fallback)

/** A quién se le escribe: lo que dice el servidor y, si no halló número pero la tarjeta sí, el enlace de la tarjeta con el guión vigente. */
function destinoWa(item: FeedItem, g: GuionOut): { url: string | null; motivo: string } {
  if (g.whatsapp.url) return { url: g.whatsapp.url, motivo: '' }
  const c = accionPrincipal(contactoDe(item.datos))
  if (c?.tipo === 'whatsapp') return { url: conGuion(c.href, { guion: g.actual }), motivo: '' }
  return {
    url: null,
    motivo: g.whatsapp.estado === 'solo_fijo' || c?.tipo === 'llamar' ? 'Solo hay un teléfono fijo: no recibe WhatsApp' : 'Sin número detectado',
  }
}

export default function FeedGuion({ item, onClose, onItem }: { item: FeedItem; onClose: () => void; onItem: (it: FeedItem) => void }) {
  const titleId = useId()
  const root = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const editBtn = useRef<HTMLButtonElement>(null)

  const [det, setDet] = useState<GuionDetalle | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [base, setBase] = useState(0) // la versión que estaba mirando quien edita
  const [busy, setBusy] = useState<'guardar' | 'restablecer' | null>(null)
  const [err, setErr] = useState('')
  const [conflict, setConflict] = useState<{ nro: number; contenido: string; por: string | null; el: string; tipo: GuionTipo } | null>(null)
  const [remote, setRemote] = useState<GuionDetalle | null>(null)
  const [openV, setOpenV] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [copied, setCopied] = useState(false)
  const [changedBy, setChangedBy] = useState<string | null>(null)

  const g: GuionOut | null = det?.guion ?? item.guion ?? null
  const dirty = editing && !!det && draft.trim() !== det.guion.actual.trim()

  // ---- carga y refresco: al abrir, y cada 15 s mientras el modal está abierto (sin pisar lo que se está escribiendo)
  const detRef = useRef<GuionDetalle | null>(null)
  detRef.current = det
  const editingRef = useRef(false)
  editingRef.current = editing
  const busyRef = useRef(false)
  busyRef.current = busy !== null
  const refresh = useCallback(
    async (first = false) => {
      try {
        const r = await loadGuion(item.id)
        setLoadErr('')
        const cur = detRef.current
        if (!cur || first) {
          setDet(r)
          return
        }
        if (r.guion.version === cur.guion.version) return
        if (editingRef.current) setRemote(r) // alguien guardó mientras editas: se avisa, tu texto no se toca
        else {
          setDet(r)
          setChangedBy(`${quien(r.guion.por)} guardó la versión ${r.guion.version}`)
          onItem(r.item)
        }
      } catch (e) {
        if (!detRef.current) setLoadErr(msgOf(e, 'No se pudo cargar el guión.'))
      }
    },
    [item.id, onItem],
  )
  useEffect(() => {
    void refresh(true)
    const t = window.setInterval(() => {
      setNow(Date.now())
      if (document.visibilityState === 'visible' && !busyRef.current) void refresh()
    }, POLL_MS)
    return () => window.clearInterval(t)
  }, [refresh])

  // ---- cerrar (con aviso si hay texto sin guardar)
  const requestClose = () => {
    if (dirty && !window.confirm('Tienes cambios sin guardar en el guión. ¿Cerrar de todos modos?')) return
    onClose()
  }
  const closeRef = useRef(requestClose)
  closeRef.current = requestClose
  useModal(root, () => closeRef.current())

  // ---- editar
  const startEdit = () => {
    if (!det) return
    setDraft(det.guion.actual)
    setBase(det.guion.version)
    setErr('')
    setConflict(null)
    setRemote(null)
    setChangedBy(null)
    setEditing(true)
    window.setTimeout(() => {
      const a = area.current
      if (a) {
        a.focus()
        a.setSelectionRange(a.value.length, a.value.length)
      }
    }, 30)
  }
  const stopEdit = () => {
    setEditing(false)
    setConflict(null)
    setRemote(null)
    setErr('')
    window.setTimeout(() => editBtn.current?.focus(), 30)
  }
  const cancelEdit = () => {
    if (dirty && !window.confirm('¿Descartar los cambios del guión?')) return
    stopEdit()
  }
  const aplicar = (r: GuionDetalle, text: string) => {
    setDet(r)
    onItem(r.item)
    setChangedBy(null)
    stopEdit()
    pushToast({ text, tone: 'ok' })
  }
  const guardar = async (forzar = false) => {
    if (!det || busy) return
    const contenido = draft.trim()
    if (!contenido) return setErr('El guión no puede quedar vacío.')
    if (contenido === det.guion.actual.trim() && !forzar) return setErr('No hay cambios que guardar.')
    setBusy('guardar')
    setErr('')
    try {
      aplicar(await editarGuion(item.id, { contenido, base, forzar: forzar || undefined }), 'Guión guardado · quedó en el historial')
    } catch (e) {
      const v = conflictoGuion(e)
      if (v) {
        setConflict(v)
        void refresh()
      } else setErr(msgOf(e, 'No se pudo guardar el guión.'))
    } finally {
      setBusy(null)
    }
  }
  const usarSuya = () => {
    // se queda con el texto de la otra persona como base para seguir editando; lo tuyo se pierde solo si lo descartas tú
    if (!conflict) return
    setDraft(conflict.contenido)
    setBase(conflict.nro)
    setConflict(null)
    setRemote(null)
    window.setTimeout(() => area.current?.focus(), 30)
  }
  const restablecer = async () => {
    if (!det || busy || !det.guion.modificado) return
    setBusy('restablecer')
    setErr('')
    try {
      aplicar(await restablecerGuion(item.id, { base: det.guion.version }), 'Guión restablecido al original · queda en el historial')
    } catch (e) {
      const v = conflictoGuion(e)
      if (v) {
        void refresh()
        setErr(`${quien(v.por)} guardó la versión ${v.nro} mientras tanto. Revísala y vuelve a pulsar «Restablecer al original».`)
      } else setErr(msgOf(e, 'No se pudo restablecer.'))
    } finally {
      setBusy(null)
    }
  }
  const copiar = async () => {
    if (!g) return
    try {
      await navigator.clipboard.writeText(g.actual)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setErr('No se pudo copiar: selecciona el texto y cópialo a mano.')
    }
  }

  const wa = useMemo(() => (g ? destinoWa(item, g) : { url: null, motivo: '' }), [item, g])
  const largo = draft.trim().length
  const versiones: GuionVersion[] = det?.versiones ?? []
  const remotaNueva = editing && remote && remote.guion.version > base && !conflict

  return createPortal(
    <div className="modal fdg-modal" onMouseDown={(e) => e.target === e.currentTarget && closeRef.current()}>
      <div ref={root} className="sheet fdg-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={!det && !loadErr} tabIndex={-1}>
        <header className="fdg-head">
          <div className="fdg-title">
            <h2 id={titleId}>Guión</h2>
            <p>{item.titulo}</p>
          </div>
          <button type="button" className="x" onClick={() => closeRef.current()} aria-label="Cerrar">
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="sheet-body fdg-body">
          {!g && !loadErr && <p className="fdg-muted" role="status">Cargando el guión…</p>}
          {loadErr && !g && (
            <p className="err fdg-err" role="alert">
              {loadErr}{' '}
              <button type="button" className="fdg-link" onClick={() => void refresh(true)}>Reintentar</button>
            </p>
          )}

          {g && (
            <>
              <p className="fdg-meta">
                <span className="fdg-chip">Versión {g.version}</span>
                <span title={fecha(g.el)}>
                  {g.tipo === 'original' || g.tipo === 'previo'
                    ? `Original · ${quien(g.por)}, ${ago(g.el, now)}`
                    : `${g.tipo === 'restablecido' ? 'Restablecido al original por' : 'Editado por'} ${quien(g.por)} ${ago(g.el, now)}`}
                </span>
                {g.modificado && <span className="fdg-chip is-mod">Distinto del original</span>}
              </p>

              {changedBy && !editing && (
                <p className="fdg-banner" role="status">
                  {changedBy} mientras lo mirabas. Ya ves la versión nueva.
                </p>
              )}

              {!editing ? (
                <>
                  <div className="fdg-bubble" aria-label="Guión vigente">
                    {g.actual}
                  </div>
                  <p className="fdg-count">{fmtN(g.actual.length)} caracteres</p>

                  <div className="fdg-actions">
                    {wa.url ? (
                      <a className="fdg-btn is-wa" href={wa.url} target="_blank" rel="noopener noreferrer">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M3 21l1.7-5.1A8.5 8.5 0 1 1 8.2 19.4L3 21Z" />
                        </svg>
                        Enviar por WhatsApp
                        <span className="fdg-sr"> (se abre en otra pestaña, con este guión ya escrito)</span>
                      </a>
                    ) : (
                      <button type="button" className="fdg-btn is-wa is-blocked" aria-disabled="true" title={wa.motivo} aria-describedby={`${titleId}-wa`} onClick={(e) => e.preventDefault()}>
                        Enviar por WhatsApp
                      </button>
                    )}
                    <button type="button" className="fdg-btn" onClick={() => void copiar()}>
                      {copied ? <Icon name="check" size={14} /> : null}
                      {copied ? 'Copiado' : 'Copiar'}
                    </button>
                    <button ref={editBtn} type="button" className="fdg-btn" onClick={startEdit} disabled={!det}>
                      <Icon name="edit" size={14} />
                      Editar
                    </button>
                    <button
                      type="button"
                      className="fdg-btn"
                      onClick={() => void restablecer()}
                      disabled={!g.modificado || busy !== null || !det}
                      title={g.modificado ? 'Vuelve al texto original; queda como una versión nueva en el historial' : 'El guión vigente ya es el original'}
                    >
                      {busy === 'restablecer' ? 'Restableciendo…' : 'Restablecer al original'}
                    </button>
                  </div>
                  {!wa.url && (
                    <p id={`${titleId}-wa`} className="fdg-hint">
                      {wa.motivo}
                    </p>
                  )}
                </>
              ) : (
                <div className="fdg-edit">
                  <label className="fdg-lbl" htmlFor={`${titleId}-t`}>
                    Tu versión
                  </label>
                  <textarea
                    id={`${titleId}-t`}
                    ref={area}
                    className="fdg-area"
                    value={draft}
                    rows={9}
                    maxLength={GUION_MAX * 2}
                    onChange={(e) => setDraft(e.target.value)}
                    aria-describedby={`${titleId}-c`}
                    spellCheck
                    lang="es"
                  />
                  <p id={`${titleId}-c`} className={`fdg-count${largo > GUION_MAX ? ' is-over' : largo > GUION_SUGERIDO ? ' is-long' : ''}`} aria-live="polite">
                    {fmtN(largo)} / {fmtN(GUION_SUGERIDO)} caracteres
                    {largo > GUION_MAX
                      ? ` · pasa del máximo de ${fmtN(GUION_MAX)}, no se puede guardar`
                      : largo > GUION_SUGERIDO
                        ? ' · pasa de lo recomendado: un mensaje largo se lee menos'
                        : ''}
                  </p>

                  {remotaNueva && remote && (
                    <p className="fdg-banner is-warn" role="status">
                      {quien(remote.guion.por)} guardó la versión {remote.guion.version} mientras editabas. Si guardas, te lo vamos a avisar antes de pisarla.
                    </p>
                  )}

                  {conflict && (
                    <div className="fdg-conflict" role="alert">
                      <strong>
                        {quien(conflict.por)} guardó la versión {conflict.nro} ({ago(conflict.el, now)}) mientras editabas
                      </strong>
                      <div className="fdg-bubble is-theirs">{conflict.contenido}</div>
                      <div className="fdg-actions">
                        <button type="button" className="fdg-btn" onClick={() => void guardar(true)} disabled={busy !== null}>
                          {busy === 'guardar' ? 'Guardando…' : 'Guardar la mía de todas formas'}
                        </button>
                        <button type="button" className="fdg-btn" onClick={usarSuya}>
                          Usar la suya y seguir editando
                        </button>
                      </div>
                      <p className="fdg-hint">Si guardas la tuya, la de {quien(conflict.por)} no se borra: queda en el historial.</p>
                    </div>
                  )}

                  <div className="fdg-actions">
                    <button type="button" className="fdg-btn is-primary" onClick={() => void guardar()} disabled={busy !== null || !!conflict || largo > GUION_MAX || largo === 0}>
                      {busy === 'guardar' && !conflict ? 'Guardando…' : 'Guardar'}
                    </button>
                    <button type="button" className="fdg-btn" onClick={cancelEdit} disabled={busy !== null}>
                      Cancelar
                    </button>
                  </div>
                </div>
              )}

              {err && (
                <p className="err fdg-err" role="alert">
                  {err}
                </p>
              )}

              <section className="fdg-hist" aria-labelledby={`${titleId}-h`}>
                <h3 id={`${titleId}-h`} className="fdg-lbl">
                  Historial{det ? ` · ${fmtN(versiones.length)} ${versiones.length === 1 ? 'versión' : 'versiones'}` : ''}
                </h3>
                {!det && <p className="fdg-muted">Cargando el historial…</p>}
                {det && (
                  <ol className="fdg-list">
                    {versiones.map((v, i) => {
                      const abierta = openV === v.nro
                      return (
                        <li key={v.nro} className={`fdg-ver${i === 0 ? ' is-now' : ''}`}>
                          <button type="button" className="fdg-ver-head" aria-expanded={abierta} aria-controls={`${titleId}-v${v.nro}`} onClick={() => setOpenV(abierta ? null : v.nro)}>
                            <span className="fdg-ver-n">v{v.nro}</span>
                            <span className="fdg-ver-what">
                              <b>{TIPO_LABEL[v.tipo]}</b>
                              {i === 0 && <em className="fdg-now">Vigente</em>}
                            </span>
                            <span className="fdg-ver-who" title={fecha(v.editado_el)}>
                              {v.tipo === 'restablecido' ? `restablecido por ${quien(v.editado_por)}` : quien(v.editado_por)} · {ago(v.editado_el, now)}
                            </span>
                            <svg className={abierta ? 'is-up' : ''} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="m6 9 6 6 6-6" />
                            </svg>
                          </button>
                          {abierta && (
                            <div id={`${titleId}-v${v.nro}`} className="fdg-ver-body">
                              <div className="fdg-bubble is-old">{v.contenido}</div>
                              {v.base_nro !== null && v.tipo !== 'original' && v.tipo !== 'previo' && v.base_nro !== v.nro - 1 && (
                                <p className="fdg-hint">Se escribió sobre la versión {v.base_nro}, cuando ya existía una más nueva.</p>
                              )}
                            </div>
                          )}
                        </li>
                      )
                    })}
                  </ol>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
