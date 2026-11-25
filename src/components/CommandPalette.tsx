import { Command } from 'cmdk'
import { useEffect, useRef, useState } from 'react'
import { useEditor } from '../lib/timeline/store'
import {
  listRecent,
  loadStoredProject,
  openProjectFromFile,
  saveProjectToFile,
  type RecentEntry,
} from '../lib/persistence/project'
import {
  openProjectBundle,
  saveProjectBundleWithPrompt,
} from '../lib/persistence/bundle'
import { useToast } from './ui/Toast'
import { useFocusTrap } from '../lib/ui/useFocusTrap'
import { useMergeClips } from './MergeProgress'
import { analyzeSource, pausesForClip, removePauses } from '../lib/silence/analyze'
import {
  DEFAULT_MIN_SILENCE_SEC,
  DEFAULT_PADDING_SEC,
  autoThreshold,
} from '../lib/silence/detect'
import {
  ensureModelConsent,
  exportCaptionsSrt,
  generateCaptions,
  transcribeSource,
} from '../lib/transcribe/transcriber'
import type { Project } from '../lib/timeline/types'
import { copyFromCommand, pasteClipboard } from '../lib/timeline/clipboardEvents'
import {
  ARRANGE_LABELS,
  PASTE_ATTRIBUTES_EVENT,
  arrangeSelection,
} from '../lib/layout/actions'
import type { LayerDirection } from '../lib/timeline/layerOrder'
import { SHAPE_LABELS, SHAPE_TYPES } from '../lib/shapes'

const ARRANGE_HINTS: Record<LayerDirection, string> = {
  forward: 'Ctrl+]',
  backward: 'Ctrl+[',
  front: 'Ctrl+Shift+]',
  back: 'Ctrl+Shift+[',
}

