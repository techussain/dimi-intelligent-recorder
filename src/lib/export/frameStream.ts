/**
 * Sequential video frame decoding for export.
 *
 * Export used to seek an HTMLVideoElement once per output frame and wait for
 * each `seeked` event — every frame paid a full seek, serially. Here each
 * layer gets a mediabunny CanvasSink fed with the *complete, ordered* list of
 * source timestamps it will need (computed up front from the scene). With
 * monotonic timestamps mediabunny decodes each packet at most once, so a
 * clip's frames stream out in decode order instead of being sought one by one.
 *
 * The timestamp list is a plain array (not a push-based iterable) so the
 * decoder can read ahead freely without waiting on the render loop.
 */
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny'

export interface FrameStream {
  /**
   * The frame for the next timestamp in the list, or null if the file has no
   * frame there (e.g. before its first frame). Call exactly once per entry of
   * the timestamps array, in order.
   */
  next(): Promise<HTMLCanvasElement | OffscreenCanvas | null>
  dispose(): void
}

/**
 * Open a frame stream over `file` for the given timestamps (seconds).
 * Resolves null when the file can't be decoded this way (unsupported
 * container/codec, no video track) — callers fall back to element seeking.
 */
export async function openFrameStream(
  file: File,
  timestamps: number[],
  opts: { alpha?: boolean } = {},
): Promise<FrameStream | null> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track || !(await track.canDecode())) {
      input.dispose()
      return null
    }
    // Transparent sources (VP9 alpha) keep their alpha instead of black.
    const sink = new CanvasSink(track, { alpha: !!opts.alpha })
    const frames = sink.canvasesAtTimestamps(timestamps)
    let done = false
    return {
      async next() {
        if (done) return null
        const r = await frames.next()
        if (r.done) {
          done = true
          return null
        }
        return r.value?.canvas ?? null
      },
      dispose() {
        done = true
        void frames.return(undefined).catch(() => {})
        input.dispose()
      },
    }
  } catch {
    input.dispose()
    return null
  }
}
