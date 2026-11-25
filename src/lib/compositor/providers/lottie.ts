/**
 * Lottie (Bodymovin) animations: `.json` and `.lottie` (dotLottie zip).
 *
 * Rendered with lottie-web's *light canvas* build, which has no expression
 * engine — so it needs no `eval` / `new Function` and runs under the app's
 * CSP. Files that use After Effects expressions still play, but the
 * expression-driven properties keep their static values (import warns).
 *
 * External image URLs are never fetched: images are taken from the
 * dotLottie zip or from inline data URLs; anything else is replaced by a
 * transparent pixel.
 */
import { strFromU8, unzipSync } from 'fflate'
import { readBlobBytes } from './readBlob'
import type { FrameProvider } from './types'

// ── Limits ──────────────────────────────────────────────────────────────────

export const MAX_LOTTIE_JSON_BYTES = 20 * 1024 * 1024
export const MAX_DOTLOTTIE_TOTAL_BYTES = 100 * 1024 * 1024
export const DEFAULT_RENDER_SCALE = 2
export const DEFAULT_MAX_RENDER_SIZE = 2048
const LOAD_TIMEOUT_MS = 20_000
const MB = 1024 * 1024

/** 1×1 transparent PNG, stands in for images we won't load. */
export const TRANSPARENT_PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

export class LottieFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LottieFileError'
  }
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface LottieJson {
  v: string
  fr: number
  ip: number
  op: number
  w: number
  h: number
  layers: unknown[]
  assets?: unknown[]
  [key: string]: unknown
}

export interface LottieInfo {
  /** Sanitized animation data, ready for `createLottieProvider`. */
  json: LottieJson
  width: number
  height: number
  fps: number
  frameCount: number
  /** Seconds. */
  duration: number
  usesExpressions: boolean
  usesLayerEffects: boolean
  /** External (URL / relative path) images were replaced by blanks. */
  hasExternalAssets: boolean
}

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

/** Structural check for a Bodymovin document. */
export function isLottieJson(x: unknown): x is LottieJson {
  if (!isObj(x)) return false
  return (
    typeof x.v === 'string' &&
    isNum(x.fr) &&
    x.fr > 0 &&
    isNum(x.ip) &&
    isNum(x.op) &&
    x.op > x.ip &&
    isNum(x.w) &&
    x.w > 0 &&
    isNum(x.h) &&
    x.h > 0 &&
    Array.isArray(x.layers)
  )
}

/** Why `isLottieJson` failed, for error messages. */
function lottieProblem(x: unknown): string {
  if (!isObj(x)) return 'the file is not a JSON object'
  const missing = ['v', 'fr', 'ip', 'op', 'w', 'h', 'layers'].filter((k) => !(k in x))
  if (missing.length) return `missing ${missing.join(', ')}`
  return 'its size, frame rate or frame range is invalid'
}

/** Every layer list in the document (root + precomp assets). */
function layerLists(json: LottieJson): unknown[][] {
  const lists: unknown[][] = [json.layers]
  for (const a of json.assets ?? []) {
    if (isObj(a) && Array.isArray(a.layers)) lists.push(a.layers)
  }
  return lists
}

/**
 * Feature scan: expressions are strings in an animatable property's `x`
 * field (`{ a, k, x: "wiggle(2, 10)" }`); layer effects are a non-empty `ef`.
 */
export function analyzeLottie(json: LottieJson): {
  usesExpressions: boolean
  usesLayerEffects: boolean
} {
  let usesLayerEffects = false
  for (const list of layerLists(json)) {
    for (const layer of list) {
      if (isObj(layer) && Array.isArray(layer.ef) && layer.ef.length > 0) {
        usesLayerEffects = true
      }
    }
  }
  let usesExpressions = false
  const stack: unknown[] = [json.layers, json.assets]
  while (stack.length && !usesExpressions) {
    const node = stack.pop()
    if (Array.isArray(node)) {
      for (const c of node) if (typeof c === 'object' && c !== null) stack.push(c)
    } else if (isObj(node)) {
      if (
        typeof node.x === 'string' &&
        node.x.trim() !== '' &&
        ('k' in node || 'a' in node)
      ) {
        usesExpressions = true
        break
      }
      for (const c of Object.values(node))
        if (typeof c === 'object' && c !== null) stack.push(c)
    }
  }
  return { usesExpressions, usesLayerEffects }
}

