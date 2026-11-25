/**
 * importFile remembers the original file's path on disk (desktop app) and
 * does not copy it anywhere but OPFS.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const writeFile = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('../../storage/opfs', () => ({ writeFile }))

import { importFile } from '../import'

describe('importFile diskPath', () => {
  beforeEach(() => {
    // jsdom never loads media: make metadata "load" as soon as src is set.
    const proto = HTMLMediaElement.prototype
    vi.spyOn(proto, 'duration', 'get').mockReturnValue(5)
    vi.spyOn(proto, 'src', 'set').mockImplementation(function (this: HTMLMediaElement) {
      queueMicrotask(() => {
        this.onloadedmetadata?.(new Event('loadedmetadata'))
      })
    })
    vi.spyOn(proto, 'load').mockImplementation(() => {})
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  })
  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
  })

  const file = () => new File([new Uint8Array(8)], 'talk.mp3', { type: 'audio/mpeg' })

  it('sets diskPath to the original path when registerImport returns one', async () => {
    const registerImport = vi.fn(() => 'D:\\Music\\talk.mp3')
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
      media: { registerImport },
    }
    const f = file()
    const s = await importFile(f)
    expect(registerImport).toHaveBeenCalledWith(f)
    expect(s.diskPath).toBe('D:\\Music\\talk.mp3')
    expect(s.duration).toBe(5)
    expect(writeFile).toHaveBeenCalledTimes(1)
  })

  it('leaves diskPath unset when there is no path (or no desktop API)', async () => {
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
      media: { registerImport: () => '' },
    }
    expect((await importFile(file())).diskPath).toBeUndefined()
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
    expect((await importFile(file())).diskPath).toBeUndefined()
  })
})
