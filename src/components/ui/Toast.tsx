import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'

export type ToastKind = 'info' | 'success' | 'error'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface Toast {
  id: string
  kind: ToastKind
  title: string
  message?: string | undefined
  action?: ToastAction | undefined
}

interface ToastApi {
  show: (t: Omit<Toast, 'id'>) => void
  error: (title: string, message?: string) => void
  success: (title: string, message?: string) => void
  info: (title: string, message?: string) => void
  /** Shows an info toast with a clickable action button (e.g. "Undo"). */
  withAction: (title: string, action: ToastAction, message?: string) => void
}

const Ctx = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const v = useContext(Ctx)
  if (!v) throw new Error('useToast must be used inside <ToastProvider>')
  return v
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: string) => {
    setToasts((ts) => ts.filter((t) => t.id !== id))
  }, [])

  const show = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = Math.random().toString(36).slice(2)
      setToasts((ts) => [...ts, { ...t, id }])
      window.setTimeout(() => dismiss(id), 5500)
    },
    [dismiss],
  )

  // Stable identity: consumers put `toast` in effect deps (e.g. the timeline's
  // key handler), so rebuilding this every render re-ran those effects.
  const api = useMemo<ToastApi>(
    () => ({
      show,
      error: (title, message) => show({ kind: 'error', title, message }),
      success: (title, message) => show({ kind: 'success', title, message }),
      info: (title, message) => show({ kind: 'info', title, message }),
      withAction: (title, action, message) =>
        show({ kind: 'info', title, message, action }),
    }),
    [show],
  )

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {/* Screen-reader announcements: errors interrupt, the rest wait. */}
        <div className="sr-only" aria-live="assertive" role="alert">
          {toasts
            .filter((t) => t.kind === 'error')
            .map((t) => (
              <p key={t.id}>
                {t.title}
                {t.message ? `. ${t.message}` : ''}
              </p>
            ))}
        </div>
        <div className="sr-only" aria-live="polite" role="status">
          {toasts
            .filter((t) => t.kind !== 'error')
            .map((t) => (
              <p key={t.id}>
                {t.title}
                {t.message ? `. ${t.message}` : ''}
              </p>
            ))}
        </div>
        {toasts.map((t) => (
          <div
            key={t.id}
            className={
              'pointer-events-auto panel shadow-pop px-3 py-2.5 pr-2 flex items-start gap-2.5 min-w-[260px] max-w-[420px] ' +
              (t.kind === 'error'
                ? 'border-danger/40'
                : t.kind === 'success'
                  ? 'border-success/40'
                  : 'border-bd2')
            }
          >
            <div
              className={
                'mt-0.5 ' +
                (t.kind === 'error'
                  ? 'text-danger'
                  : t.kind === 'success'
                    ? 'text-success'
                    : 'text-accent-text')
              }
            >
              {t.kind === 'error' ? (
                <AlertTriangle size={16} />
              ) : t.kind === 'success' ? (
                <CheckCircle2 size={16} />
              ) : (
                <Info size={16} />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold">{t.title}</div>
              {t.message && (
                <div className="text-[11px] text-muted mt-0.5 break-words">
                  {t.message}
                </div>
              )}
              {t.action && (
                <button
                  className="mt-1 text-[11px] font-semibold text-accent-text hover:underline"
                  onClick={() => {
                    t.action!.onClick()
                    dismiss(t.id)
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              className="btn-ghost !p-1"
              aria-label="Dismiss"
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}

/** Convert a capture error into a human-friendly message. */
export function describeCaptureError(err: unknown): {
  title: string
  message: string
} {
  const e = err as { name?: string; message?: string }
  switch (e?.name) {
    case 'NotAllowedError':
      return {
        title: 'Permission denied',
        message:
          'Access to the requested device was denied. Check the site permissions and try again.',
      }
    case 'NotFoundError':
      return {
        title: 'Device not found',
        message: 'No matching camera, microphone, or screen source was available.',
      }
    case 'NotReadableError':
      return {
        title: 'Device in use',
        message: 'The selected device is busy or being used by another application.',
      }
    case 'OverconstrainedError':
      return {
        title: 'Unsupported settings',
        message:
          'The requested capture constraints are not supported by the selected device.',
      }
    case 'AbortError':
      return {
        title: 'Capture aborted',
        message: 'The capture was cancelled before it could start.',
      }
    default:
      return {
        title: 'Capture failed',
        message: e?.message || 'Something went wrong while starting capture.',
      }
  }
}
