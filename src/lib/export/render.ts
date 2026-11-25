import {
  Output,
  WebMOutputFormat,
  Mp4OutputFormat,
  BufferTarget,
  StreamTarget,
  type StreamTargetChunk,
  CanvasSource,
  AudioBufferSource,
  QUALITY_HIGH,
  type OutputFormat,
  canEncodeVideo,
  canEncodeAudio,
} from 'mediabunny'
import type { MediaSource, Project, Track } from '../timeline/types'
import { readFile } from '../storage/opfs'
import { isTrackHidden, isTrackSilenced } from '../timeline/trackState'
import {
  buildScene,
  clipSourceTime,
  drawScene,
  fitView,
  type SceneImage,
  type SceneLayer,
} from '../compositor/scene'
import { loadTextFonts } from '../compositor/textRender'
import { ProviderPool, animationFrameTime } from '../compositor/providers/pool'
import { createProviderFromFile } from '../compositor/providers/forSource'
import type { FrameProvider } from '../compositor/providers/types'
import {
  createChromaKeyProcessor,
  type ChromaKeyProcessor,
} from '../compositor/chromaKey'
import { chromaProcessImage } from '../compositor/chromaLayer'
import { planClipAudio } from './audioPlan'
import {
  mixInWindows,
  NO_AUDIO,
  openAudioReader,
  type AudioReader,
  type PlannedClip,
} from './audioMix'
import { openFrameStream, type FrameStream } from './frameStream'

export interface ExportOptions {
  fps: number
  width: number
  height: number
  container: 'webm' | 'mp4'
  videoCodec: 'vp9' | 'vp8' | 'av1' | 'avc' | 'hevc'
  audioCodec: 'opus' | 'vorbis' | 'aac'
  audioSampleRate: number
  audioChannels: number
  /** false = audio-only output (no video track, no frames). Default true. */
  includeVideo?: boolean
  /**
   * Keep transparency: the background stays transparent and the video is
   * encoded with alpha (WebM / VP9 only — used when merging overlays).
   */
  alpha?: boolean
}

export interface ExportProgress {
  phase: 'audio' | 'video' | 'finalize'
  /** 0..1 */
  value: number
  /** Optional free-form message. */
  message?: string
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  fps: 30,
  width: 1920,
  height: 1080,
  container: 'webm',
  videoCodec: 'vp9',
  audioCodec: 'opus',
  audioSampleRate: 48000,
  audioChannels: 2,
}

/** Derive a file extension + mime type from ExportOptions. */
export function exportFileInfo(opts: ExportOptions): {
  extension: string
  mimeType: string
} {
  return opts.container === 'mp4'
    ? { extension: 'mp4', mimeType: 'video/mp4' }
    : { extension: 'webm', mimeType: 'video/webm' }
}

/** Default codec pairings per container. */
export function defaultCodecsFor(container: 'webm' | 'mp4'): {
  videoCodec: ExportOptions['videoCodec']
  audioCodec: ExportOptions['audioCodec']
} {
  return container === 'mp4'
    ? { videoCodec: 'avc', audioCodec: 'aac' }
    : { videoCodec: 'vp9', audioCodec: 'opus' }
}

function makeFormat(container: 'webm' | 'mp4'): OutputFormat {
  return container === 'mp4' ? new Mp4OutputFormat() : new WebMOutputFormat()
}

const CODEC_LABEL: Record<string, string> = {
  avc: 'H.264',
  hevc: 'HEVC',
  vp9: 'VP9',
  vp8: 'VP8',
  av1: 'AV1',
  aac: 'AAC',
  opus: 'Opus',
  vorbis: 'Vorbis',
}

/**
 * Probe whether this browser can encode the codecs an export will use (the
 * container's defaults unless `opts` names others) at the given size.
 * Returns null when supported, otherwise a user-facing reason.
 */
