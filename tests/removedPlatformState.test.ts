// HI-3510: what 1.6.0's jj left, read as unknown and left inert (no migration, SPEC §16.3.6): the descriptor helpers
// answer false for a platform id Combwork doesn't have, a stored refusal under a rule it no longer has shows nothing,
// the retired jj integration gates' requests are never open (an agent's ordinary question beside them still is), and a
// stored ruleset naming the retired `start.platformReady` loads without it.
import { describe, expect, it } from 'vitest'
import { accepts, declaresPaths, deliversCommits, hasCapability, hasOperation, merges, needsRepository, revisionShort, type PlatformId } from '../src/shared/platform/descriptors'
import { contradictions, preset } from '../src/shared/workflow/options'
import { isRule } from '../src/shared/workflow/refusals'
import { foldCard, type Actor, type Fact, type FactData, type FactKind } from '../src/shared/workflow/facts'
import { workView } from '../src/shared/workflow/workView'
import { loadRuleset, mustCompile } from '../src/shared/workflow/compile'

const jj = 'jj' as PlatformId

let seq = 0
const fact = <K extends FactKind>(kind: K, data: FactData[K], actor: Actor = 'combwork'): Fact => ({ seq: ++seq, card: 7, kind, at: `2026-11-22T10:00:${String(seq).padStart(2, '0')}.000Z`, actor, source: 'recorded', data })
const started = (): Fact[] => [fact('Started', { folder: 'project', line: 'cw/b1', base: 'base0000aaaa', target: 'main', builder: 'B1', cardKind: 'code' }, 'agent:B1'), fact('Moved', { from: 'todo', to: 'active', cause: 'intent' })]
const asked = (request: string, gate: string, asker?: string): Fact => fact('ApprovalRequested', { request, kind: 'decide', gate, text: `${gate}?`, ...(asker ? { asker } : {}) }, asker ? (`agent:${asker}` as Actor) : 'combwork')

describe("jj's state left by 1.6.0, read by a Combwork without jj (HI-3510)", () => {
  it('the descriptor helpers answer false for a platform Combwork no longer has, never throwing', () => {
    expect([merges(jj), accepts(jj), deliversCommits(jj), declaresPaths(jj), needsRepository(jj), hasCapability(jj, 'isolation'), hasOperation(jj, 'init')]).toEqual([false, false, false, false, false, false, false])
    expect(revisionShort(jj, '0123456789abcdef')).toBe('0123456')
    // Its saved options read as having no finish it declares, not a TypeError.
    expect(contradictions({ ...preset('git', 'pair'), platform: jj })).toContain('combworkMergesNeedsGit')
  })

  it("a stored refusal under a rule this Combwork no longer has isn't shown; one under a rule it has is", () => {
    seq = 0
    expect(isRule('platform.keptAcross')).toBe(false)
    expect(isRule('start.platformReady')).toBe(false)
    expect(isRule('evidence.changed')).toBe(true)
    const old = [...started(), fact('Refused', { move: 'start', rule: 'platform.keptAcross', message: 'x', next: 'y' }, 'agent:B1')]
    expect(workView({ card: 7, stage: 'active', preWorkflow: false }, old).refused).toBeNull()
    const now = [...old, fact('Refused', { move: 'submit', rule: 'evidence.changed', message: 'x', next: 'y' }, 'agent:B1')]
    expect(workView({ card: 7, stage: 'active', preWorkflow: false }, now).refused).toMatchObject({ rule: 'evidence.changed', times: 1 })
  })

  it("the retired jj gates' requests are never open; an agent's question beside them stays one", () => {
    seq = 0
    const facts = [...started(), asked('r1', 'advanceStopped'), asked('r2', 'advanceUncertain'), asked('r3', 'advancePreview'), asked('q1', 'question', 'B1')]
    const s = foldCard(facts)
    expect(s.requests.map((r) => r.request)).toEqual(['q1'])
    // The same on a card whose rules name jj: its folded state holds the question, not the retired gates.
    expect(foldCard(facts, 'review').requests.map((r) => r.gate)).toEqual(['question'])
  })

  it('a stored ruleset naming the retired start.platformReady loads without it, the rest as it was', () => {
    const r = mustCompile(preset('git', 'pair'))
    const stored = { ...r, options: { ...r.options, platform: 'jj' }, guards: { ...r.guards, start: ['start.platformReady', ...(r.guards.start ?? [])] } }
    const loaded = loadRuleset(JSON.parse(JSON.stringify(stored)))
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.ruleset.guards.start).toEqual(r.guards.start ?? [])
    expect(loaded.ruleset.id).toBe(r.id)
    expect(loaded.ruleset.options.platform).toBe('jj')
    // Any other unknown guard still refuses to load.
    expect(loadRuleset({ ...stored, guards: { ...r.guards, start: ['start.neverWas'] } })).toMatchObject({ ok: false, error: 'unknownPiece', piece: 'start.neverWas' })
  })
})
