// #848 (E10d): the `worktrees` area, a project's agents and their worktrees. Refusals are HiveErrors: agents (the Agent
// API's add and change agent) read them in English exactly as before, with the same status, and the window in its
// language; git's own words stay as git said them, inside either. Why an unused worktree isn't reused is English for the
// Agent API (`notReused`) and data for the window (`notReusedText`). Reasons and a merge's errors only the window reads
// (a check, a removal, a merge) are in its language.
import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from '../tempDir'

const base = tempDir('hive-i18n-worktrees-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { setLanguage } = await import('../../src/shared/i18n')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../../src/main/workspace')
const wt = await import('../../src/main/worktrees')
const agents = await import('../../src/main/projectAgents')
const { PruneBlocked, recreateWorktree, unlinkMissingWorktree } = await import('../../src/main/agentWorktree')
const { shownError, windowError } = await import('../../src/main/hiveError')
const { apiErrorReply } = await import('../../src/main/servers')

const ROOT = resolve(__dirname, '../..')
const EN = JSON.parse(readFileSync(join(ROOT, 'locales/en/worktrees.json'), 'utf8')) as Record<string, { defaultMessage: string; description: string }>
const FILES = ['worktrees.ts', 'projectAgents.ts', 'agentWorktree.ts', 'projectNames.ts']

/** A German translation of some of the area's messages, as a language file gives them (the rest stays English). */
const GERMAN: Record<string, string> = {
  'worktrees.agent.unknownProvider': 'Unbekannter Anbieter „{provider}“.',
  'worktrees.agent.gone': 'Diesen Agenten gibt es nicht mehr.',
  'worktrees.agent.chooseTree': 'Wähle einen Worktree.',
  'worktrees.agent.enterName': 'Gib einen Namen ein.',
  'worktrees.agent.roleTooLong': 'Eine Rolle hat höchstens {max} Zeichen.',
  'worktrees.agent.noTree': 'Dieser Agent arbeitet im Projektordner, nicht in einem Worktree.',
  'worktrees.branchInWay': 'Git kann den Branch {branch} nicht anlegen: der Branch {parent} ist im Weg.',
  'worktrees.badBranchName': '„{branch}“ ist kein gültiger Branch-Name.',
  'worktrees.readBranch': 'git konnte den Branch in {folder} nicht lesen ({why})',
  'worktrees.missing.noTree': '{agent} arbeitet in keinem Worktree.',
  'worktrees.reuse.notMerged': '{n, plural, one {# Commit} other {# Commits}} nicht in {base} gemergt',
  'worktrees.why.notMerged': '{n, plural, one {# Commit} other {# Commits}} nicht in {into} gemergt',
  'worktrees.why.uncommitted': '{n, plural, one {# nicht committete Datei} other {# nicht committete Dateien}}',
  'worktrees.merge.sameBranch': 'Im Projektordner ist {branch} ausgecheckt.'
}

const git = (cwd: string, ...a: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8' }).trim()
const commit = (cwd: string, file: string): void => {
  writeFileSync(join(cwd, file), `${file}\n`)
  git(cwd, 'add', '--', file)
  git(cwd, 'commit', '-qm', file)
}
const wsPath = join(base, 'ws')
const proj = join(wsPath, 'proj')
const treesRoot = join(base, 'ws.worktrees', 'proj')
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)

beforeAll(async () => {
  mkdirSync(join(proj, '.combwork'), { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', proj])
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com']]) git(proj, 'config', k, v)
  commit(proj, 'a.txt')
  writeFileSync(join(proj, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }] }))
  w = createWorkspaceService()
  await w.open(wsPath)
})
afterAll(() => disposeWorkspaceService(w))
afterEach(() => setLanguage('en', {}))

/** What a call threw. */
async function caught(p: Promise<unknown>): Promise<Error> {
  try {
    await p
  } catch (e) {
    return e as Error
  }
  throw new Error('it did not throw')
}

