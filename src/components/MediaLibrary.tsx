import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Film,
  Music,
  Image as ImageIcon,
  Upload,
  Loader2,
  Trash2,
  FolderOpen,
  Sparkles,
} from 'lucide-react'
import { useEditor } from '../lib/timeline/store'
import { importFiles } from '../lib/media/import'
import { useToast } from './ui/Toast'
import { ElementsPanel } from './ElementsPanel'

const ACCEPT =
  'video/*,audio/*,image/*,.mp4,.webm,.mov,.mkv,.mp3,.wav,.m4a,.aac,.ogg,.png,.jpg,.jpeg,.gif,.webp,.avif,.json,.lottie'

type LibraryTab = 'media' | 'elements'

export function MediaLibrary() {
  const allSources = useEditor((s) => s.project.sources)
  // Generated caption text, Elements-pack overlays and shapes (one source
  // per clip) live on the timeline, not in the library.
  const sources = useMemo(
    () =>
      allSources.filter(
        (s) => !s.captionFor && s.kind !== 'element' && s.kind !== 'shape',
      ),
    [allSources],
  )
  const [tab, setTab] = useState<LibraryTab>('media')
  const addElementClip = useEditor((s) => s.addElementClip)
  const clips = useEditor((s) => s.project.clips)
  const addSource = useEditor((s) => s.addSource)
  const removeSource = useEditor((s) => s.removeSource)
  const revealedSourceId = useEditor((s) => s.revealedSourceId)
  const clearRevealedSource = useEditor((s) => s.clearRevealedSource)
  const toast = useToast()
  const inputRef = useRef<HTMLInputElement>(null)
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [pulsingId, setPulsingId] = useState<string | null>(null)
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null)
  const [dragActive, setDragActive] = useState(false)
  // Desktop app only: media also lives as real files on disk.
  const diskMedia = window.electronAPI?.media

  const runImport = useCallback(
    async (files: FileList | File[]) => {
      const arr = Array.from(files)
      if (arr.length === 0) return
      setBusy({ done: 0, total: arr.length })
      const {
        sources: imported,
        errors,
        warnings,
      } = await importFiles(arr, (done, total, src) => {
        setBusy({ done, total })
        if (src) addSource(src)
      })
      setBusy(null)
      if (imported.length > 0) {
        toast.success(
          'Imported',
          `${imported.length} file${imported.length === 1 ? '' : 's'} added to library.`,
        )
      }
      for (const w of warnings) {
        toast.info(`${w.name}: may look different`, w.messages.join('; '))
      }
      for (const e of errors) {
        toast.error(`Import failed: ${e.name}`, e.error.message)
      }
    },
    [addSource, toast],
  )

  // Scroll to and briefly pulse a source item when revealed from the timeline.
  useEffect(() => {
    if (!revealedSourceId) return
    const el = itemRefs.current.get(revealedSourceId)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      setPulsingId(revealedSourceId)
      const t = window.setTimeout(() => setPulsingId(null), 1200)
      clearRevealedSource()
      return () => window.clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealedSourceId])

  // Application menu: File → Import media…
  useEffect(() => {
    const onImport = () => {
      if (!busy) inputRef.current?.click()
    }
    window.addEventListener('ir:import-media', onImport)
    return () => window.removeEventListener('ir:import-media', onImport)
  }, [busy])

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (files && files.length) void runImport(files)
    e.target.value = ''
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      setDragActive(true)
    }
  }
  function onDragLeave(e: React.DragEvent<HTMLDivElement>) {
    if (e.currentTarget === e.target) setDragActive(false)
  }
  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    setDragActive(false)
    const files = e.dataTransfer.files
    if (files && files.length) void runImport(files)
  }

  return (
    <div
      className={
        'flex flex-col h-full min-h-0 relative transition-colors ' +
        (dragActive ? 'bg-accent/10' : '')
      }
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div role="tablist" className="flex border-b border-bd">
        {(['media', 'elements'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={
              'flex-1 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] border-b-2 transition-colors ' +
              (tab === t
                ? 'border-accent text-fg'
                : 'border-transparent text-muted hover:text-fg')
            }
          >
            {t === 'media' ? 'Media' : 'Elements'}
          </button>
        ))}
      </div>
      {tab === 'elements' && (
        <ElementsPanel
          onAdd={(templateId) =>
            addElementClip(templateId, useEditor.getState().playhead)
          }
        />
      )}
      <div
        className={
          'px-3 py-2 border-b border-bd flex items-center justify-between ' +
          (tab === 'media' ? '' : 'hidden')
        }
      >
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
          {sources.length} {sources.length === 1 ? 'item' : 'items'}
        </span>
        <div className="flex items-center gap-1">
          {diskMedia && (
            <button
              onClick={() => diskMedia.reveal()}
              className="btn-ghost !p-1 !px-1 text-muted"
              title="Open recordings folder"
              aria-label="Open recordings folder"
            >
              <FolderOpen size={12} />
            </button>
          )}
          <button
            onClick={() => inputRef.current?.click()}
            disabled={!!busy}
            className="btn-ghost !py-0.5 !px-1.5 disabled:opacity-50"
            title="Import media files"
          >
            {busy ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                {busy.done}/{busy.total}
              </>
            ) : (
              <>
                <Upload size={12} /> Import
              </>
            )}
          </button>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          onChange={onPick}
          className="hidden"
        />
      </div>

      <div
        className={
          'flex-1 overflow-auto p-2 space-y-1.5 ' + (tab === 'media' ? '' : 'hidden')
        }
      >
        {sources.length === 0 && (
          <div className="text-center text-xs text-muted px-4 py-8">
            No media yet.
            <br />
            <span className="opacity-70">
              Press <span className="kbd">Record</span> or drop files here.
            </span>
          </div>
        )}
        {sources.map((s) => (
          <div
            key={s.id}
            ref={(el) => {
              if (el) itemRefs.current.set(s.id, el)
              else itemRefs.current.delete(s.id)
            }}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-ir-source', s.id)
              e.dataTransfer.effectAllowed = 'copy'
            }}
            className={
              'group flex items-center gap-2.5 p-2 rounded-md border cursor-grab active:cursor-grabbing transition-colors ' +
              (pulsingId === s.id
                ? 'bg-accent/15 border-accent/60 animate-pulse'
                : 'bg-surface2/60 border-bd hover:border-bd2 hover:bg-surface2')
            }
            title="Drag onto the timeline"
          >
            <div
              className={
                'w-8 h-8 rounded-md flex items-center justify-center shrink-0 ' +
                (s.kind === 'video'
                  ? 'bg-video-soft text-video'
                  : s.kind === 'audio'
                    ? 'bg-audio-soft text-audio'
                    : 'bg-overlay-soft text-overlay')
              }
            >
              {s.kind === 'video' ? (
                <Film size={14} />
              ) : s.kind === 'audio' ? (
                <Music size={14} />
              ) : s.kind === 'animation' ? (
                <Sparkles size={14} />
              ) : (
                <ImageIcon size={14} />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium">{s.name}</div>
              <div className="text-muted font-mono text-[10px] truncate">
                {s.kind === 'animation' && s.animation
                  ? `${s.animation.format.toUpperCase()} · ${s.duration.toFixed(1)}s`
                  : s.duration > 0
                    ? `${s.duration.toFixed(1)}s`
                    : 'image'}
                {s.hasAlpha ? ' · alpha' : ''}
                {s.width ? ` · ${s.width}×${s.height}` : ''}
              </div>
            </div>
            {diskMedia && s.diskPath && (
              <button
                className="opacity-0 group-hover:opacity-100 transition-opacity
                  btn-ghost !p-1 !px-1 text-muted shrink-0"
                title="Show in folder"
                aria-label={`Show "${s.name}" in folder`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  if (s.diskPath) diskMedia.reveal(s.diskPath)
                }}
              >
                <FolderOpen size={12} />
              </button>
            )}
            <button
              className="opacity-0 group-hover:opacity-100 transition-opacity
                btn-ghost !p-1 !px-1 text-muted hover:text-danger shrink-0"
              title="Remove from library"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                const inUse = clips.some((c) => c.sourceId === s.id)
                const msg = inUse
                  ? `"${s.name}" is used by clips on the timeline. Remove it and delete those clips?`
                  : `Remove "${s.name}" from the library?`
                if (!window.confirm(msg)) return
                removeSource(s.id)
                toast.info('Removed', s.name)
              }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>

      {dragActive && (
        <div className="pointer-events-none absolute inset-0 border-2 border-dashed border-accent rounded-md flex items-center justify-center bg-surface/80">
          <div className="text-xs font-medium text-accent-text">Drop to import</div>
        </div>
      )}
    </div>
  )
}