export function CommandPalette({
  onOpenExport,
  onToggleHelp,
  onToggleLeft,
  onToggleRight,
}: {
  onOpenExport: () => void
  onToggleHelp: () => void
  onToggleLeft: () => void
  onToggleRight: () => void
}) {
  const [open, setOpen] = useState(false)
  const toast = useToast()
  const mergeClips = useMergeClips()
  const store = useEditor
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef, open)
  const [recent, setRecent] = useState<RecentEntry[]>([])
  const currentProjectId = useEditor((s) => s.project.id)

  // Refresh the recent-projects list each time the palette opens.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    listRecent()
      .then((r) => {
        if (!cancelled) setRecent(r)
      })
      .catch(() => {
        if (!cancelled) setRecent([])
      })
    return () => {
      cancelled = true
    }
  }, [open])

  /** loadProject refuses while recording; surface that instead of no-oping. */
  function loadOrThrow(p: Project) {
    if (!store.getState().loadProject(p))
      throw new Error('Stop the recording before opening another project.')
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === 'k'
      ) {
        const t = e.target as HTMLElement | null
        const tag = t?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return
        e.preventDefault()
        setOpen((o) => !o)
      }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Also open via application menu command.
  useEffect(() => {
    const onMenuOpen = () => setOpen(true)
    window.addEventListener('ir:open-command-palette', onMenuOpen)
    return () => window.removeEventListener('ir:open-command-palette', onMenuOpen)
  }, [])

  function run(fn: () => void | Promise<void>) {
    setOpen(false)
    void Promise.resolve()
      .then(fn)
      .catch((err: unknown) =>
        toast.error('Command failed', err instanceof Error ? err.message : String(err)),
      )
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center pt-[12vh] bg-black/50"
      onClick={() => setOpen(false)}
    >
      <div
        ref={dialogRef}
        className="w-[520px] max-w-[92vw] rounded-xl border border-bd bg-surface shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <Command label="Command palette" className="flex flex-col">
          <Command.Input
            autoFocus
            placeholder="Type a command…"
            className="w-full bg-transparent px-4 py-3 text-sm border-b border-bd outline-none placeholder:text-muted"
          />
          <Command.List className="max-h-[50vh] overflow-auto p-1 text-sm">
            <Command.Empty className="px-3 py-6 text-center text-muted">
              No results.
            </Command.Empty>

            <Command.Group heading="Project" className="cp-group">
              <Item
                label="New project"
                hint="Ctrl+N"
                onSelect={() =>
                  run(() => {
                    if (store.getState().recording.active)
                      throw new Error(
                        'Stop the recording before starting a new project.',
                      )
                    if (
                      window.confirm(
                        'Start a new project? Current work is autosaved and stays under Recent projects.',
                      )
                    )
                      store.getState().newProject()
                  })
                }
              />
              <Item
                label="Open .irproj…"
                onSelect={() =>
                  run(async () => {
                    const p = await openProjectFromFile()
                    if (p) loadOrThrow(p)
                  })
                }
              />
              <Item
                label="Save .irproj…"
                onSelect={() =>
                  run(async () => {
                    await saveProjectToFile(store.getState().project)
                  })
                }
              />
              <Item
                label="Open .irbundle… (portable)"
                onSelect={() =>
                  run(async () => {
                    const p = await openProjectBundle()
                    if (p) loadOrThrow(p)
                  })
                }
              />
              <Item
                label="Save .irbundle… (portable)"
                onSelect={() =>
                  run(async () => {
                    await saveProjectBundleWithPrompt(store.getState().project)
                  })
                }
              />
            </Command.Group>

            {recent.some((r) => r.id !== currentProjectId) && (
              <Command.Group heading="Recent projects" className="cp-group">
                {recent
                  .filter((r) => r.id !== currentProjectId)
                  .slice(0, 20)
                  .map((r) => (
                    <Item
                      key={r.id}
                      value={`recent-${r.id} ${r.name}`}
                      label={`Open recent: ${r.name || 'Untitled Project'}`}
                      hint={new Date(r.updatedAt).toLocaleDateString()}
                      onSelect={() =>
                        run(async () => {
                          const p = await loadStoredProject(r.id)
                          if (!p)
                            throw new Error('That project is no longer available.')
                          loadOrThrow(p)
                          toast.success('Project opened', p.name)
                        })
                      }
                    />
                  ))}
              </Command.Group>
            )}

            <Command.Group heading="Edit" className="cp-group">
              <Item
                label="Undo"
                hint="Ctrl+Z"
                onSelect={() => run(() => store.getState().undo())}
              />
              <Item
                label="Redo"
                hint="Ctrl+Shift+Z"
                onSelect={() => run(() => store.getState().redo())}
              />
              <Item
                label="Split at playhead"
                hint="S"
                onSelect={() =>
                  run(() => {
                    const s = store.getState()
                    s.splitAt(s.playhead)
                  })
                }
              />
              <Item
                label="Delete selection"
                hint="Del"
                onSelect={() =>
                  run(() => {
                    const s = store.getState()
                    if (!s.selection.length) return
                    // One undo step for the whole selection.
                    s.beginInteraction()
                    try {
                      for (const id of s.selection) s.removeClip(id)
                    } finally {
                      s.endInteraction()
                    }
                  })
                }
              />
              <Item
                label="Copy selected clips"
                hint="Ctrl+C"
                onSelect={() =>
                  run(() => {
                    if (copyFromCommand() === 0)
                      throw new Error('Select clips to copy.')
                  })
                }
              />
              <Item
                label="Cut selected clips"
                hint="Ctrl+X"
                onSelect={() =>
                  run(() => {
                    if (copyFromCommand(true) === 0)
                      throw new Error('Select clips to cut.')
                  })
                }
              />
              <Item
                label="Paste clips at playhead"
                hint="Ctrl+V"
                onSelect={() =>
                  run(() => {
                    const r = pasteClipboard(null)
                    if (!r) throw new Error('Nothing to paste — copy clips first.')
                    if (r.skipped > 0)
                      toast.info(
                        `${String(r.skipped)} clip(s) not pasted`,
                        'Their media isn’t in this project.',
                      )
                  })
                }
              />
              <Item
                label="Paste attributes…"
                hint="Ctrl+Alt+V"
                onSelect={() =>
                  run(() => {
                    window.dispatchEvent(new CustomEvent(PASTE_ATTRIBUTES_EVENT))
                  })
                }
              />
              {(['forward', 'backward', 'front', 'back'] as const).map((dir) => (
                <Item
                  key={dir}
                  label={ARRANGE_LABELS[dir]}
                  hint={ARRANGE_HINTS[dir]}
                  onSelect={() =>
                    run(() => {
                      arrangeSelection(dir)
                    })
                  }
                />
              ))}
              <Item
                label="Link selected clips"
                onSelect={() =>
                  run(() => {
                    const s = store.getState()
                    if (s.selection.length >= 2) s.linkClips(s.selection)
                  })
                }
              />
              <Item
                label="Unlink selected clips"
                onSelect={() =>
                  run(() => {
                    const s = store.getState()
                    s.unlinkClips(s.selection)
                  })
                }
              />
            </Command.Group>

            <Command.Group heading="Clips" className="cp-group">
              <Item
                label="Merge selected clips into one"
                onSelect={() =>
                  run(() => {
                    const sel = store.getState().selection
                    if (sel.length < 2)
                      throw new Error('Select at least two clips to merge.')
                    mergeClips(sel)
                  })
                }
              />
            </Command.Group>

            {window.electronAPI && (
              <Command.Group heading="App" className="cp-group">
                <Item
                  label="Open recordings folder"
                  onSelect={() => run(() => window.electronAPI?.media.reveal())}
                />
                <Item
                  label="Change recordings folder…"
                  onSelect={() =>
                    run(async () => {
                      const folder = await window.electronAPI?.media.chooseFolder()
                      if (folder) toast.success('Recordings folder changed', folder)
                    })
                  }
                />
                <Item
                  label="Open logs folder"
                  onSelect={() =>
                    run(() => window.electronAPI?.diagnostics.openLogsFolder())
                  }
                />
                <Item
                  label="Check for updates"
                  onSelect={() => run(() => window.electronAPI?.updates.checkNow())}
                />
              </Command.Group>
            )}

            <Command.Group heading="Silence" className="cp-group">
              <Item
                label="Remove pauses in selected clip (auto settings)"
                onSelect={() =>
                  run(async () => {
                    const s = store.getState()
                    const clip = s.project.clips.find((c) => s.selection.includes(c.id))
                    const src =
                      clip && s.project.sources.find((x) => x.id === clip.sourceId)
                    if (
                      !clip ||
                      !src?.opfsPath ||
                      (src.kind !== 'audio' && src.kind !== 'video')
                    )
                      throw new Error('Select an audio or video clip first.')
                    const env = await analyzeSource(src.id, src.opfsPath)
                    const pauses = pausesForClip(clip, env, {
                      thresholdDb: autoThreshold(env.db),
                      minSilenceSec: DEFAULT_MIN_SILENCE_SEC,
                      paddingSec: DEFAULT_PADDING_SEC,
                    })
                    if (pauses.length === 0) {
                      toast.info(
                        'No pauses found',
                        'Try the Silence settings in the Inspector.',
                      )
                      return
                    }
                    const r = removePauses(pauses)
                    toast.success(
                      `Removed ${r.count} pauses (${r.removedSec.toFixed(1)}s)`,
                      'Cut from every track to stay in sync. Undo restores them.',
                    )
                  })
                }
              />
            </Command.Group>

            <Command.Group heading="Captions" className="cp-group">
              <Item
                label="Transcribe selected clip"
                onSelect={() =>
                  run(async () => {
                    const s = store.getState()
                    const clip = s.project.clips.find((c) => s.selection.includes(c.id))
                    if (!clip) throw new Error('Select an audio or video clip first.')
                    if (!ensureModelConsent()) return
                    toast.info('Transcribing…', 'Progress is shown in the Inspector.')
                    const n = await transcribeSource(clip.sourceId)
                    toast.success('Transcript ready', `${n} segments`)
                  })
                }
              />
              <Item
                label="Generate captions from transcripts"
                onSelect={() =>
                  run(() => {
                    const n = generateCaptions()
                    toast.success(
                      'Captions added',
                      `${n} captions on the Captions track.`,
                    )
                  })
                }
              />
              <Item
                label="Export captions (.srt)"
                onSelect={() => run(exportCaptionsSrt)}
              />
            </Command.Group>

            <Command.Group heading="Insert" className="cp-group">
              <Item
                label="Add text clip at playhead"
                onSelect={() =>
                  run(() => {
                    const s = store.getState()
                    s.addTextClip(null, s.playhead)
                  })
                }
              />
              {SHAPE_TYPES.map((type) => (
                <Item
                  key={type}
                  label={`Add ${SHAPE_LABELS[type].toLowerCase()} shape at playhead`}
                  onSelect={() =>
                    run(() => {
                      store.getState().addShapeClip(type)
                    })
                  }
                />
              ))}
              <Item
                label="Add video track"
                onSelect={() =>
                  run(() => {
                    store.getState().addTrack('video', 'Video')
                  })
                }
              />
              <Item
                label="Add audio track"
                onSelect={() =>
                  run(() => {
                    store.getState().addTrack('audio', 'Audio')
                  })
                }
              />
              <Item
                label="Add overlay track"
                onSelect={() =>
                  run(() => {
                    store.getState().addTrack('overlay', 'Overlay')
                  })
                }
              />
            </Command.Group>

            <Command.Group heading="View" className="cp-group">
              <Item label="Toggle media panel" onSelect={() => run(onToggleLeft)} />
              <Item label="Toggle inspector" onSelect={() => run(onToggleRight)} />
              <Item
                label="Export video…"
                hint="Ctrl+E"
                onSelect={() => run(onOpenExport)}
              />
              <Item
                label="Show help / shortcuts"
                hint="?"
                onSelect={() => run(onToggleHelp)}
              />
              <Item
                label="Toggle light/dark theme"
                onSelect={() =>
                  run(() => {
                    const root = document.documentElement
                    const next = root.dataset.theme === 'light' ? 'dark' : 'light'
                    root.dataset.theme = next
                    try {
                      localStorage.setItem('ir-theme', next)
                    } catch {
                      // ignore
                    }
                  })
                }
              />
            </Command.Group>

            <Command.Group heading="Playback" className="cp-group">
              <Item
                label="Play / Pause"
                hint="Space"
                onSelect={() =>
                  run(() => {
                    const s = store.getState()
                    s.setPlaying(!s.playing)
                  })
                }
              />
              <Item
                label="Go to start"
                hint="Home"
                onSelect={() => run(() => store.getState().setPlayhead(0))}
              />
              <Item
                label="Go to end"
                hint="End"
                onSelect={() =>
                  run(() => {
                    const s = store.getState()
                    s.setPlayhead(s.project.duration)
                  })
                }
              />
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  )
}

function Item({
  label,
  hint,
  value,
  onSelect,
}: {
  label: string
  hint?: string
  /** Unique cmdk value; defaults to the label. */
  value?: string
  onSelect: () => void
}) {
  return (
    <Command.Item
      value={value ?? label}
      onSelect={onSelect}
      className="flex items-center justify-between px-3 py-2 rounded cursor-pointer
        aria-selected:bg-accent/15 aria-selected:text-accent-text
        hover:bg-white/5"
    >
      <span>{label}</span>
      {hint && <kbd className="font-mono text-[10px] text-muted">{hint}</kbd>}
    </Command.Item>
  )
}
