// Pestaña Contenido: tablero Idea · En producción · Publicado (arrastrar o usar los botones; en móvil las columnas se apilan en una lista).
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLoaded } from './hubData'
import { errMsg, ESTADO_CT_LABEL, ESTADOS_CT, mk, type EstadoCt, type Pieza } from './mkData'
import { astronautNames } from './projectData'
import { useSession } from './session'
import { fmtDate, todayISO } from './store'
import { pushToast } from './toast'
import { Icon } from './ui'

const diasHasta = (iso: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${todayISO()}T00:00:00Z`)) / 86_400_000)

/** «Vencida hace 2 días» · «Vence hoy» · «Vence mañana» · «Vence en 3 días» · «12 oct». */
function plazo(p: Pieza): string | null {
  if (!p.fecha_objetivo) return null
  const d = diasHasta(p.fecha_objetivo)
  if (p.semaforo === 'vencida') return d === -1 ? 'Venció ayer' : `Venció hace ${-d} días`
  if (p.semaforo === 'proxima') return d === 0 ? 'Vence hoy' : d === 1 ? 'Vence mañana' : `Vence en ${d} días`
  return fmtDate(p.fecha_objetivo)
}

// ---------- publicar: dónde y enlace ----------
function Publicar({ p, onClose, onDone }: { p: Pieza; onClose: () => void; onDone: (n: Pieza) => void }) {
  const [donde, setDonde] = useState(p.publicado_en ?? '')
  const [enlace, setEnlace] = useState(p.enlace ?? '')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => {
    first.current?.focus()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!donde.trim()) return setErr('Indica dónde se publicó (Instagram, el blog, YouTube…).')
    if (!/^https?:\/\/\S+\.\S+/i.test(enlace.trim())) return setErr('Pega el enlace de la publicación (empieza por http:// o https://).')
    setBusy(true)
    try {
      onDone(await mk.contenidoMover(p.id, { estado: 'publicado', publicado_en: donde.trim(), enlace: enlace.trim() }))
    } catch (x) {
      setBusy(false)
      setErr(errMsg(x, 'No se pudo publicar.'))
    }
  }
  return createPortal(
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="sheet" role="dialog" aria-modal="true" aria-labelledby="ct-pub-t" onSubmit={submit} noValidate>
        <header>
          <h2 id="ct-pub-t">Publicar «{p.titulo}»</h2>
          <button type="button" className="x" onClick={onClose} aria-label="Cerrar">
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="sheet-body">
          <label className="field">
            <span>¿Dónde se publicó?</span>
            <input ref={first} value={donde} maxLength={120} onChange={(e) => setDonde(e.target.value)} placeholder="Ej. Instagram" autoComplete="off" />
          </label>
          <label className="field">
            <span>Enlace</span>
            <input type="url" value={enlace} maxLength={500} onChange={(e) => setEnlace(e.target.value)} placeholder="https://" autoComplete="off" />
          </label>
        </div>
        <footer>
          <p className="err" role="alert">
            {err}
          </p>
          <button type="button" className="ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Publicando…' : 'Marcar como publicado'}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  )
}

// ---------- crear / editar ----------
function Formulario({ pieza, onDone, onSaved }: { pieza?: Pieza; onDone: () => void; onSaved: () => void }) {
  const session = useSession()
  const nombres = astronautNames()
  const kws = useLoaded(() => mk.keywords({}), [])
  const [titulo, setTitulo] = useState(pieza?.titulo ?? '')
  const [keyword, setKeyword] = useState(pieza?.keyword?.id ?? '')
  const [resp, setResp] = useState(pieza?.responsable.nombre ?? nombres.find((n) => n.toLowerCase() === session?.name.toLowerCase()) ?? nombres[0] ?? '')
  const [fecha, setFecha] = useState(pieza?.fecha_objetivo ?? '')
  const [notas, setNotas] = useState(pieza?.notas ?? '')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!titulo.trim()) return setErr('Ponle un título a la pieza.')
    setBusy(true)
    setErr('')
    try {
      if (pieza) await mk.contenidoActualizar(pieza.id, { titulo: titulo.trim(), keyword_id: keyword || null, responsable: resp, fecha_objetivo: fecha || null, notas: notas.trim() || null })
      else await mk.contenidoCrear({ titulo: titulo.trim(), keyword_id: keyword || null, responsable: resp, fecha_objetivo: fecha || null, notas: notas.trim() || null })
      pushToast({ text: pieza ? 'Pieza guardada' : 'Pieza creada', detail: pieza ? undefined : 'Quedó en la columna Idea.' })
      onSaved()
      onDone()
    } catch (x) {
      setBusy(false)
      setErr(errMsg(x, 'No se pudo guardar.'))
    }
  }
  return (
    <form className="hb-edit mk-form" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onDone()} noValidate>
      <label>
        <span>Título</span>
        <input ref={first} value={titulo} maxLength={160} onChange={(e) => setTitulo(e.target.value)} placeholder="Ej. Reel: antes y después de una panadería" autoComplete="off" />
      </label>
      <div className="mk-two">
        <label>
          <span>Keyword (opcional)</span>
          <select value={keyword} onChange={(e) => setKeyword(e.target.value)}>
            <option value="">Sin keyword</option>
            {(kws.data?.data ?? []).map((k) => (
              <option key={k.id} value={k.id}>
                {k.texto}
              </option>
            ))}
            {pieza?.keyword && !(kws.data?.data ?? []).some((k) => k.id === pieza.keyword!.id) && <option value={pieza.keyword.id}>{pieza.keyword.texto}</option>}
          </select>
        </label>
        <label>
          <span>Responsable</span>
          <select value={resp} onChange={(e) => setResp(e.target.value)}>
            {nombres.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        <span>Fecha objetivo (opcional)</span>
        <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
      </label>
      <label>
        <span>Notas (opcional)</span>
        <textarea value={notas} maxLength={4000} rows={3} onChange={(e) => setNotas(e.target.value)} />
      </label>
      {err && <p className="hb-err" role="alert">{err}</p>}
      <div className="hb-actions">
        <button type="submit" className="hb-btn is-primary" disabled={busy}>
          {busy ? 'Guardando…' : 'Guardar'}
        </button>
        <button type="button" className="hb-btn" onClick={onDone}>
          Cancelar
        </button>
      </div>
    </form>
  )
}

// ---------- tarjeta ----------
function Tarjeta({ p, onMove, onChanged, onDragStart }: { p: Pieza; onMove: (p: Pieza, e: EstadoCt) => void; onChanged: () => void; onDragStart: (id: string) => void }) {
  const [editar, setEditar] = useState(false)
  const i = ESTADOS_CT.indexOf(p.estado)
  const prev = ESTADOS_CT[i - 1]
  const next = ESTADOS_CT[i + 1]
  const t = plazo(p)

  const archivar = async () => {
    try {
      await mk.contenidoActualizar(p.id, { archivado: true })
      pushToast({ text: 'Pieza archivada' })
      onChanged()
    } catch (x) {
      pushToast({ text: 'No se pudo', detail: errMsg(x, 'Inténtalo de nuevo.'), tone: 'info' })
    }
  }
  if (editar) return <li className="mk-card"><Formulario pieza={p} onDone={() => setEditar(false)} onSaved={onChanged} /></li>
  return (
    <li className={`mk-card is-${p.estado}`} draggable onDragStart={(e) => { e.dataTransfer.setData('text/plain', p.id); e.dataTransfer.effectAllowed = 'move'; onDragStart(p.id) }}>
      <h4>{p.titulo}</h4>
      {p.keyword && <span className="mk-kwchip">{p.keyword.texto}</span>}
      <dl className="mk-card-meta">
        <div>
          <dt>Responsable</dt>
          <dd>{p.responsable.nombre}</dd>
        </div>
        {t && (
          <div className={p.semaforo ? `is-${p.semaforo}` : ''}>
            <dt>Fecha objetivo</dt>
            <dd>
              {p.semaforo && <i className="mk-dot" aria-hidden="true" />}
              {t}
            </dd>
          </div>
        )}
      </dl>
      {p.estado === 'publicado' && p.enlace && (
        <p className="mk-pub">
          {p.publicado_en && <>En {p.publicado_en} · </>}
          <a href={p.enlace} target="_blank" rel="noopener noreferrer">
            Ver publicación
            <span className="mk-sr"> (se abre en otra pestaña)</span>
          </a>
        </p>
      )}
      {p.notas && <p className="mk-notas">{p.notas}</p>}
      <div className="hb-actions">
        {prev && (
          <button type="button" className="hb-btn is-ghost" onClick={() => onMove(p, prev)}>
            ← {ESTADO_CT_LABEL[prev]}
          </button>
        )}
        {next && (
          <button type="button" className="hb-btn is-ghost" onClick={() => onMove(p, next)}>
            {next === 'publicado' ? 'Publicar →' : `${ESTADO_CT_LABEL[next]} →`}
          </button>
        )}
        <button type="button" className="hb-btn is-ghost" onClick={() => setEditar(true)}>
          Editar
        </button>
        <button type="button" className="hb-btn is-ghost" onClick={archivar}>
          Archivar
        </button>
      </div>
    </li>
  )
}

export default function Contenido({ active = true }: { active?: boolean }) {
  const lista = useLoaded(mk.contenidos, [])
  const reloaded = useRef(active)
  // al volver a la pestaña se vuelve a leer (algo pudo moverse desde Keywords o el feed)
  useEffect(() => {
    if (active && !reloaded.current) lista.reload()
    reloaded.current = active
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
  const [nueva, setNueva] = useState(false)
  const [publicando, setPublicando] = useState<Pieza | null>(null)
  const [sobre, setSobre] = useState<EstadoCt | null>(null)
  const arrastrando = useRef<string | null>(null)
  const data = lista.data?.data ?? []

  const mover = async (p: Pieza, estado: EstadoCt) => {
    if (estado === p.estado) return
    if (estado === 'publicado') return setPublicando(p) // publicar pide dónde y el enlace
    lista.patch((d) => ({ ...d, data: d.data.map((x) => (x.id === p.id ? { ...x, estado, publicado_en: null, enlace: null } : x)) }))
    try {
      await mk.contenidoMover(p.id, { estado })
    } catch (x) {
      pushToast({ text: 'No se pudo mover', detail: errMsg(x, 'Inténtalo de nuevo.'), tone: 'info' })
    }
    lista.reload()
  }

  return (
    <section className="hb-block" aria-labelledby="ct-h" aria-busy={!lista.data && !lista.error}>
      <header className="hb-bh">
        <h2 id="ct-h">Contenido</h2>
        {!nueva && (
          <button type="button" className="hb-btn is-primary" onClick={() => setNueva(true)}>
            Nueva pieza
          </button>
        )}
      </header>
      {nueva && (
        <div className="mk-card-form">
          <Formulario onDone={() => setNueva(false)} onSaved={lista.reload} />
        </div>
      )}
      {lista.error && (
        <div className="hb-alert" role="alert">
          <p>
            No pudimos cargar el tablero. <small>{lista.error}</small>
          </p>
          <button type="button" className="hb-btn is-ghost" onClick={lista.reload}>
            Reintentar
          </button>
        </div>
      )}
      {!lista.data && !lista.error ? (
        <div className="hb-skel" aria-hidden="true"><i /><i /></div>
      ) : (
        <>
          {data.length === 0 && !nueva && <p className="hb-empty">El tablero está vacío. Crea una pieza, o mueve aquí una keyword o una idea del feed.</p>}
          <div className="mk-board">
            {ESTADOS_CT.map((e) => {
              const col = data.filter((x) => x.estado === e)
              return (
                <section
                  key={e}
                  className={`mk-col${sobre === e ? ' is-over' : ''}`}
                  aria-label={`${ESTADO_CT_LABEL[e]}, ${col.length}`}
                  onDragOver={(ev) => { ev.preventDefault(); setSobre(e) }}
                  onDragLeave={() => setSobre((s) => (s === e ? null : s))}
                  onDrop={(ev) => {
                    ev.preventDefault()
                    setSobre(null)
                    const p = data.find((x) => x.id === (arrastrando.current ?? ev.dataTransfer.getData('text/plain')))
                    arrastrando.current = null
                    if (p) void mover(p, e)
                  }}
                >
                  <h3>
                    {ESTADO_CT_LABEL[e]} <em>{col.length}</em>
                  </h3>
                  {col.length === 0 ? (
                    <p className="mk-col-empty">{e === 'idea' ? 'Aquí caen las ideas nuevas.' : e === 'produccion' ? 'Lo que se está haciendo.' : 'Lo ya publicado, con su enlace.'}</p>
                  ) : (
                    <ul>
                      {col.map((p) => (
                        <Tarjeta key={p.id} p={p} onMove={(x, s) => void mover(x, s)} onChanged={lista.reload} onDragStart={(id) => (arrastrando.current = id)} />
                      ))}
                    </ul>
                  )}
                </section>
              )
            })}
          </div>
        </>
      )}
      {publicando && (
        <Publicar
          p={publicando}
          onClose={() => setPublicando(null)}
          onDone={() => {
            setPublicando(null)
            pushToast({ text: 'Publicado ✓' })
            lista.reload()
          }}
        />
      )}
    </section>
  )
}
