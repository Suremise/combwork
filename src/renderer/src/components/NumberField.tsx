import { useEffect, useRef, useState } from 'react'
import { parseNumberDraft } from '@shared/numberInput'

/**
 * A number setting's box, saved on blur or Enter (once). A blank box keeps the saved value, or inherits where
 * `inherit` is given; text that isn't a number in range shows a message under the box and saves nothing. Where
 * 0 turns the feature off, `off` adds a checkbox for it: ticking saves 0, unticking brings back the last other
 * value (or `off.restore`). `live` (a form staging its draft, HI-2058): each value in range is passed on as it is typed
 * or stepped, so the form sees the change before the box loses focus; a blank or invalid box still waits for blur.
 */
export function NumberField({
  value,
  min,
  max,
  step,
  off,
  inherit,
  label,
  unit,
  live,
  disabled,
  onCommit
}: {
  value: number | null
  min?: number
  max?: number
  step?: number
  off?: { label: string; restore: number | null }
  /** Placeholder for an empty box, which saves null (inherit). Without it, a blank box keeps the saved value. */
  inherit?: string
  label?: string
  /** The number's unit, shown after the box ("s"). */
  unit?: string
  live?: boolean
  /** The box and its Off checkbox can't be changed (a save in progress, a setting that doesn't apply now). */
  disabled?: boolean
  onCommit: (value: number | null) => Promise<unknown> | void
}) {
  const shown = (v: number | null): string => (v === null ? '' : String(v))
  const [draft, setDraft] = useState(shown(value))
  const [error, setError] = useState<string | null>(null)
  // A value being saved, shown until the save ends (so Off ticks at once).
  const [saving, setSaving] = useState<{ value: number | null } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const current = useRef(value)
  current.current = value
  // What unticking Off brings back.
  const lastOn = useRef<number | null>(value ? value : null)
  if (value) lastOn.current = value
  useEffect(() => setDraft(shown(value)), [value])
  const isOff = !!off && (saving ? saving.value : value) === 0

  const reset = (): void => {
    setDraft(shown(current.current))
    // A number box holding text it can't read reports "", so React may not see a change to put right.
    if (input.current) input.current.value = shown(current.current)
  }
  // Saves go one at a time, so an older one can't finish last (a blur's number, then Never at once); a choice
  // replaced before its turn is skipped.
  const queue = useRef({ tail: Promise.resolve(), latest: 0, done: 0 })
  const save = (v: number | null): void => {
    setError(null)
    const q = queue.current
    if (q.done === q.latest && v === current.current) return reset()
    const n = ++q.latest
    setSaving({ value: v })
    q.tail = q.tail.then(async () => {
      if (n !== q.latest) return
      try {
        if (v !== current.current) await onCommit(v)
      } finally {
        if (n === q.latest) {
          q.done = n
          setSaving(null)
          // A failed save leaves the setting as it was: show that, not the draft.
          reset()
        }
      }
    }).catch(() => undefined)
  }
  const commit = (): void => {
    const r = parseNumberDraft(draft, { min, max }, { badInput: input.current?.validity.badInput, off: !!off })
    if (r.kind === 'invalid') {
      setError(r.message)
      reset()
    } else if (r.kind === 'blank') {
      if (inherit !== undefined) save(null)
      else {
        setError(null)
        reset()
      }
    } else save(r.value)
  }

  return (
    <div className="number-field">
      <div className="number-field-row">
        <input
          ref={input}
          className="input"
          type="number"
          aria-label={label}
          min={min}
          max={max}
          step={step ?? 1}
          disabled={isOff || disabled}
          value={isOff ? '' : draft}
          placeholder={isOff ? off.label : inherit}
          onChange={(e) => {
            setDraft(e.target.value)
            setError(null)
            if (!live) return
            const r = parseNumberDraft(e.target.value, { min, max }, { badInput: e.target.validity.badInput, off: !!off })
            // Passed on as it is, with no reset: the box keeps what is typed (the form's draft only stages it).
            if (r.kind === 'value' && r.value !== current.current) void Promise.resolve(onCommit(r.value)).catch(() => undefined)
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            else if (e.key === 'Escape') {
              setError(null)
              reset()
            }
          }}
        />
        {unit && <span className="muted number-field-unit">{unit}</span>}
        {off && (
          <label className="flex muted number-field-off">
            <input type="checkbox" className="checkbox" checked={isOff} disabled={disabled} onChange={(e) => save(e.target.checked ? 0 : (lastOn.current ?? off.restore))} /> {off.label}
          </label>
        )}
      </div>
      {error && <div className="field-error">{error}</div>}
    </div>
  )
}
