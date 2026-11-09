// The repository operations port's boundary (SPEC §16.3.6 port 5, R5.2; HI-2788's R3, HR3's s11): an operation the
// platform doesn't list is refused at main's own entry points, before anything runs, whoever calls them (the renderer's
// offer bypassed). Each case takes a normally offered operation out of Git's list (a test's copy), calls the real
// entry point (the handler ipc.ts registers, the 0.9 worktree merge, Start the next version, the Assistant's branch
// undo) and finds the refusal, no git command started and nothing changed. And the selection the window had: a None
// project's folder inside Git keeps its Files actions and Initialise repository's check; a plain folder keeps today's
// refusals. The guards inside each delegate are unchanged and tested where they were (gitRepo, gitInit, filesGit,
// nextVersion tests).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { commit, gitRepo, sh } from './workflow/harness'

const base = tempDir('repo-ops-boundary-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { gitTestHooks } = await import('../src/main/git')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const store = await import('../src/main/boardStore')
const { PLATFORMS, OPERATIONS } = await import('../src/shared/platform/descriptors')
const { REPO_OP_CHANNELS } = await import('../src/shared/repoOpChannels')
const { repoOpHandlers } = await import('../src/main/repoOpsIpc')
const { mergeInProject } = await import('../src/main/projectAgents')
const nv = await import('../src/main/workflow/nextVersion')
const form = await import('../src/main/workflow/optionsForm')
const changes = await import('../src/main/assistantChanges')
const control = await import('../src/main/assistantControl')
const { userUndo } = await import('../src/main/assistantUndo')
const { makeBranchAt } = await import('../src/main/gitRepo')

vi.setConfig({ testTimeout: 60_000 })

type WS = ReturnType<typeof createWorkspaceService>
type Op = (typeof OPERATIONS)[number]
const git = PLATFORMS.git as { operations: readonly Op[] }
const opened: WS[] = []
afterEach(() => {
  git.operations = OPERATIONS
  gitTestHooks.started = undefined
})
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

let n = 0
/** A workspace with a Git project merging into main, a None project whose folder is a Git repository, and a plain folder. */
async function workspace(): Promise<{ w: WS; ws: string; repo: string; noneInGit: string; plain: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  const noneInGit = join(ws, 'n')
  const plain = join(ws, 'plain')
  for (const d of [ws, plain]) mkdirSync(d, { recursive: true })
  for (const [dir, platform] of [[repo, 'git'], [noneInGit, 'none']] as const) {
    gitRepo(dir)
    commit(dir, { '.gitignore': '.combwork/\n', 'notes.txt': 'n\n' }, 'first')
    mkdirSync(join(dir, '.combwork'), { recursive: true })
    writeFileSync(join(dir, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform, agents: [], ...(platform === 'git' ? { workflow: { platform: 'git', preset: null, options: { target: '1.3.0' } } } : {}) }))
  }
  sh(repo, 'branch', '1.3.0')
  mkdirSync(join(plain, '.combwork'), { recursive: true })
  writeFileSync(join(plain, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'none', agents: [] }))
  mkdirSync(join(ws, '.combwork'), { recursive: true })
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, ws, repo, noneInGit, plain }
}

/** Takes `op` out of Git's operations for this test, and records the git commands started from then on. */
function without(op: Op): string[] {
  git.operations = OPERATIONS.filter((o) => o !== op)
  const ran: string[] = []
  gitTestHooks.started = (_cwd, args) => void ran.push(args.join(' '))
  return ran
}
const REFUSED = /doesn’t offer that/

