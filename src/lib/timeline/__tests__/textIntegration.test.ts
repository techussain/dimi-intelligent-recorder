import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useEditor } from '../store'
import { parse, serialize } from '../../persistence/project'
import { DEFAULT_TEXT_FONT } from '../../text/fonts'

vi.mock('../../storage/blobCache', () => ({ releaseAll: vi.fn() }))

describe('text clips', () => {
  beforeEach(() => {
    useEditor.getState().newProject()
  })

  it('new text uses the bundled font', () => {
    const id = useEditor.getState().addTextClip(null, 0)
    const st = useEditor.getState()
    const clip = st.project.clips.find((c) => c.id === id)
    const src = st.project.sources.find((s) => s.id === clip?.sourceId)
    expect(src?.text?.fontFamily).toBe(DEFAULT_TEXT_FONT)
  })

  it('a duplicated text clip gets its own text (editing it leaves the original)', () => {
    const id = useEditor.getState().addTextClip(null, 0, { content: 'Original' })
    const copyId = useEditor.getState().duplicateClip(id, 10)
    expect(copyId).toBeTruthy()
    const st = useEditor.getState()
    const orig = st.project.clips.find((c) => c.id === id)!
    const copy = st.project.clips.find((c) => c.id === copyId)!
    expect(copy.sourceId).not.toBe(orig.sourceId)
    useEditor.getState().updateTextStyle(copy.sourceId, { content: 'Edited copy' })
    const after = useEditor.getState().project.sources
    expect(after.find((s) => s.id === orig.sourceId)?.text?.content).toBe('Original')
    expect(after.find((s) => s.id === copy.sourceId)?.text?.content).toBe('Edited copy')
  })

  it('formatting fields survive save and reload', () => {
    const id = useEditor.getState().addTextClip(null, 0)
    const clip = useEditor.getState().project.clips.find((c) => c.id === id)!
    useEditor.getState().updateTextStyle(clip.sourceId, {
      italic: true,
      underline: true,
      letterSpacing: 0.1,
      lineHeight: 1.5,
      boxWidth: 800,
      background: '#7C3AED',
      backgroundOpacity: 0.8,
      backgroundPadding: 0.3,
      backgroundRadius: 12,
      shadowColor: '#000000',
      shadowBlur: 6,
      shadowOffsetX: 2,
      shadowOffsetY: 3,
    })
    const loaded = parse(serialize(useEditor.getState().project))
    const text = loaded.sources.find((s) => s.id === clip.sourceId)?.text
    expect(text).toMatchObject({
      italic: true,
      underline: true,
      letterSpacing: 0.1,
      lineHeight: 1.5,
      boxWidth: 800,
      backgroundOpacity: 0.8,
      backgroundPadding: 0.3,
      backgroundRadius: 12,
      shadowColor: '#000000',
      shadowBlur: 6,
      shadowOffsetX: 2,
      shadowOffsetY: 3,
    })
  })
})
