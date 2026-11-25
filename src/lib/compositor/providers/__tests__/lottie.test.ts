import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 as rawStrToU8 } from 'fflate'
import {
  analyzeLottie,
  isLottieJson,
  LottieFileError,
  lottieFrameAt,
  lottieFrameCount,
  lottieRenderSize,
  MAX_LOTTIE_JSON_BYTES,
  parseLottieFile,
  sanitizeLottieAssets,
  TRANSPARENT_PIXEL,
  unpackDotLottie,
  type LottieJson,
} from '../lottie'

// jsdom's TextEncoder returns a Uint8Array from another realm (see bundle.test.ts).
const strToU8 = (s: string) => Uint8Array.from(rawStrToU8(s))

function anim(extra: Partial<LottieJson> = {}): LottieJson {
  return {
    v: '5.7.4',
    fr: 30,
    ip: 0,
    op: 60,
    w: 512,
    h: 256,
    layers: [{ ty: 4, ks: { o: { a: 0, k: 100 } } }],
    ...extra,
  }
}

const asset0 = (doc: unknown) =>
  ((doc as LottieJson).assets?.[0] ?? {}) as Record<string, unknown>

describe('isLottieJson', () => {
  it('accepts a minimal Bodymovin document', () => {
    expect(isLottieJson(anim())).toBe(true)
  })
  it.each([
    ['no layers', { ...anim(), layers: undefined }],
    ['no version', { ...anim(), v: undefined }],
    ['zero fps', anim({ fr: 0 })],
    ['op <= ip', anim({ ip: 10, op: 10 })],
    ['zero width', anim({ w: 0 })],
    ['array', []],
    ['random JSON', { name: 'package', version: '1.0.0' }],
  ])('rejects %s', (_label, doc) => {
    expect(isLottieJson(doc)).toBe(false)
  })
})

describe('analyzeLottie', () => {
  it('finds nothing in a plain animation', () => {
    expect(analyzeLottie(anim())).toEqual({
      usesExpressions: false,
      usesLayerEffects: false,
    })
  })
  it('detects expressions in nested properties, incl. precomp assets', () => {
    const doc = anim({
      assets: [
        {
          id: 'comp_0',
          layers: [{ ty: 4, ks: { p: { a: 1, k: [], x: 'wiggle(2, 10)' } } }],
        },
      ],
    })
    expect(analyzeLottie(doc).usesExpressions).toBe(true)
  })
  it('ignores non-expression "x" fields', () => {
    const doc = anim({ layers: [{ ty: 4, ks: { p: { a: 0, k: [0, 0] } }, x: 5 }] })
    expect(analyzeLottie(doc).usesExpressions).toBe(false)
  })
  it('detects layer effects', () => {
    const doc = anim({ layers: [{ ty: 4, ef: [{ ty: 5, nm: 'Glow' }] }] })
    expect(analyzeLottie(doc).usesLayerEffects).toBe(true)
    expect(analyzeLottie(anim({ layers: [{ ty: 4, ef: [] }] })).usesLayerEffects).toBe(
      false,
    )
  })
})

describe('sanitizeLottieAssets', () => {
  it('keeps data URLs, blanks http and relative images, leaves precomps alone', () => {
    const doc = anim({
      assets: [
        { id: 'a', p: 'data:image/png;base64,AAAA', u: '', e: 1, w: 1, h: 1 },
        { id: 'b', p: 'pic.png', u: 'https://evil.example/', w: 1, h: 1 },
        { id: 'c', p: 'img_0.png', u: 'images/', w: 1, h: 1 },
        { id: 'comp', layers: [] },
      ],
    })
    expect(sanitizeLottieAssets(doc)).toBe(true)
    const [a, b, c, comp] = doc.assets as Record<string, unknown>[]
    expect(a?.p).toBe('data:image/png;base64,AAAA')
    expect(b).toMatchObject({ p: TRANSPARENT_PIXEL, u: '', e: 1 })
    expect(c?.p).toBe(TRANSPARENT_PIXEL)
    expect(comp).toEqual({ id: 'comp', layers: [] })
  })
  it('never resolves absolute URLs, even with a resolver', () => {
    const doc = anim({ assets: [{ id: 'b', p: 'https://x/y.png', u: '' }] })
    expect(sanitizeLottieAssets(doc, () => 'data:image/png;base64,QQ==')).toBe(true)
    expect(asset0(doc).p).toBe(TRANSPARENT_PIXEL)
  })
  it('reports false when every image is inline', () => {
    const doc = anim({ assets: [{ id: 'a', p: 'data:image/png;base64,AAAA', e: 1 }] })
    expect(sanitizeLottieAssets(doc)).toBe(false)
  })
})

