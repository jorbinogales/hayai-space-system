import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './ui'
import { waNumber } from './Invoice'
import { fmtDate, money, type Client } from './store'
import type { Proposal, ProposalItem } from './proposalData'

/**
 * Documento de propuesta comercial: el papel compartible de una propuesta (la «factura» de antes de vender).
 * Mismo formato que la factura mensual (logo, papel crema, total destacado) para imprimir o mandar por WhatsApp:
 * con el teléfono de la ficha abre el chat del cliente con el texto; sin él, comparte la imagen (canvas).
 * Es solo una vista de la propuesta guardada: editarla es crear una versión nueva.
 * Las notas de la propuesta son internas (la negociación): NO se imprimen ni se comparten aquí.
 */

const LOGO = `${import.meta.env.BASE_URL}hayai-logo.png`

export interface ProposalDocData {
  client: Client
  proposal: Proposal
}

const ref = (d: ProposalDocData) => `HY-${d.client.id.replace(/\W/g, '').slice(-4).toUpperCase()}-P${d.proposal.version}`
const issued = (d: ProposalDocData) => d.proposal.creada_el.slice(0, 10)
const unicos = (p: Proposal) => p.items.filter((i) => i.tipo === 'extra_unico')
const mensuales = (p: Proposal) => p.items.filter((i) => i.tipo !== 'extra_unico')
const lineLabel = (i: ProposalItem) => (i.cantidad > 1 ? `${i.concepto} ×${i.cantidad}` : i.concepto)

/** Texto de la propuesta (para WhatsApp cuando no se puede compartir la imagen). */
const asText = (d: ProposalDocData) => {
  const p = d.proposal
  const lines = [`*HAYAI · Propuesta ${ref(d)}*`, `Cliente: ${d.client.name}`, `Emitida: ${fmtDate(issued(d), true)}`]
  if (unicos(p).length) {
    lines.push('', '*Instalación (pago único)*', ...unicos(p).map((i) => `• ${lineLabel(i)}: ${money(i.subtotal)}`))
    lines.push(`*Total instalación: ${money(p.totales.unico)}*`)
  }
  lines.push('', '*Mensualidad*', ...mensuales(p).map((i) => `• ${lineLabel(i)}: ${money(i.subtotal)}/mes`))
  lines.push(`*Mensualidad total: ${money(p.totales.mensual)}/mes*`)
  lines.push('', 'Gracias por confiar en Hayai')
  return lines.join('\n')
}

/** Dibuja la propuesta en un canvas (mismo contenido que la vista) y la devuelve como PNG. */
async function toPng(d: ProposalDocData): Promise<Blob> {
  const logo = new Image()
  logo.src = LOGO
  await logo.decode()
  const p = d.proposal
  type Row = { kind: 'grupo' | 'item'; text: string; amount?: string }
  const rows: Row[] = []
  if (unicos(p).length) {
    rows.push({ kind: 'grupo', text: 'Instalación · pago único' })
    for (const i of unicos(p)) rows.push({ kind: 'item', text: lineLabel(i), amount: money(i.subtotal) })
  }
  if (mensuales(p).length) {
    rows.push({ kind: 'grupo', text: 'Mensualidad' })
    for (const i of mensuales(p)) rows.push({ kind: 'item', text: lineLabel(i), amount: `${money(i.subtotal)}/mes` })
  }
  const W = 720
  const ROW = 56
  const GRUPO = 46
  const top = 430 // donde empieza la lista de ítems
  const rowsH = rows.reduce((s, r) => s + (r.kind === 'grupo' ? GRUPO : ROW), 0)
  const H = top + rowsH + 330
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const g = cv.getContext('2d')!
  g.fillStyle = '#fffdf8'
  g.fillRect(0, 0, W, H)
  g.fillStyle = '#ef9d25'
  g.fillRect(0, 0, W, 14)
  const lh = 190
  g.drawImage(logo, 48, 48, lh * (logo.width / logo.height), lh)

  const font = (w: number, s: number) => (g.font = `${w} ${s}px 'Space Grotesk', system-ui, 'Segoe UI', sans-serif`)
  g.textBaseline = 'alphabetic'
  g.fillStyle = '#16110b'
  g.textAlign = 'right'
  font(700, 38)
  g.fillText('PROPUESTA', W - 48, 110)
  font(500, 22)
  g.fillStyle = '#4a3f33'
  g.fillText(ref(d), W - 48, 148)
  g.fillText(`Emitida: ${fmtDate(issued(d), true)}`, W - 48, 180)

  g.textAlign = 'left'
  g.fillStyle = 'rgba(22,17,11,0.12)'
  g.fillRect(48, 262, W - 96, 2)
  g.fillStyle = '#8a7c6a'
  font(600, 18)
  g.fillText('CLIENTE', 48, 316)
  g.fillStyle = '#16110b'
  font(700, 44)
  const name = d.client.name
  g.fillText(name.length > 24 ? `${name.slice(0, 23)}…` : name, 48, 366)
  g.fillStyle = 'rgba(22,17,11,0.12)'
  g.fillRect(48, top - 26, W - 96, 2)

  let y = top
  for (const r of rows) {
    if (r.kind === 'grupo') {
      y += GRUPO
      g.fillStyle = '#8a7c6a'
      font(600, 18)
      g.fillText(r.text.toUpperCase(), 48, y - 12)
    } else {
      y += ROW
      g.fillStyle = '#16110b'
      font(500, 24)
      g.fillText(r.text.length > 34 ? `${r.text.slice(0, 33)}…` : r.text, 48, y - 14)
      g.textAlign = 'right'
      font(700, 24)
      g.fillText(r.amount ?? '', W - 48, y - 14)
      g.textAlign = 'left'
    }
  }
  const by = top + rowsH + 16
  g.fillStyle = '#fbeed6'
  g.fillRect(48, by, W - 96, 140)
  g.fillStyle = '#8a7c6a'
  font(600, 18)
  if (p.totales.unico > 0) {
    g.fillText('TOTAL INSTALACIÓN', 72, by + 42)
    g.fillStyle = '#16110b'
    font(700, 54)
    g.fillText(money(p.totales.unico), 72, by + 102)
    g.fillStyle = '#4a3f33'
    font(500, 22)
    g.textAlign = 'right'
    g.fillText(`Mensualidad: ${money(p.totales.mensual)}/mes`, W - 72, by + 84)
    g.textAlign = 'left'
  } else {
    g.fillText('MENSUALIDAD', 72, by + 42)
    g.fillStyle = '#16110b'
    font(700, 54)
    g.fillText(`${money(p.totales.mensual)}/mes`, 72, by + 102)
  }
  g.fillStyle = '#8a7c6a'
  font(500, 18)
  g.textAlign = 'center'
  g.fillText('Gracias por confiar en Hayai', W / 2, top + rowsH + 192)
  g.fillStyle = 'rgba(22,17,11,0.12)'
  g.fillRect(48, H - 102, W - 96, 2)
  g.fillStyle = '#16110b'
  font(700, 21)
  g.fillText('hayai.com.ve', W / 2, H - 68)
  g.fillStyle = '#8a7c6a'
  font(500, 17)
  g.fillText('Instagram @hayaive · TikTok @hayai.ve · Facebook @hayai', W / 2, H - 38)
  return new Promise((ok, fail) => cv.toBlob((b) => (b ? ok(b) : fail(new Error('png'))), 'image/png'))
}

