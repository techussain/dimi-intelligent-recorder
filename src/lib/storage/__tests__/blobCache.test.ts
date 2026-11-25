/**
 * blobCache reference counting.
 *
 * Mocks URL.createObjectURL / revokeObjectURL and verifies that:
 * - acquire ×2 → release ×1 keeps the URL alive
 * - acquire ×2 → release ×2 revokes the URL
 * - releaseAll revokes all cached URLs regardless of refcount
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the OPFS readFile so getBlobUrl doesn't touch the filesystem.
vi.mock('../opfs', () => ({
  readFile: vi.fn().mockResolvedValue(new Blob(['test'], { type: 'video/webm' })),
}))

import { getBlobUrl, releaseBlobUrl, releaseAll } from '../blobCache'

// ─── helpers ─────────────────────────────────────────────────────────────────

function setupUrlMocks() {
  let counter = 0
  const created = new Map<string, string>() // opfsPath → URL (for assertion helpers)
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const url = `blob:mock-${++counter}`
    return url
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  return { created }
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('blobCache reference counting', () => {
  beforeEach(() => {
    // Clear all cached URLs and refcounts between tests.
    releaseAll()
    setupUrlMocks()
  })

  it('first acquire creates a new object URL', async () => {
    await getBlobUrl('video.webm')
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('second acquire returns the same cached URL without creating a new one', async () => {
    const url1 = await getBlobUrl('video.webm')
    const url2 = await getBlobUrl('video.webm')
    expect(url1).toBe(url2)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('acquire ×2, release ×1 — URL is NOT revoked', async () => {
    await getBlobUrl('a.webm') // refcount = 1
    await getBlobUrl('a.webm') // refcount = 2
    releaseBlobUrl('a.webm') // refcount = 1
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  })

  it('acquire ×2, release ×2 — URL IS revoked', async () => {
    const url = await getBlobUrl('b.webm') // refcount = 1
    await getBlobUrl('b.webm') // refcount = 2
    releaseBlobUrl('b.webm') // refcount = 1
    releaseBlobUrl('b.webm') // refcount = 0 → revoke
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(url)
  })

  it('acquire ×1, release ×1 — URL is revoked immediately', async () => {
    const url = await getBlobUrl('c.webm')
    releaseBlobUrl('c.webm')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(url)
  })

  it('releaseAll revokes all cached URLs regardless of refcount', async () => {
    await getBlobUrl('x.webm') // refcount 1
    await getBlobUrl('x.webm') // refcount 2
    await getBlobUrl('y.webm') // refcount 1
    // x has refcount 2, y has refcount 1 — neither manually released
    releaseAll()
    // Both URLs should be revoked (x and y have one URL each)
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
  })

  it('after releaseAll, next getBlobUrl creates a fresh URL', async () => {
    await getBlobUrl('d.webm')
    releaseAll()
    await getBlobUrl('d.webm')
    // createObjectURL called twice: once before releaseAll, once after
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2)
  })

  it('concurrent misses share one object URL and count both references', async () => {
    const [u1, u2] = await Promise.all([getBlobUrl('e.webm'), getBlobUrl('e.webm')])
    expect(u1).toBe(u2)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    releaseBlobUrl('e.webm')
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    releaseBlobUrl('e.webm')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(u1)
  })

  it('releasing an unknown path is a no-op (no crash)', () => {
    expect(() => releaseBlobUrl('nonexistent.webm')).not.toThrow()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  })
})

describe('blobCache stale releases', () => {
  beforeEach(() => {
    releaseAll()
    let counter = 0
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:stale-${++counter}`)
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  })

  it('releasing a URL from before releaseAll never revokes its replacement', async () => {
    const old = await getBlobUrl('a.webm')
    releaseAll() // project switch
    const fresh = await getBlobUrl('a.webm')
    expect(fresh).not.toBe(old)
    releaseBlobUrl('a.webm', old) // late release from the previous project
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(fresh)
    // The fresh URL is still cached: the next acquire reuses it.
    expect(await getBlobUrl('a.webm')).toBe(fresh)
  })
})
