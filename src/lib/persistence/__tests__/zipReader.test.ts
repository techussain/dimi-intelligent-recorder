/**
 * zipReader memory bounds: a lying entry is rejected before it can allocate
 * much (the inflater's own output buffers stay small), and an oversized
 * central directory is refused before it is read.
 */
import { describe, it, expect, vi } from 'vitest'
import { zipSync } from 'fflate'

// Record the largest buffer the inflater ever hands out.
const seen = vi.hoisted(() => ({ maxChunk: 0 }))
vi.mock('fflate', async (importOriginal) => {
  const real = await importOriginal<typeof import('fflate')>()
  class Inflate extends real.Inflate {
    constructor(cb: (chunk: Uint8Array, final: boolean) => void) {
      super((chunk, final) => {
        seen.maxChunk = Math.max(seen.maxChunk, chunk.length)
        cb(chunk, final)
      })
    }
  }
  return { ...real, Inflate }
})

import { extractZipEntry, readZipDirectory } from '../zipReader'

const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50

/** Patch every central-directory entry's declared size. */
function claimSize(zip: Uint8Array, size: number): void {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  for (let i = 0; i + 46 < zip.length; i++)
    if (v.getUint32(i, true) === SIG_CENTRAL) v.setUint32(i + 24, size, true)
}

describe('zipReader memory bounds', () => {
  it('stops a zip bomb after ~1 MB of output, not after inflating it all', async () => {
    // 32 MB of zeros deflates to a few dozen KB.
    const zip = zipSync({ 'bomb.bin': new Uint8Array(32 * 1024 * 1024) }, { level: 9 })
    claimSize(zip, 1024) // ...but claims to be 1 KB
    const blob = new Blob([zip as BlobPart])
    const entry = (await readZipDirectory(blob)).get('bomb.bin')!
    seen.maxChunk = 0
    const writes: number[] = []
    await expect(
      extractZipEntry(
        blob,
        entry,
        (c) =>
          Promise.resolve(
            void writes.push(c instanceof Uint8Array ? c.length : c.size),
          ),
        1024,
      ),
    ).rejects.toThrow(/expands past its size/)
    expect(seen.maxChunk).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(writes).toEqual([]) // nothing past the limit was written
  })

  it('refuses a central directory larger than the cap before reading it', async () => {
    const zip = zipSync({ 'a.txt': new Uint8Array([1, 2, 3]) })
    const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    for (let i = zip.length - 22; i >= 0; i--) {
      if (v.getUint32(i, true) !== SIG_EOCD) continue
      v.setUint32(i + 12, 64 * 1024 * 1024, true) // cdSize: 64 MB
      break
    }
    await expect(readZipDirectory(new Blob([zip as BlobPart]))).rejects.toThrow(
      /directory too large/,
    )
  })
})
