import { describe, it, expect, vi } from 'vitest'
import { ProviderPool, animationFrameTime } from '../pool'
import type { FrameProvider } from '../types'
import type { MediaSource } from '../../../timeline/types'

function src(id: string, path = `imports/${id}.json`): MediaSource {
  return {
    id,
    kind: 'animation',
    opfsPath: path,
    mimeType: 'application/json',
    duration: 2,
    createdAt: 0,
    name: id,
  }
}

type Fake = FrameProvider & { listeners: Set<() => void>; disposed: boolean }

function fakeProvider(): Fake {
  const listeners = new Set<() => void>()
  const p: Fake = {
    width: 10,
    height: 10,
    duration: 2,
    listeners,
    disposed: false,
    frameAt: () => null,
    prepare: () => Promise.resolve(),
    subscribe(l: () => void) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    ready: Promise.resolve(),
    dispose() {
      p.disposed = true
    },
  }
  return p
}

describe('animationFrameTime', () => {
  it('passes source time through and honours Clip.loop', () => {
    expect(animationFrameTime({}, 3.5)).toEqual({ t: 3.5, loop: false })
    expect(animationFrameTime({ loop: true }, 7)).toEqual({ t: 7, loop: true })
  })
  it('clamps negative / non-finite times to 0', () => {
    expect(animationFrameTime({ loop: true }, -1).t).toBe(0)
    expect(animationFrameTime({}, Number.NaN).t).toBe(0)
  })
})

describe('ProviderPool', () => {
  it('creates one provider per layer key, even for the same source', async () => {
    const made: Fake[] = []
    const pool = new ProviderPool(() => {
      const p = fakeProvider()
      made.push(p)
      return Promise.resolve(p)
    })
    const a = await pool.load('layer-a', src('s'))
    const b = await pool.load('layer-b', src('s'))
    expect(a).not.toBe(b)
    expect(made).toHaveLength(2)
    expect(await pool.load('layer-a', src('s'))).toBe(a)
    expect(made).toHaveLength(2)
    expect(pool.get('layer-a', src('s'))).toBe(a)
  })

  it('get() is null while loading and starts the load once', async () => {
    const factory = vi.fn(() => Promise.resolve(fakeProvider()))
    const pool = new ProviderPool(factory)
    expect(pool.get('k', src('s'))).toBeNull()
    expect(pool.get('k', src('s'))).toBeNull()
    expect(factory).toHaveBeenCalledTimes(1)
    await pool.load('k', src('s'))
    expect(pool.get('k', src('s'))).not.toBeNull()
  })

  it('replaces the provider when the key now shows another source or file', async () => {
    const made: Fake[] = []
    const pool = new ProviderPool(() => {
      const p = fakeProvider()
      made.push(p)
      return Promise.resolve(p)
    })
    await pool.load('k', src('s1'))
    await pool.load('k', src('s2'))
    expect(made[0]!.disposed).toBe(true)
    expect(made[1]!.disposed).toBe(false)
    await pool.load('k', src('s2', 'imports/other.json'))
    expect(made[1]!.disposed).toBe(true)
  })

  it('retain() disposes inactive providers beyond the idle allowance', async () => {
    const made: Fake[] = []
    const pool = new ProviderPool(() => {
      const p = fakeProvider()
      made.push(p)
      return Promise.resolve(p)
    })
    for (const k of ['a', 'b', 'c']) await pool.load(k, src('s'))
    pool.retain(new Set(['c']), 1)
    // c is active, b is the most recently used idle one, a goes.
    expect(made.map((p) => p.disposed)).toEqual([true, false, false])
    expect(pool.size).toBe(2)
  })

  it('dispose() disposes everything, and late loads are disposed on arrival', async () => {
    let resolveLate!: (p: FrameProvider) => void
    const first = fakeProvider()
    let n = 0
    const pool = new ProviderPool(() =>
      n++ === 0
        ? Promise.resolve(first)
        : new Promise<FrameProvider>((r) => {
            resolveLate = r
          }),
    )
    await pool.load('a', src('s'))
    const pending = pool.load('b', src('s'))
    pool.dispose()
    expect(first.disposed).toBe(true)
    const late = fakeProvider()
    resolveLate(late)
    expect(await pending).toBeNull()
    expect(late.disposed).toBe(true)
  })

  it('notifies on ready and on provider updates, but not after release', async () => {
    const p = fakeProvider()
    const onUpdate = vi.fn()
    const pool = new ProviderPool(() => Promise.resolve(p), onUpdate)
    await pool.load('a', src('s'))
    await Promise.resolve()
    const afterLoad = onUpdate.mock.calls.length
    expect(afterLoad).toBeGreaterThan(0)
    for (const l of p.listeners) l()
    expect(onUpdate.mock.calls.length).toBe(afterLoad + 1)
    pool.dispose()
    expect(p.listeners.size).toBe(0)
  })

  it('reports failed loads and resolves null', async () => {
    const pool = new ProviderPool(() => Promise.reject(new Error('bad file')))
    expect(await pool.load('a', src('s'))).toBeNull()
    expect(pool.failed('a')).toBe(true)
    expect(pool.get('a', src('s'))).toBeNull()
  })
})
