import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Download, RefreshCw, X } from 'lucide-react'
import type { UpdateStatus } from '../lib/electronAPI'

/** How long the "up to date" confirmation of a manual check stays visible. */
const UP_TO_DATE_MS = 4000

/**
 * Auto-update notice (Electron, packaged builds). Silent normally; a small
 * bottom-left chip while an update downloads, and a card once it is ready.
 * "Checking…", "up to date" and errors are only shown for a check the user
 * started (Help ▸ Check for Updates…).
 */
export function UpdateNotice() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [manual, setManual] = useState(false)
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)
  const manualRef = useRef(false)

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.updates) return
    const offStatus = api.updates.onStatus((s) => {
      setStatus(s)
      if (s.state === 'checking') {
        // A new check: user-initiated only if the menu command just came in.
        setManual(manualRef.current)
      } else if (s.state === 'none' || s.state === 'error' || s.state === 'manual') {
        // Result of the check; `manual` stays set so it is shown.
        manualRef.current = false
      } else if (s.state === 'ready') {
        manualRef.current = false
        setManual(false)
      }
    })
    // Main sends this just before it starts a user-initiated check.
    const offMenu = api.menu.onCommand((id) => {
      if (id !== 'check-for-updates') return
      manualRef.current = true
      setManual(true)
      setDismissedVersion(null)
    })
    return () => {
      offStatus()
      offMenu()
    }
  }, [])

  // Auto-hide the "up to date" confirmation.
  useEffect(() => {
    if (!manual || status?.state !== 'none') return
    const t = window.setTimeout(() => setManual(false), UP_TO_DATE_MS)
    return () => window.clearTimeout(t)
  }, [manual, status])

  if (!status) return null

  const chip = (children: ReactNode) => (
    <div
      role="status"
      className="fixed bottom-3 left-3 z-50 inline-flex items-center gap-2 px-2.5 py-1.5
        rounded-md bg-elevated border border-bd shadow-pop text-[11px] text-muted"
    >
      {children}
    </div>
  )

  switch (status.state) {
    case 'checking':
      return manual
        ? chip(
            <>
              <RefreshCw size={12} className="animate-spin" />
              Checking for updates…
            </>,
          )
        : null

    case 'none':
      return manual ? chip(<>You’re on the latest version.</>) : null

    case 'available':
      return chip(
        <>
          <Download size={12} />
          Downloading update {status.version}…
        </>,
      )

    case 'manual':
      // Unsigned build: nothing is downloaded automatically (see updater.cts).
      if (dismissedVersion === status.version) return null
      return (
        <div
          role="status"
          className="fixed bottom-3 left-3 z-50 w-72 bg-elevated border border-bd
            rounded-lg shadow-pop p-3 space-y-2.5"
        >
          <div>
            <p className="text-xs font-medium text-fg">
              Version {status.version} is available
            </p>
            <p className="text-[11px] text-muted mt-0.5">
              Download and run the new installer from the Releases page.
            </p>
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              className="btn-ghost"
              onClick={() => setDismissedVersion(status.version)}
            >
              Later
            </button>
            <button
              className="btn-soft"
              onClick={() => window.electronAPI?.updates.openReleasesPage()}
            >
              Open Releases
            </button>
          </div>
        </div>
      )

    case 'downloading':
      return chip(
        <>
          <Download size={12} />
          Downloading update… {status.percent}%
        </>,
      )

    case 'error':
      if (!manual) return null
      return (
        <div
          role="alert"
          className="fixed bottom-3 left-3 z-50 w-72 bg-elevated border border-bd
            rounded-lg shadow-pop p-3 space-y-2"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs font-medium text-fg">Couldn’t check for updates</p>
            <button
              className="btn-ghost !p-1"
              aria-label="Dismiss"
              onClick={() => setManual(false)}
            >
              <X size={12} />
            </button>
          </div>
          <p className="text-[11px] text-muted break-words">{status.message}</p>
        </div>
      )

    case 'ready':
      if (dismissedVersion === status.version) return null
      return (
        <div
          role="status"
          className="fixed bottom-3 left-3 z-50 w-72 bg-elevated border border-bd
            rounded-lg shadow-pop p-3 space-y-2.5"
        >
          <div>
            <p className="text-xs font-medium text-fg">Update {status.version} ready</p>
            <p className="text-[11px] text-muted mt-0.5">
              Restart to install. Otherwise it installs when you quit.
            </p>
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              className="btn-ghost"
              onClick={() => setDismissedVersion(status.version)}
            >
              Later
            </button>
            <button
              className="btn-soft"
              onClick={() => window.electronAPI?.updates.installAndRestart()}
            >
              Restart
            </button>
          </div>
        </div>
      )
  }
}
