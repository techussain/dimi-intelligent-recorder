#!/usr/bin/env node
/**
 * Writes build/THIRD_PARTY_NOTICES.txt: license texts for every open-source
 * package that ships inside the app.
 *
 * Included packages:
 *   1. The production dependency closure (`npm ls --all --omit=dev`), i.e. what
 *      electron-builder copies into app.asar (electron-updater and its deps).
 *   2. The transitive closure of the packages Vite bundles into dist/ (they are
 *      devDependencies because the bundle, not node_modules, ships them).
 *   3. Electron itself. Chromium's notices are referenced, not copied: they ship
 *      with every build as LICENSES.chromium.html next to the executable.
 *   4. The Whisper speech model, which the app downloads on first use.
 *
 * Deterministic (sorted by name, deduped by name@version, no timestamps) and
 * dependency-free. Usage: node scripts/generate-notices.mjs
 */
import { execFileSync, execSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'build', 'THIRD_PARTY_NOTICES.txt')

/** Packages Vite bundles into the renderer / workers (see src/). */
const BUNDLED_ROOTS = [
  'react',
  'react-dom',
  'zustand',
  'immer',
  'mediabunny',
  '@huggingface/transformers',
  'onnxruntime-web',
  'onnxruntime-common',
  'zod',
  'fflate',
  'lottie-web',
  'idb-keyval',
  'cmdk',
  'lucide-react',
  'clsx',
  '@fontsource-variable/inter',
  '@fontsource-variable/montserrat',
  '@fontsource/poppins',
  '@fontsource-variable/roboto-slab',
  '@fontsource-variable/playfair-display',
  '@fontsource/bebas-neue',
  '@fontsource-variable/jetbrains-mono',
  'electron-updater',
]

/**
 * Never shipped even though a root depends on them: Node-only backends that
 * the browser bundle doesn't import, and type-only packages.
 */
const EXCLUDE = [/^onnxruntime-node$/, /^sharp$/, /^@img\//, /^@types\//]
const isExcluded = (name) => EXCLUDE.some((re) => re.test(name))

/** Listed, but their dependencies aren't followed (Electron's are install-time only). */
const LEAVES = new Set(['electron'])

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i

// ── Helpers ─────────────────────────────────────────────────────────────────

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** Node-style resolution: <from>/node_modules/<name>, then each parent's. */
function resolvePackageDir(name, fromDir) {
  let dir = fromDir
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name)
    if (existsSync(path.join(candidate, 'package.json'))) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses.map((l) => (typeof l === 'string' ? l : l.type)).join(' OR ')
  }
  return 'UNKNOWN'
}

