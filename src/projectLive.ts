// Proyectos en vivo: el servidor avisa (evento SSE «proyecto», sin datos) cuando cambia algo del proyecto, sus hitos, su checklist o sus
// tareas, venga de donde venga (otra pestaña, la API, el MCP). Aqui solo se reparte el aviso a quien tenga ese proyecto abierto; cada
// pantalla decide que pedir. Varios avisos seguidos se funden en uno (un instante de espera) y quien no esta mirando ese proyecto no
// recibe nada. Nada de esto puede romper la pantalla: un aviso malo o un oyente que falla se ignoran, y la recarga manual sigue ahi.

export type ProjectSection = 'proyecto' | 'hitos' | 'checklist' | 'tareas'
export interface ProjectEvent {
  op: 'nuevo' | 'editado' | 'borrado'
  seccion: ProjectSection
  proyecto_id: string
  /** solo en 'tareas': la tarea cuelga de un hito (la hoja de ruta cuenta las tareas de cada hito) */
  hito?: boolean
}
/** Que secciones hay que volver a pedir. */
export type ProjectChange = Partial<Record<ProjectSection, true>>

const SECTIONS: readonly ProjectSection[] = ['proyecto', 'hitos', 'checklist', 'tareas']
const WAIT_MS = 250

const listeners = new Map<string, Set<(c: ProjectChange) => void>>()
const pending = new Map<string, ProjectChange>()
let timer = 0

function flush() {
  timer = 0
  const batch = [...pending]
  pending.clear()
  for (const [id, change] of batch) {
    for (const f of [...(listeners.get(id) ?? [])]) {
      try {
        f(change)
      } catch {
        /* un oyente roto no deja sin aviso a los demas */
      }
    }
  }
}
function queue(id: string, change: ProjectChange) {
  pending.set(id, { ...pending.get(id), ...change })
  if (!timer) timer = window.setTimeout(flush, WAIT_MS)
}

/** Escucha los cambios de UN proyecto. Devuelve la baja: al salir de la vista se llama y deja de recibir. */
export function subscribeProject(id: string, f: (c: ProjectChange) => void): () => void {
  const set = listeners.get(id) ?? new Set()
  set.add(f)
  listeners.set(id, set)
  return () => {
    set.delete(f)
    if (!set.size && listeners.get(id) === set) listeners.delete(id)
  }
}

/** Un aviso del servidor (live.ts). Los que no son de un proyecto abierto, o no se entienden, se descartan. */
export function receiveProject(e: Partial<ProjectEvent> | null | undefined) {
  if (!e || typeof e.proyecto_id !== 'string' || !SECTIONS.includes(e.seccion as ProjectSection) || !listeners.has(e.proyecto_id)) return
  const change: ProjectChange = { [e.seccion as ProjectSection]: true }
  if (e.seccion === 'tareas' && e.hito) change.hitos = true
  queue(e.proyecto_id, change)
}

/** El stream volvio tras una caida: lo que pasó mientras tanto no se reenvía, asi que cada proyecto abierto vuelve a pedirlo todo. */
export function projectsResync() {
  for (const id of listeners.keys()) queue(id, { proyecto: true, hitos: true, checklist: true, tareas: true })
}

/** Cierre de sesion: nadie escucha ya. */
export function resetProjectLive() {
  window.clearTimeout(timer)
  timer = 0
  pending.clear()
  listeners.clear()
}
