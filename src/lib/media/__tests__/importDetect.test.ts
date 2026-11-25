/** Import wiring: detection result -> source kind, warnings, errors, alpha. */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const writeFile = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('../../storage/opfs', () => ({ writeFile }))

const detectMediaFile = vi.hoisted(() => vi.fn())
const transparentVideoHint = vi.hoisted(() =>
  vi.fn((): Promise<string | null> => Promise.resolve(null)),
)
vi.mock('../detectAnimation', () => ({ detectMediaFile, transparentVideoHint }))

const canBeTransparent = vi.hoisted(() => vi.fn(() => Promise.resolve(true)))
vi.mock('mediabunny', () => ({
  ALL_FORMATS: [],
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  BlobSource: class {},
  Input: class {
    getPrimaryVideoTrack() {
      return Promise.resolve({ canBeTransparent })
    }
    computeDuration() {
      return Promise.resolve(3)
    }
    dispose() {}
  },
}))

import { importFile, importFileDetailed, importFiles } from '../import'

describe('import detection wiring', () => {
  beforeEach(() => {
    writeFile.mockClear()
    detectMediaFile.mockReset()
    canBeTransparent.mockReset().mockResolvedValue(true)
    transparentVideoHint.mockReset().mockResolvedValue(null)
    const proto = HTMLMediaElement.prototype
    vi.spyOn(proto, 'duration', 'get').mockReturnValue(5)
    vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(320)
    vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(180)
    vi.spyOn(proto, 'src', 'set').mockImplementation(function (this: HTMLMediaElement) {
      queueMicrotask(() => {
        this.onloadedmetadata?.(new Event('loadedmetadata'))
      })
    })
    vi.spyOn(proto, 'load').mockImplementation(() => {})
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  })

  it('imports a Lottie file as an animation source and returns its warnings', async () => {
    detectMediaFile.mockResolvedValue({
      kind: 'animation',
      format: 'lottie',
      width: 512,
      height: 256,
      duration: 3.5,
      frameCount: 105,
      fps: 30,
      loop: true,
      warnings: ['uses After Effects expressions'],
    })
    const f = new File(['{}'], 'sub.json', { type: 'application/json' })
    const { source, warnings } = await importFileDetailed(f)
    expect(source.kind).toBe('animation')
    expect(source.width).toBe(512)
    expect(source.height).toBe(256)
    expect(source.duration).toBe(3.5)
    expect(source.animation).toEqual({
      format: 'lottie',
      fps: 30,
      frameCount: 105,
      loop: true,
    })
    expect(source.opfsPath).toMatch(/^imports\/.+\.json$/)
    expect(writeFile).toHaveBeenCalledWith(source.opfsPath, f)
    expect(warnings).toHaveLength(1)
  })

  it('imports an animated GIF as an animation without fps', async () => {
    detectMediaFile.mockResolvedValue({
      kind: 'animation',
      format: 'gif',
      width: 64,
      height: 64,
      duration: 1,
      frameCount: 10,
      loop: false,
      warnings: [],
    })
    const s = await importFile(
      new File([new Uint8Array(4)], 'a.gif', { type: 'image/gif' }),
    )
    expect(s.kind).toBe('animation')
    expect(s.animation).toEqual({ format: 'gif', frameCount: 10, loop: false })
    expect(s.animation).not.toHaveProperty('fps')
  })

  it('rejects unknown files with the detection reason', async () => {
    detectMediaFile.mockResolvedValue({
      kind: 'unknown',
      reason: 'Not a Lottie animation.',
    })
    await expect(importFile(new File(['x'], 'bad.json'))).rejects.toThrow(
      'Not a Lottie animation.',
    )
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('reports per-file errors and warnings from importFiles', async () => {
    detectMediaFile
      .mockResolvedValueOnce({
        kind: 'animation',
        format: 'lottie',
        width: 10,
        height: 10,
        duration: 1,
        frameCount: 30,
        loop: true,
        warnings: ['w'],
      })
      .mockResolvedValueOnce({ kind: 'unknown', reason: 'nope' })
    const r = await importFiles([
      new File(['{}'], 'one.json', { type: 'application/json' }),
      new File(['x'], 'two.bin'),
    ])
    expect(r.sources).toHaveLength(1)
    expect(r.warnings).toEqual([{ name: 'one.json', messages: ['w'] }])
    expect(r.errors.map((e) => e.error.message)).toEqual(['nope'])
  })

  it('marks videos with an alpha track as hasAlpha', async () => {
    detectMediaFile.mockResolvedValue({ kind: 'video' })
    const s = await importFile(
      new File([new Uint8Array(4)], 'o.webm', { type: 'video/webm' }),
    )
    expect(s.kind).toBe('video')
    expect(s.hasAlpha).toBe(true)
    canBeTransparent.mockResolvedValueOnce(false)
    const s2 = await importFile(
      new File([new Uint8Array(4)], 'p.webm', { type: 'video/webm' }),
    )
    expect(s2.hasAlpha).toBeUndefined()
  })

  it('explains ProRes .mov files instead of a generic failure', async () => {
    detectMediaFile.mockResolvedValue({ kind: 'video' })
    canBeTransparent.mockResolvedValue(false)
    transparentVideoHint.mockResolvedValue('Convert the ProRes file')
    await expect(
      importFile(
        new File([new Uint8Array(4)], 'alpha.mov', { type: 'video/quicktime' }),
      ),
    ).rejects.toThrow('Convert the ProRes file')
    expect(writeFile).not.toHaveBeenCalled()
  })
})
