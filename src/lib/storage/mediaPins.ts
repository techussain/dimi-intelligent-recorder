/**
 * Media files referenced by a project saved as `.irproj`.
 *
 * An `.irproj` refers to media in the app's private storage (OPFS) by path,
 * and lives wherever the user saved it, so the app can't tell whether it
 * still exists. Every media file a saved `.irproj` points at is therefore
 * pinned: the media GC (mediaGc.ts) never deletes a pinned file, even after
 * it was removed from every project the app knows about. This trades some
 * disk space for never breaking a project file the user kept.
 *
 * Kept separate from mediaGc.ts so persistence can use it without an import
 * cycle.
 */
import { createStore, get, update } from 'idb-keyval'
import type { Project } from '../timeline/types'

const pinStore = createStore('intelligent-recorder-media-pins', 'pins')
const K_PINNED = 'pinned'

/** Pin every media file `project` references. */
export async function pinProjectMedia(project: Project): Promise<void> {
  const paths = project.sources.map((s) => s.opfsPath).filter((p) => !!p)
  if (paths.length === 0) return
  await update<string[]>(
    K_PINNED,
    (old) => {
      const all = new Set(old ?? [])
      for (const p of paths) all.add(p)
      return [...all]
    },
    pinStore,
  )
}

/** Every pinned media path. */
export async function pinnedMedia(): Promise<Set<string>> {
  return new Set((await get<string[]>(K_PINNED, pinStore)) ?? [])
}
