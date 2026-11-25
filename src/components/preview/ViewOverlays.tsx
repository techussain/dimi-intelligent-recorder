import { useEffect, useRef, useState } from 'react'
import { Check, Eye } from 'lucide-react'
import { SAFE_MARGINS } from '../../lib/layout/snap'
import { useViewPrefs, type ViewPrefs } from './viewPrefs'

const ITEMS: { key: keyof ViewPrefs; label: string }[] = [
  { key: 'rulers', label: 'Rulers' },
  { key: 'safe', label: 'Safe margins' },
  { key: 'thirds', label: 'Rule-of-thirds grid' },
  { key: 'center', label: 'Centre cross' },
]

/** "View" dropdown for the preview's guide overlays. */
export function ViewMenu() {
  const prefs = useViewPrefs()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const active = ITEMS.filter((i) => prefs[i.key]).length

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className={
          'px-2 py-0.5 rounded border inline-flex items-center gap-1 ' +
          (active
            ? 'bg-accent-soft border-accent/40 text-accent-text'
            : 'bg-surface2 border-bd hover:text-fg')
        }
        aria-haspopup="menu"
        aria-expanded={open}
        title="Preview guides: rulers, safe margins, grid"
        onClick={() => {
          setOpen((v) => !v)
        }}
      >
        <Eye size={12} /> View
      </button>
      {open && (
        <div
          role="menu"
          className="absolute bottom-full right-0 mb-1 z-30 min-w-[180px] rounded-lg border border-bd bg-elevated shadow-pop py-1 font-sans text-xs text-fg"
        >
          {ITEMS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitemcheckbox"
              aria-checked={prefs[item.key]}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-white/5 text-left"
              onClick={() => {
                prefs.toggle(item.key)
              }}
            >
              <span className="w-3.5 h-3.5 inline-flex items-center justify-center text-accent-text">
                {prefs[item.key] && <Check size={12} />}
              </span>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Safe margins, thirds grid and centre cross over the picture (no input). */
export function StageGuides({ prefs }: { prefs: ViewPrefs }) {
  if (!prefs.safe && !prefs.thirds && !prefs.center) return null
  return (
    <div
      className="absolute inset-0 pointer-events-none"
      data-preview-overlay="guides"
      aria-hidden
    >
      {prefs.safe &&
        SAFE_MARGINS.map((m) => (
          <div
            key={m.label}
            className="absolute border border-dashed border-white/45"
            style={{
              left: `${m.inset * 100}%`,
              top: `${m.inset * 100}%`,
              right: `${m.inset * 100}%`,
              bottom: `${m.inset * 100}%`,
            }}
          >
            <span className="absolute left-1 top-0.5 text-[9px] font-mono text-white/55">
              {m.label}
            </span>
          </div>
        ))}
      {prefs.thirds && (
        <>
          {[1 / 3, 2 / 3].map((f) => (
            <div
              key={`v${f}`}
              className="absolute top-0 bottom-0 w-px bg-white/35"
              style={{ left: `${f * 100}%` }}
            />
          ))}
          {[1 / 3, 2 / 3].map((f) => (
            <div
              key={`h${f}`}
              className="absolute left-0 right-0 h-px bg-white/35"
              style={{ top: `${f * 100}%` }}
            />
          ))}
        </>
      )}
      {prefs.center && (
        <div className="absolute left-1/2 top-1/2 w-6 h-6 -translate-x-1/2 -translate-y-1/2">
          <div className="absolute left-0 right-0 top-1/2 h-px bg-white/70" />
          <div className="absolute top-0 bottom-0 left-1/2 w-px bg-white/70" />
        </div>
      )}
    </div>
  )
}

/** Pick a tick step (project px) so labelled ticks are >= ~60 screen px apart. */
function rulerStep(pxPerUnit: number): number {
  const steps = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000]
  return steps.find((s) => s * pxPerUnit >= 60) ?? 5000
}

function RulerTicks({
  length,
  displayed,
  vertical,
}: {
  /** Project px along this edge. */
  length: number
  /** Displayed (CSS) px along this edge. */
  displayed: number
  vertical: boolean
}) {
  if (displayed <= 0 || length <= 0) return null
  const k = displayed / length
  const major = rulerStep(k)
  const minor = major / 5
  const ticks: { pos: number; major: boolean }[] = []
  for (let v = 0; v <= length + 0.001; v += minor) {
    const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6
    ticks.push({ pos: v, major: isMajor })
  }
  return (
    <>
      {ticks.map((t) => {
        const at = t.pos * k
        const size = t.major ? 8 : 4
        return (
          <div key={t.pos}>
            <div
              className="absolute bg-muted/70"
              style={
                vertical
                  ? { top: at, right: 0, width: size, height: 1 }
                  : { left: at, bottom: 0, height: size, width: 1 }
              }
            />
            {t.major && (
              <span
                className="absolute text-[8px] leading-none font-mono text-muted"
                style={
                  vertical
                    ? {
                        top: at + 2,
                        left: 1,
                        writingMode: 'vertical-rl',
                        transform: 'rotate(180deg)',
                      }
                    : { left: at + 2, top: 1 }
                }
              >
                {Math.round(t.pos)}
              </span>
            )}
          </div>
        )
      })}
    </>
  )
}

/** Pixel rulers along the top and left edges, outside the stage. */
export function Rulers({
  projectW,
  projectH,
  displayedW,
  displayedH,
}: {
  projectW: number
  projectH: number
  displayedW: number
  displayedH: number
}) {
  return (
    <div className="pointer-events-none" data-preview-overlay="rulers" aria-hidden>
      <div
        className="absolute left-0 right-0 overflow-hidden bg-surface/90 border-b border-bd"
        style={{ bottom: '100%', height: 14 }}
      >
        <RulerTicks length={projectW} displayed={displayedW} vertical={false} />
      </div>
      <div
        className="absolute top-0 bottom-0 overflow-hidden bg-surface/90 border-r border-bd"
        style={{ right: '100%', width: 14 }}
      >
        <RulerTicks length={projectH} displayed={displayedH} vertical />
      </div>
    </div>
  )
}
