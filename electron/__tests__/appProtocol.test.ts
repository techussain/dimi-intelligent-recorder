// @vitest-environment node
import * as path from 'path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ protocol: {} }))

const { resolveAppFile } = await import('../appProtocol.cts')

const DIST = path.resolve('/opt/app/dist')
const inDist = (...p: string[]) => path.join(DIST, ...p)

describe('resolveAppFile', () => {
  it('maps app://bundle paths into dist/', () => {
    expect(resolveAppFile('app://bundle/index.html', DIST)).toBe(inDist('index.html'))
    expect(resolveAppFile('app://bundle/assets/a-1.js', DIST)).toBe(
      inDist('assets', 'a-1.js'),
    )
    expect(resolveAppFile('app://bundle/', DIST)).toBe(inDist('index.html'))
    expect(resolveAppFile('app://bundle/index.html?overlay=1', DIST)).toBe(
      inDist('index.html'),
    )
  })

  it('rejects other hosts and schemes', () => {
    expect(resolveAppFile('app://other/index.html', DIST)).toBeNull()
    expect(resolveAppFile('file:///etc/passwd', DIST)).toBeNull()
    expect(resolveAppFile('not a url', DIST)).toBeNull()
  })

  it('never escapes dist/', () => {
    for (const u of [
      'app://bundle/../secret.txt',
      'app://bundle/%2e%2e/secret.txt',
      'app://bundle/assets/%2e%2e/%2e%2e/secret.txt',
      'app://bundle/..%2fsecret.txt',
      'app://bundle/..%5csecret.txt',
      'app://bundle/%00index.html',
      'app://bundle/%E0%A4%A', // malformed escape
    ]) {
      const r = resolveAppFile(u, DIST)
      if (r !== null) expect(r.startsWith(DIST + path.sep)).toBe(true)
    }
    expect(resolveAppFile('app://bundle/..%2fsecret.txt', DIST)).toBeNull()
    expect(resolveAppFile('app://bundle/..%5csecret.txt', DIST)).toBeNull()
    expect(resolveAppFile('app://bundle/%00index.html', DIST)).toBeNull()
  })
})
