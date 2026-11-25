/**
 * Transcription worker: decodes a media file's audio to 16 kHz mono and runs
 * Whisper (Transformers.js, ONNX Runtime WASM) on it — fully on-device.
 *
 * Protocol (main → worker):
 *   { type: 'transcribe', id, opfsPath }
 * Protocol (worker → main):
 *   { type: 'progress', id, stage: 'download' | 'decode' | 'transcribe', progress }
 *   { type: 'result', id, model, language, segments }
 *   { type: 'error', id, message }
 *
 * The model downloads from the Hugging Face Hub on first use and is cached in
 * OPFS (`models/…`), so later runs are offline. It is pinned to one Hub
 * commit, and every file is checked against its SHA-256 before it is used or
 * cached (lib/transcribe/modelPin.ts). The ONNX Runtime WebAssembly files are
 * bundled with the app (no CDN).
 */
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from 'mediabunny'
import { env, pipeline } from '@huggingface/transformers'
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url'
import { MonoResampler, WHISPER_SAMPLE_RATE } from '../lib/transcribe/pcm'
import { appendBlock, cleanSegments } from '../lib/transcribe/segments'
import type { TranscriptSegment } from '../lib/timeline/types'
import {
  MODEL_ID,
  MODEL_REVISION,
  modelFilePath,
  pinModelUrl,
  verifyModelFile,
} from '../lib/transcribe/modelPin'

export const TRANSCRIBE_MODEL = MODEL_ID

/** Audio is transcribed in blocks for progress + bounded work per call. */
const BLOCK_SEC = 300
/** Blocks overlap so words at a boundary aren't cut; duplicates are dropped. */
const OVERLAP_SEC = 10

interface TranscribeRequest {
  type: 'transcribe'
  id: number
  opfsPath: string
}

const post = (msg: unknown) => {
  ;(self as unknown as Worker).postMessage(msg)
}

// ── OPFS helpers ────────────────────────────────────────────────────────────

async function resolveDir(parts: string[], create: boolean) {
  let dir = await navigator.storage.getDirectory()
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create })
  return dir
}

async function openFile(opfsPath: string): Promise<File> {
  const parts = opfsPath.replace(/^\/+|\/+$/g, '').split('/')
  const name = parts.pop()
  if (!name) throw new Error(`Invalid OPFS path: ${opfsPath}`)
  const dir = await resolveDir(parts, false)
  return await (await dir.getFileHandle(name)).getFile()
}

/**
 * Model cache in OPFS (`models/<url-derived name>`). The Cache API isn't
 * reliably available on the packaged app's file:// origin; OPFS is (the app
 * already stores all media there). Writes go to `<name>.part` and are renamed
 * when complete, so an interrupted download never leaves a corrupt model.
 */
const cacheName = (url: string) =>
  url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9._-]/g, '_')

const opfsModelCache = {
  async match(url: string): Promise<Response | undefined> {
    let dir: FileSystemDirectoryHandle
    let file: File
    try {
      dir = await resolveDir(['models'], false)
      file = await (await dir.getFileHandle(cacheName(url))).getFile()
    } catch {
      return undefined
    }
    // Cached files are verified again on every load: copies cached by older
    // (unpinned) versions, or damaged on disk, are deleted and downloaded
    // again through verifiedFetch.
    const pinned = pinModelUrl(url)
    const path = pinned ? modelFilePath(pinned) : null
    try {
      if (!path) throw new Error('not a pinned model file')
      await verifyModelFile(path, await file.arrayBuffer())
    } catch {
      await dir.removeEntry(cacheName(url)).catch(() => {})
      return undefined
    }
    return new Response(file, {
      headers: { 'content-length': String(file.size) },
    })
  },
  async put(url: string, response: Response): Promise<void> {
    const dir = await resolveDir(['models'], true)
    const name = cacheName(url)
    const part = await dir.getFileHandle(`${name}.part`, { create: true })
    const w = await part.createWritable()
    try {
      await (response.body ? response.body.pipeTo(w) : w.close())
    } catch (err) {
      await dir.removeEntry(`${name}.part`).catch(() => {})
      throw err
    }
    const movable = part as FileSystemFileHandle & {
      move?: (name: string) => Promise<void>
    }
    if (movable.move) {
      await dir.removeEntry(name).catch(() => {})
      await movable.move(name)
    } else {
      // No move(): copy the finished file under its final name.
      const data = await part.getFile()
      const final = await dir.getFileHandle(name, { create: true })
      const fw = await final.createWritable()
      await fw.write(data)
      await fw.close()
      await dir.removeEntry(`${name}.part`)
    }
  },
}

/** Set while a model load runs: per-file download progress (bytes). */
let reportDownload: ((file: string, loaded: number, total: number) => void) | null =
  null

/**
 * fetch for Transformers.js: model files are downloaded completely and
 * verified against the pinned SHA-256 before Transformers.js (and therefore
 * the cache) gets them. Requests for the model at another revision (it probes
 * some files at `main`) are sent to the pinned one; anything else is refused.
 * Error responses (404 for an optional file), HEAD and 1-byte range probes
 * (206) carry no model data and pass through.
 */
async function verifiedFetch(
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = pinModelUrl(String(input))
  const path = url ? modelFilePath(url) : null
  if (!url || !path) throw new Error(`Blocked unexpected download: ${String(input)}`)
  const res = await fetch(url, init)
  if (!res.ok || res.status === 206 || init?.method === 'HEAD' || !res.body) return res
  const total = Number(res.headers.get('content-length')) || 0
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.byteLength
    reportDownload?.(path, loaded, Math.max(total, loaded))
  }
  const bytes = new Uint8Array(loaded)
  let at = 0
  for (const c of chunks) {
    bytes.set(c, at)
    at += c.byteLength
  }
  await verifyModelFile(path, bytes)
  const headers = new Headers(res.headers)
  headers.set('content-length', String(loaded))
  headers.delete('content-encoding')
  return new Response(bytes, {
    status: res.status,
    statusText: res.statusText,
    headers,
  })
}

