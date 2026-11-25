/**
 * The media GC deletes trashed files nothing references — but never a file a
 * saved .irproj points at (pinned), since the app can't see those files.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Project } from '../../timeline/types'

const idb = vi.hoisted(() => new Map<unknown, unknown>())
vi.mock('idb-keyval', () => ({
  createStore: () => ({}),
  get: (k: unknown) => Promise.resolve(idb.get(k)),
  set: (k: unknown, v: unknown) => Promise.resolve(void idb.set(k, v)),
  update: (k: unknown, fn: (old: unknown) => unknown) =>
    Promise.resolve(void idb.set(k, fn(idb.get(k)))),
}))
const deleted = vi.hoisted(() => [] as string[])
vi.mock('../opfs', () => ({
  deletePath: (p: string) => Promise.resolve(void deleted.push(p)),
  removeDirIfEmpty: () => Promise.resolve(),
}))
vi.mock('../../persistence/project', () => ({
  listStoredProjectsRaw: () => Promise.resolve([]),
}))
vi.mock('../blobCache', () => ({ releaseAll: () => {} }))

import { sweepMedia, trashMedia } from '../mediaGc'
import { pinProjectMedia } from '../mediaPins'
import { useEditor } from '../../timeline/store'

describe('media GC and .irproj pins', () => {
  beforeEach(() => {
    idb.clear()
    deleted.length = 0
    useEditor.getState().newProject()
  })

  it('keeps trashed media a saved .irproj refers to, deletes the rest', async () => {
    await pinProjectMedia({
      sources: [{ opfsPath: 'imports/kept.mp4' }, { opfsPath: '' }],
    } as unknown as Project)
    await trashMedia(['imports/kept.mp4', 'imports/gone.mp4'])

    expect(await sweepMedia()).toBe(1)
    expect(deleted).toEqual(['imports/gone.mp4'])
    // The pinned file stays in the trash; a later sweep still won't delete it.
    expect(await sweepMedia()).toBe(0)
    expect(deleted).toEqual(['imports/gone.mp4'])
  })
})
