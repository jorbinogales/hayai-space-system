// Pestaña Panel de la Central de marketing: embudo, de dónde llegan los leads, Meta Ads y las fuentes de analítica.
import { useMemo, type ReactNode } from 'react'
import { loadFunnel, loadStages, useLoaded, type Funnel, type PipelineStage } from './hubData'
import { mk, type Campanas } from './mkData'
import { money } from './store'

export const RANGES = [
  { dias: 30, label: '30 días' },
  { dias: 90, label: '90 días' },
  { dias: 180, label: '180 días' },
  { dias: 365, label: '1 año' },
]

const ORIGENES: Record<string, string> = {
  meta_ads: 'Meta Ads',
  referido: 'Referido',
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  facebook: 'Facebook',
  web: 'Web',
  visita_frio: 'Visita en frío',
  evento: 'Evento',
  otro: 'Otro',
  sin_origen: 'Sin origen (histórico)',
}
const origen = (k: string) => ORIGENES[k] ?? k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const sum = (l: number[]) => l.reduce((a, b) => a + b, 0)
const pct = (n: number) => `${n.toLocaleString('es-VE', { maximumFractionDigits: 1 })} %`

/** Una ayuda de una línea: se abre con el foco o al pasar el cursor, y también queda en `title`. */
function Tip({ children }: { children: string }) {
  return (
    <span className="mk-tip" tabIndex={0} role="note" aria-label={children} title={children}>
      <i aria-hidden="true">?</i>
      <span className="mk-tip-t" aria-hidden="true">{children}</span>
    </span>
  )
}

interface Step {
  key: string
  name: string
  n: number
  /** qué significa en etapas reales del pipeline (con los nombres que devuelve la API) */
  eq: string
}

/**
 * Embudo simplificado (Alcance → Contacto → Visita → Propuesta → Cierre) sobre las etapas REALES de la API.
 * Los nombres de etapa nunca van escritos aquí: salen de /marketing/funnel y /pipeline/stages.
 */
function buildSteps(f: Funnel, stages: PipelineStage[] | null): { steps: Step[]; ganado: string; perdido: string; perdidoEq: string } {
  const open = f.etapas
  const ganado = stages?.find((s) => s.tipo === 'ganada')?.nombre ?? 'Ganado'
  const perdido = stages?.find((s) => s.tipo === 'perdida')?.nombre ?? 'Perdido'
  // potenciales abiertos hoy en la etapa i o más allá, más los ganados del período (un ganado ya pasó por todas)
  const reached = (i: number) => sum(open.slice(i).map((e) => e.potenciales)) + f.cierres.ganados
  const onward = (i: number) => [...open.slice(i + 1).map((e) => e.nombre), ganado].map((n) => `«${n}»`).join(', ')
  const steps: Step[] = []
  if (open[0]) steps.push({ key: 'alcance', name: 'Alcance', n: sum(f.por_origen.map((o) => o.entraron)), eq: `Todo lo que entró en el período, desde «${open[0].nombre}», perdidos incluidos.` })
  const mid: [string, string, number][] = [
    ['contacto', 'Contacto', 1],
    ['visita', 'Visita', 2],
    ['propuesta', 'Propuesta', 3],
  ]
  for (const [key, name, i] of mid) if (open[i]) steps.push({ key, name, n: reached(i), eq: `Llegó a «${open[i].nombre}» o más (${onward(i)}).` })
  steps.push({ key: 'cierre', name: 'Cierre', n: f.cierres.ganados, eq: `Etapa «${ganado}»: los cierres del período.` })
  return { steps, ganado, perdido, perdidoEq: `Etapa «${perdido}»: lo que se perdió en el período. Es una métrica aparte, no una barra.` }
}

