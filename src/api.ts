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

async function call<T>(method: string, url: string, body?: unknown, opt?: WriteOptions): Promise<T> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (opt?.ifMatch) headers['If-Match'] = opt.ifMatch
  const res = await fetch(`/api${url}`, {
    method,
    credentials: 'same-origin',
    headers: Object.keys(headers).length ? headers : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const seen = res.headers.get('X-Hayai-Version')
  if (seen) onVersion?.(seen)
  const data = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) {
    // sesion vencida o revocada: la app vuelve a la pantalla de acceso (salvo en el propio login)
    if (res.status === 401 && !url.startsWith('/auth/')) window.dispatchEvent(new Event('hayai:unauthorized'))
    throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? `Error ${res.status}`, data)
  }
  return data as T
}

export const api = {
  get: <T>(url: string) => call<T>('GET', url),
  post: <T>(url: string, body?: unknown) => call<T>('POST', url, body ?? {}),
  put: <T>(url: string, body: unknown, opt?: WriteOptions) => call<T>('PUT', url, body, opt),
  patch: <T>(url: string, body: unknown, opt?: WriteOptions) => call<T>('PATCH', url, body, opt),
  del: <T = null>(url: string) => call<T>('DELETE', url),
}
