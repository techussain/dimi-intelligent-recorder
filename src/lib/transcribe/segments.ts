import type { TranscriptSegment } from '../timeline/types'

/**
 * Whisper emits non-speech annotations as whole segments ("[BLANK_AUDIO]",
 * "[Music]", "(upbeat music)"). They'd become junk captions — drop them.
 */
const NON_SPEECH = /^\s*(\[[^\]]*\]|\([^)]*\)|♪+)\s*$/

/** Trim text, drop empty / non-speech / zero-length segments, sort by start. */
export function cleanSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  return segments
    .map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text.replace(/\s+/g, ' ').trim(),
    }))
    .filter(
      (s) =>
        s.text.length > 0 &&
        !NON_SPEECH.test(s.text) &&
        Number.isFinite(s.start) &&
        Number.isFinite(s.end) &&
        s.end > s.start,
    )
    .sort((a, b) => a.start - b.start)
}

/**
 * Append the segments of one transcription block to those already collected.
 * Blocks overlap slightly so words at a block boundary aren't cut; segments of
 * the new block that start before the collected ones end are duplicates of
 * that overlap and are dropped.
 */
export function appendBlock(
  collected: TranscriptSegment[],
  block: TranscriptSegment[],
): TranscriptSegment[] {
  const lastEnd =
    collected.length > 0 ? collected[collected.length - 1]!.end : -Infinity
  const fresh = block.filter((s) => s.start >= lastEnd - 0.05)
  return [...collected, ...fresh]
}
