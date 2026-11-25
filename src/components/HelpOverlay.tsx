import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useFocusTrap } from '../lib/ui/useFocusTrap'
import pkg from '../../package.json'
import { BrandMark } from './BrandMark'

type Row = { keys: string[]; label: string }

const SECTIONS: { title: string; rows: Row[] }[] = [
  {
    title: 'Transport',
    rows: [
      { keys: ['Space'], label: 'Play / Pause' },
      { keys: ['K'], label: 'Pause' },
      { keys: ['L'], label: 'Play' },
      { keys: ['J'], label: 'Jump back 1 s' },
      { keys: ['←', '→'], label: 'Step 1 frame' },
      { keys: ['⇧', '←/→'], label: 'Step 10 frames' },
      { keys: ['Home', 'End'], label: 'Jump to start / end' },
    ],
  },
  {
    title: 'Editing',
    rows: [
      { keys: ['S'], label: 'Split at playhead' },
      { keys: ['M'], label: 'Add marker' },
      { keys: ['['], label: 'Trim selected clip start to playhead' },
      { keys: [']'], label: 'Trim selected clip end to playhead' },
      { keys: ['Del'], label: 'Delete selected clip(s)' },
      { keys: ['⇧Del'], label: 'Ripple delete' },
      { keys: ['Ctrl', 'Z'], label: 'Undo' },
      { keys: ['Ctrl', '⇧', 'Z'], label: 'Redo' },
    ],
  },
  {
    title: 'Timeline',
    rows: [
      { keys: ['Alt'], label: 'Bypass snap while dragging' },
      { keys: ['Shift', 'click'], label: 'Add to selection' },
      { keys: ['Drag empty'], label: 'Marquee select' },
      { keys: ['Scroll'], label: 'Scroll tracks (⇧ = horizontal)' },
      { keys: ['Ctrl', 'Scroll'], label: 'Zoom (or pinch)' },
    ],
  },
  {
    title: 'Preview',
    rows: [
      { keys: ['⇧/Ctrl', 'click'], label: 'Add / remove object from selection' },
      { keys: ['Alt', 'click'], label: 'Select the object underneath' },
      { keys: ['⇧', 'drag'], label: 'Move along one axis' },
      { keys: ['Ctrl', 'drag'], label: 'Move / resize without snapping' },
      { keys: ['←↑↓→'], label: 'Nudge selection 1 px (preview focused)' },
      { keys: ['⇧', '←↑↓→'], label: 'Nudge selection 10 px' },
      { keys: ['Esc'], label: 'Deselect (preview focused)' },
      { keys: ['⇧', 'corner'], label: 'Resize free / keep aspect (per lock)' },
      { keys: ['Alt', 'resize'], label: 'Resize from the centre' },
    ],
  },
  {
    title: 'Transform',
    rows: [
      { keys: ['C'], label: 'Crop mode for the selected picture (preview focused)' },
      { keys: ['Enter', 'Esc'], label: 'Finish cropping / hide the anchor' },
      { keys: ['Alt'], label: 'Hold to show and drag the anchor point' },
      { keys: ['Toolbar'], label: 'Flip H / V, Fit, Fill, Reset, Crop, Anchor' },
      { keys: ['Inspector'], label: 'W / H (aspect lock), anchor, crop, presets' },
      { keys: ['Inspector'], label: 'Blend mode next to Opacity' },
    ],
  },
  {
    title: 'Layers & clipboard',
    rows: [
      { keys: ['Ctrl', ']'], label: 'Bring forward' },
      { keys: ['Ctrl', '['], label: 'Send backward' },
      { keys: ['Ctrl', '⇧', ']'], label: 'Bring to front' },
      { keys: ['Ctrl', '⇧', '['], label: 'Send to back (stays above the screen)' },
      { keys: ['Ctrl', 'C'], label: 'Copy selected clips' },
      { keys: ['Ctrl', 'X'], label: 'Cut selected clips' },
      { keys: ['Ctrl', 'V'], label: 'Paste clips at the playhead' },
      { keys: ['Ctrl', 'Alt', 'V'], label: 'Paste attributes… onto the selection' },
    ],
  },
  {
    title: 'Shapes',
    rows: [
      {
        keys: ['Elements tab'],
        label: 'Rectangle, ellipse, line, arrow (click / drag)',
      },
      { keys: ['Preview'], label: 'Shapes menu under the preview' },
      { keys: ['Ctrl', 'K'], label: '“Add … shape at playhead”' },
      { keys: ['Inspector'], label: 'Fill / no fill, stroke, width, corner radius' },
    ],
  },
]

