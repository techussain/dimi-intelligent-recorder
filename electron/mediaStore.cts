/**
 * The recordings folder: real files on the user's disk.
 *
 * Access rules (the renderer is not trusted with arbitrary file access):
 *  - Writes only create NEW files inside the current recordings folder.
 *  - Reads are allowed for files inside the current (or a previously used)
 *    recordings folder, and for files the user explicitly picked/dropped
 *    (registered through `allowImport`, persisted, capped).
 *
 * Settings live in <userData>/settings.json:
 *   { mediaFolder?: string, previousMediaFolders?: string[], allowedImports?: string[] }
 */
import { app, dialog, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import { log } from './logger.cjs'

const IS_WIN = process.platform === 'win32'
const MAX_ALLOWED_IMPORTS = 5000
const MAX_PREVIOUS_FOLDERS = 20
const MAX_PATH_LEN = 4096
const MAX_SEGMENT_LEN = 120
const MAX_SEGMENTS = 8
const MAX_READ_BYTES = 16 * 1024 * 1024
const MAX_WRITE_BYTES = 64 * 1024 * 1024
const MAX_OPEN_WRITES = 32
const MAX_COLLISIONS = 999

// ── Settings ───────────────────────────────────────────────────────────────
interface Settings {
  mediaFolder?: string
  previousMediaFolders?: string[]
  allowedImports?: string[]
  [key: string]: unknown
}

let settings: Settings | null = null
let saveTimer: NodeJS.Timeout | null = null

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function loadSettings(): Settings {
  if (settings) return settings
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
    settings = typeof raw === 'object' && raw !== null ? (raw as Settings) : {}
  } catch {
    settings = {}
  }
  if (typeof settings.mediaFolder !== 'string') delete settings.mediaFolder
  settings.previousMediaFolders = stringArray(settings.previousMediaFolders)
  settings.allowedImports = stringArray(settings.allowedImports)
  return settings
}

function writeSettingsNow() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (!settings) return
  try {
    const file = settingsPath()
    const tmp = `${file}.tmp`
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2))
    fs.renameSync(tmp, file)
  } catch (err) {
    log('error', 'media', 'could not save settings.json', err)
  }
}

function saveSettingsSoon() {
  if (saveTimer) return
  saveTimer = setTimeout(writeSettingsNow, 300)
}

/** Flush pending settings (call on quit). */
export function flushSettings() {
  if (saveTimer) writeSettingsNow()
}

// ── Path helpers ───────────────────────────────────────────────────────────
function key(p: string) {
  return IS_WIN ? p.toLowerCase() : p
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function asAbsPath(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_PATH_LEN) return null
  if (v.includes('\0') || !path.isAbsolute(v)) return null
  return path.resolve(v)
}

async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await fsp.realpath(p)
  } catch {
    return p
  }
}

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g

/** Make one path segment safe on every OS. Never returns '', '.', or '..'. */
export function sanitizeSegment(raw: string, isFile: boolean): string {
  let s = raw.replace(UNSAFE_CHARS, '_').trim()
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
  if (!s) s = isFile ? 'untitled' : 'folder'
  if (RESERVED.test(s)) s = `_${s}`
  if (s.length > MAX_SEGMENT_LEN) {
    const ext = isFile ? path.extname(s).slice(0, 16) : ''
    s = s.slice(0, MAX_SEGMENT_LEN - ext.length).replace(/[.\s]+$/, '') + ext
  }
  return s
}

// ── Folder ─────────────────────────────────────────────────────────────────
function defaultFolder() {
  return path.join(app.getPath('videos'), 'Dimi Intelligent Recorder')
}

function currentFolder(): string {
  const s = loadSettings()
  const custom = s.mediaFolder ? asAbsPath(s.mediaFolder) : null
  return custom ?? defaultFolder()
}

/** Absolute path of the recordings folder, created if missing. */
export async function getFolder(): Promise<string> {
  const folder = currentFolder()
  await fsp.mkdir(folder, { recursive: true })
  return folder
}

