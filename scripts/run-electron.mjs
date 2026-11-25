/**
 * Launch Electron for development.
 *
 * VS Code's integrated terminal (and some other tools) export
 * ELECTRON_RUN_AS_NODE=1, which makes Electron run as plain Node: no window,
 * and `require('electron')` returns a path instead of the API. Remove it
 * before spawning so `npm run dev:electron` works from any terminal.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electron = require('electron') // resolves to the Electron binary path

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electron, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
})
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
