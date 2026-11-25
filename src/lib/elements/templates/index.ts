import type { ElementTemplate } from '../types'
import { arrow } from './arrow'
import { bell } from './bell'
import { countdown } from './countdown'
import { follow } from './follow'
import { highlightCircle } from './highlightCircle'
import { like } from './like'
import { lowerThird } from './lowerThird'
import { subscribe } from './subscribe'

/** All built-in element templates, in the order shown in the Elements panel. */
export const ELEMENT_TEMPLATES: readonly ElementTemplate[] = [
  subscribe,
  like,
  bell,
  follow,
  lowerThird,
  arrow,
  highlightCircle,
  countdown,
]

const BY_ID = new Map(ELEMENT_TEMPLATES.map((tpl) => [tpl.id, tpl]))

export function getTemplate(id: string): ElementTemplate | undefined {
  return BY_ID.get(id)
}
