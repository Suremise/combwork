// The workflow runtime in the app (#1263): one Workflow per workspace and project on the board's store, never shared
// with another workspace, refusing once its workspace has closed; a project's options resolved global → workspace →
// project with each option's origin, and options that can't be used falling back to the platform's all-off.
import { execFileSync } from 'child_process'
import { mkdirSync, statSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { PREFERENCE_DEFAULTS } from '../src/shared/workflow/preferences'

const base = tempDir('hive-wfservice-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { config } = await import('../src/main/config')
const { optionsFor, workflowFor } = await import('../src/main/workflow/service')
const { resolveOptions, rulesetsNow } = await import('../src/main/workflow/rulesets')
const { allOff } = await import('../src/shared/workflow/options')
const { observer } = await import('../src/main/platform/observe')
const { isUnknown } = await import('../src/main/platform/types')

/** The bound for a hung run: the watcher's events and the folder settling come well within it. */
const HUNG_MS = 20_000

type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
let n = 0

/** A workspace with a git project `p` (its own options, if given) and, when given, the workspace's default options. */
async function workspace(opts: { project?: unknown; workspace?: unknown } = {}): Promise<{ ws: string; w: WS; repo: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  mkdirSync(join(ws, '.combwork'), { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [], ...(opts.project ? { workflow: { platform: 'git', preset: null, options: opts.project } } : {}) }))
  if (opts.workspace) writeFileSync(join(ws, '.combwork', 'workspace.json'), JSON.stringify({ version: 1, mcp: { enabled: [], model: 2 }, workflow: opts.workspace }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { ws, w, repo }
}

describe('one runtime per workspace and project (#1263)', () => {
  it('is made once per workspace and project, and another workspace on the same folders never shares it', async () => {
    const { ws, w, repo } = await workspace()
    const a = await workflowFor(w, repo)
    expect(a).not.toBeNull()
    expect(await workflowFor(w, repo.toUpperCase())).toBe(a)
    expect(await workflowFor(w, join(ws, 'nothing'))).toBeNull()
    // Its store is the board's: a card made on the board is the runtime's card.
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Seen', project: 'p' }, { kind: 'user' }))).number
    expect(a!.store.cards().map((c) => c.id)).toContain(card)
    // Another workspace (another window): its own runtime, on its own board, and never this one's project.
    const other = await workspace()
    const b = await workflowFor(other.w, other.repo)
    expect(b).not.toBeNull()
    expect(b).not.toBe(a)
    expect(await workflowFor(other.w, repo)).toBeNull()
    expect(b!.store.cards().map((c) => c.id)).not.toContain(card)
  })

  it('refuses once its workspace has closed, and a workspace opened again in the window gets a new one', async () => {
    const { ws, w, repo } = await workspace()
    const wf = (await workflowFor(w, repo))!
    // Open: a write is a change of the board, and joins one the caller already holds.
    expect(await wf.locked(() => 1)).toBe(1)
    expect(await store.boardWrite(w, async () => wf.locked(() => 2))).toBe(2)
    await w.close()
    await expect(wf.locked(() => 3)).rejects.toThrow(/closed/)
    await expect(workflowFor(w, repo)).rejects.toThrow(/closed/)
    await w.open(ws)
    const again = (await workflowFor(w, repo))!
    expect(again).not.toBe(wf)
    expect(await again.locked(() => 4)).toBe(4)
    await expect(wf.locked(() => 5)).rejects.toThrow(/closed/)
  })
})

// HR2's round 1: a runtime kept across calls keeps None's hashes, so a write the watcher saw (a same-size edit with its
// time kept: a file restored or copied) must drop its hash before the next call reads it, and every hash goes when the
// watcher's record isn't complete.
describe("None: the kept runtime's hashes follow the watcher (#1263)", () => {
  it('a same-size edit with its time kept is seen at the next call; with no complete record, every hash is read again', async () => {
    const ws = join(base, `ws-${++n}`)
    const folder = join(ws, 'n')
    mkdirSync(join(folder, '.combwork'), { recursive: true })
    writeFileSync(join(folder, 'a.txt'), 'AAAA')
    writeFileSync(join(folder, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    const w = createWorkspaceService()
    await w.open(ws)
    opened.push(w)
    const unwatched = (await workflowFor(w, folder))!
    expect(unwatched.cfg.options().platform).toBe('none')
    // One time for every version of the file, in whole seconds (a time with more precision than utimes keeps would differ).
    const at = 1_700_000_000
    const edit = (text: string): void => {
      writeFileSync(join(folder, 'a.txt'), text)
      utimesSync(join(folder, 'a.txt'), at, at)
    }
    edit('AAAA')
    expect(statSync(join(folder, 'a.txt')).mtimeMs).toBe(at * 1000)
    const before = unwatched.none.revision(['a.txt'])
    // Not watched (no complete record): the next call drops every hash.
    edit('BBBB')
    expect(unwatched.none.revision(['a.txt'])).toEqual(before)
    const forget = vi.spyOn(unwatched.none, 'forget')
    expect(await workflowFor(w, folder)).toBe(unwatched)
    expect(forget).toHaveBeenCalled()
    const second = unwatched.none.revision(['a.txt'])
    expect(second).not.toEqual(before)
    forget.mockClear()
    // Watched: the record is complete from when its watch is armed; the written path alone is dropped.
    observer.follow([{ path: folder, platform: 'none' }])
    try {
      await vi.waitFor(async () => expect(isUnknown(await observer.changedBetween(folder, Date.now(), Date.now(), (p) => p))).toBe(false), { timeout: HUNG_MS })
      // This call's record began before the watch did: every hash goes once more. Read again, the hash is kept.
      await workflowFor(w, folder)
      expect(unwatched.none.revision(['a.txt'])).toEqual(second)
      forget.mockClear()
      const invalidate = vi.spyOn(unwatched.none, 'invalidate')
      edit('CCCC')
      expect(unwatched.none.revision(['a.txt'])).toEqual(second)
      await vi.waitFor(
        async () => {
          await workflowFor(w, folder)
          expect(invalidate).toHaveBeenCalledWith('a.txt')
        },
        { timeout: HUNG_MS }
      )
      expect(forget).not.toHaveBeenCalled()
      const third = unwatched.none.revision(['a.txt'])
      expect(third).not.toEqual(second)
      expect(third).not.toEqual(before)
    } finally {
      observer.follow([])
    }
  })
})

// HR2's round 2: the hash sync waits (for the folder to settle); a workspace closed or switched meanwhile is refused,
// never handed back as a runtime whose board has gone, for the call waiting and for one queued behind it.
describe('None: a workspace closed or switched while its hashes sync (#1263)', () => {
  /** A workspace with a None project; the watcher's answer held until `release`. */
  async function held(): Promise<{ ws: string; w: WS; folder: string; hold: () => () => void }> {
    const ws = join(base, `ws-${++n}`)
    const folder = join(ws, 'n')
    mkdirSync(join(folder, '.combwork'), { recursive: true })
    writeFileSync(join(folder, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    const w = createWorkspaceService()
    await w.open(ws)
    opened.push(w)
    const real = observer.changedBetween.bind(observer)
    const hold = (): (() => void) => {
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      const spy = vi.spyOn(observer, 'changedBetween').mockImplementation(async (...args) => {
        await gate
        return real(...args)
      })
      return () => {
        release()
        spy.mockRestore()
      }
    }
    return { ws, w, folder, hold }
  }

  it('closed while the sync waits: both calls refuse', async () => {
    const { w, folder, hold } = await held()
    expect(await workflowFor(w, folder)).not.toBeNull()
    const release = hold()
    const first = workflowFor(w, folder)
    const second = workflowFor(w, folder)
    await vi.waitFor(() => expect(observer.changedBetween).toHaveBeenCalled(), { timeout: HUNG_MS })
    await w.close()
    release()
    await expect(first).rejects.toThrow(/closed/)
    await expect(second).rejects.toThrow(/closed/)
  })

  it('switched to another workspace while the sync waits: refused, and the new workspace gets its own', async () => {
    const { w, folder, hold } = await held()
    const old = (await workflowFor(w, folder))!
    const release = hold()
    const first = workflowFor(w, folder)
    const second = workflowFor(w, folder)
    await vi.waitFor(() => expect(observer.changedBetween).toHaveBeenCalled(), { timeout: HUNG_MS })
    const other = join(base, `ws-${++n}`)
    mkdirSync(join(other, 'n', '.combwork'), { recursive: true })
    writeFileSync(join(other, 'n', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    await w.open(other)
    release()
    await expect(first).rejects.toThrow(/closed/)
    await expect(second).rejects.toThrow(/closed/)
    const now = await workflowFor(w, join(other, 'n'))
    expect(now).not.toBeNull()
    expect(now).not.toBe(old)
  })
})

// Resolved options have the preferences' defaults under every level (HI-1766): all-off leaves them unset.
const resolvedOff = (p: 'git' | 'none') => ({ ...PREFERENCE_DEFAULTS, ...allOff(p) })

describe("a project's options, resolved (#1263, SPEC §16.6.6)", () => {
  it('global → workspace → project, each level inheriting what it leaves unset, with each origin', () => {
    const r = resolveOptions('git', {
      global: { git: { stopOwnRuns: true, dependenciesDone: true }, none: { review: 'agent' } },
      workspace: { git: { dependenciesDone: false, preChecks: ['lint'] } },
      project: { platform: 'git', preChecks: ['test'] }
    })
    expect(r.invalid).toBeNull()
    expect(r.options).toEqual({ ...resolvedOff('git'), stopOwnRuns: true, dependenciesDone: false, preChecks: ['test'] })
    expect(r.origins).toMatchObject({ stopOwnRuns: 'global', dependenciesDone: 'workspace', preChecks: 'project', review: 'platform', finish: 'platform' })
    // Nothing set anywhere: the platform's all-off.
    expect(resolveOptions('none', {})).toMatchObject({ options: resolvedOff('none'), invalid: null })
  })

  it('an unknown option, a value of the wrong type, another platform or a contradiction falls back to all-off', () => {
    const off = (r: ReturnType<typeof resolveOptions>) => {
      expect(r.options).toEqual(resolvedOff('git'))
      expect(Object.values(r.origins).every((o) => o === 'platform')).toBe(true)
      return r.invalid
    }
    expect(off(resolveOptions('git', { project: { bogus: true } as never }))).toMatch(/project options: unknown option bogus/)
    expect(off(resolveOptions('git', { workspace: { git: { reviewers: 3 } as never } }))).toMatch(/workspace options: reviewers/)
    expect(off(resolveOptions('git', { project: { platform: 'none' } }))).toMatch(/options for none/)
    expect(off(resolveOptions('git', { global: { git: { review: 'agent', noSelfReview: false } } }))).toMatch(/contradict each other \(selfReview\)/)
    expect(off(resolveOptions('git', { project: 'all' as never }))).toMatch(/not an object/)
  })

  it("a choice an option doesn't have falls back to all-off, at every level (HR2's round 1)", () => {
    const off = (r: ReturnType<typeof resolveOptions>, why: RegExp) => {
      expect(r.options).toEqual(resolvedOff('git'))
      expect(r.invalid).toMatch(why)
    }
    off(resolveOptions('git', { project: { finish: 'typo' } as never }), /project options: finish/)
    off(resolveOptions('git', { workspace: { git: { review: 'everyone' } } as never }), /workspace options: review/)
    off(resolveOptions('git', { global: { git: { style: 'octopus' } } as never }), /global options: style/)
    off(resolveOptions('git', { project: { sameness: 'close' } as never }), /project options: sameness/)
    off(resolveOptions('git', { project: { folder: 'tmp' } as never }), /project options: folder/)
    off(resolveOptions('git', { project: { okBefore: { mode: 'sometimes', labels: [] } } as never }), /project options: okBefore/)
    off(resolveOptions('git', { project: { identity: { name: 'A' } } as never }), /project options: identity/)
    off(resolveOptions('git', { project: { commands: { test: 1 } } as never }), /project options: commands/)
    // Every value each option takes passes.
    expect(resolveOptions('git', { project: { review: 'agentThenYou', noSelfReview: true, reviewers: 2, sameness: 'exact', finish: 'hiveMerges', style: 'squash', folder: 'slots', okBefore: { mode: 'never', labels: ['ui'] }, identity: { name: 'A', email: 'a@example.com' } } }).invalid).toBeNull()
  })

  it("the runtime works under the project's resolved options, read again at each call", async () => {
    config.settings.workflow = { git: { stopOwnRuns: true } }
    try {
      const { w, repo } = await workspace({ workspace: { git: { dependenciesDone: true } }, project: { ...allOff('git'), preChecks: ['test'] } })
      const r = (await optionsFor(w, repo))!
      // project.json's options are whole (the upgrade writes every one): its own values win over the defaults.
      expect(r.options).toMatchObject({ stopOwnRuns: false, dependenciesDone: false, preChecks: ['test'] })
      expect(r.origins).toMatchObject({ preChecks: 'project', dependenciesDone: 'project', stopOwnRuns: 'project' })
      const wf = (await workflowFor(w, repo))!
      expect(wf.cfg.options().preChecks).toEqual(['test'])
      // A bad option in project.json: all off, never a throw.
      writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [], workflow: { platform: 'git', preset: null, options: { review: 'agent', noSelfReview: false } } }))
      expect(await workflowFor(w, repo)).toBe(wf)
      expect(wf.cfg.options()).toEqual(resolvedOff('git'))
      expect((await optionsFor(w, repo))!.invalid).toMatch(/selfReview/)
      // Unset at the project: the workspace's and the global defaults show through.
      writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
      expect((await optionsFor(w, repo))!.origins).toMatchObject({ stopOwnRuns: 'global', dependenciesDone: 'workspace', preChecks: 'platform' })
    } finally {
      delete config.settings.workflow
    }
  })
})

describe("each project's ruleset now (HI-1780: kept by what it is made from)", () => {
  it('is the same while its options are, another once they change, and the first again once they change back', async () => {
    let options: Record<string, unknown> = { ...allOff('git') }
    const ws = { config: { workflow: undefined }, info: () => ({ projects: [{ name: 'Kept', path: join(base, 'kept-ruleset'), platform: { id: 'git' } }] }), projectConfig: async () => ({ workflow: { options } }) } as never
    const first = (await rulesetsNow(ws)).get('kept')
    expect(first).toBeTruthy()
    expect((await rulesetsNow(ws)).get('kept')).toBe(first)
    options = { ...allOff('git'), preChecks: ['test'] }
    const changed = (await rulesetsNow(ws)).get('kept')
    expect(changed).toBeTruthy()
    expect(changed).not.toBe(first)
    options = { ...allOff('git') }
    expect((await rulesetsNow(ws)).get('kept')).toBe(first)
  })
})
