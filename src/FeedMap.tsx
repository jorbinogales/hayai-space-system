// Vista de mapa del Feed: los hallazgos con dirección como pines sobre OpenStreetMap o Mapbox (Leaflet; OpenStreetMap por defecto, sin llave ni facturación).
// Los filtros y el buscador son los de la lista (los pone FeedScreen). Tocar un pin abre la MISMA tarjeta de la lista (WhatsApp, convertir,
// descartar, seguimiento…); lo que no tiene pin va a la bandeja «Sin ubicación», donde se corrige la dirección o se fija el pin a mano.
// Se carga aparte (React.lazy): Leaflet solo se descarga cuando alguien abre el mapa.
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  FEED_ESTADO_LABEL,
  ES_LEAD,
  FEED_TIPO_LABEL,
  MOTIVO_SIN_PIN,
  PIN_ESTADOS,
  PRECISION_LABEL,
  categoriaLabel,
  fijarUbicacion,
  fmtN,
  loadFeedItem,
  loadFeedMapa,
  loadTeselas,
  type FeedEstado,
  type FeedFilters,
  type FeedItem,
  type FeedMapa,
  type MapaItem,
} from './feedData'
import { pushToast } from './toast'
import { Icon } from './ui'

/** Barquisimeto: el mapa arranca aquí. */
const CENTRO: [number, number] = [10.0647, -69.357]
const ZOOM = 12
// Teselas: las dice el servidor (MAP_TILES=osm | mapbox; el token público de Mapbox nunca está en el código del front). VITE_MAP_TILES, si se
// definió en el build, manda sobre todo; sin respuesta, OpenStreetMap.
/** Los pines a menos de esto (km) de Barquisimeto encuadran el mapa; uno lejano no aleja a todos los demás. */
const RADIO_KM = 60
const POLL_MS = 4000
const POLL_MAX = 12

