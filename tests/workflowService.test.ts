// The workflow runtime in the app (#1263): one Workflow per workspace and project on the board's store, never shared
// with another workspace, refusing once its workspace has closed; a project's options resolved global → workspace →
// project with each option's origin, and options that can't be used falling back to the platform's all-off.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-wfservice-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { config } = await import('../src/main/config')
const { optionsFor, workflowFor } = await import('../src/main/workflow/service')
const { resolveOptions } = await import('../src/main/workflow/rulesets')
const { allOff } = await import('../src/shared/workflow/options')

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
  mkdirSync(join(repo, '.hive'), { recursive: true })
  mkdirSync(join(ws, '.hive'), { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
  writeFileSync(join(repo, '.gitignore'), '.hive/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  writeFileSync(join(repo, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [], ...(opts.project ? { workflow: { platform: 'git', preset: null, options: opts.project } } : {}) }))
  if (opts.workspace) writeFileSync(join(ws, '.hive', 'workspace.json'), JSON.stringify({ version: 1, mcp: { enabled: [], model: 2 }, workflow: opts.workspace }))
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

describe("a project's options, resolved (#1263, SPEC §16.6.6)", () => {
  it('global → workspace → project, each level inheriting what it leaves unset, with each origin', () => {
    const r = resolveOptions('git', {
      global: { git: { stopOwnRuns: true, dependenciesDone: true }, none: { review: 'agent' } },
      workspace: { git: { dependenciesDone: false, preChecks: ['lint'] } },
      project: { platform: 'git', preChecks: ['test'] }
    })
    expect(r.invalid).toBeNull()
    expect(r.options).toEqual({ ...allOff('git'), stopOwnRuns: true, dependenciesDone: false, preChecks: ['test'] })
    expect(r.origins).toMatchObject({ stopOwnRuns: 'global', dependenciesDone: 'workspace', preChecks: 'project', review: 'platform', finish: 'platform' })
    // Nothing set anywhere: the platform's all-off.
    expect(resolveOptions('none', {})).toMatchObject({ options: allOff('none'), invalid: null })
  })

  it('an unknown option, a value of the wrong type, another platform or a contradiction falls back to all-off', () => {
    const off = (r: ReturnType<typeof resolveOptions>) => {
      expect(r.options).toEqual(allOff('git'))
      expect(Object.values(r.origins).every((o) => o === 'platform')).toBe(true)
      return r.invalid
    }
    expect(off(resolveOptions('git', { project: { bogus: true } as never }))).toMatch(/project options: unknown option bogus/)
    expect(off(resolveOptions('git', { workspace: { git: { reviewers: 3 } as never } }))).toMatch(/workspace options: reviewers/)
    expect(off(resolveOptions('git', { project: { platform: 'none' } }))).toMatch(/options for none/)
    expect(off(resolveOptions('git', { global: { git: { review: 'agent', noSelfReview: false } } }))).toMatch(/contradict each other \(selfReview\)/)
    expect(off(resolveOptions('git', { project: 'all' as never }))).toMatch(/not an object/)
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
      writeFileSync(join(repo, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [], workflow: { platform: 'git', preset: null, options: { review: 'agent', noSelfReview: false } } }))
      expect(await workflowFor(w, repo)).toBe(wf)
      expect(wf.cfg.options()).toEqual(allOff('git'))
      expect((await optionsFor(w, repo))!.invalid).toMatch(/selfReview/)
      // Unset at the project: the workspace's and the global defaults show through.
      writeFileSync(join(repo, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
      expect((await optionsFor(w, repo))!.origins).toMatchObject({ stopOwnRuns: 'global', dependenciesDone: 'workspace', preChecks: 'platform' })
    } finally {
      delete config.settings.workflow
    }
  })
})
