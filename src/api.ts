import { activeTenantId } from './tenant'

// Cliente HTTP del backend (misma origen: en desarrollo Vite redirige /api al servidor). La sesion viaja en una cookie httpOnly.

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data?: unknown,
  ) {
    super(message)
  }
}

/** Opciones de una escritura. `ifMatch`: la marca `updatedAt` que vio quien edita; si el registro cambio, el servidor responde 409 (conflicto) en vez de pisarlo. */
export interface WriteOptions {
  ifMatch?: string | null
}

/** Quien quiera enterarse de la version del sistema que anuncia el servidor en cada respuesta (X-Hayai-Version). */
let onVersion: ((v: string) => void) | null = null
export const watchServerVersion = (fn: ((v: string) => void) | null) => void (onVersion = fn)

/** Un 409 de conflicto (alguien guardo antes) trae la marca actual del registro. */
export const isConflict = (e: unknown): e is ApiError & { data: { codigo: 'conflicto'; actualizado_el: string } } =>
  e instanceof ApiError && e.status === 409 && (e.data as { codigo?: string } | undefined)?.codigo === 'conflicto'

/** Todo /api es de un tenant (cabecera X-Tenant-Id) salvo el acceso y la administracion, que son globales. */
const scoped = (url: string) => !url.startsWith('/auth/') && !url.startsWith('/admin')

/** Cabeceras de una lectura/escritura al servidor, con el tenant activo cuando la ruta es de un tenant. */
const tenantHeaders = (url: string, headers: Record<string, string> = {}) => {
  const t = scoped(url) ? activeTenantId() : null
  if (t) headers['X-Tenant-Id'] = t
  return headers
}

async function call<T>(method: string, url: string, body?: unknown, opt?: WriteOptions): Promise<T> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (opt?.ifMatch) headers['If-Match'] = opt.ifMatch
  const tenant = scoped(url) ? activeTenantId() : null
  tenantHeaders(url, headers)
  const res = await fetch(`/api${url}`, {
    method,
    credentials: 'same-origin',
    headers: Object.keys(headers).length ? headers : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  // se cambio de tenant mientras volaba la peticion: su respuesta es del espacio anterior y no debe tocar la pantalla
  if (scoped(url) && tenant !== activeTenantId()) throw new ApiError(0, 'Cambiaste de espacio de trabajo')
  const seen = res.headers.get('X-Hayai-Version')
  if (seen) onVersion?.(seen)
  const data = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) {
    // sesion vencida o revocada: la app vuelve a la pantalla de acceso (salvo en el propio login)
    if (res.status === 401 && !url.startsWith('/auth/')) window.dispatchEvent(new Event('hayai:unauthorized'))
    // el tenant (o el modulo) ya no es del socio: la app vuelve a pedir sus accesos
    const codigo = (data as { codigo?: string } | null)?.codigo
    if (scoped(url) && (codigo === 'tenant_sin_acceso' || codigo === 'tenant_requerido' || codigo === 'modulo_sin_acceso')) window.dispatchEvent(new Event('hayai:tenant-denied'))
    throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? `Error ${res.status}`, data)
  }
  return data as T
}

/** Descarga un archivo del servidor (logo, comprobante) con el tenant en la cabecera: un <img src> no puede mandarla. */
export async function fetchBlob(url: string): Promise<Blob> {
  const res = await fetch(url, { credentials: 'same-origin', headers: tenantHeaders(url.replace(/^\/api/, '')) })
  if (!res.ok) throw new ApiError(res.status, `Error ${res.status}`)
  return res.blob()
}

export const api = {
  get: <T>(url: string) => call<T>('GET', url),
  post: <T>(url: string, body?: unknown) => call<T>('POST', url, body ?? {}),
  put: <T>(url: string, body: unknown, opt?: WriteOptions) => call<T>('PUT', url, body, opt),
  patch: <T>(url: string, body: unknown, opt?: WriteOptions) => call<T>('PATCH', url, body, opt),
  del: <T = null>(url: string) => call<T>('DELETE', url),
}