describe('the worktrees area', () => {
  it('every message is of the worktrees area, with a note for translators, and its four files have no text left to convert', () => {
    expect(Object.keys(EN).length).toBeGreaterThan(50)
    for (const [id, m] of Object.entries(EN)) {
      expect(id).toMatch(/^worktrees\./)
      expect(m.description.length, id).toBeGreaterThan(10)
    }
    for (const f of FILES) expect(() => readFileSync(join(ROOT, 'i18n/allow', `src__main__${f}.json`)), f).toThrow()
  })
})

describe("agents' and worktrees' refusals: English for agents as before, the window's language for the window", () => {
  it('says each in English with the status it always had, and in German to the window', async () => {
    setLanguage('de', GERMAN)
    const notRepo = tempDir('hive-not-a-repo-')
    const cases: [Error, string | RegExp, number, string | RegExp | null][] = [
      [await caught(run(() => agents.addAgent(proj, { name: 'P', location: 'project', provider: 'nope' }))), 'Unknown provider "nope".', 400, 'Unbekannter Anbieter „nope“.'],
      // 1.0 (#1451): no agent is pinned to a worktree, new or existing.
      [await caught(run(() => agents.addAgent(proj, { name: 'Q', location: 'existing-worktree', worktreePath: notRepo }))), 'Agents aren’t pinned to worktrees in 1.0: slots are lent per card or lane.', 400, null],
      [await caught(run(() => agents.addAgent(proj, { name: 'R', location: 'new-worktree' }))), 'Agents aren’t pinned to worktrees in 1.0: slots are lent per card or lane.', 400, null],
      [await caught(run(() => agents.moveAgent(proj, 'nope', 0))), 'That agent no longer exists.', 404, 'Diesen Agenten gibt es nicht mehr.'],
      [await caught(run(() => agents.moveAgent(proj, 'a1', Number.NaN))), 'Choose where to move the agent.', 500, null],
      [await caught(run(() => agents.updateAgent(proj, 'a1', { name: ' ' }))), 'Enter a name.', 400, 'Gib einen Namen ein.'],
      [await caught(run(() => agents.updateAgent(proj, 'a1', { role: 'x'.repeat(200) }))), /^A role is at most \d+ characters\.$/, 400, /^Eine Rolle hat höchstens \d+ Zeichen\.$/],
      [await caught(run(() => agents.branchStatus(proj, 'a1'))), 'This agent works in the project folder, not a worktree.', 500, 'Dieser Agent arbeitet im Projektordner, nicht in einem Worktree.'],
      [await caught(wt.uniqueBranch(proj, 'main/x')), "Git can't make the branch main/x: a branch main is in the way. Choose another branch.", 500, 'Git kann den Branch main/x nicht anlegen: der Branch main ist im Weg.'],
      [await caught(wt.createWorktree(proj, join(treesRoot, 'bad'), 'bad..name', 'main')), '"bad..name" is not a valid branch name.', 500, '„bad..name“ ist kein gültiger Branch-Name.'],
      [await caught(run(() => recreateWorktree(proj, 'nope'))), 'That agent no longer exists.', 404, null],
      [await caught(run(() => unlinkMissingWorktree(proj, 'a1'))), "Agent 1 doesn't work in a worktree.", 500, 'Agent 1 arbeitet in keinem Worktree.']
    ]
    for (const [e, english, status, german] of cases) {
      // The Agent API's reply (and every reader of .message): the English, as before, with the status its English gave.
      expect(e.message).toMatch(english)
      expect(apiErrorReply(e).body.error).toBe(e.message)
      expect(apiErrorReply(e).status, e.message).toBe(status)
      // Except the refusals HI-1952 gave a kind, which answered 500 (no pattern matched their English): now 400.
      if (!/^(Enter a name\.|A role is at most)/.test(e.message)) expect(apiErrorReply(new Error(e.message)).status, `${e.message}: the status its English always gave`).toBe(status)
      // The window (IPC's conversion): in its language, or English where this test has no translation.
      expect((windowError(e) as Error).message).toMatch(german ?? english)
      expect(shownError(e)).toMatch(german ?? english)
    }
  })

  it("keeps git's own words as they came, inside either language", async () => {
    setLanguage('de', GERMAN)
    const notRepo = tempDir('hive-not-a-repo-')
    const e = await caught(wt.checkedOutBranch(notRepo))
    const prefix = `git couldn't read the branch checked out in ${notRepo} (`
    expect(e.message.startsWith(prefix) && e.message.endsWith(')'), e.message).toBe(true)
    const said = e.message.slice(prefix.length, -1)
    expect(said).toMatch(/not a git repository/i)
    expect(shownError(e)).toBe(`git konnte den Branch in ${notRepo} nicht lesen (${said})`)
  })
})

