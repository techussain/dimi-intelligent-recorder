/**
 * Shared contract for animated sources that aren't <video> elements
 * (animated GIF / WebP / APNG / AVIF, Lottie). One provider instance per
 * scene layer (keyed by `layer.key`): `frameAt` may return a shared canvas
 * that the next call overwrites, so it must be drawn before asking again.
 */
export interface FrameProvider {
  /** Intrinsic size (the returned frame's pixel size may differ, e.g. Lottie hi-dpi). */
  readonly width: number
  readonly height: number
  /** Length of one play-through, in seconds. */
  readonly duration: number
  /**
   * Synchronous: the frame for local time `t` (seconds from the asset's start).
   * `loop` repeats past `duration`, otherwise the last frame holds.
   * Returns the nearest decoded frame (or null) when the exact one isn't
   * available yet; decoding it is started and `subscribe` listeners fire
   * once it lands.
   */
  frameAt(t: number, loop: boolean): CanvasImageSource | null
  /** Resolves once `frameAt(t, loop)` will return the exact frame (export). */
  prepare(t: number, loop: boolean): Promise<void>
  /** Called whenever a frame that was missing becomes available. Returns unsubscribe. */
  subscribe(listener: () => void): () => void
  /** Resolves when the first frame can be drawn; rejects if the asset can't be loaded. */
  readonly ready: Promise<void>
  dispose(): void
}
