/**
 * Registry of the MediaStreams currently being recorded, keyed by the
 * MediaSource id the recorder writes to.
 *
 * The recorder (CaptureManager) registers a stream when it creates the source
 * and unregisters it when the take stops. The preview compositor and mixer
 * read from here to show/hear live clips while recording — an
 * HTMLVideoElement pointed at the OPFS file can't see data appended after it
 * loaded, so live clips are rendered straight from the stream instead.
 */
import type { ID } from '../timeline/types'

const streams = new Map<ID, MediaStream>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const cb of listeners) cb()
}

export function registerLiveStream(sourceId: ID, stream: MediaStream): void {
  streams.set(sourceId, stream)
  notify()
}

export function unregisterLiveStream(sourceId: ID): void {
  if (streams.delete(sourceId)) notify()
}

export function getLiveStream(sourceId: ID): MediaStream | undefined {
  return streams.get(sourceId)
}

/** Subscribe to registry changes. Returns an unsubscribe function. */
export function onLiveStreamsChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
