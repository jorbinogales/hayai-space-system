import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { NavTarget } from './App'
import { api } from './api'
import { Blobvatar } from './blob'
import { FeedEntry, FeedScreen } from './Feed'
import { useFeedView } from './feedData'
import { loadHub, useLoaded, type Acuerdo, type AcuerdoEstado, type Astronauta, type HubData, type Sistema } from './hubData'
import { useLive, type Activity } from './live'
import { setInternal } from './nav'
import { fmtDate, money, todayISO } from './store'
import { ago } from './time'
import { saveGuarded, useFormGuard } from './updates'
import { DraftBar } from './UpdateUI'
import { Icon } from './ui'
import { useCosmos } from './Cosmos'
import { reduced } from './warp'
import './hub.css'

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
const monthLabel = (ym: string) => `${MONTHS[+ym.slice(5, 7) - 1] ?? ym} ${ym.slice(0, 4)}`
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)

/** Un bloque del hub: encabezado con titulo (h2), contenido y, si no hay datos, su esqueleto. */
function Block({ id, title, aside, className = '', ready, children }: { id: string; title: string; aside?: ReactNode; className?: string; ready: boolean; children: ReactNode }) {
  return (
    <section className={`hb-block ${className}`} aria-labelledby={`hb-${id}`} aria-busy={!ready}>
      <header className="hb-bh">
        <h2 id={`hb-${id}`}>{title}</h2>
        {aside}
      </header>
      {ready ? children : <div className="hb-skel" aria-hidden="true"><i /><i /><i /></div>}
    </section>
  )
}

/** Nombre del socio en negrita (el servidor siempre empieza el texto por el nombre). */
function Said({ e }: { e: Activity }) {
  const n = e.actor.nombre
  return e.texto.startsWith(n) ? (
    <>
      <b>{n}</b>
      {e.texto.slice(n.length)}
    </>
  ) : (
    <>{e.texto}</>
  )
}

// ---------- pulso ----------
function Pulse({ d }: { d: HubData }) {
  const p = d.pulso
  const t = p.tareas_internas
  return (
    <div className="hb-pulse">
      <article className="hb-stat is-dark">
        <small>Gastos generales · {monthLabel(p.mes)}</small>
        <strong>{money(p.gastos_generales_mes)}</strong>
        <span>{plural(p.gastos_generales_movimientos, 'movimiento', 'movimientos')}, sin cliente</span>
      </article>
      <article className="hb-stat">
        <small>Tareas internas</small>
        <strong>{t.pendientes}</strong>
        <span>
          por hacer{t.vencidas > 0 && <em className="late"> · {plural(t.vencidas, 'vencida', 'vencidas')}</em>} · {t.completadas_mes} {t.completadas_mes === 1 ? 'completada' : 'completadas'} este mes
        </span>
      </article>
      <article className="hb-stat">
        <small>Proyectos internos</small>
        <strong>{p.proyectos_internos.activos}</strong>
        <span>{p.proyectos_internos.activos === 1 ? 'activo' : 'activos'} de {p.proyectos_internos.total} en total</span>
      </article>
      <article className="hb-stat">
        <small>Acuerdos</small>
        <strong>{d.acuerdos.por_estado.abierto}</strong>
        <span>
          {d.acuerdos.por_estado.abierto === 1 ? 'abierto' : 'abiertos'} · {d.acuerdos.por_estado.cumplido} {d.acuerdos.por_estado.cumplido === 1 ? 'cumplido' : 'cumplidos'} hasta hoy
        </span>
      </article>
    </div>
  )
}

