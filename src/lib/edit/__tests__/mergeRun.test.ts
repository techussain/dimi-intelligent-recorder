/**
 * A merge that fails while opening its output file must reset the job, or
 * every later merge is refused with "A merge is already running".
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { identityTransform } from '../../timeline/types'
import type { Project } from '../../timeline/types'

vi.mock('../../storage/blobCache', () => ({ releaseAll: vi.fn() }))

import { mergeClips, useMergeJob } from '../mergeClips'
import { useEditor } from '../../timeline/store'

const clip = (id: string, start: number) => ({
  id,
  trackId: 'ov',
  sourceId: 's',
  timelineStart: start,
  sourceIn: 0,
  sourceOut: 2,
  speed: 1,
  volume: 1,
  transform: { ...identityTransform },
})

const project: Project = {
  id: 'p',
  name: 'p',
  fps: 30,
  width: 1280,
  height: 720,
  sampleRate: 48000,
  tracks: [
    { id: 'ov', kind: 'overlay', name: 'ov', muted: false, locked: false, height: 40 },
  ],
  sources: [
    {
      id: 's',
      kind: 'video',
      opfsPath: 's.webm',
      mimeType: 'video/webm',
      duration: 2,
      createdAt: 0,
      name: 's',
    },
  ],
  clips: [clip('a', 0), clip('b', 2)],
  transitions: [],
  duration: 4,
  createdAt: 0,
  updatedAt: 0,
}

describe('mergeClips job state', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'storage')
  afterEach(() => {
    if (original) Object.defineProperty(navigator, 'storage', original)
  })

  it('a storage failure resets the job, so the next merge can run', async () => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { getDirectory: () => Promise.reject(new Error('storage unavailable')) },
    })
    useEditor.getState().loadProject(project)
    await expect(mergeClips(['a', 'b'])).rejects.toThrow(/storage unavailable/)
    expect(useMergeJob.getState().job).toBeNull()
    // Not "A merge is already running."
    await expect(mergeClips(['a', 'b'])).rejects.toThrow(/storage unavailable/)
  })
})
