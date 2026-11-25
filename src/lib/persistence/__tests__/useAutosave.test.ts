/**
 * useAutosave: throttled checkpoints mid-recording (crash recovery) plus one
 * save on stop, and flushes the previous project when the open project is
 * switched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Project } from '../../timeline/types'

const saved = vi.hoisted(() => ({ current: [] as string[], stored: [] as string[] }))
vi.mock('../project', () => ({
  saveCurrentProject: (p: Project) => {
    saved.current.push(`${p.id}:${p.name}`)
    return Promise.resolve()
  },
  saveStoredProject: (p: Project) => {
    saved.stored.push(`${p.id}:${p.name}`)
    return Promise.resolve()
  },
  loadCurrentProject: () => Promise.resolve(null),
}))
vi.mock('../../storage/blobCache', () => ({ releaseAll: () => {} }))

import { useAutosave } from '../useAutosave'
import { useEditor } from '../../timeline/store'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Harness() {
  useAutosave(800)
  return null
}

describe('useAutosave', () => {
  let root: Root
  const st = () => useEditor.getState()

  beforeEach(() => {
    vi.useFakeTimers()
    saved.current = []
    saved.stored = []
    st().newProject()
    root = createRoot(document.createElement('div'))
    act(() => root.render(createElement(Harness)))
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
  })

  const flushTimers = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  it('debounces ordinary edits into one save', async () => {
    st().setProjectName('One')
    st().addMarker({ time: 1, label: 'm' })
    await flushTimers(1000)
    expect(saved.current).toEqual([`${st().project.id}:One`])
  })

  it('checkpoints a recording every few seconds (throttled), then saves on stop', async () => {
    st().startRecording()
    const screen = st().project.tracks[0]!.id
    const live = st().addClip({
      trackId: screen,
      sourceId: 's',
      timelineStart: 0,
      sourceIn: 0,
      sourceOut: 1,
      speed: 1,
      volume: 1,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 },
      isLive: true,
    })
    // A chunk every second for 12 s: a debounce would never fire; the
    // throttle saves at ~5 s and ~10 s.
    for (let i = 2; i < 14; i++) {
      st().extendLiveClip(live, i)
      await flushTimers(1000)
    }
    expect(saved.current).toHaveLength(2)
    st().stopRecording()
    await flushTimers(10)
    expect(saved.current).toHaveLength(3)
  })

  it('flushes the previous project immediately when switching projects', async () => {
    const oldId = st().project.id
    st().setProjectName('Old edits')
    st().newProject() // before the debounce fired
    await flushTimers(0)
    expect(saved.stored).toEqual([`${oldId}:Old edits`])
    await flushTimers(1000)
    expect(saved.current).toEqual([`${st().project.id}:Untitled Project`])
  })
})