function Kbd({ label }: { label: string }) {
  return (
    <span className="px-1.5 py-0.5 rounded bg-surface2 border border-bd text-[10px] font-mono text-fg">
      {label}
    </span>
  )
}

export function HelpOverlay() {
  const [open, setOpen] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef, open)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const tag = t?.tagName
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        t?.isContentEditable
      )
        return
      if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
        e.preventDefault()
        setOpen((v) => !v)
      } else if (e.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    const onToggle = () => setOpen((v) => !v)
    window.addEventListener('keydown', onKey)
    window.addEventListener('ir:toggle-help', onToggle)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('ir:toggle-help', onToggle)
    }
  }, [open])

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={() => setOpen(false)}
    >
      <div
        ref={dialogRef}
        className="bg-elevated border border-bd rounded-xl shadow-pop max-w-2xl w-full max-h-[85vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-bd sticky top-0 bg-elevated">
          <h2 id="help-title" className="text-sm font-semibold">
            Keyboard shortcuts
          </h2>
          <button
            className="p-1 rounded hover:bg-white/5 text-muted hover:text-fg"
            onClick={() => setOpen(false)}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-6">
          {SECTIONS.map((sec) => (
            <div key={sec.title}>
              <h3 className="text-[11px] uppercase tracking-[0.08em] text-muted mb-2">
                {sec.title}
              </h3>
              <ul className="space-y-1.5">
                {sec.rows.map((r, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <span className="text-fg/90">{r.label}</span>
                    <span className="flex items-center gap-1">
                      {r.keys.map((k, j) => (
                        <Kbd key={j} label={k} />
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="px-5 py-3 border-t border-bd text-[11px] text-muted">
          Press <Kbd label="?" /> to toggle · <Kbd label="Esc" /> to close
        </div>
      </div>
    </div>
  )
}

/** Help → About (menu command 'ir:show-about'). */
export function AboutDialog() {
  const [open, setOpen] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef, open)
  useEffect(() => {
    const onShow = () => setOpen(true)
    window.addEventListener('ir:show-about', onShow)
    return () => window.removeEventListener('ir:show-about', onShow)
  }, [])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={() => setOpen(false)}
    >
      <div
        ref={dialogRef}
        className="bg-elevated border border-bd rounded-xl shadow-pop w-full max-w-sm p-5 text-center"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
      >
        <div className="flex justify-center mb-3">
          <BrandMark size={56} />
        </div>
        <h2 id="about-title" className="text-sm font-semibold">
          Dimi Intelligent Recorder
        </h2>
        <p className="text-[11px] text-muted font-mono mt-1">Version {pkg.version}</p>
        <p className="text-xs text-fg/80 mt-3 leading-relaxed">
          Record your screen, mic and webcam while you edit.
        </p>
        <div className="mt-4 pt-3 border-t border-bd text-left">
          <h3 className="text-[11px] uppercase tracking-[0.08em] text-muted mb-1.5">
            Privacy
          </h3>
          <ul className="space-y-1 text-[11px] text-fg/80 leading-relaxed list-disc pl-4">
            <li>
              Recordings, transcripts and edits are processed and stored on this
              computer. No account, analytics or tracking.
            </li>
            <li>
              The speech model downloads once from Hugging Face, only after you agree.
              No audio is sent.
            </li>
            <li>The installed app checks GitHub Releases for updates.</li>
          </ul>
          <p className="text-[10px] text-muted mt-2 leading-relaxed">
            The full privacy notice and third-party licenses are included with the
            installer (PRIVACY.md, THIRD_PARTY_NOTICES.txt).
          </p>
        </div>
        <button className="btn-soft mt-4 mx-auto" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
    </div>
  )
}
