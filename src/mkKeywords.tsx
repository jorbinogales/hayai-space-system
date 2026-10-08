// Pestaña Keywords: explorador (autocompletado de Google), lista guardada con filtros y SERP real (Brightdata, con aviso de costo).
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLoaded } from './hubData'
import { errMsg, ESTADO_KW_LABEL, ESTADOS_KW, FUENTE_KW_LABEL, INTENCION_LABEL, INTENCIONES, mk, type EstadoKw, type Intencion, type Investigacion, type Keyword, type SerpAviso, type Serp } from './mkData'
import { fmtDate } from './store'
import { pushToast } from './toast'

const usd = (n: number) => `US$ ${n.toLocaleString('es-VE', { minimumFractionDigits: n < 0.01 ? 4 : 2, maximumFractionDigits: 4 })}`
const dia = (iso: string) => fmtDate(iso.slice(0, 10), true)

function IntencionSelect({ value, onChange, label }: { value: Intencion; onChange: (v: Intencion) => void; label: string }) {
  return (
    <select className="mk-sel" value={value} aria-label={label} onChange={(e) => onChange(e.target.value as Intencion)}>
      {INTENCIONES.map((i) => (
        <option key={i} value={i}>
          {INTENCION_LABEL[i]}
        </option>
      ))}
    </select>
  )
}