/** El documento de la propuesta: se imprime (o guarda como PDF) y se comparte por WhatsApp. */
export default function ProposalDoc({ client, proposal, onClose }: { client: Client; proposal: Proposal; onClose: () => void }) {
  const data: ProposalDocData = { client, proposal }
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close.current()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [])

  const whatsapp = async () => {
    // Con el teléfono de la ficha el chat se abre directo con el cliente (wa.me/<numero>). Sin él, se comparte la imagen como en la factura.
    const to = waNumber(client.phone)
    if (to) {
      window.open(`https://wa.me/${to}?text=${encodeURIComponent(asText(data))}`, '_blank', 'noopener')
      return
    }
    try {
      const file = new File([await toPng(data)], `propuesta-${ref(data)}.png`, { type: 'image/png' })
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text: asText(data) })
        return
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return // el usuario cerró el menú de compartir
    }
    // ponytail: sin Web Share de archivos (p. ej. escritorio) WhatsApp solo recibe texto; adjuntar la imagen a mano
    window.open(`https://wa.me/?text=${encodeURIComponent(asText(data))}`, '_blank', 'noopener')
  }

  const uni = unicos(proposal)
  const men = mensuales(proposal)
  return createPortal(
    <div className="modal invoice-modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet invoice-sheet" role="dialog" aria-modal="true" aria-labelledby="prop-title">
        <header>
          <h2 id="prop-title">Propuesta {ref(data)}</h2>
          <button type="button" className="x" onClick={onClose} aria-label="Cerrar">
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="invoice-body">
          <article className="invoice-paper proposal-paper">
            <div className="inv-top">
              <img src={LOGO} alt="Hayai" />
              <div>
                <strong>PROPUESTA</strong>
                <span>{ref(data)}</span>
                <span>Emitida: {fmtDate(issued(data), true)}</span>
              </div>
            </div>
            <dl>
              <dt>Cliente</dt>
              <dd>
                {client.hasLogo && <img className="inv-clogo" src={`/api/clients/${client.id}/logo`} alt="" />}
                {client.name}
              </dd>
            </dl>
            {uni.length > 0 && (
              <>
                <p className="inv-group">Instalación · pago único</p>
                <ul className="inv-lines">
                  {uni.map((i) => (
                    <li key={i.id}>
                      <span className="inv-concept">{lineLabel(i)}</span>
                      <b>{money(i.subtotal)}</b>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {men.length > 0 && (
              <>
                <p className="inv-group">Mensualidad</p>
                <ul className="inv-lines">
                  {men.map((i) => (
                    <li key={i.id}>
                      <span className="inv-concept">{lineLabel(i)}</span>
                      <b>
                        {money(i.subtotal)}
                        <span className="inv-per">/mes</span>
                      </b>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {proposal.totales.unico > 0 ? (
              <>
                <p className="inv-total">
                  <small>Total instalación</small>
                  {money(proposal.totales.unico)}
                </p>
                <p className="inv-mensual">
                  Mensualidad: <b>{money(proposal.totales.mensual)}/mes</b>
                </p>
              </>
            ) : (
              <p className="inv-total">
                <small>Mensualidad</small>
                {money(proposal.totales.mensual)}/mes
              </p>
            )}
            <p className="inv-thanks">Gracias por confiar en Hayai</p>
            <footer className="inv-letterfoot">
              <p className="inv-site">hayai.com.ve</p>
              <p className="inv-social">Instagram @hayaive · TikTok @hayai.ve · Facebook @hayai</p>
            </footer>
          </article>
        </div>
        <footer>
          <button type="button" className="ghost" onClick={() => window.print()}>
            <Icon name="print" size={16} /> Imprimir
          </button>
          <button type="button" className="primary" title={waNumber(client.phone) ? 'Abre el chat de WhatsApp del cliente' : 'Comparte la propuesta por WhatsApp'} onClick={() => void whatsapp()}>
            <Icon name="share" size={16} /> WhatsApp
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
