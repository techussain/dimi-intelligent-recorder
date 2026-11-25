/**
 * Minimal streaming ZIP reader for `.irbundle` import.
 *
 * Reads the central directory from the end of the file (ZIP64 included) and
 * extracts single entries slice by slice, so a bundle is never loaded into
 * memory as a whole. Stored entries (all media in an .irbundle) are copied
 * as Blob slices; deflated entries are inflated as a stream. Every entry is
 * bounded by its declared size and a caller-supplied cap, which stops zip
 * bombs and lying headers.
 */
import { Inflate } from 'fflate'

export interface ZipEntry {
  name: string
  /** 0 = stored, 8 = deflate. */
  method: number
  compressedSize: number
  /** Declared uncompressed size. */
  size: number
  localHeaderOffset: number
}

/** Upper bound on entries in a bundle (a project has a few hundred at most). */
export const MAX_ZIP_ENTRIES = 10_000
/** Bytes per slice read from the archive while extracting. */
const SLICE = 4 * 1024 * 1024
/**
 * Compressed bytes handed to the inflater per push. fflate decompresses a
 * whole push into one output buffer before we can check its size, and
 * deflate can expand ~1000×: a 4 MB push could allocate gigabytes. 1 KB in
 * means at most ~1 MB out between two size checks.
 */
const INFLATE_STEP = 1024
/**
 * Largest central directory accepted (it is read into memory whole). Even
 * MAX_ZIP_ENTRIES entries with long names stay far below this.
 */
const MAX_DIRECTORY_BYTES = 16 * 1024 * 1024

const SIG_EOCD = 0x06054b50
const SIG_ZIP64_LOCATOR = 0x07064b50
const SIG_ZIP64_EOCD = 0x06064b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(`Not a valid bundle: ${message}`)
    this.name = 'ZipFormatError'
  }
}

/** Bytes [start, end) of a Blob (FileReader fallback for older runtimes). */
export function readBytes(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  const part = blob.slice(start, end)
  if (typeof part.arrayBuffer === 'function')
    return part.arrayBuffer().then((b) => new Uint8Array(b))
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer))
    r.onerror = () => reject(r.error ?? new Error('read failed'))
    r.readAsArrayBuffer(part)
  })
}

const u64 = (v: DataView, at: number) =>
  v.getUint32(at, true) + v.getUint32(at + 4, true) * 0x1_0000_0000

/** The archive's entries, by name. Throws ZipFormatError on a malformed file. */
export async function readZipDirectory(file: Blob): Promise<Map<string, ZipEntry>> {
  // The end-of-central-directory record is in the last 22 + 65535 bytes.
  const tailStart = Math.max(0, file.size - (22 + 0xffff))
  const tail = await readBytes(file, tailStart, file.size)
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ZipFormatError('end of archive not found')

  let count = tv.getUint16(eocd + 10, true)
  let cdSize = tv.getUint32(eocd + 12, true)
  let cdOffset = tv.getUint32(eocd + 16, true)
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // ZIP64: the locator sits right before the classic record.
    const loc = eocd - 20
    if (loc < 0 || tv.getUint32(loc, true) !== SIG_ZIP64_LOCATOR)
      throw new ZipFormatError('ZIP64 locator missing')
    const z64At = u64(tv, loc + 8)
    const z = await readBytes(file, z64At, z64At + 56)
    const zv = new DataView(z.buffer, z.byteOffset, z.byteLength)
    if (z.length < 56 || zv.getUint32(0, true) !== SIG_ZIP64_EOCD)
      throw new ZipFormatError('ZIP64 record missing')
    count = u64(zv, 32)
    cdSize = u64(zv, 40)
    cdOffset = u64(zv, 48)
  }
  if (count > MAX_ZIP_ENTRIES) throw new ZipFormatError(`too many entries (${count})`)
  if (cdSize > MAX_DIRECTORY_BYTES) throw new ZipFormatError('directory too large')
  if (cdSize < count * 46) throw new ZipFormatError('directory too small')
  if (cdOffset + cdSize > file.size) throw new ZipFormatError('directory out of range')

  const cd = await readBytes(file, cdOffset, cdOffset + cdSize)
  const v = new DataView(cd.buffer, cd.byteOffset, cd.byteLength)
  const names = new TextDecoder()
  const entries = new Map<string, ZipEntry>()
  let p = 0
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || v.getUint32(p, true) !== SIG_CENTRAL)
      throw new ZipFormatError('corrupt directory')
    const flags = v.getUint16(p + 8, true)
    const method = v.getUint16(p + 10, true)
    let compressedSize = v.getUint32(p + 20, true)
    let size = v.getUint32(p + 24, true)
    const nameLen = v.getUint16(p + 28, true)
    const extraLen = v.getUint16(p + 30, true)
    const commentLen = v.getUint16(p + 32, true)
    let localHeaderOffset = v.getUint32(p + 42, true)
    if (p + 46 + nameLen + extraLen > cd.length)
      throw new ZipFormatError('corrupt directory')
    const name = names.decode(cd.subarray(p + 46, p + 46 + nameLen))
    // ZIP64 extra field: 64-bit values for the fields that overflowed.
    let e = p + 46 + nameLen
    const extraEnd = e + extraLen
    while (e + 4 <= extraEnd) {
      const id = v.getUint16(e, true)
      const len = v.getUint16(e + 2, true)
      if (id === 0x0001) {
        let q = e + 4
        if (size === 0xffffffff) {
          size = u64(v, q)
          q += 8
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = u64(v, q)
          q += 8
        }
        if (localHeaderOffset === 0xffffffff) localHeaderOffset = u64(v, q)
      }
      e += 4 + len
    }
    p = extraEnd + commentLen
    if (flags & 1) throw new ZipFormatError(`encrypted entry "${name}"`)
    if (method !== 0 && method !== 8)
      throw new ZipFormatError(`unsupported compression in "${name}"`)
    if (localHeaderOffset + compressedSize > file.size)
      throw new ZipFormatError(`entry "${name}" out of range`)
    entries.set(name, { name, method, compressedSize, size, localHeaderOffset })
  }
  return entries
}

