import type { Clip } from './types'

/**
 * Correct a finished take's clip to its file's real length (`duration`),
 * given the length it was estimated at while recording (`estimated`).
 *
 * All recorders of a take are stopped together, so every file ENDS at the
 * same instant — the reliable anchor. (Their reported start times are not:
 * MediaRecorder's `start` events can be a few hundred ms apart even when the
 * files themselves start together.) So the clip keeps its end on the
 * timeline and the source window shifts by the difference: the clips of a
 * take end together and stay in sync. Only if the file is too short to fill
 * the clip does the clip start later instead.
 *
 * A take interrupted by a crash is different: its clip was saved at the last
 * checkpoint, and the footage recorded after it is at the END of the file —
 * there the clip keeps its start and grows (`keepEnd: false`).
 */
export function anchorRecordedClip(
  c: Clip,
  estimated: number,
  duration: number,
  keepEnd = true,
): void {
  if (!keepEnd) {
    c.sourceOut = Math.max(c.sourceIn + 0.01, duration)
    return
  }
  const shift = duration - estimated
  const sourceIn = c.sourceIn + shift
  if (sourceIn < 0) {
    c.timelineStart += -sourceIn / (c.speed || 1)
    c.sourceIn = 0
  } else {
    c.sourceIn = sourceIn
  }
  c.sourceOut = Math.max(c.sourceIn + 0.01, duration)
}
