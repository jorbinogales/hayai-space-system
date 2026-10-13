// Cliente mínimo de un LLM por HTTP (API compatible con chat/completions). Hoy el servidor no tenía ningún proveedor de IA configurado,
// así que el predeterminado es DeepSeek con DEEPSEEK_API_KEY. Se lee del entorno en cada llamada (no al arrancar): así una llave nueva o
// una prueba con un servidor falso no piden reiniciar nada.
//
//   DEEPSEEK_API_KEY    obligatoria; sin ella no hay IA y todo lo que depende de ella queda apagado sin romper nada.
//   DEEPSEEK_MODEL      opcional (por defecto «deepseek-chat»).
//   DEEPSEEK_BASE_URL   opcional (por defecto https://api.deepseek.com); sirve para otro proveedor compatible o un proxy.
//   LLM_TIMEOUT_MS      opcional (por defecto 45000).
//
// La llave nunca se escribe en un log ni se devuelve en un error: los mensajes que salen de aquí son cortos y sin secretos.
export class LlmError extends Error {}

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
}

export function llmConfig(): LlmConfig | null {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
  if (!apiKey) return null
  const timeout = Number(process.env.LLM_TIMEOUT_MS)
  return {
    apiKey,
    baseUrl: (process.env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com').replace(/\/+$/, ''),
    model: process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-chat',
    timeoutMs: Number.isFinite(timeout) && timeout >= 1000 ? timeout : 45_000,
  }
}

/** Saca el JSON de la respuesta del modelo (tolera una cerca ```json … ``` y texto suelto alrededor). */
export function parseJsonLoose(raw: string): unknown {
  const t = raw.trim()
  const cerca = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const base = cerca ? cerca[1] : t
  try {
    return JSON.parse(base)
  } catch {
    const i = base.indexOf('{')
    const j = base.lastIndexOf('}')
    if (i >= 0 && j > i) return JSON.parse(base.slice(i, j + 1))
    throw new LlmError('La respuesta de la IA no era JSON')
  }
}

/** Pide al modelo una respuesta en JSON. Reintenta una vez ante un 429/5xx o un corte de red. */
export async function llmJson(system: string, user: string, opts: { maxTokens?: number } = {}): Promise<{ json: unknown; model: string }> {
  const cfg = llmConfig()
  if (!cfg) throw new LlmError('No hay un proveedor de IA configurado (DEEPSEEK_API_KEY)')
  const body = JSON.stringify({
    model: cfg.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.2,
    max_tokens: opts.maxTokens ?? 1500,
    stream: false,
  })
  let ultimo = 'sin respuesta'
  for (let intento = 0; intento < 2; intento++) {
    if (intento) await new Promise((r) => setTimeout(r, 800))
    try {
      const r = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body,
        signal: AbortSignal.timeout(cfg.timeoutMs),
      })
      if (r.status === 401 || r.status === 403) throw new LlmError('El proveedor de IA rechazó la llave (revisa DEEPSEEK_API_KEY)')
      if (r.status === 402) throw new LlmError('El proveedor de IA no tiene saldo')
      if (r.status === 429 || r.status >= 500) {
        ultimo = `el proveedor de IA respondió ${r.status}`
        continue
      }
      if (!r.ok) throw new LlmError(`El proveedor de IA respondió ${r.status}`)
      const data = (await r.json()) as { choices?: { message?: { content?: unknown } }[]; model?: unknown }
      const content = data.choices?.[0]?.message?.content
      if (typeof content !== 'string' || !content.trim()) throw new LlmError('El proveedor de IA devolvió una respuesta vacía')
      return { json: parseJsonLoose(content), model: typeof data.model === 'string' ? data.model.slice(0, 80) : cfg.model }
    } catch (e) {
      if (e instanceof LlmError) throw e
      ultimo = (e as Error).name === 'TimeoutError' ? 'el proveedor de IA tardó demasiado' : 'no se pudo conectar con el proveedor de IA'
    }
  }
  throw new LlmError(`No se pudo consultar la IA: ${ultimo}`)
}