describe('an unused worktree not reused: English for the Agent API, data for the window', () => {
  it("the Add Agent dialog's look says why in the window's language (1.0 adds no agent in one: #1451), and so does a removal", async () => {
    setLanguage('de', GERMAN)
    const t = { path: join(treesRoot, 'b1'), branch: 'cw/b1' }
    await wt.createWorktree(proj, t.path, t.branch, 'main')
    commit(t.path, 'ahead.txt')
    const look = await run(() => agents.worktreeMatch(proj, 'cw/b1', 'main', 'B1'))
    expect(look).toMatchObject({ branch: 'cw/b1', reusable: false, why: '1 Commit nicht in main gemergt' })

    // Removing that worktree is the window's: why it is kept, in its language (unmerged commits, and a file now too).
    writeFileSync(join(t.path, 'dirty.txt'), 'x')
    const check = await wt.worktreeCheck(proj, { ...t, base: 'main' })
    expect(check).toMatchObject({ removable: false, ahead: 1, dirty: 1, reason: '1 Commit nicht in main gemergt und 1 nicht committete Datei' })
    setLanguage('en', {})
    expect((await wt.worktreeCheck(proj, { ...t, base: 'main' })).reason).toBe('1 commit not merged into main and 1 uncommitted file')
  })

  it("a recreate git's prune refuses carries the worktrees git named, not those Combwork thinks missing (#1313)", async () => {
    // Third's folder is gone (to recreate); Second, missing to Combwork, has no git registration left; an unmanaged worktree
    // made outside Combwork lost its folder: only that one is what git's prune would forget.
    const third = join(treesRoot, 'third')
    const ext = join(base, 'external-blocker')
    await wt.createWorktree(proj, third, 'cw/third', 'main')
    git(proj, 'worktree', 'add', '-q', '-b', 'ext', ext)
    const before = await run(() => w.projectConfig(proj))
    await run(() =>
      w.mutateProjectConfig(proj, (c) => ({
        agents: [...(c.agents ?? []), { id: 'a2', name: 'Second', worktree: { path: join(treesRoot, 'second'), branch: 'cw/second', base: 'main' } }, { id: 'a3', name: 'Third', worktree: { path: third, branch: 'cw/third', base: 'main' } }]
      }))
    )
    try {
      rmSync(third, { recursive: true, force: true })
      rmSync(ext, { recursive: true, force: true })
      const e = await caught(run(() => recreateWorktree(proj, 'a3')))
      expect(e).toBeInstanceOf(PruneBlocked)
      expect((e as InstanceType<typeof PruneBlocked>).blockers.map((p) => p.toLowerCase())).toEqual([ext.toLowerCase()])
      expect(e.message).toMatch(/which would also drop git's link to .*external-blocker \(missing too\)\. Locate, recreate or remove that worktree first\./)
    } finally {
      await run(() => w.mutateProjectConfig(proj, () => ({ agents: before.agents })))
      git(proj, 'worktree', 'prune')
      git(proj, 'branch', '-D', 'ext', 'cw/third')
    }
  })

  it("a merge's errors are the window's, in its language", async () => {
    setLanguage('de', GERMAN)
    expect(await wt.mergeWorktree(proj, { path: proj, branch: 'main', base: 'main' }, { squash: false, message: '' })).toEqual({ ok: false, error: 'Im Projektordner ist main ausgecheckt.' })
    setLanguage('en', {})
    expect(await wt.mergeWorktree(proj, { path: proj, branch: 'main', base: 'main' }, { squash: false, message: '' })).toEqual({ ok: false, error: 'The project folder has main checked out.' })
  })
})
