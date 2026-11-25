/**
 * Finalizing a take lands in the project it was recorded into — the open
 * project, or its autosaved copy if the user switched projects meanwhile —
 * and takes interrupted by a crash are found when their project is loaded.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Project } from '../../timeline/types'
import { identityTransform } from '../../timeline/types'

const REAL_DURATION = 12
const DISK_PATH = 'D:/Videos/Dimi/take.webm'

// Remux unavailable (no tracks) → the raw file stays; duration is read as 12 s.
vi.mock('mediabunny', () => {
  class Input {
    getTracks() {
      return Promise.resolve([])
    }
    computeDuration() {
      return Promise.resolve(REAL_DURATION)
    }
    dispose() {}
  }
  // Only Input is used when remux is unavailable; the rest just need to exist.
  const Stub = function Stub() {}
  return {
    ALL_FORMATS: [],
    BlobSource: Stub,
    EncodedAudioPacketSource: Stub,
    EncodedPacketSink: Stub,
    EncodedVideoPacketSource: Stub,
    Input,
    MkvOutputFormat: Stub,
    Output: Stub,
    StreamTarget: Stub,
    WebMOutputFormat: Stub,
  }
})
vi.mock('../../storage/opfs', () => ({
  readFile: () => Promise.resolve(new Blob(['webm bytes'])),
  deletePath: () => Promise.resolve(),
}))
vi.mock('../../storage/mediaGc', () => ({ trashMedia: () => Promise.resolve() }))
vi.mock('../../storage/blobCache', () => ({ releaseAll: () => {} }))
vi.mock('../../storage/diskMedia', () => ({
  isDiskMediaAvailable: () => true,
  saveToDisk: () => Promise.resolve(DISK_PATH),
  recordingRelPath: () => 'take.webm',
  extOf: () => 'webm',
  sourceFileLabel: () => 'Screen',
}))
// Autosaved projects: an in-memory map (structuredClone = what IDB returns).
const stored = vi.hoisted(() => new Map<string, unknown>())
vi.mock('../../persistence/project', () => ({
  loadStoredProject: (id: string) =>
    Promise.resolve(stored.has(id) ? structuredClone(stored.get(id)) : null),
  updateStoredProject: (id: string, fn: (p: unknown) => boolean) => {
    if (!stored.has(id)) return Promise.resolve(false)
    const p = structuredClone(stored.get(id))
    if (!fn(p)) return Promise.resolve(false)
    stored.set(id, p)
    return Promise.resolve(true)
  },
}))

import { useEditor } from '../../timeline/store'
import { finalizeRecordedFiles } from '../finalizeRecording'

const st = () => useEditor.getState()

/** A project holding one stopped take whose clip length is a 5 s estimate. */
function takeProject(id: string, live = false): Project {
  return {
    id,
    name: 'Take project',
    fps: 30,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    tracks: [
      {
        id: 'v1',
        kind: 'video',
        name: 'Screen',
        muted: false,
        locked: false,
        height: 64,
      },
    ],
    sources: [
      {
        id: 'src',
        kind: 'video',
        opfsPath: 'sessions/s1/src.webm',
        mimeType: 'video/webm',
        duration: 5,
        createdAt: 1,
        name: 'Screen capture',
      },
    ],
    clips: [
      {
        id: 'clip',
        trackId: 'v1',
        sourceId: 'src',
        timelineStart: 0,
        sourceIn: 0,
        sourceOut: 5,
        speed: 1,
        volume: 1,
        transform: { ...identityTransform },
        ...(live ? { isLive: true } : {}),
      },
    ],
    transitions: [],
    duration: 5,
    createdAt: 1,
    updatedAt: 1,
  }
}

const file = {
  sourceId: 'src',
  clipId: 'clip',
  opfsPath: 'sessions/s1/src.webm',
  estimatedDurationSec: 5,
}

describe('finalizeRecordedFiles', () => {
  beforeEach(() => {
    stored.clear()
    st().newProject()
  })

  it('updates the open project: real duration, clip length, disk copy', async () => {
    st().loadProject(takeProject('p1'))
    await finalizeRecordedFiles([file], 'p1')
    const p = st().project
    expect(p.sources[0]!.duration).toBe(REAL_DURATION)
    expect(p.sources[0]!.diskPath).toBe(DISK_PATH)
    // A stopped take keeps its end; the extra footage is at the file's start.
    expect(p.clips[0]!.sourceOut).toBe(REAL_DURATION)
    expect(p.clips[0]!.sourceIn).toBe(REAL_DURATION - 5)
    expect(p.duration).toBe(5)
  })

  it('a take recovered after a crash grows at its end instead', async () => {
    st().loadProject(takeProject('p1'))
    await finalizeRecordedFiles([{ ...file, interrupted: true }], 'p1')
    const c = st().project.clips[0]!
    expect(c.sourceIn).toBe(0)
    expect(c.sourceOut).toBe(REAL_DURATION)
    expect(st().project.duration).toBe(REAL_DURATION)
  })

  it('updates the autosaved copy when another project was opened meanwhile', async () => {
    stored.set('p1', takeProject('p1'))
    st().loadProject(takeProject('p2')) // the user switched away
    await finalizeRecordedFiles([file], 'p1')

    const saved = stored.get('p1') as Project
    expect(saved.sources[0]!.duration).toBe(REAL_DURATION)
    expect(saved.sources[0]!.diskPath).toBe(DISK_PATH)
    expect(saved.clips[0]!.sourceOut).toBe(REAL_DURATION)
    expect(saved.clips[0]!.sourceIn).toBe(REAL_DURATION - 5)
    expect(saved.duration).toBe(5)
    // The project that is open now is untouched.
    expect(st().project.id).toBe('p2')
    expect(st().project.sources[0]!.diskPath).toBeUndefined()
  })

  it('leaves a clip the user already trimmed alone', async () => {
    const p = takeProject('p1')
    p.clips[0]!.sourceOut = 3 // trimmed after the take stopped
    stored.set('p1', p)
    st().loadProject(takeProject('p2'))
    await finalizeRecordedFiles([file], 'p1')
    expect((stored.get('p1') as Project).clips[0]!.sourceOut).toBe(3)
  })
})

describe('interrupted takes (crash recovery)', () => {
  beforeEach(() => {
    st().newProject()
  })

  it('loadProject lists clips saved mid-take and clears their live flag', () => {
    st().loadProject(takeProject('p1', true))
    expect(st().project.clips[0]!.isLive).toBeFalsy()
    const pending = st().takeInterruptedTakes()
    expect(pending).toEqual({
      projectId: 'p1',
      takes: [{ ...file, interrupted: true }],
    })
    // Consumed exactly once.
    expect(st().takeInterruptedTakes()).toBeNull()
  })

  it('a project without live clips has nothing to recover', () => {
    st().loadProject(takeProject('p1'))
    expect(st().takeInterruptedTakes()).toBeNull()
  })
})
