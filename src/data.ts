import { loadClients, resetClients } from './store'
import { loadProjects, resetProjects } from './projectData'
import { loadExpenses, resetExpenses } from './expenseData'
import { loadTasks, resetTasks } from './taskData'
import { loadUsers, resetUsers } from './users'
import { resetStages } from './clientLog'
import { resetFeedState } from './feedData'
import { closeProposal } from './proposalData'

/** Carga todos los datos del sistema desde el servidor (tras iniciar sesion). */
export const loadAll = () => Promise.all([loadUsers(), loadClients(), loadProjects(), loadExpenses(), loadTasks()]).then(() => undefined)

/** Vacia las copias en memoria (al cerrar sesion o cambiar de espacio de trabajo): nada del anterior debe quedar a la vista. */
export function resetAll() {
  resetUsers()
  resetClients()
  resetProjects()
  resetExpenses()
  resetTasks()
  resetStages()
  resetFeedState()
  closeProposal()
}
