/**
 * Auto-update via electron-updater (GitHub Releases of the public
 * repository's Releases, see package.json build.publish).
 *
 * Packaged builds only: checks 10 s after launch and every 4 h, downloads in
 * the background and installs on quit, or immediately via installAndRestart
 * (refused while a recording is running). Status is pushed to the renderer as
 * `UpdateStatus` objects (src/lib/electronAPI.ts).
 *
 * Unsigned builds never download or install anything. Without a code
 * signature the only integrity check is a hash published next to the
 * installer, so anyone able to edit the GitHub release could push code that
 * installs silently. They report `{ state: 'manual' }` instead, and the user
 * downloads the new version from the Releases page themselves. The release
 * workflow marks signed builds with `signedBuild: true` in the packaged
 * package.json (electron-builder extraMetadata).
 */
import * as fs from 'fs'
import * as path from 'path'
import { app, dialog, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { ProgressInfo, UpdateInfo } from 'electron-updater'
import { describeError, log } from './logger.cjs'

export type UpdateStatus =
  | { state: 'checking' }
  | { state: 'none' }
  | { state: 'available'; version: string }
  | { state: 'manual'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

export const UPDATE_STATUS_CHANNEL = 'updates:status'

/** Fixed — never taken from the renderer. Keep in sync with build.publish. */
const RELEASES_URL =
  'https://github.com/techussain/dimi-intelligent-recorder/releases/latest'

const FIRST_CHECK_DELAY_MS = 10_000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

interface UpdaterDeps {
  send: (status: UpdateStatus) => void
  isRecording: () => boolean
  getWindow: () => BrowserWindow | null
}

let deps: UpdaterDeps | null = null
let lastStatus: UpdateStatus | null = null
let checking = false
let lastLoggedPercent = -1
let signed = false

/** True if the release workflow signed this build (see header). */
function isSignedBuild(): boolean {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'),
    ) as { signedBuild?: unknown }
    return pkg.signedBuild === true || pkg.signedBuild === 'true'
  } catch {
    return false
  }
}

function emit(status: UpdateStatus) {
  lastStatus = status
  deps?.send(status)
}

/** Re-send the latest status (renderer reloaded / subscribed late). */
export function replayStatus() {
  if (lastStatus) deps?.send(lastStatus)
}

function shortMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : describeError(err)
  // electron-updater errors can embed whole HTTP responses.
  return (msg.split('\n')[0] ?? msg).slice(0, 300)
}

export function initUpdater(d: UpdaterDeps) {
  deps = d
  if (!app.isPackaged) {
    log('info', 'updater', 'disabled (not a packaged build)')
    return
  }
  try {
    autoUpdater.logger = {
      info: (m: unknown) => log('info', 'updater', String(m)),
      warn: (m: unknown) => log('warn', 'updater', String(m)),
      error: (m: unknown) => log('error', 'updater', String(m)),
      debug: () => undefined,
    }
    signed = isSignedBuild()
    log(
      'info',
      'updater',
      signed ? 'signed build: auto-update' : 'unsigned build: notify only',
    )
    autoUpdater.autoDownload = signed
    autoUpdater.autoInstallOnAppQuit = signed

    autoUpdater.on('checking-for-update', () => emit({ state: 'checking' }))
    autoUpdater.on('update-not-available', () => emit({ state: 'none' }))
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      log('info', 'updater', `update available: ${info.version}`)
      emit({ state: signed ? 'available' : 'manual', version: info.version })
    })
    autoUpdater.on('download-progress', (p: ProgressInfo) => {
      const percent = Math.max(0, Math.min(100, Math.round(p.percent)))
      if (percent === lastLoggedPercent) return
      lastLoggedPercent = percent
      emit({ state: 'downloading', percent })
    })
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      log('info', 'updater', `update downloaded: ${info.version}`)
      emit({ state: 'ready', version: info.version })
    })
    autoUpdater.on('error', (err: Error) => {
      log('error', 'updater', 'update error', err)
      emit({ state: 'error', message: shortMessage(err) })
    })
  } catch (err) {
    log('error', 'updater', 'init failed', err)
    return
  }

  setTimeout(() => checkNow(), FIRST_CHECK_DELAY_MS)
  setInterval(() => checkNow(), CHECK_INTERVAL_MS)
}

/** Check now. Never throws; results arrive as status events. */
export function checkNow() {
  if (!app.isPackaged) {
    emit({
      state: 'error',
      message: 'Updates are only available in the installed app, not in development.',
    })
    return
  }
  // Already downloading or downloaded: just repeat the state.
  if (lastStatus?.state === 'ready' || lastStatus?.state === 'downloading') {
    replayStatus()
    return
  }
  if (checking) return
  checking = true
  autoUpdater
    .checkForUpdates()
    .catch((err: unknown) => {
      // The 'error' event already reported it to the renderer.
      log('warn', 'updater', 'checkForUpdates failed', err)
    })
    .finally(() => {
      checking = false
    })
}

/** Open the Releases page (manual update for unsigned builds). */
export function openReleasesPage() {
  void shell.openExternal(RELEASES_URL).catch((err: unknown) => {
    log('warn', 'updater', 'could not open the releases page', err)
  })
}

/** Quit and install a downloaded update — refused while recording. */
export function installAndRestart() {
  if (!signed || lastStatus?.state !== 'ready') return
  if (deps?.isRecording()) {
    log('info', 'updater', 'install refused: recording in progress')
    const win = deps.getWindow()
    const opts: Electron.MessageBoxOptions = {
      type: 'info',
      buttons: ['OK'],
      title: 'Recording in progress',
      message: 'Stop the recording before installing the update.',
      detail: 'The update will also be installed automatically when you quit.',
    }
    void (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)).catch(
      () => undefined,
    )
    return
  }
  log('info', 'updater', 'quitAndInstall')
  setImmediate(() => {
    try {
      autoUpdater.quitAndInstall(false, true)
    } catch (err) {
      log('error', 'updater', 'quitAndInstall failed', err)
      emit({ state: 'error', message: shortMessage(err) })
    }
  })
}
