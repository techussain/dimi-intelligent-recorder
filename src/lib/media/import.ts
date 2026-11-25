import { ALL_FORMATS, BlobSource, Input } from 'mediabunny'
import { writeFile } from '../storage/opfs'
import { useEditor } from '../timeline/store'
import type { MediaSource } from '../timeline/types'
import { detectMediaFile, transparentVideoHint } from './detectAnimation'
import type { AnimationDetection } from './detectAnimation'

export type MediaKind = 'video' | 'audio' | 'image'

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/** A metadata probe that hasn't answered by now never will (corrupt file). */
const PROBE_TIMEOUT_MS = 15_000

/** Thrown when storage is (about to be) full; importFiles stops on it. */
export class StorageFullError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StorageFullError'
  }
}

interface ProbeResult {
  duration: number
  width?: number
  height?: number
  sampleRate?: number
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(`Timed out ${what}`)), ms)
    p.then(
      (v) => {
        window.clearTimeout(t)
        resolve(v)
      },
      (e: unknown) => {
        window.clearTimeout(t)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}

/**
 * Load metadata via a media element, with a timeout. `duration` may be
 * NaN/Infinity (MediaRecorder WebM has no duration header) — probeMedia
 * resolves that.
 */
function probeElement(url: string, kind: 'video' | 'audio'): Promise<ProbeResult> {
  const el = document.createElement(kind)
  const cleanup = () => {
    el.onloadedmetadata = null
    el.onerror = null
    el.removeAttribute('src')
    el.load()
  }
  const loaded = new Promise<ProbeResult>((resolve, reject) => {
    el.preload = 'metadata'
    el.muted = true
    el.onloadedmetadata = () => {
      const r: ProbeResult = { duration: el.duration }
      if (el instanceof HTMLVideoElement) {
        r.width = el.videoWidth
        r.height = el.videoHeight
      }
      resolve(r)
    }
    el.onerror = () => reject(new Error(`Failed to read ${kind} metadata`))
    el.src = url
  })
  return withTimeout(loaded, PROBE_TIMEOUT_MS, `reading ${kind} metadata`).finally(
    cleanup,
  )
}

function probeImage(url: string): Promise<ProbeResult> {
  const img = new Image()
  const loaded = new Promise<ProbeResult>((resolve, reject) => {
    img.onload = () =>
      resolve({
        duration: 0,
        width: img.naturalWidth,
        height: img.naturalHeight,
      })
    img.onerror = () => reject(new Error('Failed to read image metadata'))
    img.src = url
  })
  return withTimeout(loaded, PROBE_TIMEOUT_MS, 'reading image metadata').finally(() => {
    img.onload = null
    img.onerror = null
  })
}

/**
 * True when the file's primary video track can carry transparency (VP9 alpha
 * WebM …). Best effort: any failure means "opaque".
 */
export async function detectVideoAlpha(file: File): Promise<boolean> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  try {
    const track = await withTimeout(
      input.getPrimaryVideoTrack(),
      PROBE_TIMEOUT_MS,
      'reading video track',
    )
    return track ? await track.canBeTransparent() : false
  } catch {
    return false
  } finally {
    input.dispose()
  }
}

/** Real duration by demuxing the file (handles header-less WebM). 0 if unknown. */
async function computeDuration(file: File): Promise<number> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  try {
    const d = await withTimeout(
      input.computeDuration(),
      PROBE_TIMEOUT_MS,
      'computing duration',
    )
    return Number.isFinite(d) && d > 0 ? d : 0
  } catch {
    return 0
  } finally {
    input.dispose()
  }
}

export async function probeMedia(file: File, kind: MediaKind): Promise<ProbeResult> {
  const url = URL.createObjectURL(file)
  let probe: ProbeResult
  try {
    probe = kind === 'image' ? await probeImage(url) : await probeElement(url, kind)
  } finally {
    URL.revokeObjectURL(url)
  }
  // Unknown duration (Infinity/NaN, e.g. MediaRecorder WebM): demux for the
  // real one rather than storing 0 (which would become a default-length clip).
  if (kind !== 'image' && !(Number.isFinite(probe.duration) && probe.duration > 0)) {
    probe.duration = await computeDuration(file)
  }
  return probe
}

/** Throws StorageFullError if `bytes` won't fit in the remaining quota. */
async function ensureSpace(bytes: number): Promise<void> {
  let estimate: StorageEstimate
  try {
    estimate = await navigator.storage.estimate()
  } catch {
    return // estimate() unavailable — let the write itself fail if full
  }
  if (!estimate.quota) return
  const available = estimate.quota - (estimate.usage ?? 0)
  if (bytes > available) {
    throw new StorageFullError(
      `Not enough storage space. Need ${(bytes / 1e6).toFixed(1)} MB but only ` +
        `${(Math.max(0, available) / 1e6).toFixed(1)} MB available.`,
    )
  }
}

/** name+size+lastModified: identifies "the same file" across imports. */
const fingerprint = (f: File) => [f.name, f.size, f.lastModified].join('|')

/**
 * The library source an earlier import of this exact file produced, if it is
 * still in the project. The fingerprint is saved on the source (`importKey`),
 * so this also works after a reload or when reopening the project.
 */