function FunnelBlock({ f, stages, busy }: { f: Funnel; stages: PipelineStage[] | null; busy: boolean }) {
  const { steps, ganado, perdido, perdidoEq } = useMemo(() => buildSteps(f, stages), [f, stages])
  const max = Math.max(1, ...steps.map((s) => s.n))
  const rates = steps.slice(1).map((s, i) => {
    const from = steps[i]
    // la conversión solo se muestra si tiene sentido (el tramo anterior existe y no es menor): mezcla de foto actual y período
    return { label: `${from.name} → ${s.name}`, v: from.n > 0 && s.n <= from.n ? Math.round((1000 * s.n) / from.n) / 10 : null }
  })
  const valor = sum(f.etapas.map((e) => e.valor_mensual))
  const pond = sum(f.etapas.map((e) => e.valor_ponderado))
  const total = steps[0]?.n ?? 0
  return (
    <>
      <div className={`mk-funnel${busy ? ' is-busy' : ''}`}>
        {total === 0 && steps.every((s) => s.n === 0) ? (
          <p className="hb-empty is-dark">Todavía no hay leads en estos {f.dias} días. Cuando entren clientes potenciales (a mano, por Meta Ads o por la API), verás aquí cómo avanzan.</p>
        ) : (
          <ol className="mk-bars" aria-label={`Embudo de los últimos ${f.dias} días`}>
            {steps.map((s, i) => (
              <li key={s.key} style={{ '--w': `${s.n ? Math.max(1.5, (s.n / max) * 100) : 0}%`, '--o': i === steps.length - 1 ? 1 : 1 - i * 0.16 } as React.CSSProperties} className={i === steps.length - 1 ? 'is-won' : ''}>
                <span className="mk-name">{s.name}</span>
                <span className="mk-track" aria-hidden="true">
                  <i />
                </span>
                <b className="mk-n">{s.n}</b>
              </li>
            ))}
          </ol>
        )}
        <hr />
        <dl className="mk-rates">
          {rates.map((r) => (
            <div key={r.label}>
              <dt>{r.label}</dt>
              <dd>{r.v === null ? '—' : pct(r.v)}</dd>
            </div>
          ))}
        </dl>
        <dl className="mk-rates is-closing">
          <div>
            <dt>{ganado} (período)</dt>
            <dd>{f.cierres.ganados}</dd>
          </div>
          <div>
            <dt>{perdido} (período)</dt>
            <dd>{f.cierres.perdidos}</dd>
          </div>
          <div>
            <dt>
              Tasa de cierre <Tip>{`${ganado} ÷ (${ganado} + ${perdido}) del período.`}</Tip>
            </dt>
            <dd>{f.cierres.tasa_cierre === null ? '—' : pct(f.cierres.tasa_cierre)}</dd>
          </div>
          <div>
            <dt>Abierto</dt>
            <dd>{money(valor)}</dd>
          </div>
          <div>
            <dt>
              Ponderado (por probabilidad) <Tip>Valor de cada potencial × la probabilidad de su etapa: lo que se espera cerrar.</Tip>
            </dt>
            <dd>{money(pond)}</dd>
          </div>
        </dl>
      </div>
      <ul className="mk-how">
        <li>
          <b>Alcance y Cierre</b> cuentan lo que pasó en los últimos {f.dias} días.
        </li>
        <li>
          <b>Contacto, Visita y Propuesta</b> cuentan cuántos están hoy en esa etapa o más allá.
        </li>
        <li>
          <b>{perdido}</b> es un número del período, no una barra.
        </li>
      </ul>
      <details className="mk-eq">
        <summary>¿Cómo se calcula?</summary>
        <dl>
          {[...steps.map((s) => [s.key, s.name, s.eq]), ['perdido', perdido, perdidoEq]].map(([k, name, eq]) => (
            <div key={k}>
              <dt>{name}</dt>
              <dd>{eq}</dd>
            </div>
          ))}
        </dl>
      </details>
    </>
  )
}

