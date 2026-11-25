import { ScrubbableInput } from '../ui/ScrubbableInput'
import { useEditor } from '../../lib/timeline/store'
import type { MediaSource } from '../../lib/timeline/types'
import { getTemplate, resolveParams } from '../../lib/elements'
import { Section } from './fields'

/**
 * Inspector section for an Elements-pack clip: one control per template
 * parameter (text / dropdown, colour, number). Edits are undoable and
 * consecutive edits of the same element coalesce into one undo step.
 */
export function ElementSection({ source }: { source: MediaSource }) {
  const updateElementParams = useEditor((s) => s.updateElementParams)
  const beginInteraction = useEditor((s) => s.beginInteraction)
  const endInteraction = useEditor((s) => s.endInteraction)
  const scrub = { onScrubStart: beginInteraction, onScrubEnd: endInteraction }
  const info = source.element
  const tpl = info ? getTemplate(info.template) : undefined
  if (!info || !tpl) return null
  const values = resolveParams(tpl, info.params as Record<string, string | number>)
  const patch = (key: string, v: string | number) =>
    updateElementParams(source.id, { [key]: v })

  return (
    <Section label={`Element · ${tpl.name}`}>
      {tpl.params.map((def) => {
        const value = values[def.key]
        switch (def.kind) {
          case 'text':
            return def.options ? (
              <label key={def.key} className="flex items-center justify-between gap-2">
                <span className="text-muted text-[11px]">{def.label}</span>
                <select
                  value={String(value ?? '')}
                  onChange={(e) => patch(def.key, e.currentTarget.value)}
                  className="bg-surface border border-bd rounded px-1.5 py-1 text-[11px] focus:border-accent focus:outline-none"
                >
                  {def.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label key={def.key} className="block space-y-1">
                <span className="text-muted text-[11px]">{def.label}</span>
                <input
                  type="text"
                  value={String(value ?? '')}
                  maxLength={def.maxLength}
                  onChange={(e) => patch(def.key, e.currentTarget.value)}
                  className="w-full bg-surface border border-bd rounded px-2 py-1 text-[11px] focus:border-accent focus:outline-none"
                />
              </label>
            )
          case 'color':
            return (
              <label key={def.key} className="flex items-center justify-between gap-2">
                <span className="text-muted text-[11px]">{def.label}</span>
                <input
                  type="color"
                  value={String(value ?? '#000000')}
                  onChange={(e) => patch(def.key, e.currentTarget.value)}
                  className="w-8 h-6 rounded bg-surface border border-bd cursor-pointer"
                />
              </label>
            )
          case 'number':
            return (
              <ScrubbableInput
                key={def.key}
                label={def.label}
                value={typeof value === 'number' ? value : def.min}
                step={def.step ?? 1}
                min={def.min}
                max={def.max}
                {...scrub}
                onCommit={(v) =>
                  patch(def.key, Math.max(def.min, Math.min(def.max, v)))
                }
              />
            )
        }
      })}
    </Section>
  )
}
