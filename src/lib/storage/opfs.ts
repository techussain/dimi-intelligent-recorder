/**
 * Thin wrapper over the Origin Private File System. Used to store captured
 * segments and imported media without blowing up IndexedDB.
 */

async function root(): Promise<FileSystemDirectoryHandle> {
  return await navigator.storage.getDirectory()
}

async function resolveDir(
  parts: string[],
  create = false,
): Promise<FileSystemDirectoryHandle> {
  let dir = await root()
  for (const p of parts) {
    dir = await dir.getDirectoryHandle(p, { create })
  }
  return dir
}

function splitPath(path: string): { dirs: string[]; file: string } {
  const norm = path.replace(/^\/+|\/+$/g, '')
  const segs = norm.split('/')
  const file = segs.pop() ?? ''
  return { dirs: segs, file }
}

export async function writeFile(
  path: string,
  data: Blob | ArrayBuffer | Uint8Array,
): Promise<void> {
  const { dirs, file } = splitPath(path)
  const dir = await resolveDir(dirs, true)
  const handle = await dir.getFileHandle(file, { create: true })
  const writable = await handle.createWritable()
  await writable.write(data as FileSystemWriteChunkType)
  await writable.close()
}

/** A file being written in pieces (bundle import); abort() discards it. */
export interface FileWriter {
  write(chunk: Uint8Array | Blob): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}

/** Create (or replace) `path` and write it chunk by chunk. */
export async function openFileWriter(path: string): Promise<FileWriter> {
  const { dirs, file } = splitPath(path)
  const dir = await resolveDir(dirs, true)
  const handle = await dir.getFileHandle(file, { create: true })
  const writable = await handle.createWritable()
  return {
    write: (chunk) => writable.write(chunk as FileSystemWriteChunkType),
    close: () => writable.close(),
    abort: () => writable.abort().catch(() => undefined),
  }
}

/**
 * Sequential append-only writer for one file (used by live recording).
 * Appends are applied strictly in call order; after the first failure every
 * further append rejects, so a file never gets a silent gap mid-stream.
 */
export interface AppendWriter {
  append(data: Uint8Array): Promise<void>
  close(): Promise<void>
}

const WORKER_OPEN_TIMEOUT_MS = 3000

/**
 * Open an append writer that truncates `path` and appends to it.
 *
 * Prefers a worker holding a FileSystemSyncAccessHandle (in-place writes,
 * flushed per chunk). Falls back to main-thread `createWritable` writes,
 * serialized and positioned by an in-memory offset, when the worker or
 * sync handles are unavailable.
 */
export async function openAppendWriter(path: string): Promise<AppendWriter> {
  try {
    return await openWorkerWriter(path)
  } catch (err) {
    console.warn('[opfs] sync-access writer unavailable, using fallback', err)
    return await openFallbackWriter(path)
  }
}

type WorkerReply = { ok: true } | { ok: false; error: string }

async function openWorkerWriter(path: string): Promise<AppendWriter> {
  const worker = new Worker(
    new URL('../../workers/opfsWriter.worker.ts', import.meta.url),
    { type: 'module' },
  )
  // The worker answers every request in order, so replies are matched FIFO.
  const waiting: Array<{ resolve: () => void; reject: (e: Error) => void }> = []
  let failed: Error | null = null
  const fail = (err: Error) => {
    failed ??= err
    for (const w of waiting.splice(0)) w.reject(err)
  }
  worker.onmessage = (ev: MessageEvent<WorkerReply>) => {
    const w = waiting.shift()
    if (!w) return
    if (ev.data.ok) w.resolve()
    else {
      const err = new Error(ev.data.error)
      failed ??= err
      w.reject(err)
    }
  }
  worker.onerror = (ev) => {
    ev.preventDefault()
    fail(new Error(ev.message || 'OPFS writer worker crashed'))
  }
  const request = (msg: unknown, transfer: Transferable[] = []) =>
    new Promise<void>((resolve, reject) => {
      if (failed) {
        reject(failed)
        return
      }
      waiting.push({ resolve, reject })
      worker.postMessage(msg, transfer)
    })

  try {
    await Promise.race([
      request({ op: 'open', path }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('OPFS writer worker timed out')),
          WORKER_OPEN_TIMEOUT_MS,
        ),
      ),
    ])
  } catch (err) {
    worker.terminate()
    throw err
  }

  return {
    append(data) {
      // Copy into a standalone buffer so it can be transferred.
      const buf = data.slice().buffer
      return request({ op: 'append', bytes: buf }, [buf])
    },
    async close() {
      try {
        if (!failed) await request({ op: 'close' })
      } finally {
        worker.terminate()
      }
    },
  }
}

/**
 * Main-thread fallback (no FileSystemSyncAccessHandle — not the case in the
 * desktop app or Chromium 120+). Each chunk is committed on its own
 * (createWritable + close), so a crash loses at most one chunk. The cost:
 * every commit copies the file so far, so very long takes get slower to
 * write. Durability wins over speed on this rarely used path.
 */
async function openFallbackWriter(path: string): Promise<AppendWriter> {
  const { dirs, file } = splitPath(path)
  const dir = await resolveDir(dirs, true)
  const handle = await dir.getFileHandle(file, { create: true })
  let offset = 0
  let failed: Error | null = null
  const toError = (err: unknown) =>
    err instanceof Error ? err : new Error('OPFS write failed')
  let chain: Promise<void> = (async () => {
    const w = await handle.createWritable() // truncates
    await w.close()
  })().catch((err: unknown) => {
    failed = toError(err)
  })
  return {
    append(data) {
      const next = chain.then(async () => {
        if (failed) throw failed
        try {
          const w = await handle.createWritable({ keepExistingData: true })
          await w.seek(offset)
          await w.write(data as FileSystemWriteChunkType)
          await w.close()
          offset += data.byteLength
        } catch (err) {
          failed = toError(err)
          throw failed
        }
      })
      chain = next.catch(() => {})
      return next
    },
    async close() {
      await chain
    },
  }
}

export async function readFile(path: string): Promise<File> {
  const { dirs, file } = splitPath(path)
  const dir = await resolveDir(dirs, false)
  const handle = await dir.getFileHandle(file, { create: false })
  return await handle.getFile()
}

export async function deletePath(path: string): Promise<void> {
  const { dirs, file } = splitPath(path)
  const dir = await resolveDir(dirs, false)
  await dir.removeEntry(file, { recursive: true })
}

/**
 * Remove the directory containing `filePath` if it is now empty (e.g. a
 * recording session folder after its last file was deleted). Never removes
 * a non-empty directory; failures are ignored.
 */
export async function removeDirIfEmpty(filePath: string): Promise<void> {
  const { dirs } = splitPath(filePath)
  const name = dirs.pop()
  if (!name) return
  try {
    const parent = await resolveDir(dirs, false)
    await parent.removeEntry(name) // non-recursive: throws if not empty
  } catch {
    // not empty / already gone
  }
}

export async function ensureDir(path: string): Promise<void> {
  const norm = path.replace(/^\/+|\/+$/g, '')
  const segs = norm ? norm.split('/') : []
  await resolveDir(segs, true)
}

// toBlobUrl removed — use getBlobUrl from blobCache instead (it caches and
// evicts object URLs automatically via releaseAll on project load).
