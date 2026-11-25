/**
 * Project persistence. Uses idb-keyval to autosave every project into its own
 * slot (`project:<id>`), plus a pointer to the last-open one and a
 * recent-projects list. `.irproj` files are plain JSON (media stays in OPFS
 * referenced by opfsPath) — good enough for local reload.
 */
import { get, getMany, set, setMany, del, keys, createStore } from 'idb-keyval'
import { ZodError } from 'zod'
import { ProjectSchema } from './projectSchema'
import { pinProjectMedia } from '../storage/mediaPins'
import type { Project } from '../timeline/types'

const store = createStore('intelligent-recorder', 'projects')

/** Legacy single autosave slot (full project), read only for migration. */
const K_CURRENT = 'current'
/** Id of the project that was open last. */
const K_CURRENT_ID = 'currentId'
const K_RECENT = 'recent'
const PROJECT_PREFIX = 'project:'
const projectKey = (id: string) => `${PROJECT_PREFIX}${id}`

/**
 * Current .irproj format version. v2 added clip effects and the animation /
 * element source kinds; v1 files open unchanged (all new fields optional).
 */
export const IRPROJ_VERSION = 2
/** Oldest version this build still reads. */
export const IRPROJ_MIN_VERSION = 1

export interface IrprojFile {
  format: 'irproj'
  version: number
  project: Project
}

export interface RecentEntry {
  id: string
  name: string
  updatedAt: number
}

/**
 * Autosave `project` into its own slot and mark it as the last-open project.
 * Each project keeps its slot, so starting or opening another project never
 * overwrites earlier work.
 */
export async function saveCurrentProject(project: Project): Promise<void> {
  await setMany(
    [
      [projectKey(project.id), project],
      [K_CURRENT_ID, project.id],
    ],
    store,
  )
  await bumpRecent(project)
}

/**
 * Save `project` into its slot WITHOUT marking it last-open — used to flush a
 * project that is being switched away from.
 */
export async function saveStoredProject(project: Project): Promise<void> {
  await set(projectKey(project.id), project, store)
  await bumpRecent(project)
}

/**
 * Remove an autosaved project: its slot, its recent-list entry, and the
 * last-open pointer if it pointed at it. Media files are not touched (the
 * media GC only reclaims files the user removed).
 */
export async function deleteStoredProject(id: string): Promise<void> {
  await del(projectKey(id), store)
  if ((await get<string>(K_CURRENT_ID, store)) === id) await del(K_CURRENT_ID, store)
  await updateRecent(async () => {
    const list = (await get<RecentEntry[]>(K_RECENT, store)) ?? []
    const next = list.filter((e) => e.id !== id)
    if (next.length !== list.length) await set(K_RECENT, next, store)
  })
}

/** The last-open project (validated), or null if there is none. */
export async function loadCurrentProject(): Promise<Project | null> {
  const id = await get<string>(K_CURRENT_ID, store)
  const raw = id
    ? await get<unknown>(projectKey(id), store)
    : await get<unknown>(K_CURRENT, store) // pre-migration autosave
  return raw ? validateProject(raw) : null
}

/** Load an autosaved project by id (validated), or null if it's gone. */
export async function loadStoredProject(id: string): Promise<Project | null> {
  const raw = await get<unknown>(projectKey(id), store)
  return raw ? validateProject(raw) : null
}

/**
 * Patch an autosaved project in place: `mutate` edits the loaded copy and
 * returns true if it changed anything, then it is written back. Does not
 * touch the recent list or the last-open pointer. Resolves false if the
 * project isn't stored or nothing changed. For background work (finishing a
 * recording) on a project that is no longer open.
 */
export async function updateStoredProject(
  id: string,
  mutate: (project: Project) => boolean,
): Promise<boolean> {
  const project = await loadStoredProject(id)
  if (!project || !mutate(project)) return false
  await set(projectKey(id), project, store)
  return true
}

export async function clearCurrentProject(): Promise<void> {
  await del(K_CURRENT_ID, store)
}

/**
 * Every autosaved project, unvalidated — used by the media GC to find which
 * OPFS files are still referenced. Includes the legacy single slot.
 */
export async function listStoredProjectsRaw(): Promise<Partial<Project>[]> {
  const all = await keys<IDBValidKey>(store)
  const projectKeys = all.filter(
    (k) => typeof k === 'string' && (k.startsWith(PROJECT_PREFIX) || k === K_CURRENT),
  )
  const values = await getMany<Partial<Project> | undefined>(projectKeys, store)
  return values.filter((v): v is Partial<Project> => !!v && typeof v === 'object')
}

