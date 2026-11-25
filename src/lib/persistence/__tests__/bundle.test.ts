/**
 * .irbundle save/restore: missing media is reported, media is stored
 * uncompressed, and restore only writes referenced, validated paths into a
 * fresh session folder (never partial, never over another project's files).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { zipSync, unzipSync, strToU8 as rawStrToU8 } from 'fflate'
import type { Project } from '../../timeline/types'

const fs = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  failWrites: new Set<string>(),
  writes: [] as string[],
}))
vi.mock('../../storage/opfs', () => ({
  readFile: (p: string) => {
    const d = fs.files.get(p)
    return d
      ? Promise.resolve(new File([d as BlobPart], p))
      : Promise.reject(new Error('NotFound'))
  },
  writeFile: (p: string, d: Uint8Array) => {
    fs.writes.push(p)
    if ([...fs.failWrites].some((f) => p.endsWith(f)))
      return Promise.reject(new Error('quota'))
    fs.files.set(p, d)
    return Promise.resolve()
  },
  openFileWriter: (p: string) => {
    fs.writes.push(p)
    const parts: Uint8Array[] = []
    const failing = [...fs.failWrites].some((f) => p.endsWith(f))
    return Promise.resolve({
      write: async (c: Uint8Array | Blob) => {
        if (failing) throw new Error('quota')
        parts.push(c instanceof Uint8Array ? c : await readBlob(c))
      },
      close: () => {
        const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0))
        let at = 0
        for (const x of parts) {
          out.set(x, at)
          at += x.length
        }
        fs.files.set(p, out)
        return Promise.resolve()
      },
      abort: () => Promise.resolve(),
    })
  },
  deletePath: (p: string) => {
    fs.files.delete(p)
    return Promise.resolve()
  },
  removeDirIfEmpty: () => Promise.resolve(),
}))
vi.mock('../../errorBus', () => ({ emitError: () => {} }))

import {
  saveProjectBundle,
  restoreBundle,
  MissingMediaError,
  MAX_BUNDLE_BYTES,
  isSafeOpfsPath,
} from '../bundle'
import { serialize } from '../project'

// jsdom's TextEncoder returns a Uint8Array from another realm, which fflate's
// `instanceof` checks treat as a directory; re-wrap in this realm.
const strToU8 = (s: string) => Uint8Array.from(rawStrToU8(s))

/** Read a Blob without Blob.stream/arrayBuffer (missing in jsdom). */
function readBlob(b: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer))
    r.onerror = () => reject(r.error ?? new Error('read failed'))
    r.readAsArrayBuffer(b)
  })
}

function project(sources: { id: string; opfsPath: string }[]): Project {
  return {
    id: 'orig',
    name: 'P',
    fps: 30,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    tracks: [],
    clips: [],
    transitions: [],
    duration: 0,
    createdAt: 0,
    updatedAt: 0,
    sources: sources.map((s) => ({
      ...s,
      kind: 'video' as const,
      mimeType: 'video/webm',
      duration: 1,
      createdAt: 0,
      name: s.id,
    })),
  }
}

function zipBytes(
  p: Project,
  extra: Record<string, Uint8Array> = {},
  level: 0 | 6 = 6,
): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'project.irproj': strToU8(serialize(p)),
    ...extra,
  }
  for (const s of p.sources)
    if (s.opfsPath && !(s.opfsPath in files))
      files[s.opfsPath] = strToU8(`data:${s.id}`)
  return zipSync(files, { level })
}

function bundle(
  p: Project,
  extra: Record<string, Uint8Array> = {},
  level: 0 | 6 = 6,
): Blob {
  return new Blob([zipBytes(p, extra, level) as BlobPart])
}

beforeEach(() => {
  fs.files.clear()
  fs.failWrites.clear()
  fs.writes = []
})

describe('saveProjectBundle', () => {
  it('throws MissingMediaError listing missing media instead of reporting success', async () => {
    fs.files.set('sessions/a/x.webm', new Uint8Array([1]))
    const p = project([
      { id: 'x', opfsPath: 'sessions/a/x.webm' },
      { id: 'gone', opfsPath: 'sessions/a/gone.webm' },
    ])
    await expect(saveProjectBundle(p)).rejects.toBeInstanceOf(MissingMediaError)
    await expect(saveProjectBundle(p)).rejects.toThrow(/gone/)
  })

  it('stores media uncompressed (level 0) and round-trips', async () => {
    const media = new Uint8Array(5000).fill(7) // highly compressible on purpose
    fs.files.set('sessions/a/x.webm', media)
    let blob: Blob | null = null
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      blob = b as Blob
      return 'blob:x'
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    await saveProjectBundle(project([{ id: 'x', opfsPath: 'sessions/a/x.webm' }]))
    const bytes = Uint8Array.from(await readBlob(blob!))
    const compression: Record<string, number> = {}
    const out = unzipSync(bytes, {
      filter: (f) => {
        compression[f.name] = f.compression
        return true
      },
    })
    expect(compression['sessions/a/x.webm']).toBe(0)
    expect(out['sessions/a/x.webm']).toEqual(media)
    expect(out['project.irproj']).toBeDefined()
  })
})

