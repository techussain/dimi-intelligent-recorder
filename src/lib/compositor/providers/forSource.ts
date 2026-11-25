/**
 * Create the right FrameProvider for an `animation` source from its file.
 */
import type { MediaSource } from '../../timeline/types'
import { createAnimatedImageProvider } from './animatedImage'
import { createLottieProvider, parseLottieFile } from './lottie'
import type { FrameProvider } from './types'

const MIME_BY_FORMAT: Record<string, string> = {
  gif: 'image/gif',
  webp: 'image/webp',
  apng: 'image/png',
  avif: 'image/avif',
}

/** MIME type to hand ImageDecoder for an animated image source. */
export function animatedImageMime(
  source: Pick<MediaSource, 'mimeType' | 'animation'>,
): string {
  const mt = source.mimeType.toLowerCase()
  if (mt.startsWith('image/')) return mt === 'image/apng' ? 'image/png' : mt
  return MIME_BY_FORMAT[source.animation?.format ?? 'gif'] ?? 'image/gif'
}

export async function createProviderFromFile(
  source: MediaSource,
  file: Blob,
): Promise<FrameProvider> {
  if (source.animation?.format === 'lottie') {
    // The OPFS name keeps the original extension (.json / .lottie).
    const info = await parseLottieFile(file, source.opfsPath || source.name)
    return createLottieProvider(info.json)
  }
  return createAnimatedImageProvider(file, animatedImageMime(source))
}
