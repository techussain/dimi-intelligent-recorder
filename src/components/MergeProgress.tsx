import { useCallback } from 'react'
import { Loader2, X } from 'lucide-react'
import { cancelMerge, mergeClips, useMergeJob } from '../lib/edit/mergeClips'
import { useEditor } from '../lib/timeline/store'
import type { ID } from '../lib/timeline/types'
import { ensureModelConsent, transcribeSource } from '../lib/transcribe/transcriber'
import { useToast } from './ui/Toast'

/**
 * Merge the given clips (default: the selection) with toasts for the outcome.
 * On success the toast offers to transcribe the merged clip right away.
 */
export function useMergeClips(): (ids?: ID[]) => void {
  const toast = useToast()
  return useCallback(
    (ids?: ID[]) => {
      const st = useEditor.getState()
      const targets = ids ?? st.selection
      const count = targets.length
      mergeClips(targets)
        .then((clipId) => {
          const clip = useEditor.getState().project.clips.find((c) => c.id === clipId)
          toast.withAction(
            'Clips merged',
            {
              label: 'Transcribe',
              onClick: () => {
                if (!clip || !ensureModelConsent()) return
                transcribeSource(clip.sourceId)
                  .then((n) => toast.success('Transcript ready', `${n} segments`))
                  .catch((err: unknown) => {
                    const msg = err instanceof Error ? err.message : String(err)
                    if (msg !== 'Transcription canceled.')
                      toast.error('Transcription failed', msg)
                  })
              },
            },
            `${count} clips are now one clip. Undo restores them.`,
          )
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err)
          if (msg === 'Merge canceled.') toast.info('Merge canceled')
          else toast.error("Couldn't merge clips", msg)
        })
    },
    [toast],
  )
}

/** Floating progress card while a merge renders. */
export function MergeProgress() {
  const job = useMergeJob((s) => s.job)
  if (!job) return null
  const pct = Math.round(job.progress * 100)
  return (
    <div
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-80 panel shadow-pop p-3 space-y-2 text-xs"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" />
          Merging {job.clipCount} clips — {job.label}… {pct}%
        </span>
        <button
          onClick={cancelMerge}
          className="btn-ghost !py-0.5 !px-1.5"
          title="Cancel merge"
        >
          <X size={12} /> Cancel
        </button>
      </div>
      <div className="h-1 rounded-full bg-bd overflow-hidden">
        <div
          className="h-full bg-accent transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
