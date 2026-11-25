import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 as rawStrToU8 } from 'fflate'
import {
  detectMediaFile,
  findProResFourcc,
  lottieWarnings,
  PRORES_ALPHA_MESSAGE,
  PRORES_MESSAGE,
  transparentVideoHint,
  WARN_EXPRESSIONS,
  WARN_EXTERNAL_IMAGES,
  WARN_LAYER_EFFECTS,
} from '../detectAnimation'

const strToU8 = (s: string) => Uint8Array.from(rawStrToU8(s))

const lottie = {
  v: '5.9.0',
  fr: 25,
  ip: 0,
  op: 50,
  w: 300,
  h: 100,
  layers: [{ ty: 4, ks: { o: { a: 1, k: [], x: 'loopOut()' } } }],
}

const file = (parts: BlobPart[], name: string, type = '') =>
  new File(parts, name, { type })

describe('detectMediaFile', () => {
  it('recognises a Lottie JSON with warnings', async () => {
    const r = await detectMediaFile(
      file([JSON.stringify(lottie)], 'sub.json', 'application/json'),
    )
    expect(r).toEqual({
      kind: 'animation',
      format: 'lottie',
      width: 300,
      height: 100,
      duration: 2,
      frameCount: 50,
      fps: 25,
      loop: true,
      warnings: [WARN_EXPRESSIONS],
    })
  })

  it('recognises a .lottie archive', async () => {
    const zip = zipSync({ 'animations/a.json': strToU8(JSON.stringify(lottie)) })
    const r = await detectMediaFile(file([zip as BlobPart], 'like.lottie'))
    expect(r).toMatchObject({ kind: 'animation', format: 'lottie', frameCount: 50 })
  })

  it('explains why other JSON is rejected', async () => {
    const r = await detectMediaFile(file(['{"a":1}'], 'data.json'))
    expect(r.kind).toBe('unknown')
    expect(r).toHaveProperty(
      'reason',
      expect.stringMatching(/isn't a Lottie animation/),
    )
  })

  it('treats GIF/WebP/PNG as still images when WebCodecs is unavailable', async () => {
    expect(
      await detectMediaFile(file([new Uint8Array(8)], 'a.gif', 'image/gif')),
    ).toEqual({
      kind: 'image',
    })
    expect(await detectMediaFile(file([new Uint8Array(8)], 'a.png'))).toEqual({
      kind: 'image',
    })
  })

  it('classifies other media by MIME / extension', async () => {
    expect((await detectMediaFile(file([], 'a.mp4'))).kind).toBe('video')
    expect((await detectMediaFile(file([], 'x', 'video/webm'))).kind).toBe('video')
    expect((await detectMediaFile(file([], 'a.flac'))).kind).toBe('audio')
    expect((await detectMediaFile(file([], 'a.jpg'))).kind).toBe('image')
    expect((await detectMediaFile(file([], 'a.aep'))).kind).toBe('unknown')
  })
})

describe('lottieWarnings', () => {
  it('lists each problem once', () => {
    expect(
      lottieWarnings({
        usesExpressions: false,
        usesLayerEffects: true,
        hasExternalAssets: true,
      }),
    ).toEqual([WARN_LAYER_EFFECTS, WARN_EXTERNAL_IMAGES])
  })
})

describe('ProRes detection', () => {
  const withCode = (code: string) => {
    const b = new Uint8Array(64)
    b.set(strToU8('....stsd....' + code + '....'), 10)
    return b
  }
  it('spots 4444 (alpha-capable) and 422 ProRes sample entries', () => {
    expect(findProResFourcc(withCode('ap4h'))).toBe('alpha')
    expect(findProResFourcc(withCode('ap4x'))).toBe('alpha')
    expect(findProResFourcc(withCode('apcn'))).toBe('opaque')
    expect(findProResFourcc(withCode('avc1'))).toBeNull()
  })
  it('explains how to convert', async () => {
    expect(
      await transparentVideoHint(file([withCode('ap4h') as BlobPart], 'logo.mov')),
    ).toBe(PRORES_ALPHA_MESSAGE)
    expect(
      await transparentVideoHint(
        file([withCode('apch') as BlobPart], 'a', 'video/quicktime'),
      ),
    ).toBe(PRORES_MESSAGE)
    expect(
      await transparentVideoHint(file([withCode('avc1') as BlobPart], 'a.mov')),
    ).toBeNull()
    expect(
      await transparentVideoHint(file([withCode('ap4h') as BlobPart], 'a.mp4')),
    ).toBeNull()
  })
})
