import { useEffect, useState } from 'react'

/**
 * Carga interna: con la sesion iniciada, cubre la espera mientras el mundo 3D pinta su primer frame.
 * El antiguo #splash de index.html hacia tambien este papel y se fue con el; esta version vive dentro
 * de la app y usa el video del planeta con orbitas generado por Elis (public/splash-planeta.webm/.mp4,
 * con su poster .webp para que se vea al instante y de fondo desenfocado).
 * La marca y la barra van en HTML encima del video: nitidas y sin depender del arte.
 * Red de seguridad: a los 9 s se oculta si o si — una carga nunca debe atrapar al usuario.
 * Con prefers-reduced-motion no hay video: solo el poster quieto.
 */
export default function IntroSplash({ done }: { done: boolean }) {
  const [out, setOut] = useState(false)
  const [gone, setGone] = useState(false)
  const [reduced] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)

  useEffect(() => {
    if (!done) return
    setOut(true)
    const t = window.setTimeout(() => setGone(true), 700)
    return () => window.clearTimeout(t)
  }, [done])

  useEffect(() => {
    const t = window.setTimeout(() => {
      setOut(true)
      window.setTimeout(() => setGone(true), 700)
    }, 9000)
    return () => window.clearTimeout(t)
  }, [])

  if (gone) return null

  return (
    <div className={`intro${out ? ' is-out' : ''}`} role="status" aria-label="Cargando tu mundo">
      <style>{`
        .intro { position: fixed; inset: 0; z-index: 80; display: grid; place-items: center; overflow: hidden;
          background: #100c07; transition: opacity .65s ease, visibility .65s ease; }
        .intro.is-out { opacity: 0; visibility: hidden; pointer-events: none; }
        .intro-bg { position: absolute; inset: 0; background: url('/splash-planeta-poster.webp') center / cover no-repeat;
          filter: blur(28px) brightness(.45); transform: scale(1.15); }
        .intro-media { position: relative; width: min(880px, 94vw); aspect-ratio: 16 / 9; object-fit: cover;
          border-radius: 18px; box-shadow: 0 40px 120px rgba(0,0,0,.65); background: #17110a; }
        .intro-brand { position: absolute; left: 0; right: 0; bottom: 8%; text-align: center; padding: 0 16px; }
        .intro-word { font-size: clamp(30px, 5vw, 46px); font-weight: 800; letter-spacing: .34em; text-indent: .34em; color: #f6eee2; }
        .intro-i { position: relative; }
        .intro-i i { position: absolute; left: 50%; top: -.14em; width: .15em; height: .15em; border-radius: 50%;
          background: #ef9d25; transform: translateX(-72%); box-shadow: 0 0 12px rgba(239,157,37,.9); }
        .intro-tag { margin-top: 9px; font-size: 11px; font-weight: 600; letter-spacing: .5em; text-indent: .5em;
          text-transform: uppercase; color: rgba(246,238,226,.62); }
        .intro-bar { margin: 22px auto 0; width: min(230px, 55vw); height: 2px; border-radius: 2px;
          background: rgba(246,238,226,.15); overflow: hidden; }
        .intro-bar i { display: block; height: 100%; width: 40%; border-radius: 2px;
          background: linear-gradient(90deg, #b45f16, #ef9d25, #ffd98a); animation: introSlide 1.3s ease-in-out infinite; }
        @keyframes introSlide { 0% { transform: translateX(-110%); } 100% { transform: translateX(280%); } }
        @media (prefers-reduced-motion: reduce) { .intro-bar i { animation: none; } }
      `}</style>
      <div className="intro-bg" aria-hidden="true" />
      {reduced ? (
        <img className="intro-media" src="/splash-planeta-poster.webp" alt="" />
      ) : (
        <video className="intro-media" autoPlay muted loop playsInline poster="/splash-planeta-poster.webp" aria-hidden="true">
          <source src="/splash-planeta.webm" type="video/webm" />
          <source src="/splash-planeta.mp4" type="video/mp4" />
        </video>
      )}
      <div className="intro-brand">
        <div className="intro-word">
          HAYA
          <span className="intro-i">
            ı<i />
          </span>
        </div>
        <div className="intro-tag">Todo está conectado</div>
        <div className="intro-bar" aria-hidden="true">
          <i />
        </div>
      </div>
    </div>
  )
}