describe('time → frame', () => {
  const meta = { ip: 10, op: 70, fr: 30 } // 60 frames, 2 s
  it('counts frames like lottie-web', () => {
    expect(lottieFrameCount(meta)).toBe(60)
    expect(lottieFrameCount({ ip: 0, op: 59.5 })).toBe(59)
  })
  it('maps seconds to frames relative to ip', () => {
    expect(lottieFrameAt(0, meta, false)).toBe(0)
    expect(lottieFrameAt(1, meta, false)).toBe(30)
    expect(lottieFrameAt(0.5, meta, false)).toBeCloseTo(15)
  })
  it('holds the last frame (never reaching op) and the first before 0', () => {
    expect(lottieFrameAt(5, meta, false)).toBe(59)
    expect(lottieFrameAt(2, meta, false)).toBe(59)
    expect(lottieFrameAt(-1, meta, false)).toBe(0)
  })
  it('wraps when looping', () => {
    expect(lottieFrameAt(2, meta, true)).toBe(0)
    expect(lottieFrameAt(2.5, meta, true)).toBeCloseTo(15)
    expect(lottieFrameAt(-0.5, meta, true)).toBeCloseTo(45)
    expect(lottieFrameAt(1.999, meta, true)).toBeLessThanOrEqual(59)
  })
  it('treats NaN as 0', () => {
    expect(lottieFrameAt(Number.NaN, meta, true)).toBe(0)
  })
})

describe('lottieRenderSize', () => {
  it('scales by the factor', () => {
    expect(lottieRenderSize(512, 256)).toEqual({ width: 1024, height: 512 })
  })
  it('caps the longest side', () => {
    expect(lottieRenderSize(1920, 1080)).toEqual({ width: 2048, height: 1152 })
    expect(lottieRenderSize(4000, 1000, 1, 2048)).toEqual({ width: 2048, height: 512 })
  })
})

