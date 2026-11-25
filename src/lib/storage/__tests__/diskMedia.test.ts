/**
 * diskMedia: OPFS ↔ recordings-folder copies, with an in-memory OPFS and an
 * in-memory disk behind a mocked `window.electronAPI.media`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MediaSource, Project } from '../../timeline/types'

const opfs = vi.hoisted(() => ({ files: new Map<string, Uint8Array>() }))
const notFound = () => Object.assign(new Error('not found'), { name: 'NotFoundError' })

vi.mock('../opfs', () => ({
  readFile: (path: string) => {
    const data = opfs.files.get(path)
    if (!data) return Promise.reject(notFound())
    return Promise.resolve(new File([data as BlobPart], path.split('/').pop()!))
  },
  deletePath: (path: string) => {
    opfs.files.delete(path)
    return Promise.resolve()
  },
  openAppendWriter: (path: string) => {
    const parts: Uint8Array[] = []
    opfs.files.set(path, new Uint8Array(0))
    return Promise.resolve({
      append: (d: Uint8Array) => {
        parts.push(d.slice())
        return Promise.resolve()
      },
      close: () => {
        const total = parts.reduce((n, p) => n + p.byteLength, 0)
        const out = new Uint8Array(total)
        let o = 0
        for (const p of parts) {
          out.set(p, o)
          o += p.byteLength
        }
        opfs.files.set(path, out)
        return Promise.resolve()
      },
    })
  },
}))
const emitError = vi.hoisted(() => vi.fn())
vi.mock('../../errorBus', () => ({ emitError }))

import {
  _setDiskChunkSize,
  checkProjectMedia,
  dropUnreachableDiskPaths,
  ensureProjectMedia,
  isDiskMediaAvailable,
  recordingRelPath,
  restoreFromDisk,
  saveToDisk,
  _resetCheckedProject,
} from '../diskMedia'
import { ProjectSchema } from '../../persistence/projectSchema'

/** Small chunks keep the fixtures tiny (deep-equality on MiBs is slow). */
const CHUNK = 16
const FOLDER = 'C:/Users/me/Videos/Dimi Intelligent Recorder'

function makeDisk() {
  const files = new Map<string, Uint8Array>()
  const open = new Map<number, { path: string; parts: Uint8Array[] }>()
  let nextId = 1
  const media = {
    failWriteAt: -1,
    writes: 0,
    getFolder: vi.fn(() => Promise.resolve(FOLDER)),
    chooseFolder: vi.fn(() => Promise.resolve(null)),
    reveal: vi.fn(),
    openWrite: vi.fn((rel: string) => {
      const id = nextId++
      const path = `${FOLDER}/${rel}`
      open.set(id, { path, parts: [] })
      return Promise.resolve({ id, path })
    }),
    write: vi.fn((id: number, data: Uint8Array) => {
      if (media.writes++ === media.failWriteAt)
        return Promise.reject(new Error('disk full'))
      open.get(id)!.parts.push(data.slice())
      return Promise.resolve()
    }),
    closeWrite: vi.fn((id: number) => {
      const w = open.get(id)!
      open.delete(id)
      const total = w.parts.reduce((n, p) => n + p.byteLength, 0)
      const out = new Uint8Array(total)
      let o = 0
      for (const p of w.parts) {
        out.set(p, o)
        o += p.byteLength
      }
      files.set(w.path, out)
      return Promise.resolve()
    }),
    abortWrite: vi.fn((id: number) => {
      open.delete(id)
      return Promise.resolve()
    }),
    stat: vi.fn((p: string) => Promise.resolve(files.get(p)?.byteLength ?? -1)),
    read: vi.fn((p: string, offset: number, length: number) =>
      Promise.resolve(files.get(p)!.slice(offset, offset + length)),
    ),
    registerImport: vi.fn(() => ''),
  }
  return { media, files, open }
}

function bytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = i % 251
  return b
}

function src(id: string, extra: Partial<MediaSource> = {}): MediaSource {
  return {
    id,
    kind: 'video',
    opfsPath: `sessions/s/${id}.webm`,
    mimeType: 'video/webm',
    duration: 1,
    createdAt: 0,
    name: `Source ${id}`,
    ...extra,
  }
}

function project(sources: MediaSource[], id = 'p1'): Project {
  return {
    id,
    name: 'Demo',
    fps: 30,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    tracks: [],
    clips: [],
    transitions: [],
    markers: [],
    sources,
    duration: 0,
    createdAt: 0,
    updatedAt: 0,
  }
}

let disk: ReturnType<typeof makeDisk>

beforeEach(() => {
  opfs.files.clear()
  emitError.mockReset()
  disk = makeDisk()
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = { media: disk.media }
  _resetCheckedProject()
  _setDiskChunkSize(CHUNK)
})

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('recordingRelPath', () => {
  const date = new Date(2026, 8, 30, 10, 2, 7)

  it('builds "<Project>/<timestamp> <Label>.<ext>"', () => {
    expect(recordingRelPath('My Project', 'Screen', date)).toBe(
      'My Project/2026-09-30 10.02.07 Screen.webm',
    )
    expect(recordingRelPath('P', 'System audio', date, '.MKV')).toBe(
      'P/2026-09-30 10.02.07 System audio.mkv',
    )
  })

  it('sanitizes unsafe names', () => {
    expect(recordingRelPath('a/b\\c:d*?"<>|', 'Scr/een', date)).toBe(
      'a_b_c_d_/2026-09-30 10.02.07 Scr_een.webm',
    )
    expect(recordingRelPath('  ..  ', 'Mic', date)).toBe(
      'Untitled Project/2026-09-30 10.02.07 Mic.webm',
    )
    expect(recordingRelPath('CON', 'Mic', date).startsWith('CON_/')).toBe(true)
    expect(recordingRelPath('x'.repeat(200), 'Mic', date).split('/')[0]!.length).toBe(
      80,
    )
  })
})

