/**
 * Waveform worker: streams the file's primary audio track through mediabunny
 * (WebCodecs AudioDecoder, available in workers — OfflineAudioContext is not)
 * and folds each decoded chunk straight into per-bin peaks. Memory stays
 * bounded: the full PCM is never materialised.
 *
 * Failures (no audio track, undecodable codec, unknown duration) are reported
 * as errors — never as all-zero peaks, which would be cached as valid.
 *
 * Protocol (main → worker):
 *   { id: number; opfsPath: string; bins: number }
 * Protocol (worker → main):
 *   { id: number; peaks: Float32Array }   — transferable
 *   { id: number; error: string }
 */
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from 'mediabunny'

interface WaveformRequest {
  id: number
  opfsPath: string
  bins: number
}

async function openFile(opfsPath: string): Promise<File> {
  // Resolve OPFS path segments directly inside the worker — OPFS is available here.
  const parts = opfsPath.replace(/^\/+|\/+$/g, '').split('/')
  const filename = parts.pop()
  if (!filename) throw new Error(`Invalid OPFS path: ${opfsPath}`)

  let dir = await navigator.storage.getDirectory()
  for (const seg of parts) {
    dir = await dir.getDirectoryHandle(seg)
  }
  const fh = await dir.getFileHandle(filename)
  return await fh.getFile()
}

async function generate(opfsPath: string, bins: number): Promise<Float32Array> {
  const file = await openFile(opfsPath)
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track) throw new Error('No audio track')
    if (!(await track.canDecode())) throw new Error('Audio codec cannot be decoded')
    const start = await track.getFirstTimestamp()
    const duration = (await track.computeDuration()) - start
    if (!(duration > 0)) throw new Error('Unknown audio duration')

    // Peak-per-bin across all channels.
    const peaks = new Float32Array(bins)
    const binsPerSec = bins / duration
    let buf = new Float32Array(0)
    const sink = new AudioSampleSink(track)
    for await (const sample of sink.samples()) {
      try {
        const frames = sample.numberOfFrames
        if (buf.length < frames) buf = new Float32Array(frames)
        const t0 = (sample.timestamp - start) * binsPerSec
        const step = binsPerSec / sample.sampleRate
        for (let ch = 0; ch < sample.numberOfChannels; ch++) {
          sample.copyTo(buf, { planeIndex: ch, format: 'f32-planar' })
          for (let i = 0; i < frames; i++) {
            const b = Math.min(bins - 1, Math.max(0, Math.floor(t0 + i * step)))
            const v = Math.abs(buf[i]!)
            if (v > peaks[b]!) peaks[b] = v
          }
        }
      } finally {
        sample.close()
      }
    }
    return peaks
  } finally {
    input.dispose()
  }
}

self.onmessage = (ev: MessageEvent<WaveformRequest>) => {
  const { id, opfsPath, bins } = ev.data
  generate(opfsPath, bins)
    .then((peaks) => {
      ;(self as unknown as Worker).postMessage({ id, peaks }, [peaks.buffer])
    })
    .catch((err: unknown) => {
      ;(self as unknown as Worker).postMessage({
        id,
        error: err instanceof Error ? err.message : String(err),
      })
    })
}
