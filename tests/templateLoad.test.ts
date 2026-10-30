// The Load template dialog's detail (#268): same-name replacements marked, and (#1436) each new agent's role in the
// workflow, note and pairing; every created agent works in the project folder. HI-2109: each on the connection the
// picker gives it (shown with what it runs), and the picker itself: what each role preselects (the first connection on
// the CLI it suggests, else the first usable), Same for all, a role's and an agent's own answers, Choose Connections'
// "keep", and the answers' keys and names checked.
import { describe, expect, it } from 'vitest'
import { connectionShown, connectionValues, roleShown, templateLoadDetail, templateLoadView } from '../src/shared/templateLoad'
import { answerFor, badAnswers, initialPicker, loadFallback, optionNamed, pickerAnswers, preselected, rolesOf, suggestedCli, type ConnectionOption } from '../src/shared/templateConnections'

const opt = (id: string, cli: string, extra: Partial<ConnectionOption> = {}): ConnectionOption => ({ id, name: id, account: `acc-${cli}`, accountName: cli === 'codex' ? 'Work' : 'Personal', cli, ...extra })
const options = [opt('Personal', 'claude-code'), opt('Claude · High', 'claude-code', { model: 'opus', effort: 'high', permissionMode: 'acceptEdits' }), opt('Work', 'codex')]

describe('the Load template dialog (#268)', () => {
  it('marks agents a new one of the same name replaces, with each agent\'s role, pairing and connection; a removed worktree agent\'s worktree stays', () => {
    const plan = {
      remove: [
        { id: 'a', name: 'Claude', running: false, dirty: 0, worktree: { path: 'D:/x/site/claude', branch: 'hive/claude' } },
        { id: 'b', name: 'Old', running: false, dirty: 0 }
      ],
      create: [
        { name: 'claude', role: 'builder' as const, note: 'UI', provider: 'claude-code' as const },
        { name: 'Reviewer', role: 'reviewer' as const, provider: 'codex' as const }
      ],
      pairs: [{ builder: 0, reviewer: 1 }]
    }
    const at = (i: number): ConnectionOption | null => [options[1], null][i]
    const text = templateLoadDetail(plan, at)
    expect(text).toContain('• Claude (its worktree and branch hive/claude stay): replaced by a new agent with the same name')
    expect(text).toContain('• Old\n')
    expect(text).toMatch(/• claude — Builder \(paired: Reviewer\) \(new\): Claude · High \(opus · High · \S[^)]*\)\n/)
    expect(text).toContain('• Reviewer — Reviewer (paired: claude): no connection\n')
    // No worktree anywhere: nothing said of one for the created agents.
    expect(text).not.toMatch(/own worktree|reuses|setup command/)
    // Nothing removed: no Removed list and nothing about removed agents.
    const fresh = templateLoadDetail({ ...plan, remove: [] }, at)
    expect(fresh.startsWith('Created:')).toBe(true)
    expect(fresh).not.toMatch(/replaced|\(new\)|conversations stay/)
    expect(roleShown({ role: 'either' })).toBe('Either')
  })

  it("as a table (#511): each created agent in the template's order, its role, note, pairing, suggested CLI and connection", () => {
    const plan = {
      remove: [{ id: 'a', name: 'Claude', running: false, dirty: 0, worktree: { path: 'D:/x/site/claude', branch: 'hive/claude' } }],
      create: [
        { name: 'HI-B1', role: 'builder' as const, note: 'UI', provider: 'claude-code' as const },
        { name: 'claude', role: 'either' as const },
        { name: 'HI-R1', role: 'reviewer' as const, provider: 'codex' as const }
      ],
      pairs: [{ builder: 0, reviewer: 2 }]
    }
    const v = templateLoadView(plan, (i) => [options[0], options[0], options[2]][i])
    expect(v.created.map((a) => [a.name, a.role, a.note, a.pairedWith, a.suggested, a.connection?.id, a.replaces])).toEqual([
      ['HI-B1', 'builder', 'UI', 'HI-R1', 'claude-code', 'Personal', false],
      ['claude', 'either', undefined, undefined, undefined, 'Personal', true],
      ['HI-R1', 'reviewer', undefined, 'HI-B1', 'codex', 'Work', false]
    ])
    expect(v.removed).toEqual([{ name: 'Claude', note: 'its worktree and branch hive/claude stay', replaced: true }])
    expect(v.notes).toEqual(["Their conversations stay in the Sessions tab, and their open cards go back (Active ones to Todo). The layout becomes the template's."])
  })

  it("says what a connection runs: its own values, else its CLI's defaults", () => {
    expect(connectionValues(options[0])).toBe('Claude Code defaults')
    expect(connectionValues(opt('x', 'claude-code', { model: 'sonnet', use200kContext: true }))).toBe('sonnet · 200K')
    expect(connectionShown(options[2])).toBe('Work (Codex defaults)')
  })
})

