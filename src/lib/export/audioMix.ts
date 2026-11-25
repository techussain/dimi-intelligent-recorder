/**
 * Export audio mix in bounded memory.
 *
 * The timeline is mixed in fixed windows (WINDOW_SEC): each window gets its
 * own short OfflineAudioContext, and each clip is decoded only for the part
 * of its source that window needs (mediabunny's AudioBufferSink). Memory is
 * therefore proportional to the window length, not to the project length —
 * an hour-long project no longer needs a full-length PCM mix (~1.4 GB for
 * 48 kHz stereo) plus a fully decoded copy of every source.
 *
 * The scheduling math (which part of a clip falls into a window, and the
 * gain automation there) is pure and unit-tested; see clipWindow and
 * fadeOpsInWindow.
 */
import {
  ALL_FORMATS,
  AudioBufferSink,
  BlobSource,
  Input,
  type InputAudioTrack,
} from 'mediabunny'
import type { Clip } from '../timeline/types'
import type { ClipAudioPlan, FadeSegment } from './audioPlan'
import { sampleVolumeCurve, VOLUME_CURVE_RATE } from './audioPlan'

/** Seconds of timeline mixed per OfflineAudioContext. */
export const WINDOW_SEC = 30
/** Extra source seconds decoded past a window's end (resampler look-ahead). */
const READ_PAD_SEC = 0.05
/**
 * Source seconds decoded before a window's start and discarded: after a seek,
 * codecs like Opus need ~80 ms of pre-roll before their output is exact, so
 * starting cold at the seam would leave a small level dip there.
 */
const PREROLL_SEC = 0.12

// ── Pure scheduling math ─────────────────────────────────────────────────────

/** The part of a planned clip that plays inside timeline window [w0, w1). */
export interface ClipWindow {
  /** Timeline span of the clip inside the window. */
  a: number
  b: number
  /** Source seconds playing at `a` and `b`. */
  srcFrom: number
  srcTo: number
}

export function clipWindow(
  plan: Pick<ClipAudioPlan, 'start' | 'stop' | 'offset'>,
  speed: number,
  w0: number,
  w1: number,
): ClipWindow | null {
  const a = Math.max(plan.start, w0)
  const b = Math.min(plan.stop, w1)
  if (b <= a) return null
  return {
    a,
    b,
    srcFrom: plan.offset + (a - plan.start) * speed,
    srcTo: plan.offset + (b - plan.start) * speed,
  }
}

/** One gain automation step, in window-local seconds. */
export type GainOp =
  | { kind: 'set'; value: number; at: number }
  | { kind: 'ramp'; value: number; at: number }

/** Value of the fade automation at timeline time `t` (1 before any fade). */
export function fadeGainAt(fades: readonly FadeSegment[], t: number): number {
  let v = 1
  for (const s of fades) {
    if (t < s.t0) break
    if (t >= s.t1) {
      v = s.v1
      continue
    }
    return s.v0 + ((s.v1 - s.v0) * (t - s.t0)) / (s.t1 - s.t0)
  }
  return v
}

/**
 * The transition-fade automation for clip span [a, b] of a window starting
 * at `w0`, as window-local ops: the value at `a` (whatever earlier fades left
 * it at), then each fade segment clipped to [a, b].
 */
export function fadeOpsInWindow(
  fades: readonly FadeSegment[],
  a: number,
  b: number,
  w0: number,
): GainOp[] {
  const ops: GainOp[] = [{ kind: 'set', value: fadeGainAt(fades, a), at: a - w0 }]
  for (const s of fades) {
    const t0 = Math.max(s.t0, a)
    const t1 = Math.min(s.t1, b)
    if (t1 <= t0) continue
    ops.push({ kind: 'set', value: fadeGainAt(fades, t0), at: t0 - w0 })
    ops.push({ kind: 'ramp', value: fadeGainAt([s], t1), at: t1 - w0 })
  }
  return ops
}

// ── Source readers ───────────────────────────────────────────────────────────

/** Decoded audio covering a requested source range. */
export interface AudioSpan {
  buffer: AudioBuffer
  /** Source seconds at buffer frame 0. */
  start: number
}

export interface AudioReader {
  /** Decoded source audio covering [from, to) (as far as it exists), or null. */
  read(from: number, to: number): Promise<AudioSpan | null>
  dispose(): void
}

/** The source has no audio track at all (e.g. a screen recording) — not an error. */
export const NO_AUDIO = 'no-audio' as const

/** Copy decoded chunks into one AudioBuffer starting at the first chunk. */
function joinChunks(
  chunks: { buffer: AudioBuffer; timestamp: number }[],
): AudioSpan | null {
  const first = chunks[0]
  if (!first) return null
  const sr = first.buffer.sampleRate
  const channels = Math.max(...chunks.map((c) => c.buffer.numberOfChannels))
  const last = chunks[chunks.length - 1]!
  const frames = Math.max(
    1,
    Math.round((last.timestamp - first.timestamp) * sr) + last.buffer.length,
  )
  const out = new AudioBuffer({
    length: frames,
    numberOfChannels: channels,
    sampleRate: sr,
  })
  for (const c of chunks) {
    const at = Math.round((c.timestamp - first.timestamp) * sr)
    if (at >= frames) continue
    for (let ch = 0; ch < channels; ch++) {
      // Mono chunks fill every output channel.
      const src = c.buffer.getChannelData(Math.min(ch, c.buffer.numberOfChannels - 1))
      out.copyToChannel(src.subarray(0, frames - at), ch, at)
    }
  }
  return { buffer: out, start: first.timestamp }
}

