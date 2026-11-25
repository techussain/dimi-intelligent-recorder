import { useEditor, uid } from '../timeline/store'
import { emitError } from '../errorBus'
import { openAppendWriter, type AppendWriter } from '../storage/opfs'
import type { ID, MediaSource } from '../timeline/types'
import { identityTransform } from '../timeline/types'
import { usePipStore } from '../ui/pipStore'
import { IS_ELECTRON } from '../capabilities'
import { OVERLAY_RELEASE_CAMERA, openWebcamStream } from './webcam'
import { openMicStream } from './devices'
import { registerLiveStream, unregisterLiveStream } from './liveStreams'
import { finalizeRecordedFiles, type RecordedFile } from './finalizeRecording'

export interface CaptureOptions {
  screen: boolean
  systemAudio: boolean
  mic: boolean
  micDeviceId?: string | undefined
  webcam: boolean
  webcamDeviceId?: string | undefined
  /**
   * If the webcam stream is already open (e.g. from the self-view PiP),
   * pass it here so captureManager reuses it instead of opening a second
   * concurrent getUserMedia call on the same device.
   */
  webcamStream?: MediaStream
  /** How often to emit a segment (ms). Smaller = more responsive live timeline, more clips. */
  timesliceMs?: number | undefined
  /**
   * Optional region crop applied to the captured screen/window stream.
   * All values are ratios (0–1) relative to the actual captured video dimensions.
   */
  cropRegion?: {
    xRatio: number
    yRatio: number
    widthRatio: number
    heightRatio: number
  } | null
}

export interface CaptureTargets {
  screenTrackId: ID
  webcamTrackId?: ID | undefined
  systemAudioTrackId?: ID | undefined
  micTrackId?: ID | undefined
}

interface ActiveRecorder {
  stream: MediaStream
  recorder: MediaRecorder
  /** OPFS path for this recorder's session file. */
  opfsPath: string
  /** Source record pushed to the store on first chunk. */
  sourceId: ID
  /** Track this recorder writes clips onto. */
  trackId: ID
  /** Kind of clip to spawn per chunk. */
  clipKind: 'video' | 'audio' | 'overlay'
  mimeType: string
  /** Width/height for video streams (for compositor defaults). */
  width?: number | undefined
  height?: number | undefined
  /**
   * performance.now() when the recorder actually started (onstart). Also used
   * to offset this recorder's clip against the earliest recorder of the take.
   */
  startedAtMs: number
  /** Accumulated paused time in ms, subtracted from wall-clock. */
  pausedAccumMs: number
  /** Set when paused to freeze the clock. */
  pausedAtMs: number | null
  /** Running duration written to OPFS. */
  totalDurationSec: number
  /** Bytes successfully written to the OPFS file so far. */
  byteOffset: number
  /** Sequential writer for the OPFS file, opened on the first chunk. */
  writer: AppendWriter | null
  /** Set after the first failed write; later chunks are dropped. */
  writeFailed: boolean
  /** Id of the live clip currently being extended on the timeline. */
  liveClipId: ID | null
  /** True when this manager called getUserMedia and must stop the tracks on cleanup. */
  ownedStream: boolean
  /**
   * Tail of this recorder's chunk queue. Chunks are processed strictly one
   * after another so they reach the file in order (awaiting each Blob's
   * arrayBuffer() in parallel could otherwise reorder them). Drained before
   * finalizeLiveClips in stop().
   */
  chunkQueue: Promise<void>
}

interface TrackProcessorCtor {
  new (init: { track: MediaStreamTrack }): { readable: ReadableStream<VideoFrame> }
}
interface TrackGeneratorCtor {
  new (init: {
    kind: 'video'
  }): MediaStreamTrack & { writable: WritableStream<VideoFrame> }
}

/**
 * Recorded length at `now`: wall-clock time since the recorder started,
 * minus time spent paused (a pause in progress counts from when it began).
 */
function setElapsed(rec: ActiveRecorder, now: number): void {
  const at = rec.pausedAtMs ?? now
  rec.totalDurationSec = Math.max(0, (at - rec.startedAtMs - rec.pausedAccumMs) / 1000)
}

/** Largest even integer <= n (4:2:0 frames need even crop offsets/sizes). */
const even = (n: number) => Math.max(0, Math.floor(n / 2) * 2)