/** Folder picker. Persists and returns the new folder, or null if canceled. */
export async function chooseFolder(
  parent: BrowserWindow | null,
): Promise<string | null> {
  const opts: Electron.OpenDialogOptions = {
    title: 'Choose Recordings Folder',
    defaultPath: currentFolder(),
    buttonLabel: 'Use This Folder',
    properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
  }
  const res = parent
    ? await dialog.showOpenDialog(parent, opts)
    : await dialog.showOpenDialog(opts)
  const picked = res.canceled ? null : asAbsPath(res.filePaths[0])
  if (!picked) return null
  await fsp.mkdir(picked, { recursive: true })

  const s = loadSettings()
  const old = currentFolder()
  if (key(old) !== key(picked)) {
    // Keep files recorded into the old folder readable by existing projects.
    const prev = (s.previousMediaFolders ?? []).filter(
      (p) => key(p) !== key(old) && key(p) !== key(picked),
    )
    prev.push(old)
    s.previousMediaFolders = prev.slice(-MAX_PREVIOUS_FOLDERS)
  }
  s.mediaFolder = picked
  writeSettingsNow()
  log('info', 'media', `recordings folder set to ${picked}`)
  return picked
}

// ── Access rule ────────────────────────────────────────────────────────────
function readRoots(): string[] {
  const s = loadSettings()
  return [currentFolder(), ...(s.previousMediaFolders ?? [])]
}

let importKeys: Set<string> | null = null
function importSet(): Set<string> {
  importKeys ??= new Set((loadSettings().allowedImports ?? []).map(key))
  return importKeys
}

/** Resolve `raw` to a readable absolute path, or null if access is denied. */
async function readablePath(raw: unknown): Promise<string | null> {
  const abs = asAbsPath(raw)
  if (!abs) return null
  if (importSet().has(key(abs))) return abs
  const roots = readRoots()
  if (!roots.some((r) => isInside(abs, r))) return null
  // Symlinks inside the folder must not lead outside it.
  const real = await realpathOrSelf(abs)
  for (const r of roots) {
    if (isInside(real, await realpathOrSelf(r))) return abs
  }
  return null
}

/** Called for a user-picked/dropped file: allow reading it back later. */
export function allowImport(raw: unknown) {
  const abs = asAbsPath(raw)
  if (!abs) return
  try {
    if (!fs.statSync(abs).isFile()) return
  } catch {
    return
  }
  const s = loadSettings()
  const k = key(abs)
  const list = (s.allowedImports ?? []).filter((p) => key(p) !== k)
  list.push(abs)
  s.allowedImports = list.slice(-MAX_ALLOWED_IMPORTS)
  importKeys = new Set(s.allowedImports.map(key))
  saveSettingsSoon()
}

// ── Reveal ─────────────────────────────────────────────────────────────────
export async function reveal(raw: unknown) {
  const file = raw === undefined || raw === null ? null : await readablePath(raw)
  if (file && fs.existsSync(file)) {
    shell.showItemInFolder(file)
    return
  }
  const folder = await getFolder()
  const err = await shell.openPath(folder)
  if (err) log('warn', 'media', `could not open recordings folder: ${err}`)
}

// ── Reads ──────────────────────────────────────────────────────────────────
export async function stat(raw: unknown): Promise<number> {
  const p = await readablePath(raw)
  if (!p) return -1
  try {
    const st = await fsp.stat(p)
    return st.isFile() ? st.size : -1
  } catch {
    return -1
  }
}

export async function read(
  raw: unknown,
  offset: unknown,
  length: unknown,
): Promise<Uint8Array> {
  if (
    typeof offset !== 'number' ||
    typeof length !== 'number' ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0
  ) {
    throw new Error('media.read: invalid offset/length')
  }
  if (length > MAX_READ_BYTES) {
    throw new Error(`media.read: length exceeds ${MAX_READ_BYTES} bytes per call`)
  }
  const p = await readablePath(raw)
  if (!p) throw new Error('media.read: access denied')
  const fh = await fsp.open(p, 'r')
  try {
    const buf = Buffer.alloc(length)
    let got = 0
    while (got < length) {
      const { bytesRead } = await fh.read(buf, got, length - got, offset + got)
      if (bytesRead === 0) break
      got += bytesRead
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, got)
  } finally {
    await fh.close()
  }
}

// ── Writes ─────────────────────────────────────────────────────────────────
interface OpenWrite {
  fh: fsp.FileHandle
  path: string
  /** Serialises appends so concurrent write() calls land in order. */
  queue: Promise<void>
}

