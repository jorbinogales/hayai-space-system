import { useEffect, useRef, useState } from 'react'

/**
 * Carga interna: con la sesion iniciada, cubre la espera mientras el mundo 3D pinta su primer frame.
 * El antiguo #splash de index.html hacia tambien este papel y se fue con el; esta version vive dentro
 * de la app y usa el video del planeta con orbitas generado por Elis (public/splash-planeta.webm?v=2/.mp4,
 * con su poster .webp para que se vea al instante). El planeta va a PANTALLA COMPLETA (object-fit: cover);
 * la marca y la barra van en HTML encima, nitidas y sin depender del arte.
 * Red de seguridad: a los 9 s se oculta si o si — una carga nunca debe atrapar al usuario.
 * Con prefers-reduced-motion no hay video: solo el poster quieto, tambien a pantalla completa.
 */
export default function IntroSplash({ done }: { done: boolean }) {
  const [out, setOut] = useState(false)
  const [gone, setGone] = useState(false)
  const [reduced] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)

  // Tiempo minimo en pantalla (2,2 s): si el mundo carga muy rapido, sin esto la carga es un
  // parpadeo que no se aprecia y se siente brusco; con el minimo se saborea el planeta y sale suave.
  const born = useRef(Date.now())
  useEffect(() => {
    if (!done) return
    const wait = Math.max(0, 2200 - (Date.now() - born.current))
    const t1 = window.setTimeout(() => setOut(true), wait)
    const t2 = window.setTimeout(() => setGone(true), wait + 700)
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
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
        .intro { position: fixed; inset: 0; z-index: 80; overflow: hidden;
          background: #100c07; transition: opacity .65s ease, visibility .65s ease; }
        .intro.is-out { opacity: 0; visibility: hidden; pointer-events: none; }
        .intro-media { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; background: #100c07; }
        .intro-vignette { position: absolute; inset: 0; pointer-events: none;
          background: radial-gradient(120% 90% at 50% 42%, transparent 55%, rgba(10,6,2,.42) 100%); }
        .intro-scrim { position: absolute; left: 0; right: 0; bottom: 0; height: 46%; pointer-events: none;
          background: linear-gradient(to top, rgba(12,7,2,.66), rgba(12,7,2,0)); }
        .intro-brand { position: absolute; left: 0; right: 0; bottom: 9%; text-align: center; padding: 0 16px; }
        .intro-word { font-size: clamp(34px, 5.4vw, 54px); font-weight: 800; letter-spacing: .34em; text-indent: .34em;
          color: #f6eee2; text-shadow: 0 4px 30px rgba(0,0,0,.6); }
        .intro-i { position: relative; }
        .intro-i i { position: absolute; left: 50%; top: -.14em; width: .15em; height: .15em; border-radius: 50%;
          background: #ef9d25; transform: translateX(-72%); box-shadow: 0 0 14px rgba(239,157,37,.95); }
        .intro-tag { margin-top: 10px; font-size: 11px; font-weight: 600; letter-spacing: .5em; text-indent: .5em;
          text-transform: uppercase; color: rgba(246,238,226,.78); }
        .intro-bar { margin: 24px auto 0; width: min(240px, 55vw); height: 2px; border-radius: 2px;
          background: rgba(246,238,226,.22); overflow: hidden; }
        .intro-bar i { display: block; height: 100%; width: 40%; border-radius: 2px;
          background: linear-gradient(90deg, #b45f16, #ef9d25, #ffd98a); animation: introSlide 1.3s ease-in-out infinite; }
        @keyframes introSlide { 0% { transform: translateX(-110%); } 100% { transform: translateX(280%); } }
        @media (prefers-reduced-motion: reduce) { .intro-bar i { animation: none; } }
      `}</style>
      {reduced ? (
        <img className="intro-media" src="/splash-planeta-poster.webp?v=2" alt="" />
      ) : (
        <video className="intro-media" autoPlay muted loop playsInline poster="/splash-planeta-poster.webp?v=2" aria-hidden="true">
          <source src="/splash-planeta.webm?v=2" type="video/webm" />
          <source src="/splash-planeta.mp4?v=2" type="video/mp4" />
        </video>
      )}
      <div className="intro-vignette" aria-hidden="true" />
      <div className="intro-scrim" aria-hidden="true" />
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
