// A card's lines over its whole history (HI-1823): every line it has started on, kept across cycles and renames, so a
// card back from Done that starts again elsewhere (the project folder, after an override) still owns its earlier line,
// which the Changes tab never offers as a leftover and main never deletes while the card is open.
import { describe, expect, it } from 'vitest'
import { foldCard, type Fact, type FactKind } from '../../src/shared/workflow/facts'
import { workBadge, workView } from '../../src/shared/workflow/workView'

let seq = 0
const fact = <K extends FactKind>(kind: K, data: Fact<K>['data']): Fact => ({ seq: ++seq, card: 3, kind, at: new Date(seq * 1000).toISOString(), actor: 'user', source: 'recorded', data }) as unknown as Fact
const started = (folder: string, line: string) => fact('Started', { folder, line, base: 'b'.repeat(40), target: 'integration', builder: 'a-1', cardKind: 'code' } as never)

describe("a card's lines", () => {
  it('keeps every line it started on, across a new cycle and a rename', () => {
    seq = 0
    const facts = [
      started('slot-c', 'cw/AL/AL-3-x'),
      fact('Moved', { from: 'todo', to: 'active', cause: 'intent' } as never),
      fact('Moved', { from: 'active', to: 'done', cause: 'override' } as never),
      fact('Moved', { from: 'done', to: 'todo', cause: 'user' } as never),
      // Back from Done with no slot free: started again in the project folder, on main.
      started('project', 'main'),
      fact('Moved', { from: 'todo', to: 'active', cause: 'override' } as never)
    ]
    const s = foldCard(facts)
    expect([s.started?.line, s.lines]).toEqual(['main', ['cw/AL/AL-3-x', 'main']])
    const renamed = foldCard([...facts, fact('LineRenamed', { from: 'cw/AL/AL-3-x', to: 'cw/AL/AL-3-y', why: 'repair' } as never)])
    expect(renamed.lines).toEqual(['cw/AL/AL-3-y', 'main'])
  })

  it("is on the card's work view and badge, beside this cycle's line", () => {
    seq = 0
    const facts = [started('slot-c', 'cw/AL/AL-3-x'), fact('Moved', { from: 'todo', to: 'active', cause: 'intent' } as never), started('project', 'main')]
    const v = workView({ card: 3, column: 'doing', preWorkflow: false } as never, facts)
    expect([v.line, v.lines]).toEqual(['main', ['cw/AL/AL-3-x', 'main']])
    expect(workBadge(v).lines).toEqual(['cw/AL/AL-3-x', 'main'])
  })
})