export async function listRecent(): Promise<RecentEntry[]> {
  const r = (await get<RecentEntry[]>(K_RECENT, store)) ?? []
  return r.slice().sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Recent-list updates are read-modify-write: two at once (a project-switch
 * save and a tab-hide flush) could each read the old list and the second
 * write would drop the first one's entry. Every update runs in this queue.
 */
let recentQueue: Promise<void> = Promise.resolve()
function updateRecent(fn: () => Promise<void>): Promise<void> {
  const run = recentQueue.then(fn)
  recentQueue = run.catch(() => undefined)
  return run
}

function bumpRecent(project: Project): Promise<void> {
  return updateRecent(() => bumpRecentNow(project))
}

async function bumpRecentNow(project: Project): Promise<void> {
  const list = (await get<RecentEntry[]>(K_RECENT, store)) ?? []
  const idx = list.findIndex((e) => e.id === project.id)
  const entry: RecentEntry = {
    id: project.id,
    name: project.name,
    updatedAt: Date.now(),
  }
  if (idx >= 0) list[idx] = entry
  else list.push(entry)
  // Entries are tiny and every listed project has a stored slot, so the list
  // is not truncated (truncating would hide projects that are still saved).
  list.sort((a, b) => b.updatedAt - a.updatedAt)
  await set(K_RECENT, list, store)
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-z0-9-_ ]+/gi, '_').trim() || 'project'
}

export function serialize(project: Project): string {
  const file: IrprojFile = {
    format: 'irproj',
    version: IRPROJ_VERSION,
    project,
  }
  return JSON.stringify(file, null, 2)
}

export function parse(raw: string): Project {
  const data = JSON.parse(raw) as Partial<IrprojFile>
  if (!data || data.format !== 'irproj' || !data.project)
    throw new Error('Not an .irproj file')
  const version = data.version ?? IRPROJ_MIN_VERSION
  if (typeof version !== 'number' || version > IRPROJ_VERSION)
    throw new Error(`Unsupported .irproj version ${String(version)}`)
  return validateProject(data.project)
}

/**
 * Validate (and repair — see projectSchema) a project from any untrusted
 * source: files, bundles and autosave alike.
 */
export function validateProject(raw: unknown): Project {
  try {
    return ProjectSchema.parse(raw) as Project
  } catch (err) {
    const detail =
      err instanceof ZodError ? (err.issues[0]?.message ?? err.message) : String(err)
    throw new Error(
      `This project file is corrupted or from an incompatible version. (${detail})`,
    )
  }
}

type ShowSaveFilePicker = (opts: {
  suggestedName?: string
  types?: { description: string; accept: Record<string, string[]> }[]
}) => Promise<FileSystemFileHandle>

type ShowOpenFilePicker = (opts: {
  types?: { description: string; accept: Record<string, string[]> }[]
  multiple?: boolean
}) => Promise<FileSystemFileHandle[]>

/**
 * Returns false if the user canceled the save dialog. The media the file
 * refers to is pinned first, so the media GC never deletes it (mediaPins.ts).
 */
export async function saveProjectToFile(project: Project): Promise<boolean> {
  await pinProjectMedia(project).catch((err: unknown) => {
    console.warn('[project] could not pin media of the saved project', err)
  })
  const data = serialize(project)
  const suggestedName = `${sanitizeFilename(project.name)}.irproj`
  const picker = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker })
    .showSaveFilePicker
  if (picker) {
    try {
      const handle = await picker({
        suggestedName,
        types: [
          {
            description: 'Dimi Intelligent Recorder project',
            accept: { 'application/json': ['.irproj'] },
          },
        ],
      })
      const writable = await handle.createWritable()
      await writable.write(data)
      await writable.close()
      return true
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return false
      // fall through to download fallback
    }
  }
  const blob = new Blob([data], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = suggestedName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
  return true
}

export async function openProjectFromFile(): Promise<Project | null> {
  const picker = (window as unknown as { showOpenFilePicker?: ShowOpenFilePicker })
    .showOpenFilePicker
  if (picker) {
    try {
      const [handle] = await picker({
        types: [
          {
            description: 'Dimi Intelligent Recorder project',
            accept: { 'application/json': ['.irproj'] },
          },
        ],
      })
      const file = await handle!.getFile()
      const text = await file.text()
      return parse(text)
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return null
      throw err
    }
  }
  return await openViaInput()
}

function openViaInput(): Promise<Project | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.irproj,application/json'
    input.onchange = async () => {
      const f = input.files?.[0]
      if (!f) {
        resolve(null)
        return
      }
      try {
        const text = await f.text()
        resolve(parse(text))
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    }
    input.click()
  })
}