/** Offset of an entry's data (after its local header). */
async function dataOffset(file: Blob, entry: ZipEntry): Promise<number> {
  const h = await readBytes(file, entry.localHeaderOffset, entry.localHeaderOffset + 30)
  const hv = new DataView(h.buffer, h.byteOffset, h.byteLength)
  if (h.length < 30 || hv.getUint32(0, true) !== SIG_LOCAL)
    throw new ZipFormatError(`entry "${entry.name}" has no local header`)
  const start =
    entry.localHeaderOffset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true)
  if (start + entry.compressedSize > file.size)
    throw new ZipFormatError(`entry "${entry.name}" out of range`)
  return start
}

/**
 * Stream one entry's uncompressed bytes to `write`, in order. Fails if the
 * entry would produce more than `maxBytes`, or more than it declares.
 */
export async function extractZipEntry(
  file: Blob,
  entry: ZipEntry,
  write: (chunk: Uint8Array | Blob) => Promise<void>,
  maxBytes: number,
): Promise<number> {
  const limit = Math.min(maxBytes, entry.size)
  if (entry.size > maxBytes)
    throw new ZipFormatError(`entry "${entry.name}" is too large`)
  const start = await dataOffset(file, entry)
  const end = start + entry.compressedSize

  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size)
      throw new ZipFormatError(`entry "${entry.name}" has inconsistent sizes`)
    // Stored: copy slices of the archive itself — nothing is buffered.
    for (let at = start; at < end; at += SLICE)
      await write(file.slice(at, Math.min(end, at + SLICE)))
    return entry.size
  }

  let produced = 0
  // Set by the (synchronous) inflate callback once the output is too big.
  const state = { overflow: false }
  let pending: Uint8Array[] = []
  const inflate = new Inflate((chunk) => {
    produced += chunk.length
    if (produced > limit) state.overflow = true
    else pending.push(chunk)
  })
  const tooBig = () => new ZipFormatError(`entry "${entry.name}" expands past its size`)
  for (let at = start; at < end; at += SLICE) {
    const sliceEnd = Math.min(end, at + SLICE)
    const slice = await readBytes(file, at, sliceEnd)
    // Small pushes keep each decompressed buffer small (see INFLATE_STEP);
    // stop at the first one that goes past the limit.
    for (let i = 0; i < slice.length; i += INFLATE_STEP) {
      inflate.push(slice.subarray(i, i + INFLATE_STEP), at + i + INFLATE_STEP >= end)
      if (state.overflow) throw tooBig()
      // Write out right away: buffered output must not pile up either.
      const out = pending
      pending = []
      for (const c of out) await write(c)
    }
  }
  if (entry.compressedSize === 0) inflate.push(new Uint8Array(0), true)
  if (state.overflow) throw tooBig()
  for (const c of pending) await write(c)
  return produced
}

/** One (small) entry fully in memory, capped at `maxBytes`. */
export async function readZipEntry(
  file: Blob,
  entry: ZipEntry,
  maxBytes: number,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let total = 0
  await extractZipEntry(
    file,
    entry,
    async (c) => {
      const bytes = c instanceof Uint8Array ? c : await readBytes(c, 0, c.size)
      parts.push(bytes)
      total += bytes.length
    },
    maxBytes,
  )
  const out = new Uint8Array(total)
  let at = 0
  for (const b of parts) {
    out.set(b, at)
    at += b.length
  }
  return out
}
