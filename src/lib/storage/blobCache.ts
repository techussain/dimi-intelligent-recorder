import { readFile } from './opfs'

/**
 * Caches object URLs for OPFS-backed media so the same <video>/<audio> element
 * can be reused across renders without leaking blob URLs. Caller should call
 * `releaseAll` when a project is closed.
 *
 * Reference-counted — the object URL is only revoked when all callers
 * have released their interest (refcount reaches 0).
 */
const urlCache = new Map<string, string>()
const refCounts = new Map<string, number>()
/** URL creations in progress, so concurrent misses share one object URL. */
const inFlight = new Map<string, Promise<string>>()

export async function getBlobUrl(opfsPath: string): Promise<string> {
  const existing = urlCache.get(opfsPath)
  if (existing) {
    // Increment refcount on every call (new or cached).
    refCounts.set(opfsPath, (refCounts.get(opfsPath) ?? 0) + 1)
    return existing
  }
  let pending = inFlight.get(opfsPath)
  if (!pending) {
    const p: Promise<string> = readFile(opfsPath)
      .then((file) => {
        const url = URL.createObjectURL(file)
        // releaseAll ran while reading: still hand the URL out, but only
        // cache it if nothing newer took the slot (else it would leak).
        if (inFlight.get(opfsPath) === p || !urlCache.has(opfsPath)) {
          urlCache.set(opfsPath, url)
        }
        return url
      })
      .finally(() => {
        if (inFlight.get(opfsPath) === p) inFlight.delete(opfsPath)
      })
    inFlight.set(opfsPath, p)
    pending = p
  }
  const url = await pending
  refCounts.set(opfsPath, (refCounts.get(opfsPath) ?? 0) + 1)
  return url
}

/**
 * Give back one reference. With `url`, a reference to an older URL for the
 * path (from before releaseAll / refreshBlobUrl) is ignored instead of
 * decrementing — and possibly revoking — the URL that replaced it.
 */
export function releaseBlobUrl(opfsPath: string, url?: string): void {
  if (url !== undefined && urlCache.get(opfsPath) !== url) return
  const count = refCounts.get(opfsPath) ?? 0
  if (count <= 1) {
    // Last reference — revoke and clean up.
    const url = urlCache.get(opfsPath)
    if (url) URL.revokeObjectURL(url)
    urlCache.delete(opfsPath)
    refCounts.delete(opfsPath)
  } else {
    refCounts.set(opfsPath, count - 1)
  }
}

export function releaseAll(): void {
  // Revoke all URLs regardless of refcount (project is being closed).
  for (const url of urlCache.values()) URL.revokeObjectURL(url)
  urlCache.clear()
  refCounts.clear()
  inFlight.clear()
}

/**
 * Refresh the cached URL for a path (e.g. after more data was appended to a
 * recording segment). Returns the new URL.
 */
export async function refreshBlobUrl(opfsPath: string): Promise<string> {
  // Revoke and remove without decrementing refcount — the callers still hold
  // references; we're only invalidating the stale URL object.
  const stale = urlCache.get(opfsPath)
  if (stale) URL.revokeObjectURL(stale)
  urlCache.delete(opfsPath)
  // Preserve the existing refcount so future releaseBlobUrl calls balance correctly.
  const existing = refCounts.get(opfsPath) ?? 0
  const file = await readFile(opfsPath)
  const url = URL.createObjectURL(file)
  urlCache.set(opfsPath, url)
  if (existing === 0) refCounts.set(opfsPath, 1)
  return url
}
