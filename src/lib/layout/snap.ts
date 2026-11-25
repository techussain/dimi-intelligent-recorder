/**
 * Smart-guide snapping. Pure: given the bounds being moved and the candidate
 * lines (frame edges & centre, safe margins, other objects' edges/centres),
 * find the smallest correction within a threshold and the guides to draw.
 */
import type { Bounds } from './geometry'

export type GuideKind = 'frame' | 'center' | 'safe' | 'object'

/**
 * A snap line. `pos` is x for vertical lines (the `x` list) and y for
 * horizontal ones. `start` / `end` = the extent along the other axis to draw
 * the guide over (omitted = the whole frame).
 */
export interface SnapLine {
  pos: number
  kind: GuideKind
  label?: string
  start?: number
  end?: number
}

export interface SnapTargets {
  x: SnapLine[]
  y: SnapLine[]
}

/** A guide to draw: a vertical line (axis 'x') at x = pos, or horizontal. */
export interface Guide {
  axis: 'x' | 'y'
  pos: number
  kind: GuideKind
  label?: string
  /** Extent along the other axis, or null = the whole frame. */
  from: number | null
  to: number | null
}

export interface SnapResult {
  dx: number
  dy: number
  guides: Guide[]
}

/** Title-safe (80 %) and action-safe (90 %) areas as insets per side. */
export const SAFE_MARGINS = [
  { label: 'Title safe', inset: 0.1 },
  { label: 'Action safe', inset: 0.05 },
] as const

/** Lines within this distance after snapping count as "aligned" for guides. */
const ALIGNED_EPS = 0.5

function best(
  candidates: readonly number[],
  lines: readonly SnapLine[],
  threshold: number,
): number {
  let delta = 0
  let bestDist = Infinity
  for (const line of lines) {
    for (const c of candidates) {
      const d = line.pos - c
      const dist = Math.abs(d)
      if (dist <= threshold && dist < bestDist) {
        bestDist = dist
        delta = d
      }
    }
  }
  return delta
}

function guidesFor(
  axis: 'x' | 'y',
  candidates: readonly number[],
  lines: readonly SnapLine[],
  moving: Bounds,
): Guide[] {
  const out: Guide[] = []
  const seen = new Set<string>()
  const movLo = axis === 'x' ? moving.top : moving.left
  const movHi = axis === 'x' ? moving.bottom : moving.right
  for (const line of lines) {
    if (!candidates.some((c) => Math.abs(line.pos - c) <= ALIGNED_EPS)) continue
    const key = `${Math.round(line.pos * 2)}:${line.kind}`
    if (seen.has(key)) continue
    seen.add(key)
    const g: Guide = {
      axis,
      pos: line.pos,
      kind: line.kind,
      from: line.start === undefined ? null : Math.min(line.start, movLo),
      to: line.end === undefined ? null : Math.max(line.end, movHi),
    }
    if (line.label !== undefined) g.label = line.label
    out.push(g)
  }
  return out
}

function edgesX(b: Bounds): number[] {
  return [b.left, (b.left + b.right) / 2, b.right]
}

function edgesY(b: Bounds): number[] {
  return [b.top, (b.top + b.bottom) / 2, b.bottom]
}

/**
 * Snap `moving`'s left/centre/right to the nearest `targets.x` line and its
 * top/middle/bottom to the nearest `targets.y` line, each only when within
 * `thresholdProjPx`. Returns the correction and the guides that now line up.
 */
export function computeSnap(
  moving: Bounds,
  targets: SnapTargets,
  thresholdProjPx: number,
): SnapResult {
  const dx = best(edgesX(moving), targets.x, thresholdProjPx)
  const dy = best(edgesY(moving), targets.y, thresholdProjPx)
  const snapped: Bounds = {
    left: moving.left + dx,
    right: moving.right + dx,
    top: moving.top + dy,
    bottom: moving.bottom + dy,
  }
  return {
    dx,
    dy,
    guides: [
      ...guidesFor('x', edgesX(snapped), targets.x, snapped),
      ...guidesFor('y', edgesY(snapped), targets.y, snapped),
    ],
  }
}

/**
 * Snap one value (e.g. the edge a resize handle drags) to the nearest line
 * within the threshold. Returns the corrected value and the line, or null.
 */
export function snapValue(
  value: number,
  lines: readonly SnapLine[],
  thresholdProjPx: number,
): { value: number; line: SnapLine } | null {
  let found: SnapLine | null = null
  let bestDist = Infinity
  for (const line of lines) {
    const dist = Math.abs(line.pos - value)
    if (dist <= thresholdProjPx && dist < bestDist) {
      bestDist = dist
      found = line
    }
  }
  return found ? { value: found.pos, line: found } : null
}

/**
 * Standard targets: frame edges and centre, safe margins, and the edges and
 * centres of `objects` (the other visible objects' bounds).
 */
export function buildSnapTargets(
  frame: { w: number; h: number },
  objects: readonly Bounds[],
): SnapTargets {
  const x: SnapLine[] = [
    { pos: 0, kind: 'frame', label: 'Frame' },
    { pos: frame.w / 2, kind: 'center', label: 'Centre' },
    { pos: frame.w, kind: 'frame', label: 'Frame' },
  ]
  const y: SnapLine[] = [
    { pos: 0, kind: 'frame', label: 'Frame' },
    { pos: frame.h / 2, kind: 'center', label: 'Centre' },
    { pos: frame.h, kind: 'frame', label: 'Frame' },
  ]
  for (const m of SAFE_MARGINS) {
    x.push({ pos: frame.w * m.inset, kind: 'safe', label: m.label })
    x.push({ pos: frame.w * (1 - m.inset), kind: 'safe', label: m.label })
    y.push({ pos: frame.h * m.inset, kind: 'safe', label: m.label })
    y.push({ pos: frame.h * (1 - m.inset), kind: 'safe', label: m.label })
  }
  for (const b of objects) {
    for (const pos of edgesX(b))
      x.push({ pos, kind: 'object', start: b.top, end: b.bottom })
    for (const pos of edgesY(b))
      y.push({ pos, kind: 'object', start: b.left, end: b.right })
  }
  return { x, y }
}
