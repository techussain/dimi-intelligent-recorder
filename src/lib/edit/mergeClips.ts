/**
 * Merge clips: render a selection of clips (picture + mixed audio, exactly as
 * they play on the timeline) into ONE new media file in OPFS, and replace the
 * selection with a single clip of it. The merged clip is ordinary media, so it
 * can be transcribed as one piece.
 */
import { create } from 'zustand'
import type { StreamTargetChunk } from 'mediabunny'
import { useEditor, uid } from '../timeline/store'
import type { Clip, ID, MediaSource, Project } from '../timeline/types'
import {
  DEFAULT_EXPORT_OPTIONS,
  exportProject,
  type ExportProgress,
} from '../export/render'
import { recordingRelPath, saveToDisk } from '../storage/diskMedia'

export interface MergePlan {
  clipIds: ID[]
  /** Timeline range covered by the selection. */
  start: number
  end: number
  /** true if any clip draws something (video/image/text); else audio-only. */
  hasVisual: boolean
  /** Track the merged clip goes on. */
  targetTrackId: ID
}

function clipEnd(c: Clip): number {
  return (
    c.timelineStart +
    Math.max(0, (c.sourceOut - c.sourceIn) / Math.max(0.1, c.speed || 1))
  )
}

/**
 * Validate a selection and decide where the merged clip goes. Throws an
 * Error with a user-facing message when the selection can't be merged.
 */
export function planMerge(project: Project, ids: readonly ID[]): MergePlan {
  const set = new Set(ids)
  const clips = project.clips.filter((c) => set.has(c.id))
  if (clips.length < 2) throw new Error('Select at least two clips to merge.')
  if (clips.some((c) => c.isLive))
    throw new Error('Stop the recording before merging its clips.')

  const trackIndex = (id: ID) => project.tracks.findIndex((t) => t.id === id)
  const kindOf = (c: Clip) => project.tracks[trackIndex(c.trackId)]?.kind
  const visual = clips.filter((c) => kindOf(c) === 'video' || kindOf(c) === 'overlay')
  const hasVisual = visual.length > 0

  // Visual merge → the bottom-most visual track (the base layer the composite
  // replaces). Audio-only → the top-most selected audio track.
  const candidates = hasVisual ? visual : clips
  const target = [...candidates].sort((a, b) =>
    hasVisual
      ? trackIndex(b.trackId) - trackIndex(a.trackId)
      : trackIndex(a.trackId) - trackIndex(b.trackId),
  )[0]!
  const targetTrack = project.tracks[trackIndex(target.trackId)]
  if (!targetTrack) throw new Error('The selected clips are on a missing track.')
  if (targetTrack.locked)
    throw new Error(`Unlock the "${targetTrack.name}" track to merge onto it.`)

  const start = Math.min(...clips.map((c) => c.timelineStart))
  const end = Math.max(...clips.map(clipEnd))
  if (!(end - start > 0.01)) throw new Error('The selected clips have no length.')
  return {
    clipIds: clips.map((c) => c.id),
    start,
    end,
    hasVisual,
    targetTrackId: targetTrack.id,
  }
}

/**
 * Whether the merged file keeps transparency, so it still sits on top of the
 * footage below instead of covering it with black. It does when:
 * - no merged clip is on a VIDEO (base) track — overlays only (shapes, text,
 *   elements, webcam…): nothing opaque is behind them; or
 * - a merged clip on an OVERLAY track has an alpha source (`hasAlpha`, e.g.
 *   a VP9-alpha WebM).
 * Alpha sources on video tracks (the base layer) don't count.
 */
export function mergeKeepsAlpha(project: Project, plan: MergePlan): boolean {
  if (!plan.hasVisual) return false
  const ids = new Set(plan.clipIds)
  const kindOf = (c: Clip) => project.tracks.find((t) => t.id === c.trackId)?.kind
  const merged = project.clips.filter((c) => ids.has(c.id))
  if (!merged.some((c) => kindOf(c) === 'video')) return true
  return project.clips.some((c) => {
    if (!ids.has(c.id)) return false
    if (project.tracks.find((t) => t.id === c.trackId)?.kind !== 'overlay') return false
    return project.sources.find((s) => s.id === c.sourceId)?.hasAlpha === true
  })
}

/**
 * The project as the renderer should see it for a merge: only the selected
 * clips (and transitions between them), shifted so the range starts at 0.
 */
export function buildMergeProject(project: Project, plan: MergePlan): Project {
  const ids = new Set(plan.clipIds)
  return {
    ...project,
    clips: project.clips
      .filter((c) => ids.has(c.id))
      .map((c) => ({ ...c, timelineStart: c.timelineStart - plan.start })),
    transitions: project.transitions.filter(
      (t) => ids.has(t.fromClipId) && ids.has(t.toClipId),
    ),
    markers: [],
    duration: plan.end - plan.start,
  }
}

// ── Job state (one merge at a time) ─────────────────────────────────────────

export interface MergeJob {
  clipCount: number
  /** 0..1 overall. */
  progress: number
  label: string
}

export const useMergeJob = create<{ job: MergeJob | null }>(() => ({ job: null }))

let abort: AbortController | null = null

export function cancelMerge(): void {
  abort?.abort()
}

