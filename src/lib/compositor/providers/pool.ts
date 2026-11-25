/**
 * Frame providers for `animation` sources (Lottie, animated GIF / WebP /
 * APNG / AVIF), keyed like the video pool by `SceneLayer.key`: a provider
 * may hand out one shared canvas per instance, so two layers showing the
 * same asset at different times each need their own.
 *
 * Loading is lazy (first `get` / `load`), and every provider the pool
 * created is disposed on eviction, source change or `dispose()`.
 */
import type { Clip, MediaSource } from '../../timeline/types'
import type { FrameProvider } from './types'

export type ProviderFactory = (source: MediaSource) => Promise<FrameProvider>

interface Entry {
  sourceId: string
  opfsPath: string
  promise: Promise<FrameProvider | null>
  provider: FrameProvider | null
  failed: boolean
  disposed: boolean
  unsubscribe: (() => void) | null
  lastUsed: number
}

/** Time / loop flag to ask a provider for, for a clip showing `sourceTime`. */
export function animationFrameTime(
  clip: Pick<Clip, 'loop'>,
  sourceTime: number,
): { t: number; loop: boolean } {
  return {
    t: Math.max(0, Number.isFinite(sourceTime) ? sourceTime : 0),
    loop: !!clip.loop,
  }
}

export class ProviderPool {
  private entries = new Map<string, Entry>()
  private clock = 0

  /**
   * @param factory creates a provider for a source (reads its file).
   * @param onUpdate called when a provider becomes ready or a frame it was
   *   missing lands — the preview re-renders then (no polling).
   */
  private readonly factory: ProviderFactory
  private readonly onUpdate: (() => void) | undefined

  constructor(factory: ProviderFactory, onUpdate?: () => void) {
    this.factory = factory
    this.onUpdate = onUpdate
  }

  private entryFor(key: string, source: MediaSource): Entry {
    const existing = this.entries.get(key)
    if (
      existing &&
      existing.sourceId === source.id &&
      existing.opfsPath === source.opfsPath
    ) {
      existing.lastUsed = ++this.clock
      return existing
    }
    if (existing) this.release(key, existing)
    const entry: Entry = {
      sourceId: source.id,
      opfsPath: source.opfsPath,
      provider: null,
      failed: false,
      disposed: false,
      unsubscribe: null,
      lastUsed: ++this.clock,
      promise: Promise.resolve(null),
    }
    entry.promise = this.factory(source).then(
      (provider) => {
        if (entry.disposed) {
          provider.dispose()
          return null
        }
        entry.provider = provider
        if (this.onUpdate) {
          const notify = this.onUpdate
          entry.unsubscribe = provider.subscribe(() => {
            if (!entry.disposed) notify()
          })
          provider.ready.then(
            () => {
              if (!entry.disposed) notify()
            },
            () => {},
          )
          notify()
        }
        return provider
      },
      () => {
        entry.failed = true
        return null
      },
    )
    this.entries.set(key, entry)
    return entry
  }

  /** The provider for this layer if it is loaded (starts loading otherwise). */
  get(key: string, source: MediaSource): FrameProvider | null {
    return this.entryFor(key, source).provider
  }

  /** True when this key's provider failed to load (don't wait for it). */
  failed(key: string): boolean {
    return this.entries.get(key)?.failed ?? false
  }

  /** Await the provider (export). Null when the asset can't be loaded. */
  load(key: string, source: MediaSource): Promise<FrameProvider | null> {
    return this.entryFor(key, source).promise
  }

  /**
   * Dispose providers whose key isn't in `active`, keeping up to `maxIdle`
   * of the most recently used idle ones (scrubbing back stays instant).
   */
  retain(active: ReadonlySet<string>, maxIdle = 0): void {
    const idle = [...this.entries.entries()]
      .filter(([k]) => !active.has(k))
      .sort((a, b) => b[1].lastUsed - a[1].lastUsed)
    for (const [k, e] of idle.slice(maxIdle)) this.release(k, e)
  }

  get size(): number {
    return this.entries.size
  }

  private release(key: string, entry: Entry): void {
    entry.disposed = true
    entry.unsubscribe?.()
    entry.unsubscribe = null
    entry.provider?.dispose()
    entry.provider = null
    this.entries.delete(key)
  }

  dispose(): void {
    for (const [k, e] of [...this.entries.entries()]) this.release(k, e)
  }
}