/** La barra de cada origen: lo que entró, partido por cómo va. */
const PARTES: { k: 'abiertos' | 'ganados' | 'perdidos' | 'descartados' | 'directos'; one: string; many: string }[] = [
  { k: 'abiertos', one: 'abierto', many: 'abiertos' },
  { k: 'ganados', one: 'ganado', many: 'ganados' },
  { k: 'perdidos', one: 'perdido', many: 'perdidos' },
  { k: 'descartados', one: 'descartado', many: 'descartados' },
  { k: 'directos', one: 'alta directa', many: 'altas directas' },
]

function Origenes({ f }: { f: Funnel }) {
  const max = Math.max(1, ...f.por_origen.map((x) => x.entraron))
  return (
    <>
      <p className="hb-note">Cada barra es lo que entró por ese origen, partido por cómo va hoy.</p>
      <ul className="mk-src">
        {f.por_origen.map((o) => (
          <li key={o.origen}>
            <div className="mk-src-h">
              <b>{origen(o.origen)}</b>
              <span className="mk-src-n">{plural(o.entraron, 'lead', 'leads')}</span>
            </div>
            <div className="mk-src-bar" style={{ width: `${(o.entraron / max) * 100}%` }} aria-hidden="true">
              {PARTES.map((p) => (o[p.k] > 0 ? <i key={p.k} className={`is-${p.k}`} style={{ flexGrow: o[p.k] }} /> : null))}
            </div>
            <small>{PARTES.map((p) => plural(o[p.k], p.one, p.many)).join(' · ')}</small>
          </li>
        ))}
      </ul>
      <ul className="mk-legend" aria-hidden="true">
        {PARTES.map((p) => (
          <li key={p.k} className={`is-${p.k}`}>
            {p.many}
          </li>
        ))}
      </ul>
    </>
  )
}

function Meta({ f, camp }: { f: Funnel; camp: Campanas | null }) {
  const m = f.meta_ads
  return (
    <>
      {!m.conectado ? (
        <p className="mk-pend">
          <span className="hb-pill is-idle">Pendiente de conexión</span>
          Los leads de Meta Ads todavía no llegan: falta activar la recepción en el servidor.
        </p>
      ) : (
        <>
          <dl className="mk-meta">
            <div>
              <dt>Leads</dt>
              <dd>{m.leads_30d}</dd>
            </div>
            <div>
              <dt>Procesados</dt>
              <dd>{m.procesados}</dd>
            </div>
            <div>
              <dt>Duplicados</dt>
              <dd>{m.duplicados}</dd>
            </div>
          </dl>
          <p className={`hb-note${m.con_error > 0 ? ' mk-late' : ''}`}>
            {plural(m.con_error, 'error', 'errores')} en {plural(m.total, 'lead', 'leads')}
            {m.con_error > 0 ? ': revísalos con la API o el MCP.' : '.'}
          </p>
        </>
      )}
      {camp && camp.conectado && camp.totales && !camp.error ? (
        <dl className="mk-meta">
          <div>
            <dt>Gasto</dt>
            <dd>{money(camp.totales.gasto)}</dd>
          </div>
          <div>
            <dt>Leads de campañas</dt>
            <dd>{camp.totales.leads}</dd>
          </div>
          <div>
            <dt>Costo por lead</dt>
            <dd>{camp.totales.cpl === null ? '—' : money(camp.totales.cpl)}</dd>
          </div>
        </dl>
      ) : (
        camp && (
          <p className="mk-pend">
            <span className="hb-pill is-idle">Pendiente de conexión</span>
            Gasto y costo por lead: {camp.error ? `Meta no respondió (${camp.error})` : (camp.motivo ?? 'sin conexión a la cuenta publicitaria')}
          </p>
        )
      )}
    </>
  )
}

