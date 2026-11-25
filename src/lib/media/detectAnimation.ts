/**
 * Decide what an imported file really is: Lottie (`.json` / `.lottie`) and
 * animated GIF / WebP / APNG / AVIF become `animation`; single-frame images
 * stay `image`. Also explains `.mov` files Chromium can't play (ProRes).
 */
import { probeAnimatedImage } from '../compositor/providers/animatedImage'
import { LottieFileError, parseLottieFile } from '../compositor/providers/lottie'
import { readBlobBytes } from '../compositor/providers/readBlob'

export type AnimationFormat = 'lottie' | 'gif' | 'webp' | 'apng' | 'avif'

export interface AnimationDetection {
  kind: 'animation'
  format: AnimationFormat
  width: number
  height: number
  /** Seconds. */
  duration: number
  frameCount: number
  /** Lottie only. */
  fps?: number
  loop: boolean
  /** User-facing notes ("may look different"). */
  warnings: string[]
}

export type MediaDetection =
  | AnimationDetection
  | { kind: 'image' | 'video' | 'audio' }
  /** `reason` is a user-facing explanation when we know why. */
  | { kind: 'unknown'; reason?: string }

export const WARN_EXPRESSIONS = 'uses After Effects expressions — parts may not animate'
export const WARN_LAYER_EFFECTS = "uses layer effects that aren't supported"
export const WARN_EXTERNAL_IMAGES = 'external images were removed'

const ext = (name: string) => {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

const IMAGE_MIME_BY_EXT: Record<string, { mime: string; format: AnimationFormat }> = {
  gif: { mime: 'image/gif', format: 'gif' },
  webp: { mime: 'image/webp', format: 'webp' },
  png: { mime: 'image/png', format: 'apng' },
  apng: { mime: 'image/apng', format: 'apng' },
  avif: { mime: 'image/avif', format: 'avif' },
}

const FORMAT_BY_MIME: Record<string, AnimationFormat> = {
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/png': 'apng',
  'image/apng': 'apng',
  'image/vnd.mozilla.apng': 'apng',
  'image/avif': 'avif',
}

const VIDEO_EXT = /^(mp4|webm|mov|mkv|avi|m4v)$/
const AUDIO_EXT = /^(mp3|wav|m4a|aac|ogg|oga|opus|flac)$/
const IMAGE_EXT = /^(png|apng|jpe?g|gif|webp|bmp|avif|svg)$/

/** Warnings for a parsed Lottie file. */
export function lottieWarnings(info: {
  usesExpressions: boolean
  usesLayerEffects: boolean
  hasExternalAssets: boolean
}): string[] {
  const w: string[] = []
  if (info.usesExpressions) w.push(WARN_EXPRESSIONS)
  if (info.usesLayerEffects) w.push(WARN_LAYER_EFFECTS)
  if (info.hasExternalAssets) w.push(WARN_EXTERNAL_IMAGES)
  return w
}

export async function detectMediaFile(file: File): Promise<MediaDetection> {
  const e = ext(file.name)
  const mime = file.type.toLowerCase()

  if (
    e === 'lottie' ||
    e === 'json' ||
    mime === 'application/json' ||
    mime === 'application/zip+dotlottie'
  ) {
    try {
      const info = await parseLottieFile(file, file.name)
      return {
        kind: 'animation',
        format: 'lottie',
        width: info.width,
        height: info.height,
        duration: info.duration,
        frameCount: info.frameCount,
        fps: info.fps,
        loop: true,
        warnings: lottieWarnings(info),
      }
    } catch (err) {
      return {
        kind: 'unknown',
        reason:
          err instanceof LottieFileError
            ? err.message
            : "This file couldn't be read as a Lottie animation.",
      }
    }
  }

  const byMime = FORMAT_BY_MIME[mime]
  const byExt = IMAGE_MIME_BY_EXT[e]
  if (byMime || byExt) {
    const probeMime = byMime ? mime : (byExt?.mime ?? mime)
    const format = byMime ?? byExt?.format ?? 'gif'
    const info = await probeAnimatedImage(file, probeMime)
    if (info?.animated && info.frameCount > 1) {
      return {
        kind: 'animation',
        format,
        width: info.width,
        height: info.height,
        duration: info.duration,
        frameCount: info.frameCount,
        loop: info.loop,
        warnings: [],
      }
    }
    return { kind: 'image' }
  }

  if (mime.startsWith('video/') || VIDEO_EXT.test(e)) return { kind: 'video' }
  if (mime.startsWith('audio/') || AUDIO_EXT.test(e)) return { kind: 'audio' }
  if (mime.startsWith('image/') || IMAGE_EXT.test(e)) return { kind: 'image' }
  return { kind: 'unknown' }
}

// ── Transparent video hints ─────────────────────────────────────────────────

export const PRORES_ALPHA_MESSAGE =
  'This .mov uses Apple ProRes 4444, which this app (Chromium) cannot decode — transparency ' +
  'included. Convert it to WebM with alpha, e.g. ' +
  '`ffmpeg -i input.mov -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 30 output.webm`, then import the .webm.'

export const PRORES_MESSAGE =
  'This .mov uses Apple ProRes, which this app (Chromium) cannot decode. Convert it to MP4 (H.264) — ' +
  'or, if it has a transparent background, to WebM with alpha: ' +
  '`ffmpeg -i input.mov -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 30 output.webm`.'

export const MOV_ALPHA_NOTE =
  'Transparent .mov files (ProRes 4444) are not supported. For a transparent overlay, use WebM (VP9) with alpha.'

const PRORES_CODES = ['ap4h', 'ap4x', 'apch', 'apcn', 'apcs', 'apco'] as const
const SCAN_BYTES = 4 * 1024 * 1024

/**
 * Find a ProRes sample-entry fourcc (`stsd`) in raw bytes. 'alpha' for the
 * 4444 variants, 'opaque' for 422 ones, null when absent.
 */
export function findProResFourcc(bytes: Uint8Array): 'alpha' | 'opaque' | null {
  let found: 'alpha' | 'opaque' | null = null
  const codes = PRORES_CODES.map((c) =>
    Array.from({ length: 4 }, (_, j) => c.charCodeAt(j)),
  )
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] !== 0x61 || bytes[i + 1] !== 0x70) continue // 'ap'
    for (const [k, code] of codes.entries()) {
      if (bytes[i + 2] === code[2] && bytes[i + 3] === code[3]) {
        if (k < 2) return 'alpha'
        found = 'opaque'
      }
    }
  }
  return found
}

/**
 * For QuickTime files: a user-facing explanation when the file is ProRes
 * (Chromium can't decode it), else null. Scans the head and tail of the
 * file, where the `moov` box lives.
 */
export async function transparentVideoHint(file: File): Promise<string | null> {
  const isMov =
    ext(file.name) === 'mov' || file.type.toLowerCase() === 'video/quicktime'
  if (!isMov) return null
  try {
    const head = await readBlobBytes(file.slice(0, SCAN_BYTES))
    let kind = findProResFourcc(head)
    if (kind === null && file.size > SCAN_BYTES) {
      kind = findProResFourcc(
        await readBlobBytes(file.slice(Math.max(SCAN_BYTES, file.size - SCAN_BYTES))),
      )
    }
    if (kind === 'alpha') return PRORES_ALPHA_MESSAGE
    if (kind === 'opaque') return PRORES_MESSAGE
    return null
  } catch {
    return null
  }
}
