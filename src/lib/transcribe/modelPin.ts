/**
 * The speech model, pinned: one exact Hugging Face Hub commit, and the
 * SHA-256 of every file the app may load from it. A file whose hash doesn't
 * match (a changed repository, a compromised mirror, a corrupted download) is
 * rejected before Transformers.js sees it or it is cached.
 *
 * To move to a new model revision: set MODEL_REVISION to the new commit and
 * regenerate MODEL_FILES from
 *   https://huggingface.co/api/models/<MODEL_ID>/revision/<commit>?blobs=true
 * (`lfs.sha256` for weights; for plain files download them at that commit
 * and hash them, checking each against its git `blobId`).
 */

export const MODEL_ID = 'onnx-community/whisper-base.en'
export const MODEL_REVISION = '51eefc0af78b103839eda9e7e4f4186acc6517fe'

/** Repository path → SHA-256 (hex) at MODEL_REVISION. */
export const MODEL_FILES: Readonly<Record<string, string>> = {
  'added_tokens.json':
    '560be47bea388757f8d4cc185c5d82067426cbb6361e38016dd90ddc01ab203a',
  'config.json': 'c8a0de5ed8a083565a4319db29d0c210fda35b4d6076c2d711cae53ae00f3cb1',
  'generation_config.json':
    '3479b1f44a07e41db799e22599222fee5816738036def94a39841cb9cdbb4120',
  'merges.txt': '1ce1664773c50f3e0cc8842619a93edc4624525b728b188a9e0be33b7726adc5',
  'normalizer.json': 'bf1c507dc8724ca9cf9903640dacfb69dae2f00edee4f21ceba106a7392f26dd',
  'onnx/decoder_model_merged_quantized.onnx':
    'dd4761a3f7add26afda3512abff4706920404c2517e85a9f2ff090b0c0987909',
  'onnx/decoder_model_quantized.onnx':
    '88f4ffae377556e6326125226c0797f6d08d6075b4cb9891df709404d33ca067',
  'onnx/decoder_with_past_model_quantized.onnx':
    '400ccb2833dd4bc1470ed15d3355d18374db5101d81c69979bfc50a1a36655e8',
  'onnx/encoder_model_quantized.onnx':
    '6e8001198c490bbae018c0044f630c2915efb826bad957006ce36152d0ab2a10',
  'preprocessor_config.json':
    'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d',
  'quantize_config.json':
    '6e0e27f293a5c17ff2ca8046f06079c0120aa2ede6456faac8ec4b3203471a55',
  'special_tokens_map.json':
    '98bdf3ec5b32e31575b02f64b0a32bde7c0449075d34484a7df9bdd3cdeb9fb9',
  'tokenizer.json': '5eb60cec1e77aeeb6869a2bb5a8e01a84c3fe5d072d75369343021fe6f5310d0',
  'tokenizer_config.json':
    '93879c3dccdd4b976f709acd85b44778873f30c275e67026f30ca1e4c975230c',
  'vocab.json': 'f6bd25a65e4e63ca31360e9fb11c7e4f9a391a78385d640acd814092dd6eee4f',
}

/**
 * The repository path of a model file URL at the pinned revision
 * (`https://huggingface.co/<id>/resolve/<revision>/<path>`), or null for any
 * other URL — including the same model at another revision.
 */
export function modelFilePath(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.hostname !== 'huggingface.co') return null
  const prefix = `/${MODEL_ID}/resolve/${MODEL_REVISION}/`
  if (!u.pathname.startsWith(prefix)) return null
  try {
    return decodeURIComponent(u.pathname.slice(prefix.length))
  } catch {
    return null
  }
}

/**
 * The same file at the pinned revision, for a URL of this model at any
 * revision (Transformers.js probes some files at `main` even when given a
 * revision); null for anything else.
 */
export function pinModelUrl(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.hostname !== 'huggingface.co') return null
  const prefix = `/${MODEL_ID}/resolve/`
  if (!u.pathname.startsWith(prefix)) return null
  const rest = u.pathname.slice(prefix.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  u.pathname = `${prefix}${MODEL_REVISION}${rest.slice(slash)}`
  u.search = ''
  u.hash = ''
  return u.href
}

async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Throws unless `bytes` is exactly the pinned file at `path`. */
export async function verifyModelFile(
  path: string,
  bytes: BufferSource,
): Promise<void> {
  const expected = MODEL_FILES[path]
  if (!expected) throw new Error(`Unexpected speech model file: ${path}`)
  if ((await sha256Hex(bytes)) !== expected)
    throw new Error(
      `The downloaded speech model file ${path} failed its integrity check. ` +
        'It was not used. Try again later.',
    )
}