/**
 * Creates a stream that carries only the cropped portion of the source video
 * track. Returns the new stream and a cleanup function, which also stops the
 * source track (it belongs to the recorder — otherwise the screen share would
 * stay alive after Stop).
 *
 * Must keep producing frames while the app is in the background, so nothing
 * here is driven by requestAnimationFrame (paused for hidden pages):
 * - MediaStreamTrackProcessor/Generator (Chromium): crops each VideoFrame
 *   zero-copy via visibleRect, paced by the source itself.
 * - Fallback: canvas redraw on a setInterval at the target fps.
 */
function buildCroppedStream(
  sourceTrack: MediaStreamTrack,
  crop: { xRatio: number; yRatio: number; widthRatio: number; heightRatio: number },
  srcW: number,
  srcH: number,
  fps: number,
): { stream: MediaStream; destroy: () => void } {
  const g = globalThis as unknown as {
    MediaStreamTrackProcessor?: TrackProcessorCtor
    MediaStreamTrackGenerator?: TrackGeneratorCtor
  }
  if (g.MediaStreamTrackProcessor && g.MediaStreamTrackGenerator) {
    const processor = new g.MediaStreamTrackProcessor({ track: sourceTrack })
    const generator = new g.MediaStreamTrackGenerator({ kind: 'video' })
    const reader = processor.readable.getReader()
    const writer = generator.writable.getWriter()
    let stopped = false
    void (async () => {
      while (!stopped) {
        let frame: VideoFrame | undefined
        try {
          const res = await reader.read()
          if (res.done) break
          frame = res.value
        } catch {
          break
        }
        try {
          // Ratios are applied per frame: a captured window can change size.
          const vr = frame.visibleRect ?? {
            x: 0,
            y: 0,
            width: frame.codedWidth,
            height: frame.codedHeight,
          }
          const w = Math.max(2, even(vr.width * crop.widthRatio))
          const h = Math.max(2, even(vr.height * crop.heightRatio))
          const x = Math.min(
            even(vr.x + vr.width * crop.xRatio),
            even(vr.x + vr.width - w),
          )
          const y = Math.min(
            even(vr.y + vr.height * crop.yRatio),
            even(vr.y + vr.height - h),
          )
          const out = new VideoFrame(frame, {
            visibleRect: { x, y, width: w, height: h },
          })
          frame.close()
          // The generator takes ownership of (and closes) written frames.
          await writer.write(out)
        } catch {
          frame.close()
          if (stopped) break
        }
      }
    })()
    return {
      stream: new MediaStream([generator]),
      destroy: () => {
        stopped = true
        void reader.cancel().catch(() => {})
        generator.stop()
        sourceTrack.stop()
      },
    }
  }

  const cropX = Math.round(srcW * crop.xRatio)
  const cropY = Math.round(srcH * crop.yRatio)
  const cropW = Math.max(2, Math.round(srcW * crop.widthRatio))
  const cropH = Math.max(2, Math.round(srcH * crop.heightRatio))
  const canvas = document.createElement('canvas')
  canvas.width = cropW
  canvas.height = cropH
  const ctx = canvas.getContext('2d', { alpha: false })!
  const video = document.createElement('video')
  video.srcObject = new MediaStream([sourceTrack])
  video.muted = true
  let timer = 0
  let stopped = false
  const draw = () => {
    if (video.readyState >= 2)
      ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH)
  }
  void video.play().then(() => {
    if (!stopped) timer = window.setInterval(draw, Math.round(1000 / fps))
  })
  return {
    stream: canvas.captureStream(fps),
    destroy: () => {
      stopped = true
      window.clearInterval(timer)
      video.srcObject = null
      sourceTrack.stop()
    },
  }
}

function pickOverlayBitrate(
  width: number | undefined,
  height: number | undefined,
): number {
  const pixels = Math.max(1, (width ?? 1280) * (height ?? 720))
  if (pixels >= 3840 * 2160) return 20_000_000
  if (pixels >= 1920 * 1080) return 10_000_000
  if (pixels >= 1280 * 720) return 6_000_000
  return 3_500_000
}

/** Screen bitrate from capture size and frame rate (30 fps baseline). */
function pickScreenBitrate(
  width: number | undefined,
  height: number | undefined,
  fps: number,
): number {
  const pixels = Math.max(1, (width ?? 1920) * (height ?? 1080))
  let bps: number
  if (pixels >= 3840 * 2160) bps = 24_000_000
  else if (pixels >= 2560 * 1440) bps = 14_000_000
  else if (pixels >= 1920 * 1080) bps = 10_000_000
  else if (pixels >= 1280 * 720) bps = 6_000_000
  else bps = 4_000_000
  return Math.round(bps * Math.min(2, Math.max(0.5, fps / 30)))
}