export async function probeContainerSupport(
  container: 'webm' | 'mp4',
  width: number,
  height: number,
  opts: Pick<ExportOptions, 'audioSampleRate' | 'audioChannels'> &
    Partial<
      Pick<ExportOptions, 'videoCodec' | 'audioCodec' | 'includeVideo'>
    > = DEFAULT_EXPORT_OPTIONS,
): Promise<string | null> {
  const defaults = defaultCodecsFor(container)
  const videoCodec = opts.videoCodec ?? defaults.videoCodec
  const audioCodec = opts.audioCodec ?? defaults.audioCodec
  const label = CODEC_LABEL[videoCodec] ?? videoCodec
  const audioLabel = CODEC_LABEL[audioCodec] ?? audioCodec
  try {
    const [video, audio] = await Promise.all([
      // Audio-only output (merging sound clips) needs no video encoder.
      opts.includeVideo === false
        ? true
        : canEncodeVideo(videoCodec, { width, height, bitrate: QUALITY_HIGH }),
      canEncodeAudio(audioCodec, {
        numberOfChannels: opts.audioChannels,
        sampleRate: opts.audioSampleRate,
        bitrate: QUALITY_HIGH,
      }),
    ])
    if (!video) return `This browser can't encode ${label} video at ${width}×${height}.`
    if (!audio) return `This browser can't encode ${audioLabel} audio.`
    return null
  } catch {
    return `Couldn't check ${label}/${audioLabel} encoder support in this browser.`
  }
}

/** Resolve/reject with `p`, or reject as soon as `signal` aborts. */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p
  if (signal.aborted) return Promise.reject(new Error('Export canceled'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('Export canceled'))
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}

/** A source the export had to leave out (shown to the user afterwards). */
export interface SkippedMedia {
  sourceId: string
  name: string
  /** What was lost: its picture, or its sound. */
  part: 'video' | 'audio' | 'image' | 'animation'
}

/** Result of exportProject. */
export interface ExportResult {
  /** The file when exporting to memory; null when streamed to `writable`. */
  blob: Blob | null
  /** Media that couldn't be read or decoded and is missing from the output. */
  skipped: SkippedMedia[]
}

/**
 * Open an audio reader per audible source and plan every audible clip.
 * Sources whose audio can't be decoded are reported through `skip`; video
 * without any audio track is normal and silent.
 */
async function planAudio(
  project: Project,
  opts: ExportOptions,
  getFile: (opfsPath: string) => Promise<File>,
  skip: (src: MediaSource, part: SkippedMedia['part']) => void,
  signal?: AbortSignal,
): Promise<{ clips: PlannedClip[]; readers: AudioReader[] }> {
  // Only audio-producing clips contribute. Video clips carry audio too (the
  // preview mixer plays video-track audio as well).
  const audibleKinds: Track['kind'][] = ['audio', 'video']
  const readers = new Map<string, Promise<AudioReader | typeof NO_AUDIO | null>>()
  const clips: PlannedClip[] = []
  for (const clip of project.clips) {
    throwIfAborted(signal)
    if (clip.isLive) continue // still recording: file isn't finalized
    const track = project.tracks.find((t) => t.id === clip.trackId)
    if (!track) continue
    if (isTrackSilenced(project, track)) continue
    if (!audibleKinds.includes(track.kind)) continue
    const src = project.sources.find((s) => s.id === clip.sourceId)
    if (!src) continue
    if (src.kind !== 'audio' && src.kind !== 'video') continue

    let pending = readers.get(src.id)
    if (!pending) {
      pending = (async () => {
        try {
          const file = await abortable(getFile(src.opfsPath), signal)
          return await abortable(openAudioReader(file, opts.audioSampleRate), signal)
        } catch {
          throwIfAborted(signal)
          return null
        }
      })()
      readers.set(src.id, pending)
    }
    const reader = await pending
    if (reader === NO_AUDIO) continue
    if (!reader) {
      skip(src, 'audio')
      continue
    }
    const plan = planClipAudio(project, clip, src.duration)
    if (plan.stop <= plan.start) continue
    clips.push({ clip, plan, reader })
  }
  const opened: AudioReader[] = []
  for (const p of readers.values()) {
    const r = await p.catch(() => null)
    if (r && r !== NO_AUDIO) opened.push(r)
  }
  return { clips, readers: opened }
}

interface VideoEntry {
  el: HTMLVideoElement
  url: string
  ready: Promise<void>
}

function makeVideoEntry(file: File): VideoEntry {
  const url = URL.createObjectURL(file)
  const el = document.createElement('video')
  el.preload = 'auto'
  el.muted = true
  el.playsInline = true
  el.src = url
  const ready = new Promise<void>((resolve, reject) => {
    el.onloadeddata = () => resolve()
    el.onerror = () => reject(new Error('Video decode failed'))
  })
  return { el, url, ready }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Export canceled')
}

/**
 * Generous: recorded WebM without cues can seek slowly, but a seek that never
 * completes (decode error, broken file) must fail the export, not hang it.
 */
