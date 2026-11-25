import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { produce } from 'immer'
import type {
  BlendMode,
  Clip,
  ClipCrop,
  ColorAdjust,
  ID,
  Keyframe,
  KeyframeProp,
  Marker,
  MediaSource,
  Project,
  ShapeInfo,
  ShapeType,
  TextStyle,
  Track,
  TrackKind,
  Transition,
  Transcript,
} from './types'
import { identityTransform } from './types'
import { splitKeyframes } from './keyframeSplit'
import { duplicateClipData } from './duplicate'
import {
  cutTimeRanges,
  lockedTracksAffected,
  normalizeRanges,
  type TimeRange,
} from './cutRanges'
import { releaseAll as releaseBlobCache } from '../storage/blobCache'
import {
  effectAllowedFor,
  normalizeEffect,
  type ClipEffect,
  type EffectPatch,
} from '../effects/types'
import { splitEffects, zoomOverlaps } from '../effects/edit'
import { getTemplate, resolveParams } from '../elements'
import { DEFAULT_TEXT_FONT } from '../text/fonts'
import {
  SHAPE_DEFAULT_DURATION,
  SHAPE_LABELS,
  defaultShape,
  normalizeShape,
} from '../shapes'
import { reorderClipsIn, type LayerDirection } from './layerOrder'
import { changesLockedClips, lockedTrackIds } from './locks'
import { anchorRecordedClip } from './recordedClip'
import {
  pasteAttributesInto,
  pasteInto,
  type AttributeSelection,
  type AttributeSource,
  type ClipboardPayload,
} from './clipboard'

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function defaultProject(): Project {
  const now = Date.now()
  // Track order is stacking order: the top track is drawn on top (see
  // buildScene). The webcam overlay (V2) must sit above the screen (V1), or
  // the full-frame screen recording hides it.
  const tracks: Track[] = [
    {
      id: uid(),
      kind: 'overlay',
      name: 'V2 · Webcam',
      muted: false,
      locked: false,
      height: 56,
      role: 'webcam',
    },
    {
      id: uid(),
      kind: 'video',
      name: 'V1 · Screen',
      muted: false,
      locked: false,
      height: 72,
      role: 'screen',
    },
    {
      id: uid(),
      kind: 'audio',
      name: 'A1 · System',
      muted: false,
      locked: false,
      height: 48,
      role: 'system-audio',
    },
    {
      id: uid(),
      kind: 'audio',
      name: 'A2 · Mic',
      muted: false,
      locked: false,
      height: 48,
      role: 'mic',
    },
  ]
  return {
    id: uid(),
    name: 'Untitled Project',
    fps: 30,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    tracks,
    clips: [],
    transitions: [],
    sources: [],
    duration: 0,
    createdAt: now,
    updatedAt: now,
  }
}

export interface RecordingState {
  active: boolean
  paused: boolean
  startedAt: number | null
  /** Wall-clock ms when the current pause started (null while running). */
  pausedAt: number | null
  /** Total ms spent paused since startedAt. */
  pausedAccumMs: number
  /** Map trackId → live elapsed seconds already captured into clips. */
  trackCursor: Record<ID, number>
}

interface HistoryEntry {
  project: Project
  selection: ID[]
  /**
   * Redo entries only: media sources the undone edit had removed (e.g. a
   * removeSource). Redo must not bring these back — see keepLibraryMedia.
   */
  removedMedia?: ID[]
}

/** Source fields that describe the media file itself (see updateSource). */
type SourceMediaPatch = Partial<Omit<MediaSource, 'id' | 'name' | 'text'>>

/**
 * One clip's part of a `setTransforms` call. In `patch`, an optional field
 * set to undefined is removed (e.g. the anchor on Reset).
 */
export interface TransformPatch {
  id: ID
  patch: Partial<Clip['transform']>
  /** New crop; null removes it; absent leaves it alone. */
  crop?: ClipCrop | null | undefined
  /** Negate these props' keyframe values as well (flip). */
  negateKeyframes?: readonly ('scaleX' | 'scaleY')[] | undefined
}

function sameCrop(a: ClipCrop | undefined, b: ClipCrop): boolean {
  return (
    !!a &&
    a.left === b.left &&
    a.top === b.top &&
    a.right === b.right &&
    a.bottom === b.bottom
  )
}

/**
 * A take that was still recording when its project was last saved (the app
 * crashed or was killed mid-take). Found by loadProject; finalized by
 * capture/recovery.ts like a normally stopped take.
 */
export interface InterruptedTake {
  sourceId: ID
  clipId: ID
  opfsPath: string
  /** The clip's sourceOut as saved (the last checkpoint's estimate). */
  estimatedDurationSec: number
  /** The take never stopped: footage past the checkpoint is at the end. */
  interrupted: true
}

export interface EditorState {
  project: Project
  selection: ID[]
  playhead: number
  playing: boolean
  zoom: number // pixels per second
  recording: RecordingState

  /** Undo stack (most-recent last). */
  past: HistoryEntry[]
  /** Redo stack (most-recent last = next redo). */
  future: HistoryEntry[]
  /** When >0, mutations coalesce into a single undo entry (drag gesture). */
  _interactionDepth: number
  /** Snapshot captured at beginInteraction; committed to past on end. */
  _interactionSnapshot: HistoryEntry | null

  // ---------- project ops ----------
  /** Returns false (and does nothing) while a recording is in progress. */
  newProject(): boolean
  /** Returns false (and does nothing) while a recording is in progress. */
  loadProject(project: Project): boolean
  /** Consecutive name edits (typing) coalesce into one undo step. */
  setProjectName(name: string): void

  // ---------- source ops ----------
  addSource(source: MediaSource): void
  removeSource(id: ID): void
  /**
   * Patch a source. `name`/`text` changes are undoable; media fields
   * (opfsPath, duration, dimensions, …) are not — they are applied to the
   * undo/redo snapshots too, so undo never brings back a stale file path.
   */
  updateSource(id: ID, patch: Partial<Omit<MediaSource, 'id'>>): void
  /** Undoable text edit for a text source (typing coalesces into one step). */
  updateTextStyle(sourceId: ID, patch: Partial<TextStyle>): void

  // ---------- track ops ----------
  addTrack(
    kind: TrackKind,
    name?: string,
    opts?: { beforeTrackId?: ID; role?: Track['role'] },
  ): ID
  removeTrack(id: ID): void
  updateTrack(id: ID, patch: Partial<Omit<Track, 'id'>>): void
  moveTrack(id: ID, delta: number): void

