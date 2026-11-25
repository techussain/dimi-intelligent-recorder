/** Input types where the user types text and expects the field's own undo. */
const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
])

/**
 * Focus is in a control with its own text undo (text inputs, textareas,
 * contenteditable). Sliders, colour pickers, checkboxes and dropdowns have
 * none, so app-level Ctrl+Z / Ctrl+Y must still work when they're focused —
 * focus stays on them after you use them in the Inspector.
 */
export function isTextEntryTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true
  if (el.tagName !== 'INPUT') return false
  return TEXT_INPUT_TYPES.has((el as HTMLInputElement).type)
}
