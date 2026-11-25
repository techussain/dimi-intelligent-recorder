// @vitest-environment node
/**
 * Speech model pinning: only files of the pinned revision are accepted, other
 * revisions are redirected to it, and content must match its SHA-256.
 */
import { describe, it, expect } from 'vitest'
import {
  MODEL_ID,
  MODEL_REVISION,
  modelFilePath,
  pinModelUrl,
  verifyModelFile,
} from '../modelPin'

const at = (rev: string, file: string) =>
  `https://huggingface.co/${MODEL_ID}/resolve/${rev}/${file}`

describe('model pinning', () => {
  it('maps pinned URLs to repository paths', () => {
    expect(modelFilePath(at(MODEL_REVISION, 'config.json'))).toBe('config.json')
    expect(modelFilePath(at(MODEL_REVISION, 'onnx/encoder_model_quantized.onnx'))).toBe(
      'onnx/encoder_model_quantized.onnx',
    )
  })

  it('rejects other revisions, models and hosts', () => {
    expect(modelFilePath(at('main', 'config.json'))).toBeNull()
    expect(
      modelFilePath(`https://huggingface.co/someone/else/resolve/${MODEL_REVISION}/x`),
    ).toBeNull()
    expect(
      modelFilePath(
        `https://evil.example/${MODEL_ID}/resolve/${MODEL_REVISION}/config.json`,
      ),
    ).toBeNull()
    expect(modelFilePath('not a url')).toBeNull()
  })

  it('redirects any revision of the model to the pinned one, nothing else', () => {
    expect(pinModelUrl(at('main', 'tokenizer.json'))).toBe(
      at(MODEL_REVISION, 'tokenizer.json'),
    )
    expect(pinModelUrl('https://huggingface.co/api/models/x')).toBeNull()
    expect(pinModelUrl('https://example.com/a')).toBeNull()
  })

  it('rejects content that differs from the pinned file, and unknown files', async () => {
    await expect(
      verifyModelFile('config.json', new TextEncoder().encode('{"tampered":true}')),
    ).rejects.toThrow(/integrity check/)
    await expect(
      verifyModelFile('onnx/unknown.onnx', new Uint8Array([1, 2, 3])),
    ).rejects.toThrow(/Unexpected speech model file/)
  })
})
