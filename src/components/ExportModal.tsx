import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Archive, Download, X, Loader2 } from 'lucide-react'
import { useEditor } from '../lib/timeline/store'
import {
  exportProject,
  downloadBlob,
  DEFAULT_EXPORT_OPTIONS,
  defaultCodecsFor,
  exportFileInfo,
  probeContainerSupport,
  type ExportOptions,
  type ExportProgress,
} from '../lib/export/render'
import { fitExportSize } from '../lib/export/size'
import { saveProjectBundleWithPrompt } from '../lib/persistence/bundle'
import { useToast } from './ui/Toast'
import { useFocusTrap } from '../lib/ui/useFocusTrap'

type Container = 'webm' | 'mp4'

interface Preset {
  label: string
  width: number
  height: number
  fps: number
}

const PRESETS: Preset[] = [
  { label: '720p30', width: 1280, height: 720, fps: 30 },
  { label: '1080p30', width: 1920, height: 1080, fps: 30 },
  { label: '1080p60', width: 1920, height: 1080, fps: 60 },
  { label: '1440p30', width: 2560, height: 1440, fps: 30 },
  { label: '4K30', width: 3840, height: 2160, fps: 30 },
]

export function ExportModal({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project)
  const toast = useToast()
  const [presetIdx, setPresetIdx] = useState(1)
  const [container, setContainer] = useState<Container>('webm')
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [abortCtl, setAbortCtl] = useState<AbortController | null>(null)
  const [bundlePct, setBundlePct] = useState<number | null>(null)
  // Per-container reason it can't be encoded here (null = supported,
  // undefined = still probing).
  const [support, setSupport] = useState<Partial<Record<Container, string | null>>>({})
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef)

  const busy = !!abortCtl || bundlePct !== null
  const preset = PRESETS[presetIdx]
  // Keep the project's aspect ratio: the preset picks the size class.
  const outSize = useMemo(
    () =>
      preset
        ? fitExportSize(project.width, project.height, preset.width, preset.height)
        : null,
    [preset, project.width, project.height],
  )

  // Probe encoder support for both containers at the chosen output size.
  useEffect(() => {
    if (!outSize) return
    let cancelled = false
    setSupport({})
    void Promise.all(
      (['webm', 'mp4'] as Container[]).map(
        async (c) =>
          [c, await probeContainerSupport(c, outSize.width, outSize.height)] as const,
      ),
    ).then((results) => {
      if (cancelled) return
      const next: Partial<Record<Container, string | null>> = {}
      for (const [c, reason] of results) next[c] = reason
      setSupport(next)
      // Fall back to the other container if the selected one can't encode.
      setContainer((cur) => {
        if (next[cur] == null) return cur
        const other: Container = cur === 'webm' ? 'mp4' : 'webm'
        return next[other] == null ? other : cur
      })
    })
    return () => {
      cancelled = true
    }
  }, [outSize])
  const containerError = support[container]

  // Lock background scroll + close on Escape (when not exporting).
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [busy, onClose])

  const run = useCallback(async () => {
    if (!preset || !outSize) return
    const codecs = defaultCodecsFor(container)
    const opts: ExportOptions = {
      ...DEFAULT_EXPORT_OPTIONS,
      width: outSize.width,
      height: outSize.height,
      fps: preset.fps,
      container,
      videoCodec: codecs.videoCodec,
      audioCodec: codecs.audioCodec,
    }
    const ctl = new AbortController()
    setAbortCtl(ctl)
    setProgress({ phase: 'audio', value: 0, message: 'Starting…' })
    // Set once the save picker succeeded, so a failed/canceled export can
    // remove the partial file it left on disk.
    let discardPartial: (() => Promise<'removed' | 'kept' | 'failed'>) | null = null
    try {
      const info = exportFileInfo(opts)
      const ext = info.extension
      const name =
        project.name.replace(/[^a-z0-9_-]+/gi, '_') + '_' + preset.label + '.' + ext

      // Prefer streaming directly to disk via File System Access API when
      // available; falls back to BufferTarget + download.
      let writable:
        | WritableStream<{
            type: 'write'
            data: Uint8Array<ArrayBuffer>
            position: number
          }>
        | undefined
      let finalize: (() => Promise<void>) | null = null
      const fsAny = window as unknown as {
        showSaveFilePicker?: (opts: {
          suggestedName: string
          types: { description: string; accept: Record<string, string[]> }[]
        }) => Promise<{
          createWritable: () => Promise<FileSystemWritableFileStream>
          getFile: () => Promise<File>
          remove?: () => Promise<void>
        }>
      }
      if (fsAny.showSaveFilePicker) {
        try {
          const handle = await fsAny.showSaveFilePicker({
            suggestedName: name,
            types: [
              {
                description: container === 'mp4' ? 'MP4 video' : 'WebM video',
                accept: { [info.mimeType]: ['.' + ext] },
              },
            ],
          })
          // Did the user pick a file that already has content (e.g. an
          // earlier export)? createWritable() writes to a swap file and only
          // replaces the original on close(), so on failure abort() alone
          // leaves that file intact — it must never be removed or truncated.
          let replacingExisting = true // unknown → assume yes (never destroy)
          try {
            replacingExisting = (await handle.getFile()).size > 0
          } catch {
            /* keep the safe default */
          }
          const fileWritable = await handle.createWritable()
          writable = new WritableStream({
            async write(chunk) {
              await fileWritable.write({
                type: 'write',
                position: chunk.position,
                data: chunk.data,
              })
            },
            async close() {
              await fileWritable.close()
            },
            async abort(reason) {
              try {
                await fileWritable.abort?.(reason)
              } catch {
                /* ignore */
              }
            },
          })
          finalize = async () => {
            /* stream close handled by mediabunny */
          }
          discardPartial = async () => {
            // Drop uncommitted data (mediabunny may already have aborted it).
            try {
              await fileWritable.abort()
            } catch {
              /* already closed/aborted */
            }
            // Existing file: the aborted swap file was its only change, so it
            // is untouched. Report "nothing left behind" without deleting it.
            if (replacingExisting) return 'kept'
            // New (empty) file the picker created: delete it, or at least empty it.
            try {
              if (handle.remove) {
                await handle.remove()
                return 'removed'
              }
            } catch {
              /* fall through to truncation */
            }
            try {
              const w = await handle.createWritable()
              await w.truncate(0)
              await w.close()
              return 'removed'
            } catch {
              return 'failed'
            }
          }
        } catch (err) {
          if (
            err instanceof DOMException &&
            (err.name === 'AbortError' || err.name === 'NotAllowedError')
          ) {
            toast.info('Export canceled')
            setAbortCtl(null)
            setProgress(null)
            return
          }
          // Any other error -> fall back to in-memory buffer path.
          writable = undefined
        }
      }

      const { blob, skipped } = await exportProject(
        project,
        opts,
        setProgress,
        ctl.signal,
        writable,
      )
      await finalize?.()
      if (blob) downloadBlob(blob, name)
      const saved = blob
        ? `${(blob.size / 1024 / 1024).toFixed(1)} MB saved.`
        : `Saved ${name}.`
      if (skipped.length > 0) {
        // Never present an incomplete export as a success.
        const list = skipped
          .slice(0, 4)
          .map((s) => `${s.name} (${s.part === 'audio' ? 'sound' : 'picture'})`)
          .join(', ')
        const more = skipped.length > 4 ? ` and ${skipped.length - 4} more` : ''
        toast.error(
          'Exported with missing media',
          `${saved} These couldn't be read and are missing from the video: ${list}${more}.`,
        )
      } else {
        toast.success('Export complete', saved)
      }
      onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const canceled = msg.includes('canceled')
      let cleanup = ''
      if (discardPartial) {
        const outcome = await discardPartial()
        cleanup =
          outcome === 'removed'
            ? ' The partial file was removed.'
            : outcome === 'kept'
              ? ' The existing file was left unchanged.'
              : ' A partial file may remain at the chosen location — delete it manually.'
      }
      if (canceled) {
        toast.info('Export canceled' + (cleanup ? '.' + cleanup : ''))
      } else {
        toast.error('Export failed', msg + cleanup)
      }
    } finally {
      setAbortCtl(null)
      setProgress(null)
    }
  }, [preset, outSize, container, project, toast, onClose])

  function cancel() {
    abortCtl?.abort()
  }

  const saveBundle = useCallback(async () => {
    setBundlePct(0)
    try {
      if (await saveProjectBundleWithPrompt(project, (pct) => setBundlePct(pct)))
        toast.success('Bundle saved', 'Project + media exported to .irbundle.')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.toLowerCase().includes('abort')) {
        toast.error('Bundle export failed', msg)
      }
    } finally {
      setBundlePct(null)
    }
  }, [project, toast])

  const overallPct = progress
    ? progress.phase === 'audio'
      ? progress.value * 10
      : progress.phase === 'video'
        ? 10 + progress.value * 85
        : 95 + progress.value * 5
    : 0

  return createPortal(
    <div
      className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-150"
      onClick={(e) => {
        if (!busy && e.target === e.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Export video"
    >
      <div
        ref={dialogRef}
        className="w-full max-w-md bg-surface border border-bd rounded-xl shadow-2xl overflow-hidden"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-bd">
          <div className="flex items-center gap-2">
            <Download size={14} />
            <span className="font-semibold text-sm">Export video</span>
          </div>
          {!busy && (
            <button
              className="btn-ghost !py-0.5 !px-1.5"
              onClick={onClose}
              aria-label="Close"
            >
              <X size={14} />
            </button>
          )}
        </div>

        <div className="p-4 space-y-4 text-xs">
          <div>
            <div className="text-muted text-[11px] uppercase tracking-[0.08em] font-semibold mb-2">
              Format
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {(['webm', 'mp4'] as Container[]).map((c) => (
                <button
                  key={c}
                  disabled={busy || !!support[c]}
                  onClick={() => setContainer(c)}
                  title={support[c] ?? undefined}
                  className={
                    'px-2 py-1.5 rounded border text-[11px] font-medium transition-colors ' +
                    (container === c
                      ? 'border-accent bg-accent/15 text-accent-text'
                      : 'border-bd bg-surface2/60 hover:border-bd2') +
                    (busy || support[c] ? ' opacity-50 cursor-not-allowed' : '')
                  }
                >
                  {c === 'webm' ? 'WebM (VP9 + Opus)' : 'MP4 (H.264 + AAC)'}
                </button>
              ))}
            </div>
            {containerError && (
              <div className="mt-1.5 text-[11px] text-danger">
                {containerError}
                {support[container === 'webm' ? 'mp4' : 'webm'] === null &&
                  ' Choose the other format.'}
              </div>
            )}
          </div>

          <div>
            <div className="text-muted text-[11px] uppercase tracking-[0.08em] font-semibold mb-2">
              Preset
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {PRESETS.map((p, i) => (
                <button
                  key={p.label}
                  disabled={busy}
                  onClick={() => setPresetIdx(i)}
                  className={
                    'px-2 py-1.5 rounded border text-[11px] font-medium transition-colors ' +
                    (presetIdx === i
                      ? 'border-accent bg-accent/15 text-accent-text'
                      : 'border-bd bg-surface2/60 hover:border-bd2') +
                    (busy ? ' opacity-50 cursor-not-allowed' : '')
                  }
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="text-[11px] text-muted space-y-1">
            <div>
              <span className="opacity-70">Format:</span>{' '}
              {container === 'webm' ? 'WebM · VP9 + Opus' : 'MP4 · H.264 (AVC) + AAC'}
            </div>
            {outSize && (
              <div>
                <span className="opacity-70">Output size:</span>{' '}
                <span className="font-mono">
                  {outSize.width}×{outSize.height}
                </span>
                {(outSize.width !== preset?.width ||
                  outSize.height !== preset?.height) && (
                  <span className="opacity-70"> (project aspect ratio kept)</span>
                )}
              </div>
            )}
            <div>
              <span className="opacity-70">Duration:</span>{' '}
              <span className="font-mono">{project.duration.toFixed(2)}s</span>
            </div>
            <div>
              <span className="opacity-70">Source clips:</span>{' '}
              <span className="font-mono">{project.clips.length}</span>
            </div>
          </div>

          {progress && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-[11px]">
                <span className="text-muted">{progress.message ?? progress.phase}</span>
                <span className="font-mono">{overallPct.toFixed(0)}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-surface2 overflow-hidden">
                <div
                  className="h-full bg-accent transition-[width] duration-75"
                  style={{ width: `${overallPct}%` }}
                />
              </div>
            </div>
          )}

          {bundlePct !== null && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-[11px]">
                <span className="text-muted">Bundling project…</span>
                <span className="font-mono">{bundlePct}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-surface2 overflow-hidden">
                <div
                  className="h-full bg-accent transition-[width] duration-75"
                  style={{ width: `${bundlePct}%` }}
                />
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            {busy ? (
              <>
                <button className="btn-soft text-danger" onClick={cancel}>
                  Cancel
                </button>
                <button className="btn-primary" disabled>
                  <Loader2 size={12} className="animate-spin" />{' '}
                  {abortCtl ? 'Exporting…' : 'Bundling…'}
                </button>
              </>
            ) : (
              <>
                <button className="btn-soft" onClick={onClose}>
                  Close
                </button>
                <button
                  className="btn-soft"
                  onClick={() => {
                    void saveBundle()
                  }}
                  disabled={project.duration <= 0}
                  title="Save portable .irbundle (project + media)"
                >
                  <Archive size={12} /> Save bundle
                </button>
                <button
                  className="btn-primary"
                  onClick={() => {
                    void run()
                  }}
                  disabled={project.duration <= 0 || containerError !== null}
                  title={
                    project.duration <= 0
                      ? 'Record or import media first'
                      : containerError === undefined
                        ? 'Checking encoder support…'
                        : (containerError ?? 'Export')
                  }
                >
                  <Download size={12} /> Export
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