env.fetch = verifiedFetch
env.allowLocalModels = false
env.useBrowserCache = false
env.useCustomCache = true
env.customCache = opfsModelCache
env.useWasmCache = false
{
  const wasm = env.backends.onnx.wasm
  if (wasm) {
    wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl }
    wasm.numThreads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1))
  }
}

// ── Model ───────────────────────────────────────────────────────────────────

type AsrChunk = { timestamp: [number, number | null]; text: string }
type Asr = (
  audio: Float32Array,
  opts: Record<string, unknown>,
) => Promise<{ text: string; chunks?: AsrChunk[] }>

let asrPromise: Promise<Asr> | null = null

function loadModel(onProgress: (fraction: number) => void): Promise<Asr> {
  if (!asrPromise) {
    // Aggregate per-file download progress into one fraction. Fed by the
    // verifying fetch (bytes as they arrive) and by Transformers.js itself.
    const files = new Map<string, { loaded: number; total: number }>()
    const update = (file: string, loaded: number, total: number) => {
      files.set(file, { loaded, total })
      let sumLoaded = 0
      let sumTotal = 0
      for (const f of files.values()) {
        sumLoaded += f.loaded
        sumTotal += f.total
      }
      if (sumTotal > 0) onProgress(Math.min(1, sumLoaded / sumTotal))
    }
    reportDownload = update
    asrPromise = pipeline('automatic-speech-recognition', TRANSCRIBE_MODEL, {
      device: 'wasm',
      dtype: 'q8',
      revision: MODEL_REVISION,
      progress_callback: (p: {
        status: string
        file?: string
        loaded?: number
        total?: number
      }) => {
        if (p.status !== 'progress' || !p.file || !p.total) return
        update(p.file, p.loaded ?? 0, p.total)
      },
    }) as unknown as Promise<Asr>
    // A failed load (offline, blocked, failed integrity check) must be retryable.
    asrPromise.then(
      () => {
        reportDownload = null
      },
      () => {
        reportDownload = null
        asrPromise = null
      },
    )
  }
  return asrPromise
}

// ── Audio ───────────────────────────────────────────────────────────────────

/** 16 kHz mono PCM of the file's audio, plus the audio's first timestamp. */
async function decodeAudio(
  opfsPath: string,
  onProgress: (fraction: number) => void,
): Promise<{ pcm: Float32Array; start: number }> {
  const file = await openFile(opfsPath)
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track) throw new Error('This media has no audio track to transcribe.')
    if (!(await track.canDecode()))
      throw new Error("This media's audio format can't be decoded.")
    const start = await track.getFirstTimestamp()
    const duration = Math.max(0, (await track.computeDuration()) - start)
    let resampler: MonoResampler | null = null
    let planes: Float32Array[] = []
    const sink = new AudioSampleSink(track)
    for await (const sample of sink.samples()) {
      try {
        resampler ??= new MonoResampler(sample.sampleRate)
        const frames = sample.numberOfFrames
        const n = sample.numberOfChannels
        if (planes.length !== n || (planes[0]?.length ?? 0) < frames) {
          planes = Array.from({ length: n }, () => new Float32Array(frames))
        }
        for (let c = 0; c < n; c++) {
          sample.copyTo(planes[c]!, { planeIndex: c, format: 'f32-planar' })
        }
        resampler.push(planes, frames)
        if (duration > 0) onProgress(Math.min(1, (sample.timestamp - start) / duration))
      } finally {
        sample.close()
      }
    }
    if (!resampler) throw new Error('No audio found in this media.')
    return { pcm: resampler.finish(), start }
  } finally {
    input.dispose()
  }
}

// ── Transcription ───────────────────────────────────────────────────────────

async function transcribe(req: TranscribeRequest): Promise<TranscriptSegment[]> {
  const progress = (stage: string, value: number) =>
    post({ type: 'progress', id: req.id, stage, progress: value })

  progress('download', 0)
  const asr = await loadModel((f) => progress('download', f))
  progress('decode', 0)
  const { pcm, start } = await decodeAudio(req.opfsPath, (f) => progress('decode', f))

  const rate = WHISPER_SAMPLE_RATE
  const totalSec = pcm.length / rate
  let segments: TranscriptSegment[] = []
  progress('transcribe', 0)
  for (let b = 0; b < totalSec; b += BLOCK_SEC - OVERLAP_SEC) {
    const end = Math.min(totalSec, b + BLOCK_SEC)
    const block = pcm.subarray(Math.floor(b * rate), Math.floor(end * rate))
    const out = await asr(block, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
    })
    const blockSegs = (out.chunks ?? []).map((c) => ({
      start: start + b + (c.timestamp[0] ?? 0),
      end: start + b + (c.timestamp[1] ?? end - b),
      text: c.text,
    }))
    segments = appendBlock(segments, cleanSegments(blockSegs))
    progress('transcribe', end / totalSec)
    if (end >= totalSec) break
  }
  return segments
}

self.onmessage = (ev: MessageEvent<TranscribeRequest>) => {
  const req = ev.data
  if (req.type !== 'transcribe') return
  transcribe(req)
    .then((segments) =>
      post({
        type: 'result',
        id: req.id,
        model: TRANSCRIBE_MODEL,
        language: 'en',
        segments,
      }),
    )
    .catch((err: unknown) =>
      post({
        type: 'error',
        id: req.id,
        message: err instanceof Error ? err.message : String(err),
      }),
    )
}
