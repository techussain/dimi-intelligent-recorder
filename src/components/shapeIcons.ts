import { Circle, Minus, MoveRight, Square, type LucideIcon } from 'lucide-react'
import { useEditor } from '../lib/timeline/store'
import type { ShapeType } from '../lib/timeline/types'

export const SHAPE_ICONS: Record<ShapeType, LucideIcon> = {
  rect: Square,
  ellipse: Circle,
  line: Minus,
  arrow: MoveRight,
}

/** Add a shape at the playhead (selects it). */
export function addShapeAtPlayhead(type: ShapeType): void {
  const st = useEditor.getState()
  st.addShapeClip(type, st.playhead)
}
