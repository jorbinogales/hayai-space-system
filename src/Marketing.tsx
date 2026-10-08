import { useState } from 'react'
import { Icon } from './ui'
import Campanas from './mkCampanas'
import Competidores from './mkCompetidores'
import Contenido from './mkContenido'
import Keywords from './mkKeywords'
import Panel from './mkPanel'
import './hub.css'

const TABS = [
  { id: 'panel', label: 'Panel' },
  { id: 'keywords', label: 'Keywords' },
  { id: 'competidores', label: 'Competidores' },
  { id: 'contenido', label: 'Contenido' },
  { id: 'campanas', label: 'Campañas' },
] as const
type Tab = (typeof TABS)[number]['id']

/** La pestaña inicial sale del enlace (#marketing/contenido): así el feed puede llevar directo al tablero. */
const fromHash = (): Tab => {
  const t = location.hash.slice(1).split('/')[1]
  return TABS.some((x) => x.id === t) ? (t as Tab) : 'panel'
}

/** Planeta Marketing: la Central de marketing, una pantalla plana con cinco pestañas (Panel, Keywords, Competidores, Contenido y Campañas). */
export default function Marketing({ from = 'hub', onBack }: { from?: 'hub' | 'home'; onBack: () => void }) {
  const [tab, setTab] = useState<Tab>(fromHash)
  const [visitadas, setVisitadas] = useState<Set<Tab>>(() => new Set([fromHash()]))
  const [dias, setDias] = useState(90)

  const abrir = (t: Tab) => {
    setTab(t)
    setVisitadas((v) => (v.has(t) ? v : new Set(v).add(t)))
    // el enlace recuerda la pestaña sin disparar una navegación
    history.replaceState(null, '', `#marketing${t === 'panel' ? '' : `/${t}`}`)
  }
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : null
    if (to === null) return
    e.preventDefault()
    const n = TABS[(to + TABS.length) % TABS.length].id
    abrir(n)
    document.getElementById(`mk-tab-${n}`)?.focus()
  }

  return (
    <main className="screen layer hub-screen mkt-screen" aria-label="Planeta Marketing">
      <div className="hb-scroll">
        <div className="hb-wrap">
          <button className="hb-back" onClick={onBack}>
            <Icon name="back" size={16} />
            {from === 'home' ? 'Volver al core' : 'Volver al hub'}
          </button>

          <header className="hb-head">
            <div>
              <p className="hb-eyebrow">Planeta Marketing</p>
              <h1>Central de marketing</h1>
            </div>
          </header>

          <div className="hb-tabs mk-tabs" role="tablist" aria-label="Secciones de Marketing">
            {TABS.map((t, i) => (
              <button key={t.id} id={`mk-tab-${t.id}`} role="tab" type="button" aria-selected={tab === t.id} aria-controls={`mk-panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1} className={tab === t.id ? 'is-on' : ''} onClick={() => abrir(t.id)} onKeyDown={(e) => onKey(e, i)}>
                {t.label}
              </button>
            ))}
          </div>

          {TABS.map(
            (t) =>
              visitadas.has(t.id) && (
                <div key={t.id} id={`mk-panel-${t.id}`} role="tabpanel" aria-labelledby={`mk-tab-${t.id}`} hidden={tab !== t.id} className="mk-panel">
                  {t.id === 'panel' && <Panel dias={dias} setDias={setDias} />}
                  {t.id === 'keywords' && <Keywords active={tab === 'keywords'} onGoContenido={() => abrir('contenido')} />}
                  {t.id === 'competidores' && <Competidores />}
                  {t.id === 'contenido' && <Contenido active={tab === 'contenido'} />}
                  {t.id === 'campanas' && <Campanas />}
                </div>
              ),
          )}
        </div>
      </div>
    </main>
  )
}