/** An image asset (not a precomp, not audio/data). */
function isImageAsset(a: unknown): a is Obj & { p: string } {
  return isObj(a) && typeof a.p === 'string' && !Array.isArray(a.layers) && a.t !== 3
}

/**
 * Rewrite image assets in place so lottie never fetches anything: data URLs
 * stay, `resolve(asset)` may supply an inline replacement (dotLottie images),
 * everything else becomes a transparent pixel. Returns whether any asset had
 * to be blanked.
 */
export function sanitizeLottieAssets(
  json: LottieJson,
  resolve?: (path: string, dir: string) => string | null,
): boolean {
  let blanked = false
  for (const a of json.assets ?? []) {
    if (!isImageAsset(a)) continue
    const dir = typeof a.u === 'string' ? a.u : ''
    let src: string | null = null
    if (a.p.startsWith('data:')) src = a.p
    // Relative paths may resolve inside a dotLottie; URLs (http:, file:, …) never load.
    else if (!/^[a-z][a-z0-9+.-]*:/i.test(a.p)) src = resolve?.(a.p, dir) ?? null
    if (src === null) {
      blanked = true
      src = TRANSPARENT_PIXEL
    }
    a.p = src
    a.u = ''
    a.e = 1
  }
  return blanked
}

/** Number of renderable frames, as lottie-web computes it. */
export function lottieFrameCount(json: Pick<LottieJson, 'ip' | 'op'>): number {
  return Math.max(1, Math.floor(json.op - json.ip))
}

/**
 * Time (s from the animation's start) → frame offset from `ip`, the value
 * `goToAndStop(frame, true)` expects. Looping wraps; otherwise holds the
 * first / last frame. Never reaches `op` (exclusive end).
 */
export function lottieFrameAt(
  t: number,
  meta: Pick<LottieJson, 'ip' | 'op' | 'fr'>,
  loop: boolean,
): number {
  const total = lottieFrameCount(meta)
  const last = total - 1
  const duration = total / meta.fr
  let local = Number.isFinite(t) ? t : 0
  if (loop && duration > 0) {
    local %= duration
    if (local < 0) local += duration
  }
  const frame = local * meta.fr
  return Math.min(last, Math.max(0, frame))
}

/** Backing-canvas size: intrinsic × scale, longest side capped. */
export function lottieRenderSize(
  width: number,
  height: number,
  scale = DEFAULT_RENDER_SCALE,
  maxSize = DEFAULT_MAX_RENDER_SIZE,
): { width: number; height: number } {
  const longest = Math.max(width, height, 1)
  const s = Math.min(Math.max(scale, 0.01), maxSize / longest)
  return {
    width: Math.max(1, Math.round(width * s)),
    height: Math.max(1, Math.round(height * s)),
  }
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  svg: 'image/svg+xml',
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

function toDataUrl(name: string, bytes: Uint8Array): string | null {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  const mime = IMAGE_MIME[ext]
  return mime ? `data:${mime};base64,${bytesToBase64(bytes)}` : null
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new LottieFileError(
      "This file isn't valid JSON, so it can't be a Lottie animation.",
    )
  }
}

const tooBig = (what: string, cap: number) =>
  new LottieFileError(
    `${what} is larger than the ${cap / MB} MB limit for Lottie animations.`,
  )

/** Normalized zip path (no leading "./" or "/", forward slashes). */
const normPath = (p: string) => p.replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '')

/**
 * Unpack a dotLottie archive (v1: `animations/`, `images/`; v2: `a/`, `i/`).
 * Picks the manifest's active / initial animation, else the first one, and
 * inlines its images. Enforces the size caps before inflating anything.
 */
