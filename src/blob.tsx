import { useId } from 'react'

// "blobvatar" no existe como paquete npm: generador propio de avatares-blob SVG, deterministas por semilla y en la paleta ambar.

export const AVATAR_SEEDS = ['nova', 'orion', 'lyra', 'vega', 'atlas', 'luna', 'kepler', 'sirio', 'rigel', 'titan', 'cygnus', 'pulsar']

const PALETTES: [string, string][] = [
  ['#FFD27A', '#EF9D25'],
  ['#FFE9B8', '#F1B24A'],
  ['#F6C177', '#C9803A'],
  ['#FFF1D6', '#E8A33D'],
  ['#FFC93C', '#D9822B'],
  ['#F2D7A8', '#B97A3A'],
  ['#FFE08A', '#EF9D25'],
  ['#E9B872', '#8A5520'],
]

function rng(seed: string) {
  let h = 1779033703 ^ seed.length
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    h ^= h >>> 16
    return (h >>> 0) / 4294967296
  }
}

function build(seed: string) {
  const r = rng(seed)
  const n = 8
  const pts = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 + r() * 0.3
    const rad = 34 + r() * 12
    return [50 + Math.cos(a) * rad, 50 + Math.sin(a) * rad] as const
  })
  // curva cerrada suave (Catmull-Rom -> Bezier)
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]
    const p1 = pts[i]
    const p2 = pts[(i + 1) % n]
    const p3 = pts[(i + 2) % n]
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += `C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`
  }
  const pal = PALETTES[Math.floor(r() * PALETTES.length)]
  const eyeGap = 9 + r() * 5
  const eyeY = 44 + r() * 6
  const eyeR = 2.6 + r() * 1.6
  const smile = 5 + r() * 5
  const dx = (r() - 0.5) * 6
  return { d, pal, eyeGap, eyeY, eyeR, smile, dx }
}

export function Blobvatar({ seed, size = 40, className = '' }: { seed: string; size?: number; className?: string }) {
  const id = useId()
  const b = build(seed)
  return (
    <svg className={`blob ${className}`} width={size} height={size} viewBox="0 0 100 100" role="img" aria-label={`Avatar ${seed}`}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={b.pal[0]} />
          <stop offset="1" stopColor={b.pal[1]} />
        </linearGradient>
      </defs>
      <path d={b.d} fill={`url(#${id})`} />
      <ellipse cx={50 + b.dx - b.eyeGap} cy={b.eyeY} rx={b.eyeR} ry={b.eyeR * 1.25} fill="#16110B" />
      <ellipse cx={50 + b.dx + b.eyeGap} cy={b.eyeY} rx={b.eyeR} ry={b.eyeR * 1.25} fill="#16110B" />
      <path d={`M${50 + b.dx - b.smile},${b.eyeY + 14} Q${50 + b.dx},${b.eyeY + 14 + b.smile} ${50 + b.dx + b.smile},${b.eyeY + 14}`} fill="none" stroke="#16110B" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  )
}

/** Selector de avatar: rejilla de blobs, uno marcado. */
export function AvatarPicker({ value, onChange, label = 'Elige un avatar' }: { value: string; onChange: (seed: string) => void; label?: string }) {
  return (
    <div className="avatars" role="radiogroup" aria-label={label}>
      {AVATAR_SEEDS.map((s) => (
        <button key={s} type="button" role="radio" aria-checked={value === s} aria-label={s} className={value === s ? 'is-on' : ''} onClick={() => onChange(s)}>
          <Blobvatar seed={s} size={44} />
        </button>
      ))}
    </div>
  )
}