// ---------- explorador ----------
function Explorador({ onSaved }: { onSaved: () => void }) {
  const [semilla, setSemilla] = useState('')
  const [res, setRes] = useState<Investigacion | null>(null)
  const [buscando, setBuscando] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [intenciones, setIntenciones] = useState<Record<string, Intencion>>({})
  const [guardando, setGuardando] = useState(false)
  const [manual, setManual] = useState('')
  const [manualInt, setManualInt] = useState<Intencion>('informacional')
  const manualRef = useRef<HTMLInputElement>(null)

  const investigar = async (e: React.FormEvent) => {
    e.preventDefault()
    const s = semilla.trim()
    if (!s || buscando) return
    setBuscando(true)
    setErr(null)
    try {
      const r = await mk.investigar(s)
      setRes(r)
      setSel(new Set())
      setIntenciones({})
    } catch (x) {
      setRes(null)
      setErr(errMsg(x, 'El autocompletado de Google no respondió.'))
    } finally {
      setBuscando(false)
    }
  }

  const nuevas = useMemo(() => (res?.sugerencias ?? []).filter((s) => !s.guardada), [res])
  const todasMarcadas = nuevas.length > 0 && nuevas.every((s) => sel.has(s.texto))
  const toggle = (t: string) =>
    setSel((cur) => {
      const n = new Set(cur)
      if (n.has(t)) n.delete(t)
      else n.add(t)
      return n
    })

  const guardar = async () => {
    if (!res || !sel.size || guardando) return
    setGuardando(true)
    try {
      const items = res.sugerencias.filter((s) => sel.has(s.texto)).map((s) => ({ texto: s.texto, intencion: intenciones[s.texto] ?? s.intencion_sugerida, fuente: 'autocompletado' as const, semilla: res.semilla }))
      const r = await mk.guardar(items)
      const ids = new Map(r.data.map((k) => [k.texto.toLowerCase(), k.id]))
      setRes({ ...res, sugerencias: res.sugerencias.map((s) => (sel.has(s.texto) ? { ...s, guardada: true, keyword_id: ids.get(s.texto.toLowerCase()) ?? s.keyword_id } : s)) })
      setSel(new Set())
      pushToast({ text: `${r.creadas} ${r.creadas === 1 ? 'guardada' : 'guardadas'}`, detail: r.duplicadas ? `${r.duplicadas} ya estaban` : undefined })
      onSaved()
    } catch (x) {
      pushToast({ text: 'No se pudo guardar', detail: errMsg(x, 'Inténtalo de nuevo.'), tone: 'info' })
    } finally {
      setGuardando(false)
    }
  }

  const guardarManual = async (e: React.FormEvent) => {
    e.preventDefault()
    const t = manual.trim()
    if (!t) return
    try {
      const r = await mk.guardar([{ texto: t, intencion: manualInt, fuente: 'manual' }])
      setManual('')
      pushToast({ text: r.creadas ? 'Keyword guardada' : '✓ Guardada', detail: r.creadas ? undefined : 'Ya estaba en tu lista.' })
      onSaved()
    } catch (x) {
      pushToast({ text: 'No se pudo guardar', detail: errMsg(x, 'Inténtalo de nuevo.'), tone: 'info' })
    }
  }

  return (
    <section className="hb-block" aria-labelledby="kw-exp-h">
      <header className="hb-bh">
        <h2 id="kw-exp-h">Investigar una palabra</h2>
        <span className="hb-aside">Autocompletado de Google · gratis</span>
      </header>
      <form className="mk-row" onSubmit={investigar}>
        <label className="mk-grow">
          <span className="mk-sr">Palabra semilla</span>
          <input className="mk-in" value={semilla} maxLength={80} onChange={(e) => setSemilla(e.target.value)} placeholder="Palabra semilla, p. ej. sistema de citas" autoComplete="off" />
        </label>
        <button type="submit" className="hb-btn is-primary" disabled={!semilla.trim() || buscando}>
          {buscando ? 'Investigando…' : 'Investigar'}
        </button>
      </form>

      {err && (
        <div className="hb-alert" role="alert">
          <p>
            {err}
            <small>Mientras tanto, carga la palabra a mano.</small>
          </p>
          <button type="button" className="hb-btn is-ghost" onClick={() => manualRef.current?.focus()}>
            Cargar a mano
          </button>
        </div>
      )}

      {res && (
        <div className="mk-res">
          {res.sugerencias.length === 0 ? (
            <p className="hb-empty">Google no sugirió nada para «{res.semilla}». Prueba con otra palabra.</p>
          ) : (
            <>
              <div className="mk-res-h">
                <label className="mk-chk">
                  <input
                    type="checkbox"
                    checked={todasMarcadas}
                    disabled={!nuevas.length}
                    onChange={() => setSel(todasMarcadas ? new Set() : new Set(nuevas.map((s) => s.texto)))}
                  />
                  <span>{nuevas.length ? `Marcar las ${nuevas.length} nuevas` : 'Todas ya están guardadas'}</span>
                </label>
                <button type="button" className="hb-btn is-dark" disabled={!sel.size || guardando} onClick={guardar}>
                  {guardando ? 'Guardando…' : sel.size ? `Guardar ${sel.size}` : 'Guardar'}
                </button>
              </div>
              <ul className="mk-list">
                {res.sugerencias.map((s) => (
                  <li key={s.texto} className={s.guardada ? 'is-done' : ''}>
                    <label className="mk-chk">
                      <input type="checkbox" checked={sel.has(s.texto)} disabled={s.guardada} onChange={() => toggle(s.texto)} />
                      <span>{s.texto}</span>
                    </label>
                    <span className="hb-pill is-idle">{s.tipo === 'pregunta' ? 'Pregunta' : 'Sugerencia'}</span>
                    {s.guardada ? (
                      <span className="mk-ok">✓ Guardada</span>
                    ) : (
                      <IntencionSelect value={intenciones[s.texto] ?? s.intencion_sugerida} onChange={(v) => setIntenciones((c) => ({ ...c, [s.texto]: v }))} label={`Intención de «${s.texto}»`} />
                    )}
                  </li>
                ))}
              </ul>
              {res.fallidas > 0 && <p className="hb-note">{res.fallidas} de {res.consultas} consultas a Google no respondieron; puede que falten algunas sugerencias.</p>}
            </>
          )}
        </div>
      )}

      <form className="mk-row mk-manual" onSubmit={guardarManual}>
        <label className="mk-grow">
          <span className="mk-sr">Cargar una keyword a mano</span>
          <input ref={manualRef} className="mk-in" value={manual} maxLength={120} onChange={(e) => setManual(e.target.value)} placeholder="O cárgala a mano" autoComplete="off" />
        </label>
        <IntencionSelect value={manualInt} onChange={setManualInt} label="Intención de la keyword a mano" />
        <button type="submit" className="hb-btn" disabled={!manual.trim()}>
          Guardar
        </button>
      </form>
    </section>
  )
}