export function unpackDotLottie(zip: Uint8Array): {
  json: unknown
  hasExternalAssets: boolean
} {
  if (zip.length > MAX_DOTLOTTIE_TOTAL_BYTES)
    throw tooBig('The .lottie file', MAX_DOTLOTTIE_TOTAL_BYTES)
  const entries = new Map<string, number>()
  try {
    // Pass 1: read the directory only (filter declines every entry).
    unzipSync(zip, {
      filter: (f) => {
        entries.set(normPath(f.name), f.originalSize)
        return false
      },
    })
  } catch {
    throw new LottieFileError(
      "This .lottie file is damaged (it isn't a readable zip archive).",
    )
  }
  let total = 0
  for (const size of entries.values()) total += size
  if (total > MAX_DOTLOTTIE_TOTAL_BYTES) {
    throw tooBig('The unpacked .lottie content', MAX_DOTLOTTIE_TOTAL_BYTES)
  }

  const readOne = (name: string): Uint8Array | null => {
    if (!entries.has(name)) return null
    const out = unzipSync(zip, { filter: (f) => normPath(f.name) === name })
    for (const [k, v] of Object.entries(out)) if (normPath(k) === name) return v
    return null
  }

  // Which animation?
  let id: string | null = null
  const manifestBytes = readOne('manifest.json')
  if (manifestBytes) {
    let manifest: unknown = null
    try {
      manifest = JSON.parse(strFromU8(manifestBytes)) as unknown
    } catch {
      manifest = null
    }
    if (isObj(manifest)) {
      const anims = Array.isArray(manifest.animations) ? manifest.animations : []
      const ids = anims.flatMap((a) =>
        isObj(a) && typeof a.id === 'string' ? [a.id] : [],
      )
      const initial = isObj(manifest.initial) ? manifest.initial.animation : undefined
      const active = manifest.activeAnimationId
      if (typeof active === 'string' && ids.includes(active)) id = active
      else if (typeof initial === 'string' && ids.includes(initial)) id = initial
      else id = ids[0] ?? null
    }
  }
  const animPaths = [...entries.keys()].filter((n) =>
    /^(animations|a)\/[^/]+\.json$/i.test(n),
  )
  let animPath: string | undefined
  if (id !== null)
    animPath = [`animations/${id}.json`, `a/${id}.json`].find((p) => entries.has(p))
  animPath ??= animPaths.sort()[0]
  if (!animPath) throw new LottieFileError('This .lottie file contains no animation.')
  if ((entries.get(animPath) ?? 0) > MAX_LOTTIE_JSON_BYTES) {
    throw tooBig('The animation data', MAX_LOTTIE_JSON_BYTES)
  }
  const animBytes = readOne(animPath)
  if (!animBytes) throw new LottieFileError('This .lottie file contains no animation.')
  if (animBytes.length > MAX_LOTTIE_JSON_BYTES)
    throw tooBig('The animation data', MAX_LOTTIE_JSON_BYTES)
  const json = parseJsonText(strFromU8(animBytes))
  if (!isLottieJson(json)) {
    throw new LottieFileError(
      `The animation inside this .lottie file isn't valid Lottie data (${lottieProblem(json)}).`,
    )
  }

  // Inline images that the animation references.
  const wanted = new Set<string>()
  const candidates = (p: string, dir: string): string[] => {
    const file = normPath(p)
    const base = file.slice(file.lastIndexOf('/') + 1)
    return [normPath(dir + p), file, `images/${base}`, `i/${base}`]
  }
  for (const a of json.assets ?? []) {
    if (!isImageAsset(a) || a.p.startsWith('data:')) continue
    const found = candidates(a.p, typeof a.u === 'string' ? a.u : '').find((c) =>
      entries.has(c),
    )
    if (found) wanted.add(found)
  }
  const images: Record<string, Uint8Array> =
    wanted.size > 0
      ? unzipSync(zip, { filter: (f) => wanted.has(normPath(f.name)) })
      : {}
  const byName = new Map<string, Uint8Array>()
  let actual = animBytes.length
  for (const [k, v] of Object.entries(images)) {
    byName.set(normPath(k), v)
    actual += v.length
  }
  // Declared sizes can lie; check what was actually inflated.
  if (actual > MAX_DOTLOTTIE_TOTAL_BYTES) {
    throw tooBig('The unpacked .lottie content', MAX_DOTLOTTIE_TOTAL_BYTES)
  }
  const hasExternalAssets = sanitizeLottieAssets(json, (p, dir) => {
    const found = candidates(p, dir).find((c) => byName.has(c))
    const bytes = found ? byName.get(found) : undefined
    return found && bytes ? toDataUrl(found, bytes) : null
  })
  return { json, hasExternalAssets }
}

const isZipBytes = (b: Uint8Array) =>
  b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04

