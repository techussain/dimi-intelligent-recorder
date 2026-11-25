/**
 * Append-only OPFS writer for live recordings.
 *
 * Uses a FileSystemSyncAccessHandle (worker-only API) so each chunk is written
 * in place at a known offset and flushed — O(chunk) per append and durable
 * after every chunk. The main-thread alternative, `createWritable()`, copies
 * the entire existing file into a swap file on every call, which makes long
 * recordings progressively slower until writes overlap and corrupt the file.
 *
 * One worker per file. Messages are processed strictly in order.
 *
 *   → { op: 'open', path }       ← { ok: true } | { ok: false, error }
 *   → { op: 'append', bytes }    ← { ok: true } | { ok: false, error }
 *   → { op: 'close' }            ← { ok: true } | { ok: false, error }
 */

interface SyncAccessHandle {
  write(buffer: ArrayBufferView, opts?: { at?: number }): number
  truncate(size: number): void
  flush(): void
  close(): void
}

type Request =
  | { op: 'open'; path: string }
  | { op: 'append'; bytes: ArrayBuffer }
  | { op: 'close' }

let handle: SyncAccessHandle | null = null
let offset = 0

async function openFile(path: string): Promise<void> {
  const segs = path.replace(/^\/+|\/+$/g, '').split('/')
  const file = segs.pop() ?? ''
  let dir = await navigator.storage.getDirectory()
  for (const s of segs) dir = await dir.getDirectoryHandle(s, { create: true })
  const fh = (await dir.getFileHandle(file, {
    create: true,
  })) as FileSystemFileHandle & {
    createSyncAccessHandle(): Promise<SyncAccessHandle>
  }
  handle = await fh.createSyncAccessHandle()
  // A recording always starts a fresh file.
  handle.truncate(0)
  offset = 0
}

function append(bytes: ArrayBuffer): void {
  if (!handle) throw new Error('Writer is not open')
  const view = new Uint8Array(bytes)
  let written = 0
  while (written < view.byteLength) {
    const n = handle.write(view.subarray(written), { at: offset + written })
    if (n <= 0) throw new Error('OPFS write returned 0 bytes (disk full?)')
    written += n
  }
  offset += written
  handle.flush()
}

let queue: Promise<void> = Promise.resolve()
const post = (msg: unknown) => {
  ;(self as unknown as Worker).postMessage(msg)
}

self.onmessage = (ev: MessageEvent<Request>) => {
  const req = ev.data
  queue = queue.then(async () => {
    try {
      if (req.op === 'open') await openFile(req.path)
      else if (req.op === 'append') append(req.bytes)
      else {
        handle?.flush()
        handle?.close()
        handle = null
      }
      post({ ok: true })
    } catch (err) {
      post({
        ok: false,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      })
    }
  })
}