const SEEK_TIMEOUT_MS = 15_000

function seekVideo(
  el: HTMLVideoElement,
  t: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Export canceled'))
      return
    }
    if (Math.abs(el.currentTime - t) < 1 / 120) {
      resolve()
      return
    }
    const done = (err?: Error) => {
      el.removeEventListener('seeked', onSeeked)
      el.removeEventListener('error', onError)
      signal?.removeEventListener('abort', onAbort)
      window.clearTimeout(timer)
      if (err) reject(err)
      else resolve()
    }
    const onSeeked = () => done()
    const onError = () => done(new Error('Video decode failed while seeking'))
    const onAbort = () => done(new Error('Export canceled'))
    const timer = window.setTimeout(() => {
      done(
        new Error(
          `Timed out seeking video to ${t.toFixed(2)}s. The source file may be damaged.`,
        ),
      )
    }, SEEK_TIMEOUT_MS)
    el.addEventListener('seeked', onSeeked)
    el.addEventListener('error', onError)
    signal?.addEventListener('abort', onAbort)
    el.currentTime = Math.max(0, t)
  })
}

/** Export a project to a WebM/MP4 Blob using mediabunny + WebCodecs.
 *
 * If `writable` is provided the output is streamed directly into the given
 * WritableStream (e.g. a File System Access handle) and the returned `blob`
 * is `null`. Otherwise the encoded bytes are collected in memory and
 * returned as a single Blob. `skipped` lists media that couldn't be read or
 * decoded and is therefore missing from the output: callers must tell the
 * user instead of presenting the export as complete.
 *
 * Frames are composed by compositor/scene.ts (same as the preview). All
 * project-pixel quantities are scaled by width / project.width; an output
 * size with a different aspect ratio is letterboxed.
 */