describe('the connection picker (HI-2109)', () => {
  const agents = [
    { key: 'k1', name: 'HB1', role: 'builder' as const, provider: 'claude-code' },
    { key: 'k2', name: 'HB2', role: 'builder' as const, provider: 'claude-code' },
    { key: 'k3', name: 'HR1', role: 'reviewer' as const, provider: 'codex' },
    { key: 'k4', name: 'G1', role: 'generalist' as const }
  ]

  it('each role preselects the first connection on the CLI its agents suggest, else the first usable', () => {
    expect(rolesOf(agents)).toEqual(['builder', 'reviewer', 'generalist'])
    expect([suggestedCli(agents, 'builder'), suggestedCli(agents, 'reviewer'), suggestedCli(agents, 'generalist'), suggestedCli(agents, '*')]).toEqual(['claude-code', 'codex', undefined, 'claude-code'])
    expect([preselected(options, 'codex'), preselected(options, 'copilot'), preselected(options, undefined), preselected([], 'codex')]).toEqual(['Work', 'Personal', 'Personal', undefined])
    expect(initialPicker(agents, options)).toEqual({ same: false, all: 'Personal', roles: { builder: 'Personal', reviewer: 'Work', generalist: 'Personal' }, agents: {} })
    // Nothing answered: each its role's preselected one.
    expect(answerFor(agents, {}, loadFallback(agents, options))).toEqual(['Personal', 'Personal', 'Work', 'Personal'])
  })

  it("an agent's own answer (by its key) over its role's over all's", () => {
    const answers = { all: 'Work', roles: { builder: 'Claude · High' }, agents: { k2: 'Personal' } }
    expect(answerFor(agents, answers, loadFallback(agents, options))).toEqual(['Claude · High', 'Personal', 'Work', 'Work'])
    // Choose Connections…: none for an agent keeps its own (undefined).
    expect(answerFor(agents, { roles: { reviewer: 'Personal' } }, () => undefined)).toEqual([undefined, undefined, 'Personal', undefined])
  })

  it("an agent called Builder never stands for the builders (HR3's round 1): its own choice is its alone", () => {
    const two = [
      { key: 'a', name: 'Builder', role: 'builder' as const, provider: 'claude-code' },
      { key: 'b', name: 'Second', role: 'builder' as const, provider: 'claude-code' }
    ]
    const state = { same: false, all: '', roles: { builder: 'c-default' }, agents: { 0: 'c-special' } }
    expect(answerFor(two, pickerAnswers(state, two), () => undefined)).toEqual(['c-special', 'c-default'])
  })

  it("an agent's own choice stays with that agent when the list changes before it is used (HR3's round 2): never another's", () => {
    const shown = [
      { key: 'a', name: 'A', role: 'builder' as const },
      { key: 'b', name: 'Second', role: 'builder' as const }
    ]
    const answers = pickerAnswers({ same: false, all: '', roles: {}, agents: { 0: 'c-special' } }, shown)
    expect(answers).toEqual({ agents: { a: 'c-special' } })
    // A removed: Second never gets A's choice, and the answer names an agent the list hasn't (refused where it is used).
    expect(answerFor([shown[1]], answers, () => undefined)).toEqual([undefined])
    expect(badAnswers(['b'], answers)).toEqual(['agent a'])
    // Moved: the choice follows A.
    expect(answerFor([shown[1], shown[0]], answers, () => undefined)).toEqual([undefined, 'c-special'])
  })

  it("the picker's state as answers: Same for all alone, else each role's and each agent's own by its key", () => {
    const state = { same: false, all: 'Work', roles: { builder: 'Claude · High', reviewer: '' }, agents: { 1: 'Personal', 3: '' } }
    expect(pickerAnswers(state, agents)).toEqual({ roles: { builder: 'Claude · High' }, agents: { k2: 'Personal' } })
    expect(pickerAnswers({ ...state, same: true }, agents)).toEqual({ all: 'Work' })
    // Keep (''), all of it: nothing answered.
    expect(pickerAnswers(initialPicker(agents, options, () => ''), agents)).toEqual({})
  })

  it("answers name a role or an agent it has, each a connection's id or a name only one has", () => {
    const keys = agents.map((a) => a.key)
    expect(badAnswers(keys, { all: 'x', roles: { builder: 'x', builders: 'x' }, agents: { k3: 'x', k9: 'x' } })).toEqual(['role builders', 'agent k9'])
    expect(badAnswers(keys, { builder: 'x' })).toEqual(['builder'])
    expect([badAnswers(keys, undefined), badAnswers(keys, 'x'), badAnswers(keys, { roles: { builder: 5 } })]).toEqual([[], ['x'], ['role builder']])
    const two = [...options, opt('c-1', 'codex', { name: 'Same' }), opt('c-2', 'codex', { name: 'Same', account: 'acc-2' })]
    expect(optionNamed(two, 'personal')).toMatchObject({ ok: true, option: { id: 'Personal' } })
    expect(optionNamed(two, 'c-2')).toMatchObject({ ok: true, option: { id: 'c-2' } })
    expect(optionNamed(two, 'same')).toEqual({ ok: false, why: 'ambiguous', ids: ['c-1', 'c-2'] })
    expect(optionNamed(two, 'Gone')).toEqual({ ok: false, why: 'unknown' })
  })
})
