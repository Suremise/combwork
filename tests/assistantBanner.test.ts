// HI-2899: what the Assistant panel says while the Assistant can't start for want of an account, and the CLI it names:
// the one its launch would pick (decision A: an Assistant that names no CLI runs the first usable account's), never Claude
// Code by default.
import { describe, expect, it } from 'vitest'
import { assistantCli, assistantNeed, type CliReady } from '../src/shared/connectionLabel'
import type { ConnectionsView } from '../src/shared/accounts'
import type { Account } from '../src/shared/types'

type Acc = ConnectionsView['connections'][number]
const acc = (id: string, cli: Account['provider'], over: Partial<Acc> = {}): Acc => ({ id, provider: cli, name: `Account ${id}`, createdAt: '', signingIn: false, folder: '', ...over })
const row = (id: string, account: string): ConnectionsView['connectionRows'][number] => ({ id, account, name: `Name ${id}`, users: [] })
const view = (over: Partial<ConnectionsView> = {}): ConnectionsView => ({ providers: ['claude-code', 'codex'], connections: [], workspace: {}, testHome: [], order: [], homes: [], connectionRows: [], ...over })
const settings = { providers: { 'claude-code': { enabled: true }, codex: { enabled: true } } } as never
const all: CliReady = () => 'yes'
const signedOut = (a: Account): boolean => !!a.observed && a.observed.loggedIn === false
// The renderer's Automatic pick on a fresh install: Claude Code, the first turned on.
const AUTO = 'claude-code' as const
const automatic = {}

/** Its CLI and what it needs, as the panel works them out. */
const need = (a: { provider?: string; connection?: string }, v: ConnectionsView) => assistantNeed(a, assistantCli(a, v, settings, all, (a.provider as never) || AUTO), v, settings, all, signedOut)

describe('the Assistant panel when the Assistant cannot start for want of an account (HI-2899)', () => {
  it('a fresh install with no account: provider-neutral, Add an Account', () => {
    expect(need(automatic, view())).toEqual({ kind: 'noneAny' })
  })

  it('only a Codex account, on here: the Assistant starts on Codex, so no banner (never "No Claude Code account")', () => {
    const v = view({ connections: [acc('x', 'codex')], order: ['x'], connectionRows: [row('x1', 'x')], workspace: { codex: { on: ['x'], default: 'x' } } })
    expect(assistantCli(automatic, v, settings, all, AUTO)).toBe('codex')
    expect(need(automatic, v)).toEqual({ kind: 'ok' })
  })

  it('only a Codex account, off here: it is offered (Turn On Here), as any CLI would be', () => {
    const v = view({ connections: [acc('x', 'codex')], order: ['x'], connectionRows: [row('x1', 'x')] })
    expect(need(automatic, v)).toEqual({ kind: 'off', choice: { kind: 'one', id: 'x', name: 'Account x', cli: 'codex' } })
  })

  it("its connection's account signed out: that connection named, to sign in again", () => {
    const v = view({ connections: [acc('a', 'claude-code', { observed: { at: '', loggedIn: false } as never })], order: ['a'], connectionRows: [row('a1', 'a')], workspace: { 'claude-code': { on: ['a'], default: 'a' } } })
    expect(need({ provider: 'claude-code', connection: 'a1' }, v)).toEqual({ kind: 'signedOut', name: 'Name a1', cli: 'claude-code' })
    // Signed in, or never checked: nothing to say.
    const ok = view({ ...v, connections: [acc('a', 'claude-code')] })
    expect(need({ provider: 'claude-code', connection: 'a1' }, ok)).toEqual({ kind: 'ok' })
    // A server account has no sign-in.
    const server = view({ ...v, connections: [acc('a', 'claude-code', { kind: 'server', observed: { at: '', loggedIn: false } as never })] })
    expect(need({ provider: 'claude-code', connection: 'a1' }, server)).toEqual({ kind: 'ok' })
  })

  it("its own CLI chosen, none of that CLI's on here: named, with the Assistant's settings when another CLI's account would do", () => {
    const codexOn = view({ connections: [acc('x', 'codex')], order: ['x'], connectionRows: [row('x1', 'x')], workspace: { codex: { on: ['x'], default: 'x' } } })
    expect(need({ provider: 'claude-code' }, codexOn)).toEqual({ kind: 'noneFor', cli: 'claude-code', others: true })
    expect(need({ provider: 'claude-code' }, view())).toEqual({ kind: 'noneFor', cli: 'claude-code', others: false })
  })

  it("its chosen connection's account off here: that CLI's accounts off here offered", () => {
    const v = view({ connections: [acc('a', 'claude-code'), acc('x', 'codex')], order: ['a', 'x'], connectionRows: [row('a1', 'a'), row('x1', 'x')] })
    expect(need({ provider: 'claude-code', connection: 'a1' }, v)).toEqual({ kind: 'off', choice: { kind: 'one', id: 'a', name: 'Account a', cli: 'claude-code' } })
  })

  it('no account missing: nothing while the CLIs are looked for, or with an account on here whose CLI isn\'t installed', () => {
    const v = view({ connections: [acc('x', 'codex')], order: ['x'], connectionRows: [row('x1', 'x')], workspace: { codex: { on: ['x'], default: 'x' } } })
    const codexMissing: CliReady = (c) => (c === 'codex' ? 'no' : 'yes')
    const looking: CliReady = () => 'checking'
    for (const ready of [codexMissing, looking]) expect(assistantNeed(automatic, assistantCli(automatic, v, settings, ready, AUTO), v, settings, ready, signedOut)).toEqual({ kind: 'ok' })
    // No account at all: add one, whatever the CLIs' detection says.
    expect(assistantNeed(automatic, AUTO, view(), settings, looking, signedOut)).toEqual({ kind: 'noneAny' })
  })

  it('running, or a test copy on its CLI test home: nothing', () => {
    expect(assistantCli({ live: { provider: 'codex' } }, view(), settings, all, AUTO)).toBe('codex')
    expect(need(automatic, view({ testHome: ['claude-code'] }))).toEqual({ kind: 'ok' })
  })
})