  // ---------- clip ops ----------
  addClip(clip: Omit<Clip, 'id'>): ID
  removeClip(id: ID): void
  /** Remove several clips as one undo step (live clips are skipped). */
  removeClips(ids: ID[]): void
  rippleDeleteClip(id: ID): void
  /** Ripple-delete several clips as one undo step (live clips are skipped). */
  rippleDeleteClips(ids: ID[]): void
  splitAt(time: number, trackIds?: ID[], clipIds?: ID[]): void
  trimClip(id: ID, edge: 'start' | 'end', delta: number): void
  /**
   * Move a clip (and its link group) in time. `deltaTrackIndex` moves only
   * this clip, and only onto a compatible, unlocked track.
   */
  moveClip(id: ID, deltaTime: number, deltaTrackIndex?: number): void
  /** Move many clips (plus their link groups) in time as one undo step. */
  moveClips(ids: ID[], deltaTime: number): void
  updateClip(id: ID, patch: Partial<Omit<Clip, 'id' | 'trackId' | 'sourceId'>>): void
  setTransform(id: ID, patch: Partial<Clip['transform']>): void
  /**
   * Patch several clips' transforms as ONE undo step (align, distribute,
   * multi-object move, nudge, flip, fit, crop). Live clips are skipped;
   * nothing is recorded when no value changes. With `coalesceKey`, a quick
   * run of calls with the same key (e.g. arrow-key nudges) shares one undo
   * step. Per item, `crop` sets (or with null removes) the clip's crop, and
   * `negateKeyframes` mirrors those props' keyframe values too (flip).
   */
  setTransforms(patches: readonly TransformPatch[], coalesceKey?: string): void
  setColor(id: ID, patch: Partial<ColorAdjust>): void
  // ---------- effects ----------
  /**
   * Add an effect to a clip (values are normalized). Returns its id, or null
   * when refused: unknown/live clip, an effect type the source kind can't
   * take, a second Fade, or a zoom overlapping another zoom.
   */
  addEffect(clipId: ID, effect: ClipEffect): ID | null
  /** Patch an effect. Returns false (no change) if refused, e.g. a zoom overlap. */
  updateEffect(
    clipId: ID,
    effectId: ID,
    patch: EffectPatch,
    /** Quick runs of edits with the same key share one undo step. */
    coalesceKey?: string,
  ): boolean
  removeEffect(clipId: ID, effectId: ID): void
  /** Flip an effect's `enabled` flag. */
  toggleEffect(clipId: ID, effectId: ID): void
  setKeyframe(id: ID, prop: KeyframeProp, kf: Keyframe): void
  removeKeyframe(id: ID, prop: KeyframeProp, t: number): void
  /** Link clips; groups any of them already belong to are merged in. */
  linkClips(ids: ID[]): void
  unlinkClips(ids: ID[]): void
  addTextClip(trackId: ID | null, timelineStart: number, style?: Partial<TextStyle>): ID
  /**
   * Add an Elements-pack overlay: one new `element` source per clip plus a
   * clip on an overlay track (the topmost with room at that time; a new one
   * is created on top if none). One undo step. Null for an unknown template.
   */
  addElementClip(
    templateId: string,
    timelineStart: number,
    trackId?: ID | null,
  ): ID | null
  /** Undoable edit of an element source's parameters (typing coalesces). */
  updateElementParams(sourceId: ID, patch: Record<string, string | number>): void
  /**
   * Add a vector shape at `timelineStart` (default: the playhead): one new
   * `shape` source per clip on the topmost overlay track with room (a new
   * one on top if none). One undo step; the new clip is selected.
   */
  addShapeClip(type: ShapeType, timelineStart?: number, trackId?: ID | null): ID
  /**
   * Undoable edit of a shape source (values clamped). Quick runs of edits to
   * the same shape (colour / slider drags) coalesce into one undo step.
   */
  updateShape(sourceId: ID, patch: Partial<ShapeInfo>): void
  /**
   * Duplicate a clip as a new clip at `timelineStart` (one undo step).
   * Text / element / shape sources are cloned so editing the copy never
   * changes the original.
   */
  duplicateClip(clipId: ID, timelineStart: number): ID | null
  /**
   * Layer order: move visual clips one layer up / down or to the front /
   * back by changing their track (rules in layerOrder.ts). One undo step;
   * returns how many clips moved.
   */
  reorderClips(ids: readonly ID[], dir: LayerDirection): number
  reorderClip(id: ID, dir: LayerDirection): number
  /**
   * Paste copied clips at `at` (default: the playhead), keeping relative
   * times and tracks (rules in clipboard.ts). One undo step; the new clips
   * are selected. Per-clip sources are cloned, media is referenced.
   */
  pasteClips(payload: ClipboardPayload, at?: number): { ids: ID[]; skipped: number }
  /** Apply attributes of a copied clip to `targetIds` (default: selection). One undo step. */
  pasteAttributes(
    from: AttributeSource,
    sel: AttributeSelection,
    targetIds?: readonly ID[],
  ): number
  /** Set the blend mode of clips as one undo step ('normal' removes it). */
  setBlendMode(ids: readonly ID[], mode: BlendMode): void
  extendLiveClip(clipId: ID, sourceOut: number): void
  finalizeLiveClips(sourceId?: ID): void
  updateSourceDuration(sourceId: ID, duration: number): void

  /**
   * Replace `clipIds` with one clip of an already-rendered merged `source`,
   * placed at `at`, as a single undo step (undo restores the originals; the
   * merged media stays in the library). Returns the new clip id, or null if
   * refused (recording, a live clip, or a missing clip/track).
   */
  replaceWithMergedClip(
    clipIds: ID[],
    source: MediaSource,
    at: { trackId: ID; timelineStart: number },
  ): ID | null

  /**
   * Ripple-cut time ranges out of every track (keeps sync), one undo step.
   * Refused while recording or when a locked track would change.
   */
  removeTimeRanges(
    ranges: TimeRange[],
  ): { ok: true; removedSec: number; count: number } | { ok: false; reason: string }

  // ---------- transcripts / captions ----------
  /**
   * Store (or with null, remove) a source's transcript. Not an undoable edit:
   * transcripts are derived data and survive undo/redo.
   */
  setTranscript(sourceId: ID, transcript: Transcript | null): void
  /**
   * Replace everything on the Captions track (created at the top if missing)
   * with one text clip per cue, as a single undo step. Returns the count.
   */
  setCaptions(
    cues: { start: number; end: number; text: string }[],
    style: { text: TextStyle; y: number },
  ): number
  /**
   * Correct a finished take's clip to the real media length, without an undo
   * step (see anchorRecordedClip: the clip keeps its end, the source window
   * shifts). Applied to the current project and every history snapshot, but
   * only where the clip still ends at `fromSourceOut` (i.e. untrimmed).
   */
  reconcileRecordedClip(
    clipId: ID,
    fromSourceOut: number,
    toSourceOut: number,
    keepEnd?: boolean,
  ): void

  // ---------- transition ops ----------
  addTransition(t: Omit<Transition, 'id'>): ID
  removeTransition(id: ID): void
  updateTransition(id: ID, patch: Partial<Omit<Transition, 'id'>>): void

  // ---------- marker ops ----------
  addMarker(m: Omit<Marker, 'id'>): ID
  removeMarker(id: ID): void
  updateMarker(id: ID, patch: Partial<Omit<Marker, 'id'>>): void

  // ---------- selection ops ----------
  setSelection(ids: ID[]): void

  // ---------- library reveal ----------
  /** Source ID to highlight / scroll to in MediaLibrary. Cleared after consumption. */
  revealedSourceId: ID | null
  revealSource(sourceId: ID): void
  clearRevealedSource(): void

  // ---------- crash recovery ----------
  /** Interrupted takes found by the last loadProject, waiting to be finalized. */
  interruptedTakes: { projectId: ID; takes: InterruptedTake[] } | null
  /** Return and clear `interruptedTakes`. */
  takeInterruptedTakes(): { projectId: ID; takes: InterruptedTake[] } | null

  // ---------- transport ----------
  setPlayhead(t: number): void
  setPlaying(p: boolean): void
  setZoom(z: number): void

  // ---------- recording state ----------
  startRecording(): void
  pauseRecording(): void
  resumeRecording(): void
  stopRecording(): void

  // ---------- history ----------
  /** Group multiple mutations into a single undo step (e.g. drag gesture). */
  beginInteraction(): void
  endInteraction(): void
  /**
   * Force-close any open interaction (e.g. a missed pointerup), committing
   * its undo step if it changed anything. Safe to call at any time.
   */
  resetInteraction(): void
  /** No-op while recording or while an interaction is open. */
  undo(): void
  /** No-op while recording or while an interaction is open. */
  redo(): void
  canUndo(): boolean
  canRedo(): boolean
}

function durationOf(clip: Clip): number {
  return Math.max(0, (clip.sourceOut - clip.sourceIn) / Math.max(0.1, clip.speed ?? 1))
}

function recomputeDuration(project: Project): void {
  let end = 0
  for (const c of project.clips) {
    const e = c.timelineStart + durationOf(c)
    if (e > end) end = e
  }
  project.duration = end
}

const HISTORY_LIMIT = 100
/** Consecutive edits with the same coalesce key within this window share one undo step. */
const COALESCE_MS = 1000

/**
 * Library media (sources backed by an OPFS file) is not rolled back by
 * undo/redo. Imports and recordings are added without a history entry, so a
 * plain snapshot swap would silently drop media added since that snapshot —
 * and the next edit would clear redo, losing it for good. Keep every media
 * source that exists now, preferring the current record (fresher duration).
 * Sources only the snapshot has (e.g. undoing a removeSource) come back.
 * `removedMedia` (redo) lists sources the redone edit itself removed: those
 * stay removed instead of being kept as "added since the snapshot".
 *
 * Snapshots are frozen (shared with the history stacks), so this returns a
 * new project when anything differs instead of mutating `restored`.
 */
