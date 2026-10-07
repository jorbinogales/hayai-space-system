import { useMemo, useState } from 'react'
import { Icon } from './ui'
import { loadFunnel, loadStages, useLoaded, type Funnel, type PipelineStage } from './hubData'
import { money } from './store'
import './hub.css'

const RANGES = [
  { dias: 30, label: '30 días' },
  { dias: 90, label: '90 días' },
  { dias: 180, label: '180 días' },
  { dias: 365, label: '1 año' },
]

const ORIGENES: Record<string, string> = {
  meta_ads: 'Meta Lead Ads',
  referido: 'Referidos',
  whatsapp: 'WhatsApp directo',
  instagram: 'Instagram',
  facebook: 'Facebook',
  web: 'Sitio web',
  visita_frio: 'Visita en frío',
  evento: 'Evento',
  otro: 'Otro',
  sin_origen: 'Sin origen',
}
const origen = (k: string) => ORIGENES[k] ?? k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const sum = (l: number[]) => l.reduce((a, b) => a + b, 0)
const pct = (n: number) => `${n.toLocaleString('es-VE', { maximumFractionDigits: 1 })} %`

interface Step {
  key: string
  name: string
  n: number
  /** que significa en etapas reales del pipeline (con los nombres que devuelve la API) */
  eq: string
}

/**
 * Embudo simplificado (Alcance → Contacto → Visita → Propuesta → Cierre) sobre las etapas REALES de la API.
 * Los nombres de etapa nunca van escritos aqui: salen de /marketing/funnel y /pipeline/stages.
 */
function buildSteps(f: Funnel, stages: PipelineStage[] | null): { steps: Step[]; ganado: string; perdido: string } {
  const open = f.etapas
  const ganado = stages?.find((s) => s.tipo === 'ganada')?.nombre ?? 'Ganado'
  const perdido = stages?.find((s) => s.tipo === 'perdida')?.nombre ?? 'Perdido'
  // posibles abiertos hoy en la etapa i o mas alla, mas los ganados del periodo (un ganado ya paso por todas)
  const reached = (i: number) => sum(open.slice(i).map((e) => e.posibles)) + f.cierres.ganados
  const onward = (i: number) => [...open.slice(i + 1).map((e) => e.nombre), ganado].map((n) => `«${n}»`).join(', ')
  const steps: Step[] = []
  if (open[0]) steps.push({ key: 'alcance', name: 'Alcance', n: sum(f.por_origen.map((o) => o.entraron)), eq: `Todo lo que entró en el período, desde «${open[0].nombre}» e incluidos los perdidos.` })
  const mid: [string, string, number][] = [
    ['contacto', 'Contacto', 1],
    ['visita', 'Visita', 2],
    ['propuesta', 'Propuesta', 3],
  ]
  for (const [key, name, i] of mid) if (open[i]) steps.push({ key, name, n: reached(i), eq: `Llegó a «${open[i].nombre}» o más (${onward(i)}).` })
  steps.push({ key: 'cierre', name: 'Cierre', n: f.cierres.ganados, eq: `Etapa «${ganado}» (cierres del período). «${perdido}» no es una barra: resta de Alcance y se ve en la tasa de cierre.` })
  return { steps, ganado, perdido }
}

