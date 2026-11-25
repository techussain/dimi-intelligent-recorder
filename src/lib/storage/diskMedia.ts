/**
 * Real files on the user's disk ("the recordings folder").
 *
 * OPFS stays the working store: every decoder, worker and export reads media
 * from OPFS. In the desktop app, each recording and merged clip is ALSO
 * streamed to a real file in the recordings folder, and an imported file
 * remembers the path it was imported from. The absolute path is kept on the
 * source as `diskPath`. When a project is opened and a source's OPFS copy is
 * gone (app data cleared, another profile, …) it is copied back from disk.
 *
 * Ownership rules:
 *   - The app never deletes files on disk. The media GC (mediaGc.ts) only
 *     reclaims OPFS copies; removing a source from the library, deleting a
 *     project or a GC sweep leaves the disk file where it is.
 *   - Imports are not copied: `diskPath` points at the user's original file.
 *
 * Everything here is a no-op in the browser build (`window.electronAPI` is
 * undefined there) and never throws: failures are reported via emitError.
 */
import { deletePath, openAppendWriter, readFile } from './opfs'
import { emitError } from '../errorBus'
import type { MediaSource, Project } from '../timeline/types'

/** Bytes per IPC read/write (bounds memory while copying). */
export const DISK_CHUNK = 4 * 1024 * 1024
let chunkSize = DISK_CHUNK

/** Test hook: use a smaller chunk size (pass nothing to reset). */
export function _setDiskChunkSize(bytes = DISK_CHUNK): void {
  chunkSize = bytes
}

type DiskMediaAPI = NonNullable<Window['electronAPI']>['media']

function api(): DiskMediaAPI | null {
  if (typeof window === 'undefined') return null
  return window.electronAPI?.media ?? null
}

/** True in the desktop app, where media can be kept as real files. */
export function isDiskMediaAvailable(): boolean {
  return api() !== null
}

// ── Naming ──────────────────────────────────────────────────────────────────

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

/** One path segment safe on Windows, macOS and Linux. */
export function sanitizeSegment(name: string, fallback = 'Untitled'): string {
  let s = name
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, '')
  if (!s || /^_+$/.test(s)) s = fallback
  if (WINDOWS_RESERVED.test(s)) s += '_'
  return s
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Local time as "YYYY-MM-DD HH.MM.SS" (colons aren't allowed on Windows). */
export function fileTimestamp(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`
  )
}

/**
 * Relative path of a file in the recordings folder:
 * `"<Project>/<YYYY-MM-DD HH.MM.SS> <Label>.<ext>"`, e.g.
 * `"My Project/2026-09-30 10.02.07 Screen.webm"`.
 */
export function recordingRelPath(
  projectName: string,
  label: string,
  date: Date,
  ext = 'webm',
): string {
  const project = sanitizeSegment(projectName, 'Untitled Project')
  const cleanExt = ext.replace(/^\.+/, '').replace(/[^a-z0-9]/gi, '') || 'webm'
  const file = sanitizeSegment(
    `${fileTimestamp(date)} ${sanitizeSegment(label, 'Media')}`,
  )
  return `${project}/${file}.${cleanExt.toLowerCase()}`
}

/** File extension of an OPFS path ("sessions/x/abc.final.webm" → "webm"). */
export function extOf(path: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(path)
  return m ? m[1]!.toLowerCase() : 'webm'
}

/**
 * Human label for a source's file on disk: from the role of the track its
 * clips sit on (Screen / Webcam / Mic / System audio), else from its name.
 */
export function sourceFileLabel(source: MediaSource, project?: Project): string {
  if (project) {
    const clip = project.clips.find((c) => c.sourceId === source.id)
    const role = clip && project.tracks.find((t) => t.id === clip.trackId)?.role
    switch (role) {
      case 'screen':
        return 'Screen'
      case 'webcam':
        return 'Webcam'
      case 'mic':
        return 'Mic'
      case 'system-audio':
        return 'System audio'
    }
  }
  const n = source.name.toLowerCase()
  if (n.startsWith('merged')) return 'Merged'
  if (n.startsWith('screen')) return 'Screen'
  if (n.startsWith('webcam')) return 'Webcam'
  if (n.includes('system')) return 'System audio'
  if (n.startsWith('mic')) return 'Mic'
  if (source.kind === 'audio') return 'Audio'
  return source.name || 'Media'
}

// ── Copy OPFS → disk ────────────────────────────────────────────────────────

async function folderName(media: DiskMediaAPI): Promise<string> {
  try {
    return await media.getFolder()
  } catch {
    return 'the recordings folder'
  }
}

export interface SaveToDiskOptions {
  /** What is being saved, for the error message ("recording", "merged clip"). */
  what?: string
}

/**
 * Stream an OPFS file to `relPath` under the recordings folder. Resolves with
 * the absolute path written, or null when unavailable (browser) or on failure
 * (reported via emitError; a partial file is removed). Never rejects.
 */
export async function saveToDisk(
  opfsPath: string,
  relPath: string,
  opts: SaveToDiskOptions = {},
): Promise<string | null> {
  const media = api()
  if (!media) return null
  let writeId: number | null = null
  try {
    const file = await readFile(opfsPath)
    const opened = await media.openWrite(relPath)
    writeId = opened.id
    for (let off = 0; off < file.size; off += chunkSize) {
      const buf = new Uint8Array(await file.slice(off, off + chunkSize).arrayBuffer())
      await media.write(writeId, buf)
    }
    await media.closeWrite(writeId)
    writeId = null
    return opened.path
  } catch (err) {
    if (writeId !== null) await media.abortWrite(writeId).catch(() => {})
    const folder = await folderName(media)
    emitError(
      `Couldn't save a copy of the ${opts.what ?? 'recording'} to ${folder}`,
      err,
    )
    return null
  }
}