function repositoryOf(pkg) {
  let url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  if (!url) return pkg.homepage || ''
  url = url.replace(/^git\+/, '').replace(/\.git$/, '')
  url = url.replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://')
  if (url.startsWith('github:')) url = url.replace(/^github:/, 'https://github.com/')
  else if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`
  return url
}

function licenseTexts(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && LICENSE_FILE.test(d.name))
    .map((d) => d.name)
    .sort()
    .map((file) => ({
      file,
      text: readFileSync(path.join(dir, file), 'utf8').replace(/\r\n?/g, '\n').trim(),
    }))
}

// ── Collect ─────────────────────────────────────────────────────────────────

/** name@version → { name, version, dir, pkg } */
const found = new Map()

/** Records a package; returns its package.json, or null if already recorded. */
function add(dir) {
  const pkg = readJson(path.join(dir, 'package.json'))
  const key = `${pkg.name}@${pkg.version}`
  if (found.has(key)) return null
  found.set(key, { name: pkg.name, version: pkg.version, dir, pkg })
  return pkg
}

function walk(name, fromDir) {
  if (isExcluded(name)) return
  const dir = resolvePackageDir(name, fromDir)
  if (!dir) return // optional dependency not installed on this platform
  const pkg = add(dir)
  if (!pkg || LEAVES.has(pkg.name)) return
  const deps = { ...pkg.dependencies, ...pkg.optionalDependencies }
  for (const dep of Object.keys(deps).sort()) walk(dep, dir)
}

// 1. Production closure from npm.
function npmProdTree() {
  const args = ['ls', '--all', '--omit=dev', '--json', '--long']
  const opts = {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  }
  // Under `npm run`, npm_execpath is npm's own CLI script: run it with this
  // Node, no shell. Otherwise call `npm` (a .cmd shim on Windows, which needs
  // a shell — the arguments are fixed, so one command string is safe).
  const npmCli = process.env.npm_execpath
  const run = () =>
    npmCli && /\.c?js$/.test(npmCli)
      ? execFileSync(process.execPath, [npmCli, ...args], opts)
      : process.platform === 'win32'
        ? execSync(['npm', ...args].join(' '), opts)
        : execFileSync('npm', args, opts)
  try {
    return JSON.parse(run())
  } catch (err) {
    // npm ls exits non-zero on peer/extraneous problems but still prints the tree.
    if (err.stdout) return JSON.parse(err.stdout)
    throw err
  }
}

function collectNpm(node) {
  for (const [name, child] of Object.entries(node.dependencies ?? {})) {
    if (isExcluded(name) || !child.path) continue
    if (!existsSync(path.join(child.path, 'package.json'))) continue
    if (add(child.path)) collectNpm(child)
  }
}
collectNpm(npmProdTree())

// 2 + 3. Bundled roots and Electron.
for (const name of [...BUNDLED_ROOTS, 'electron']) {
  if (!resolvePackageDir(name, ROOT)) {
    throw new Error(`Missing package: ${name} (run npm install)`)
  }
  walk(name, ROOT)
}

// ── Write ───────────────────────────────────────────────────────────────────

const RULE = '='.repeat(78)
const entries = [...found.values()].sort((a, b) =>
  a.name === b.name ? a.version.localeCompare(b.version) : a.name < b.name ? -1 : 1,
)

const WHISPER_MIT = `MIT License

Copyright (c) 2022 OpenAI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

const out = [
  'Dimi Intelligent Recorder - Third-Party Notices',
  '',
  'Dimi Intelligent Recorder includes the open-source software listed below. Each',
  'component is provided under its own license, reproduced here. Components',
  'are sorted by name.',
  '',
  'Chromium and the other libraries built into Electron are listed separately',
  'in LICENSES.chromium.html, installed next to the application executable',
  '(on macOS: inside the app bundle, under',
  'Contents/Frameworks/Electron Framework.framework/Resources/).',
  '',
  `Components: ${String(entries.length + 1)}`,
  '',
]

for (const e of entries) {
  const license = licenseOf(e.pkg)
  const repo = repositoryOf(e.pkg)
  out.push(RULE, `${e.name} ${e.version}`, `License: ${license}`)
  if (repo) out.push(`Repository: ${repo}`)
  if (e.name === 'electron') {
    out.push('Chromium notices: see LICENSES.chromium.html (shipped with the app).')
  }
  out.push(RULE, '')
  const texts = licenseTexts(e.dir)
  if (texts.length === 0) {
    out.push(
      `(The package contains no license file. It is licensed under ${license}.)`,
      '',
    )
  }
  for (const t of texts) {
    if (texts.length > 1) out.push(`--- ${t.file} ---`, '')
    out.push(t.text, '')
  }
}

out.push(
  RULE,
  'Whisper speech model: onnx-community/whisper-base.en',
  'License: MIT',
  'Source: https://huggingface.co/onnx-community/whisper-base.en',
  'Derived from: https://github.com/openai/whisper (openai/whisper-base.en)',
  'Downloaded by the app the first time transcription is used, after the user agrees.',
  RULE,
  '',
  WHISPER_MIT,
  '',
)

mkdirSync(path.dirname(OUT), { recursive: true })
writeFileSync(OUT, out.join('\n'))
console.log(
  `Wrote ${path.relative(ROOT, OUT)}: ${String(entries.length)} packages + Whisper model`,
)