describe('saveProjectBundle size limit', () => {
  it('refuses projects too large for a bundle (no ZIP64) before asking where to save', async () => {
    const huge = { size: MAX_BUNDLE_BYTES + 1 } as File
    fs.files.set('sessions/a/x.webm', new Uint8Array([1]))
    const p = project([{ id: 'x', opfsPath: 'sessions/a/x.webm' }])
    const opfs = await import('../../storage/opfs')
    vi.spyOn(opfs, 'readFile').mockResolvedValue(huge)
    await expect(saveProjectBundle(p)).rejects.toThrow(/up to 4 GB/)
  })
})

describe('restoreBundle', () => {
  it('writes only referenced entries, into a fresh session folder, and rewrites paths', async () => {
    const p = project([{ id: 'x', opfsPath: 'sessions/other/x.webm' }])
    const restored = await restoreBundle(
      bundle(p, { 'imports/evil.webm': strToU8('nope') }),
    )
    expect(restored.id).not.toBe('orig')
    const path = restored.sources[0]!.opfsPath
    expect(path.startsWith(`sessions/${restored.id}/`)).toBe(true)
    expect(fs.writes).toEqual([path])
    expect(fs.files.has('sessions/other/x.webm')).toBe(false)
    expect(fs.files.has('imports/evil.webm')).toBe(false)
  })

  it('rejects an unsafe source path before writing anything', async () => {
    const p = project([
      { id: 'ok', opfsPath: 'sessions/a/ok.webm' },
      { id: 'bad', opfsPath: '../escape.webm' },
    ])
    await expect(restoreBundle(bundle(p))).rejects.toThrow(/invalid path/)
    expect(fs.writes).toEqual([])
  })

  it('fails and removes already-written files when a write fails', async () => {
    const p = project([
      { id: 'a', opfsPath: 'sessions/s/a.webm' },
      { id: 'b', opfsPath: 'sessions/s/b.webm' },
    ])
    fs.failWrites.add('b.webm')
    await expect(restoreBundle(bundle(p))).rejects.toThrow(/Could not restore media/)
    expect(fs.writes).toHaveLength(2)
    expect(fs.files.size).toBe(0)
  })

  it('restores stored (uncompressed) media byte for byte', async () => {
    const media = Uint8Array.from({ length: 10_000 }, (_, i) => i % 251)
    const p = project([{ id: 'x', opfsPath: 'sessions/a/x.webm' }])
    const restored = await restoreBundle(bundle(p, { 'sessions/a/x.webm': media }, 0))
    expect(fs.files.get(restored.sources[0]!.opfsPath)).toEqual(media)
  })

  it('refuses an entry that expands past its declared size (zip bomb)', async () => {
    const p = project([{ id: 'x', opfsPath: 'sessions/a/x.webm' }])
    const zip = zipBytes(p, { 'sessions/a/x.webm': new Uint8Array(50_000) }, 6)
    // Make the central directory claim the media is only 10 bytes.
    const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    const name = strToU8('sessions/a/x.webm')
    for (let i = 0; i + 46 < zip.length; i++) {
      if (v.getUint32(i, true) !== 0x02014b50) continue
      const n = v.getUint16(i + 28, true)
      if (
        n === name.length &&
        zip.subarray(i + 46, i + 46 + n).every((b, k) => b === name[k])
      )
        v.setUint32(i + 24, 10, true)
    }
    await expect(restoreBundle(new Blob([zip as BlobPart]))).rejects.toThrow(
      /expands past its size/,
    )
    expect(fs.files.size).toBe(0)
  })

  it('rejects a file that is not a zip', async () => {
    await expect(restoreBundle(new Blob(['not a zip at all']))).rejects.toThrow(
      /Not a valid bundle/,
    )
  })

  it('isSafeOpfsPath rejects traversal, absolute, backslash and empty segments', () => {
    expect(isSafeOpfsPath('sessions/a/b.webm')).toBe(true)
    for (const p of ['', '/a', 'a\\b', 'a/../b', './a', 'a//b'])
      expect(isSafeOpfsPath(p)).toBe(false)
  })
})
