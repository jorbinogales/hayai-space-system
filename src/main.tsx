import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { preloadPlanets, warmRenderers } from './scene'

// mientras se ve la pantalla de acceso: texturas decodificadas y renderers calentados
preloadPlanets()
warmRenderers()

createRoot(document.getElementById('root')!).render(<App />)