// ---------- astronautas ----------
function AstroEditor({ a, onDone, onSaved }: { a: Astronauta; onDone: () => void; onSaved: (n: Astronauta) => void }) {
  const [rol, setRol] = useState(a.rol ?? '')
  const [resp, setResp] = useState(a.responsabilidades ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const guard = useFormGuard({
    id: `astronauta:${a.id}`,
    label: `Astronauta · ${a.nombre}`,
    values: { rol, resp },
    initial: { rol: a.rol ?? '', resp: a.responsabilidades ?? '' },
    labels: { rol: 'rol', resp: 'responsabilidades' },
    apply: (v) => {
      setRol(v.rol)
      setResp(v.resp)
    },
  })
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const n = await api.patch<Astronauta>(`/team/${encodeURIComponent(a.nombre)}`, { rol: rol.trim() || null, responsabilidades: resp.trim() || null })
      guard.saved()
      onSaved(n)
      onDone()
    } catch (x) {
      setErr(msg(x, 'No se pudo guardar.'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="hb-edit" onSubmit={save} onKeyDown={(e) => e.key === 'Escape' && onDone()}>
      <DraftBar guard={guard} />
      <label>
        <span>Rol</span>
        <input ref={first} value={rol} maxLength={80} onChange={(e) => setRol(e.target.value)} placeholder="Ej. Marketing digital" />
      </label>
      <label>
        <span>Responsabilidades</span>
        <textarea value={resp} maxLength={600} rows={4} onChange={(e) => setResp(e.target.value)} placeholder="Qué lleva cada quien, en una o dos frases" />
      </label>
      {err && (
        <p className="hb-err" role="alert">
          {err}
        </p>
      )}
      <div className="hb-actions">
        <button type="submit" className="hb-btn is-primary" disabled={busy || !guard.changed.length}>
          {busy ? 'Guardando…' : 'Guardar'}
        </button>
        <button type="button" className="hb-btn" onClick={onDone}>
          Cancelar
        </button>
      </div>
    </form>
  )
}

function AstroCard({ a, onSaved }: { a: Astronauta; onSaved: (n: Astronauta) => void }) {
  const [edit, setEdit] = useState(false)
  const c = a.carga
  return (
    <article className="hb-astro">
      <header>
        <Blobvatar seed={a.avatar} size={44} />
        <div>
          <h3>{a.nombre}</h3>
          <p className="hb-role">{a.rol || 'Sin rol definido'}</p>
        </div>
        {!edit && (
          <button type="button" className="hb-icon" onClick={() => setEdit(true)} aria-label={`Editar rol y responsabilidades de ${a.nombre}`} title="Editar">
            <Icon name="edit" size={15} />
          </button>
        )}
      </header>
      {edit ? (
        <AstroEditor a={a} onDone={() => setEdit(false)} onSaved={onSaved} />
      ) : (
        <>
          <p className="hb-resp">{a.responsabilidades || 'Aún no se han escrito sus responsabilidades.'}</p>
          <dl className="hb-load">
            <div>
              <dt>Tareas abiertas</dt>
              <dd>{c.abiertas}</dd>
            </div>
            <div className={c.vencidas ? 'is-late' : ''}>
              <dt>Vencidas</dt>
              <dd>{c.vencidas}</dd>
            </div>
            <div>
              <dt>Completadas (7 días)</dt>
              <dd>{c.completadas_7d}</dd>
            </div>
            <div>
              <dt>De HAYAI abiertas</dt>
              <dd>{c.internas_abiertas}</dd>
            </div>
          </dl>
        </>
      )}
    </article>
  )
}

// ---------- sistemas ----------
const SLOW_MS = 2000
function sysTone(s: Sistema): 'ok' | 'slow' | 'down' | 'idle' {
  if (s.estado === 'caido') return 'down'
  if (s.estado === 'desconocido') return 'idle'
  return s.respuesta_ms != null && s.respuesta_ms >= SLOW_MS ? 'slow' : 'ok'
}
const host = (u: string | null) => (u ? u.replace(/^https?:\/\//, '').replace(/\/$/, '') : null)
const TONE_LABEL = { ok: 'En línea', slow: 'Lento', down: 'Caído', idle: 'Sin verificar' }

function SystemRow({ s, onChecked }: { s: Sistema; onChecked: (n: Sistema) => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const tone = sysTone(s)
  const url = s.enlace ?? s.url_produccion ?? s.url_verificacion
  const check = async () => {
    setBusy(true)
    setErr('')
    try {
      const r = await api.post<{ sistema: Sistema }>(`/systems/${s.id}/check`)
      onChecked(r.sistema)
    } catch (e) {
      setErr(msg(e, 'No se pudo verificar.'))
    } finally {
      setBusy(false)
    }
  }
  const detail =
    tone === 'down'
      ? `Caído${s.desde ? ` ${ago(s.desde)}` : ''}${s.error ? ` · ${s.error}` : ''}`
      : tone === 'slow'
        ? `Lento · ${(s.respuesta_ms! / 1000).toLocaleString('es-VE', { maximumFractionDigits: 1 })} s`
        : tone === 'idle'
          ? s.verificar
            ? 'Aún sin verificar'
            : 'Sin vigilancia'
          : s.respuesta_ms != null
            ? `${s.respuesta_ms} ms`
            : 'En línea'
  return (
    <li className={`hb-sys is-${tone}`}>
      <span className="hb-dot" role="img" aria-label={TONE_LABEL[tone]} />
      <div className="hb-sys-main">
        <b>{s.nombre}</b>
        <small>
          {s.cliente}
          {host(url) && <> · {host(url)}</>}
        </small>
        <small className="hb-sys-detail">{err || detail}</small>
      </div>
      <div className="hb-sys-side">
        <small>{s.ultima_verificacion ? ago(s.ultima_verificacion) : '—'}</small>
        <button type="button" className="hb-btn is-ghost" onClick={check} disabled={busy} aria-label={`Verificar ahora ${s.nombre}`}>
          {busy ? 'Verificando…' : 'Verificar'}
        </button>
      </div>
    </li>
  )
}

/** Cambia un sistema de la lista y recalcula el resumen del semáforo. */
function withSystem(s: HubData['sistemas'], n: Sistema): HubData['sistemas'] {
  const data = s.data.map((y) => (y.id === n.id ? n : y))
  const resumen = { arriba: 0, caido: 0, desconocido: 0 }
  for (const y of data) resumen[y.estado]++
  return { data, resumen }
}

// ---------- bitácora ----------
const LOG_SHORT = 7
function Logbook({ list: all }: { list: Activity[] }) {
  const [more, setMore] = useState(false)
  const list = more ? all : all.slice(0, LOG_SHORT)
  if (!all.length) return <p className="hb-empty">Aún no hay movimiento interno.</p>
  return (
    <>
    <ol className="hb-log">
      {list.map((e) => (
        <li key={e.id} className={e.tipo === 'sistema_caido' ? 'is-down' : e.tipo === 'sistema_recuperado' ? 'is-up' : ''}>
          {e.tipo === 'sistema_caido' || e.tipo === 'sistema_recuperado' ? (
            <span className="hb-log-ico" aria-hidden="true">
              {e.tipo === 'sistema_caido' ? '!' : '✓'}
            </span>
          ) : (
            <Blobvatar seed={e.actor.avatar} size={30} />
          )}
          <p>
            <Said e={e} />
          </p>
          <time dateTime={e.fecha} title={new Date(e.fecha).toLocaleString('es-VE')}>
            {ago(e.fecha)}
          </time>
        </li>
      ))}
    </ol>
      {all.length > LOG_SHORT && (
        <button type="button" className="hb-add" onClick={() => setMore((m) => !m)} aria-expanded={more}>
          {more ? 'Ver menos' : `Ver las ${all.length} últimas`}
        </button>
      )}
    </>
  )
}

// ---------- acuerdos ----------
const ESTADO_LABEL: Record<AcuerdoEstado, string> = { abierto: 'Abierto', cumplido: 'Cumplido', descartado: 'Descartado' }
const LABELS = { texto: 'Acuerdo', responsable: 'Responsable', vence: 'Vence', estado: 'Estado' }
const valuesOf = (a: Acuerdo) => ({ texto: a.texto, responsable: a.responsable?.nombre ?? null, vence: a.vence, estado: a.estado })

function AgreementForm({ a, owners, onDone, onSaved }: { a?: Acuerdo; owners: string[]; onDone: () => void; onSaved: (n: Acuerdo, old?: Acuerdo) => void }) {
  const [texto, setTexto] = useState(a?.texto ?? '')
  const [fecha, setFecha] = useState(a?.fecha_reunion ?? todayISO())
  const [owner, setOwner] = useState(a?.responsable?.nombre ?? '')
  const [vence, setVence] = useState(a?.vence ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const guard = useFormGuard({
    id: a ? `acuerdo:${a.id}` : 'acuerdo:nuevo',
    label: a ? 'Acuerdo de reunión' : 'Nuevo acuerdo',
    values: { texto, fecha, owner, vence },
    initial: { texto: a?.texto ?? '', fecha: a?.fecha_reunion ?? todayISO(), owner: a?.responsable?.nombre ?? '', vence: a?.vence ?? '' },
    labels: { texto: 'acuerdo', fecha: 'fecha de la reunión', owner: 'responsable', vence: 'vence' },
    apply: (v) => {
      setTexto(v.texto)
      setFecha(v.fecha)
      setOwner(v.owner)
      setVence(v.vence)
    },
  })
  const first = useRef<HTMLTextAreaElement>(null)
  useEffect(() => first.current?.focus(), [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!texto.trim()) return setErr('Escribe qué se acordó.')
    setBusy(true)
    setErr('')
    try {
      if (!a) {
        const n = await api.post<Acuerdo>('/agreements', { texto: texto.trim(), fecha_reunion: fecha, responsable: owner || null, vence: vence || null })
        guard.saved()
        onSaved(n)
        return onDone()
      }
      let fresh: Acuerdo | undefined
      const mine = { texto: texto.trim(), responsable: owner || null, vence: vence || null }
      const r = await saveGuarded({
        title: 'Alguien cambió este acuerdo mientras lo editabas',
        base: a.actualizado_el ?? undefined,
        save: (ifMatch) => api.patch<Acuerdo>(`/agreements/${a.id}`, { texto: mine.texto, fecha_reunion: fecha, responsable: mine.responsable, vence: mine.vence, ...(ifMatch ? { actualizado_el: ifMatch } : {}) }),
        fresh: async () => {
          fresh = (await api.get<{ data: Acuerdo[] }>('/agreements?per_page=100')).data.find((x) => x.id === a.id)
          return { stamp: fresh?.actualizado_el ?? undefined, values: fresh ? valuesOf(fresh) : {} }
        },
        mine,
        labels: LABELS,
      })
      guard.saved()
      if (r.kind === 'saved') onSaved(r.value, a)
      else if (fresh) onSaved(fresh, a)
      onDone()
    } catch (x) {
      setErr(msg(x, 'No se pudo guardar.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="hb-edit hb-agree-form" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onDone()}>
      <DraftBar guard={guard} />
      <label>
        <span>Qué se acordó</span>
        <textarea ref={first} value={texto} maxLength={1000} rows={2} onChange={(e) => setTexto(e.target.value)} placeholder="Ej. Definir el precio del plan mensual" />
      </label>
      <div className="hb-row3">
        <label>
          <span>Responsable</span>
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">Sin responsable</option>
            {owners.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Vence</span>
          <input type="date" value={vence} onChange={(e) => setVence(e.target.value)} />
        </label>
        <label>
          <span>Reunión del</span>
          <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
        </label>
      </div>
      {err && (
        <p className="hb-err" role="alert">
          {err}
        </p>
      )}
      <div className="hb-actions">
        <button type="submit" className="hb-btn is-primary" disabled={busy || !texto.trim() || (!!a && !guard.changed.length)}>
          {busy ? 'Guardando…' : a ? 'Guardar cambios' : 'Registrar acuerdo'}
        </button>
        <button type="button" className="hb-btn" onClick={onDone}>
          Cancelar
        </button>
      </div>
    </form>
  )
}

function Agreements({ initial, owners }: { initial: HubData['acuerdos']; owners: string[] }) {
  const [open, setOpen] = useState(initial.abiertos)
  const [closed, setClosed] = useState<Acuerdo[] | null>(null)
  const [counts, setCounts] = useState(initial.por_estado)
  const [tab, setTab] = useState<'abierto' | 'cerrado'>('abierto')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [closedErr, setClosedErr] = useState('')
  const today = todayISO()

  // el hub se recargo (en vivo o a mano): lo de aqui vuelve a lo ultimo que dice el servidor
  useEffect(() => {
    setOpen(initial.abiertos)
    setCounts(initial.por_estado)
    setClosed(null)
  }, [initial])

  useEffect(() => {
    if (tab !== 'cerrado' || closed) return
    let live = true
    setClosedErr('')
    api
      .get<{ data: Acuerdo[] }>('/agreements?per_page=100')
      .then((r) => live && setClosed(r.data.filter((x) => x.estado !== 'abierto')))
      .catch((e) => live && setClosedErr(msg(e, 'No se pudieron cargar los acuerdos cerrados.')))
    return () => void (live = false)
  }, [tab, closed])

  // un acuerdo cambio (de estado, texto...): se reubica en su lista y se ajustan los conteos
  const place = (n: Acuerdo, old?: Acuerdo) => {
    if (!old) setCounts((c) => ({ ...c, [n.estado]: c[n.estado] + 1 }))
    else if (old.estado !== n.estado) setCounts((c) => ({ ...c, [old.estado]: Math.max(0, c[old.estado] - 1), [n.estado]: c[n.estado] + 1 }))
    const upsert = (l: Acuerdo[]) => (l.some((x) => x.id === n.id) ? l.map((x) => (x.id === n.id ? n : x)) : [n, ...l])
    setOpen((l) => (n.estado === 'abierto' ? upsert(l) : l.filter((x) => x.id !== n.id)))
    setClosed((l) => (l === null ? null : n.estado !== 'abierto' ? upsert(l) : l.filter((x) => x.id !== n.id)))
  }

  const setEstado = async (a: Acuerdo, estado: AcuerdoEstado) => {
    setBusyId(a.id)
    setErr('')
    let fresh: Acuerdo | undefined
    try {
      const r = await saveGuarded({
        title: 'Alguien cambió este acuerdo mientras lo editabas',
        base: a.actualizado_el ?? undefined,
        save: (ifMatch) => api.patch<Acuerdo>(`/agreements/${a.id}`, { estado, ...(ifMatch ? { actualizado_el: ifMatch } : {}) }),
        fresh: async () => {
          fresh = (await api.get<{ data: Acuerdo[] }>('/agreements?per_page=100')).data.find((x) => x.id === a.id)
          return { stamp: fresh?.actualizado_el ?? undefined, values: fresh ? valuesOf(fresh) : {} }
        },
        mine: { estado },
        labels: { estado: LABELS.estado },
      })
      if (r.kind === 'saved') place(r.value, a)
      else if (fresh) place(fresh, a)
    } catch (e) {
      setErr(msg(e, 'No se pudo actualizar el acuerdo.'))
    } finally {
      setBusyId(null)
    }
  }

  const list = tab === 'abierto' ? open : (closed ?? [])
  const item = (a: Acuerdo) => {
    const late = a.estado === 'abierto' && !!a.vence && a.vence < today
    const done = a.estado !== 'abierto'
    if (editing === a.id) return <li key={a.id} className="hb-agree is-edit"><AgreementForm a={a} owners={owners} onDone={() => setEditing(null)} onSaved={place} /></li>
    return (
      <li key={a.id} className={`hb-agree${done ? ' is-done' : ''}`}>
        <div className="hb-agree-top">
          <strong className={a.estado === 'descartado' ? 'is-struck' : ''}>{a.texto}</strong>
          <span className={`hb-pill is-${a.estado}`}>{ESTADO_LABEL[a.estado]}</span>
        </div>
        <p className="hb-agree-meta">
          {a.responsable?.nombre ?? 'Sin responsable'}
          {a.vence && (
            <>
              {' · '}
              <span className={late ? 'late' : ''}>
                {late ? 'venció el' : 'para el'} {fmtDate(a.vence)}
              </span>
            </>
          )}
          {' · '}reunión del {fmtDate(a.fecha_reunion)}
          {done && a.cerrado_el && <> · {a.estado === 'cumplido' ? 'cumplido' : 'descartado'} {ago(a.cerrado_el)}</>}
        </p>
        <div className="hb-agree-act">
          {a.estado === 'abierto' ? (
            <>
              <button type="button" className="hb-btn is-ghost" disabled={busyId === a.id} onClick={() => void setEstado(a, 'cumplido')} aria-label={`Marcar como cumplido: ${a.texto}`}>
                <Icon name="check" size={14} /> Cumplido
              </button>
              <button type="button" className="hb-btn is-ghost" disabled={busyId === a.id} onClick={() => void setEstado(a, 'descartado')} aria-label={`Descartar: ${a.texto}`}>
                Descartar
              </button>
              <button type="button" className="hb-btn is-ghost" disabled={busyId === a.id} onClick={() => setEditing(a.id)} aria-label={`Editar: ${a.texto}`}>
                <Icon name="edit" size={14} /> Editar
              </button>
            </>
          ) : (
            <button type="button" className="hb-btn is-ghost" disabled={busyId === a.id} onClick={() => void setEstado(a, 'abierto')} aria-label={`Reabrir: ${a.texto}`}>
              Reabrir
            </button>
          )}
        </div>
      </li>
    )
  }

  const cerrados = counts.cumplido + counts.descartado
  return (
    <div className="hb-agreements">
      <div className="hb-tabs" role="tablist" aria-label="Estado de los acuerdos">
        <button role="tab" aria-selected={tab === 'abierto'} className={tab === 'abierto' ? 'is-on' : ''} onClick={() => setTab('abierto')}>
          Abiertos <em>{counts.abierto}</em>
        </button>
        <button role="tab" aria-selected={tab === 'cerrado'} className={tab === 'cerrado' ? 'is-on' : ''} onClick={() => setTab('cerrado')}>
          Cerrados <em>{cerrados}</em>
        </button>
      </div>
      {err && (
        <p className="hb-err" role="alert">
          {err}
        </p>
      )}
      {tab === 'cerrado' && !closed && !closedErr && <p className="hb-empty">Cargando…</p>}
      {closedErr && (
        <p className="hb-err" role="alert">
          {closedErr}
        </p>
      )}
      {list.length === 0 && (tab === 'abierto' || closed) && (
        <p className="hb-empty">{tab === 'abierto' ? 'Sin acuerdos abiertos. Anota aquí lo que quede pendiente tras la reunión.' : 'Aún no hay acuerdos cerrados.'}</p>
      )}
      {list.length > 0 && <ul className="hb-agree-list">{list.map(item)}</ul>}
      {adding ? (
        <AgreementForm owners={owners} onDone={() => setAdding(false)} onSaved={(n) => (place(n), setTab('abierto'))} />
      ) : (
        <button type="button" className="hb-add" onClick={() => setAdding(true)}>
          <Icon name="plus" size={15} /> Registrar un acuerdo
        </button>
      )}
    </div>
  )
}

// ---------- atajos internos ----------
function Shortcuts({ d, onGo }: { d: HubData; onGo: (s: NavTarget) => void }) {
  const t = d.pulso.tareas_internas
  const items: { key: NavTarget; title: string; value: string; hint: string }[] = [
    { key: 'tareas', title: 'Tareas internas', value: `${t.pendientes} ${t.pendientes === 1 ? 'abierta' : 'abiertas'}`, hint: 'Abre Tareas ya filtrada a los proyectos de HAYAI' },
    { key: 'gastos', title: 'Gastos internos', value: `${money(d.pulso.gastos_generales_mes)} este mes`, hint: 'Abre Finanzas en Gastos, ya filtrada a lo general y a proyectos sin cliente' },
    { key: 'finanzas', title: 'Finanzas internas', value: 'Gastos generales', hint: 'Abre Finanzas enfocada en los gastos generales de HAYAI' },
  ]
  return (
    <>
      <ul className="hb-shortcuts">
        {items.map((s) => (
          <li key={s.key}>
            <button type="button" onClick={() => onGo(s.key)}>
              <span className="hb-sc-title">{s.title}</span>
              <strong>{s.value}</strong>
              <span className="hb-sc-hint">{s.hint}</span>
              <span className="hb-tag">Filtro · interno</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="hb-note">Cada atajo llega con su filtro aplicado como chip; quítalo con un toque.</p>
    </>
  )
}

// ---------- pantalla ----------
export default function Hub({ onBack, onOpen }: { onBack: () => void; onOpen: (s: NavTarget) => void }) {
  const { world } = useCosmos()
  // Al entrar, la camara hace zoom hacia el nucleo HAYAI, que queda centrado y enorme como fondo vivo; el contenido flota encima y aparece al terminar el zoom.
  const [arrived, setArrived] = useState(() => world.coreReady())
  const [exiting, setExiting] = useState(false)
  useEffect(() => {
    world.screenRate = null
    const sub = (at: string) => at === 'hub' && setArrived(true)
    world.arriveSubs.add(sub)
    if (world.key !== 'hub' || world.target !== 1) world.go('hub')
    const t = window.setTimeout(() => setArrived(true), 6000) // si el mundo 3D no avanza (sin WebGL, pestaña oculta), el contenido no se queda escondido
    return () => {
      world.arriveSubs.delete(sub)
      window.clearTimeout(t)
    }
  }, [world])
  // salir: el contenido se funde y la camara hace zoom-out de regreso al Home 3D; al llegar, se muestra el Home
  const back = () => {
    if (exiting) return
    setExiting(true)
    const done = (at: string) => {
      if (at !== 'home') return
      world.arriveSubs.delete(done)
      onBack()
    }
    world.arriveSubs.add(done)
    world.go(null)
    window.setTimeout(() => world.arriveSubs.has(done) && !world.busy() && done('home'), reduced() ? 900 : 2600) // red de seguridad si la llegada ya pasó
  }
  const hub = useLoaded(loadHub, [])
  const live = useLive()
  const d = hub.data

  // llega actividad del equipo: el hub se refresca solo (sin esqueleto, con los datos viejos mientras tanto)
  const lastAct = live.activity[0]?.id
  const first = useRef(true)
  const reload = useRef(hub.reload)
  reload.current = hub.reload
  useEffect(() => {
    if (first.current) return void (first.current = false)
    const t = window.setTimeout(() => reload.current(), 700)
    return () => window.clearTimeout(t)
  }, [lastAct])

  const owners = useMemo(() => (d?.astronautas ?? []).map((a) => a.nombre), [d?.astronautas])
  const go = (s: NavTarget) => {
    setInternal(true) // el filtro interno se enciende justo antes de navegar
    onOpen(s)
  }
  const ready = !!d
  const sis = d?.sistemas
  const feedOpen = useFeedView() // #hub/feed: el feed es una vista propia; el Hub queda montado debajo (con su scroll) y se oculta

  return (
    <>
    {feedOpen && <FeedScreen owners={owners} />}
    <main className={`screen layer hub-screen is-bg arriving${arrived ? '' : ' is-waiting'}${exiting ? ' exiting' : ''}`} aria-label="Hub central" hidden={feedOpen}>
      <div className="hb-scroll">
        <div className="hb-wrap">
          <button className="hb-back" onClick={back}>
            <Icon name="back" size={16} />
            Volver al core
          </button>

          <header className="hb-head">
            <div>
              <p className="hb-eyebrow">Planeta HAYAI · Centro</p>
              <h1>Así va la empresa hoy</h1>
            </div>
            <div className="hb-head-side">
              <p>Lo interno de HAYAI en una sola pantalla. Lo de los clientes, en su planeta.</p>
              <button type="button" className="hb-btn is-dark" onClick={() => onOpen('marketing')}>
                Planeta Marketing <Icon name="arrow" size={15} />
              </button>
            </div>
          </header>

          {hub.error && (
            <div className="hb-alert" role="alert">
              <p>{ready ? 'No pudimos actualizar el hub; ves lo último que cargó.' : 'No pudimos cargar el hub.'} <small>{hub.error}</small></p>
              <button type="button" className="hb-btn is-ghost" onClick={hub.reload}>
                Reintentar
              </button>
            </div>
          )}

          {ready ? <Pulse d={d} /> : <div className="hb-pulse" aria-hidden="true">{[0, 1, 2, 3].map((i) => <article key={i} className="hb-stat is-skel"><i /><i /><i /></article>)}</div>}

          <FeedEntry seed={d?.feed} />

          <div className="hb-grid is-7-5">
            <Block id="team" title="Los astronautas" ready={ready} aside={d && <span className="hb-aside">{plural(d.astronautas.length, 'socio', 'socios')}</span>}>
              {d && d.astronautas.length ? (
                <div className="hb-team">
                  {d.astronautas.map((a) => (
                    <AstroCard key={a.id} a={a} onSaved={(n) => hub.patch((x) => ({ ...x, astronautas: x.astronautas.map((y) => (y.id === n.id ? n : y)) }))} />
                  ))}
                </div>
              ) : (
                <p className="hb-empty">No hay socios activos todavía.</p>
              )}
            </Block>

            <Block id="systems" title="Sistemas" className="is-dark" ready={ready} aside={sis && <span className="hb-aside">{sis.resumen.arriba} en línea{sis.resumen.caido > 0 ? ` · ${sis.resumen.caido} caído${sis.resumen.caido === 1 ? '' : 's'}` : ''}</span>}>
              {sis && sis.data.length ? (
                <ul className="hb-systems">
                  {sis.data.map((s) => (
                    <SystemRow key={s.id} s={s} onChecked={(n) => hub.patch((x) => ({ ...x, sistemas: withSystem(x.sistemas, n) }))} />
                  ))}
                </ul>
              ) : (
                <p className="hb-empty is-dark">Aún no hay sistemas vigilados. Se dan de alta por la API o el MCP.</p>
              )}
            </Block>
          </div>

          <div className="hb-grid is-7-5">
            <Block id="log" title="Bitácora interna" ready={ready}>
              <Logbook list={d?.bitacora ?? []} />
            </Block>
            <Block id="agreements" title="Acuerdos de reunión" ready={ready}>
              {d && <Agreements initial={d.acuerdos} owners={owners} />}
            </Block>
          </div>

          <div className="hb-grid is-5-7">
            <Block id="shortcuts" title="Atajos internos" ready={ready}>
              {d && <Shortcuts d={d} onGo={go} />}
            </Block>
            <Block id="analytics" title="Analítica web y redes" ready={ready} aside={<span className="hb-pill is-idle">{d?.analytics.disponible ? 'Conectada' : 'Sin conectar'}</span>}>
              <div className="hb-reserved">
                <p>
                  <strong>Espacio reservado.</strong> Visitas del sitio y alcance en Instagram llegarán aquí cuando se conecte una fuente.
                </p>
                <button type="button" className="hb-btn is-ghost" onClick={() => onOpen('marketing')}>
                  Ver la propuesta <Icon name="arrow" size={14} />
                </button>
              </div>
            </Block>
          </div>
        </div>
      </div>
    </main>
    </>
  )
}
