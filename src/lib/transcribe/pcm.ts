/**
 * Streaming downmix + resample to 16 kHz mono (Whisper's input format).
 *
 * Downsampling (44.1 / 48 kHz → 16 kHz, the common case): each output
 * sample is the average of the input samples in its time window (a box
 * filter), which doubles as a cheap anti-aliasing filter.
 * Upsampling (8 / 11.025 kHz phone or voice-memo audio → 16 kHz): output
 * samples are linearly interpolated between neighbouring input samples.
 *
 * Works chunk by chunk, so an hour of audio never has to exist at the source
 * rate in memory — only the 16 kHz mono result (~3.8 MB per minute).
 */
export const WHISPER_SAMPLE_RATE = 16_000

export class MonoResampler {
  /** Input samples per output sample (< 1 when upsampling). */
  private readonly step: number
  private readonly upsampling: boolean
  // Downsampling (box filter) state.
  private sum = 0
  private count = 0
  /** Input-sample position (fractional) where the current output window ends. */
  private boundary: number
  // Upsampling (linear interpolation) state.
  private prev = 0
  /** Input-sample position of the next output sample. */
  private nextPos = 0
  private emitted = 0

  private inputPos = 0
  private chunks: Float32Array[] = []
  private current: Float32Array
  private currentLen = 0

  constructor(inputRate: number, outputRate = WHISPER_SAMPLE_RATE) {
    if (!(inputRate > 0) || !(outputRate > 0)) throw new Error('Invalid sample rate')
    this.step = inputRate / outputRate
    this.upsampling = this.step < 1
    this.boundary = this.step
    this.current = new Float32Array(1 << 16)
  }

  /** Push one chunk of planar channel data (all channels the same length). */
  push(channels: readonly Float32Array[], frames: number): void {
    const n = channels.length
    if (n === 0) return
    for (let i = 0; i < frames; i++) {
      let v = 0
      for (let c = 0; c < n; c++) v += channels[c]![i]!
      v /= n
      if (this.upsampling) this.pushInterpolated(v)
      else this.pushAveraged(v)
    }
  }

  /** Box filter: average the inputs falling into each output window. */
  private pushAveraged(v: number): void {
    this.sum += v
    this.count++
    this.inputPos++
    // step >= 1: at most one window closes per input sample.
    if (this.inputPos >= this.boundary) {
      this.emit(this.sum / this.count)
      this.sum = 0
      this.count = 0
      this.boundary += this.step
    }
  }

  /** Linear interpolation: emit every output position up to this input sample. */
  private pushInterpolated(v: number): void {
    const at = this.inputPos // index of `v`
    if (at === 0) this.prev = v
    // Output positions in (at - 1, at] lie between prev (at - 1) and v (at).
    while (this.nextPos <= at) {
      const frac = this.nextPos - (at - 1)
      this.emit(at === 0 ? v : this.prev + (v - this.prev) * frac)
      this.emitted++
      this.nextPos = this.emitted * this.step
    }
    this.prev = v
    this.inputPos++
  }

  /** All output so far (plus a final partial window), as one array. */
  finish(): Float32Array {
    if (this.upsampling) {
      // Hold the last sample until the output covers the input's duration.
      const total = Math.round(this.inputPos / this.step)
      while (this.inputPos > 0 && this.emitted < total) {
        this.emit(this.prev)
        this.emitted++
      }
    } else if (this.count > 0) {
      this.emit(this.sum / this.count)
      this.sum = 0
      this.count = 0
    }
    const total = this.chunks.reduce((n, c) => n + c.length, 0) + this.currentLen
    const out = new Float32Array(total)
    let off = 0
    for (const c of this.chunks) {
      out.set(c, off)
      off += c.length
    }
    out.set(this.current.subarray(0, this.currentLen), off)
    return out
  }

  private emit(v: number): void {
    if (this.currentLen === this.current.length) {
      this.chunks.push(this.current)
      this.current = new Float32Array(this.current.length)
      this.currentLen = 0
    }
    this.current[this.currentLen++] = v
  }
}
