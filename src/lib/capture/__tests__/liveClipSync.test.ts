/**
 * While recording, every track's live clip must end at the same timeline
 * point, even though each recorder delivers its chunks on its own schedule.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useEditor } from '../../timeline/store'
import { clipEndSec as clipEnd } from '../../timeline/selectors'

vi.mock('../../storage/opfs', () => ({
  openAppendWriter: () =>
    Promise.resolve({
      append: () => Promise.resolve(),
      close: () => Promise.resolve(),
    }),
}))
vi.mock('../../storage/blobCache', () => ({ releaseAll: vi.fn() }))

import { CaptureManager } from '../captureManager'

interface FakeRec {
  sourceId: string
  trackId: string
  clipKind: 'video' | 'audio' | 'overlay'
  startedAtMs: number
  pausedAccumMs: number
  pausedAtMs: number | null
  totalDurationSec: number
  byteOffset: number
  writer: null
  writeFailed: boolean
  liveClipId: string | null
  opfsPath: string
  mimeType: string
}

type Internals = {
  active: FakeRec[]
  onChunk(rec: FakeRec, ev: { data: Blob }, beforeFirst: () => void): Promise<void>
}

const rec = (trackId: string, startedAtMs: number): FakeRec => ({
  sourceId: `src-${trackId}`,
  trackId,
  clipKind: 'video',
  startedAtMs,
  pausedAccumMs: 0,
  pausedAtMs: null,
  totalDurationSec: 0,
  byteOffset: 0,
  writer: null,
  writeFailed: false,
  liveClipId: null,
  opfsPath: `sessions/x/${trackId}.webm`,
  mimeType: 'video/webm',
})

describe('live clip growth', () => {
  beforeEach(() => {
    useEditor.getState().newProject()
  })

  it('extends all live clips together when any recorder delivers a chunk', async () => {
    const st = useEditor.getState()
    const v1 = st.addTrack('video', 'Screen')
    const a1 = st.addTrack('audio', 'Mic')
    st.startRecording()

    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const cm = new CaptureManager() as unknown as Internals
    const screen = rec(v1, 1000)
    const mic = rec(a1, 1000)
    cm.active = [screen, mic]
    const chunk = { data: new Blob([new Uint8Array(4)]) }

    now = 2000
    await cm.onChunk(screen, chunk, () => {})
    await cm.onChunk(mic, chunk, () => {})
    // Only the screen recorder delivers its next chunk.
    now = 2900
    await cm.onChunk(screen, chunk, () => {})

    const clips = useEditor.getState().project.clips
    const ends = [screen, mic].map((r) =>
      clipEnd(clips.find((c) => c.id === r.liveClipId)!),
    )
    expect(ends[0]).toBeCloseTo(1.9)
    expect(ends[1]).toBeCloseTo(ends[0]!)
    vi.restoreAllMocks()
  })
})