const FUENTES: { name: string; tag: string; text: string; estado: ReactNode }[] = [
  { name: 'Google Analytics 4', tag: 'Más completo', text: 'Visitas, páginas y origen del tráfico de hayai.com.ve.', estado: 'Pendiente de conexión' },
  { name: 'Cloudflare Web Analytics', tag: 'Más liviano', text: 'Visitas sin cookies y sin banner de consentimiento.', estado: 'Pendiente de conexión' },
]

export default function Panel({ dias, setDias }: { dias: number; setDias: (n: number) => void }) {
  const funnel = useLoaded(() => loadFunnel(dias), [dias])
  const stages = useLoaded(loadStages, [])
  const camp = useLoaded(() => mk.campanas(30), [])
  const f = funnel.data
  const busy = funnel.loading && !!f && f.dias !== dias

  return (
    <>
      <div className="mk-bar">
        <div className="hb-range" role="group" aria-label="Período del embudo">
          {RANGES.map((r) => (
            <button key={r.dias} type="button" aria-pressed={dias === r.dias} className={dias === r.dias ? 'is-on' : ''} onClick={() => setDias(r.dias)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {funnel.error && (
        <div className="hb-alert" role="alert">
          <p>
            {f ? 'No pudimos actualizar el embudo; ves lo último que cargó.' : 'No pudimos cargar el embudo.'} <small>{funnel.error}</small>
          </p>
          <button type="button" className="hb-btn is-ghost" onClick={funnel.reload}>
            Reintentar
          </button>
        </div>
      )}

      <div className="hb-grid is-7-5">
        <section className="hb-block is-dark" aria-labelledby="mk-funnel-h" aria-busy={!f || busy}>
          <header className="hb-bh">
            <h2 id="mk-funnel-h">Embudo de los últimos {dias} días</h2>
            {busy && <span className="hb-aside">Actualizando…</span>}
          </header>
          {f ? <FunnelBlock f={f} stages={stages.data} busy={busy} /> : <div className="hb-skel is-dark" aria-hidden="true"><i /><i /><i /></div>}
        </section>

        <div className="hb-col">
          <section className="hb-block" aria-labelledby="mk-src-h" aria-busy={!f}>
            <header className="hb-bh">
              <h2 id="mk-src-h">De dónde llegan</h2>
              {f && <span className="hb-aside">{f.dias} días</span>}
            </header>
            {!f ? (
              <div className="hb-skel" aria-hidden="true"><i /><i /><i /></div>
            ) : f.por_origen.length === 0 ? (
              <p className="hb-empty">Aún no entraron leads en estos {f.dias} días.</p>
            ) : (
              <Origenes f={f} />
            )}
          </section>

          <section className="hb-block" aria-labelledby="mk-meta-h" aria-busy={!f}>
            <header className="hb-bh">
              <h2 id="mk-meta-h">Meta Ads · 30 días</h2>
            </header>
            {!f ? <div className="hb-skel" aria-hidden="true"><i /><i /></div> : <Meta f={f} camp={camp.data} />}
          </section>
        </div>
      </div>

      <section className="hb-block" aria-labelledby="mk-prop-h">
        <header className="hb-bh">
          <h2 id="mk-prop-h">Fuentes de analítica</h2>
        </header>
        <ul className="mk-sources">
          {FUENTES.map((s) => (
            <li key={s.name}>
              <strong>{s.name}</strong>
              <span>{s.text}</span>
              <em>{s.tag}</em>
              <span className="hb-pill is-idle">{s.estado}</span>
            </li>
          ))}
          <li>
            <strong>Meta Ads (campañas)</strong>
            <span>Gasto, leads y costo por lead, solo lectura. Las credenciales viven en el servidor.</span>
            <em>Pestaña Campañas</em>
            <span className={`hb-pill ${camp.data?.conectado && !camp.data.error ? 'is-cumplido' : 'is-idle'}`}>{camp.data?.conectado && !camp.data.error ? 'Conectado' : 'Pendiente de conexión'}</span>
          </li>
        </ul>
      </section>
    </>
  )
}
