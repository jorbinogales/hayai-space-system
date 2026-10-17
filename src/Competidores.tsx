// «Competidores» dentro del Feed (v1.8.2): el radar comercial de HAYAI. Un bloque fijo con las 3 oportunidades contra ellos y, debajo, una ficha por
// competidor (qué vende, precio, mensaje, a quién le habla, fortaleza y debilidad frente a HAYAI) con buscador, filtro por grupo y alta/edición/borrado.
// Se monta dentro de FeedScreen (hereda sus tokens --fd-*): el Feed queda montado y oculto debajo, así que sus filtros y su posición no se pierden.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './competidores.css'
import {
  GRUPO_LABEL,
  GRUPOS,
  borrarCompetidor,
  cargarRadar,
  crearCompetidor,
  editarCompetidor,
  errorDe,
  urlWeb,
  webCorta,
  type Competidor,
  type CompetidorForm,
  type Grupo,
  type Oportunidad,
} from './competidoresData'
import { pushToast } from './toast'
import { Icon } from './ui'

const sinTildes = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`
const escape = (fn: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === 'Escape') {
    e.stopPropagation()
    fn()
  }
}

// ---------- formulario (alta y edición) ----------
const VACIO: CompetidorForm = { nombre: '', grupo: 'saas_venezolano', web: '', que_vende: '', precio: '', mensaje: '', a_quien: '', fortaleza: '', debilidad: '', notas: '' }
const desde = (c: Competidor): CompetidorForm => ({ nombre: c.nombre, grupo: c.grupo, web: c.web ?? '', que_vende: c.que_vende ?? '', precio: c.precio ?? '', mensaje: c.mensaje ?? '', a_quien: c.a_quien ?? '', fortaleza: c.fortaleza ?? '', debilidad: c.debilidad ?? '', notas: c.notas ?? '' })

function Formulario({ inicial, onCancel, onSaved }: { inicial?: Competidor; onCancel: () => void; onSaved: (c: Competidor) => void }) {
  const uid = useRef(`rd-f-${Math.random().toString(36).slice(2, 8)}`).current
  const [v, setV] = useState<CompetidorForm>(inicial ? desde(inicial) : VACIO)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])
  const set = (k: keyof CompetidorForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setV((c) => ({ ...c, [k]: e.target.value }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (!v.nombre.trim()) return setErr('Escribe el nombre del competidor.')
    setBusy(true)
    setErr('')
    try {
      const body = { ...v, nombre: v.nombre.trim() }
      const c = inicial ? await editarCompetidor(inicial.id, body) : await crearCompetidor(body)
      pushToast({ text: inicial ? 'Competidor guardado' : 'Competidor agregado', detail: c.nombre })
      onSaved(c)
    } catch (x) {
      setBusy(false)
      setErr(errorDe(x, 'No se pudo guardar. Revisa tu conexión e inténtalo de nuevo.'))
    }
  }
  const campo = (k: keyof CompetidorForm, label: string, ph: string, max: number, ancho?: 'largo') =>
    ancho ? (
      <label className="rd-wide" htmlFor={`${uid}-${k}`}>
        <span>{label}</span>
        <textarea id={`${uid}-${k}`} value={v[k]} maxLength={max} rows={2} placeholder={ph} onChange={set(k)} />
      </label>
    ) : (
      <label htmlFor={`${uid}-${k}`}>
        <span>{label}</span>
        <input id={`${uid}-${k}`} value={v[k]} maxLength={max} placeholder={ph} autoComplete="off" onChange={set(k)} />
      </label>
    )
  return (
    <form className="fd-form rd-form" onSubmit={submit} onKeyDown={escape(onCancel)} noValidate aria-label={inicial ? `Editar a ${inicial.nombre}` : 'Agregar competidor'}>
      <div className="fd-two">
        <label htmlFor={`${uid}-nombre`}>
          <span>Nombre</span>
          <input id={`${uid}-nombre`} ref={first} value={v.nombre} maxLength={120} placeholder="Ej. Clarito" autoComplete="off" aria-required="true" aria-invalid={!!err && !v.nombre.trim()} onChange={set('nombre')} />
        </label>
        <label htmlFor={`${uid}-grupo`}>
          <span>Grupo</span>
          <select id={`${uid}-grupo`} value={v.grupo} onChange={set('grupo')}>
            {GRUPOS.map((g) => (
              <option key={g} value={g}>
                {GRUPO_LABEL[g]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="fd-two">
        {campo('web', 'Web (opcional)', 'clarito.app', 300)}
        {campo('precio', 'Precio (opcional)', '$10/mes · 7 días gratis', 300)}
      </div>
      {campo('que_vende', 'Qué vende', 'SaaS de inventario, ventas y caja', 400, 'largo')}
      {campo('mensaje', 'Mensaje principal', 'Lo que dice en su web o sus anuncios', 400, 'largo')}
      {campo('a_quien', 'A quién le habla', 'Abastos, bodegas, restaurantes pequeños', 300, 'largo')}
      <div className="fd-two">
        {campo('fortaleza', 'Su fortaleza frente a HAYAI', 'Dónde nos gana', 400, 'largo')}
        {campo('debilidad', 'Su debilidad frente a HAYAI', 'Dónde le ganamos', 400, 'largo')}
      </div>
      {campo('notas', 'Notas (opcional)', 'De dónde salió el dato, qué vigilar…', 4000, 'largo')}
      {err && (
        <p className="hb-err" role="alert">
          {err}
        </p>
      )}
      <div className="fd-actions">
        <button type="submit" className="fd-btn is-primary" disabled={busy}>
          {busy ? 'Guardando…' : inicial ? 'Guardar cambios' : 'Agregar competidor'}
        </button>
        <button type="button" className="fd-btn" onClick={onCancel} disabled={busy}>
          Cancelar
        </button>
      </div>
    </form>
  )
}

// ---------- una ficha ----------
function Dato({ k, v }: { k: string; v: string | null }) {
  return (
    <div className="rd-fact">
      <dt>{k}</dt>
      <dd className={v ? undefined : 'is-none'}>{v ?? 'Sin dato'}</dd>
    </div>
  )
}

function Ficha({ c, onChanged, onGone }: { c: Competidor; onChanged: (c: Competidor) => void; onGone: (id: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const editBtn = useRef<HTMLButtonElement>(null)
  const delBtn = useRef<HTMLButtonElement>(null)
  const yes = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (asking) yes.current?.focus()
  }, [asking])
  const href = urlWeb(c.web)

  const borrar = async () => {
    setBusy(true)
    setErr('')
    try {
      await borrarCompetidor(c.id)
      pushToast({ text: 'Competidor eliminado', detail: c.nombre })
      onGone(c.id)
    } catch (x) {
      setBusy(false)
      setErr(errorDe(x, 'No se pudo eliminar. Inténtalo de nuevo.'))
    }
  }

  if (editing)
    return (
      <li id={`rd-${c.id}`} className="fd-card rd-card is-editing">
        <Formulario
          inicial={c}
          onCancel={() => {
            setEditing(false)
            requestAnimationFrame(() => editBtn.current?.focus())
          }}
          onSaved={(n) => {
            onChanged(n)
            setEditing(false)
          }}
        />
      </li>
    )
  return (
    <li id={`rd-${c.id}`} className="fd-card rd-card">
      <article aria-labelledby={`rd-t-${c.id}`}>
        <header className="rd-head">
          <div className="rd-name">
            <h3 id={`rd-t-${c.id}`} className="fd-title">
              {c.nombre}
            </h3>
            {href && c.web ? (
              <a className="rd-web" href={href} target="_blank" rel="noopener noreferrer">
                {webCorta(c.web)}
                <span className="fd-sr"> (se abre en otra pestaña)</span>
              </a>
            ) : (
              <span className="rd-web is-none">{c.web ? webCorta(c.web) : 'Sin web registrada'}</span>
            )}
          </div>
          <span className={`fd-cat rd-grupo g-${c.grupo}`}>{GRUPO_LABEL[c.grupo]}</span>
        </header>

        <dl className="rd-facts">
          <Dato k="Qué vende" v={c.que_vende} />
          <Dato k="Precio" v={c.precio} />
          <Dato k="Mensaje principal" v={c.mensaje} />
          <Dato k="A quién le habla" v={c.a_quien} />
        </dl>

        <div className="rd-vs">
          <section className="rd-edge" aria-label={`Fortaleza de ${c.nombre} frente a HAYAI`}>
            <h4>Su fortaleza</h4>
            <p className={c.fortaleza ? undefined : 'is-none'}>{c.fortaleza ?? 'Sin dato'}</p>
          </section>
          <section className="rd-gap" aria-label={`Debilidad de ${c.nombre} frente a HAYAI`}>
            <h4>
              Su debilidad <small>· nuestra puerta</small>
            </h4>
            <p className={c.debilidad ? undefined : 'is-none'}>{c.debilidad ?? 'Sin dato'}</p>
          </section>
        </div>

        {c.notas && <p className="rd-notes">{c.notas}</p>}

        {asking ? (
          <div className="rd-confirm" role="group" aria-label={`Confirmar: eliminar a ${c.nombre}`} onKeyDown={escape(() => !busy && (setAsking(false), delBtn.current?.focus()))}>
            <p>
              ¿Eliminar a <strong>{c.nombre}</strong>? No se puede deshacer.
            </p>
            <div className="fd-actions">
              <button type="button" ref={yes} className="fd-btn is-danger" disabled={busy} onClick={() => void borrar()}>
                {busy ? 'Eliminando…' : 'Sí, eliminar'}
              </button>
              <button
                type="button"
                className="fd-btn"
                disabled={busy}
                onClick={() => {
                  setAsking(false)
                  requestAnimationFrame(() => delBtn.current?.focus())
                }}
              >
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <div className="rd-act">
            <button type="button" ref={editBtn} className="fd-btn is-ghost" onClick={() => setEditing(true)} aria-label={`Editar a ${c.nombre}`}>
              <Icon name="edit" size={14} /> Editar
            </button>
            <button type="button" ref={delBtn} className="fd-btn is-ghost" onClick={() => setAsking(true)} aria-label={`Eliminar a ${c.nombre}`}>
              <Icon name="trash" size={14} /> Eliminar
            </button>
          </div>
        )}
        {err && (
          <p className="hb-err" role="alert">
            {err}
          </p>
        )}
      </article>
    </li>
  )
}

// ---------- las oportunidades (bloque fijo) ----------
function Oportunidades({ ops }: { ops: Oportunidad[] }) {
  if (!ops.length) return null
  return (
    <section className="rd-ops" aria-labelledby="rd-ops-h">
      <h2 id="rd-ops-h">
        <span>Dónde HAYAI les gana</span> Tres oportunidades
      </h2>
      <ol>
        {ops.map((o, i) => (
          <li key={o.titulo}>
            <span className="rd-n" aria-hidden="true">
              {i + 1}
            </span>
            <h3>{o.titulo}</h3>
            <p>{o.texto}</p>
          </li>
        ))}
      </ol>
    </section>
  )
}

// ---------- la vista ----------
export default function Competidores({ onClose }: { onClose: () => void }) {
  const [lista, setLista] = useState<Competidor[] | null>(null)
  const [ops, setOps] = useState<Oportunidad[]>([])
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [grupo, setGrupo] = useState<Grupo | ''>('')
  const [adding, setAdding] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const addBtn = useRef<HTMLButtonElement>(null)

  const cargar = useCallback(() => {
    setError('')
    cargarRadar()
      .then((r) => {
        setLista(r.data)
        setOps(r.oportunidades)
      })
      .catch((e: unknown) => setError(errorDe(e, 'No se pudo cargar el radar.')))
  }, [])
  useEffect(() => {
    cargar()
    heading.current?.focus({ preventScroll: true })
  }, [cargar])

  const visibles = useMemo(() => {
    const n = sinTildes(q.trim())
    return (lista ?? []).filter((c) => (!grupo || c.grupo === grupo) && (!n || sinTildes(c.nombre).includes(n)))
  }, [lista, q, grupo])
  const porGrupo = useMemo(() => {
    const m = Object.fromEntries(GRUPOS.map((g) => [g, 0])) as Record<Grupo, number>
    for (const c of lista ?? []) m[c.grupo]++
    return m
  }, [lista])
  const total = lista?.length ?? 0
  const filtrando = !!grupo || !!q.trim()
  const limpiar = () => (setQ(''), setGrupo(''))

  return (
    <div className="rd-view" onKeyDown={(e) => e.key === 'Escape' && !adding && onClose()}>
      <header className="hb-head fd-phead rd-phead">
        <div>
          <p className="hb-eyebrow">Planeta HAYAI · Feed · Competidores</p>
          <h1 ref={heading} tabIndex={-1}>
            Radar de competidores
          </h1>
          <p className="fd-lede">A quién le compite HAYAI, qué dice cada uno y por dónde se les entra. La lista es viva: agrega, corrige o elimina a medida que aprendas.</p>
        </div>
        <div className="fd-head-side">
          <button type="button" className="fd-btn" onClick={onClose}>
            <Icon name="back" size={14} /> Volver al Feed
          </button>
          <button type="button" ref={addBtn} className="fd-btn is-dark" aria-expanded={adding} aria-controls="rd-nuevo" onClick={() => setAdding((a) => !a)}>
            <Icon name="plus" size={14} /> Agregar competidor
          </button>
        </div>
      </header>

      <Oportunidades ops={ops} />

      <section className="hb-block fd-block rd-block" aria-label="Competidores" aria-busy={lista === null && !error}>
        <h2 className="fd-sr">Fichas de competidores</h2>
        {adding && (
          <div id="rd-nuevo" className="fd-card rd-card is-editing rd-new">
            <Formulario
              onCancel={() => {
                setAdding(false)
                requestAnimationFrame(() => addBtn.current?.focus())
              }}
              onSaved={(c) => {
                setLista((l) => [...(l ?? []), c])
                setAdding(false)
                limpiar()
                requestAnimationFrame(() => document.getElementById(`rd-${c.id}`)?.scrollIntoView({ block: 'center' }))
              }}
            />
          </div>
        )}

        {lista !== null && total > 0 && (
          <div className="fd-filters rd-filters" role="group" aria-label="Filtros de competidores">
            <label className="fd-field fd-search">
              <span className="fd-sr">Buscar por nombre</span>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-3.5-3.5" />
              </svg>
              <input type="search" value={q} maxLength={120} placeholder="Buscar por nombre" onChange={(e) => setQ(e.target.value)} />
            </label>
            <div className="fd-chips" role="group" aria-label="Grupo">
              <button type="button" className={`fd-chip${grupo === '' ? ' is-on' : ''}`} aria-pressed={grupo === ''} onClick={() => setGrupo('')}>
                Todos <em>{total}</em>
              </button>
              {GRUPOS.map((g) => (
                <button key={g} type="button" className={`fd-chip${grupo === g ? ' is-on' : ''}`} aria-pressed={grupo === g} onClick={() => setGrupo((c) => (c === g ? '' : g))}>
                  {GRUPO_LABEL[g]} <em className={porGrupo[g] === 0 ? 'is-zero' : ''}>{porGrupo[g]}</em>
                </button>
              ))}
            </div>
          </div>
        )}

        {lista !== null && total > 0 && (
          <p className="fd-results" role="status" aria-live="polite">
            {filtrando ? `${visibles.length} de ${plural(total, 'competidor', 'competidores')}` : plural(total, 'competidor', 'competidores')}
          </p>
        )}

        {error && (
          <div className="hb-alert fd-alert" role="alert">
            <p>
              {lista ? 'No pudimos actualizar el radar.' : 'No pudimos cargar el radar.'} <small>{error}</small>
            </p>
            <button type="button" className="fd-btn is-ghost" onClick={cargar}>
              Reintentar
            </button>
          </div>
        )}

        {lista === null && !error && (
          <ul className="rd-list" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <li key={i} className="fd-card rd-card rd-skel">
                <i />
                <i />
                <i />
              </li>
            ))}
          </ul>
        )}

        {lista !== null && total === 0 && !adding && (
          <div className="fd-empty is-initial">
            <h3>Aún no hay competidores</h3>
            <p>Agrega el primero para empezar a compararlo con HAYAI.</p>
            <button type="button" className="fd-btn is-primary" onClick={() => setAdding(true)}>
              <Icon name="plus" size={14} /> Agregar competidor
            </button>
          </div>
        )}

        {lista !== null && total > 0 && visibles.length === 0 && (
          <div className="fd-empty">
            <h3>Nada coincide</h3>
            <p>Ningún competidor responde a esa búsqueda{grupo ? ` en ${GRUPO_LABEL[grupo]}` : ''}.</p>
            <button type="button" className="fd-btn is-primary" onClick={limpiar}>
              Quitar filtros
            </button>
          </div>
        )}

        {visibles.length > 0 && (
          <ul className="rd-list">
            {visibles.map((c) => (
              <Ficha
                key={c.id}
                c={c}
                onChanged={(n) => setLista((l) => (l ?? []).map((x) => (x.id === n.id ? n : x)))}
                onGone={(id) => {
                  setLista((l) => (l ?? []).filter((x) => x.id !== id))
                  requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }))
                }}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