function overall(p: ExportProgress, hasVisual: boolean): number {
  // Rough phase weights: audio mix is quick, frames dominate.
  if (!hasVisual) return p.phase === 'finalize' ? 0.95 + p.value * 0.05 : p.value * 0.95
  if (p.phase === 'audio') return p.value * 0.1
  if (p.phase === 'video') return 0.1 + p.value * 0.85
  return 0.95 + p.value * 0.05
}

/**
 * Merge the given clips. Resolves with the new clip id. Rejects with a
 * user-facing message on invalid selection, failure, or cancel ("Merge
 * canceled."). A failed/canceled render leaves no file behind.
 */
export async function mergeClips(ids: readonly ID[]): Promise<ID> {
  if (abort) throw new Error('A merge is already running.')
  const project = useEditor.getState().project
  if (useEditor.getState().recording.active)
    throw new Error('Stop the recording before merging.')
  const plan = planMerge(project, ids)
  const sub = buildMergeProject(project, plan)
  const alpha = mergeKeepsAlpha(project, plan)

  const id = uid()
  const ext = 'webm'
  const opfsPath = `merged/${id}.${ext}`
  const ctl = new AbortController()
  abort = ctl
  useMergeJob.setState({
    job: { clipCount: plan.clipIds.length, progress: 0, label: 'Preparing' },
  })

  // Everything from here on is inside try/finally: any failure (including
  // opening the output file) resets the job, so the next merge can run.
  let dir: FileSystemDirectoryHandle | null = null
  let file: FileSystemWritableFileStream | null = null
  try {
    const root = await navigator.storage.getDirectory()
    dir = await root.getDirectoryHandle('merged', { create: true })
    const handle = await dir.getFileHandle(`${id}.${ext}`, { create: true })
    const out = await handle.createWritable()
    file = out
    // mediabunny writes positioned chunks; forward them to the OPFS file.
    const writable = new WritableStream<StreamTargetChunk>({
      async write(chunk) {
        await out.write({ type: 'write', position: chunk.position, data: chunk.data })
      },
      async close() {
        await out.close()
      },
      async abort() {
        await out.abort().catch(() => {})
      },
    })

    const { skipped } = await exportProject(
      sub,
      {
        ...DEFAULT_EXPORT_OPTIONS,
        width: project.width,
        height: project.height,
        fps: project.fps,
        container: 'webm',
        videoCodec: 'vp9',
        audioCodec: 'opus',
        includeVideo: plan.hasVisual,
        alpha,
      },
      (p) =>
        useMergeJob.setState({
          job: {
            clipCount: plan.clipIds.length,
            progress: overall(p, plan.hasVisual),
            label:
              p.phase === 'audio'
                ? 'Mixing audio'
                : p.phase === 'video'
                  ? 'Rendering'
                  : 'Finishing',
          },
        }),
      ctl.signal,
      writable,
    )
    // The merged clip replaces the originals: never with an incomplete render.
    if (skipped.length > 0) {
      const names = [...new Set(skipped.map((x) => x.name))].join(', ')
      throw new Error(
        `Couldn't merge: some media couldn't be read (${names}). The clips were left as they are.`,
      )
    }

    const duration = plan.end - plan.start
    const source: MediaSource = {
      id,
      kind: plan.hasVisual ? 'video' : 'audio',
      opfsPath,
      mimeType: plan.hasVisual ? 'video/webm' : 'audio/webm',
      duration,
      // A composite of the whole frame: keep it full-frame even when it
      // replaces overlays (otherwise it lands in the overlay PIP box).
      ...(plan.hasVisual
        ? { width: project.width, height: project.height, fullFrame: true }
        : {}),
      ...(alpha ? { hasAlpha: true } : {}),
      createdAt: Date.now(),
      name: `Merged clip (${plan.clipIds.length} clips)`,
    }
    const clipId = useEditor.getState().replaceWithMergedClip(plan.clipIds, source, {
      trackId: plan.targetTrackId,
      timelineStart: plan.start,
    })
    if (!clipId)
      throw new Error(
        'The timeline changed while merging (a clip was removed or recording started).',
      )
    saveMergedToDisk(source, project.name)
    return clipId
  } catch (err) {
    await file?.abort().catch(() => {})
    await dir?.removeEntry(`${id}.${ext}`).catch(() => {})
    if (ctl.signal.aborted) throw new Error('Merge canceled.')
    throw err instanceof Error ? err : new Error(String(err))
  } finally {
    abort = null
    useMergeJob.setState({ job: null })
  }
}

/**
 * Desktop app: save a copy of the merged file into the recordings folder in
 * the background and remember its path. Errors are reported by saveToDisk.
 */
function saveMergedToDisk(source: MediaSource, projectName: string): void {
  const rel = recordingRelPath(
    projectName,
    'Merged',
    new Date(source.createdAt),
    'webm',
  )
  void saveToDisk(source.opfsPath, rel, { what: 'merged clip' }).then((diskPath) => {
    if (!diskPath) return
    const st = useEditor.getState()
    const src = st.project.sources.find((x) => x.id === source.id)
    if (src && src.opfsPath === source.opfsPath)
      st.updateSource(source.id, { diskPath })
  })
}
