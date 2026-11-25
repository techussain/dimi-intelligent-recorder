/**
 * Media garbage collection for OPFS.
 *
 * `removeSource` never deletes files eagerly (it is undoable). Instead, media
 * removed from a project's library is recorded in a trash list, and a sweep
 * deletes a trashed file only once nothing can reach it any more:
 *   - no autosaved project references its opfsPath, and
 *   - neither the open project nor its in-memory undo/redo history does.
 *
 * Deliberately conservative: only files the user removed are ever candidates,
 * never "unknown" files found on disk, and never a file pinned because a
 * saved `.irproj` points at it (see mediaPins.ts) — the app can't see those
 * files, so it can't know whether they are still in use.
 */
import { createStore, get, set } from 'idb-keyval'
import { useEditor } from '../timeline/store'
import { listStoredProjectsRaw } from '../persistence/project'
import type { Project } from '../timeline/types'
import { deletePath, removeDirIfEmpty } from './opfs'
import { pinnedMedia } from './mediaPins'

const gcStore = createStore('intelligent-recorder-media', 'gc')
const K_TRASH = 'trash'
const STARTUP_SWEEP_DELAY_MS = 5000

async function readTrash(): Promise<string[]> {
  return (await get<string[]>(K_TRASH, gcStore)) ?? []
}

/**
 * Mark media files as no longer used by the open project (e.g. a raw
 * recording replaced by its remuxed copy). They are deleted by a later
 * sweep only if nothing references them by then.
 */
export async function trashMedia(paths: string[]): Promise<void> {
  const trash = new Set(await readTrash())
  for (const p of paths) trash.add(p)
  await set(K_TRASH, [...trash], gcStore)
}

function collectPaths(into: Set<string>, project: Partial<Project> | undefined): void {
  for (const s of project?.sources ?? []) {
    if (s && typeof s.opfsPath === 'string' && s.opfsPath) into.add(s.opfsPath)
  }
}

/** Delete trashed media nothing references any more. Returns files deleted. */
export async function sweepMedia(): Promise<number> {
  const trash = await readTrash()
  if (trash.length === 0) return 0
  const st = useEditor.getState()
  if (st.recording.active) return 0

  const refs = await pinnedMedia()
  for (const p of await listStoredProjectsRaw()) collectPaths(refs, p)
  collectPaths(refs, st.project)
  for (const e of st.past) collectPaths(refs, e.project)
  for (const e of st.future) collectPaths(refs, e.project)
  collectPaths(refs, st._interactionSnapshot?.project)

  const keep: string[] = []
  let deleted = 0
  for (const path of trash) {
    if (refs.has(path)) {
      keep.push(path)
      continue
    }
    try {
      await deletePath(path)
      deleted++
      await removeDirIfEmpty(path)
    } catch (err) {
      // Already gone → drop it from the trash; anything else → retry later.
      if ((err as DOMException)?.name !== 'NotFoundError') keep.push(path)
    }
  }
  // Merge in anything trashed while the sweep was running.
  const latest = await readTrash()
  const swept = new Set(trash)
  await set(K_TRASH, [...keep, ...latest.filter((p) => !swept.has(p))], gcStore)
  return deleted
}

/** Ask the browser not to evict OPFS/IndexedDB under storage pressure. */
async function requestPersistentStorage(): Promise<void> {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return
    await navigator.storage?.persist?.()
  } catch {
    // Not supported / denied — nothing else we can do.
  }
}

/**
 * Start tracking library removals and schedule a startup sweep.
 * Returns an uninstall function (use as a useEffect cleanup).
 */
export function installMediaGc(): () => void {
  void requestPersistentStorage()

  const unsub = useEditor.subscribe((state, prev) => {
    if (state.project.sources === prev.project.sources) return
    // Only removals *within* one project count. Switching projects replaces
    // the whole source list, and the previous project may not be autosaved
    // yet (e.g. just opened from a file) — never treat that as a removal.
    if (state.project.id !== prev.project.id) return
    const now = new Set(state.project.sources.map((s) => s.id))
    const removed = prev.project.sources
      .filter((s) => s.opfsPath && !now.has(s.id))
      .map((s) => s.opfsPath)
    if (removed.length === 0) return
    trashMedia(removed).catch((err: unknown) => {
      console.warn('[mediaGc] could not record removed media', err)
    })
  })

  const timer = window.setTimeout(() => {
    sweepMedia().catch((err: unknown) => {
      console.warn('[mediaGc] sweep failed', err)
    })
  }, STARTUP_SWEEP_DELAY_MS)

  return () => {
    unsub()
    window.clearTimeout(timer)
  }
}