const SCREEN_FPS = 30

/** Thrown when the user dismisses the screen picker (not an error). */
export class CaptureCanceledError extends Error {
  constructor() {
    super('Recording canceled')
    this.name = 'CaptureCanceledError'
  }
}

/**
 * getDisplayMedia rejects with NotAllowedError both when the user dismisses
 * the picker and when the OS denies screen recording ("... by system").
 */
function isPickerCancel(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null
  return e?.name === 'NotAllowedError' && !/system/i.test(e.message ?? '')
}

function pickVideoMime(): string {
  // H.264 first: hardware-encoded on most machines (far less CPU while
  // editing). Then VP9 → VP8.
  const candidates = [
    'video/webm;codecs=h264',
    'video/webm;codecs=avc1',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ]
  for (const c of candidates) if (MediaRecorder.isTypeSupported(c)) return c
  return ''
}

function pickAudioMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm']
  for (const c of candidates) if (MediaRecorder.isTypeSupported(c)) return c
  return ''
}

/** A stream acquired by prepare(), waiting for begin() to record it. */
interface PreparedSource {
  stream: MediaStream
  trackId: ID
  kind: 'video' | 'audio' | 'overlay'
  /** User-facing name, used when the source has to be skipped. */
  label: string
  width?: number | undefined
  height?: number | undefined
  videoBitsPerSecond?: number | undefined
  ownedStream: boolean
  /** Tracks whose 'ended' stops the take, with the reason shown to the user. */
  watch: Array<{ track: MediaStreamTrack; reason: string }>
}

interface PreparedCapture {
  sources: PreparedSource[]
  /** Crop pipelines to tear down (they also stop the original display track). */
  cleanups: Array<() => void>
}

function releasePrepared(p: PreparedCapture): void {
  for (const src of p.sources) {
    if (src.ownedStream) for (const t of src.stream.getTracks()) t.stop()
  }
  for (const fn of p.cleanups) fn()
}

export class CaptureManager {
  /** Regenerated on every start() so each take gets its own OPFS folder. */
  private sessionId = uid()
  private active: ActiveRecorder[] = []
  private starting = false
  private stopping: Promise<void> | null = null
  private stopListeners: Array<() => void> = []
  private cropCleanups: Array<() => void> = []
  /** Device id to hand back to the Electron overlay after it released the camera for us. */
  private overlayRestoreDeviceId: string | null = null
  /** Called when a stream ends unexpectedly (permission revoked, device unplugged, etc). */
  onStreamEnded?: (reason: string) => void
  /** Called when a recorder raises an error mid-capture. */
  onRecorderError?: (err: unknown) => void
  /**
   * Called when an optional source (mic, webcam, system audio) couldn't be
   * acquired and the take continues without it. `err` is undefined when the
   * source simply wasn't provided (e.g. audio not ticked in the share picker).
   */
  onSourceSkipped?: (label: string, err: unknown) => void
  /** Called when a saved device id was stale and the default device was used. */
  onStaleDevice?: (kind: 'mic' | 'webcam') => void
  /** Called when background finalization of a stopped take starts / ends. */
  onFinalizing?: (active: boolean) => void

  get isRecording(): boolean {
    return this.active.length > 0
  }

  /** True from start() (incl. picker + countdown) until the take has fully stopped. */
  get isBusy(): boolean {
    return this.isRecording || this.starting || this.stopping !== null
  }

  /**
   * Start a take in phases so all recorders share one start instant:
   *   1. prepare: acquire every stream (screen picker, mic, webcam, crop);
   *   2. `beforeBegin` (e.g. the countdown) — resolve false to cancel;
   *   3. begin: create all MediaRecorders, then start them back to back.
   * Resolves true if recording started, false if canceled in `beforeBegin`.
   * Throws when the screen can't be captured (CaptureCanceledError when the
   * picker was dismissed); optional sources are skipped instead.
   */
  async start(
    opts: CaptureOptions,
    targets: CaptureTargets,
    beforeBegin?: () => Promise<boolean>,
  ): Promise<boolean> {
    // `starting` covers the awaits below (storage estimate, permission
    // prompts, countdown) during which `active` may still be empty — without
    // it a second start (e.g. menu shortcut during the countdown) would run
    // concurrently.
    if (this.isBusy) throw new Error('Already recording')
    this.starting = true
    try {
      const prepared = await this.prepare(opts, targets)
      let proceed = true
      try {
        if (beforeBegin) proceed = await beforeBegin()
      } catch (err) {
        releasePrepared(prepared)
        this.restoreOverlayCamera()
        throw err
      }
      if (!proceed) {
        releasePrepared(prepared)
        this.restoreOverlayCamera()
        return false
      }
      this.begin(prepared, opts.timesliceMs ?? 2000)
      return true
    } finally {
      this.starting = false
    }
  }

