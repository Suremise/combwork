// HI-3276: one in-process listener that throws (outageResume's did, for a CLI with no connection pattern) is logged
// and skipped: the listeners after it still get the event, and the code that emitted it carries on.
import { describe, expect, it } from 'vitest'
import type { CombworkEvent } from '../src/shared/types'
import { emit, onCombworkEvent, tellListeners } from '../src/main/events'

describe('in-process event listeners', () => {
  it('a listener that throws neither stops the ones after it nor reaches the emitter', () => {
    const seen: string[] = []
    const offs = [
      onCombworkEvent(() => {
        throw new Error('a listener broke')
      }),
      onCombworkEvent((e) => void seen.push(e.type))
    ]
    try {
      const ev = { type: 'advanced-changed' } as CombworkEvent
      expect(() => emit(ev)).not.toThrow()
      expect(() => tellListeners(ev)).not.toThrow()
      expect(seen).toEqual(['advanced-changed', 'advanced-changed'])
    } finally {
      for (const off of offs) off()
    }
  })
})
