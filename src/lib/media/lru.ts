/**
 * Generic LRU (Least Recently Used) cache backed by insertion-ordered Map.
 * The first Map entry is always the LRU candidate for eviction.
 */
export class LRUCache<K, V> {
  private readonly map = new Map<K, V>()
  readonly maxSize: number
  private readonly onEvict: ((key: K, value: V) => void) | undefined

  constructor(maxSize: number, onEvict?: (key: K, value: V) => void) {
    this.maxSize = maxSize
    this.onEvict = onEvict
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined
    const val = this.map.get(key) as V
    // Promote to MRU position by re-inserting at end.
    this.map.delete(key)
    this.map.set(key, val)
    return val
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key)
    } else if (this.map.size >= this.maxSize) {
      const lruKey = this.map.keys().next().value as K
      const lruVal = this.map.get(lruKey) as V
      this.map.delete(lruKey)
      this.onEvict?.(lruKey, lruVal)
    }
    this.map.set(key, value)
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  /** Remove an entry and fire the eviction callback. */
  delete(key: K): void {
    const val = this.map.get(key)
    if (val !== undefined) this.onEvict?.(key, val)
    this.map.delete(key)
  }

  clear(): void {
    if (this.onEvict) {
      for (const [k, v] of this.map) this.onEvict(k, v)
    }
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries()
  }

  values(): IterableIterator<V> {
    return this.map.values()
  }
}
