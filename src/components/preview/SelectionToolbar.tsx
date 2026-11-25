import { useLayoutEffect, useRef, useState } from 'react'
import type { Bounds } from '../../lib/layout/geometry'
import type { ID } from '../../lib/timeline/types'
import { AlignControls } from '../layout/AlignControls'
import { TransformControls } from '../layout/TransformControls'
import { LayerControls } from '../layout/LayerControls'

/** Toolbar height (CSS px) used to keep it on the stage. */
const TOOLBAR_H = 32
const GAP = 8
/** Room the single-selection rotate handle takes above the box. */
const ROTATE_HANDLE_ROOM = 44

/**
 * Floating contextual toolbar over the preview selection: align, distribute
 * and the Frame / Selection reference, then flip / fit / fill / reset, the
 * Crop / Anchor modes and layer order. Sits above the selection's group box,
 * flips below it when there's no room, and falls back to the stage top.
 */
export function SelectionToolbar({
  bounds,
  projectW,
  projectH,
  stageW,
  stageH,
  count,
  hasRotateHandle,
  ids,
  crop,
  anchor,
}: {
  /** Selection group bounds (project px). */
  bounds: Bounds
  projectW: number
  projectH: number
  /** Displayed stage size (CSS px). */
  stageW: number
  stageH: number
  count: number
  hasRotateHandle: boolean
  /** Selected clips visible at the playhead (transform tools act on them). */
  ids: readonly ID[]
  crop?: { active: boolean; toggle: () => void } | undefined
  anchor?: { active: boolean; toggle: () => void } | undefined
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Measured width (keeps the toolbar on the stage); a guess until measured.
  const [width, setWidth] = useState(480)
  const hasCrop = !!crop
  const hasAnchor = !!anchor
  useLayoutEffect(() => {
    const w = ref.current?.offsetWidth
    if (w) setWidth(w)
  }, [count, hasCrop, hasAnchor, stageW])
  if (stageW <= 0 || stageH <= 0) return null
  const kx = stageW / projectW
  const ky = stageH / projectH
  const top = bounds.top * ky
  const bottom = bounds.bottom * ky
  const centerX = ((bounds.left + bounds.right) / 2) * kx
  const above = top - GAP - TOOLBAR_H - (hasRotateHandle ? ROTATE_HANDLE_ROOM : 0)
  const below = bottom + GAP
  let y: number
  if (above >= 0) y = above
  else if (below + TOOLBAR_H <= stageH) y = below
  else y = 18
  const half = Math.min(width / 2, stageW / 2)
  const x = Math.min(Math.max(centerX, half), stageW - half)

  return (
    <div
      ref={ref}
      className="absolute z-20 w-max flex items-center gap-1 rounded-lg border border-bd bg-elevated/95 shadow-pop px-1.5 py-1 backdrop-blur-sm whitespace-nowrap"
      style={{ left: x, top: y, transform: 'translateX(-50%)' }}
      data-selection-toolbar
      role="toolbar"
      aria-label="Arrange selection"
      // Keep keyboard focus on the stage (arrow-key nudge) and never start a
      // selection gesture underneath.
      onPointerDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <AlignControls count={count} />
      <span className="w-px h-4 bg-bd mx-0.5" aria-hidden />
      <TransformControls ids={ids} crop={crop} anchor={anchor} />
      <span className="w-px h-4 bg-bd mx-0.5" aria-hidden />
      <LayerControls ids={ids} />
    </div>
  )
}
