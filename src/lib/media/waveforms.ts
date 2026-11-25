/**
 * Waveform peaks — delegates to a Web Worker (mediabunny streaming decode +
 * peak binning) so audio decoding never blocks the main thread.
 * Results are kept in an LRU cache (max 50 entries). Failures are never
 * cached, so a later call retries.
 */
import { LRUCache } from './lru'
import { readFile } from '../storage/opfs'

/** A request that hasn't answered by now is abandoned (rejected). */
const REQUEST_TIMEOUT_MS = 120_000

// Lazy worker singleton.
let worker: Worker | null = null
function getWorker(): Worker {
  if (!worker) {
    const w = new Worker(
      new URL('../../workers/waveforms.worker.ts', import.meta.url),
      { type: 'module' },
    )
    w.addEventListener('message', onMessage)
    // A crashed/unloadable worker never answers: fail everything pending and
    // start a fresh worker on the next request.
    w.addEventListener('error', (ev) => {
      ev.preventDefault()
      if (worker === w) worker = null
      w.terminate()
      const err = new Error(ev.message || 'Waveform worker crashed')
      for (const [id, p] of pending) {
        pending.delete(id)
        p.reject(err)
      }
    })
    worker = w
  }
  return worker
}

interface Pending {
  resolve: (v: Float32Array) => void
  reject: (err: unknown) => void
}

let nextId = 0
const pending = new Map<number, Pending>()

function onMessage(
  ev: MessageEvent<{ id: number; peaks?: Float32Array; error?: string }>,
): void {
  const { id, peaks, error } = ev.data
  const p = pending.get(id)
  if (!p) return // timed out already
  pending.delete(id)
  if (error !== undefined) {
    p.reject(new Error(error))
  } else if (peaks) {
    p.resolve(peaks)
  } else {
    p.reject(new Error('Waveform worker returned no data'))
  }
}

// LRU cache — evicts the least-recently-used entry when full.
const cache = new LRUCache<string, Float32Array>(50)
const inFlight = new Map<string, Promise<Float32Array>>()

export const WAVEFORM_BIN_COUNT = 200

/**
 * Largest file the main-thread fallback will decode. decodeAudioData needs the
 * whole file plus the full PCM in memory, so big recordings stay without a
 * waveform rather than risking the tab.
 */
const FALLBACK_MAX_BYTES = 150 * 1024 * 1024

/**
 * Fallback for files the worker (mediabunny) can't decode: the browser's own
 * decoder on the main thread, peak-binned like the worker. Rejects if the
 * file is too large or can't be decoded either — never returns all-zero peaks.
 */
async function decodePeaksOnMainThread(
  opfsPath: string,
  bins: number,
): Promise<Float32Array> {
  const file = await readFile(opfsPath)
  if (file.size > FALLBACK_MAX_BYTES)
    throw new Error('File too large for fallback waveform')
  const ctx = new OfflineAudioContext(1, 1, 44100)
  const buffer = await ctx.decodeAudioData(await file.arrayBuffer())
  if (buffer.length === 0) throw new Error('No audio')
  const peaks = new Float32Array(bins)
  const per = buffer.length / bins
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) =>
    buffer.getChannelData(c),
  )
  for (let b = 0; b < bins; b++) {
    const start = Math.floor(b * per)
    const end = Math.min(buffer.length, Math.floor((b + 1) * per))
    let max = 0
    for (const data of channels) {
      for (let i = start; i < end; i++) {
        const v = Math.abs(data[i] ?? 0)
        if (v > max) max = v
      }
    }
    peaks[b] = max
  }
  return peaks
}

export function getWaveformPeaks(
  sourceId: string,
  opfsPath: string,
): Float32Array | Promise<Float32Array> {
  // Keyed by path too: a source whose file was swapped (remux) recomputes.
  const key = `${sourceId}|${opfsPath}`
  const cached = cache.get(key)
  if (cached) return cached

  const existing = inFlight.get(key)
  if (existing) return existing

  const id = nextId++
  const promise = new Promise<Float32Array>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      if (pending.delete(id)) reject(new Error('Waveform generation timed out'))
    }, REQUEST_TIMEOUT_MS)
    pending.set(id, {
      resolve: (v) => {
        window.clearTimeout(timer)
        resolve(v)
      },
      reject: (e) => {
        window.clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    })
    try {
      getWorker().postMessage({ id, opfsPath, bins: WAVEFORM_BIN_COUNT })
    } catch (err) {
      pending.get(id)?.reject(err)
      pending.delete(id)
    }
  })
    // Worker couldn't decode it (codec/container mediabunny doesn't handle,
    // or the worker failed): try the browser's decoder before giving up.
    .catch(() => decodePeaksOnMainThread(opfsPath, WAVEFORM_BIN_COUNT))
    .then((peaks) => {
      cache.set(key, peaks)
      inFlight.delete(key)
      return peaks
    })
    .catch((err: unknown) => {
      inFlight.delete(key)
      throw err
    })

  inFlight.set(key, promise)
  return promise
}
