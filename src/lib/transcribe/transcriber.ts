/**
 * Main-thread side of on-device transcription: runs one job at a time in
 * transcribe.worker.ts, exposes its progress as a small store, and turns
 * transcripts into captions / .srt.
 */
import { create } from 'zustand'
import { useEditor } from '../timeline/store'
import type { ID, TranscriptSegment } from '../timeline/types'
import { buildCaptionCues, captionStyle, cuesFromCaptionTrack, toSrt } from './captions'

/** Approximate one-time download (whisper-base.en, 8-bit). */
export const MODEL_DOWNLOAD_MB = 77

const CONSENT_KEY = 'ir-transcribe-model-consent'

export function hasModelConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === '1'
  } catch {
    return false
  }
}

export function giveModelConsent(): void {
  try {
    localStorage.setItem(CONSENT_KEY, '1')
  } catch {
    // Storage unavailable: we'll just ask again next time.
  }
}

/**
 * Ask once (then remember) before the first model download. Returns true if
 * transcription may proceed.
 */
export function ensureModelConsent(): boolean {
  if (hasModelConsent()) return true
  const ok = window.confirm(
    `Transcription runs entirely on this computer — your audio never leaves it.

` +
      `The first time, the English speech model (about ${MODEL_DOWNLOAD_MB} MB) is ` +
      `downloaded once from Hugging Face and kept for offline use.

Continue?`,
  )
  if (ok) giveModelConsent()
  return ok
}

export type TranscribeStage = 'download' | 'decode' | 'transcribe'

export interface TranscribeJob {
  sourceId: ID
  stage: TranscribeStage
  /** 0..1 within the stage. */
  progress: number
}

export const useTranscription = create<{ job: TranscribeJob | null }>(() => ({
  job: null,
}))

type WorkerMessage =
  | { type: 'progress'; id: number; stage: TranscribeStage; progress: number }
  | {
      type: 'result'
      id: number
      model: string
      language: string
      segments: TranscriptSegment[]
    }
  | { type: 'error'; id: number; message: string }

let worker: Worker | null = null
let active: { id: number; reject: (err: Error) => void } | null = null
let nextId = 1

function getWorker(): Worker {
  worker ??= new Worker(
    new URL('../../workers/transcribe.worker.ts', import.meta.url),
    {
      type: 'module',
    },
  )
  return worker
}

/**
 * Transcribe a media source's audio and store the transcript on the project.
 * Rejects if another transcription is running, the source has no media, or
 * decoding/transcription fails. Cancel with cancelTranscription().
 */
export function transcribeSource(sourceId: ID): Promise<number> {
  if (active) return Promise.reject(new Error('A transcription is already running.'))
  const src = useEditor.getState().project.sources.find((s) => s.id === sourceId)
  if (!src || !src.opfsPath || (src.kind !== 'audio' && src.kind !== 'video')) {
    return Promise.reject(new Error('Only audio or video media can be transcribed.'))
  }
  const id = nextId++
  const w = getWorker()
  useTranscription.setState({ job: { sourceId, stage: 'download', progress: 0 } })

  return new Promise<number>((resolve, reject) => {
    const finish = () => {
      w.removeEventListener('message', onMessage)
      w.removeEventListener('error', onError)
      active = null
      useTranscription.setState({ job: null })
    }
    const onMessage = (ev: MessageEvent<WorkerMessage>) => {
      const msg = ev.data
      if (msg.id !== id) return
      if (msg.type === 'progress') {
        useTranscription.setState({
          job: {
            sourceId,
            stage: msg.stage,
            progress: Math.max(0, Math.min(1, msg.progress)),
          },
        })
      } else if (msg.type === 'result') {
        finish()
        useEditor.getState().setTranscript(sourceId, {
          model: msg.model,
          language: msg.language,
          createdAt: Date.now(),
          segments: msg.segments,
        })
        resolve(msg.segments.length)
      } else {
        finish()
        reject(new Error(msg.message))
      }
    }
    const onError = (ev: ErrorEvent) => {
      ev.preventDefault()
      // A crashed worker can't be reused.
      worker?.terminate()
      worker = null
      finish()
      reject(new Error(ev.message || 'The transcription worker crashed.'))
    }
    w.addEventListener('message', onMessage)
    w.addEventListener('error', onError)
    active = {
      id,
      reject: (err) => {
        finish()
        reject(err)
      },
    }
    w.postMessage({ type: 'transcribe', id, opfsPath: src.opfsPath })
  })
}

/** Stop the running transcription (the worker is discarded; the model stays cached). */
export function cancelTranscription(): void {
  if (!active) return
  worker?.terminate()
  worker = null
  active.reject(new Error('Transcription canceled.'))
}

/**
 * (Re)build the Captions track from all transcripts, mapped through the
 * current edit. One undo step. Returns the number of captions created.
 */
export function generateCaptions(): number {
  const st = useEditor.getState()
  const cues = buildCaptionCues(st.project)
  if (cues.length === 0) {
    throw new Error(
      'Nothing to caption: transcribe a clip first (its audio must be on an audible track).',
    )
  }
  return st.setCaptions(cues, captionStyle(st.project))
}

/**
 * Download the captions as a .srt file: the Captions track if there is one
 * (so manual caption edits are kept), otherwise straight from the transcripts.
 */
export function exportCaptionsSrt(): void {
  const project = useEditor.getState().project
  const fromTrack = cuesFromCaptionTrack(project)
  const cues = fromTrack.length > 0 ? fromTrack : buildCaptionCues(project)
  if (cues.length === 0)
    throw new Error('No captions to export — transcribe a clip first.')
  const blob = new Blob([toSrt(cues)], { type: 'application/x-subrip' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${project.name.replace(/[^a-z0-9-_ ]+/gi, '_').trim() || 'captions'}.srt`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