function findDuplicate(file: File): MediaSource | undefined {
  const key = fingerprint(file)
  return useEditor
    .getState()
    .project.sources.find((s) => s.importKey === key && !!s.opfsPath)
}

/** Absolute path of a picked/dropped file (desktop app), else undefined. */
export function originalDiskPath(file: File): string | undefined {
  try {
    return window.electronAPI?.media?.registerImport(file) || undefined
  } catch {
    return undefined
  }
}

/** An imported source plus user-facing notes about it ("may look different"). */
export interface ImportResult {
  source: MediaSource
  warnings: string[]
}

/**
 * Import a file: copy into OPFS and return a MediaSource. Caller should push
 * it onto the project via `addSource`.
 */
export async function importFile(file: File): Promise<MediaSource> {
  return (await importFileDetailed(file)).source
}

export async function importFileDetailed(file: File): Promise<ImportResult> {
  const det = await detectMediaFile(file)
  if (det.kind === 'unknown') {
    throw new Error(det.reason ?? `Unsupported file type: ${file.name}`)
  }
  const kind: MediaKind | 'animation' = det.kind

  // Guard against filling the OPFS quota before writing.
  await ensureSpace(file.size)

  let probe: ProbeResult
  let animation: AnimationDetection | null = null
  let hasAlpha = false
  const warnings: string[] = []
  if (det.kind === 'animation') {
    animation = det
    warnings.push(...det.warnings)
    probe = { duration: det.duration, width: det.width, height: det.height }
  } else {
    try {
      probe = await probeMedia(file, det.kind)
    } catch (err) {
      // Chromium can't decode ProRes .mov: explain instead of "failed to read".
      if (det.kind === 'video') {
        const hint = await transparentVideoHint(file)
        if (hint) throw new Error(hint)
      }
      throw err
    }
    if (det.kind === 'video') {
      hasAlpha = await detectVideoAlpha(file)
      if (!hasAlpha && /\.mov$/i.test(file.name)) {
        const hint = await transparentVideoHint(file)
        if (hint) throw new Error(hint)
      }
    }
  }
  const id = uid()
  const ext = (() => {
    const m = file.name.match(/\.([a-z0-9]+)$/i)
    return m ? '.' + m[1]!.toLowerCase() : ''
  })()
  const opfsPath = `imports/${id}${ext}`
  await writeFile(opfsPath, file)
  const source: MediaSource = {
    id,
    kind,
    opfsPath,
    mimeType: file.type || 'application/octet-stream',
    duration: probe.duration,
    width: probe.width,
    height: probe.height,
    sampleRate: probe.sampleRate,
    createdAt: Date.now(),
    name: file.name,
    importKey: fingerprint(file),
  }
  if (animation) {
    source.animation = {
      format: animation.format,
      frameCount: animation.frameCount,
      loop: animation.loop,
      ...(animation.fps !== undefined ? { fps: animation.fps } : {}),
    }
  }
  if (hasAlpha) source.hasAlpha = true
  // Desktop app: remember where the original lives (not copied — the user
  // already has it) so the OPFS copy can be restored from it if lost.
  const diskPath = originalDiskPath(file)
  if (diskPath) source.diskPath = diskPath
  return { source, warnings }
}

/**
 * Import several files in order. A file identical (name+size+lastModified)
 * to one already in the library is skipped (and revealed) instead of being
 * copied again. Storage is checked before each file; once it runs out, the
 * rest of the batch is reported as not imported rather than attempted.
 */
export async function importFiles(
  files: FileList | File[],
  onProgress?: (done: number, total: number, source?: MediaSource) => void,
): Promise<{
  sources: MediaSource[]
  errors: { name: string; error: Error }[]
  /** Files already in the library (not re-imported). */
  skipped: { name: string; sourceId: string }[]
  /** Detection notes per imported file (e.g. unsupported Lottie features). */
  warnings: { name: string; messages: string[] }[]
}> {
  const arr = Array.from(files)
  const sources: MediaSource[] = []
  const errors: { name: string; error: Error }[] = []
  const skipped: { name: string; sourceId: string }[] = []
  const warnings: { name: string; messages: string[] }[] = []
  for (let i = 0; i < arr.length; i++) {
    const file = arr[i]!
    // Also catch the same file twice in one batch: callers may only add the
    // batch's sources to the project after it finishes.
    const dup =
      findDuplicate(file) ?? sources.find((s) => s.importKey === fingerprint(file))
    if (dup) {
      skipped.push({ name: file.name, sourceId: dup.id })
      useEditor.getState().revealSource(dup.id)
      onProgress?.(i + 1, arr.length)
      continue
    }
    try {
      const { source: s, warnings: w } = await importFileDetailed(file)
      if (w.length > 0) warnings.push({ name: file.name, messages: w })
      sources.push(s)
      onProgress?.(i + 1, arr.length, s)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      errors.push({ name: file.name, error })
      onProgress?.(i + 1, arr.length)
      if (error instanceof StorageFullError || error.name === 'QuotaExceededError') {
        const rest = arr.slice(i + 1)
        for (const f of rest) {
          errors.push({
            name: f.name,
            error: new StorageFullError('Not imported: storage is full.'),
          })
        }
        if (rest.length > 0) onProgress?.(arr.length, arr.length)
        break
      }
    }
  }
  return { sources, errors, skipped, warnings }
}