export async function exportProject(
  project: Project,
  options: Partial<ExportOptions> = {},
  onProgress?: (p: ExportProgress) => void,
  signal?: AbortSignal,
  writable?: WritableStream<StreamTargetChunk>,
): Promise<ExportResult> {
  const opts: ExportOptions = { ...DEFAULT_EXPORT_OPTIONS, ...options }
  if (project.duration <= 0) {
    throw new Error('Project is empty — nothing to export.')
  }
  const unsupported = await probeContainerSupport(
    opts.container,
    opts.width,
    opts.height,
    opts,
  )
  if (unsupported) throw new Error(unsupported)

  const canvas = document.createElement('canvas')
  canvas.width = opts.width
  canvas.height = opts.height
  const ctx2d = canvas.getContext('2d')!
  const view = fitView(project.width, project.height, opts.width, opts.height)

  // Sources are loaded lazily, the first time a frame needs them, so media
  // not referenced by any visible clip is never decoded. Keyed like the
  // preview pool (SceneLayer.key): a source shown twice gets two elements.
  const videoEntries = new Map<string, Promise<VideoEntry | null>>()
  // Preferred path: one sequential decoder per layer key (see frameStream.ts).
  // null = this key can't be streamed; use element seeking (videoEntries).
  const frameStreams = new Map<string, Promise<FrameStream | null>>()
  const streamTimes = new Map<string, number[]>()
  const imageEntries = new Map<string, Promise<HTMLImageElement | null>>()
  const files = new Map<string, Promise<File>>()
  // Sources missing from the output, reported once each.
  const skipped = new Map<string, SkippedMedia>()
  const skip = (src: MediaSource, part: SkippedMedia['part']) => {
    const key = `${src.id}:${part}`
    if (!skipped.has(key))
      skipped.set(key, { sourceId: src.id, name: src.name || 'Untitled', part })
  }
  let audioReaders: AudioReader[] = []
  // Every element / object URL created below is released in `finally`,
  // whether the export succeeds, fails or is canceled.
  const createdVideos: VideoEntry[] = []
  const objectUrls: string[] = []
  const getFile = (opfsPath: string): Promise<File> => {
    let f = files.get(opfsPath)
    if (!f) {
      f = readFile(opfsPath)
      files.set(opfsPath, f)
    }
    return f
  }
  const getVideo = (key: string, src: MediaSource): Promise<VideoEntry | null> => {
    let p = videoEntries.get(key)
    if (!p) {
      p = (async () => {
        try {
          const entry = makeVideoEntry(await abortable(getFile(src.opfsPath), signal))
          createdVideos.push(entry)
          await abortable(entry.ready, signal)
          return entry
        } catch {
          throwIfAborted(signal)
          return null // skip unreadable
        }
      })()
      videoEntries.set(key, p)
    }
    return p
  }
  const getImage = (src: MediaSource): Promise<HTMLImageElement | null> => {
    let p = imageEntries.get(src.id)
    if (!p) {
      p = (async () => {
        try {
          const file = await abortable(getFile(src.opfsPath), signal)
          const url = URL.createObjectURL(file)
          objectUrls.push(url)
          const img = new Image()
          await abortable(
            new Promise<void>((resolve, reject) => {
              img.onload = () => resolve()
              img.onerror = () => reject(new Error('Image load failed'))
              img.src = url
            }),
            signal,
          )
          return img
        } catch {
          throwIfAborted(signal)
          return null
        }
      })()
      imageEntries.set(src.id, p)
    }
    return p
  }
  const getStream = (key: string, src: MediaSource): Promise<FrameStream | null> => {
    let p = frameStreams.get(key)
    if (!p) {
      p = (async () => {
        try {
          const file = await abortable(getFile(src.opfsPath), signal)
          return await abortable(
            openFrameStream(file, streamTimes.get(key) ?? [], {
              alpha: !!src.hasAlpha,
            }),
            signal,
          )
        } catch {
          throwIfAborted(signal)
          return null
        }
      })()
      frameStreams.set(key, p)
    }
    return p
  }
  // Animated sources: one provider per layer key, frames prepared before
  // each drawScene and produced inside its getImage callback.
  const animations = new ProviderPool(async (src) =>
    createProviderFromFile(src, await getFile(src.opfsPath)),
  )
  // One chroma-key processor for the whole run, created on first use.
  let chroma: ChromaKeyProcessor | null = null
  const processImage = chromaProcessImage(() => (chroma ??= createChromaKeyProcessor()))
  const keepAlpha = !!opts.alpha && opts.container === 'webm'
  let output: Output | null = null
  let finalized = false

  try {
    // Web fonts used by visible text clips must be ready before frame 0.
    const textSources = project.sources.filter(
      (s) =>
        (s.kind === 'text' || s.kind === 'element') &&
        project.clips.some((c) => {
          if (c.sourceId !== s.id) return false
          const track = project.tracks.find((t) => t.id === c.trackId)
          return !!track && !isTrackHidden(project, track)
        }),
    )
    await abortable(loadTextFonts(textSources), signal)

    output = new Output({
      format: makeFormat(opts.container),
      target: writable
        ? new StreamTarget(writable, { chunked: true })
        : new BufferTarget(),
    })

    const withVideo = opts.includeVideo !== false
    const videoSource = withVideo
      ? new CanvasSource(canvas, {
          codec: opts.videoCodec,
          bitrate: QUALITY_HIGH,
          ...(keepAlpha ? { alpha: 'keep' as const } : {}),
        })
      : null
    if (videoSource) output.addVideoTrack(videoSource, { frameRate: opts.fps })

    const audioSource = new AudioBufferSource({
      codec: opts.audioCodec,
      bitrate: QUALITY_HIGH,
    })
    output.addAudioTrack(audioSource)

    await output.start()

    // Audio: mixed window by window straight into the encoder (audioMix.ts),
    // so memory doesn't grow with the project's length.
    onProgress?.({ phase: 'audio', value: 0, message: 'Mixing audio…' })
    const audio = await planAudio(project, opts, getFile, skip, signal)
    audioReaders = audio.readers
    await mixInWindows(
      audio.clips,
      Math.max(0.01, project.duration),
      opts.audioChannels,
      opts.audioSampleRate,
      (buffer) => audioSource.add(buffer),
      { signal, onProgress: (f) => onProgress?.({ phase: 'audio', value: f }) },
    )
    throwIfAborted(signal)
    onProgress?.({ phase: 'audio', value: 1 })

    // Render frames.
    onProgress?.({ phase: 'video', value: 0, message: 'Rendering frames…' })
    // Audio-only output renders no frames.
    const totalFrames = videoSource ? Math.ceil(project.duration * opts.fps) : 0
    const frameDur = 1 / opts.fps
    // Seek to the frame's midpoint: WebM timestamps are ms-rounded, so a
    // frame-boundary time can land on the previous frame. (Which clips are
    // drawn is still decided at t.)
    const sourceTimeAt = (layer: SceneLayer, t: number) =>
      Math.max(0, clipSourceTime(layer.clip, t + frameDur / 2).time)

    // Pre-pass: the ordered source times every video layer will request, so
    // each layer's decoder gets its whole timestamp list up front. Must visit
    // layers in exactly the same order as the render loop below.
    for (let i = 0; i < totalFrames; i++) {
      if (i % 2000 === 0) throwIfAborted(signal)
      const t = i / opts.fps
      for (const group of buildScene(project, t, { includeLive: false })) {
        for (const layer of group.layers) {
          if (layer.source.kind !== 'video') continue
          let list = streamTimes.get(layer.key)
          if (!list) streamTimes.set(layer.key, (list = []))
          list.push(sourceTimeAt(layer, t))
        }
      }
    }

    for (let i = 0; i < totalFrames; i++) {
      throwIfAborted(signal)
      const t = i / opts.fps
      const scene = buildScene(project, t, { includeLive: false })
      const images = new Map<SceneLayer, SceneImage>()
      const anims = new Map<
        SceneLayer,
        { provider: FrameProvider; at: { t: number; loop: boolean } }
      >()
      for (const group of scene) {
        for (const layer of group.layers) {
          const src = layer.source
          if (src.kind === 'animation') {
            const provider = await abortable(animations.load(layer.key, src), signal)
            if (!provider) {
              skip(src, 'animation') // unreadable asset: skip the layer
              continue
            }
            const at = animationFrameTime(layer.clip, sourceTimeAt(layer, t))
            try {
              await abortable(provider.prepare(at.t, at.loop), signal)
            } catch {
              throwIfAborted(signal)
              // A frame that can't be produced is missing from the output:
              // report it like an unreadable file.
              skip(src, 'animation')
              continue
            }
            anims.set(layer, { provider, at })
          } else if (src.kind === 'video') {
            const time = sourceTimeAt(layer, t)
            const stream = await getStream(layer.key, src)
            if (stream) {
              // Always consume this layer's slot, even if it yields nothing,
              // so the stream stays aligned with its timestamp list.
              const frame = await abortable(stream.next(), signal)
              if (frame) images.set(layer, frame)
              continue
            }
            const ve = await getVideo(layer.key, src)
            if (!ve) {
              skip(src, 'video')
              continue
            }
            await seekVideo(ve.el, time, signal)
            images.set(layer, ve.el)
          } else if (src.kind === 'image') {
            const img = await getImage(src)
            if (img) images.set(layer, img)
            else skip(src, 'image')
          }
        }
      }
      drawScene(
        ctx2d,
        project,
        t,
        scene,
        (layer) => {
          const a = anims.get(layer)
          if (a)
            return (a.provider.frameAt(a.at.t, a.at.loop) as SceneImage | null) ?? null
          return images.get(layer) ?? null
        },
        view,
        { processImage, transparent: keepAlpha },
      )

      await videoSource?.add(t, frameDur)
      if (i % 5 === 0) {
        onProgress?.({ phase: 'video', value: (i + 1) / totalFrames })
      }
    }

    videoSource?.close()
    audioSource.close()

    onProgress?.({ phase: 'finalize', value: 0, message: 'Finalizing file…' })
    await output.finalize()
    finalized = true
    onProgress?.({ phase: 'finalize', value: 1 })

    const result = { skipped: [...skipped.values()] }
    if (writable) return { blob: null, ...result }
    const bytes = (output.target as BufferTarget).buffer
    if (!bytes) throw new Error('Export produced no data')
    return {
      blob: new Blob([bytes], { type: exportFileInfo(opts).mimeType }),
      ...result,
    }
  } catch (err) {
    // Release the encoders and the output target (file handle) on any failure.
    if (output && !finalized) {
      try {
        await output.cancel()
      } catch {
        /* already torn down */
      }
    }
    throw err
  } finally {
    for (const p of frameStreams.values()) {
      void p.then((st) => st?.dispose()).catch(() => {})
    }
    for (const ve of createdVideos) {
      ve.el.removeAttribute('src')
      ve.el.load()
      URL.revokeObjectURL(ve.url)
    }
    for (const url of objectUrls) URL.revokeObjectURL(url)
    for (const r of audioReaders) r.dispose()
    animations.dispose()
    // Late resolutions are disposed by the pool itself.
    const c = chroma as ChromaKeyProcessor | null
    c?.dispose()
  }
}

/** Trigger a download of a Blob as a file. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