/** Streaming reader: decodes only the requested range (WebCodecs). */
async function openStreamingReader(
  file: Blob,
): Promise<AudioReader | typeof NO_AUDIO | null> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  let track: InputAudioTrack | null
  try {
    track = await input.getPrimaryAudioTrack()
    if (!track) {
      input.dispose()
      return NO_AUDIO
    }
    if (!(await track.canDecode())) {
      input.dispose()
      return null
    }
  } catch {
    input.dispose()
    return null
  }
  const sink = new AudioBufferSink(track)
  return {
    async read(from, to) {
      const chunks: { buffer: AudioBuffer; timestamp: number }[] = []
      for await (const w of sink.buffers(
        Math.max(0, from - PREROLL_SEC),
        to + READ_PAD_SEC,
      )) {
        chunks.push({ buffer: w.buffer, timestamp: w.timestamp })
      }
      return joinChunks(chunks)
    },
    dispose: () => input.dispose(),
  }
}

/** Fallback: decode the whole file with Web Audio (formats WebCodecs can't). */
async function openWholeFileReader(
  file: Blob,
  sampleRate: number,
): Promise<AudioReader | null> {
  try {
    const ctx = new OfflineAudioContext(1, 1, sampleRate)
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer())
    return {
      read: () => Promise.resolve({ buffer, start: 0 }),
      dispose: () => undefined,
    }
  } catch {
    return null
  }
}

/**
 * Open a reader for a source file: streaming when possible, else whole-file
 * decode. NO_AUDIO when the file has no audio track; null when it has audio
 * that can't be decoded (the caller reports it as skipped).
 */
export async function openAudioReader(
  file: Blob,
  sampleRate: number,
): Promise<AudioReader | typeof NO_AUDIO | null> {
  const streaming = await openStreamingReader(file).catch(() => null)
  if (streaming) return streaming
  return await openWholeFileReader(file, sampleRate)
}

// ── Mixing ───────────────────────────────────────────────────────────────────

export interface PlannedClip {
  clip: Clip
  plan: ClipAudioPlan
  reader: AudioReader
}

/**
 * Mix `clips` over [0, totalSec) window by window, handing each rendered
 * window to `emit` in order (e.g. AudioBufferSource.add).
 */
export async function mixInWindows(
  clips: readonly PlannedClip[],
  totalSec: number,
  channels: number,
  sampleRate: number,
  emit: (buffer: AudioBuffer) => Promise<void>,
  opts: {
    signal?: AbortSignal | undefined
    onProgress?: ((f: number) => void) | undefined
  } = {},
): Promise<void> {
  const totalFrames = Math.max(1, Math.ceil(totalSec * sampleRate))
  const windowFrames = Math.round(WINDOW_SEC * sampleRate)
  for (let f0 = 0; f0 < totalFrames; f0 += windowFrames) {
    if (opts.signal?.aborted) throw new Error('Export canceled')
    // Windows are cut on whole frames so they add up exactly.
    const frames = Math.min(windowFrames, totalFrames - f0)
    const w0 = f0 / sampleRate
    const w1 = (f0 + frames) / sampleRate
    const ctx = new OfflineAudioContext(channels, frames, sampleRate)

    for (const { clip, plan, reader } of clips) {
      const speed = Math.max(0.1, clip.speed)
      const win = clipWindow(plan, speed, w0, w1)
      if (!win) continue
      const span = await reader.read(win.srcFrom, win.srcTo)
      if (opts.signal?.aborted) throw new Error('Export canceled')
      if (!span) continue

      // Source seconds missing before the decoded audio starts (a file whose
      // audio begins after the requested point): play from where it exists.
      const lead = Math.max(0, span.start - win.srcFrom)
      const when = win.a - w0 + lead / speed
      const offset = Math.max(0, win.srcFrom - span.start)
      const playFor = win.srcTo - win.srcFrom - lead
      if (playFor <= 0 || offset >= span.buffer.duration) continue

      const node = ctx.createBufferSource()
      node.buffer = span.buffer
      // playbackRate resamples: speed-changed clips are pitch-shifted in the
      // export (the preview keeps pitch). Time-stretching isn't implemented.
      node.playbackRate.value = speed

      // Two chained gains so keyframed volume and transition fades don't
      // overwrite each other's automation on one AudioParam.
      const volume = ctx.createGain()
      const curve = sampleVolumeCurve(
        clip,
        win.a,
        win.b,
        VOLUME_CURVE_RATE,
        plan.edgeFade,
      )
      if (curve) {
        volume.gain.value = curve[0]!
        volume.gain.setValueCurveAtTime(curve, win.a - w0, win.b - win.a)
      } else {
        volume.gain.value = clip.volume
      }
      const fade = ctx.createGain()
      for (const op of fadeOpsInWindow(plan.fades, win.a, win.b, w0)) {
        if (op.kind === 'set') fade.gain.setValueAtTime(op.value, op.at)
        else fade.gain.linearRampToValueAtTime(op.value, op.at)
      }

      node.connect(volume).connect(fade).connect(ctx.destination)
      node.start(when, offset, playFor)
    }

    await emit(await ctx.startRendering())
    opts.onProgress?.(Math.min(1, (f0 + frames) / totalFrames))
  }
}
