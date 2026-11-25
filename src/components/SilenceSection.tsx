import { useEffect, useMemo, useState } from 'react'
import { Loader2, Scissors, X } from 'lucide-react'
import type { Clip, MediaSource } from '../lib/timeline/types'
import {
  analyzeSource,
  cancelAnalysis,
  getCachedEnvelope,
  pausesForClip,
  removePauses,
  useSilenceJob,
} from '../lib/silence/analyze'
import {
  DEFAULT_MIN_SILENCE_SEC,
  DEFAULT_PADDING_SEC,
  autoThreshold,
  type Envelope,
} from '../lib/silence/detect'
import { useToast } from './ui/Toast'

function secs(v: number): string {
  return v >= 60 ? `${Math.floor(v / 60)}m ${Math.round(v % 60)}s` : `${v.toFixed(1)}s`
}

/**
 * Inspector section: find pauses in this clip's audio and cut them from the
 * whole timeline (every track, so everything stays in sync).
 */
export function SilenceSection({ clip, source }: { clip: Clip; source: MediaSource }) {
  const toast = useToast()
  const job = useSilenceJob((s) => s.job)
  const mine = job?.sourceId === source.id
  const [env, setEnv] = useState<Envelope | undefined>(() =>
    getCachedEnvelope(source.opfsPath),
  )
  const [threshold, setThreshold] = useState(() => (env ? autoThreshold(env.db) : -45))
  const [minPause, setMinPause] = useState(DEFAULT_MIN_SILENCE_SEC)
  const [padding, setPadding] = useState(DEFAULT_PADDING_SEC)

  // Another clip of a different file selected in this card slot: reset.
  useEffect(() => {
    const cached = getCachedEnvelope(source.opfsPath)
    setEnv(cached)
    if (cached) setThreshold(autoThreshold(cached.db))
  }, [source.opfsPath])

  const pauses = useMemo(
    () =>
      env
        ? pausesForClip(clip, env, {
            thresholdDb: threshold,
            minSilenceSec: minPause,
            paddingSec: padding,
          })
        : [],
    [clip, env, threshold, minPause, padding],
  )
  const total = pauses.reduce((s, r) => s + (r.end - r.start), 0)
  const clipDur = (clip.sourceOut - clip.sourceIn) / Math.max(0.1, clip.speed || 1)

  function find(): void {
    analyzeSource(source.id, source.opfsPath)
      .then((e) => {
        setEnv(e)
        setThreshold(autoThreshold(e.db))
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg !== 'Analysis canceled.') toast.error("Couldn't analyze audio", msg)
      })
  }

  function remove(): void {
    try {
      const r = removePauses(pauses)
      toast.success(
        `Removed ${r.count} ${r.count === 1 ? 'pause' : 'pauses'} (${secs(r.removedSec)})`,
        'Cut from every track to stay in sync. Undo restores them.',
      )
    } catch (err) {
      toast.error(
        "Couldn't remove pauses",
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  return (
    <div className="space-y-2">
      <div className="text-[10px] uppercase tracking-[0.08em] text-muted font-semibold">
        Silence
      </div>

      {mine && job ? (
        <div className="flex items-center justify-between text-[11px]">
          <span className="flex items-center gap-1.5">
            <Loader2 size={12} className="animate-spin" />
            Analyzing audio… {Math.round(job.progress * 100)}%
          </span>
          <button onClick={cancelAnalysis} className="btn-ghost !py-0.5 !px-1.5">
            <X size={12} /> Cancel
          </button>
        </div>
      ) : !env ? (
        <button
          onClick={find}
          disabled={!!job}
          className="btn-soft !py-1 disabled:opacity-40 disabled:cursor-not-allowed"
          title="Find pauses in this clip's audio"
        >
          <Scissors size={12} /> Find pauses
        </button>
      ) : (
        <div className="space-y-2">
          <p className="text-[11px]">
            {pauses.length === 0
              ? 'No pauses with these settings.'
              : `${pauses.length} ${pauses.length === 1 ? 'pause' : 'pauses'} · ${secs(total)} of ${secs(clipDur)}`}
          </p>
          <Range
            label="Silence level"
            value={threshold}
            min={-70}
            max={-20}
            step={1}
            format={(v) => `${v} dB`}
            hint="Quieter than this counts as silence"
            onChange={setThreshold}
          />
          <Range
            label="Shortest pause"
            value={minPause}
            min={0.3}
            max={3}
            step={0.1}
            format={(v) => `${v.toFixed(1)}s`}
            hint="Shorter pauses are kept"
            onChange={setMinPause}
          />
          <Range
            label="Keep around speech"
            value={padding}
            min={0}
            max={0.5}
            step={0.05}
            format={(v) => `${v.toFixed(2)}s`}
            hint="Silence left before/after words so they aren't clipped"
            onChange={setPadding}
          />
          <button
            onClick={remove}
            disabled={pauses.length === 0 || !!clip.isLive}
            className="btn-soft !py-1 w-full justify-center disabled:opacity-40 disabled:cursor-not-allowed"
            title="Cut these pauses from every track (one undo step)"
          >
            <Scissors size={12} /> Remove {pauses.length || ''} pauses
            {pauses.length > 0 ? ` (−${secs(total)})` : ''}
          </button>
          <p className="text-[10px] text-muted leading-snug">
            Pauses are cut from every track at once so video, audio and captions stay in
            sync.
          </p>
        </div>
      )}
    </div>
  )
}

function Range({
  label,
  value,
  min,
  max,
  step,
  format,
  hint,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  hint: string
  onChange: (v: number) => void
}) {
  return (
    <label className="block space-y-1" title={hint}>
      <span className="flex justify-between text-[11px]">
        <span className="text-muted">{label}</span>
        <span className="font-mono">{format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-accent"
      />
    </label>
  )
}
