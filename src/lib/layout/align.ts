/**
 * Align / distribute maths on axis-aligned bounds (pass
 * `axisAlignedBounds(box)` for rotated objects). Pure: returns per-object
 * translations; callers apply them (see layout/actions.ts).
 */
import { unionBounds, type Bounds } from './geometry'

export type AlignEdge = 'left' | 'hcenter' | 'right' | 'top' | 'vmiddle' | 'bottom'
export type AlignRelativeTo = 'frame' | 'selection'
export type DistributeAxis = 'h' | 'v'

export interface LayoutItem {
  id: string
  bounds: Bounds
}

export interface LayoutDelta {
  id: string
  dx: number
  dy: number
}

/** Line an object edge/centre is moved to. */
function edgeOf(b: Bounds, edge: AlignEdge): number {
  switch (edge) {
    case 'left':
      return b.left
    case 'hcenter':
      return (b.left + b.right) / 2
    case 'right':
      return b.right
    case 'top':
      return b.top
    case 'vmiddle':
      return (b.top + b.bottom) / 2
    case 'bottom':
      return b.bottom
  }
}

function isHorizontal(edge: AlignEdge): boolean {
  return edge === 'left' || edge === 'hcenter' || edge === 'right'
}

/**
 * Move each item so its `edge` lines up with the same edge of the frame or
 * of the selection's bounds. One delta per item (zero when already aligned).
 */
export function alignDeltas(
  items: readonly LayoutItem[],
  edge: AlignEdge,
  relativeTo: AlignRelativeTo,
  frame: { w: number; h: number },
): LayoutDelta[] {
  if (items.length === 0) return []
  const ref =
    relativeTo === 'frame'
      ? { left: 0, top: 0, right: frame.w, bottom: frame.h }
      : unionBounds(items.map((i) => i.bounds))
  if (!ref) return []
  const target = edgeOf(ref, edge)
  const horizontal = isHorizontal(edge)
  return items.map((item) => {
    const d = target - edgeOf(item.bounds, edge)
    return { id: item.id, dx: horizontal ? d : 0, dy: horizontal ? 0 : d }
  })
}

/**
 * Space items so the gaps between neighbouring bounds are equal along
 * `axis`. Items are ordered by centre; the first and last stay put. Needs 3+
 * items (otherwise no deltas). Gaps may be negative if the objects overlap.
 */
export function distributeDeltas(
  items: readonly LayoutItem[],
  axis: DistributeAxis,
): LayoutDelta[] {
  if (items.length < 3) return []
  const lo = (b: Bounds) => (axis === 'h' ? b.left : b.top)
  const hi = (b: Bounds) => (axis === 'h' ? b.right : b.bottom)
  const sorted = [...items].sort((a, b) => {
    const ca = (lo(a.bounds) + hi(a.bounds)) / 2
    const cb = (lo(b.bounds) + hi(b.bounds)) / 2
    return ca - cb || lo(a.bounds) - lo(b.bounds)
  })
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (!first || !last) return []
  const middle = sorted.slice(1, -1)
  const middleSize = middle.reduce((sum, i) => sum + (hi(i.bounds) - lo(i.bounds)), 0)
  const gap = (lo(last.bounds) - hi(first.bounds) - middleSize) / (sorted.length - 1)
  const out: LayoutDelta[] = [
    { id: first.id, dx: 0, dy: 0 },
    { id: last.id, dx: 0, dy: 0 },
  ]
  let cursor = hi(first.bounds) + gap
  for (const item of middle) {
    const d = cursor - lo(item.bounds)
    out.push({ id: item.id, dx: axis === 'h' ? d : 0, dy: axis === 'h' ? 0 : d })
    cursor += hi(item.bounds) - lo(item.bounds) + gap
  }
  return out
}