// ── Copy disk → OPFS ────────────────────────────────────────────────────────

/**
 * Copy a file from disk back into OPFS at `opfsPath` (overwriting it).
 * Resolves true if the copy is complete and has the expected size. On
 * failure the partial OPFS file is removed. Never rejects.
 */
export async function restoreFromDisk(
  diskPath: string,
  opfsPath: string,
): Promise<boolean> {
  const media = api()
  if (!media) return false
  let wrote = false
  try {
    const size = await media.stat(diskPath)
    if (size < 0) return false
    const writer = await openAppendWriter(opfsPath)
    wrote = true
    try {
      let off = 0
      while (off < size) {
        const chunk = await media.read(diskPath, off, Math.min(chunkSize, size - off))
        if (chunk.byteLength === 0) throw new Error('Unexpected end of file')
        await writer.append(chunk)
        off += chunk.byteLength
      }
    } finally {
      await writer.close()
    }
    const restored = await readFile(opfsPath)
    if (restored.size !== size)
      throw new Error(`Size mismatch (${restored.size} ≠ ${size})`)
    return true
  } catch (err) {
    console.warn('[diskMedia] restore failed', diskPath, err)
    if (wrote) await deletePath(opfsPath).catch(() => {})
    return false
  }
}

async function opfsFileMissing(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return false
  } catch (err) {
    // A missing directory or file both surface as NotFoundError.
    return (err as DOMException)?.name === 'NotFoundError'
  }
}

export interface EnsureMediaResult {
  /** Files copied back from disk into OPFS. */
  restored: number
  /** Display names of sources whose media is in neither place. */
  missing: string[]
}

/**
 * Make sure every media file of `project` is in OPFS, restoring missing ones
 * from their `diskPath`. Sequential (each restore reads a whole file). Does
 * not touch the editor store, so the preview can call it for any project.
 */
export async function ensureProjectMedia(project: Project): Promise<EnsureMediaResult> {
  const result: EnsureMediaResult = { restored: 0, missing: [] }
  const seen = new Set<string>()
  for (const src of project.sources) {
    if (!src.opfsPath || seen.has(src.opfsPath)) continue
    seen.add(src.opfsPath)
    if (!(await opfsFileMissing(src.opfsPath))) continue
    if (src.diskPath && (await restoreFromDisk(src.diskPath, src.opfsPath))) {
      result.restored++
      continue
    }
    result.missing.push(src.name || src.opfsPath)
  }
  return result
}

let lastCheckedId: string | null = null

/**
 * Run ensureProjectMedia for a newly opened project (once per project switch)
 * and report what couldn't be found. Desktop app only; never rejects.
 */
export async function checkProjectMedia(
  project: Project,
): Promise<EnsureMediaResult | null> {
  if (!isDiskMediaAvailable()) return null
  if (project.id === lastCheckedId) return null
  lastCheckedId = project.id
  if (!project.sources.some((s) => s.opfsPath)) return null
  try {
    const res = await ensureProjectMedia(project)
    if (res.restored > 0)
      console.info(`[diskMedia] restored ${res.restored} media file(s) from disk`)
    if (res.missing.length > 0) {
      const n = res.missing.length
      emitError(
        `${n} media file${n === 1 ? ' is' : 's are'} missing: ${res.missing.join(', ')}`,
      )
    }
    return res
  } catch (err) {
    console.warn('[diskMedia] media check failed', err)
    return null
  }
}

/** Test hook: forget which project was checked last. */
export function _resetCheckedProject(): void {
  lastCheckedId = null
}

/**
 * Keep only `diskPath`s that exist and are readable on this machine (e.g. a
 * project from a bundle made elsewhere must not point at foreign paths).
 */
export async function dropUnreachableDiskPaths(
  sources: MediaSource[],
): Promise<MediaSource[]> {
  const media = api()
  const out: MediaSource[] = []
  for (const s of sources) {
    if (!s.diskPath) {
      out.push(s)
      continue
    }
    let ok = false
    if (media) {
      try {
        ok = (await media.stat(s.diskPath)) >= 0
      } catch {
        ok = false
      }
    }
    if (ok) out.push(s)
    else {
      const { diskPath: _drop, ...rest } = s
      void _drop
      out.push(rest)
    }
  }
  return out
}