function FunnelBlock({ f, stages, busy }: { f: Funnel; stages: PipelineStage[] | null; busy: boolean }) {
  const { steps, ganado, perdido } = useMemo(() => buildSteps(f, stages), [f, stages])
  const max = Math.max(1, ...steps.map((s) => s.n))
  const rates = steps.slice(1).map((s, i) => {
    const from = steps[i]
    // la conversion solo se muestra si tiene sentido (el tramo anterior existe y no es menor): mezcla de foto actual y periodo
    return { label: `${from.name} a ${s.name.toLowerCase()}`, v: from.n > 0 && s.n <= from.n ? Math.round((1000 * s.n) / from.n) / 10 : null }
  })
  const valor = sum(f.etapas.map((e) => e.valor_mensual))
  const pond = sum(f.etapas.map((e) => e.valor_ponderado))
  const total = steps[0]?.n ?? 0
  return (
    <>
      <div className={`mk-funnel${busy ? ' is-busy' : ''}`}>
        {total === 0 && steps.every((s) => s.n === 0) ? (
          <p className="hb-empty is-dark">Todavía no hay leads en estos {f.dias} días. Cuando entren posibles clientes (a mano, por Meta Ads o por la API), verás aquí cómo avanzan.</p>
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
            <dt>Tasa de cierre</dt>
            <dd>{f.cierres.tasa_cierre === null ? '—' : pct(f.cierres.tasa_cierre)}</dd>
          </div>
          <div>
            <dt>Valor mensual abierto</dt>
            <dd>
              {money(valor)}
              <small>{money(pond)} ponderado</small>
            </dd>
          </div>
        </dl>
      </div>
      <p className="hb-note">
        Alcance y Cierre salen del período elegido ({f.dias} días). Las etapas del medio cuentan los posibles que hoy están en esa etapa o más allá, más los ganados del período: no cambian con los días. Los nombres de arriba son un resumen; abajo, a qué etapas reales del pipeline equivale cada uno.
      </p>
      <section className="mk-eq" aria-labelledby="mk-eq-h">
        <h3 id="mk-eq-h">Equivalencia con las etapas reales del pipeline</h3>
        <dl>
          {steps.map((s) => (
            <div key={s.key}>
              <dt>{s.name}</dt>
              <dd>{s.eq}</dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  )
}

const SOURCES = [
  { name: 'Google Analytics 4', tag: 'Más completo', text: 'Visitas, páginas y origen del tráfico de hayai.com.ve. Cuenta de servicio con rol de lector.' },
  { name: 'Cloudflare Web Analytics', tag: 'Más liviano', text: 'Visitas sin cookies y sin banner de consentimiento. Token de solo lectura.' },
  { name: 'Meta Graph API', tag: 'Redes', text: 'Alcance, seguidores e interacción de Instagram y Facebook. Permisos de lectura de insights.' },
]

/** Planeta Marketing: embudo del pipeline, de dónde llegan los leads, Meta Ads y la propuesta de analítica. */
export default function Marketing({ onBack }: { onBack: () => void }) {
  const [dias, setDias] = useState(90)
  const funnel = useLoaded(() => loadFunnel(dias), [dias])
  const stages = useLoaded(loadStages, [])
  const f = funnel.data
  const busy = funnel.loading && !!f && f.dias !== dias

  return (
    <main className="screen layer hub-screen mkt-screen" aria-label="Planeta Marketing">
      <div className="hb-scroll">
        <div className="hb-wrap">
          <button className="hb-back" onClick={onBack}>
            <Icon name="back" size={16} />
            Volver al hub
          </button>

          <header className="hb-head">
            <div>
              <p className="hb-eyebrow">Planeta Marketing</p>
              <h1>De desconocido a cliente</h1>
            </div>
            <div className="hb-range" role="group" aria-label="Período del embudo">
              {RANGES.map((r) => (
                <button key={r.dias} type="button" aria-pressed={dias === r.dias} className={dias === r.dias ? 'is-on' : ''} onClick={() => setDias(r.dias)}>
                  {r.label}
                </button>
              ))}
            </div>
          </header>

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
                  <ul className="mk-src">
                    {f.por_origen.map((o) => (
                      <li key={o.origen}>
                        <div>
                          <b>{origen(o.origen)}</b>
                          <small>
                            {plural(o.ganados, 'ganado', 'ganados')} · {plural(o.abiertos, 'abierto', 'abiertos')}
                            {o.perdidos > 0 && <> · {plural(o.perdidos, 'perdido', 'perdidos')}</>}
                          </small>
                        </div>
                        <span className="mk-src-n">{plural(o.entraron, 'lead', 'leads')}</span>
                        <i aria-hidden="true" style={{ width: `${(o.entraron / Math.max(1, ...f.por_origen.map((x) => x.entraron))) * 100}%` }} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="hb-block" aria-labelledby="mk-meta-h" aria-busy={!f}>
                <header className="hb-bh">
                  <h2 id="mk-meta-h">Meta Ads · 30 días</h2>
                </header>
                {!f ? (
                  <div className="hb-skel" aria-hidden="true"><i /><i /></div>
                ) : (
                  <dl className="mk-meta">
                    <div>
                      <dt>Leads</dt>
                      <dd>{f.meta_ads.leads_30d}</dd>
                    </div>
                    <div>
                      <dt>Procesados</dt>
                      <dd>{f.meta_ads.procesados}</dd>
                    </div>
                    <div>
                      <dt>Duplicados</dt>
                      <dd>{f.meta_ads.duplicados}</dd>
                    </div>
                    <div className={f.meta_ads.con_error > 0 ? 'is-late' : ''}>
                      <dt>Con error</dt>
                      <dd>{f.meta_ads.con_error}</dd>
                      <small>en total</small>
                    </div>
                  </dl>
                )}
                {f && f.meta_ads.leads_30d === 0 && f.meta_ads.con_error === 0 && <p className="hb-note">Todavía no han llegado leads de Meta Ads en los últimos 30 días.</p>}
                {f && f.meta_ads.con_error > 0 && <p className="hb-note">Hay leads que no se pudieron procesar: revísalos con la API o el MCP.</p>}
              </section>
            </div>
          </div>

          <section className="hb-block hb-prop" aria-labelledby="mk-prop-h">
            <header className="hb-bh">
              <h2 id="mk-prop-h">Propuesta · fuentes de analítica</h2>
              <span className="hb-pill is-abierto">Para decidir, no conectado</span>
            </header>
            <ul className="mk-sources">
              {SOURCES.map((s) => (
                <li key={s.name}>
                  <strong>{s.name}</strong>
                  <span>{s.text}</span>
                  <em>{s.tag}</em>
                </li>
              ))}
            </ul>
            <div className="mk-prop-note">
              <p>
                <strong>Las tres, de la misma manera.</strong> Solo lectura. Las credenciales viven en el servidor, nunca en el navegador ni en el repositorio.
              </p>
              <p>
                <strong>Qué se vería.</strong> Un bloque en el hub y otro aquí, bajo el embudo, con visitas, alcance y su relación con los leads.
              </p>
              <p>
                <strong>Qué falta decidir.</strong> Cuál de las tres entra primero. Sugerencia: Cloudflare, por no pedir consentimiento.
              </p>
            </div>
          </section>
        </div>
      </div>
    </main>
  )
}
