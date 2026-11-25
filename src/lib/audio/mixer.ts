import type { Clip, MediaSource, Project, Track } from '../timeline/types'
import { getBlobUrl, releaseBlobUrl } from '../storage/blobCache'
import { LRUCache } from '../media/lru'
import { clipDuration, findActiveClip } from '../compositor/scene'
import { activeFade, fadeEdges, fadeGain } from '../effects/sample'
import { sampleClipProp } from '../compositor/keyframes'
import { isTrackSilenced } from '../timeline/trackState'

/**
 * Preview audio mixer: one HTMLAudioElement per audible source, routed
 * through a MediaElementAudioSourceNode + GainNode into the audio context.
 * Like the export (render.ts / audioMix.ts) it walks 'audio' AND 'video'
 * tracks, honours mute/solo, volume keyframes and Fade, and skips live
 * clips. Unlike the export it plays only the topmost clip per track, so
 * crossfades between adjacent clips are heard in the export only.
 *
 * Live (still-recording) clips are never played — the capture stream would
 * feed the mic back into the speakers.
 */

interface AudioEntry {
  el: HTMLAudioElement
  node: MediaElementAudioSourceNode
  gain: GainNode
  opfsPath: string
  url: string
}

/** Audio elements kept around (most recently used); older ones are released. */
const AUDIO_POOL_SIZE = 16

/** Stop an entry and give back its element, graph nodes and blob URL. */
function releaseEntry(e: AudioEntry): void {
  e.el.pause()
  e.el.removeAttribute('src')
  e.el.load()
  e.node.disconnect()
  e.gain.disconnect()
  releaseBlobUrl(e.opfsPath, e.url)
}

type TickArgs = { project: Project; t: number; playing: boolean }

export class AudioMixer {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  // Keyed by sourceId, or `sourceId:clipId` when one source is audible in
  // several clips at once (e.g. on an audio and a video track).
  // Bounded: keys change as clips overlap (sourceId ↔ sourceId:clipId), so
  // without a limit elements would pile up until dispose().
  private entries = new LRUCache<string, AudioEntry>(AUDIO_POOL_SIZE, (_k, e) =>
    releaseEntry(e),
  )
  // Ticks are serialized: tick() is called unawaited every frame, and two
  // overlapping ticks could each create an element for the same source (one
  // orphaned and still playing) or a stale "play" tick could finish after a
  // newer "pause" tick. Only the newest queued request runs next.
  private tickInFlight = false
  private pendingTick: TickArgs | null = null
  // Bumped by dispose() so an in-flight tick stops touching the graph.
  private generation = 0

  private getCtx(): AudioContext {
    if (this.ctx) return this.ctx
    this.ctx = new AudioContext()
    this.master = this.ctx.createGain()
    this.master.connect(this.ctx.destination)
    return this.ctx
  }

  async resume(): Promise<void> {
    const ctx = this.getCtx()
    if (ctx.state === 'suspended') await ctx.resume()
  }

  /** The AudioContext clock — monotonic, high-resolution, unaffected by rAF jitter. */
  contextTime(): number {
    return this.ctx?.currentTime ?? 0
  }

  private async ensure(
    key: string,
    opfsPath: string,
    gen: number,
  ): Promise<AudioEntry | null> {
    const existing = this.entries.get(key)
    if (existing && existing.opfsPath === opfsPath) return existing
    if (existing) this.entries.delete(key) // releases it

    const url = await getBlobUrl(opfsPath)
    if (gen !== this.generation) {
      releaseBlobUrl(opfsPath, url)
      return null // disposed while loading
    }
    const ctx = this.getCtx()
    const el = document.createElement('audio')
    el.preload = 'auto'
    el.preservesPitch = true
    el.src = url
    const node = ctx.createMediaElementSource(el)
    const gain = ctx.createGain()
    gain.gain.value = 1
    node.connect(gain).connect(this.master!)
    const entry: AudioEntry = { el, node, gain, opfsPath, url }
    this.entries.set(key, entry)
    return entry
  }