/** Parse + validate + sanitize a `.json` or `.lottie` file. Throws LottieFileError. */
export async function parseLottieFile(file: Blob, name: string): Promise<LottieInfo> {
  const dotLottie = /\.lottie$/i.test(name)
  const cap = dotLottie ? MAX_DOTLOTTIE_TOTAL_BYTES : MAX_LOTTIE_JSON_BYTES
  if (file.size > cap)
    throw tooBig(dotLottie ? 'The .lottie file' : 'This JSON file', cap)
  const bytes = await readBlobBytes(file)
  let json: LottieJson
  let hasExternalAssets: boolean
  if (dotLottie || isZipBytes(bytes)) {
    const r = unpackDotLottie(bytes)
    json = r.json as LottieJson
    hasExternalAssets = r.hasExternalAssets
  } else {
    // Strip a UTF-8 BOM some exporters write.
    const text = strFromU8(bytes)
    const parsed = parseJsonText(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
    if (!isLottieJson(parsed)) {
      throw new LottieFileError(
        `This JSON file isn't a Lottie animation (${lottieProblem(parsed)}).`,
      )
    }
    json = parsed
    hasExternalAssets = sanitizeLottieAssets(json)
  }
  const { usesExpressions, usesLayerEffects } = analyzeLottie(json)
  const frameCount = lottieFrameCount(json)
  return {
    json,
    width: json.w,
    height: json.h,
    fps: json.fr,
    frameCount,
    duration: frameCount / json.fr,
    usesExpressions,
    usesLayerEffects,
    hasExternalAssets,
  }
}

// ── Provider ────────────────────────────────────────────────────────────────

export interface LottieProviderOptions {
  /** Backing canvas = intrinsic size × scale (default 2)… */
  scale?: number
  /** …with the longest side capped at this (default 2048 px). */
  maxSize?: number
}

/**
 * Renders into its own canvas. `frameAt` seeks synchronously and returns the
 * canvas (pixel size = `lottieRenderSize(...)`, not width/height).
 */
export async function createLottieProvider(
  json: object,
  opts: LottieProviderOptions = {},
): Promise<FrameProvider> {
  if (!isLottieJson(json))
    throw new LottieFileError(`Not a Lottie animation (${lottieProblem(json)}).`)
  const { default: lottie } =
    await import('lottie-web/build/player/lottie_light_canvas')
  // lottie-web mutates the data it's given; keep the caller's copy pristine.
  const data = structuredClone(json)
  const meta = { ip: data.ip, op: data.op, fr: data.fr }
  const size = lottieRenderSize(data.w, data.h, opts.scale, opts.maxSize)
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not create a canvas for the Lottie animation')

  // No `container`: with `rendererSettings.context` lottie draws into our canvas.
  const config = {
    renderer: 'canvas' as const,
    loop: false,
    autoplay: false,
    animationData: data,
    rendererSettings: {
      context: ctx,
      clearCanvas: true,
      preserveAspectRatio: 'xMidYMid meet',
      dpr: 1,
    },
  }
  const anim = lottie.loadAnimation(
    config as unknown as Parameters<typeof lottie.loadAnimation<'canvas'>>[0],
  )

  let loaded = false
  let disposed = false
  const listeners = new Set<() => void>()

  // For the canvas renderer, DOMLoaded fires only after `loaded_images`
  // (AnimationItem.checkLoaded waits for the image preloader), so it covers both.
  const ready = new Promise<void>((resolve, reject) => {
    let settled = false
    const done = (err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) {
        reject(err)
        return
      }
      loaded = true
      if (!disposed) anim.goToAndStop(0, true)
      resolve()
      for (const l of listeners) l()
    }
    anim.addEventListener('DOMLoaded', () => {
      done()
    })
    anim.addEventListener('data_failed', () => {
      done(new LottieFileError('The Lottie animation data could not be loaded.'))
    })
    const timer = setTimeout(() => {
      done(new LottieFileError('The Lottie animation took too long to load.'))
    }, LOAD_TIMEOUT_MS)
    if (anim.isLoaded) done()
  })
  ready.catch(() => {})

  return {
    width: data.w,
    height: data.h,
    duration: lottieFrameCount(meta) / meta.fr,
    ready,
    frameAt(t, loop) {
      if (!loaded || disposed) return null
      anim.goToAndStop(lottieFrameAt(t, meta, loop), true)
      return canvas
    },
    prepare: () => ready,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      listeners.clear()
      anim.destroy()
      canvas.width = canvas.height = 0
    },
  }
}