describe('saveToDisk', () => {
  it('is a no-op without the desktop API', async () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
    expect(isDiskMediaAvailable()).toBe(false)
    opfs.files.set('a.webm', bytes(10))
    expect(await saveToDisk('a.webm', 'P/a.webm')).toBeNull()
  })

  it('streams the file in chunks and returns the absolute path', async () => {
    const data = bytes(CHUNK * 2 + 5)
    opfs.files.set('a.webm', data)
    const path = await saveToDisk('a.webm', 'P/a.webm')
    expect(path).toBe(`${FOLDER}/P/a.webm`)
    expect(disk.media.write).toHaveBeenCalledTimes(3)
    expect(disk.files.get(path!)).toEqual(data)
    expect(emitError).not.toHaveBeenCalled()
  })

  it('aborts the write and reports on failure', async () => {
    opfs.files.set('a.webm', bytes(CHUNK * 2))
    disk.media.failWriteAt = 1
    expect(await saveToDisk('a.webm', 'P/a.webm')).toBeNull()
    expect(disk.media.abortWrite).toHaveBeenCalledWith(1)
    expect(disk.media.closeWrite).not.toHaveBeenCalled()
    expect(disk.files.size).toBe(0)
    expect(emitError).toHaveBeenCalledWith(
      `Couldn't save a copy of the recording to ${FOLDER}`,
      expect.any(Error),
    )
  })

  it('reports a missing OPFS file without opening a write', async () => {
    expect(
      await saveToDisk('nope.webm', 'P/a.webm', { what: 'merged clip' }),
    ).toBeNull()
    expect(disk.media.openWrite).not.toHaveBeenCalled()
    expect(emitError.mock.calls[0]![0]).toContain('merged clip')
  })
})

describe('restoreFromDisk', () => {
  it('copies the disk file into OPFS', async () => {
    const data = bytes(CHUNK + 5)
    disk.files.set('/d/a.webm', data)
    expect(await restoreFromDisk('/d/a.webm', 'sessions/s/a.webm')).toBe(true)
    expect(opfs.files.get('sessions/s/a.webm')).toEqual(data)
    expect(disk.media.read).toHaveBeenCalledTimes(2)
  })

  it('fails for a missing disk file and leaves OPFS untouched', async () => {
    expect(await restoreFromDisk('/d/missing.webm', 'x.webm')).toBe(false)
    expect(opfs.files.has('x.webm')).toBe(false)
  })

  it('removes a partial copy when reading fails', async () => {
    disk.files.set('/d/a.webm', bytes(100))
    disk.media.read.mockRejectedValueOnce(new Error('io'))
    expect(await restoreFromDisk('/d/a.webm', 'x.webm')).toBe(false)
    expect(opfs.files.has('x.webm')).toBe(false)
  })
})

describe('ensureProjectMedia', () => {
  it('restores missing OPFS files from disk and reports truly missing ones', async () => {
    const present = src('a', { diskPath: '/d/a.webm' })
    const restorable = src('b', { diskPath: '/d/b.webm' })
    const goneEverywhere = src('c', { diskPath: '/d/c.webm', name: 'Screen capture' })
    const noDisk = src('d', { name: 'Old import' })
    const text = src('t', { kind: 'text', opfsPath: '' })
    opfs.files.set(present.opfsPath, bytes(3))
    disk.files.set('/d/b.webm', bytes(42))

    const res = await ensureProjectMedia(
      project([present, restorable, goneEverywhere, noDisk, text]),
    )
    expect(res).toEqual({ restored: 1, missing: ['Screen capture', 'Old import'] })
    expect(opfs.files.get(restorable.opfsPath)).toEqual(bytes(42))
    // Present files are never re-read from disk.
    expect(disk.media.stat).not.toHaveBeenCalledWith('/d/a.webm')
  })

  it('checkProjectMedia reports missing files once per project', async () => {
    const p = project([src('c', { name: 'Webcam capture' })])
    await checkProjectMedia(p)
    await checkProjectMedia(p)
    expect(emitError).toHaveBeenCalledTimes(1)
    expect(emitError.mock.calls[0]![0]).toBe('1 media file is missing: Webcam capture')
  })

  it('checkProjectMedia does nothing in the browser', async () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
    expect(await checkProjectMedia(project([src('c')]))).toBeNull()
    expect(emitError).not.toHaveBeenCalled()
  })
})

describe('dropUnreachableDiskPaths', () => {
  it('keeps only paths that exist here', async () => {
    disk.files.set('/d/a.webm', bytes(1))
    const out = await dropUnreachableDiskPaths([
      src('a', { diskPath: '/d/a.webm' }),
      src('b', { diskPath: '/other-machine/b.webm' }),
      src('c'),
    ])
    expect(out.map((s) => s.diskPath)).toEqual(['/d/a.webm', undefined, undefined])
    expect('diskPath' in out[1]!).toBe(false)
  })
})

describe('schema', () => {
  it('round-trips diskPath', () => {
    const p = project([src('a', { diskPath: 'D:\\Videos\\a.webm' }), src('b')])
    const parsed = ProjectSchema.parse(JSON.parse(JSON.stringify(p)))
    expect(parsed.sources[0]!.diskPath).toBe('D:\\Videos\\a.webm')
    expect(parsed.sources[1]!.diskPath).toBeUndefined()
  })
})