  private async prepare(
    opts: CaptureOptions,
    targets: CaptureTargets,
  ): Promise<PreparedCapture> {
    this.sessionId = uid()

    // Pre-flight: warn if OPFS is nearly full so the user can free space before
    // a recording silently loses data.
    if (navigator.storage?.estimate) {
      const { usage = 0, quota = 1 } = await navigator.storage.estimate()
      if (quota > 0 && usage / quota > 0.9) {
        throw new Error(
          'Storage is more than 90 % full. Free up space before recording.',
        )
      }
    }

    const prepared: PreparedCapture = { sources: [], cleanups: [] }
    const skip = (label: string, err: unknown) => this.onSourceSkipped?.(label, err)

    try {
      // 1. Screen + (optional) system audio. The only source whose failure
      //    aborts the take.
      if (opts.screen) {
        let displayStream: MediaStream
        try {
          displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: SCREEN_FPS },
            audio: opts.systemAudio,
          })
        } catch (err) {
          if (isPickerCancel(err)) throw new CaptureCanceledError()
          throw err
        }
        // Split off the system-audio track to record as its own clip line.
        const audioTracks = displayStream.getAudioTracks()
        if (opts.systemAudio && audioTracks.length && targets.systemAudioTrackId) {
          prepared.sources.push({
            stream: new MediaStream(audioTracks),
            trackId: targets.systemAudioTrackId,
            kind: 'audio',
            label: 'System audio',
            ownedStream: true,
            watch: audioTracks.map((track) => ({
              track,
              reason: 'System audio capture ended',
            })),
          })
        } else {
          for (const t of audioTracks) t.stop()
          if (opts.systemAudio) skip('System audio', undefined)
        }
        // Video-only stream for the main recorder.
        const videoTracks = displayStream.getVideoTracks()
        const videoTrack = videoTracks[0]
        const settings = videoTrack?.getSettings()
        let recordStream = new MediaStream(videoTracks)
        let recWidth = settings?.width
        let recHeight = settings?.height
        if (opts.cropRegion && videoTrack && settings?.width && settings?.height) {
          const { stream: croppedStream, destroy } = buildCroppedStream(
            videoTrack,
            opts.cropRegion,
            settings.width,
            settings.height,
            SCREEN_FPS,
          )
          recordStream = croppedStream
          recWidth = Math.max(
            2,
            Math.round(settings.width * opts.cropRegion.widthRatio),
          )
          recHeight = Math.max(
            2,
            Math.round(settings.height * opts.cropRegion.heightRatio),
          )
          prepared.cleanups.push(destroy)
        }
        prepared.sources.push({
          stream: recordStream,
          trackId: targets.screenTrackId,
          kind: 'video',
          label: 'Screen',
          width: recWidth,
          height: recHeight,
          videoBitsPerSecond: pickScreenBitrate(
            recWidth,
            recHeight,
            settings?.frameRate ?? SCREEN_FPS,
          ),
          ownedStream: true,
          // Watch the original track: it ends when the user clicks the
          // browser's "Stop sharing" bar (also in crop mode).
          watch: videoTrack
            ? [{ track: videoTrack, reason: 'Screen sharing was stopped' }]
            : [],
        })
      }

      // 2. Mic (optional)
      if (opts.mic && targets.micTrackId) {
        try {
          const micStream = await openMicStream(opts.micDeviceId, () =>
            this.onStaleDevice?.('mic'),
          )
          prepared.sources.push({
            stream: micStream,
            trackId: targets.micTrackId,
            kind: 'audio',
            label: 'Microphone',
            ownedStream: true,
            watch: micStream.getAudioTracks().map((track) => ({
              track,
              reason: 'Microphone was disconnected',
            })),
          })
        } catch (err) {
          skip('Microphone', err)
        }
      }

      // 3. Webcam overlay (optional)
      if (opts.webcam && targets.webcamTrackId) {
        try {
          // Reuse the self-view stream when available to avoid opening a
          // second concurrent getUserMedia session on the same device.
          const borrowed =
            opts.webcamStream?.getVideoTracks()[0]?.readyState === 'live'
              ? opts.webcamStream
              : undefined
          const camStream = borrowed ?? (await this.openCamera(opts.webcamDeviceId))
          const camTrack = camStream.getVideoTracks()[0]
          const settings = camTrack?.getSettings()
          prepared.sources.push({
            stream: camStream,
            trackId: targets.webcamTrackId,
            kind: 'overlay',
            label: 'Webcam',
            width: settings?.width,
            height: settings?.height,
            videoBitsPerSecond: pickOverlayBitrate(settings?.width, settings?.height),
            ownedStream: !borrowed,
            // Borrowed tracks too: if the preview's stream dies the webcam
            // recording is dead as well, and the user must hear about it.
            watch: camTrack
              ? [{ track: camTrack, reason: 'Webcam was disconnected' }]
              : [],
          })
        } catch (err) {
          skip('Webcam', err)
        }
      }
    } catch (err) {
      releasePrepared(prepared)
      this.restoreOverlayCamera()
      throw err
    }
    return prepared
  }

  /**
   * Open the camera for recording. In Electron the native overlay window
   * holds its own stream of the same camera; drivers that refuse a second
   * open fail with NotReadableError — then ask the overlay to release the
   * camera and retry once (it re-opens it after the take).
   */
  private async openCamera(deviceId: string | undefined): Promise<MediaStream> {
    const onStale = () => this.onStaleDevice?.('webcam')
    try {
      return await openWebcamStream(deviceId, onStale)
    } catch (err) {
      const overlay = window.electronAPI?.overlay
      if (
        !IS_ELECTRON ||
        !overlay ||
        (err as { name?: string }).name !== 'NotReadableError'
      )
        throw err
      overlay.updateParams({ deviceId: OVERLAY_RELEASE_CAMERA })
      this.overlayRestoreDeviceId = deviceId ?? ''
      await new Promise((r) => window.setTimeout(r, 500))
      return await openWebcamStream(deviceId, onStale)
    }
  }

  private restoreOverlayCamera(): void {
    if (this.overlayRestoreDeviceId === null) return
    window.electronAPI?.overlay.updateParams({ deviceId: this.overlayRestoreDeviceId })
    this.overlayRestoreDeviceId = null
  }

  private begin(prepared: PreparedCapture, timeslice: number): void {
    const fail = (sources: PreparedSource[], err: unknown): never => {
      this.active = []
      releasePrepared({ sources, cleanups: prepared.cleanups })
      this.restoreOverlayCamera()
      throw err
    }
    // Anything that ended while we waited (countdown)? A dead screen share
    // aborts; a dead optional source is skipped.
    const ended = (src: PreparedSource) =>
      src.watch.some((w) => w.track.readyState === 'ended')
    const sources = prepared.sources.filter((src) => {
      if (src.kind === 'video' || !ended(src)) return true
      this.onSourceSkipped?.(src.label, undefined)
      if (src.ownedStream) for (const t of src.stream.getTracks()) t.stop()
      return false
    })
    if (sources.some((src) => src.kind === 'video' && ended(src)))
      fail(sources, new CaptureCanceledError())
    if (sources.length === 0)
      fail(sources, new Error('No capture source could be started.'))

    // Create every recorder first (the constructor can throw on an
    // unsupported config), then start them back to back so their clips line
    // up; residual skew is compensated from each recorder's onstart time.
    try {
      for (const src of sources) this.createRecorder(src)
    } catch (err) {
      fail(sources, err)
    }
    this.cropCleanups.push(...prepared.cleanups)

    // Right before the first recorder starts: the first chunk needs
    // trackCursor initialized and undo frozen.
    this.alignAtMs = null
    useEditor.getState().startRecording()
    for (const r of this.active) {
      registerLiveStream(r.sourceId, r.stream)
      r.recorder.start(timeslice)
    }

    for (const src of sources) {
      for (const { track, reason } of src.watch) {
        const onEnded = () => {
          // Ignore a second track of the same share ending right after the
          // first, and anything after the take already stopped.
          if (!this.isRecording || this.stopping) return
          this.onStreamEnded?.(reason)
          void this.stop()
        }
        track.addEventListener('ended', onEnded)
        // Removed when the take stops: a borrowed track (the self-view
        // camera) outlives the take, and its later 'ended' must not stop the
        // next take.
        this.stopListeners.push(() => track.removeEventListener('ended', onEnded))
      }
    }
    if (sources.some((src) => src.kind === 'overlay' && !src.ownedStream))
      usePipStore.getState().setWebcamBorrowed(true)
    window.electronAPI?.tray.setRecording(true)
  }

  private createRecorder(src: PreparedSource): void {
    const { stream, trackId, kind, width, height } = src
    const mimeType = kind === 'audio' ? pickAudioMime() : pickVideoMime()
    const sourceId = uid()
    const ext = 'webm'
    const opfsPath = `sessions/${this.sessionId}/${sourceId}.${ext}`
    // Force ~1s GOP + tuned bitrates for cleaner mid-segment splits later.
    const recorderOpts: MediaRecorderOptions = {
      ...(mimeType ? { mimeType } : {}),
      videoKeyFrameIntervalDuration: 1000,
      videoBitsPerSecond: kind === 'audio' ? undefined : src.videoBitsPerSecond,
      audioBitsPerSecond: kind === 'audio' ? 128_000 : undefined,
    } as MediaRecorderOptions
    const recorder = new MediaRecorder(stream, recorderOpts)

    const rec: ActiveRecorder = {
      stream,
      recorder,
      opfsPath,
      sourceId,
      trackId,
      clipKind: kind,
      mimeType: mimeType || recorder.mimeType || 'video/webm',
      width,
      height,
      startedAtMs: 0,
      pausedAccumMs: 0,
      pausedAtMs: null,
      totalDurationSec: 0,
      byteOffset: 0,
      writer: null,
      writeFailed: false,
      liveClipId: null,
      ownedStream: src.ownedStream,
      chunkQueue: Promise.resolve(),
    }
    this.active.push(rec)

    let sourceRegistered = false
    recorder.onstart = () => {
      rec.startedAtMs = performance.now()
    }
    recorder.onpause = () => {
      // pause() already set this; only fall back if the app didn't.
      if (rec.pausedAtMs == null) rec.pausedAtMs = performance.now()
    }
    recorder.onresume = () => {
      if (rec.pausedAtMs != null) {
        rec.pausedAccumMs += performance.now() - rec.pausedAtMs
        rec.pausedAtMs = null
      }
    }
    recorder.ondataavailable = (ev) => {
      rec.chunkQueue = rec.chunkQueue
        .then(() =>
          this.onChunk(rec, ev, () => {
            if (!sourceRegistered) {
              sourceRegistered = true
              const source: MediaSource = {
                id: rec.sourceId,
                kind: rec.clipKind === 'audio' ? 'audio' : 'video',
                opfsPath: rec.opfsPath,
                mimeType: rec.mimeType,
                duration: 0,
                width: rec.width,
                height: rec.height,
                createdAt: Date.now(),
                name:
                  rec.clipKind === 'audio'
                    ? 'Audio capture'
                    : rec.clipKind === 'overlay'
                      ? 'Webcam capture'
                      : 'Screen capture',
              }
              useEditor.getState().addSource(source)
            }
          }),
        )
        .catch((err: unknown) => {
          emitError('Failed to process recording chunk', err)
        })
    }
    recorder.onerror = (e) => {
      emitError('MediaRecorder error', e)
      this.onRecorderError?.(e)
      // A failed recorder goes inactive while the others keep running, which
      // would silently produce a take missing a track. Stop the whole take.
      void this.stop()
    }
  }

  /**
   * The instant all clips of the take line up at (performance.now() ms):
   * the latest recorder start known when the take's first clip is placed.
   * Reset per take in begin().
   */
  private alignAtMs: number | null = null

  /**
   * Where this recorder's clip goes so every track of the take stays in sync
   * AND starts at the same timeline point. Recorders start a little apart
   * (the video encoder is slower to start than audio); instead of delaying
   * the later clips (a gap at the start of the take), the earlier ones skip
   * their first moments via `sourceIn`. Only a recorder that starts after the
   * alignment point was fixed (rare) is delayed on the timeline instead.
   */
  private alignment(rec: ActiveRecorder): { delaySec: number; sourceInSec: number } {
    if (this.alignAtMs === null) {
      const starts = this.active.map((r) => r.startedAtMs).filter((t) => t > 0)
      this.alignAtMs = starts.length > 0 ? Math.max(...starts) : rec.startedAtMs
    }
    const deltaSec = (rec.startedAtMs - this.alignAtMs) / 1000
    return deltaSec >= 0
      ? { delaySec: deltaSec, sourceInSec: 0 }
      : { delaySec: 0, sourceInSec: -deltaSec }
  }

  private async onChunk(
    rec: ActiveRecorder,
    ev: BlobEvent,
    beforeFirst: () => void,
  ): Promise<void> {
    if (!ev.data || ev.data.size === 0) return
    if (rec.writeFailed) return
    beforeFirst()

    if (!rec.startedAtMs) rec.startedAtMs = performance.now()
    setElapsed(rec, performance.now())

    // Persist chunk to OPFS. The writer appends strictly in order.
    const bytes = new Uint8Array(await ev.data.arrayBuffer())
    try {
      rec.writer ??= await openAppendWriter(rec.opfsPath)
      await rec.writer.append(bytes)
    } catch (err) {
      // Once a chunk is lost the rest of the file can't be decoded past that
      // point (and a lost first chunk loses the WebM header). Stop the take so
      // everything captured so far stays intact instead of recording on into
      // a broken file.
      rec.writeFailed = true
      emitError('Recording stopped: could not write to storage', err)
      this.onRecorderError?.(err)
      void this.stop()
      return
    }
    rec.byteOffset += bytes.byteLength

    // Create (once) or extend the live clip on the timeline.
    const store = useEditor.getState()
    if (!rec.liveClipId) {
      // Compensate this recorder's start skew so all tracks of the take stay
      // in sync with each other (see alignment()).
      const { delaySec, sourceInSec } = this.alignment(rec)
      const startAt =
        (store.recording.trackCursor[rec.trackId] ?? store.playhead) + delaySec
      const isPip = rec.clipKind === 'overlay'
      rec.liveClipId = store.addClip({
        trackId: rec.trackId,
        sourceId: rec.sourceId,
        timelineStart: startAt,
        // Never past the recorded length (a near-empty first chunk).
        sourceIn: Math.min(sourceInSec, rec.totalDurationSec),
        sourceOut: rec.totalDurationSec,
        speed: 1,
        volume: 1,
        // Default webcam PIP: identity scale — the compositor's overlay base
        // size already renders it at ~25% of the frame, pinned bottom-right
        // (0,0 means at the default pin position).
        transform: isPip
          ? { ...identityTransform, scaleX: 1, scaleY: 1 }
          : { ...identityTransform },
        isLive: true,
      })
    }
    this.syncLiveClips(performance.now())
  }

  /**
   * Grow every live clip of the take to the same instant. Recorders deliver
   * chunks on their own schedules; extending only the one that just got a
   * chunk leaves the clip ends staggered by up to a timeslice.
   */
  private syncLiveClips(now: number): void {
    const store = useEditor.getState()
    for (const r of this.active) {
      if (!r.liveClipId || r.writeFailed || !r.startedAtMs) continue
      setElapsed(r, now)
      store.extendLiveClip(r.liveClipId, r.totalDurationSec)
      store.updateSourceDuration(r.sourceId, r.totalDurationSec)
    }
  }

  pause(): void {
    const now = performance.now()
    for (const r of this.active) {
      // Track pause start ourselves so we don't depend on MediaRecorder's
      // onpause event firing (it's unreliable on some display streams).
      if (r.pausedAtMs == null) r.pausedAtMs = now
      try {
        if (r.recorder.state === 'recording') r.recorder.pause()
      } catch (err) {
        console.warn('MediaRecorder.pause failed', err)
      }
    }
    useEditor.getState().pauseRecording()
    window.electronAPI?.tray.setPaused(true)
  }

  resume(): void {
    const now = performance.now()
    for (const r of this.active) {
      if (r.pausedAtMs != null) {
        r.pausedAccumMs += now - r.pausedAtMs
        r.pausedAtMs = null
      }
      try {
        if (r.recorder.state === 'paused') r.recorder.resume()
      } catch (err) {
        console.warn('MediaRecorder.resume failed', err)
      }
    }
    useEditor.getState().resumeRecording()
    window.electronAPI?.tray.setPaused(false)
  }

  stop(): Promise<void> {
    // Idempotent: a stream 'ended' event, a write failure and the Stop button
    // can all call stop(). A second concurrent run would see the recorders
    // already inactive and finalize before the last chunk is written.
    this.stopping ??= this.stopInner().finally(() => {
      this.stopping = null
    })
    return this.stopping
  }

  private async stopInner(): Promise<void> {
    // If stopped while paused, close out the paused span so any trailing
    // chunk's elapsed math doesn't include the paused time.
    const now = performance.now()
    for (const r of this.active) {
      if (r.pausedAtMs != null) {
        r.pausedAccumMs += now - r.pausedAtMs
        r.pausedAtMs = null
      }
    }
    const stopOne = (r: ActiveRecorder) =>
      new Promise<void>((resolve) => {
        if (r.recorder.state === 'inactive') {
          resolve()
          return
        }
        r.recorder.addEventListener('stop', () => resolve(), { once: true })
        try {
          r.recorder.stop()
        } catch {
          resolve()
        }
      })
    await Promise.all(this.active.map(stopOne))
    // Drain each recorder's chunk queue so the final chunk (emitted just
    // before the 'stop' event) is fully written to OPFS and the timeline clip
    // is updated before we call finalizeLiveClips.
    await Promise.all(this.active.map((r) => r.chunkQueue))
    await Promise.all(
      this.active.map(async (r) => {
        try {
          await r.writer?.close()
        } catch (err) {
          emitError('Failed to close recording file', err)
        }
      }),
    )
    const recorded: RecordedFile[] = []
    for (const r of this.active) {
      unregisterLiveStream(r.sourceId)
      // Only stop tracks we opened; borrowed streams (e.g. from self-view PiP)
      // are managed by their owner (useWebcamPreview).
      if (r.ownedStream) {
        for (const t of r.stream.getTracks()) t.stop()
      }
      if (r.byteOffset > 0 && !r.writeFailed)
        recorded.push({
          sourceId: r.sourceId,
          clipId: r.liveClipId,
          opfsPath: r.opfsPath,
          estimatedDurationSec: r.totalDurationSec,
        })
    }
    this.active = []
    // Crop pipelines also stop the original display track (ends the share).
    for (const fn of this.cropCleanups) fn()
    this.cropCleanups = []
    for (const fn of this.stopListeners) fn()
    this.stopListeners = []
    const state = useEditor.getState()
    // The project the take belongs to (projects can't be switched mid-take).
    const projectId = state.project.id
    state.finalizeLiveClips()
    state.stopRecording()
    window.electronAPI?.tray.setRecording(false)
    usePipStore.getState().setWebcamBorrowed(false)
    this.restoreOverlayCamera()
    // Remux (duration + cues), correct clip lengths and copy to the
    // recordings folder in the background; the take is already usable from
    // the original files. Tracked, so closing the app waits for it.
    if (recorded.length > 0) void this.finalizeFiles(recorded, projectId)
  }

  /** Tail of the finalization queue (takes are finalized one at a time). */
  private finalizing: Promise<void> = Promise.resolve()
  private pendingFinalizations = 0

  /** True while a stopped take is still being finalized / saved to disk. */
  get isFinalizing(): boolean {
    return this.pendingFinalizations > 0
  }

  /**
   * Finalize recorded files of `projectId` (a stopped take, or one recovered
   * after a crash). Queued behind earlier takes. Never rejects.
   */
  finalizeFiles(files: RecordedFile[], projectId: ID): Promise<void> {
    if (this.pendingFinalizations++ === 0) {
      this.onFinalizing?.(true)
      window.electronAPI?.app.setSaving(true)
    }
    const run = this.finalizing.then(() => finalizeRecordedFiles(files, projectId))
    this.finalizing = run
      .catch((err: unknown) => {
        emitError('Could not finish saving the recording', err)
      })
      .finally(() => {
        if (--this.pendingFinalizations === 0) {
          this.onFinalizing?.(false)
          window.electronAPI?.app.setSaving(false)
        }
      })
    return this.finalizing
  }

  /**
   * Resolves once no take is being stopped or finalized — everything recorded
   * so far has been remuxed and copied to the recordings folder.
   */
  async whenIdle(): Promise<void> {
    // A stop can start a new finalization; loop until both are settled.
    for (;;) {
      const stopping = this.stopping
      const finalizing = this.finalizing
      await stopping
      await finalizing
      if (this.stopping === null && this.finalizing === finalizing) return
    }
  }
}

/**
 * The one CaptureManager for the app. It lives outside React on purpose: a
 * recording must survive any component unmounting (layout swaps, error
 * boundaries), otherwise the recorder keeps writing with nothing left that
 * can stop it.
 */
let shared: CaptureManager | null = null
export function getCaptureManager(): CaptureManager {
  return (shared ??= new CaptureManager())
}
