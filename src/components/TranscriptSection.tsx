import { Captions, FileText, Loader2, X } from 'lucide-react'
import { useEditor } from '../lib/timeline/store'
import type { Clip, MediaSource } from '../lib/timeline/types'
import {
  cancelTranscription,
  exportCaptionsSrt,
  generateCaptions,
  ensureModelConsent,
  transcribeSource,
  useTranscription,
  type TranscribeStage,
} from '../lib/transcribe/transcriber'
import { useToast } from './ui/Toast'

const STAGE_LABEL: Record<TranscribeStage, string> = {
  download: 'Loading speech model',
  decode: 'Reading audio',
  transcribe: 'Transcribing',
}

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Inspector section: transcribe the clip's media on-device, show the
 * transcript (click a line to jump there), and turn it into captions / .srt.
 */
export function TranscriptSection({
  clip,
  source,
}: {
  clip: Clip
  source: MediaSource
}) {
  const transcript = useEditor((s) => s.project.transcripts?.[source.id])
  const job = useTranscription((s) => s.job)
  const toast = useToast()
  const mine = job?.sourceId === source.id
  const busyElsewhere = !!job && !mine

  function start(): void {
    if (!ensureModelConsent()) return
    transcribeSource(source.id)
      .then((n) =>
        toast.success(
          'Transcript ready',
          n > 0
            ? `${n} segments — add them as captions below.`
            : 'No speech was detected.',
        ),
      )
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg === 'Transcription canceled.') toast.info('Transcription canceled')
        else toast.error('Transcription failed', msg)
      })
  }

  function captions(): void {
    try {
      const n = generateCaptions()
      toast.success(
        'Captions added',
        `${n} captions on the Captions track (one undo step).`,
      )
    } catch (err) {
      toast.error('No captions', err instanceof Error ? err.message : String(err))
    }
  }

  function srt(): void {
    try {
      exportCaptionsSrt()
    } catch (err) {
      toast.error('Export failed', err instanceof Error ? err.message : String(err))
    }
  }

  /** Timeline time of a source time within this clip, or null if trimmed out. */
  function timelineTime(sourceTime: number): number | null {
    if (sourceTime < clip.sourceIn || sourceTime > clip.sourceOut) return null
    return (
      clip.timelineStart + (sourceTime - clip.sourceIn) / Math.max(0.1, clip.speed || 1)
    )
  }

  return (
    <div className="space-y-2">
      <div className="text-[10px] uppercase tracking-[0.08em] text-muted font-semibold">
        Transcript
      </div>

      {mine && job ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px]">
            <span className="flex items-center gap-1.5 text-fg/90">
              <Loader2 size={12} className="animate-spin" />
              {STAGE_LABEL[job.stage]}… {Math.round(job.progress * 100)}%
            </span>
            <button
              onClick={cancelTranscription}
              className="btn-ghost !py-0.5 !px-1.5"
              title="Cancel transcription"
            >
              <X size={12} /> Cancel
            </button>
          </div>
          <div
            className="h-1 rounded-full bg-bd overflow-hidden"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(job.progress * 100)}
            aria-label={STAGE_LABEL[job.stage]}
          >
            <div
              className="h-full bg-accent transition-[width] duration-200"
              style={{ width: `${job.progress * 100}%` }}
            />
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={start}
            disabled={busyElsewhere}
            className="btn-soft !py-1 disabled:opacity-40 disabled:cursor-not-allowed"
            title={
              busyElsewhere
                ? 'Another transcription is running'
                : 'Speech-to-text on this computer (English)'
            }
          >
            <FileText size={12} /> {transcript ? 'Re-transcribe' : 'Transcribe'}
          </button>
          {transcript && transcript.segments.length > 0 && (
            <>
              <button
                onClick={captions}
                className="btn-soft !py-1"
                title="Create or refresh the Captions track from all transcripts"
              >
                <Captions size={12} /> Generate captions
              </button>
              <button
                onClick={srt}
                className="btn-ghost !py-1"
                title="Download captions as .srt"
              >
                .srt
              </button>
            </>
          )}
        </div>
      )}

      {transcript &&
        !mine &&
        (transcript.segments.length === 0 ? (
          <p className="text-[11px] text-muted">No speech detected.</p>
        ) : (
          <ol className="max-h-48 overflow-auto rounded-md border border-bd divide-y divide-bd">
            {transcript.segments.map((seg, i) => {
              const at = timelineTime(seg.start)
              return (
                <li key={i}>
                  <button
                    disabled={at === null}
                    onClick={() => at !== null && useEditor.getState().setPlayhead(at)}
                    className="w-full text-left px-2 py-1.5 flex gap-2 hover:bg-white/5
                      disabled:opacity-40 disabled:cursor-default"
                    title={
                      at === null ? 'Trimmed out of this clip' : 'Jump to this line'
                    }
                  >
                    <span className="font-mono text-[10px] text-muted pt-px shrink-0">
                      {fmt(seg.start)}
                    </span>
                    <span className="text-[11px] leading-snug">{seg.text}</span>
                  </button>
                </li>
              )
            })}
          </ol>
        ))}
    </div>
  )
}
