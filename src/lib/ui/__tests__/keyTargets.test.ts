import { describe, expect, it } from 'vitest'
import { isTextEntryTarget } from '../keyTargets'

const input = (type: string) => {
  const el = document.createElement('input')
  el.type = type
  return el
}

describe('isTextEntryTarget', () => {
  it('keeps native undo for text fields', () => {
    for (const t of ['text', 'search', 'email', 'url', 'tel', 'password', 'number'])
      expect(isTextEntryTarget(input(t))).toBe(true)
    expect(isTextEntryTarget(document.createElement('textarea'))).toBe(true)
  })

  it('lets app undo work on controls without text undo', () => {
    for (const t of ['range', 'checkbox', 'radio', 'color', 'button', 'file'])
      expect(isTextEntryTarget(input(t))).toBe(false)
    expect(isTextEntryTarget(document.createElement('select'))).toBe(false)
    expect(isTextEntryTarget(document.createElement('button'))).toBe(false)
    expect(isTextEntryTarget(document.body)).toBe(false)
    expect(isTextEntryTarget(null)).toBe(false)
  })
})
