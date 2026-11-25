/**
 * Silence analysis worker: decodes a media file's audio (mediabunny,
 * streaming) and returns its loudness envelope — one dBFS value per 20 ms.
 *
 * Protocol (main → worker): { id, opfsPath }
 * Protocol (worker → main):
 *   { id, type: 'progress', progress }
 *   { id, type: 'result', start, frameSec, db }   (db transferred)
 *   { id, type: 'error', message }
 */
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from 'mediabunny'
import { EnvelopeBuilder, FRAME_SEC } from '../lib/silence/detect'

const post = (msg: unknown, transfer: Transferable[] = []) => {
  ;(self as unknown as Worker).postMessage(msg, transfer)
}

async function openFile(opfsPath: string): Promise<File> {
  const parts = opfsPath.replace(/^\/+|\/+$/g, '').split('/')
  const name = parts.pop()
  if (!name) throw new Error(`Invalid OPFS path: ${opfsPath}`)
  let dir = await navigator.storage.getDirectory()
  for (const p of parts) dir = await dir.getDirectoryHandle(p)
  return await (await dir.getFileHandle(name)).getFile()
}

async function analyze(id: number, opfsPath: string): Promise<void> {
  const input = new Input({
    source: new BlobSource(await openFile(opfsPath)),
    formats: ALL_FORMATS,
  })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track) throw new Error('This media has no audio track.')
    if (!(await track.canDecode()))
      throw new Error("This media's audio format can't be decoded.")
    const start = await track.getFirstTimestamp()
    const duration = Math.max(0, (await track.computeDuration()) - start)
    let builder: EnvelopeBuilder | null = null
    let planes: Float32Array[] = []
    let lastReport = 0
    for await (const sample of new AudioSampleSink(track).samples()) {
      try {
        builder ??= new EnvelopeBuilder(sample.sampleRate)
        const frames = sample.numberOfFrames
        const n = sample.numberOfChannels
        if (planes.length !== n || (planes[0]?.length ?? 0) < frames) {
          planes = Array.from({ length: n }, () => new Float32Array(frames))
        }
        for (let c = 0; c < n; c++) {
          sample.copyTo(planes[c]!, { planeIndex: c, format: 'f32-planar' })
        }
        builder.push(planes, frames)
        const p = duration > 0 ? (sample.timestamp - start) / duration : 0
        if (p - lastReport >= 0.02) {
          lastReport = p
          post({ id, type: 'progress', progress: Math.min(1, p) })
        }
      } finally {
        sample.close()
      }
    }
    if (!builder) throw new Error('No audio found in this media.')
    const db = builder.finish()
    post({ id, type: 'result', start, frameSec: FRAME_SEC, db }, [db.buffer])
  } finally {
    input.dispose()
  }
}

self.onmessage = (ev: MessageEvent<{ id: number; opfsPath: string }>) => {
  const { id, opfsPath } = ev.data
  analyze(id, opfsPath).catch((err: unknown) =>
    post({
      id,
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    }),
  )
}