  /** Call each frame with the current playhead. Starts/stops elements as clips go in/out of scope. */
  async tick(project: Project, t: number, playing: boolean): Promise<void> {
    if (this.tickInFlight) {
      this.pendingTick = { project, t, playing }
      return
    }
    this.tickInFlight = true
    try {
      await this.tickInternal(project, t, playing, this.generation)
    } finally {
      this.tickInFlight = false
    }
    const next = this.pendingTick
    if (next) {
      this.pendingTick = null
      await this.tick(next.project, next.t, next.playing)
    }
  }

  private async tickInternal(
    project: Project,
    t: number,
    playing: boolean,
    gen: number,
  ): Promise<void> {
    // Same clip choice as the exporter: topmost clip per audible track.
    const audible: { track: Track; clip: Clip; source: MediaSource }[] = []
    for (const track of project.tracks) {
      if (track.kind !== 'audio' && track.kind !== 'video') continue
      const clip = findActiveClip(project.clips, track.id, t, false)
      if (!clip) continue
      const source = project.sources.find((s) => s.id === clip.sourceId)
      if (!source || (source.kind !== 'audio' && source.kind !== 'video')) continue
      audible.push({ track, clip, source })
    }
    const perSource = new Map<string, number>()
    for (const a of audible)
      perSource.set(a.source.id, (perSource.get(a.source.id) ?? 0) + 1)

    const active = new Set<string>()
    for (const { track, clip, source } of audible) {
      const key =
        (perSource.get(source.id) ?? 0) > 1 ? `${source.id}:${clip.id}` : source.id
      try {
        const entry = await this.ensure(key, source.opfsPath, gen)
        if (!entry || gen !== this.generation) return
        active.add(key)

        const local = (t - clip.timelineStart) * clip.speed + clip.sourceIn
        const silenced = isTrackSilenced(project, track)
        const clipLocal = t - clip.timelineStart
        const vol = sampleClipProp(clip, 'volume', clipLocal, clip.volume)
        // Fade effect (edges owned by a transition are ignored, as in export).
        const fade = fadeGain(
          activeFade(clip),
          clipLocal,
          clipDuration(clip),
          fadeEdges(project, clip.id),
        )
        const gain = (silenced ? 0 : 1) * vol * fade
        const param = entry.gain.gain
        if (playing && !entry.el.paused && this.ctx) {
          // Smooth per-frame changes (fades, keyframes) instead of stepping
          // the gain at frame rate, which would crackle.
          param.setTargetAtTime(gain, this.ctx.currentTime, 0.015)
        } else {
          param.cancelScheduledValues(0)
          param.value = gain
        }
        // Play at clip speed (pitch preserved) so sped clips don't drift and
        // get re-seeked every few frames.
        const rate = Math.max(0.0625, Math.min(16, clip.speed || 1))
        if (entry.el.playbackRate !== rate) entry.el.playbackRate = rate
        if (playing && !silenced) {
          if (Math.abs(entry.el.currentTime - local) > 0.05 * Math.max(1, rate)) {
            entry.el.currentTime = Math.max(0, local)
          }
          if (entry.el.paused) {
            try {
              await entry.el.play()
            } catch {
              /* requires user gesture */
            }
            if (gen !== this.generation) return
          }
        } else {
          if (!entry.el.paused) entry.el.pause()
          if (Math.abs(entry.el.currentTime - local) > 0.03) {
            entry.el.currentTime = Math.max(0, local)
          }
        }
      } catch {
        // Missing/unreadable audio source — skip it, keep mixing the rest.
      }
    }
    for (const [key, entry] of this.entries.entries()) {
      if (!active.has(key) && !entry.el.paused) entry.el.pause()
    }
  }

  dispose(): void {
    this.generation++
    this.pendingTick = null
    this.entries.clear() // releases every entry
    void this.ctx?.close()
    this.ctx = null
    this.master = null
  }
}
