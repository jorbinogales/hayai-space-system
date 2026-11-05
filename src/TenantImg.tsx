import { useEffect, useState, type ImgHTMLAttributes } from 'react'
import { fetchBlob } from './api'
import { useTenants } from './tenant'

/**
 * <img> de un archivo del servidor (logo de cliente, comprobante). Un <img src> no puede mandar la cabecera X-Tenant-Id que exige
 * /api, asi que el archivo se descarga con ella y se muestra desde un blob. Si falla, avisa con onError (no pinta una imagen rota).
 */
export default function TenantImg({ src, onError, ...rest }: { src: string; onError?: () => void } & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'onError'>) {
  const tenant = useTenants().activeId
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let off = false
    let obj: string | null = null
    setUrl(null)
    fetchBlob(src)
      .then((b) => {
        if (off) return
        obj = URL.createObjectURL(b)
        setUrl(obj)
      })
      .catch(() => !off && onError?.())
    return () => {
      off = true
      if (obj) URL.revokeObjectURL(obj)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, tenant])
  return url ? <img {...rest} src={url} onError={() => onError?.()} /> : null
}