const writes = new Map<number, OpenWrite>()
let nextWriteId = 1

async function exclusiveCreate(
  dir: string,
  name: string,
): Promise<{ fh: fsp.FileHandle; path: string }> {
  const ext = path.extname(name)
  const base = name.slice(0, name.length - ext.length)
  for (let n = 1; n <= MAX_COLLISIONS; n++) {
    const candidate = path.join(dir, n === 1 ? name : `${base} (${n})${ext}`)
    try {
      return { fh: await fsp.open(candidate, 'wx'), path: candidate }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  throw new Error('media.openWrite: too many files with this name')
}

export async function openWrite(
  relPath: unknown,
): Promise<{ id: number; path: string }> {
  if (typeof relPath !== 'string' || !relPath || relPath.length > MAX_PATH_LEN) {
    throw new Error('media.openWrite: invalid path')
  }
  if (writes.size >= MAX_OPEN_WRITES)
    throw new Error('media.openWrite: too many open files')
  const parts = relPath.split(/[\\/]+/).filter((p) => p !== '' && p !== '.')
  if (parts.length === 0 || parts.length > MAX_SEGMENTS || parts.includes('..')) {
    throw new Error('media.openWrite: invalid path')
  }
  const safe = parts.map((p, i) => sanitizeSegment(p, i === parts.length - 1))

  const folder = await getFolder()
  const target = path.resolve(folder, ...safe)
  if (!isInside(target, folder)) throw new Error('media.openWrite: path escapes folder')
  const dir = path.dirname(target)
  await makeDirsInside(folder, path.relative(folder, dir))

  const { fh, path: finalPath } = await exclusiveCreate(dir, path.basename(target))
  const id = nextWriteId++
  writes.set(id, { fh, path: finalPath, queue: Promise.resolve() })
  return { id, path: finalPath }
}

/**
 * Create `rel` (relative path) under `folder` one level at a time, checking
 * each level's real path before going deeper: a symlink or junction inside
 * the recordings folder can't make us create directories anywhere else.
 */
async function makeDirsInside(folder: string, rel: string): Promise<void> {
  await fsp.mkdir(folder, { recursive: true })
  const realFolder = await realpathOrSelf(folder)
  let current = folder
  for (const seg of rel.split(path.sep).filter((p) => p !== '')) {
    current = path.join(current, seg)
    try {
      await fsp.mkdir(current)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    const real = await realpathOrSelf(current)
    if (real !== realFolder && !isInside(real, realFolder))
      throw new Error('media.openWrite: path escapes folder')
  }
}

function getWrite(id: unknown): OpenWrite {
  const w = typeof id === 'number' ? writes.get(id) : undefined
  if (!w) throw new Error('media: unknown write id')
  return w
}

export function write(id: unknown, data: unknown): Promise<void> {
  const w = getWrite(id)
  if (!(data instanceof Uint8Array)) throw new Error('media.write: data must be bytes')
  if (data.byteLength > MAX_WRITE_BYTES) throw new Error('media.write: chunk too large')
  const bytes = data
  w.queue = w.queue.then(async () => {
    let done = 0
    while (done < bytes.byteLength) {
      const { bytesWritten } = await w.fh.write(bytes, done, bytes.byteLength - done)
      done += bytesWritten
    }
  })
  return w.queue
}

export async function closeWrite(id: unknown): Promise<void> {
  const w = getWrite(id)
  writes.delete(id as number)
  try {
    await w.queue
  } finally {
    await w.fh.close()
  }
}

export async function abortWrite(id: unknown): Promise<void> {
  const w = getWrite(id)
  writes.delete(id as number)
  await w.queue.catch(() => undefined)
  await w.fh.close().catch(() => undefined)
  await fsp.unlink(w.path).catch(() => undefined)
}

/** Close every open write (renderer gone). Partial files are kept for recovery. */
export function closeAllWrites() {
  for (const [id, w] of writes) {
    writes.delete(id)
    void w.queue
      .catch(() => undefined)
      .then(() => w.fh.close())
      .catch((err: unknown) => log('warn', 'media', `closing ${w.path} failed`, err))
    log('warn', 'media', `closed unfinished write ${w.path}`)
  }
}
