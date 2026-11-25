export function buildPreferredWebcamConstraints(
  deviceId?: string,
): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
    width: { ideal: 3840 },
    height: { ideal: 2160 },
    frameRate: { ideal: 30, max: 30 },
  }
}

export async function maximizeWebcamTrack(
  track: MediaStreamTrack | null | undefined,
): Promise<void> {
  if (!track || typeof track.getCapabilities !== 'function') return

  const capabilities = track.getCapabilities()
  const next: MediaTrackConstraints = {}

  if (typeof capabilities.width?.max === 'number') {
    next.width = { ideal: capabilities.width.max }
  }
  if (typeof capabilities.height?.max === 'number') {
    next.height = { ideal: capabilities.height.max }
  }
  if (typeof capabilities.frameRate?.max === 'number') {
    next.frameRate = { ideal: Math.min(capabilities.frameRate.max, 30), max: 30 }
  }
  if (Object.keys(next).length === 0) return

  try {
    await track.applyConstraints(next)
  } catch {
    // Some drivers reject capability-max constraints; keep the acquired stream.
  }
}
/**
 * A saved deviceId that no longer matches a connected device fails with
 * OverconstrainedError (deviceId: {exact}) or NotFoundError.
 */
export function isStaleDeviceError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name
  return name === 'OverconstrainedError' || name === 'NotFoundError'
}

/**
 * Open the webcam at the best available resolution. If the saved `deviceId`
 * is stale (camera unplugged / ids rotated), retries once with the default
 * camera and calls `onStaleDevice` so the caller can forget the saved id.
 */
export async function openWebcamStream(
  deviceId?: string,
  onStaleDevice?: () => void,
): Promise<MediaStream> {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: buildPreferredWebcamConstraints(deviceId),
      audio: false,
    })
  } catch (err) {
    if (!deviceId || !isStaleDeviceError(err)) throw err
    onStaleDevice?.()
    stream = await navigator.mediaDevices.getUserMedia({
      video: buildPreferredWebcamConstraints(undefined),
      audio: false,
    })
  }
  await maximizeWebcamTrack(stream.getVideoTracks()[0])
  return stream
}

/**
 * Sentinel deviceId sent to the Electron overlay window (via
 * overlay.updateParams) asking it to release the camera so the recorder can
 * open it. Any other string (including '' = default camera) re-opens it.
 */
export const OVERLAY_RELEASE_CAMERA = '__release__'
