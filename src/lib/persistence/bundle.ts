/**
 * `.irbundle` — zipped project containing .irproj + all OPFS media. Portable
 * across machines, unlike `.irproj` (which references OPFS paths only).
 *
 * Layout inside the zip:
 *   project.irproj — JSON file (same schema as saveProjectToFile)
 *   <opfsPath>     — one entry per media file, named by the source's opfsPath
 *
 * Media is already compressed (webm/mp4/…), so it is STORED (level 0) and
 * streamed file-by-file into the output instead of being re-deflated in
 * memory.
 *
 * On load, only entries whose name equals a source opfsPath the project
 * references are extracted, every referenced path is validated before
 * anything is written, and media is re-materialised into a fresh
 * `sessions/<newId>/` folder (the project gets that new id and its opfsPaths
 * are rewritten) — so a bundle can never overwrite another project's files.
 *
 * Import streams (zipReader.ts): the bundle is never read into memory as a
 * whole, entries are bounded by their declared sizes (no zip bombs), and the
 * total is checked against free storage before anything is written.
 *
 * Bundles are limited to 4 GB: the zip writer (fflate) has no ZIP64 support,
 * so a larger archive would be written corrupt. Saving refuses instead.
 */
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import type { Project } from '../timeline/types'
import { deletePath, openFileWriter, readFile, removeDirIfEmpty } from '../storage/opfs'
import { extractZipEntry, readZipDirectory, readZipEntry } from './zipReader'
import { emitError } from '../errorBus'
import { dropUnreachableDiskPaths } from '../storage/diskMedia'
import { parse, serialize } from './project'

const PROJECT_ENTRY = 'project.irproj'
/** Largest project.irproj accepted from a bundle. */
const MAX_PROJECT_JSON = 64 * 1024 * 1024
/**
 * Largest bundle the zip writer can produce correctly (no ZIP64): 4 GiB,
 * minus room for headers and the project file.
 */
export const MAX_BUNDLE_BYTES = 0xffffffff - 64 * 1024 * 1024

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`
/** Bytes read from OPFS per zip push (bounds memory while streaming). */
const READ_CHUNK = 4 * 1024 * 1024

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-z0-9-_ ]+/gi, '_').trim() || 'project'
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/**
 * Returns true only for paths that are safe to write into OPFS:
 * - no empty segments
 * - no absolute paths (no leading /)
 * - no backslashes (Windows-style separators in a zip are suspicious)
 * - no path-traversal components (..)
 */
export function isSafeOpfsPath(p: string): boolean {
  if (!p || p.startsWith('/') || p.includes('\\')) return false
  return p.split('/').every((seg) => seg !== '' && seg !== '..' && seg !== '.')
}

/** Thrown by saveProjectBundle when referenced media can't be read. */
export class MissingMediaError extends Error {
  /** Display names (or paths) of the sources whose media is missing. */
  readonly missing: string[]
  constructor(missing: string[]) {
    super(
      `${missing.length} media file${missing.length === 1 ? ' is' : 's are'} missing and ` +
        `would be left out of the bundle: ${missing.join(', ')}`,
    )
    this.name = 'MissingMediaError'
    this.missing = missing
  }
}

export interface SaveBundleOptions {
  /**
   * Save anyway when some media files are missing (they are left out).
   * Without it, saveProjectBundle throws MissingMediaError before writing.
   */
  allowMissing?: boolean
}

type ShowSaveFilePicker = (opts: {
  suggestedName?: string
  types?: { description: string; accept: Record<string, string[]> }[]
}) => Promise<FileSystemFileHandle>

type ShowOpenFilePicker = (opts: {
  types?: { description: string; accept: Record<string, string[]> }[]
  multiple?: boolean
}) => Promise<FileSystemFileHandle[]>

/** Where zip output goes: a picked file, or an in-memory download. */
interface Sink {
  write(chunk: Uint8Array): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}

function downloadSink(suggestedName: string): Sink {
  const parts: BlobPart[] = []
  return {
    write(chunk) {
      parts.push(chunk as BlobPart)
      return Promise.resolve()
    },
    close() {
      const blob = new Blob(parts, { type: 'application/zip' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = suggestedName
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
      return Promise.resolve()
    },
    abort() {
      parts.length = 0
      return Promise.resolve()
    },
  }
}

/** Opens the save picker; null if the user canceled. */
async function openSink(suggestedName: string): Promise<Sink | null> {
  const picker = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker })
    .showSaveFilePicker
  if (picker) {
    try {
      const handle = await picker({
        suggestedName,
        types: [
          {
            description: 'Dimi Intelligent Recorder bundle',
            accept: { 'application/zip': ['.irbundle'] },
          },
        ],
      })
      const writable = await handle.createWritable()
      return {
        write: (chunk) => writable.write(chunk as FileSystemWriteChunkType),
        close: () => writable.close(),
        abort: () => writable.abort(),
      }
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return null
      // fall through to download fallback
    }
  }
  return downloadSink(suggestedName)
}

/**
 * Save a portable bundle. Throws MissingMediaError (before asking where to
 * save) if any referenced media file can't be read, unless
 * `opts.allowMissing` is set.
 */
export async function saveProjectBundle(
  project: Project,
  onProgress?: (pct: number) => void,
  opts: SaveBundleOptions = {},
): Promise<boolean> {
  // Resolve every media file up front so a missing one is reported instead
  // of silently producing an incomplete bundle.
  const media: { path: string; file: File }[] = []
  const missing: string[] = []
  const seen = new Set<string>()
  for (const src of project.sources) {
    if (!src.opfsPath || seen.has(src.opfsPath)) continue
    seen.add(src.opfsPath)
    try {
      media.push({ path: src.opfsPath, file: await readFile(src.opfsPath) })
    } catch (err) {
      console.warn('Bundle: missing media for', src.id, err)
      missing.push(src.name || src.opfsPath)
    }
  }
  if (missing.length > 0 && !opts.allowMissing) throw new MissingMediaError(missing)
  const mediaBytes = media.reduce((n, m) => n + m.file.size, 0)
  if (mediaBytes > MAX_BUNDLE_BYTES)
    throw new Error(
      `This project's media is ${gb(mediaBytes)}; a bundle can hold up to 4 GB. ` +
        'Remove unused media, or save the project (.irproj) and copy the recordings ' +
        'folder instead.',
    )

  const sink = await openSink(`${sanitizeFilename(project.name)}.irbundle`)
  if (!sink) return false // save dialog canceled
  try {
    await streamZip(project, media, sink, onProgress)
    await sink.close()
  } catch (err) {
    await sink.abort().catch(() => {})
    throw err
  }
  onProgress?.(100)
  return true
}

