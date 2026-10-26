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
  // pie membretado: fila de contacto con su icono por canal, igual que en la vista
  const LF_ICONS: Record<string, string> = {
    globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9Z',
    instagram: 'M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM17.2 6.8h.01',
    tiktok: 'M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.57 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1Z',
    facebook: 'M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z',
    phone: 'M8 3h8a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 16 21H8a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 8 3ZM11 18h2',
  }
  const lfItems: Array<[string, string]> = [
    [LF_ICONS.globe, 'hayai.com.ve'],
    [LF_ICONS.instagram, '@hayaive'],
    [LF_ICONS.tiktok, '@hayai.ve'],
    [LF_ICONS.facebook, '@hayai'],
    [LF_ICONS.phone, '0424-1387198'],
  ]
  g.fillStyle = 'rgba(22,17,11,0.12)'
  g.fillRect(48, H - 92, W - 96, 2)
  font(600, 16)
  const IS = 16
  const IGAP = 6
  const GAP = 18
  const widths = lfItems.map(([, t]) => IS + IGAP + g.measureText(t).width)
  let fx = (W - (widths.reduce((a, b) => a + b, 0) + GAP * (lfItems.length - 1))) / 2
  const fy = H - 46
  g.textAlign = 'left'
  lfItems.forEach(([d, t], i) => {
    g.save()
    g.translate(fx, fy - IS + 3)
    g.scale(IS / 24, IS / 24)
    g.strokeStyle = '#c67f14'
    g.lineWidth = 2.4
    g.lineCap = 'round'
    g.lineJoin = 'round'
    g.stroke(new Path2D(d))
    g.restore()
    g.fillStyle = '#16110b'
    g.fillText(t, fx + IS + IGAP, fy)
    fx += widths[i] + GAP
  })
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
              <span className="lf-item"><Icon name="globe" size={15} /> hayai.com.ve</span>
              <span className="lf-item"><Icon name="instagram" size={15} /> @hayaive</span>
              <span className="lf-item"><Icon name="tiktok" size={15} /> @hayai.ve</span>
              <span className="lf-item"><Icon name="facebook" size={15} /> @hayai</span>
              <span className="lf-item"><Icon name="phone" size={15} /> 0424-1387198</span>
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
