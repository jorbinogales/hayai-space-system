import { z } from 'zod'

z.config(z.locales.es())

export class HttpError extends Error {
  status: number
  extra: Record<string, unknown>
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

/** Valida con zod; el primer problema se devuelve como 400 con mensaje legible. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {})
  if (!r.success) {
    const i = r.error.issues[0]
    const path = i.path.join('.')
    throw new HttpError(400, path ? `${path}: ${i.message}` : i.message)
  }
  return r.data
}

export const text = (max: number) => z.string().trim().min(1, 'Es obligatorio').max(max, `Máximo ${max} caracteres`)
export const isoDate = z.iso.date('Fecha inválida (usa AAAA-MM-DD)')
export const id = z.uuid('Id inválido')
export const money = z
  .number('Monto inválido')
  .gt(0, 'El monto debe ser mayor que 0')
  .max(1_000_000_000, 'El monto máximo es 1.000.000.000')
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'Máximo 2 decimales')

export const idParam = (v: unknown) => parse(id, v)
