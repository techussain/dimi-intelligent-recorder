import { useEffect, useRef, useState } from 'react'
import { FolderOpen, PanelLeft, PanelRight } from 'lucide-react'
import { TopBar } from './TopBar'
import { TitleBar, TITLE_BAR_HEIGHT } from './TitleBar'
import { IS_ELECTRON } from '../lib/capabilities'
import { Preview } from './Preview'
import { MediaLibrary } from './MediaLibrary'
import { Inspector } from './Inspector'
import { Timeline } from './timeline/Timeline'
import { CommandPalette } from './CommandPalette'
import { MergeProgress } from './MergeProgress'
import { UpdateNotice } from './UpdateNotice'
import { AboutDialog } from './HelpOverlay'
import { PasteAttributesDialog } from './PasteAttributesDialog'
import { useViewport } from '../lib/ui/useViewport'
import { restoreLastProject, useAutosave } from '../lib/persistence/useAutosave'
import { installMediaGc } from '../lib/storage/mediaGc'
import { installTakeRecovery } from '../lib/capture/recovery'
import { useToast } from './ui/Toast'

const MIN_TIMELINE = 180
const MAX_TIMELINE_RATIO = 0.72

export function EditorShell() {
  const vp = useViewport()
  // On tablet (<1024 logical), collapse both panels by default.
  const [leftOpen, setLeftOpen] = useState(vp.isDesktop)
  const [rightOpen, setRightOpen] = useState(vp.isDesktop)
  const [timelineH, setTimelineH] = useState(320)

  // Restore last session on mount; autosave from then on.
  useEffect(() => {
    void restoreLastProject()
  }, [])
  useAutosave()
  useEffect(() => installMediaGc(), [])
  // Finish takes interrupted by a crash (see lib/capture/recovery.ts).
  const toast = useToast()
  useEffect(
    () =>
      installTakeRecovery((tracks) => {
        toast.info(
          'Recovering an interrupted recording',
          `The app closed while recording. Restoring ${
            tracks === 1 ? 'the recorded track' : `${tracks} recorded tracks`
          } up to that moment.`,
        )
      }),
    [toast],
  )

  useEffect(() => {
    if (!vp.isDesktop) {
      setLeftOpen(false)
      setRightOpen(false)
    }
  }, [vp.isDesktop])

  // Handle menu-driven panel toggles.
  useEffect(() => {
    const onToggleLib = () => setLeftOpen((v) => !v)
    const onToggleInsp = () => setRightOpen((v) => !v)
    window.addEventListener('ir:toggle-library', onToggleLib)
    window.addEventListener('ir:toggle-inspector', onToggleInsp)
    return () => {
      window.removeEventListener('ir:toggle-library', onToggleLib)
      window.removeEventListener('ir:toggle-inspector', onToggleInsp)
    }
  }, [])

  // Menu "Import media…": the library's file picker only exists while the
  // media panel is mounted, so open the panel first and re-dispatch once it
  // has rendered (MediaLibrary handles the event itself when open).
  const leftOpenRef = useRef(leftOpen)
  useEffect(() => {
    leftOpenRef.current = leftOpen
  }, [leftOpen])
  useEffect(() => {
    let timer = 0
    const onImport = () => {
      if (leftOpenRef.current) return
      setLeftOpen(true)
      timer = window.setTimeout(
        () => window.dispatchEvent(new CustomEvent('ir:import-media')),
        50,
      )
    }
    window.addEventListener('ir:import-media', onImport)
    return () => {
      window.removeEventListener('ir:import-media', onImport)
      window.clearTimeout(timer)
    }
  }, [])

  // Vertical resize between stage and timeline. Pointer capture keeps the
  // drag (and its pointerup) routed here even if released outside the window.
  function startVerticalDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: PointerEvent) => {
      const maxH = Math.floor(window.innerHeight * MAX_TIMELINE_RATIO)
      const next = Math.max(
        MIN_TIMELINE,
        Math.min(maxH, window.innerHeight - ev.clientY),
      )
      setTimelineH(next)
    }
    const onUp = () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      handle.removeEventListener('lostpointercapture', onUp)
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
    handle.addEventListener('lostpointercapture', onUp)
  }

  const leftWidth = leftOpen ? 280 : 0
  const rightWidth = rightOpen ? 320 : 0

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden">
      <TitleBar />
      <TopBar
        leftOpen={leftOpen}
        rightOpen={rightOpen}
        onToggleLeft={() => setLeftOpen((v) => !v)}
        onToggleRight={() => setRightOpen((v) => !v)}
      />

      <div
        className="flex-1 min-h-0 grid gap-2 p-2"
        style={{
          gridTemplateColumns: `${leftWidth}px 1fr ${rightWidth}px`,
          transition: 'grid-template-columns 220ms ease',
        }}
      >
        {leftOpen && (
          <Sidebar side="left" title="Media" onClose={() => setLeftOpen(false)}>
            <MediaLibrary />
          </Sidebar>
        )}

        <main className="panel flex flex-col min-w-0 min-h-0 overflow-hidden">
          <Preview />
        </main>

        {rightOpen && (
          <Sidebar side="right" title="Inspector" onClose={() => setRightOpen(false)}>
            <Inspector />
          </Sidebar>
        )}
      </div>

      {/* Vertical divider between stage and timeline */}
      <div
        onPointerDown={startVerticalDrag}
        className="h-1.5 mx-2 rounded-full bg-transparent hover:bg-bd cursor-row-resize transition-colors touch-none"
        title="Drag to resize"
      />

      <div
        className="px-2 pb-2 min-h-0"
        style={{ height: timelineH, transition: 'height 120ms ease' }}
      >
        <div className="panel h-full overflow-hidden">
          <Timeline />
        </div>
      </div>

      {/* Floating panel toggles when a side is closed */}
      {!leftOpen && (
        <FloatingToggle
          side="left"
          icon={<FolderOpen size={14} />}
          label="Media"
          onClick={() => setLeftOpen(true)}
        />
      )}
      {!rightOpen && (
        <FloatingToggle
          side="right"
          icon={<PanelRight size={14} />}
          label="Inspector"
          onClick={() => setRightOpen(true)}
        />
      )}
      <CommandPalette
        onOpenExport={() => window.dispatchEvent(new CustomEvent('ir:open-export'))}
        onToggleHelp={() => window.dispatchEvent(new CustomEvent('ir:toggle-help'))}
        onToggleLeft={() => setLeftOpen((v) => !v)}
        onToggleRight={() => setRightOpen((v) => !v)}
      />
      <AboutDialog />
      <PasteAttributesDialog />
      <MergeProgress />
      <UpdateNotice />
    </div>
  )
}

function Sidebar({
  side,
  title,
  onClose,
  children,
}: {
  side: 'left' | 'right'
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <aside className="panel flex flex-col min-h-0 overflow-hidden">
      <div className="panel-header">
        <span>{title}</span>
        <button
          onClick={onClose}
          className="btn-ghost !px-1.5 !py-0.5"
          title={`Hide ${title}`}
        >
          {side === 'left' ? <PanelLeft size={14} /> : <PanelRight size={14} />}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
    </aside>
  )
}

function FloatingToggle({
  side,
  icon,
  label,
  onClick,
}: {
  side: 'left' | 'right'
  icon: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      // 64px below the window top, plus the custom title bar in Electron.
      style={{ top: 64 + (IS_ELECTRON ? TITLE_BAR_HEIGHT : 0) }}
      className={
        'absolute z-20 btn-soft shadow-pop ' + (side === 'left' ? 'left-2' : 'right-2')
      }
    >
      {icon} {label}
    </button>
  )
}