describe('an operation the platform doesn’t list is refused at main’s entry points (HI-2788)', () => {
  it('the IPC handlers: New branch, Fetch, the Files tab’s Exclude', async () => {
    const { w, repo } = await workspace()
    const exclude = join(repo, '.git', 'info', 'exclude')
    const before = existsSync(exclude) ? readFileSync(exclude, 'utf8') : null
    let ran = without('createLine')
    await expect(inWorkspace(w, async () => repoOpHandlers['git:createBranch'](repo, 'x', true, null))).rejects.toThrow(REFUSED)
    expect(ran).toEqual([])
    expect(sh(repo, 'branch', '--list', 'x')).toBe('')
    ran = without('fetch')
    await expect(inWorkspace(w, async () => repoOpHandlers['git:fetch'](repo))).rejects.toThrow(REFUSED)
    expect(ran).toEqual([])
    ran = without('ignoreRules')
    await expect(inWorkspace(w, async () => repoOpHandlers['files:gitExclude'](repo, [{ rel: 'notes.txt', isDir: false }], 'local', false))).rejects.toThrow(REFUSED)
    expect(ran).toEqual([])
    expect(existsSync(exclude) ? readFileSync(exclude, 'utf8') : null).toBe(before)
  })

  it('the Merge dialog’s worktree merge: refused inside its lock, nothing merged', async () => {
    const { w, repo } = await workspace()
    const tree = join(base, `tree-${n}`)
    sh(repo, 'worktree', 'add', '-q', '-b', 'side', tree)
    commit(tree, { 's.txt': 's\n' }, 'side work')
    const head = sh(repo, 'rev-parse', 'HEAD')
    const ran = without('mergeLine')
    await expect(inWorkspace(w, () => mergeInProject(repo, { path: tree, branch: 'side', base: head }, { squash: false, message: '' }))).rejects.toThrow(REFUSED)
    // What may run before the gate is the lock's and the slot's own reads: no merge, commit, checkout or ref change.
    expect(ran.filter((c) => /^(merge|commit|checkout|update-ref|read-tree|reset)\b/.test(c))).toEqual([])
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('Start the next version: no branch made, the options as they were', async () => {
    const { w, repo } = await workspace()
    const ran = without('createLine')
    await expect(inWorkspace(w, () => nv.startNextVersion(w, repo, {}))).rejects.toThrow(REFUSED)
    expect(ran.filter((c) => c.startsWith('update-ref'))).toEqual([])
    expect(sh(repo, 'branch', '--list', '1.4.0')).toBe('')
    expect((await inWorkspace(w, () => form.workflowForm(w, repo))).options.target).toBe('1.3.0')
  })

  it('the Assistant’s branch undo: the branch kept, the change left to undo again', async () => {
    const { w, ws, repo } = await workspace()
    await control.newAssistantToken(ws)
    control.newTurn(ws)
    const group = control.currentTurn(ws).id
    await changes.recordingChanges(ws, 'create-branch', 'create kept', () =>
      inWorkspace(w, async () => {
        const s = await makeBranchAt(repo, 'kept', { ref: '1.3.0', commit: '' })
        await changes.noteChange(w, changes.branchChange('p', 'kept', s.commit))
      })
    )
    const ran = without('deleteLines')
    const [r] = await userUndo(w, { group })
    expect(r).toMatchObject({ undone: [], skipped: [{ field: 'branch', why: 'failed', error: expect.stringMatching(REFUSED) }] })
    expect(ran.filter((c) => c.startsWith('update-ref'))).toEqual([])
    expect(sh(repo, 'branch', '--list', 'kept')).not.toBe('')
    git.operations = OPERATIONS
    const [again] = await userUndo(w, { group })
    expect(again).toMatchObject({ undone: ['branch'] })
  })
})

describe('the platform each entry point selects is the window’s as before (HI-2788)', () => {
  it('a None project whose folder is in Git keeps its Files actions and Initialise’s check; a plain folder its refusals', async () => {
    const { w, noneInGit, plain } = await workspace()
    const done = await inWorkspace(w, async () => repoOpHandlers['files:gitExclude'](noneInGit, [{ rel: 'notes.txt', isDir: false }], 'local', false))
    expect(done).toMatchObject({ lines: ['/notes.txt'] })
    expect(await inWorkspace(w, async () => repoOpHandlers['git:initCheck'](noneInGit))).toBeTruthy()
    await expect(inWorkspace(w, async () => repoOpHandlers['files:gitExclude'](plain, [{ rel: 'a.txt', isDir: false }], 'local', false))).rejects.toThrow(/not a git repository/)
    await expect(inWorkspace(w, async () => repoOpHandlers['git:fetch'](plain))).rejects.toThrow(/isn't a git repository/)
  })
})

describe('the one map (HI-2788)', () => {
  it('every mutation channel is a handler of repoOpsIpc.ts, or ipc.ts’ merge through opsAt; ipc.ts calls no mutation itself', () => {
    const channels = Object.keys(REPO_OP_CHANNELS).sort()
    expect([...Object.keys(repoOpHandlers), 'worktrees:mergeBranch'].sort()).toEqual(channels)
    const ipc = readFileSync(join(__dirname, '..', 'src', 'main', 'ipc.ts'), 'utf8')
    expect(ipc).toContain('...repoOpHandlers,')
    expect(ipc).toContain("opsAt('worktrees:mergeBranch').mergeLine(")
    expect(ipc).not.toMatch(/from '\.\/(gitRepo|gitInit)'/)
    expect(ipc).not.toMatch(/filesGit\.(gitExclude|gitUntrack|gitInclude)\b/)
    expect(ipc).not.toMatch(/\bmergeBranch\(path/)
  })
})