// ---------- SERP real ----------
function SerpTabla({ s }: { s: Serp }) {
  return (
    <>
      <p className="hb-note">
        Consultado el {dia(s.consultado_el)} por {s.consultado_por} · costo estimado {usd(s.costo_estimado_usd)}
      </p>
      <div className="mk-scroll">
        <table className="mk-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Título</th>
              <th scope="col">Dominio</th>
            </tr>
          </thead>
          <tbody>
            {s.resultados.map((r) => (
              <tr key={`${r.posicion}-${r.url}`} className={r.competidor ? 'is-comp' : ''}>
                <td className="mk-num">{r.posicion}</td>
                <td>
                  <a href={r.url} target="_blank" rel="noopener noreferrer">
                    {r.titulo}
                    <span className="mk-sr"> (se abre en otra pestaña)</span>
                  </a>
                </td>
                <td>
                  {r.dominio}
                  {r.competidor && <span className="mk-comp">Competidor: {r.competidor.nombre}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function SerpPanel({ kw, onClose, onDone }: { kw: Keyword; onClose: () => void; onDone: () => void }) {
  const aviso = useLoaded<SerpAviso>(() => mk.serpAviso(kw.id), [kw.id])
  const [serp, setSerp] = useState<Serp | null>(null)
  const [confirmando, setConfirmando] = useState<boolean | null>(null)
  const [consultando, setConsultando] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const a = aviso.data
  const actual = serp ?? a?.ultimo_serp ?? null
  // sin SERP guardado el aviso va primero; con uno guardado solo aparece si piden consultar de nuevo
  const pide = confirmando ?? !actual

  const consultar = async () => {
    setConsultando(true)
    setErr(null)
    try {
      setSerp(await mk.serp(kw.id))
      setConfirmando(false)
      onDone()
    } catch (x) {
      setErr(errMsg(x, 'No se pudo consultar el SERP. No se guardó nada.'))
    } finally {
      setConsultando(false)
    }
  }

  return (
    <div className="mk-serp" role="region" aria-label={`SERP real de ${kw.texto}`}>
      {aviso.loading && !a && <p className="hb-note">Cargando…</p>}
      {aviso.error && <p className="hb-err">{aviso.error}</p>}
      {a && !a.conectado && (
        <p className="mk-pend">
          <span className="hb-pill is-idle">Pendiente de conexión</span>
          {a.motivo ?? 'Brightdata no está conectado en el servidor.'}
        </p>
      )}
      {actual && <SerpTabla s={actual} />}
      {a?.conectado && pide && (
        <div className="mk-cost" role="alert">
          <p>
            <strong>Esta consulta consume saldo de tu cuenta de Brightdata.</strong> Costo estimado: {usd(a.costo_estimado_usd)}.
          </p>
          <div className="hb-actions">
            <button type="button" className="hb-btn is-primary" disabled={consultando} onClick={consultar}>
              {consultando ? 'Consultando…' : `Consultar (${usd(a.costo_estimado_usd)})`}
            </button>
            <button type="button" className="hb-btn" disabled={consultando} onClick={() => (actual ? setConfirmando(false) : onClose())}>
              Cancelar
            </button>
          </div>
        </div>
      )}
      {err && <p className="hb-err" role="alert">{err}</p>}
      <div className="hb-actions">
        {a?.conectado && actual && !pide && (
          <button type="button" className="hb-btn is-ghost" onClick={() => setConfirmando(true)}>
            Volver a consultar (gasta saldo)
          </button>
        )}
        <button type="button" className="hb-btn is-ghost" onClick={onClose}>
          Cerrar
        </button>
      </div>
    </div>
  )
}

// ---------- lista guardada ----------
function Fila({ k, abierto, onSerp, onChanged, onGoContenido }: { k: Keyword; abierto: boolean; onSerp: () => void; onChanged: () => void; onGoContenido: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (what: string, fn: () => Promise<string | void>) => {
    if (busy) return
    setBusy(what)
    try {
      const t = await fn()
      if (t) pushToast({ text: t })
      onChanged()
    } catch (x) {
      pushToast({ text: 'No se pudo', detail: errMsg(x, 'Inténtalo de nuevo.'), tone: 'info' })
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className={`mk-kw is-${k.estado}`}>
      <div className="mk-kw-main">
        <b>{k.texto}</b>
        <span className="hb-pill is-abierto">{INTENCION_LABEL[k.intencion]}</span>
        <select className="mk-sel" value={k.estado} aria-label={`Estado de «${k.texto}»`} disabled={!!busy} onChange={(e) => void run('estado', async () => void (await mk.kwActualizar(k.id, { estado: e.target.value as EstadoKw })))}>
          {ESTADOS_KW.map((s) => (
            <option key={s} value={s}>
              {ESTADO_KW_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      <small className="mk-kw-meta">
        {FUENTE_KW_LABEL[k.fuente]} · guardada el {dia(k.guardada_el)}
        {k.guardada_por ? ` por ${k.guardada_por}` : ''}
      </small>
      <div className="hb-actions">
        <button type="button" className="hb-btn is-ghost" aria-expanded={abierto} onClick={onSerp}>
          Ver SERP real
        </button>
        {k.idea_item_id ? (
          <span className="mk-ok">✓ Idea en el feed</span>
        ) : (
          <button type="button" className="hb-btn is-ghost" disabled={!!busy} onClick={() => void run('idea', async () => ((await mk.idea(k.id)).creada ? 'Idea creada en el feed' : '✓ Ya tenía idea'))}>
            {busy === 'idea' ? 'Creando…' : 'Crear idea de contenido'}
          </button>
        )}
        {k.contenidos > 0 ? (
          <button type="button" className="hb-btn is-ghost mk-ok" onClick={onGoContenido}>
            ✓ En contenido
          </button>
        ) : (
          <button type="button" className="hb-btn is-ghost" disabled={!!busy} onClick={() => void run('contenido', async () => ((await mk.kwContenido(k.id)).creado ? 'Pasó a Contenido (columna Idea)' : '✓ Ya está en Contenido'))}>
            {busy === 'contenido' ? 'Moviendo…' : 'Mover a contenido'}
          </button>
        )}
        {k.estado === 'descartada' ? (
          <button type="button" className="hb-btn is-ghost" disabled={!!busy} onClick={() => void run('estado', async () => void (await mk.kwActualizar(k.id, { estado: 'por_atacar' })))}>
            Restaurar
          </button>
        ) : (
          <button type="button" className="hb-btn is-ghost" disabled={!!busy} onClick={() => void run('estado', async () => void (await mk.kwActualizar(k.id, { estado: 'descartada' })))}>
            Descartar
          </button>
        )}
      </div>
    </div>
  )
}

export default function Keywords({ onGoContenido, active = true }: { onGoContenido: () => void; active?: boolean }) {
  const [q, setQ] = useState('')
  const [dq, setDq] = useState('')
  const [intencion, setIntencion] = useState('')
  const [estado, setEstado] = useState('')
  const [serpDe, setSerpDe] = useState<string | null>(null)
  useEffect(() => {
    const t = window.setTimeout(() => setDq(q.trim()), 250)
    return () => window.clearTimeout(t)
  }, [q])
  const lista = useLoaded(() => mk.keywords({ q: dq, intencion, estado }), [dq, intencion, estado])
  const reloaded = useRef(active)
  useEffect(() => {
    if (active && !reloaded.current) lista.reload()
    reloaded.current = active
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
  const filtrando = !!(dq || intencion || estado)
  const data = lista.data?.data ?? []
  const serpKw = data.find((k) => k.id === serpDe)

  return (
    <>
      <Explorador onSaved={lista.reload} />
      <section className="hb-block" aria-labelledby="kw-lista-h" aria-busy={lista.loading && !lista.data}>
        <header className="hb-bh">
          <h2 id="kw-lista-h">Mis keywords</h2>
          {lista.data && <span className="hb-aside">{lista.data.meta.total}</span>}
        </header>
        <div className="mk-row mk-filtros">
          <label className="mk-grow">
            <span className="mk-sr">Buscar keyword</span>
            <input className="mk-in" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar" autoComplete="off" />
          </label>
          <select className="mk-sel" value={intencion} aria-label="Filtrar por intención" onChange={(e) => setIntencion(e.target.value)}>
            <option value="">Toda intención</option>
            {INTENCIONES.map((i) => (
              <option key={i} value={i}>
                {INTENCION_LABEL[i]}
              </option>
            ))}
          </select>
          <select className="mk-sel" value={estado} aria-label="Filtrar por estado" onChange={(e) => setEstado(e.target.value)}>
            <option value="">Todo estado</option>
            {ESTADOS_KW.map((s) => (
              <option key={s} value={s}>
                {ESTADO_KW_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        {lista.error && (
          <div className="hb-alert" role="alert">
            <p>
              No pudimos cargar las keywords. <small>{lista.error}</small>
            </p>
            <button type="button" className="hb-btn is-ghost" onClick={lista.reload}>
              Reintentar
            </button>
          </div>
        )}
        {!lista.data && !lista.error ? (
          <div className="hb-skel" aria-hidden="true"><i /><i /></div>
        ) : data.length === 0 ? (
          <p className="hb-empty">{filtrando ? 'Ninguna keyword coincide con ese filtro.' : 'Aún no guardas keywords. Investiga una palabra arriba y marca las que sirvan.'}</p>
        ) : (
          <ul className="mk-kws">
            {data.map((k) => (
              <li key={k.id} className="mk-kw-wrap">
                <Fila k={k} abierto={serpDe === k.id} onSerp={() => setSerpDe(serpDe === k.id ? null : k.id)} onChanged={lista.reload} onGoContenido={onGoContenido} />
                {serpDe === k.id && serpKw && <SerpPanel kw={serpKw} onClose={() => setSerpDe(null)} onDone={lista.reload} />}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}
