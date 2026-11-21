// Codex's Windows sandbox per home (HI-3490): a home's own setting wins, the others only fill in for one that names none;
// Provider Setup's sandbox items for the accounts on in a window's workspace; and the setup run on an account's folder,
// finished only by that folder's own change. In this file's temp folders only: Codex is never run, nothing signs in, no
// real home is touched (CODEX_HOME is a temp folder standing in for ~/.codex).
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'

const base = tempDir('cw-codex-sandbox-home-')
const pc = join(base, 'user-codex')
const before = process.env.CODEX_HOME
process.env.CODEX_HOME = pc

const { codex, codexSandboxIssues, effectiveSandbox, fallbackSandbox, launchConnectionArgs } = await import('../src/main/providers/codex/adapter')
const seam = await import('../src/main/connectionSeam')

const home = (name: string, sandbox?: string): string => {
  const h = join(base, name)
  mkdirSync(h, { recursive: true })
  writeFileSync(join(h, 'config.toml'), sandbox ? `[windows]\nsandbox = "${sandbox}"\n` : 'model = "gpt-5"\n')
  return h
}
const A = home('a', 'unelevated')
const B = home('b', 'elevated')
const C = home('c')
let homes: string[] = []
seam.setAccountHomes((cli) => (cli === 'codex' ? homes : []))

beforeEach(() => {
  rmSync(pc, { recursive: true, force: true })
  homes = [A, B, C]
})
afterEach(() => {
  writeFileSync(join(C, 'config.toml'), 'model = "gpt-5"\n')
})
afterAll(() => {
  if (before === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = before
  rmSync(base, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'win32')("each home's sandbox (HI-3490)", () => {
  it("keeps a home's own setting, whatever another names", () => {
    expect(effectiveSandbox(A)).toBe('unelevated')
    expect(effectiveSandbox(B)).toBe('elevated')
    // Its own wins: its launches are given none.
    expect(launchConnectionArgs({ connectionHome: A }).some((x) => x.startsWith('windows.sandbox='))).toBe(false)
  })

  it('fills in for a home naming none from the first other account in the one order, as its launches are given it', () => {
    expect(effectiveSandbox(C)).toBe('unelevated')
    expect(launchConnectionArgs({ connectionHome: C })).toContain('windows.sandbox="unelevated"')
    // The order reversed: B is first.
    homes = [B, A, C]
    expect(effectiveSandbox(C)).toBe('elevated')
    expect(launchConnectionArgs({ connectionHome: C })).toContain('windows.sandbox="elevated"')
  })

  it("puts ~/.codex's (a setup in the user's own terminal) before the other accounts'", () => {
    mkdirSync(pc, { recursive: true })
    writeFileSync(join(pc, 'config.toml'), '[windows]\nsandbox = "elevated"\n')
    expect(fallbackSandbox(C)).toBe('elevated')
    expect(effectiveSandbox(C)).toBe('elevated')
    expect(effectiveSandbox(A)).toBe('unelevated')
  })

  it('has none where no home names one, and passes over a name Codex would not take on a command line', () => {
    homes = [C]
    expect(effectiveSandbox(C)).toBeNull()
    homes = [home('odd', 'not a kind'), C]
    expect(effectiveSandbox(C)).toBeNull()
  })
})

describe("Provider Setup's sandbox items (codexSandboxIssues)", () => {
  it('asks for setup naming the accounts without one, before any upgrade', () => {
    const [i] = codexSandboxIssues([{ name: 'Work', sandbox: 'unelevated' }, { name: 'Home', sandbox: 'elevated' }, { name: 'Spare', sandbox: null }], 'task')
    expect(i).toMatchObject({ id: 'sandbox', level: 'warning', action: { task: 'setup' } })
    expect(i.message).toContain('Spare')
    expect(i.message).not.toContain('Work')
    expect(i.action).not.toHaveProperty('opens')
  })

  it('offers Upgrade for those on the non-admin sandbox once each has one', () => {
    const issues = codexSandboxIssues([{ name: 'Work', sandbox: 'unelevated' }, { name: 'Home', sandbox: 'elevated' }], 'task')
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ id: 'sandbox-upgrade', level: 'info', action: { task: 'setup' } })
    expect(issues[0].message).toContain('Work')
    expect(issues[0].message).not.toContain('Home')
    expect(codexSandboxIssues([{ name: 'Home', sandbox: 'elevated' }], 'task')).toEqual([])
  })

  it('with no account to run on, opens Accounts & Connections instead, and says why', () => {
    const [i] = codexSandboxIssues([{ sandbox: null }], 'connections')
    expect(i).toMatchObject({ id: 'sandbox', action: { task: 'setup', opens: 'connections' } })
    expect(i.action!.label).toBe('Open Accounts & Connections')
    expect(i.detail![0]).toMatch(/none on in this workspace is signed in/)
    expect(i.message).toBe('Codex needs a one-time setup of its Windows sandbox; until then it asks before every command.')
  })

  it('has nothing off Windows', () => {
    expect(codexSandboxIssues([{ sandbox: 'n/a' }], 'task')).toEqual([])
  })
})

describe.skipIf(process.platform !== 'win32')("the setup on an account's folder (accountSandboxSetUp)", () => {
  it("runs as the account's launches do (its login store, its fallback sandbox), never on ~/.codex", () => {
    const setup = codex.accountSandboxSetUp('C:\\bin\\codex.exe', C)
    const args = setup.args.join(' ')
    expect(args).toContain('cli_auth_credentials_store="file"')
    expect(args).toContain('windows.sandbox="unelevated"')
    expect(args).not.toContain(pc)
  })

  it('types the keys for the sandbox that folder has: Upgrade on the non-admin one, else the permissions pick', () => {
    expect(JSON.stringify(codex.accountSandboxSetUp('codex.exe', A).keys)).toContain('/setup-default-sandbox')
    homes = [C]
    expect(JSON.stringify(codex.accountSandboxSetUp('codex.exe', C).keys)).not.toContain('/setup-default-sandbox')
  })

  it("finishes only when that folder's own config names another sandbox: another home's change never does", () => {
    homes = [C]
    const setup = codex.accountSandboxSetUp('codex.exe', C)
    expect(setup.done!()).toBe(false)
    // Another account's folder set up meanwhile: not this one's.
    writeFileSync(join(B, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
    homes = [B, C]
    expect(setup.done!()).toBe(false)
    writeFileSync(join(B, 'config.toml'), '[windows]\nsandbox = "elevated"\n')
    writeFileSync(join(C, 'config.toml'), '[windows]\nsandbox = "elevated"\n')
    expect(setup.done!()).toBe(true)
  })

  it('finishes when the folder that had the non-admin one by the fallback gets the default one of its own', () => {
    const setup = codex.accountSandboxSetUp('codex.exe', C)
    expect(effectiveSandbox(C)).toBe('unelevated')
    expect(JSON.stringify(setup.keys)).toContain('/setup-default-sandbox')
    writeFileSync(join(C, 'config.toml'), '[windows]\nsandbox = "elevated"\n')
    expect(setup.done!()).toBe(true)
  })
})
