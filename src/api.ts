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

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${url}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
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
  patch: <T>(url: string, body: unknown) => call<T>('PATCH', url, body),
  del: (url: string) => call<null>('DELETE', url),
}
