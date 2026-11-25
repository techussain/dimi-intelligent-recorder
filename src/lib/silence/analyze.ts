/**
 * Main-thread side of silence analysis: runs silence.worker.ts for one file at
 * a time, caches envelopes by file path (sliders re-detect instantly), and
 * applies a removal to the timeline.
 */
import { create } from 'zustand'
import { LRUCache } from '../media/lru'
import { useEditor } from '../timeline/store'
import type { Clip, ID } from '../timeline/types'
import {
  detectSilences,
  silencesOnTimeline,
  type Envelope,
  type SilenceOptions,
} from './detect'
import type { TimeRange } from '../timeline/cutRanges'

/** Envelopes are small (~180 kB per hour of audio); keep a few. */
const cache = new LRUCache<string, Envelope>(12)

export const useSilenceJob = create<{ job: { sourceId: ID; progress: number } | null }>(
  () => ({
    job: null,
  }),
)

let running: Worker | null = null
let cancelRunning: (() => void) | null = null
let nextId = 1

export function getCachedEnvelope(opfsPath: string): Envelope | undefined {
  return cache.get(opfsPath)
}

/** Loudness envelope of a source's audio (cached). One analysis at a time. */
export function analyzeSource(sourceId: ID, opfsPath: string): Promise<Envelope> {
  const hit = cache.get(opfsPath)
  if (hit) return Promise.resolve(hit)
  if (running) return Promise.reject(new Error('Another analysis is running.'))

  const id = nextId++
  const w = new Worker(new URL('../../workers/silence.worker.ts', import.meta.url), {
    type: 'module',
  })
  running = w
  useSilenceJob.setState({ job: { sourceId, progress: 0 } })

  return new Promise<Envelope>((resolve, reject) => {
    const done = () => {
      w.terminate()
      running = null
      cancelRunning = null
      useSilenceJob.setState({ job: null })
    }
    cancelRunning = () => {
      done()
      reject(new Error('Analysis canceled.'))
    }
    w.onmessage = (
      ev: MessageEvent<
        | { id: number; type: 'progress'; progress: number }
        | {
            id: number
            type: 'result'
            start: number
            frameSec: number
            db: Float32Array
          }
        | { id: number; type: 'error'; message: string }
      >,
    ) => {
      const m = ev.data
      if (m.id !== id) return
      if (m.type === 'progress') {
        useSilenceJob.setState({ job: { sourceId, progress: m.progress } })
      } else if (m.type === 'result') {
        done()
        const env: Envelope = { start: m.start, frameSec: m.frameSec, db: m.db }
        cache.set(opfsPath, env)
        resolve(env)
      } else {
        done()
        reject(new Error(m.message))
      }
    }
    w.onerror = (ev) => {
      ev.preventDefault()
      done()
      reject(new Error(ev.message || 'The analysis worker crashed.'))
    }
    w.postMessage({ id, opfsPath })
  })
}

export function cancelAnalysis(): void {
  cancelRunning?.()
}

/** The pauses a removal would cut, in timeline seconds, for one clip. */
export function pausesForClip(
  clip: Clip,
  env: Envelope,
  opts: SilenceOptions,
): TimeRange[] {
  return silencesOnTimeline(clip, detectSilences(env, opts))
}

/**
 * Cut the given pauses from every track (keeps sync). One undo step.
 * Throws with a user-facing message if refused.
 */
export function removePauses(ranges: TimeRange[]): {
  removedSec: number
  count: number
} {
  const r = useEditor.getState().removeTimeRanges(ranges)
  if (!r.ok) throw new Error(r.reason)
  return { removedSec: r.removedSec, count: r.count }
}
