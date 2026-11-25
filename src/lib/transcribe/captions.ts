import type { Clip, Project, TextStyle } from '../timeline/types'
import { isTrackSilenced } from '../timeline/trackState'
import { DEFAULT_TEXT_FONT } from '../text/fonts'

/** A caption on the timeline (timeline seconds). */
export interface CaptionCue {
  start: number
  end: number
  text: string
}

/** Readable caption layout: at most two lines of ~42 characters. */
const LINE_CHARS = 42
const MAX_LINES = 2
/** Cues shorter than this are dropped (a sliver left by a trim). */
const MIN_CUE_SEC = 0.2

function clipDuration(c: Clip): number {
  return Math.max(0, (c.sourceOut - c.sourceIn) / Math.max(0.1, c.speed || 1))
}

/**
 * Map every transcript onto the timeline: for each audible clip whose source
 * has a transcript, the segments inside the clip's trimmed range become cues
 * at the matching timeline times (respecting speed). Overlapping cues from
 * different clips are trimmed so captions never stack.
 */
export function buildCaptionCues(project: Project): CaptionCue[] {
  const transcripts = project.transcripts ?? {}
  const raw: CaptionCue[] = []
  for (const clip of project.clips) {
    if (clip.isLive) continue
    const transcript = transcripts[clip.sourceId]
    if (!transcript) continue
    const track = project.tracks.find((t) => t.id === clip.trackId)
    if (!track || (track.kind !== 'audio' && track.kind !== 'video')) continue
    if (isTrackSilenced(project, track)) continue
    const speed = Math.max(0.1, clip.speed || 1)
    for (const seg of transcript.segments) {
      const s = Math.max(seg.start, clip.sourceIn)
      const e = Math.min(seg.end, clip.sourceOut)
      if (e - s <= 0) continue
      raw.push({
        start: clip.timelineStart + (s - clip.sourceIn) / speed,
        end: clip.timelineStart + (e - clip.sourceIn) / speed,
        text: seg.text,
      })
    }
  }
  raw.sort((a, b) => a.start - b.start || a.end - b.end)

  const cues: CaptionCue[] = []
  for (const cue of raw) {
    const prev = cues[cues.length - 1]
    // The same phrase from two clips of one source (e.g. linked A/V copies).
    if (prev && prev.text === cue.text && Math.abs(prev.start - cue.start) < 0.1)
      continue
    if (prev && cue.start < prev.end) prev.end = cue.start
    cues.push({ ...cue })
  }
  return cues.filter((c) => c.end - c.start >= MIN_CUE_SEC).flatMap((c) => splitCue(c))
}

/**
 * Wrap a cue to at most MAX_LINES lines; if the text is still too long, split
 * it into consecutive cues, dividing the time in proportion to their length.
 */
export function splitCue(cue: CaptionCue): CaptionCue[] {
  const words = cue.text.split(/\s+/).filter(Boolean)
  const pages: string[][] = []
  let lines: string[] = []
  let line = ''
  for (const w of words) {
    const next = line ? `${line} ${w}` : w
    if (next.length <= LINE_CHARS || !line) {
      line = next
      continue
    }
    lines.push(line)
    line = w
    if (lines.length === MAX_LINES) {
      pages.push(lines)
      lines = []
    }
  }
  if (line) lines.push(line)
  if (lines.length) pages.push(lines)
  if (pages.length <= 1) return [{ ...cue, text: (pages[0] ?? []).join('\n') }]

  const lengths = pages.map((p) => p.join(' ').length)
  const total = lengths.reduce((a, b) => a + b, 0)
  const span = cue.end - cue.start
  const out: CaptionCue[] = []
  let t = cue.start
  pages.forEach((p, i) => {
    const end = i === pages.length - 1 ? cue.end : t + (span * lengths[i]!) / total
    out.push({ start: t, end, text: p.join('\n') })
    t = end
  })
  return out
}

/** Caption look, scaled to the project height (tuned at 1080p). */
export function captionStyle(project: Project): { text: TextStyle; y: number } {
  const k = project.height / 1080
  return {
    text: {
      content: '',
      fontFamily: DEFAULT_TEXT_FONT,
      fontSize: Math.round(44 * k),
      fontWeight: 600,
      color: '#ffffff',
      background: 'rgba(0,0,0,0.62)',
      align: 'center',
      strokeColor: '#000000',
      strokeWidth: 0,
      shadow: false,
    },
    // Text is positioned from the frame center; sit near the bottom edge.
    y: Math.round(project.height / 2 - 110 * k),
  }
}

/** The captions currently on the Captions track (for .srt export). */
export function cuesFromCaptionTrack(project: Project): CaptionCue[] {
  const track = project.tracks.find((t) => t.role === 'captions')
  if (!track) return []
  const byId = new Map(project.sources.map((s) => [s.id, s]))
  return project.clips
    .filter((c) => c.trackId === track.id)
    .map((c) => ({
      start: c.timelineStart,
      end: c.timelineStart + clipDuration(c),
      text: byId.get(c.sourceId)?.text?.content ?? '',
    }))
    .filter((c) => c.text.trim() && c.end > c.start)
    .sort((a, b) => a.start - b.start)
}

function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000))
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const r = ms % 1000
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`
}

/** SubRip (.srt) text for the given cues. */
export function toSrt(cues: CaptionCue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`)
    .join('\n')
}