function keepLibraryMedia(
  restored: Project,
  current: Project,
  removedMedia?: readonly ID[],
): Project {
  const removed = new Set(removedMedia)
  const cur = new Map(current.sources.map((x) => [x.id, x]))
  const restoredIds = new Set(restored.sources.map((x) => x.id))
  let changed = false
  const sources = restored.sources.map((x) => {
    const c = x.opfsPath ? cur.get(x.id) : undefined
    if (!c || c === x) return x
    changed = true
    // The display name is user-edited (updateSource) and does roll back.
    return c.name === x.name ? c : { ...c, name: x.name }
  })
  for (const x of current.sources) {
    if (x.opfsPath && !restoredIds.has(x.id) && !removed.has(x.id)) {
      sources.push(x)
      changed = true
    }
  }
  // Transcripts are derived data (set without history): keep the current ones.
  if (current.transcripts !== restored.transcripts) {
    const next: Project = { ...restored, sources }
    if (current.transcripts) next.transcripts = current.transcripts
    else delete next.transcripts
    return next
  }
  return changed ? { ...restored, sources } : restored
}

/** True if `clipId` is a clip the recorder is still writing. */
function isLiveClip(project: Project, clipId: ID): boolean {
  return project.clips.some((c) => c.id === clipId && c.isLive === true)
}

/**
 * Upper bound for a clip's sourceOut: the source's duration for timed media
 * (video/audio/animation with a known duration). Text/image/element sources
 * are unbounded, and so is a looping animation clip (it repeats past the end
 * of the asset).
 */
function maxSourceOut(
  project: Project,
  clip: Pick<Clip, 'sourceId' | 'loop'>,
): number | undefined {
  const src = project.sources.find((x) => x.id === clip.sourceId)
  if (!src) return undefined
  if (src.kind === 'animation') {
    if (clip.loop) return undefined
  } else if (src.kind !== 'video' && src.kind !== 'audio') return undefined
  return src.duration > 0 ? src.duration : undefined
}

/**
 * Track for a new per-clip overlay (element / shape) over [start, start+dur):
 * `trackId` if it is a free, unlocked overlay track, else the topmost such
 * track with room (earlier tracks paint on top), else a new overlay track
 * named `newName` on top. With `avoidRoles`, built-in recording tracks (the
 * webcam track) are not picked automatically, so a later take can't collide
 * with the object and the object isn't buried under the screen track.
 */
function overlayTrackFor(
  project: Project,
  start: number,
  dur: number,
  trackId: ID | null | undefined,
  newName: string,
  avoidRoles = false,
): ID {
  const free = (tid: ID) =>
    !project.clips.some(
      (c) =>
        c.trackId === tid &&
        start < c.timelineStart + durationOf(c) &&
        start + dur > c.timelineStart,
    )
  const wanted = trackId ? project.tracks.find((t) => t.id === trackId) : undefined
  if (wanted && wanted.kind === 'overlay' && !wanted.locked && free(wanted.id))
    return wanted.id
  const found = project.tracks.find(
    (t) => t.kind === 'overlay' && !t.locked && !(avoidRoles && t.role) && free(t.id),
  )
  if (found) return found.id
  const tid = uid()
  project.tracks.unshift({
    id: tid,
    kind: 'overlay',
    name: newName,
    muted: false,
    locked: false,
    height: 56,
  })
  return tid
}

/** Clips on these track kinds may be moved between each other. */
function trackFamily(kind: TrackKind): 'audio' | 'visual' {
  return kind === 'audio' ? 'audio' : 'visual'
}

/** `ids` plus every clip sharing a link group with one of them. */
function withLinked(project: Project, ids: ID[]): Set<ID> {
  const idSet = new Set(ids)
  const groups = new Set<ID>()
  for (const c of project.clips) {
    if (idSet.has(c.id) && c.linkGroup) groups.add(c.linkGroup)
  }
  const out = new Set<ID>()
  for (const c of project.clips) {
    if (idSet.has(c.id) || (c.linkGroup && groups.has(c.linkGroup))) out.add(c.id)
  }
  return out
}

/** Shift `targets` by `deltaTime`, clamped so none starts before 0. */
function shiftClips(project: Project, targets: Set<ID>, deltaTime: number): void {
  let clamped = deltaTime
  for (const c of project.clips) {
    if (targets.has(c.id) && c.timelineStart + clamped < 0) clamped = -c.timelineStart
  }
  if (clamped === 0) return
  for (const c of project.clips) {
    if (targets.has(c.id)) c.timelineStart = Math.max(0, c.timelineStart + clamped)
  }
}

