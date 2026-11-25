import { useCallback, useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { BrandMark } from './BrandMark'
import { useEditor } from '../lib/timeline/store'
import type { MenuModelItem } from '../lib/electronAPI'

/**
 * Custom window title bar for the Electron build (Adobe-style): app mark,
 * in-app menu bar, centered document title. Replaces the native frame.
 *
 * - Windows/Linux: the native caption buttons are kept through Electron's
 *   `titleBarOverlay` (Snap Layouts, correct hit-testing); this bar leaves room
 *   for them on the right. The menu bar is generated from the real application
 *   menu (`menu.getModel()`), and choosing an item runs the native MenuItem.
 * - macOS: the traffic lights stay on the left and the menu stays in the
 *   system menu bar, as in Adobe's Mac apps — only the title is shown here.
 *
 * Rendered only in Electron; the browser build has its own chrome.
 */

/** Must match TITLE_BAR_HEIGHT in electron/main.cts. */
export const TITLE_BAR_HEIGHT = 36
/** Room for macOS traffic lights (hiddenInset, trafficLightPosition x:14). */
const MAC_TRAFFIC_LIGHTS_WIDTH = 78
/** Fallback width of the Windows caption buttons if WCO geometry is missing. */
const CAPTION_BUTTONS_FALLBACK = 138

/** Title-bar colors per theme; light = the dark colors after the root invert. */
const TITLE_BAR_COLORS = {
  dark: { color: '#0e1014', symbolColor: '#c9ccd3' },
  light: { color: '#edeff3', symbolColor: '#30333a' },
} as const

export function TitleBar() {
  const api = window.electronAPI
  const isMac = api?.platform === 'darwin'
  const projectName = useEditor((s) => s.project.name)
  const recording = useEditor((s) => s.recording.active)
  const paused = useEditor((s) => s.recording.paused)
  const [focused, setFocused] = useState(() => document.hasFocus())
  const rightInset = useCaptionButtonsInset(!isMac)

  const title = `${projectName.trim() || 'Untitled Project'} — Dimi Intelligent Recorder`

  // Taskbar / Alt+Tab title follows the project.
  useEffect(() => {
    document.title = title
  }, [title])

  // Dim the title when the window is inactive, like native title bars.
  useEffect(() => {
    const onFocus = () => setFocused(true)
    const onBlur = () => setFocused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // Keep the native caption buttons in step with the light/dark theme.
  useEffect(() => {
    if (!api || isMac) return
    const root = document.documentElement
    const apply = () => {
      const theme = root.dataset.theme === 'light' ? 'light' : 'dark'
      api.window.setTitleBarColors(TITLE_BAR_COLORS[theme])
    }
    apply()
    const obs = new MutationObserver(apply)
    obs.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [api, isMac])

  if (!api) return null

  return (
    <div
      className="relative shrink-0 flex items-center select-none border-b border-bd"
      style={{
        height: TITLE_BAR_HEIGHT,
        background: TITLE_BAR_COLORS.dark.color,
        WebkitAppRegion: 'drag',
        paddingLeft: isMac ? MAC_TRAFFIC_LIGHTS_WIDTH : 8,
        paddingRight: rightInset,
      }}
    >
      {!isMac && (
        <>
          <span className="mr-2 flex">
            <BrandMark size={20} />
          </span>
          <MenuBar />
        </>
      )}

      {/* Centered document title. Not interactive, so it stays draggable. */}
      <div
        className={
          'absolute inset-y-0 left-1/2 -translate-x-1/2 flex items-center gap-2 text-xs ' +
          'pointer-events-none max-w-[45%] ' +
          (focused ? 'text-fg/80' : 'text-muted/70')
        }
      >
        {recording && (
          <span className="flex items-center gap-1 text-danger font-medium shrink-0">
            <span
              className={
                'inline-block w-1.5 h-1.5 rounded-full bg-danger ' +
                (paused ? '' : 'rec-dot')
              }
            />
            {paused ? 'PAUSED' : 'REC'}
          </span>
        )}
        <span className="truncate">{title}</span>
      </div>
    </div>
  )
}

/**
 * Width to reserve on the right for the native caption buttons, from the
 * Window Controls Overlay geometry (updates on resize / fullscreen).
 */
function useCaptionButtonsInset(enabled: boolean): number {
  const [inset, setInset] = useState(enabled ? CAPTION_BUTTONS_FALLBACK : 0)
  useEffect(() => {
    if (!enabled) return
    const wco = (
      navigator as Navigator & {
        windowControlsOverlay?: EventTarget & {
          visible: boolean
          getTitlebarAreaRect(): DOMRect
        }
      }
    ).windowControlsOverlay
    if (!wco) return
    const update = () => {
      if (!wco.visible) {
        setInset(0) // e.g. fullscreen: no caption buttons
        return
      }
      const r = wco.getTitlebarAreaRect()
      setInset(Math.max(0, Math.round(window.innerWidth - (r.x + r.width))))
    }
    update()
    wco.addEventListener('geometrychange', update)
    window.addEventListener('resize', update)
    return () => {
      wco.removeEventListener('geometrychange', update)
      window.removeEventListener('resize', update)
    }
  }, [enabled])
  return inset
}

// ── Menu bar ───────────────────────────────────────────────────────────────

/** 'CmdOrCtrl+Shift+S' → 'Ctrl+Shift+S' (the menu bar is Windows/Linux only). */
function formatAccelerator(accel: string): string {
  return accel
    .replace(/CommandOrControl|CmdOrCtrl|Command|Cmd/g, 'Ctrl')
    .replace(/Control/g, 'Ctrl')
    .replace(/Plus/g, '+')
    .replace(/Delete/g, 'Del')
}

/** Default shortcuts of Electron role items (their `accelerator` is unset). */
const ROLE_ACCELERATORS: Record<string, string> = {
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Y',
  cut: 'Ctrl+X',
  copy: 'Ctrl+C',
  paste: 'Ctrl+V',
  selectall: 'Ctrl+A',
  togglefullscreen: 'F11',
  quit: 'Alt+F4',
}

function acceleratorLabel(item: MenuModelItem): string | null {
  if (item.accelerator) return formatAccelerator(item.accelerator)
  return item.role ? (ROLE_ACCELERATORS[item.role.toLowerCase()] ?? null) : null
}

function isActionable(item: MenuModelItem | undefined): boolean {
  return !!item && item.type !== 'separator' && item.enabled
}

function MenuBar() {
  const api = window.electronAPI
  const [model, setModel] = useState<MenuModelItem[]>([])
  /** Index of the open top-level menu, or null. */
  const [open, setOpen] = useState<number | null>(null)
  /** Highlighted item inside the open menu (-1 = none). */
  const [active, setActive] = useState(-1)
  /** Keyboard mode: Alt pressed, top-level buttons focusable, none open. */
  const [armed, setArmed] = useState<number | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const topRefs = useRef<(HTMLButtonElement | null)[]>([])
  /** Element focused before keyboard navigation took focus — restored after. */
  const returnFocus = useRef<HTMLElement | null>(null)

  const loadModel = useCallback(() => {
    if (!api) return
    api.menu
      .getModel()
      .then((m) => setModel(m.filter((x) => x.submenu && x.submenu.length > 0)))
      .catch(() => setModel([]))
  }, [api])

  useEffect(loadModel, [loadModel])

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(null)
    setActive(-1)
    setArmed(null)
    if (restoreFocus && returnFocus.current?.isConnected) returnFocus.current.focus()
    returnFocus.current = null
  }, [])

  const activate = useCallback(
    (item: MenuModelItem) => {
      if (!api || !isActionable(item) || item.submenu) return
      // Restore focus first so role items (copy, paste, select all…) act on
      // whatever the user was working in, not on the menu.
      close(true)
      api.menu.click(item.path)
    },
    [api, close],
  )

  const openMenu = useCallback(
    (index: number, highlightFirst: boolean) => {
      if (model.length === 0) {
        loadModel()
        return
      }
      const i = (index + model.length) % model.length
      setOpen(i)
      setArmed(null)
      const items = model[i]?.submenu ?? []
      setActive(highlightFirst ? items.findIndex(isActionable) : -1)
    },
    [model, loadModel],
  )

  // Close on outside pointer, window blur.
  useEffect(() => {
    if (open === null && armed === null) return
    const onPointer = (e: PointerEvent) => {
      if (!barRef.current?.contains(e.target as Node)) close(false)
    }
    const onBlur = () => close(false)
    document.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [open, armed, close])

  // Keyboard: Alt alone arms the bar (Windows convention), Alt+letter opens a
  // menu by its first letter, arrows/Enter/Escape navigate.
  useEffect(() => {
    let altAlone = false
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        altAlone = !e.ctrlKey && !e.shiftKey && !e.metaKey
        return
      }
      altAlone = false

      if (
        e.altKey &&
        !e.ctrlKey &&
        !e.shiftKey &&
        !e.metaKey &&
        /^[a-z]$/i.test(e.key)
      ) {
        const i = model.findIndex(
          (m) => m.label[0]?.toLowerCase() === e.key.toLowerCase(),
        )
        if (i >= 0) {
          e.preventDefault()
          returnFocus.current ??= document.activeElement as HTMLElement | null
          openMenu(i, true)
        }
        return
      }

      if (open !== null) {
        const items = model[open]?.submenu ?? []
        const step = (dir: 1 | -1) => {
          if (!items.some(isActionable)) return
          let i = active
          do i = (i + dir + items.length) % items.length
          while (!isActionable(items[i]))
          setActive(i)
        }
        switch (e.key) {
          case 'ArrowDown':
            step(1)
            break
          case 'ArrowUp':
            step(-1)
            break
          case 'ArrowRight':
            openMenu(open + 1, true)
            break
          case 'ArrowLeft':
            openMenu(open - 1, true)
            break
          case 'Enter':
          case ' ': {
            const item = items[active]
            if (item) activate(item)
            break
          }
          case 'Escape':
            close(true)
            break
          default:
            return
        }
        e.preventDefault()
        e.stopPropagation()
        return
      }

      if (armed !== null) {
        switch (e.key) {
          case 'ArrowRight':
            setArmed((armed + 1) % model.length)
            break
          case 'ArrowLeft':
            setArmed((armed - 1 + model.length) % model.length)
            break
          case 'ArrowDown':
          case 'Enter':
          case ' ':
            openMenu(armed, true)
            break
          case 'Escape':
            close(true)
            break
          default:
            return
        }
        e.preventDefault()
        e.stopPropagation()
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== 'Alt' || !altAlone) return
      altAlone = false
      if (open !== null || armed !== null) {
        close(true)
        return
      }
      if (model.length === 0) return
      e.preventDefault()
      returnFocus.current = document.activeElement as HTMLElement | null
      setArmed(0)
    }
    // Capture phase: menu navigation must win over timeline shortcuts.
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
    }
  }, [model, open, active, armed, openMenu, activate, close])

  // Move DOM focus to the armed/open top-level button for screen readers.
  useEffect(() => {
    const i = open ?? armed
    if (i !== null) topRefs.current[i]?.focus()
  }, [open, armed])

  if (model.length === 0) return null

  return (
    <div
      ref={barRef}
      role="menubar"
      aria-label="Application menu"
      className="flex items-stretch h-full"
      style={{ WebkitAppRegion: 'no-drag' }}
    >
      {model.map((top, i) => {
        const isOpen = open === i
        return (
          <div key={top.path.join('.')} className="relative flex">
            <button
              ref={(el) => {
                topRefs.current[i] = el
              }}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={isOpen}
              tabIndex={armed === i || isOpen ? 0 : -1}
              // Don't take focus on pointer press — keeps role items (copy,
              // paste…) targeting the user's current field.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => (isOpen ? close(false) : openMenu(i, false))}
              onMouseEnter={() => {
                if (open !== null && !isOpen) openMenu(i, false)
              }}
              className={
                'px-2.5 my-1 rounded text-[13px] leading-none outline-none ' +
                (isOpen || armed === i
                  ? 'bg-white/10 text-fg'
                  : 'text-fg/80 hover:bg-white/5 hover:text-fg')
              }
            >
              {top.label}
            </button>
            {isOpen && top.submenu && (
              <MenuDropdown
                items={top.submenu}
                active={active}
                onHover={setActive}
                onActivate={activate}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

function MenuDropdown({
  items,
  active,
  onHover,
  onActivate,
}: {
  items: MenuModelItem[]
  active: number
  onHover: (i: number) => void
  onActivate: (item: MenuModelItem) => void
}) {
  return (
    <div
      role="menu"
      className="absolute left-0 top-full mt-px z-[10000] min-w-[240px] py-1
        rounded-md border border-bd2 bg-elevated shadow-pop text-[13px]"
    >
      {items.map((item, i) => {
        if (item.type === 'separator')
          return (
            <div
              key={item.path.join('.')}
              role="separator"
              className="my-1 h-px bg-bd"
            />
          )
        const disabled = !item.enabled
        const accel = acceleratorLabel(item)
        return (
          <div
            key={item.path.join('.')}
            role={item.type === 'checkbox' ? 'menuitemcheckbox' : 'menuitem'}
            aria-disabled={disabled || undefined}
            aria-checked={item.type === 'checkbox' ? item.checked : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => onHover(disabled ? -1 : i)}
            onClick={() => onActivate(item)}
            className={
              'flex items-center gap-2 pl-2 pr-3 py-1.5 mx-1 rounded ' +
              (disabled
                ? 'text-muted/50 cursor-default'
                : active === i
                  ? 'bg-accent text-white cursor-default'
                  : 'text-fg cursor-default')
            }
          >
            <span className="w-4 flex justify-center shrink-0">
              {item.checked && <Check size={12} />}
            </span>
            <span className="flex-1 whitespace-nowrap">{item.label}</span>
            {accel && (
              <span
                className={
                  'pl-6 text-xs whitespace-nowrap ' +
                  (active === i && !disabled ? 'text-white/80' : 'text-muted')
                }
              >
                {accel}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