/**
 * saveProjectBundle for UI callers: if some media is missing, ask whether to
 * save the bundle without it. Returns false if the user declined or canceled
 * the save dialog.
 */
export async function saveProjectBundleWithPrompt(
  project: Project,
  onProgress?: (pct: number) => void,
): Promise<boolean> {
  try {
    return await saveProjectBundle(project, onProgress)
  } catch (err) {
    if (!(err instanceof MissingMediaError)) throw err
    if (
      !window.confirm(`${err.message}

Save the bundle without them?`)
    )
      return false
    return await saveProjectBundle(project, onProgress, { allowMissing: true })
  }
}

async function streamZip(
  project: Project,
  media: { path: string; file: File }[],
  sink: Sink,
  onProgress?: (pct: number) => void,
): Promise<void> {
  let failure: unknown = null
  let writes: Promise<void> = Promise.resolve()
  let finish!: () => void
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  const zip = new Zip((err, chunk, final) => {
    if (err) {
      failure ??= err
      finish()
      return
    }
    writes = writes
      .then(() => sink.write(chunk))
      .catch((e: unknown) => {
        failure ??= e
      })
    if (final) finish()
  })
  const check = async () => {
    await writes // backpressure: never buffer more than one chunk ahead
    if (failure)
      throw failure instanceof Error ? failure : new Error('Bundle write failed')
  }

  const proj = new ZipDeflate(PROJECT_ENTRY, { level: 6 })
  zip.add(proj)
  proj.push(new TextEncoder().encode(serialize(project)), true)
  await check()

  const total = Math.max(
    1,
    media.reduce((n, m) => n + m.file.size, 0),
  )
  let done = 0
  for (const { path, file } of media) {
    // Stored, not deflated: the media is already compressed.
    const entry = new ZipPassThrough(path)
    zip.add(entry)
    for (let off = 0; off < file.size; off += READ_CHUNK) {
      const buf = new Uint8Array(await file.slice(off, off + READ_CHUNK).arrayBuffer())
      entry.push(buf)
      done += buf.byteLength
      await check()
      // Reserve 0–95 % for streaming media; the rest for finalizing.
      onProgress?.(Math.round((done / total) * 95))
    }
    entry.push(new Uint8Array(0), true)
    await check()
  }
  zip.end()
  await finished
  await check()
}

