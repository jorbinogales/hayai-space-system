// Pestaña Competidores: alta manual, «lo que sabemos» (hallazgos del espía de anuncios) y cruce con los SERP ya consultados.
import { useEffect, useRef, useState } from 'react'
import { ago } from './time'
import { useLoaded } from './hubData'
import { errMsg, mk, type Competidor, type CruceCompetidor } from './mkData'
import { fmtDate } from './store'
import { pushToast } from './toast'

const dia = (iso: string) => fmtDate(iso.slice(0, 10), true)
const urlWeb = (v: string) => (/^https?:\/\//i.test(v) ? v : `https://${v}`)
const igUrl = (v: string) => `https://www.instagram.com/${v.replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^@/, '').replace(/[/?#].*$/, '')}/`

function Formulario({ inicial, onDone, onSaved }: { inicial?: Competidor; onDone: () => void; onSaved: () => void }) {
  const [nombre, setNombre] = useState(inicial?.nombre ?? '')
  const [web, setWeb] = useState(inicial?.web ?? '')
  const [instagram, setInstagram] = useState(inicial?.instagram ?? '')
  const [notas, setNotas] = useState(inicial?.notas ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!nombre.trim()) return setErr('Escribe el nombre del competidor.')
    setBusy(true)
    setErr('')
    const b = { nombre: nombre.trim(), web: web.trim() || null, instagram: instagram.trim() || null, notas: notas.trim() || null }
    try {
      if (inicial) await mk.competidorActualizar(inicial.id, b)
      else await mk.competidorCrear(b)
      pushToast({ text: inicial ? 'Competidor guardado' : 'Competidor agregado' })
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
        <span>Nombre</span>
        <input ref={first} value={nombre} maxLength={120} onChange={(e) => setNombre(e.target.value)} placeholder="Ej. Agencia Rival" autoComplete="off" />
      </label>
      <div className="mk-two">
        <label>
          <span>Web (opcional)</span>
          <input value={web} maxLength={300} onChange={(e) => setWeb(e.target.value)} placeholder="rival.com.ve" autoComplete="off" />
        </label>
        <label>
          <span>Instagram (opcional)</span>
          <input value={instagram} maxLength={120} onChange={(e) => setInstagram(e.target.value)} placeholder="@rival" autoComplete="off" />
        </label>
      </div>
      <label>
        <span>Notas (opcional)</span>
        <textarea value={notas} maxLength={4000} rows={3} onChange={(e) => setNotas(e.target.value)} placeholder="Qué ofrecen, precios, cómo se comunican…" />
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

function Cruce({ id }: { id: string }) {
  const c = useLoaded<CruceCompetidor>(() => mk.competidorKeywords(id), [id])
  if (!c.data) return c.error ? <p className="hb-err" role="alert">{c.error}</p> : <p className="hb-note">Buscando…</p>
  const d = c.data
  if (d.sin_datos_para_cruzar) return <p className="hb-note">{d.sin_datos_para_cruzar}</p>
  if (d.serp_revisados === 0) return <p className="hb-note">Todavía no hay SERP consultados. Abre «Ver SERP real» en una keyword para empezar.</p>
  if (d.apariciones.length === 0) return <p className="hb-note">No aparece en {d.serp_revisados === 1 ? 'el SERP ya consultado' : `los ${d.serp_revisados} SERP ya consultados`}.</p>
  return (
    <>
      <p className="hb-note">Según {d.serp_revisados === 1 ? 'el SERP ya consultado' : `los ${d.serp_revisados} SERP ya consultados`} (no se consultó nada nuevo):</p>
      <ul className="mk-ap">
        {d.apariciones.map((a) => (
          <li key={`${a.keyword_id}-${a.posicion}`}>
            <b>#{a.posicion}</b>
            <span>{a.keyword}</span>
            <a href={a.url} target="_blank" rel="noopener noreferrer">
              {a.titulo}
              <span className="mk-sr"> (se abre en otra pestaña)</span>
            </a>
          </li>
        ))}
      </ul>
    </>
  )
}

function Tarjeta({ c, onChanged }: { c: Competidor; onChanged: () => void }) {
  const [editar, setEditar] = useState(false)
  const [abierto, setAbierto] = useState(false)
  const [cruce, setCruce] = useState(false)
  const det = useLoaded(() => (abierto ? mk.competidor(c.id) : Promise.resolve(c)), [abierto, c.id])
  const hallazgos = det.data?.hallazgos

  const archivar = async () => {
    try {
      await mk.competidorActualizar(c.id, { archivado: !c.archivado })
      pushToast({ text: c.archivado ? 'Competidor restaurado' : 'Competidor archivado' })
      onChanged()
    } catch (x) {
      pushToast({ text: 'No se pudo', detail: errMsg(x, 'Inténtalo de nuevo.'), tone: 'info' })
    }
  }

  if (editar) return <li className="mk-comp-card"><Formulario inicial={c} onDone={() => setEditar(false)} onSaved={onChanged} /></li>
  return (
    <li className={`mk-comp-card${c.archivado ? ' is-archivado' : ''}`}>
      <header>
        <h3>{c.nombre}</h3>
        <small>Alta el {dia(c.fecha_alta)}</small>
      </header>
      <p className="mk-links">
        {c.web && (
          <a href={urlWeb(c.web)} target="_blank" rel="noopener noreferrer">
            {c.web.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '')}
            <span className="mk-sr"> (se abre en otra pestaña)</span>
          </a>
        )}
        {c.instagram && (
          <a href={igUrl(c.instagram)} target="_blank" rel="noopener noreferrer">
            {c.instagram.startsWith('@') ? c.instagram : `@${c.instagram.replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/[/?#].*$/, '')}`}
            <span className="mk-sr"> (se abre en otra pestaña)</span>
          </a>
        )}
        {!c.web && !c.instagram && <span className="mk-dim">Sin web ni Instagram</span>}
      </p>
      {c.notas && <p className="mk-notas">{c.notas}</p>}
      <div className="hb-actions">
        <button type="button" className="hb-btn is-ghost" aria-expanded={abierto} onClick={() => setAbierto(!abierto)}>
          Lo que sabemos
        </button>
        <button type="button" className="hb-btn is-ghost" aria-expanded={cruce} onClick={() => setCruce(!cruce)}>
          Ver en qué keywords aparece
        </button>
        <button type="button" className="hb-btn is-ghost" onClick={() => setEditar(true)}>
          Editar
        </button>
        <button type="button" className="hb-btn is-ghost" onClick={archivar}>
          {c.archivado ? 'Restaurar' : 'Archivar'}
        </button>
      </div>
      {abierto && (
        <div className="mk-know">
          <h4>Lo que sabemos</h4>
          {!hallazgos ? (
            <p className="hb-note">{det.error ?? 'Buscando…'}</p>
          ) : hallazgos.length === 0 ? (
            <p className="hb-note">Todavía no hay hallazgos del espía de anuncios que mencionen a {c.nombre}. Cuando aparezca uno con su nombre, lo verás aquí.</p>
          ) : (
            <ul>
              {hallazgos.map((h) => (
                <li key={h.id}>
                  <b>{h.titulo}</b>
                  {h.resumen && <span>{h.resumen}</span>}
                  <small>
                    {h.fuente} · {ago(h.fecha)}
                  </small>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {cruce && (
        <div className="mk-know">
          <h4>En qué keywords aparece</h4>
          <Cruce id={c.id} />
        </div>
      )}
    </li>
  )
}

export default function Competidores() {
  const [nuevo, setNuevo] = useState(false)
  const [archivados, setArchivados] = useState(false)
  const lista = useLoaded(() => mk.competidores(archivados ? 'solo' : 'excluir'), [archivados])
  const data = lista.data?.data ?? []
  return (
    <section className="hb-block" aria-labelledby="cp-h" aria-busy={!lista.data && !lista.error}>
      <header className="hb-bh">
        <h2 id="cp-h">{archivados ? 'Competidores archivados' : 'Competidores'}</h2>
        <div className="hb-actions">
          <button type="button" className="hb-btn is-ghost" aria-pressed={archivados} onClick={() => setArchivados(!archivados)}>
            {archivados ? 'Ver activos' : 'Ver archivados'}
          </button>
          {!archivados && !nuevo && (
            <button type="button" className="hb-btn is-primary" onClick={() => setNuevo(true)}>
              Agregar competidor
            </button>
          )}
        </div>
      </header>
      {nuevo && !archivados && (
        <div className="mk-card-form">
          <Formulario onDone={() => setNuevo(false)} onSaved={lista.reload} />
        </div>
      )}
      {lista.error && (
        <div className="hb-alert" role="alert">
          <p>
            No pudimos cargar los competidores. <small>{lista.error}</small>
          </p>
          <button type="button" className="hb-btn is-ghost" onClick={lista.reload}>
            Reintentar
          </button>
        </div>
      )}
      {!lista.data && !lista.error ? (
        <div className="hb-skel" aria-hidden="true"><i /><i /></div>
      ) : data.length === 0 && !nuevo ? (
        <p className="hb-empty">{archivados ? 'No hay competidores archivados.' : 'Aún no registras competidores. Agrega el primero: solo el nombre es obligatorio.'}</p>
      ) : (
        <ul className="mk-comps">
          {data.map((c) => (
            <Tarjeta key={c.id} c={c} onChanged={lista.reload} />
          ))}
        </ul>
      )}
    </section>
  )
}