describe('.lottie archives', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
  const json = (x: unknown) => strToU8(JSON.stringify(x))

  it('reads the active animation from the manifest and inlines its images (v1)', () => {
    const main = anim({
      assets: [{ id: 'img', p: 'logo.png', u: '/images/', w: 1, h: 1 }],
    })
    const zip = zipSync({
      'manifest.json': json({
        version: '1',
        activeAnimationId: 'main',
        animations: [{ id: 'other' }, { id: 'main' }],
      }),
      'animations/other.json': json(anim({ w: 99 })),
      'animations/main.json': json(main),
      'images/logo.png': PNG,
    })
    const { json: doc, hasExternalAssets } = unpackDotLottie(zip)
    expect(hasExternalAssets).toBe(false)
    expect((doc as LottieJson).w).toBe(512)
    expect(asset0(doc).e).toBe(1)
    expect(asset0(doc).p).toBe(
      `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`,
    )
  })

  it('supports the v2 layout (a/, i/, initial.animation)', () => {
    const zip = zipSync({
      'manifest.json': json({
        version: '2',
        initial: { animation: 'b' },
        animations: [{ id: 'a' }, { id: 'b' }],
      }),
      'a/a.json': json(anim({ w: 1 })),
      'a/b.json': json(anim({ w: 2, assets: [{ id: 'i', p: 'x.webp', u: '/i/' }] })),
      'i/x.webp': PNG,
    })
    const doc = unpackDotLottie(zip).json
    expect((doc as LottieJson).w).toBe(2)
    expect(asset0(doc).p).toMatch(/^data:image\/webp;base64,/)
  })

  it('uses the first animation when there is no manifest; flags missing images', () => {
    const zip = zipSync({
      'animations/z.json': json(
        anim({ assets: [{ id: 'i', p: 'gone.png', u: 'images/' }] }),
      ),
    })
    const r = unpackDotLottie(zip)
    expect(r.hasExternalAssets).toBe(true)
    expect(asset0(r.json).p).toBe(TRANSPARENT_PIXEL)
  })

  it('rejects archives without an animation, damaged zips and invalid data', () => {
    expect(() => unpackDotLottie(zipSync({ 'readme.txt': strToU8('hi') }))).toThrow(
      /no animation/,
    )
    expect(() => unpackDotLottie(strToU8('not a zip at all'))).toThrow(LottieFileError)
    expect(() =>
      unpackDotLottie(zipSync({ 'animations/a.json': strToU8('{"hello":1}') })),
    ).toThrow(/isn't valid Lottie data/)
  })

  it('enforces the uncompressed size caps before inflating', () => {
    // Highly compressible: > 20 MB of spaces inside valid JSON.
    const text = JSON.stringify(anim()).replace(
      '{',
      '{' + ' '.repeat(MAX_LOTTIE_JSON_BYTES + 1024),
    )
    const zip = zipSync({ 'animations/a.json': strToU8(text) })
    expect(zip.length).toBeLessThan(1024 * 1024)
    expect(() => unpackDotLottie(zip)).toThrow(/20 MB limit/)

    const pad = new Uint8Array(55 * 1024 * 1024)
    const zip2 = zipSync({
      'animations/a.json': json(anim()),
      'images/1.png': pad,
      'images/2.png': pad,
    })
    expect(() => unpackDotLottie(zip2)).toThrow(/100 MB limit/)
  }, 30_000) // builds ~20 MB of test data; slow when the whole suite runs in parallel
})

describe('parseLottieFile', () => {
  const blob = (s: string | Uint8Array) => new Blob([s as BlobPart])

  it('parses raw JSON and reports metadata + flags', async () => {
    const doc = anim({
      ip: 0,
      op: 90,
      fr: 60,
      layers: [{ ty: 4, ef: [{ ty: 5 }], ks: { r: { a: 1, k: [], x: 'time * 30' } } }],
      assets: [{ id: 'i', p: 'https://cdn.example/a.png', u: '' }],
    })
    const info = await parseLottieFile(blob(JSON.stringify(doc)), 'button.json')
    expect(info).toMatchObject({
      width: 512,
      height: 256,
      fps: 60,
      frameCount: 90,
      duration: 1.5,
      usesExpressions: true,
      usesLayerEffects: true,
      hasExternalAssets: true,
    })
    expect(asset0(info.json).p).toBe(TRANSPARENT_PIXEL)
  })

  it('strips a BOM', async () => {
    const info = await parseLottieFile(
      blob(String.fromCharCode(0xfeff) + JSON.stringify(anim())),
      'a.json',
    )
    expect(info.frameCount).toBe(60)
  })

  it('rejects non-Lottie JSON and invalid JSON with clear messages', async () => {
    await expect(parseLottieFile(blob('{"name":"x"}'), 'package.json')).rejects.toThrow(
      /isn't a Lottie animation \(missing v, fr, ip, op, w, h, layers\)/,
    )
    await expect(parseLottieFile(blob('{oops'), 'a.json')).rejects.toThrow(
      /isn't valid JSON/,
    )
  })

  it('rejects oversized JSON without reading it', async () => {
    const huge = { size: MAX_LOTTIE_JSON_BYTES + 1 } as unknown as Blob
    await expect(parseLottieFile(huge, 'big.json')).rejects.toThrow(/20 MB limit/)
  })

  it('reads .lottie by extension and by zip signature', async () => {
    const zip = zipSync({ 'animations/x.json': json(anim()) })
    expect((await parseLottieFile(blob(zip), 'x.lottie')).width).toBe(512)
    expect((await parseLottieFile(blob(zip), 'mislabelled.json')).width).toBe(512)
  })

  function json(x: unknown) {
    return strToU8(JSON.stringify(x))
  }
})