export async function openProjectBundle(): Promise<Project | null> {
  const picker = (window as unknown as { showOpenFilePicker?: ShowOpenFilePicker })
    .showOpenFilePicker
  let file: File | null = null
  if (picker) {
    try {
      const [handle] = await picker({
        types: [
          {
            description: 'Dimi Intelligent Recorder bundle',
            accept: { 'application/zip': ['.irbundle'] },
          },
        ],
      })
      file = await handle!.getFile()
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return null
      throw err
    }
  } else {
    file = await new Promise<File | null>((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.irbundle,application/zip'
      input.onchange = () => resolve(input.files?.[0] ?? null)
      input.click()
    })
  }
  if (!file) return null
  return await restoreBundle(file)
}

/** Throws if `bytes` more won't fit in the app's storage quota. */
async function ensureSpace(bytes: number): Promise<void> {
  if (!navigator.storage?.estimate) return
  const { usage = 0, quota = 0 } = await navigator.storage.estimate()
  if (quota > 0 && usage + bytes > quota * 0.95)
    throw new Error(
      `Not enough storage to import this bundle (${gb(bytes)} of media, ` +
        `${gb(Math.max(0, quota - usage))} free).`,
    )
}

/**
 * Validate a bundle, restore its media into a fresh `sessions/<newId>/`
 * folder and return the project (new id, rewritten opfsPaths). Nothing is
 * written unless every referenced path is valid; if any write fails, the
 * files already written are deleted and the whole restore fails.
 */
export async function restoreBundle(file: Blob): Promise<Project> {
  const directory = await readZipDirectory(file)
  const projEntry = directory.get(PROJECT_ENTRY)
  if (!projEntry) throw new Error('Bundle missing project.irproj')
  const project = parse(
    new TextDecoder().decode(await readZipEntry(file, projEntry, MAX_PROJECT_JSON)),
  )

  // Validate every referenced path before touching OPFS.
  const paths: string[] = []
  for (const src of project.sources) {
    if (!src.opfsPath || paths.includes(src.opfsPath)) continue
    if (!isSafeOpfsPath(src.opfsPath)) {
      throw new Error(`Bundle contains invalid path: "${src.opfsPath}"`)
    }
    paths.push(src.opfsPath)
  }
  // Only entries the project references are ever decompressed or written.
  await ensureSpace(paths.reduce((n, p) => n + (directory.get(p)?.size ?? 0), 0))

  const newId = uid()
  const remap = new Map<string, string>()
  paths.forEach((p, i) => {
    const base = (p.split('/').pop() ?? '').replace(/[^a-z0-9._-]+/gi, '_') || 'media'
    remap.set(p, `sessions/${newId}/${i}-${base}`)
  })

  const written: string[] = []
  const missing: string[] = []
  for (const p of paths) {
    const entry = directory.get(p)
    if (!entry) {
      missing.push(project.sources.find((s) => s.opfsPath === p)?.name || p)
      continue
    }
    const dest = remap.get(p)!
    try {
      const writer = await openFileWriter(dest)
      written.push(dest)
      try {
        // Bounded by the entry's declared size: a lying header can't expand.
        await extractZipEntry(file, entry, (c) => writer.write(c), entry.size)
        await writer.close()
      } catch (err) {
        await writer.abort()
        throw err
      }
    } catch (err) {
      for (const w of written) await deletePath(w).catch(() => {})
      if (written[0]) await removeDirIfEmpty(written[0])
      const reason = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Could not restore media "${p}" from the bundle (${reason}). Nothing was imported.`,
      )
    }
  }
  if (missing.length > 0) {
    // Saved with allowMissing (or truncated): open it, but say what's gone.
    emitError(
      `Bundle is missing ${missing.length} media file${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`,
    )
  }
  // diskPaths from the bundle are kept only if they exist on THIS machine.
  const sources = await dropUnreachableDiskPaths(project.sources)
  return {
    ...project,
    id: newId,
    sources: sources.map((s) =>
      s.opfsPath ? { ...s, opfsPath: remap.get(s.opfsPath)! } : s,
    ),
  }
}