const PRIORIDAD: FeedEstado[] = ['nuevo', 'revisado', 'convertido', 'descartado']
const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)
const llave = (p: MapaItem) => `${p.ubicacion.lat!.toFixed(5)},${p.ubicacion.lng!.toFixed(5)}`
const km = (a: [number, number], b: [number, number]) => {
  const r = Math.PI / 180
  const h = Math.sin(((b[0] - a[0]) * r) / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(((b[1] - a[1]) * r) / 2) ** 2
  return 12742 * Math.asin(Math.sqrt(h))
}

interface Grupo {
  key: string
  lat: number
  lng: number
  items: MapaItem[]
  estado: FeedEstado
  zona: boolean
}
/** Varios hallazgos con las mismas coordenadas (un centro comercial, una urbanización) son UN pin con su cuenta: no se inventan desplazamientos. */
function agrupar(pines: MapaItem[]): Grupo[] {
  const m = new Map<string, Grupo>()
  for (const p of pines) {
    const k = llave(p)
    const g = m.get(k) ?? { key: k, lat: p.ubicacion.lat!, lng: p.ubicacion.lng!, items: [], estado: p.estado, zona: false }
    g.items.push(p)
    if (PRIORIDAD.indexOf(p.estado) < PRIORIDAD.indexOf(g.estado)) g.estado = p.estado
    if (p.ubicacion.precision === 'zona') g.zona = true
    m.set(k, g)
  }
  return [...m.values()]
}

type CardFn = (it: FeedItem, h: { onItem: (it: FeedItem) => void; onGone: (id: string) => void }) => ReactNode
interface Props {
  query: FeedFilters
  /** sube cuando la lista se refresca (algo cambió, llegó algo nuevo): el mapa vuelve a pedir sus pines sin mover la vista */
  rev: number
  card: CardFn
  onItem: (it: FeedItem) => void
  onGone: (id: string) => void
}

export default function FeedMap({ query, rev, card, onItem, onGone }: Props) {
  const [data, setData] = useState<FeedMapa | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [grupoSel, setGrupoSel] = useState<string[]>([]) // ids del pin tocado (uno o varios)
  const [active, setActive] = useState<string | null>(null)
  const [full, setFull] = useState<FeedItem | null>(null)
  const [fullErr, setFullErr] = useState('')
  const [placing, setPlacing] = useState<{ id: string; titulo: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [said, setSaid] = useState('')

  const boxRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)
  const panelRef = useRef<HTMLElement>(null)
  const seq = useRef(0)
  const fit = useRef(true)
  const polls = useRef(0)
  const placingRef = useRef(placing)
  placingRef.current = placing
  const fijarRef = useRef<(id: string, lat: number, lng: number) => Promise<void>>(async () => {})
  const queryKey = JSON.stringify(query)
  const queryRef = useRef(query)
  queryRef.current = query

  // ---- datos ----
  const load = useCallback(async () => {
    const mine = ++seq.current
    setLoading(true)
    try {
      const d = await loadFeedMapa(queryRef.current)
      if (mine !== seq.current) return
      setData(d)
      setError('')
    } catch (e) {
      if (mine === seq.current) setError(msg(e, 'No se pudo cargar el mapa.'))
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    fit.current = true // un filtro nuevo vuelve a encuadrar
    polls.current = 0
    void load()
  }, [queryKey, load])
  const firstRev = useRef(true)
  useEffect(() => {
    if (firstRev.current) return void (firstRev.current = false)
    void load()
  }, [rev, load])
  // mientras se busquen direcciones en segundo plano, el mapa se actualiza solo (unos segundos tras publicar)
  const buscando = !!data && data.sin_ubicacion.some((x) => x.ubicacion.estado === 'pendiente') && data.geocodificador
  useEffect(() => {
    if (!buscando || polls.current >= POLL_MAX) return
    const t = window.setTimeout(() => {
      polls.current++
      void load()
    }, POLL_MS)
    return () => window.clearTimeout(t)
  }, [buscando, data, load])

  // ---- el mapa (se crea una vez) ----
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const map = L.map(el, { center: CENTRO, zoom: ZOOM, zoomControl: true, attributionControl: true, minZoom: 5 })
    // la rueda mueve la página hasta que se toca el mapa (si no, el mapa se traga el scroll de toda la pantalla)
    map.scrollWheelZoom.disable()
    map.on('click focus', () => map.scrollWheelZoom.enable())
    el.addEventListener('mouseleave', () => map.scrollWheelZoom.disable())
    layerRef.current = L.layerGroup().addTo(map)
    mapRef.current = map
    map.on('click', (e: L.LeafletMouseEvent) => {
      const p = placingRef.current
      if (p) void fijarRef.current(p.id, e.latlng.lat, e.latlng.lng)
    })
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => map.invalidateSize()) : null
    ro?.observe(el)
    return () => {
      ro?.disconnect()
      map.remove()
      mapRef.current = null
      layerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- las teselas (cuando el servidor dice cuáles) ----
  useEffect(() => {
    let vivo = true
    let capa: L.TileLayer | null = null
    void loadTeselas().then((t) => {
      const map = mapRef.current
      if (!vivo || !map) return
      capa = L.tileLayer(t.url, { attribution: t.atribucion, maxZoom: t.max_zoom, tileSize: t.tamano, zoomOffset: t.zoom_offset }).addTo(map)
      capa.bringToBack()
    })
    return () => {
      vivo = false
      capa?.remove()
    }
  }, [])

  const grupos = useMemo(() => agrupar(data?.pines ?? []), [data])
  const activePin = useMemo(() => data?.pines.find((p) => p.id === active) ?? null, [data, active])
  const selKey = activePin ? llave(activePin) : null

  // ---- pines ----
  useEffect(() => {
    const layer = layerRef.current
    const map = mapRef.current
    if (!layer || !map) return
    layer.clearLayers()
    for (const g of grupos) {
      const sel = g.key === selKey
      const uno = g.items.length === 1
      const nombre = uno ? g.items[0].titulo : `${g.items.length} hallazgos aquí`
      const icon = L.divIcon({
        className: 'fdm-pin-wrap',
        html: `<span class="fdm-pin is-${g.estado}${g.zona ? ' is-zona' : ''}${sel ? ' is-sel' : ''}"><i></i>${uno ? '' : `<b>${g.items.length}</b>`}</span>`,
        iconSize: [34, 42],
        iconAnchor: [17, 37],
      })
      const m = L.marker([g.lat, g.lng], { icon, title: nombre, keyboard: true, riseOnHover: true, zIndexOffset: sel ? 1000 : 0 })
      const abrir = () => {
        if (placingRef.current) return
        pick(g.items.map((x) => x.id))
      }
      m.on('click', abrir)
      // con teclado: Enter o espacio sobre el pin enfocado (Leaflet no convierte la tecla en clic)
      m.on('keydown', (e) => {
        const k = (e as L.LeafletKeyboardEvent).originalEvent
        if (k.key === 'Enter' || k.key === ' ') {
          k.preventDefault()
          abrir()
        }
      })
      m.addTo(layer)
      const label = `${nombre}, ${g.items.length === 1 ? FEED_ESTADO_LABEL[g.estado].toLowerCase() : 'varios'}`
      m.getElement()?.setAttribute('aria-label', label)
    }
    if (fit.current && data) {
      fit.current = false
      const cerca = grupos.filter((g) => km(CENTRO, [g.lat, g.lng]) <= RADIO_KM)
      if (cerca.length) map.fitBounds(L.latLngBounds(cerca.map((g) => [g.lat, g.lng] as [number, number])), { padding: [48, 48], maxZoom: 15 })
      else map.setView(CENTRO, ZOOM)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grupos, selKey, data])

  // en pantalla ancha el panel flota sobre el mapa (a la derecha): el pin elegido se acerca al centro de lo que queda a la vista
  useEffect(() => {
    const map = mapRef.current
    if (!map || !activePin || typeof matchMedia !== 'function' || !matchMedia('(min-width: 901px)').matches) return
    const size = map.getSize()
    const libre = size.x - (Math.min(400, size.x * 0.46) + 24)
    const pt = map.latLngToContainerPoint([activePin.ubicacion.lat!, activePin.ubicacion.lng!])
    if (pt.x < 40 || pt.x > libre - 40 || pt.y < 70 || pt.y > size.y - 50) map.panBy([pt.x - libre / 2, pt.y - size.y / 2], { animate: !window.matchMedia('(prefers-reduced-motion: reduce)').matches })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // cursor de mira y Esc mientras se coloca un pin
  useEffect(() => {
    const el = boxRef.current
    el?.classList.toggle('is-placing', !!placing)
    if (!placing) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPlacing(null)
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [placing])

  // ---- selección ----
  const pick = useCallback((ids: string[]) => {
    setGrupoSel(ids)
    setActive(ids[0] ?? null)
    if (typeof matchMedia === 'function' && matchMedia('(max-width: 900px)').matches) requestAnimationFrame(() => panelRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
  }, [])
  const cerrar = () => {
    setGrupoSel([])
    setActive(null)
    setFull(null)
  }
  const loadSeq = useRef(0)
  useEffect(() => {
    if (!active) return
    const mine = ++loadSeq.current
    setFullErr('')
    if (full?.id !== active) setFull(null)
    loadFeedItem(active)
      .then((it) => mine === loadSeq.current && setFull(it))
      .catch((e: unknown) => mine === loadSeq.current && setFullErr(msg(e, 'No se pudo abrir la tarjeta.')))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const cardItem = useCallback(
    (it: FeedItem) => {
      setFull((cur) => (cur && cur.id === it.id ? it : cur))
      onItem(it)
    },
    [onItem],
  )
  const cardGone = useCallback(
    (id: string) => {
      setGrupoSel((g) => g.filter((x) => x !== id))
      setActive((a) => (a === id ? null : a))
      setFull((f) => (f?.id === id ? null : f))
      onGone(id)
      void load()
    },
    [onGone, load],
  )

  // ---- corregir ubicación ----
  const guardar = useCallback(
    async (id: string, b: { direccion?: string; lat?: number; lng?: number }) => {
      setBusy(id)
      try {
        const it = await fijarUbicacion(id, b)
        onItem(it)
        setFull((cur) => (cur && cur.id === id ? it : cur))
        await load()
        const u = it.ubicacion
        if (u.estado === 'ok') {
          setSaid(`${it.titulo}: ubicación guardada.`)
          pushToast({ text: u.origen === 'manual' ? 'Pin guardado' : 'Ubicado en el mapa', detail: u.origen === 'manual' ? it.titulo : (u.direccion ?? it.titulo), tone: 'ok', ms: 3500 })
          if (u.lat !== null && u.lng !== null) mapRef.current?.setView([u.lat, u.lng], Math.max(mapRef.current.getZoom(), 15))
        } else {
          setSaid(`${it.titulo}: ${MOTIVO_SIN_PIN[u.estado as Exclude<typeof u.estado, 'ok'>]}.`)
        }
        return it
      } catch (e) {
        pushToast({ text: 'No se pudo guardar la ubicación', detail: msg(e, 'Inténtalo de nuevo.'), tone: 'info', ms: 5000 })
        return null
      } finally {
        setBusy(null)
      }
    },
    [load, onItem],
  )
  const fijarPin = useCallback(
    async (id: string, lat: number, lng: number) => {
      setPlacing(null)
      await guardar(id, { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 })
    },
    [guardar],
  )
  fijarRef.current = fijarPin
  const empezarPin = (id: string, titulo: string) => {
    setPlacing({ id, titulo })
    requestAnimationFrame(() => boxRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
  }

  // ---- derivados ----
  const pines = data?.pines ?? []
  // Una idea o una noticia sin dirección no es un pendiente: «Sin ubicación» es para potenciales y oportunidades, o para lo que trae una dirección que no se resolvió.
  const sin = (data?.sin_ubicacion ?? []).filter((x) => !!x.ubicacion.direccion || ES_LEAD.includes(x.tipo))
  const conDireccion = sin.filter((x) => x.ubicacion.estado !== 'sin_direccion')
  const sinDireccion = sin.filter((x) => x.ubicacion.estado === 'sin_direccion')
  const cuentas = useMemo(() => {
    const c = Object.fromEntries(PIN_ESTADOS.map((e) => [e.estado, 0])) as Record<FeedEstado, number>
    for (const p of pines) c[p.estado]++
    return c
  }, [pines])
  const aprox = pines.some((p) => p.ubicacion.precision === 'zona')

  return (
    <div className="fdm" aria-busy={loading && !data}>
      <p className="fd-results" role="status" aria-live="polite">
        {!data ? 'Cargando el mapa…' : `${fmtN(pines.length)} con pin · ${fmtN(sin.length)} sin ubicación${data.truncado ? ` · se muestran los primeros ${fmtN(pines.length + sin.length)} de ${fmtN(data.total)}: afina con los filtros` : ''}`}
      </p>

      {error && (
        <div className="hb-alert fd-alert" role="alert">
          <p>
            {data ? 'No pudimos actualizar el mapa; ves lo último que cargó.' : 'No pudimos cargar el mapa.'} <small>{error}</small>
          </p>
          <button type="button" className="fd-btn is-ghost" onClick={() => void load()}>
            Reintentar
          </button>
        </div>
      )}

      <ul className="fdm-legend" aria-label="Leyenda: color del pin según el estado">
        {PIN_ESTADOS.map((e) => (
          <li key={e.estado}>
            <span className={`fdm-dot is-${e.estado}`} aria-hidden="true" />
            {e.label} <em>{fmtN(cuentas[e.estado])}</em>
          </li>
        ))}
        {aprox && (
          <li>
            <span className="fdm-dot is-zona" aria-hidden="true" />
            Aproximado (sector)
          </li>
        )}
      </ul>

      {placing && (
        <p className="fd-note fdm-placing" role="status">
          <Icon name="pin" size={15} /> Toca el mapa donde queda <strong>{placing.titulo}</strong>.
          <button type="button" className="fd-btn is-ghost" onClick={() => setPlacing(null)}>
            Cancelar
          </button>
        </p>
      )}

      <div className="fdm-stage">
        <div className="fdm-mapbox">
          <div ref={boxRef} className="fdm-map" role="region" aria-label="Mapa de hallazgos. Los pines se pueden recorrer con el teclado." />
          {loading && data && <span className="fdm-spin fd-spin" aria-hidden="true" />}
          {data && pines.length === 0 && !loading && (
            <p className="fdm-nopins">{sin.length ? 'Nada con pin con estos filtros. Mira «Sin ubicación» más abajo.' : 'Nada que mostrar con estos filtros.'}</p>
          )}
        </div>

        <aside className={`fdm-panel${active ? '' : ' is-empty'}`} ref={panelRef} aria-label="Detalle del pin elegido">
          {!active ? (
            <div className="fdm-hint">
              <h3>Toca un pin</h3>
              <p>Aquí aparece el hallazgo con sus acciones: escribirle por WhatsApp, convertirlo, descartarlo o agendar el seguimiento.</p>
            </div>
          ) : (
            <div className="fdm-sel">
              <div className="fdm-sel-head">
                <p>{grupoSel.length > 1 ? `${grupoSel.length} hallazgos en este punto` : 'Hallazgo en el mapa'}</p>
                <button type="button" className="fd-btn is-ghost" onClick={cerrar} aria-label="Cerrar el detalle">
                  <Icon name="close" size={14} /> Cerrar
                </button>
              </div>
              {grupoSel.length > 1 && (
                <ul className="fdm-group">
                  {grupoSel.map((id) => {
                    const p = pines.find((x) => x.id === id)
                    return (
                      <li key={id}>
                        <button type="button" className={`fd-chip${id === active ? ' is-on' : ''}`} aria-pressed={id === active} onClick={() => setActive(id)}>
                          <span className={`fdm-dot is-${p?.estado ?? 'nuevo'}`} aria-hidden="true" />
                          {p?.titulo ?? 'Hallazgo'}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
              {fullErr && (
                <p className="hb-err" role="alert">
                  {fullErr}
                </p>
              )}
              {!full && !fullErr && <p className="fd-loading">Abriendo…</p>}
              {full && (
                <>
                  <UbicacionBar it={full} busy={busy === full.id} onMove={() => empezarPin(full.id, full.titulo)} onSave={(direccion) => guardar(full.id, { direccion })} />
                  <ul className="fd-list fdm-card">{card(full, { onItem: cardItem, onGone: cardGone })}</ul>
                </>
              )}
            </div>
          )}
        </aside>
      </div>

      {data && (sin.length > 0 || buscando) && (
        <section className="fdm-tray" aria-labelledby="fdm-tray-h">
          <h3 id="fdm-tray-h">
            Sin ubicación <em>{fmtN(sin.length)}</em>
          </h3>
          <p className="fdm-tray-sub">
            Estos no tienen pin: corrige la dirección para que se busque de nuevo, o toca «Fijar pin» y marca el punto en el mapa.
            {buscando && ' Hay direcciones en búsqueda; esto se actualiza solo.'}
            {!data.geocodificador && ' La búsqueda automática está apagada en este servidor: solo se pueden fijar a mano.'}
          </p>
          {conDireccion.length > 0 && (
            <ul className="fdm-rows">
              {conDireccion.map((x) => (
                <TrayRow key={x.id} x={x} busy={busy === x.id} onOpen={() => pick([x.id])} onPin={() => empezarPin(x.id, x.titulo)} onSave={(d) => guardar(x.id, { direccion: d })} />
              ))}
            </ul>
          )}
          {sinDireccion.length > 0 && (
            <details className="fdm-nodir" open={conDireccion.length === 0 && sinDireccion.length <= 8}>
              <summary>
                No traen dirección <em>{fmtN(sinDireccion.length)}</em>
              </summary>
              <ul className="fdm-rows">
                {sinDireccion.map((x) => (
                  <TrayRow key={x.id} x={x} busy={busy === x.id} onOpen={() => pick([x.id])} onPin={() => empezarPin(x.id, x.titulo)} onSave={(d) => guardar(x.id, { direccion: d })} />
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
      <p className="fd-sr" role="status">
        {said}
      </p>
    </div>
  )
}

// ---------- dirección y pin de un hallazgo (en el panel) ----------
function DireccionForm({ inicial, busy, onSave, onCancel, id }: { inicial: string; busy: boolean; onSave: (d: string) => Promise<unknown>; onCancel: () => void; id: string }) {
  const [v, setV] = useState(inicial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.focus(), [])
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!v.trim() || busy) return
    await onSave(v.trim())
  }
  return (
    <form className="fdm-addr" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <label htmlFor={id} className="fd-sr">
        Dirección corregida
      </label>
      <input id={id} ref={ref} value={v} maxLength={300} placeholder="Calle, sector y ciudad" autoComplete="off" onChange={(e) => setV(e.target.value)} />
      <button type="submit" className="fd-btn is-primary fd-sm" disabled={busy || !v.trim()}>
        {busy ? 'Buscando…' : 'Buscar y guardar'}
      </button>
      <button type="button" className="fd-btn is-ghost" onClick={onCancel}>
        Cancelar
      </button>
    </form>
  )
}

function UbicacionBar({ it, busy, onMove, onSave }: { it: FeedItem; busy: boolean; onMove: () => void; onSave: (d: string) => Promise<unknown> }) {
  const [edit, setEdit] = useState(false)
  const u = it.ubicacion
  return (
    <div className="fdm-ubic">
      <p className="fdm-ubic-line">
        <Icon name="pin" size={15} />
        <span>
          {u.direccion ?? 'Sin dirección'}
          {u.estado === 'ok' && u.precision && <small>{u.origen === 'manual' ? 'Pin fijado a mano' : PRECISION_LABEL[u.precision]}</small>}
          {u.estado !== 'ok' && <small>{MOTIVO_SIN_PIN[u.estado]}</small>}
        </span>
      </p>
      {edit ? (
        <DireccionForm
          id={`fdm-dir-${it.id}`}
          inicial={u.direccion ?? ''}
          busy={busy}
          onCancel={() => setEdit(false)}
          onSave={async (d) => {
            const r = await onSave(d)
            if (r) setEdit(false)
          }}
        />
      ) : (
        <div className="fdm-ubic-actions">
          <button type="button" className="fd-btn fd-sm" onClick={onMove}>
            {u.estado === 'ok' ? 'Mover pin' : 'Fijar pin'}
          </button>
          <button type="button" className="fd-btn fd-sm" onClick={() => setEdit(true)}>
            Corregir dirección
          </button>
        </div>
      )}
    </div>
  )
}

// ---------- una fila de la bandeja «Sin ubicación» ----------
function TrayRow({ x, busy, onOpen, onPin, onSave }: { x: MapaItem; busy: boolean; onOpen: () => void; onPin: () => void; onSave: (d: string) => Promise<unknown> }) {
  const [edit, setEdit] = useState(false)
  const u = x.ubicacion
  const motivo = MOTIVO_SIN_PIN[u.estado as Exclude<typeof u.estado, 'ok'>]
  return (
    <li className="fdm-row">
      <div className="fdm-row-main">
        <button type="button" className="fd-link fdm-row-title" onClick={onOpen}>
          {x.titulo}
        </button>
        <p className="fdm-row-meta">
          <span className={`fdm-dot is-${x.estado}`} aria-hidden="true" />
          {FEED_ESTADO_LABEL[x.estado]} · {FEED_TIPO_LABEL[x.tipo]}
          {x.categoria ? ` · ${categoriaLabel(x.categoria)}` : ''}
        </p>
        <p className="fdm-row-addr">
          {u.direccion ? <>«{u.direccion}»</> : null} <span className={`fdm-why is-${u.estado}`}>{motivo}</span>
        </p>
      </div>
      {edit ? (
        <DireccionForm
          id={`fdm-dir-${x.id}`}
          inicial={u.direccion ?? ''}
          busy={busy}
          onCancel={() => setEdit(false)}
          onSave={async (d) => {
            const r = await onSave(d)
            if (r) setEdit(false)
          }}
        />
      ) : (
        <div className="fdm-row-actions">
          <button type="button" className="fd-btn fd-sm" onClick={onPin} aria-label={`Fijar pin de ${x.titulo}`}>
            Fijar pin
          </button>
          <button type="button" className="fd-btn fd-sm" onClick={() => setEdit(true)} aria-label={`Corregir la dirección de ${x.titulo}`}>
            Corregir dirección
          </button>
          {u.direccion && u.estado !== 'pendiente' && (
            <button type="button" className="fd-btn fd-sm" disabled={busy} onClick={() => void onSave(u.direccion!)} aria-label={`Buscar otra vez ${x.titulo}`}>
              {busy ? 'Buscando…' : 'Buscar otra vez'}
            </button>
          )}
        </div>
      )}
    </li>
  )
}