export const useEditor = create<EditorState>()(
  immer((set, get) => {
    /** Push `entry` onto the undo stack (clears redo). Caller checks depth. */
    const record = (s: EditorState, entry: HistoryEntry) => {
      s.past.push(entry)
      if (s.past.length > HISTORY_LIMIT) s.past.shift()
      s.future = []
    }

    /**
     * Record the current state onto the undo stack unless inside an
     * interaction. Only for steps that are not themselves a project edit
     * (startRecording); edits go through `edit`.
     *
     * History entries are the frozen Immer project objects themselves —
     * structurally shared with the live state, never deep-cloned.
     */
    const pushHistory = () => {
      const st = get()
      if (st._interactionDepth > 0) return // grouped, captured at begin
      set((s) => {
        record(s, { project: st.project, selection: st.selection })
      })
    }

    /** Last coalescable edit: its key, the entry it pushed, and when. */
    let coalesce: { key: string; entry: HistoryEntry | undefined; at: number } | null =
      null

    /**
     * Apply an undoable project edit. Immer keeps the project reference when
     * the recipe changed nothing, so a no-op (missing id, unchanged value)
     * pushes no undo entry and leaves updatedAt alone.
     *
     * With `coalesceKey`, a run of edits with the same key (e.g. keystrokes
     * in a name field) less than COALESCE_MS apart shares one undo step.
     *
     * Track locks are enforced here, for every caller: an edit that would add,
     * remove, change or move a clip on a locked track is refused as a whole
     * (returns false, nothing changes). `opts.ignoreLocks` is for explicit
     * actions on the container itself (deleting a source from the library).
     */
    const edit = (
      recipe: (s: EditorState) => void,
      coalesceKey?: string,
      opts?: { ignoreLocks?: boolean },
    ): boolean => {
      const before = get()
      const next = produce(before, recipe)
      if (next.project === before.project) return false
      if (!opts?.ignoreLocks && changesLockedClips(before.project, next.project)) {
        return false
      }
      set(next, true)
      const now = Date.now()
      const top = before.past[before.past.length - 1]
      const merge =
        coalesceKey !== undefined &&
        coalesce !== null &&
        coalesce.key === coalesceKey &&
        coalesce.entry === top &&
        top !== undefined &&
        before.future.length === 0 &&
        now - coalesce.at < COALESCE_MS
      set((s) => {
        s.project.updatedAt = now
        if (s._interactionDepth === 0 && !merge) {
          record(s, { project: before.project, selection: before.selection })
        }
      })
      if (coalesceKey === undefined) coalesce = null
      else {
        const st = get()
        coalesce = { key: coalesceKey, entry: st.past[st.past.length - 1], at: now }
      }
      return true
    }

    /**
     * Apply a non-undoable media patch to a source in the live project AND in
     * every history snapshot, so undo/redo can never restore stale media
     * metadata (e.g. a pre-remux opfsPath).
     */
    const patchSourceMedia = (id: ID, patch: SourceMediaPatch) => {
      set((s) => {
        const projects = [
          s.project,
          ...s.past.map((e) => e.project),
          ...s.future.map((e) => e.project),
        ]
        if (s._interactionSnapshot) projects.push(s._interactionSnapshot.project)
        for (const p of projects) {
          const src = p.sources.find((x) => x.id === id)
          if (src) Object.assign(src, patch)
        }
      })
    }

    /** Close the outermost interaction, committing its step if it changed anything. */
    const closeInteraction = () => {
      const st = get()
      const snap = st._interactionSnapshot
      const changed = !!snap && snap.project !== st.project
      set((s) => {
        s._interactionDepth = 0
        s._interactionSnapshot = null
        if (changed && snap) record(s, snap)
      })
      coalesce = null
    }

    return {
      project: defaultProject(),
      selection: [],
      revealedSourceId: null,
      interruptedTakes: null,
      playhead: 0,
      playing: false,
      zoom: 100,
      recording: {
        active: false,
        paused: false,
        startedAt: null,
        pausedAt: null,
        pausedAccumMs: 0,
        trackCursor: {},
      },
      past: [],
      future: [],
      _interactionDepth: 0,
      _interactionSnapshot: null,

      newProject() {
        if (get().recording.active) return false
        // Release all cached blob URLs from the previous project (as loadProject does).
        releaseBlobCache()
        coalesce = null
        set((s) => {
          s.project = defaultProject()
          s.selection = []
          s.playhead = 0
          s.playing = false
          s.recording = {
            active: false,
            paused: false,
            startedAt: null,
            pausedAt: null,
            pausedAccumMs: 0,
            trackCursor: {},
          }
          s.past = []
          s.future = []
          s._interactionDepth = 0
          s._interactionSnapshot = null
        })
        return true
      },
      loadProject(project) {
        // Swapping the project mid-take would orphan the recorder's live clips.
        if (get().recording.active) return false
        // Release all cached blob URLs from the previous project so we don't
        // accumulate O(n) object URLs across project switches.
        releaseBlobCache()
        coalesce = null
        // Clips still marked live were saved by a checkpoint mid-take and the
        // take never stopped (crash / kill). Hand them to crash recovery,
        // which finalizes them like a normally stopped take.
        const interrupted: InterruptedTake[] = []
        for (const c of project.clips) {
          if (!c.isLive) continue
          const src = project.sources.find((x) => x.id === c.sourceId)
          if (src?.opfsPath)
            interrupted.push({
              sourceId: src.id,
              clipId: c.id,
              opfsPath: src.opfsPath,
              estimatedDurationSec: c.sourceOut,
              interrupted: true,
            })
        }
        set((s) => {
          s.project = project
          s.interruptedTakes =
            interrupted.length > 0
              ? { projectId: project.id, takes: interrupted }
              : null
          // Clear the `isLive` flags: a stuck-live clip is skipped by the
          // compositor and refused by splitAt, so it would otherwise be
          // permanently invisible/uneditable.
          for (const c of s.project.clips) if (c.isLive) c.isLive = false
          s.selection = []
          s.playhead = 0
          s.playing = false
          s.recording = {
            active: false,
            paused: false,
            startedAt: null,
            pausedAt: null,
            pausedAccumMs: 0,
            trackCursor: {},
          }
          s.past = []
          s.future = []
          s._interactionDepth = 0
          s._interactionSnapshot = null
        })
        return true
      },
      setProjectName(name) {
        edit((s) => {
          s.project.name = name
        }, 'project-name')
      },

      addSource(source) {
        set((s) => {
          s.project.sources.push(source)
          s.project.updatedAt = Date.now()
        })
      },
      removeSource(id) {
        const st = get()
        if (st.project.clips.some((c) => c.sourceId === id && c.isLive)) return
        if (!st.project.sources.some((x) => x.id === id)) return
        edit(
          (s) => {
            s.project.sources = s.project.sources.filter((x) => x.id !== id)
            // Cascade: remove any clips referencing this source.
            const removedClipIds = new Set(
              s.project.clips.filter((c) => c.sourceId === id).map((c) => c.id),
            )
            s.project.clips = s.project.clips.filter((c) => c.sourceId !== id)
            s.project.transitions = s.project.transitions.filter(
              (t) =>
                !removedClipIds.has(t.fromClipId) && !removedClipIds.has(t.toClipId),
            )
            s.selection = s.selection.filter((x) => !removedClipIds.has(x))
            recomputeDuration(s.project)
            // NOTE: we intentionally do NOT delete the OPFS file here. removeSource
            // is undoable (edit above); deleting the file eagerly meant an
            // undo restored the source record while its media was already gone,
            // leaving a permanently-dangling clip. The file is reclaimed later by
            // the media GC sweep (lib/storage/mediaGc.ts) once no saved project
            // and no in-memory history references it.
          },
          undefined,
          { ignoreLocks: true },
        )
      },
      updateSource(id, patch) {
        if (!get().project.sources.some((x) => x.id === id)) return
        const { name, text, ...media } = patch
        if (Object.keys(media).length > 0) {
          patchSourceMedia(id, media)
          set((s) => {
            s.project.updatedAt = Date.now()
          })
        }
        if (name === undefined && text === undefined) return
        edit((s) => {
          const src = s.project.sources.find((x) => x.id === id)
          if (!src) return
          if (name !== undefined) src.name = name
          if (text !== undefined) src.text = { ...text }
        })
      },
      updateTextStyle(sourceId, patch) {
        edit((s) => {
          const src = s.project.sources.find((x) => x.id === sourceId)
          if (!src || src.kind !== 'text' || !src.text) return
          Object.assign(src.text, patch)
          // Text sources are named after their content (see addTextClip).
          if (patch.content !== undefined)
            src.name = patch.content.slice(0, 40) || 'Text'
        }, `text:${sourceId}`)
      },

      addTrack(kind, name, opts) {
        const id = uid()
        edit((s) => {
          const track: Track = {
            id,
            kind,
            name: name ?? `${kind} ${s.project.tracks.length + 1}`,
            muted: false,
            locked: false,
            height: kind === 'video' ? 72 : 48,
            ...(opts?.role ? { role: opts.role } : {}),
          }
          const idx = opts?.beforeTrackId
            ? s.project.tracks.findIndex((t) => t.id === opts.beforeTrackId)
            : -1
          if (idx >= 0) s.project.tracks.splice(idx, 0, track)
          else s.project.tracks.push(track)
        })
        return id
      },
      removeTrack(id) {
        const st = get()
        if (st.project.clips.some((c) => c.trackId === id && c.isLive)) return
        if (!st.project.tracks.some((t) => t.id === id)) return
        edit((s) => {
          s.project.tracks = s.project.tracks.filter((t) => t.id !== id)
          const clipIds = new Set(
            s.project.clips.filter((c) => c.trackId === id).map((c) => c.id),
          )
          s.project.clips = s.project.clips.filter((c) => c.trackId !== id)
          s.project.transitions = s.project.transitions.filter(
            (t) => !clipIds.has(t.fromClipId) && !clipIds.has(t.toClipId),
          )
          s.selection = s.selection.filter((x) => !clipIds.has(x))
          recomputeDuration(s.project)
        })
      },
      updateTrack(id, patch) {
        edit((s) => {
          const t = s.project.tracks.find((x) => x.id === id)
          if (!t) return
          Object.assign(t, patch)
        })
      },
      moveTrack(id, delta) {
        edit((s) => {
          const idx = s.project.tracks.findIndex((t) => t.id === id)
          if (idx < 0) return
          const target = Math.max(0, Math.min(s.project.tracks.length - 1, idx + delta))
          if (target === idx) return
          const [t] = s.project.tracks.splice(idx, 1)
          s.project.tracks.splice(target, 0, t!)
        })
      },

      addClip(clip) {
        const id = uid()
        const recipe = (s: EditorState) => {
          s.project.clips.push({
            id,
            ...clip,
            transform: clip.transform ?? { ...identityTransform },
            speed: clip.speed ?? 1,
            volume: clip.volume ?? 1,
          })
          recomputeDuration(s.project)
        }
        // Live recording clips don't create undo entries.
        if (clip.isLive) {
          set((s) => {
            recipe(s)
            s.project.updatedAt = Date.now()
          })
        } else edit(recipe)
        return id
      },
      removeClip(id) {
        get().removeClips([id])
      },
      removeClips(ids) {
        const project = get().project
        const locked = lockedTrackIds(project)
        const doomed = new Set(
          project.clips
            .filter((c) => ids.includes(c.id) && !c.isLive && !locked.has(c.trackId))
            .map((c) => c.id),
        )
        if (doomed.size === 0) return
        edit((s) => {
          s.project.clips = s.project.clips.filter((c) => !doomed.has(c.id))
          s.project.transitions = s.project.transitions.filter(
            (t) => !doomed.has(t.fromClipId) && !doomed.has(t.toClipId),
          )
          s.selection = s.selection.filter((x) => !doomed.has(x))
          recomputeDuration(s.project)
        })
      },
      rippleDeleteClip(id) {
        get().rippleDeleteClips([id])
      },
      rippleDeleteClips(ids) {
        const project = get().project
        const locked = lockedTrackIds(project)
        const doomedClips = project.clips.filter(
          (c) => ids.includes(c.id) && !c.isLive && !locked.has(c.trackId),
        )
        if (doomedClips.length === 0) return
        const doomed = new Set(doomedClips.map((c) => c.id))
        // Per track, merge the removed intervals so overlapping gaps count once.
        const gaps = new Map<ID, Array<[number, number]>>()
        for (const c of [...doomedClips].sort(
          (a, b) => a.timelineStart - b.timelineStart,
        )) {
          const list = gaps.get(c.trackId) ?? []
          const start = c.timelineStart
          const end = c.timelineStart + durationOf(c)
          const last = list[list.length - 1]
          if (last && start <= last[1]) last[1] = Math.max(last[1], end)
          else list.push([start, end])
          gaps.set(c.trackId, list)
        }
        edit((s) => {
          // Remove the clips and any transitions touching them.
          s.project.clips = s.project.clips.filter((c) => !doomed.has(c.id))
          s.project.transitions = s.project.transitions.filter(
            (t) => !doomed.has(t.fromClipId) && !doomed.has(t.toClipId),
          )
          // Shift any clip on the SAME track whose start is >= a gap's end
          // backwards by that gap's length, clamped to 0.
          for (const c of s.project.clips) {
            const list = gaps.get(c.trackId)
            if (!list) continue
            let shift = 0
            for (const [a, b] of list) if (c.timelineStart >= b) shift += b - a
            if (shift > 0) c.timelineStart = Math.max(0, c.timelineStart - shift)
          }
          s.selection = s.selection.filter((x) => !doomed.has(x))
          recomputeDuration(s.project)
        })
      },
      splitAt(time, trackIds, clipIds) {
        // Build both halves from the frozen clips: fresh objects throughout so
        // the halves never share transform/color/keyframe references.
        const halves = new Map<ID, { left: Clip; right: Clip }>()
        const locked = lockedTrackIds(get().project)
        for (const c of get().project.clips) {
          if (c.isLive) continue // never split a live/recording clip
          if (locked.has(c.trackId)) continue // locked tracks are left alone
          if (clipIds && !clipIds.includes(c.id)) continue
          if (!clipIds && trackIds && !trackIds.includes(c.trackId)) continue
          const end = c.timelineStart + durationOf(c)
          if (time <= c.timelineStart || time >= end) continue
          const cut = time - c.timelineStart // clip-local (timeline) seconds
          const offset = cut * (c.speed || 1) // source seconds
          const kfs = c.keyframes ? splitKeyframes(c.keyframes, cut) : null
          const left: Clip = {
            ...c,
            sourceOut: c.sourceIn + offset,
            transform: { ...c.transform },
          }
          const right: Clip = {
            ...c,
            id: uid(),
            timelineStart: time,
            sourceIn: c.sourceIn + offset,
            transform: { ...c.transform },
          }
          if (c.color) {
            left.color = { ...c.color }
            right.color = { ...c.color }
          }
          if (c.crop) {
            left.crop = { ...c.crop }
            right.crop = { ...c.crop }
          }
          if (kfs) {
            left.keyframes = kfs.left
            right.keyframes = kfs.right
          }
          if (c.effects) {
            // Source-time anchored, so copied as is — except the fades at
            // the split point (the halves still play back to back).
            const fx = splitEffects(c.effects)
            left.effects = fx.left
            right.effects = fx.right
          }
          halves.set(c.id, { left, right })
        }
        if (halves.size === 0) return
        edit((s) => {
          s.project.clips = s.project.clips.map((c) => halves.get(c.id)?.left ?? c)
          for (const h of halves.values()) s.project.clips.push(h.right)
          // The right half now ends where the old clip ended, so transitions
          // out of the split clip belong to it.
          for (const t of s.project.transitions) {
            const h = halves.get(t.fromClipId)
            if (h) t.fromClipId = h.right.id
          }
          recomputeDuration(s.project)
        })
      },
      trimClip(id, edge, delta) {
        // The recorder rewrites a live clip's sourceOut on every chunk.
        if (isLiveClip(get().project, id)) return
        edit((s) => {
          const c = s.project.clips.find((x) => x.id === id)
          if (!c) return
          const speed = Math.max(0.1, c.speed || 1)
          const sourceDelta = delta * speed
          if (edge === 'start') {
            // Never let the start move before timeline 0: clamp the delta itself
            // (not just timelineStart) so the clip's end stays put.
            const minIn = Math.max(0, c.sourceIn - c.timelineStart * speed)
            const newIn = Math.min(
              c.sourceOut - 0.01,
              Math.max(minIn, c.sourceIn + sourceDelta),
            )
            const applied = newIn - c.sourceIn
            c.sourceIn = newIn
            c.timelineStart = Math.max(0, c.timelineStart + applied / speed)
          } else {
            // Timed media can't be extended past the end of its source (but a
            // clip already past it isn't forcibly shortened).
            const max = maxSourceOut(s.project, c)
            const upper = max === undefined ? Infinity : Math.max(max, c.sourceOut)
            c.sourceOut = Math.min(
              upper,
              Math.max(c.sourceIn + 0.01, c.sourceOut + sourceDelta),
            )
          }
          recomputeDuration(s.project)
        })
      },
      moveClip(id, deltaTime, deltaTrackIndex = 0) {
        if (isLiveClip(get().project, id)) return
        edit((s) => {
          const c = s.project.clips.find((x) => x.id === id)
          if (!c) return
          // Move all clips in the same link group together (in time only;
          // linked clips keep their own tracks).
          const targets = withLinked(s.project, [id])
          if (s.project.clips.some((x) => targets.has(x.id) && x.isLive)) return
          shiftClips(s.project, targets, deltaTime)
          if (deltaTrackIndex) {
            const idx = s.project.tracks.findIndex((t) => t.id === c.trackId)
            const from = s.project.tracks[idx]
            const target =
              idx >= 0 ? s.project.tracks[idx + deltaTrackIndex] : undefined
            // Only onto an unlocked track of a compatible kind.
            if (
              from &&
              target &&
              !target.locked &&
              trackFamily(target.kind) === trackFamily(from.kind)
            ) {
              c.trackId = target.id
            }
          }
          recomputeDuration(s.project)
        })
      },
      moveClips(ids, deltaTime) {
        const project = get().project
        const targets = withLinked(project, ids)
        if (targets.size === 0) return
        if (project.clips.some((c) => targets.has(c.id) && c.isLive)) return
        edit((s) => {
          shiftClips(s.project, targets, deltaTime)
          recomputeDuration(s.project)
        })
      },
      extendLiveClip(clipId, sourceOut) {
        set((s) => {
          const c = s.project.clips.find((x) => x.id === clipId)
          // Guard against finalizeLiveClips being called between chunk delivery
          // and this update: if the clip no longer exists or is already finalized,
          // extending it would corrupt timeline state.
          if (!c || !c.isLive) return
          c.sourceOut = sourceOut
          recomputeDuration(s.project)
          s.project.updatedAt = Date.now()
        })
      },
      updateClip(id, patch) {
        if (isLiveClip(get().project, id)) return
        edit((s) => {
          const c = s.project.clips.find((x) => x.id === id)
          if (!c) return
          const prevOut = c.sourceOut
          Object.assign(c, patch)
          if (c.sourceIn < 0) c.sourceIn = 0
          if (patch.sourceOut !== undefined) {
            const max = maxSourceOut(s.project, c)
            if (max !== undefined)
              c.sourceOut = Math.min(c.sourceOut, Math.max(max, prevOut))
          }
          if (c.sourceOut <= c.sourceIn) c.sourceOut = c.sourceIn + 0.01
          // Clamp speed to a safe range: 0 causes division-by-zero in durationOf.
          c.speed = Math.max(0.1, Math.min(16, c.speed ?? 1))
          if (c.timelineStart < 0) c.timelineStart = 0
          recomputeDuration(s.project)
        })
      },
      setTransform(id, patch) {
        edit((s) => {
          const c = s.project.clips.find((x) => x.id === id)
          if (!c) return
          Object.assign(c.transform, patch)
        })
      },
      setTransforms(patches, coalesceKey) {
        const live = new Set(
          get()
            .project.clips.filter((c) => c.isLive)
            .map((c) => c.id),
        )
        const todo = patches.filter((p) => !live.has(p.id))
        if (todo.length === 0) return
        edit((s) => {
          for (const item of todo) {
            const c = s.project.clips.find((x) => x.id === item.id)
            if (!c) continue
            const t = c.transform
            const p = item.patch
            Object.assign(
              t,
              Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)),
            )
            // Optional fields patched to undefined are removed (Reset).
            if ('anchorX' in p && p.anchorX === undefined && 'anchorX' in t)
              delete t.anchorX
            if ('anchorY' in p && p.anchorY === undefined && 'anchorY' in t)
              delete t.anchorY
            if ('lockAspect' in p && p.lockAspect === undefined && 'lockAspect' in t)
              delete t.lockAspect
            if (item.crop !== undefined) {
              if (item.crop === null) {
                if (c.crop) delete c.crop
              } else if (!sameCrop(c.crop, item.crop)) {
                c.crop = { ...item.crop }
              }
            }
            for (const prop of item.negateKeyframes ?? []) {
              const list = c.keyframes?.[prop]
              if (list) for (const k of list) k.value = -k.value
            }
          }
        }, coalesceKey)
      },
      setColor(id, patch) {
        edit((s) => {
          const c = s.project.clips.find((x) => x.id === id)
          if (!c) return
          if (!c.color) {
            c.color = {
              brightness: 1,
              contrast: 1,
              saturation: 1,
              hue: 0,
              blur: 0,
            }
          }
          Object.assign(c.color, patch)
        })
      },
      addEffect(clipId, effect) {
        const project = get().project
        const clip = project.clips.find((c) => c.id === clipId)
        if (!clip || clip.isLive) return null
        const src = project.sources.find((x) => x.id === clip.sourceId)
        if (src && !effectAllowedFor(effect.type, src.kind)) return null
        const fx = normalizeEffect({ ...effect })
        const list = clip.effects ?? []
        if (list.some((e) => e.id === fx.id)) return null
        if (fx.type === 'fade' && list.some((e) => e.type === 'fade')) return null
        if (fx.type === 'zoom' && zoomOverlaps(list, fx)) return null
        edit((s) => {
          const c = s.project.clips.find((x) => x.id === clipId)
          if (!c) return
          ;(c.effects ??= []).push(fx)
        })
        return fx.id
      },
      updateEffect(clipId, effectId, patch, coalesceKey) {
        const clip = get().project.clips.find((c) => c.id === clipId)
        if (!clip || clip.isLive || !clip.effects) return false
        const idx = clip.effects.findIndex((e) => e.id === effectId)
        const cur = clip.effects[idx]
        if (!cur) return false
        // id/type can't be patched; the merged effect is re-normalized.
        const next = normalizeEffect({
          ...cur,
          ...patch,
          id: cur.id,
          type: cur.type,
        } as ClipEffect)
        if (next.type === 'zoom' && zoomOverlaps(clip.effects, next)) return false
        edit((s) => {
          const c = s.project.clips.find((x) => x.id === clipId)
          if (!c?.effects) return
          const i = c.effects.findIndex((e) => e.id === effectId)
          const draft = c.effects[i]
          if (!draft) return
          // Assign field by field so an unchanged value is a no-op edit.
          Object.assign(draft, next)
        }, coalesceKey)
        return true
      },
      removeEffect(clipId, effectId) {
        const clip = get().project.clips.find((c) => c.id === clipId)
        if (!clip || clip.isLive || !clip.effects?.some((e) => e.id === effectId))
          return
        edit((s) => {
          const c = s.project.clips.find((x) => x.id === clipId)
          if (!c?.effects) return
          c.effects = c.effects.filter((e) => e.id !== effectId)
          if (c.effects.length === 0) delete c.effects
        })
      },
      toggleEffect(clipId, effectId) {
        if (isLiveClip(get().project, clipId)) return
        edit((s) => {
          const c = s.project.clips.find((x) => x.id === clipId)
          const e = c?.effects?.find((x) => x.id === effectId)
          if (e) e.enabled = !e.enabled
        })
      },
      setKeyframe(id, prop, kf) {
        edit((s) => {
          const c = s.project.clips.find((x) => x.id === id)
          if (!c) return
          if (!c.keyframes) c.keyframes = {}
          const list = (c.keyframes[prop] ??= [] as Keyframe[])
          const tol = 1 / 240
          const existing = list.findIndex((k) => Math.abs(k.t - kf.t) < tol)
          if (existing >= 0) list[existing] = { ...kf }
          else list.push({ ...kf })
          list.sort((a, b) => a.t - b.t)
        })
      },
      removeKeyframe(id, prop, t) {
        edit((s) => {
          const c = s.project.clips.find((x) => x.id === id)
          if (!c || !c.keyframes) return
          const list = c.keyframes[prop]
          if (!list) return
          const tol = 1 / 240
          if (!list.some((k) => Math.abs(k.t - t) < tol)) return
          c.keyframes[prop] = list.filter((k) => Math.abs(k.t - t) >= tol)
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          if (c.keyframes[prop].length === 0) delete c.keyframes[prop]
        })
      },
      linkClips(ids) {
        if (ids.length < 2) return
        // Merge: any group a selected clip already belongs to joins the new one,
        // so linking never splits an existing group.
        const members = withLinked(get().project, ids)
        if (members.size < 2) return
        edit((s) => {
          const g = uid()
          for (const c of s.project.clips) if (members.has(c.id)) c.linkGroup = g
        })
      },
      unlinkClips(ids) {
        edit((s) => {
          for (const id of ids) {
            const c = s.project.clips.find((x) => x.id === id)
            if (c && c.linkGroup !== undefined) delete c.linkGroup
          }
        })
      },
      addTextClip(trackId, timelineStart, style) {
        const sourceId = uid()
        const clipId = uid()
        edit((s) => {
          const now = Date.now()
          const text: TextStyle = {
            content: style?.content ?? 'Title',
            fontFamily: style?.fontFamily ?? DEFAULT_TEXT_FONT,
            fontSize: style?.fontSize ?? 72,
            fontWeight: style?.fontWeight ?? 700,
            color: style?.color ?? '#ffffff',
            background: style?.background,
            align: style?.align ?? 'center',
            strokeColor: style?.strokeColor ?? '#000000',
            strokeWidth: style?.strokeWidth ?? 2,
            shadow: style?.shadow ?? true,
          }
          const dur = 4
          const src: MediaSource = {
            id: sourceId,
            kind: 'text',
            opfsPath: '',
            mimeType: 'text/plain',
            duration: dur,
            createdAt: now,
            name: text.content.slice(0, 40) || 'Text',
            text,
          }
          s.project.sources.push(src)
          // Never onto a locked track (the edit would be refused).
          let tid = s.project.tracks.some((t) => t.id === trackId && !t.locked)
            ? trackId
            : null
          if (!tid) {
            const found = s.project.tracks.find(
              (t) => t.kind === 'overlay' && !t.locked,
            )
            if (found) tid = found.id
          }
          if (!tid) {
            tid = uid()
            s.project.tracks.push({
              id: tid,
              kind: 'overlay',
              name: 'Text',
              muted: false,
              locked: false,
              height: 56,
            })
          }
          s.project.clips.push({
            id: clipId,
            trackId: tid,
            sourceId,
            timelineStart: Math.max(0, timelineStart),
            sourceIn: 0,
            sourceOut: dur,
            speed: 1,
            volume: 0,
            transform: { ...identityTransform },
          })
          recomputeDuration(s.project)
        })
        return clipId
      },
      addElementClip(templateId, timelineStart, trackId) {
        const tpl = getTemplate(templateId)
        if (!tpl) return null
        const sourceId = uid()
        const clipId = uid()
        const start = Math.max(0, timelineStart)
        const dur = tpl.defaultDuration
        edit((s) => {
          s.project.sources.push({
            id: sourceId,
            kind: 'element',
            opfsPath: '',
            mimeType: 'application/x-element',
            duration: dur,
            width: tpl.size.w,
            height: tpl.size.h,
            createdAt: Date.now(),
            name: tpl.name,
            element: { template: tpl.id, params: { ...resolveParams(tpl, null) } },
          })
          const tid = overlayTrackFor(s.project, start, dur, trackId, 'Elements')
          s.project.clips.push({
            id: clipId,
            trackId: tid,
            sourceId,
            timelineStart: start,
            sourceIn: 0,
            sourceOut: dur,
            speed: 1,
            volume: 0,
            transform: { ...identityTransform },
          })
          s.selection = [clipId]
          recomputeDuration(s.project)
        })
        return clipId
      },
      updateElementParams(sourceId, patch) {
        edit((s) => {
          const src = s.project.sources.find((x) => x.id === sourceId)
          if (!src || src.kind !== 'element' || !src.element) return
          Object.assign(src.element.params, patch)
        }, `element:${sourceId}`)
      },
      addShapeClip(type, timelineStart, trackId) {
        const sourceId = uid()
        const clipId = uid()
        const start = Math.max(0, timelineStart ?? get().playhead)
        const dur = SHAPE_DEFAULT_DURATION
        const shape = defaultShape(type)
        edit((s) => {
          s.project.sources.push({
            id: sourceId,
            kind: 'shape',
            opfsPath: '',
            mimeType: 'application/x-shape',
            duration: dur,
            width: shape.width,
            height: shape.height,
            createdAt: Date.now(),
            name: SHAPE_LABELS[type],
            shape,
          })
          const tid = overlayTrackFor(s.project, start, dur, trackId, 'Shapes', true)
          s.project.clips.push({
            id: clipId,
            trackId: tid,
            sourceId,
            timelineStart: start,
            sourceIn: 0,
            sourceOut: dur,
            speed: 1,
            volume: 0,
            transform: { ...identityTransform },
          })
          s.selection = [clipId]
          recomputeDuration(s.project)
        })
        return clipId
      },
      updateShape(sourceId, patch) {
        edit((s) => {
          const src = s.project.sources.find((x) => x.id === sourceId)
          if (!src || src.kind !== 'shape' || !src.shape) return
          const next = normalizeShape({ ...src.shape, ...patch })
          // Field by field: an unchanged value is a no-op edit.
          Object.assign(src.shape, next)
          if (src.width !== next.width) src.width = next.width
          if (src.height !== next.height) src.height = next.height
          if (patch.type !== undefined) src.name = SHAPE_LABELS[next.type]
        }, `shape:${sourceId}`)
      },
      duplicateClip(clipId, timelineStart) {
        const st = get()
        const clip = st.project.clips.find((c) => c.id === clipId)
        if (!clip || clip.isLive) return null
        const src = st.project.sources.find((x) => x.id === clip.sourceId)
        const newId = uid()
        const data = duplicateClipData(clip, timelineStart)
        return edit((s) => {
          let sourceId = clip.sourceId
          if (src && src.kind === 'text' && src.text) {
            // Text lives on a per-clip source: give the copy its own, so
            // editing the duplicate doesn't change the original.
            sourceId = uid()
            s.project.sources.push({
              ...src,
              id: sourceId,
              createdAt: Date.now(),
              text: { ...src.text },
            })
          } else if (src && src.kind === 'element' && src.element) {
            sourceId = uid()
            s.project.sources.push({
              ...src,
              id: sourceId,
              createdAt: Date.now(),
              element: {
                template: src.element.template,
                params: { ...src.element.params },
              },
            })
          } else if (src && src.kind === 'shape' && src.shape) {
            sourceId = uid()
            s.project.sources.push({
              ...src,
              id: sourceId,
              createdAt: Date.now(),
              shape: { ...src.shape },
            })
          }
          s.project.clips.push({ id: newId, ...data, sourceId })
          recomputeDuration(s.project)
        })
          ? newId
          : null
      },
      reorderClips(ids, dir) {
        let moved = 0
        const ok = edit((s) => {
          moved = reorderClipsIn(s.project, ids, dir, uid)
        })
        return ok ? moved : 0
      },
      reorderClip(id, dir) {
        return get().reorderClips([id], dir)
      },
      pasteClips(payload, at) {
        let result: { ids: ID[]; skipped: number } = { ids: [], skipped: 0 }
        const time = at ?? get().playhead
        const ok = edit((s) => {
          result = pasteInto(s.project, payload, time, uid)
          if (result.ids.length) s.selection = [...result.ids]
          recomputeDuration(s.project)
        })
        return ok ? result : { ids: [], skipped: result.ids.length + result.skipped }
      },
      pasteAttributes(from, sel, targetIds) {
        const ids = targetIds ?? get().selection
        let count = 0
        const ok = edit((s) => {
          count = pasteAttributesInto(s.project, from, sel, ids)
        })
        return ok ? count : 0
      },
      setBlendMode(ids, mode) {
        edit((s) => {
          for (const id of ids) {
            const c = s.project.clips.find((x) => x.id === id)
            if (!c || c.isLive) continue
            if (mode === 'normal') delete c.blendMode
            else c.blendMode = mode
          }
        })
      },
      finalizeLiveClips(sourceId) {
        set((s) => {
          const finals = new Map<ID, number>()
          for (const c of s.project.clips) {
            if (!c.isLive) continue
            if (sourceId && c.sourceId !== sourceId) continue
            c.isLive = false
            finals.set(c.id, c.sourceOut)
          }
          if (finals.size === 0) return
          s.project.updatedAt = Date.now()
          // Snapshots pushed by edits made *during* the take hold the live clip
          // with isLive:true and a partial sourceOut. Patch them to the final
          // clip, otherwise undoing one of those edits later would restore an
          // invisible, truncated stub of the take. (Entries are frozen shared
          // objects; writing through the draft copies only what changes.)
          const entries = [...s.past, ...s.future]
          if (s._interactionSnapshot) entries.push(s._interactionSnapshot)
          for (const e of entries) {
            let touched = false
            for (const c of e.project.clips) {
              const out = finals.get(c.id)
              if (out === undefined) continue
              c.sourceOut = out
              delete c.isLive
              touched = true
            }
            if (touched) recomputeDuration(e.project)
          }
        })
      },
      reconcileRecordedClip(clipId, fromSourceOut, toSourceOut, keepEnd = true) {
        if (!Number.isFinite(toSourceOut) || toSourceOut <= 0) return
        set((s) => {
          const projects = [
            s.project,
            ...s.past.map((e) => e.project),
            ...s.future.map((e) => e.project),
          ]
          if (s._interactionSnapshot) projects.push(s._interactionSnapshot.project)
          for (const p of projects) {
            const c = p.clips.find((x) => x.id === clipId)
            if (!c || c.isLive || Math.abs(c.sourceOut - fromSourceOut) > 1e-6) continue
            anchorRecordedClip(c, fromSourceOut, toSourceOut, keepEnd)
            recomputeDuration(p)
          }
          s.project.updatedAt = Date.now()
        })
      },
      replaceWithMergedClip(clipIds, source, at) {
        const st = get()
        if (st.recording.active) return null
        const ids = new Set(clipIds)
        const targets = st.project.clips.filter((c) => ids.has(c.id))
        if (targets.length !== ids.size || targets.some((c) => c.isLive)) return null
        if (!st.project.tracks.some((t) => t.id === at.trackId)) return null
        const clipId = uid()
        return edit((s) => {
          const p = s.project
          p.clips = p.clips.filter((c) => !ids.has(c.id))
          p.transitions = p.transitions.filter(
            (t) => !ids.has(t.fromClipId) && !ids.has(t.toClipId),
          )
          if (!p.sources.some((x) => x.id === source.id)) p.sources.push(source)
          p.clips.push({
            id: clipId,
            trackId: at.trackId,
            sourceId: source.id,
            timelineStart: Math.max(0, at.timelineStart),
            sourceIn: 0,
            sourceOut: source.duration,
            speed: 1,
            volume: 1,
            transform: { ...identityTransform },
          })
          s.selection = [clipId]
          recomputeDuration(p)
        })
          ? clipId
          : null
      },
      removeTimeRanges(ranges) {
        const st = get()
        if (st.recording.active)
          return { ok: false, reason: 'Stop the recording first.' }
        const norm = normalizeRanges(ranges)
        if (norm.length === 0) return { ok: false, reason: 'Nothing to remove.' }
        const locked = lockedTracksAffected(st.project, norm)
        if (locked.length > 0) {
          return {
            ok: false,
            reason:
              `Unlock ${locked.map((n) => `"${n}"`).join(', ')} — pauses are cut from every ` +
              'track at once to keep video, audio and captions in sync.',
          }
        }
        const next = cutTimeRanges(st.project, norm, uid)
        edit((s) => {
          s.project = next
          const ids = new Set(next.clips.map((c) => c.id))
          s.selection = s.selection.filter((id) => ids.has(id))
        })
        return {
          ok: true,
          removedSec: norm.reduce((sum, r) => sum + (r.end - r.start), 0),
          count: norm.length,
        }
      },
      setTranscript(sourceId, transcript) {
        set((s) => {
          const next = Object.fromEntries(
            Object.entries(s.project.transcripts ?? {}).filter(
              ([id]) => id !== sourceId,
            ),
          )
          if (transcript) next[sourceId] = transcript
          s.project.transcripts = next
          s.project.updatedAt = Date.now()
        })
      },
      setCaptions(cues, style) {
        let count = 0
        edit((s) => {
          const p = s.project
          let track = p.tracks.find((t) => t.role === 'captions')
          if (!track) {
            track = {
              id: uid(),
              kind: 'overlay',
              name: 'Captions',
              muted: false,
              locked: false,
              height: 40,
              role: 'captions',
            }
            // First track = top of the stack, so captions draw over everything.
            p.tracks.unshift(track)
          }
          const trackId = track.id
          // Drop the previous captions (their clips, generated sources and any
          // transitions touching them).
          const oldClips = new Set(
            p.clips.filter((c) => c.trackId === trackId).map((c) => c.id),
          )
          const oldSources = new Set(
            p.clips.filter((c) => oldClips.has(c.id)).map((c) => c.sourceId),
          )
          p.clips = p.clips.filter((c) => !oldClips.has(c.id))
          p.sources = p.sources.filter(
            (x) => !(oldSources.has(x.id) && x.captionFor !== undefined),
          )
          p.transitions = p.transitions.filter(
            (t) => !oldClips.has(t.fromClipId) && !oldClips.has(t.toClipId),
          )
          s.selection = s.selection.filter((id) => !oldClips.has(id))
          const now = Date.now()
          for (const cue of cues) {
            const dur = cue.end - cue.start
            if (!(dur > 0) || !cue.text.trim()) continue
            const sourceId = uid()
            p.sources.push({
              id: sourceId,
              kind: 'text',
              opfsPath: '',
              mimeType: 'text/plain',
              duration: dur,
              createdAt: now,
              name: cue.text.replace(/\s+/g, ' ').slice(0, 40),
              text: { ...style.text, content: cue.text },
              captionFor: trackId,
            })
            p.clips.push({
              id: uid(),
              trackId,
              sourceId,
              timelineStart: Math.max(0, cue.start),
              sourceIn: 0,
              sourceOut: dur,
              speed: 1,
              volume: 0,
              transform: { ...identityTransform, y: style.y },
            })
            count++
          }
          recomputeDuration(p)
        })
        return count
      },
      updateSourceDuration(sourceId, duration) {
        if (!get().project.sources.some((x) => x.id === sourceId)) return
        patchSourceMedia(sourceId, { duration })
        set((s) => {
          s.project.updatedAt = Date.now()
        })
      },

      addTransition(t) {
        const id = uid()
        edit((s) => {
          s.project.transitions.push({ id, ...t })
        })
        return id
      },
      removeTransition(id) {
        if (!get().project.transitions.some((t) => t.id === id)) return
        edit((s) => {
          s.project.transitions = s.project.transitions.filter((t) => t.id !== id)
        })
      },
      updateTransition(id, patch) {
        edit((s) => {
          const t = s.project.transitions.find((x) => x.id === id)
          if (!t) return
          Object.assign(t, patch)
          if (t.duration < 0) t.duration = 0
        })
      },

      addMarker(m) {
        const id = uid()
        edit((s) => {
          if (!s.project.markers) s.project.markers = []
          s.project.markers.push({ id, ...m })
        })
        return id
      },
      removeMarker(id) {
        if (!get().project.markers?.some((m) => m.id === id)) return
        edit((s) => {
          if (!s.project.markers) return
          s.project.markers = s.project.markers.filter((m) => m.id !== id)
        })
      },
      updateMarker(id, patch) {
        edit((s) => {
          if (!s.project.markers) return
          const m = s.project.markers.find((x) => x.id === id)
          if (!m) return
          Object.assign(m, patch)
        })
      },

      setSelection(ids) {
        set((s) => {
          s.selection = ids
        })
      },

      revealSource(sourceId) {
        set((s) => {
          s.revealedSourceId = sourceId
        })
      },
      clearRevealedSource() {
        set((s) => {
          s.revealedSourceId = null
        })
      },

      takeInterruptedTakes() {
        const pending = get().interruptedTakes
        if (pending)
          set((s) => {
            s.interruptedTakes = null
          })
        return pending
      },

      setPlayhead(t) {
        set((s) => {
          s.playhead = Math.max(0, t)
        })
      },
      setPlaying(p) {
        set((s) => {
          s.playing = p
        })
      },
      setZoom(z) {
        set((s) => {
          s.zoom = Math.max(10, Math.min(800, z))
        })
      },

      startRecording() {
        // One undo step for the whole take: undoing right after Stop returns to
        // the timeline as it was before recording began.
        pushHistory()
        coalesce = null
        set((s) => {
          s.recording.active = true
          s.recording.paused = false
          s.recording.startedAt = Date.now()
          s.recording.pausedAt = null
          s.recording.pausedAccumMs = 0
          s.recording.trackCursor = {}
          // Initialize cursors at current playhead so new clips append there.
          for (const t of s.project.tracks) {
            s.recording.trackCursor[t.id] = s.playhead
          }
        })
      },
      pauseRecording() {
        set((s) => {
          if (s.recording.paused) return
          s.recording.paused = true
          s.recording.pausedAt = Date.now()
        })
      },
      resumeRecording() {
        set((s) => {
          if (!s.recording.paused) return
          if (s.recording.pausedAt != null) {
            s.recording.pausedAccumMs += Date.now() - s.recording.pausedAt
          }
          s.recording.pausedAt = null
          s.recording.paused = false
        })
      },
      stopRecording() {
        // Finalize any live clips (and patch history snapshots that hold them).
        get().finalizeLiveClips()
        set((s) => {
          s.recording.active = false
          s.recording.paused = false
          s.recording.startedAt = null
          s.recording.pausedAt = null
          s.recording.pausedAccumMs = 0
        })
      },

      beginInteraction() {
        const st = get()
        set((s) => {
          if (st._interactionDepth === 0) {
            s._interactionSnapshot = { project: st.project, selection: st.selection }
          }
          s._interactionDepth += 1
        })
      },
      endInteraction() {
        const st = get()
        if (st._interactionDepth <= 0) return
        if (st._interactionDepth > 1) {
          set((s) => {
            s._interactionDepth -= 1
          })
          return
        }
        // Outermost end: commit one step, or nothing if the gesture was a no-op.
        closeInteraction()
      },
      resetInteraction() {
        if (get()._interactionDepth <= 0 && !get()._interactionSnapshot) return
        closeInteraction()
      },
      undo() {
        const st = get()
        // Never undo mid-recording: undo swaps the whole project object, which
        // would orphan the live clip the CaptureManager is still extending and
        // lose the rest of the take. Live edits are deliberately kept out of
        // history, so there is nothing safe to undo while recording anyway.
        if (st.recording.active) return
        // Nor mid-gesture: endInteraction would then commit the pre-drag
        // snapshot on top of the undone state and wipe the redo stack.
        if (st._interactionDepth > 0) return
        const prev = st.past[st.past.length - 1]
        if (!prev) return
        const restored = keepLibraryMedia(prev.project, st.project)
        // Media in the pre-edit snapshot but gone now was removed by the edit
        // being undone (imports since then are in st.project, so not listed).
        const liveIds = new Set(st.project.sources.map((x) => x.id))
        const removedMedia = prev.project.sources
          .filter((x) => x.opfsPath && !liveIds.has(x.id))
          .map((x) => x.id)
        coalesce = null
        set((s) => {
          s.past.pop()
          s.future.push({
            project: st.project,
            selection: st.selection,
            ...(removedMedia.length > 0 ? { removedMedia } : {}),
          })
          s.project = restored
          s.selection = prev.selection
        })
      },
      redo() {
        const st = get()
        // See undo(): history is frozen while recording or mid-gesture.
        if (st.recording.active) return
        if (st._interactionDepth > 0) return
        const next = st.future[st.future.length - 1]
        if (!next) return
        const restored = keepLibraryMedia(next.project, st.project, next.removedMedia)
        coalesce = null
        set((s) => {
          s.future.pop()
          s.past.push({ project: st.project, selection: st.selection })
          if (s.past.length > HISTORY_LIMIT) s.past.shift()
          s.project = restored
          s.selection = next.selection
        })
      },
      canUndo() {
        return get().past.length > 0
      },
      canRedo() {
        return get().future.length > 0
      },
    }
  }),
)

export { uid }
