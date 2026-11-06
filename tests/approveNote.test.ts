// HI-2286: Approve takes an optional note. What it becomes (`approveNote`), which answers fit (`answerFits`: a decision
// with an approval only on an agent's question, and only as its note), and the payloads For you and the card's merge
// queue send (`approveAnswer`, `declineAnswer`).
import { describe, expect, it } from 'vitest'
import { answerFits, approveNote, QUEUE_ADVANCE_GATE, ROUND_LIMIT_GATE } from '../src/shared/workflow/facts'
import { approveAnswer, declineAnswer } from '../src/shared/workflow/workView'

const ask = { kind: 'approve' as const, gate: 'ask' }
const own = (gate: string) => ({ kind: 'approve' as const, gate })

describe('a note with Approve (HI-2286)', () => {
  it("is a decision on an agent's question, a reason where it offers one action, a comment on Combwork's own gates", () => {
    expect(approveNote(ask)).toBe('decision')
    expect(approveNote({ gate: 'ask', actions: [{ kind: 'done' }] })).toBe('reason')
    expect(approveNote({ gate: 'ask', actions: [{ kind: 'done' }, { kind: 'noCode' }] })).toBe('decision')
    for (const gate of ['review', 'okBefore', QUEUE_ADVANCE_GATE]) expect(approveNote({ gate })).toBe('comment')
  })

  it("answerFits: approved with a note and its decision on an agent's question only; never declined with one, never without the note", () => {
    expect(answerFits(ask, { outcome: 'approved', reply: true, decision: true }, 3)).toBe(true)
    expect(answerFits(ask, { outcome: 'approved', decision: true }, 3)).toBe(false)
    expect(answerFits(ask, { outcome: 'declined', reply: true, decision: true }, 3)).toBe(false)
    expect(answerFits({ ...ask, actions: [{ kind: 'done' }] }, { outcome: 'approved', reply: true, decision: true }, 3)).toBe(false)
    for (const gate of ['review', 'okBefore', QUEUE_ADVANCE_GATE]) {
      expect(answerFits(own(gate), { outcome: 'approved', reply: true, decision: true }, 3)).toBe(false)
      expect(answerFits(own(gate), { outcome: 'approved', reply: true }, 3)).toBe(true)
      expect(answerFits(own(gate), { outcome: 'approved' }, 3)).toBe(true)
    }
    expect(answerFits({ kind: 'decide', gate: ROUND_LIMIT_GATE }, { outcome: 'approved', reply: true, decision: true }, 3)).toBe(false)
  })

  it('the payloads: a bare Approve sends no reply, a note is trimmed, a Decline sends its reason', () => {
    expect(approveAnswer()).toEqual({ outcome: 'approved' })
    expect(approveAnswer('   ')).toEqual({ outcome: 'approved' })
    expect(approveAnswer('  keep the alias \n')).toEqual({ outcome: 'approved', reply: 'keep the alias' })
    expect(declineAnswer(' not yet ')).toEqual({ outcome: 'declined', reply: 'not yet' })
  })
})
