// HI-2753 (SPEC §16.5.4, designs s8 → s18): a card in flight, and its running lane, moved from the target it started on
// to another, its line and work kept, only when everything it would bring there is provably its own; and the move made
// under git's own ref locks, so a change meanwhile refuses it rather than slipping past. The proof on real repositories
// (rules a to d, each refused case beside its contained counterpart); the move on the real board (a temp combwork.db,
// a temp repository, the slot lending stood in for): the submit's refusal naming a deleted target, a move, its refusals,
// changes before and while git holds the refs, someone else's lock left alone, a git that ends before the write, a
// prepare that never answers, two moves at once, a reviewed card's evidence, a lane moved with its card, and a restart
// keeping its line.
import { execFileSync, spawn, type ChildProcess } from 'child_process'
import { createRequire } from 'module'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

vi.setConfig({ testTimeout: 60_000 })
/** A bound for a hung run only, never a timing (tests/README.md). */
const HUNG_MS = 10_000
const { endChildTree } = createRequire(import.meta.url)('./e2e/folderProcesses.cjs') as { endChildTree: (child: ChildProcess) => number }

const base = tempDir('cw-retargetcard-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const lanes = await import('../src/main/lanes')
const retarget = await import('../src/main/workflow/retarget')
const rc = await import('../src/main/workflow/retargetCard')
const hold = await import('../src/main/platform/refHold')
const { forgetKeptAnswers } = await import('../src/main/platform/git')
const { advanced } = await import('../src/main/advanced')
const { setSlotStarts, workflowFor } = await import('../src/main/workflow/service')
const { agentActor } = await import('../src/shared/workflow/facts')
const { allOff } = await import('../src/shared/workflow/options')
const { targetOfRulesetId } = await import('../src/shared/workflow/compile')

advanced.load(join(base, 'profile'))
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
const user = { kind: 'user' } as const

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
const commitIn = (cwd: string, file: string, text = file): string => {
  writeFileSync(join(cwd, file), `${text}\n`)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-qm', file)
  return git(cwd, 'rev-parse', 'HEAD')
}

/** Slot lending stood in for (the seam slotCards.ts fills): each start a folder of its own, made by the test. */
let slotN = 0
setSlotStarts({ leaseFor: async () => ({ slot: `slot-${++slotN}`, folder: join(base, `slot-${slotN}`), lease: `l-${slotN}`, fresh: false }), unused: async () => undefined })
afterAll(async () => {
  setSlotStarts(null)
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})
beforeEach(() => {
  forgetKeptAnswers()
  hold.refHoldTestHooks.prepared = undefined
  rc.moveTestHooks.checked = undefined
})

// ---------------------------------------------------------------------------------------------------------------------
// The proof, on plain repositories.
// ---------------------------------------------------------------------------------------------------------------------

/** A repository on main (C), with the integration branch A one commit ahead of it (A0). */
function history(): { repo: string; C: string; A0: string } {
  const repo = join(tempDir('rc-proof-'), 'repo')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'core.autocrlf', 'false')
  const C = commitIn(repo, 'c.txt')
  git(repo, 'switch', '-q', '-c', 'A')
  const A0 = commitIn(repo, 'a0.txt')
  git(repo, 'switch', '-q', 'main')
  return { repo, C, A0 }
}
/** The card's line from `from`, with one commit of its own (W) made in a worktree of its own. */
function lineFrom(repo: string, from: string): { wt: string; W: string } {
  const wt = join(repo, '..', `wt-${Math.random().toString(36).slice(2, 8)}`)
  git(repo, 'worktree', 'add', '-q', '-b', 'cw/AM/AM-1-x', wt, from)
  return { wt, W: commitIn(wt, 'w.txt') }
}
const head = (repo: string, ref: string): string => git(repo, 'rev-parse', ref)
const prove = (repo: string, wt: string, target: string, anchors: string[] = []) => rc.proveOwn(repo, { line: 'cw/AM/AM-1-x', head: head(repo, 'cw/AM/AM-1-x'), target: head(repo, target), anchors, own: rc.ownRefs('AM-1', ['cw/AM/AM-1-x']), folder: wt, reflog: true })

describe("the proof that a card's work is its own (HI-2753, rules a to d)", () => {
  it('A fully merged into main, then deleted: the line moves (the integration branch that ended)', async () => {
    const { repo, A0 } = history()
    const { wt } = lineFrom(repo, 'A')
    git(repo, 'merge', '-q', '--no-ff', '-m', 'A into main', 'A')
    git(repo, 'branch', '-D', 'A')
    expect(await prove(repo, wt, 'main', [A0])).toBeNull()
  })

  it('(d) started from a commit main lacks, A then deleted (HR2): refused; with that commit in main, it moves', async () => {
    const { repo, A0 } = history()
    const { wt } = lineFrom(repo, 'A')
    git(repo, 'branch', '-D', 'A')
    expect(await prove(repo, wt, 'main', [A0])).toMatchObject({ why: 'notInTarget', rule: 'anchor' })
    // The counterpart: A0 brought into main (by its own commit's id).
    git(repo, 'merge', '-q', '--ff-only', A0)
    expect(await prove(repo, wt, 'main', [A0])).toBeNull()
  })

  it('(a) A advanced and merged into the line after its submission, A deleted: refused; with A1 in main, it moves', async () => {
    const { repo, A0 } = history()
    const { wt } = lineFrom(repo, 'A')
    git(repo, 'merge', '-q', '--ff-only', 'A')
    git(repo, 'switch', '-q', 'A')
    const A1 = commitIn(repo, 'a1.txt')
    git(repo, 'switch', '-q', 'main')
    git(wt, 'merge', '-q', '--no-ff', '-m', 'A1 in', 'A')
    git(repo, 'branch', '-D', 'A')
    expect(await prove(repo, wt, 'main', [A0])).toMatchObject({ why: 'notInTarget', rule: 'firstParent' })
    git(repo, 'merge', '-q', '--ff-only', A1)
    expect(await prove(repo, wt, 'main', [A0])).toBeNull()
  })

  it('(c) fast-forwarded onto A1, or reset onto it, A deleted: refused by its reflog; with A1 in main, it moves', async () => {
    for (const how of ['ff', 'reset'] as const) {
      const { repo, A0 } = history()
      git(repo, 'merge', '-q', '--ff-only', 'A')
      git(repo, 'switch', '-q', 'A')
      const A1 = commitIn(repo, 'a1.txt')
      git(repo, 'switch', '-q', 'main')
      const wt = join(repo, '..', `wt-${how}`)
      git(repo, 'worktree', 'add', '-q', '-b', 'cw/AM/AM-1-x', wt, A0)
      if (how === 'ff') git(wt, 'merge', '-q', '--ff-only', A1)
      else git(wt, 'reset', '-q', '--hard', A1)
      commitIn(wt, 'w.txt')
      git(repo, 'branch', '-D', 'A')
      expect(await prove(repo, wt, 'main', [A0])).toMatchObject({ why: 'notInTarget', rule: 'reflog' })
      git(repo, 'merge', '-q', '--ff-only', A1)
      forgetKeptAnswers()
      expect(await prove(repo, wt, 'main', [A0])).toBeNull()
    }
  })

  it('(b) A deleted locally but kept as origin/A, or A rewound with the old commits on a tag: refused', async () => {
    const { repo, A0 } = history()
    git(repo, 'merge', '-q', '--ff-only', 'A')
    git(repo, 'switch', '-q', 'A')
    const A1 = commitIn(repo, 'a1.txt')
    git(repo, 'switch', '-q', 'main')
    const wt = join(repo, '..', 'wt-b')
    // Its line built on A1 by a commit of its own (no merge, no fast-forward in its reflog): only the other ref tells.
    git(repo, 'worktree', 'add', '-q', '-b', 'cw/AM/AM-1-x', wt, A1)
    commitIn(wt, 'w.txt')
    git(repo, 'update-ref', 'refs/remotes/origin/A', A1)
    git(repo, 'branch', '-D', 'A')
    expect(await prove(repo, wt, 'main', [A0])).toMatchObject({ why: 'notInTarget', rule: 'otherRef' })
    git(repo, 'update-ref', '-d', 'refs/remotes/origin/A')
    git(repo, 'tag', 'old-A', A1)
    expect(await prove(repo, wt, 'main', [A0])).toMatchObject({ why: 'notInTarget', rule: 'otherRef' })
  })

  it('a rebase in its reflog, or a reflog that starts after the line was made, refuses', async () => {
    const { repo, A0 } = history()
    const { wt } = lineFrom(repo, 'A')
    git(repo, 'merge', '-q', '--ff-only', 'A')
    commitIn(repo, 'm.txt')
    git(wt, 'rebase', '-q', 'main')
    git(repo, 'branch', '-D', 'A')
    expect(await prove(repo, wt, 'main', [A0])).toMatchObject({ why: 'notInTarget', rule: 'reflog' })
    const gone = history()
    const l2 = lineFrom(gone.repo, 'A')
    git(gone.repo, 'merge', '-q', '--ff-only', 'A')
    git(gone.repo, 'reflog', 'expire', '--expire=all', 'refs/heads/cw/AM/AM-1-x')
    expect(await prove(gone.repo, l2.wt, 'main', [gone.A0])).toMatchObject({ why: 'cantCheck', rule: 'reflog' })
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// The move, on the real board.
// ---------------------------------------------------------------------------------------------------------------------

let wsN = 0
/** A workspace whose project `p` merges into the integration branch 1.2.0 (listing main), cards built in slots. */
async function workspace(): Promise<{ w: WS; repo: string }> {
  const ws = join(base, `ws-${++wsN}`)
  const repo = join(ws, 'p')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  mkdirSync(join(ws, '.combwork'), { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  commitIn(repo, 'a.txt')
  git(repo, 'branch', '1.2.0')
  const agents = [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }]
  const options = { ...allOff('git'), review: 'agent', noSelfReview: true, finish: 'agentMerges', folder: 'slots', target: '1.2.0', otherTargets: ['main'] }
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents, workflow: { platform: 'git', preset: null, options } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, repo }
}
const wfOf = async (w: WS, repo: string) => (await workflowFor(w, repo))!

/** A card started by b1 on 1.2.0, its slot's line made and one commit of its own on it: its number, folder and line. */
async function started(w: WS, repo: string, title = 'Card'): Promise<{ n: number; folder: string; line: string }> {
  const n = await inWorkspace(w, async () => (await tasks.createTask({ title, project: 'p' }, user)).number)
  const wf = await wfOf(w, repo)
  expect(await store.boardWrite(w, async () => wf.start(`#${n}`, agentActor('b1')))).toMatchObject({ ok: true })
  const s = wf.state(wf.store.card(n))
  const folder = s.started!.folder
  const line = s.started!.line!
  if (!existsSync(folder)) git(repo, 'worktree', 'add', '-q', '-b', line, folder, s.started!.base!)
  commitIn(folder, `work-${n}.txt`)
  return { n, folder, line }
}
/** 1.2.0 merged into main (the release), then deleted, and the project's target moved to main. */
async function release(w: WS, repo: string, o: { keepBranch?: boolean } = {}): Promise<void> {
  git(repo, 'merge', '-q', '--no-ff', '-m', '1.2.0 into main', '1.2.0')
  if (!o.keepBranch) git(repo, 'branch', '-D', '1.2.0')
  await w.mutateProjectConfig(repo, (cfg) => ({ workflow: { ...cfg.workflow!, options: { ...cfg.workflow!.options, target: 'main', otherTargets: o.keepBranch ? ['1.2.0'] : [] } } }))
}
const stateOf = async (w: WS, repo: string, n: number) => {
  const wf = await wfOf(w, repo)
  return wf.state(wf.store.card(n))
}
const kinds = async (w: WS, repo: string, n: number) => (await wfOf(w, repo)).store.facts(n).map((f) => f.kind)

describe('a card in flight on an integration branch that ended (HI-2753)', () => {
  it("its submit names the deleted target; moved to main (its work kept), it submits, and says so in its history", async () => {
    const { w, repo } = await workspace()
    const { n, line } = await started(w, repo)
    await release(w, repo)
    const wf = await wfOf(w, repo)
    const refused = await store.boardWrite(w, async () => wf.submit(`#${n}`, agentActor('b1'), { summary: 'Done' }))
    expect(refused).toMatchObject({ refused: true, rule: 'platform.targetGone' })
    expect(JSON.stringify(refused)).toMatch(/was started on 1\.2\.0, which no longer exists in this repository/)
    const before = head(repo, line)
    const card = await inWorkspace(w, () => tasks.setTarget(n, 'main', user))
    expect(card.history.at(-1)?.what).toMatch(/Moved from 1\.2\.0 to main, its branch and work kept/)
    const s = await stateOf(w, repo, n)
    expect(s.started).toMatchObject({ target: 'main', line })
    expect(head(repo, line)).toBe(before)
    expect(await kinds(w, repo, n)).toContain('Retargeted')
    // Its rules merge into main now.
    expect(wf.rulesetOf(wf.store.card(n)).options.target).toBe('main')
    expect(await store.boardWrite(w, async () => wf.submit(`#${n}`, agentActor('b1'), { summary: 'Done' }))).toMatchObject({ ok: true })
  })

  it("refused, nothing changed: an agent asking; an open queue entry; history main doesn't have", async () => {
    const { w, repo } = await workspace()
    const { n, folder } = await started(w, repo)
    await expect(inWorkspace(w, () => tasks.setTarget(n, 'main', { kind: 'agent', agentId: 'b1' } as never))).rejects.toThrow(/Only the user or the Assistant/)
    // 1.2.0 not merged into main: the line was started from a commit main lacks once 1.2.0 has its own.
    git(repo, 'switch', '-q', '1.2.0')
    commitIn(repo, 'r.txt')
    git(repo, 'switch', '-q', 'main')
    git(folder, 'merge', '-q', '--no-ff', '-m', 'release work in', '1.2.0')
    await expect(inWorkspace(w, () => tasks.setTarget(n, 'main', user))).rejects.toThrow(/stays on 1\.2\.0: its branch merged in history main doesn’t have/)
    expect((await stateOf(w, repo, n)).started?.target).toBe('1.2.0')
    // An open entry: it waits for it.
    const wf = await wfOf(w, repo)
    await store.boardWrite(w, async () => wf.write(wf.store.card(n), null, 'combwork', (x) => void x.fact('IntegrationRequested', { entry: 'e1', revision: head(repo, '1.2.0'), key: null, target: '1.2.0', style: 'merge' })))
    await expect(inWorkspace(w, () => tasks.setTarget(n, 'main', user))).rejects.toThrow(/is in the merge queue for 1\.2\.0/)
  })

  it('a commit on its line after the check and before git holds it: the prepare fails, nothing moves', async () => {
    const { w, repo } = await workspace()
    const { n, folder, line } = await started(w, repo)
    await release(w, repo)
    rc.moveTestHooks.checked = () => void commitIn(folder, 'late.txt')
    try {
      await expect(inWorkspace(w, () => tasks.setTarget(n, 'main', user))).rejects.toThrow(/changed while it was being moved/)
    } finally {
      rc.moveTestHooks.checked = undefined
    }
    expect((await stateOf(w, repo, n)).started?.target).toBe('1.2.0')
    expect(await kinds(w, repo, n)).not.toContain('Retargeted')
    // main moving after the check refuses it the same way.
    rc.moveTestHooks.checked = () => void git(repo, 'commit', '-q', '--allow-empty', '-m', 'main moves')
    try {
      await expect(inWorkspace(w, () => tasks.setTarget(n, 'main', user))).rejects.toThrow(/changed while it was being moved/)
    } finally {
      rc.moveTestHooks.checked = undefined
    }
    // Checked again with nothing moving: it moves, at the head it has now.
    await inWorkspace(w, () => tasks.setTarget(n, 'main', user))
    expect((await wfOf(w, repo)).store.facts(n).find((f) => f.kind === 'Retargeted')?.data).toMatchObject({ head: head(repo, line) })
  })

  it("a submission or a verdict between the check and the write changes what was proved: refused (HR2's round 1, finding 1)", async () => {
    const { w, repo } = await workspace()
    const { n, folder } = await started(w, repo)
    const W1 = git(folder, 'rev-parse', 'HEAD')
    commitIn(folder, 'second.txt')
    // main has W1 already: the reviewed change W1+W2 against 1.2.0 isn't the one main would get (W2), so a reviewed card
    // must be refused, though the card in Doing, as checked, could move.
    git(repo, 'merge', '-q', '--no-ff', '-m', 'part of it', W1)
    const other = await started(w, repo, 'Other')
    await release(w, repo, { keepBranch: true })
    const wf = await wfOf(w, repo)
    rc.moveTestHooks.checked = async () => {
      expect(await store.boardWrite(w, async () => wf.submit(`#${n}`, agentActor('b1'), { summary: 'Done' }))).toMatchObject({ ok: true })
    }
    try {
      await expect(inWorkspace(w, () => tasks.setTarget(n, 'main', user))).rejects.toThrow(/changed while it was being moved/)
    } finally {
      rc.moveTestHooks.checked = undefined
    }
    expect(await stateOf(w, repo, n)).toMatchObject({ stage: 'review', started: { target: '1.2.0' } })
    // Checked again now that it is reviewed: refused for what it is.
    await expect(inWorkspace(w, () => tasks.setTarget(n, 'main', user))).rejects.toThrow(/its reviewed work would bring other commits into main/)
    // A verdict between the check and the write: refused too.
    expect(await store.boardWrite(w, async () => wf.submit(`#${other.n}`, agentActor('b1'), { summary: 'Done' }))).toMatchObject({ ok: true })
    rc.moveTestHooks.checked = async () => {
      expect(await store.boardWrite(w, async () => wf.verdict(`#${other.n}`, agentActor('r1'), { pass: true, comment: 'ok', startReview: true }))).toMatchObject({ ok: true })
    }
    try {
      await expect(inWorkspace(w, () => tasks.setTarget(other.n, 'main', user))).rejects.toThrow(/changed while it was being moved/)
    } finally {
      rc.moveTestHooks.checked = undefined
    }
    expect((await stateOf(w, repo, other.n)).started?.target).toBe('1.2.0')
  })

  it('an enqueue or a lane started between the check and the write: refused under the locks, nothing moved', async () => {
    const { w, repo } = await workspace()
    const { n } = await started(w, repo)
    await release(w, repo)
    const wf = await wfOf(w, repo)
    rc.moveTestHooks.checked = () => store.boardWrite(w, async () => wf.write(wf.store.card(n), null, 'combwork', (x) => void x.fact('IntegrationRequested', { entry: 'e9', revision: 'x', key: null, target: '1.2.0', style: 'merge' })))
    try {
      await expect(inWorkspace(w, () => tasks.setTarget(n, 'main', user))).rejects.toThrow(/is in the merge queue for 1\.2\.0/)
    } finally {
      rc.moveTestHooks.checked = undefined
    }
    expect((await stateOf(w, repo, n)).started?.target).toBe('1.2.0')
  })

  it('while git holds the refs, a commit, a reset and an update of main all fail; the move is written at the head checked', async () => {
    const { w, repo } = await workspace()
    const { n, folder, line } = await started(w, repo)
    await release(w, repo)
    const at = head(repo, line)
    const tried: string[] = []
    hold.refHoldTestHooks.prepared = () => {
      for (const args of [['commit', '-q', '--allow-empty', '-m', 'meanwhile'], ['reset', '-q', '--hard', 'HEAD~1']] as const) {
        try {
          git(folder, ...args)
          tried.push(`${args[0]}: ok`)
        } catch (e) {
          tried.push(`${args[0]}: ${/cannot lock ref|Unable to create/.test(String((e as { stderr?: unknown }).stderr ?? e)) ? 'locked' : 'failed'}`)
        }
      }
      try {
        git(repo, 'update-ref', 'refs/heads/main', at)
        tried.push('main: ok')
      } catch {
        tried.push('main: locked')
      }
    }
    await inWorkspace(w, () => tasks.setTarget(n, 'main', user))
    expect(tried).toEqual(['commit: locked', 'reset: locked', 'main: locked'])
    expect(head(repo, line)).toBe(at)
    expect((await stateOf(w, repo, n)).started?.target).toBe('main')
    // Released afterwards: git takes commits again.
    commitIn(folder, 'after.txt')
  })

  it("someone else's lock on its line refuses it, named, and is left there; so is a lock taken after ours was released", async () => {
    const { w, repo } = await workspace()
    const { n, line } = await started(w, repo)
    await release(w, repo)
    const lock = join(repo, '.git', 'refs', 'heads', ...line.split('/')) + '.lock'
    writeFileSync(lock, '')
    await expect(inWorkspace(w, () => tasks.setTarget(n, 'main', user))).rejects.toThrow(/Another git operation holds refs\/heads\/.*remove .*\.lock/)
    expect(existsSync(lock)).toBe(true)
    expect((await stateOf(w, repo, n)).started?.target).toBe('1.2.0')
    // A live transaction of another git (another Combwork's, say) holding it: refused too, and its lock untouched.
    execFileSync('cmd', ['/c', 'del', lock])
    const other = spawn('git', ['update-ref', '--stdin'], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] })
    other.stdin.write(`start\nverify refs/heads/${line} ${head(repo, line)}\nprepare\n`)
    await vi.waitFor(() => expect(existsSync(lock)).toBe(true), { timeout: HUNG_MS })
    await expect(inWorkspace(w, () => tasks.setTarget(n, 'main', user))).rejects.toThrow(/Another git operation holds/)
    expect(existsSync(lock)).toBe(true)
    other.stdin.end()
    await new Promise((r) => other.once('exit', r))
    expect(existsSync(lock)).toBe(false)
    // Moved; then a new lock on the same ref (someone else's): nothing of ours removes it.
    await inWorkspace(w, () => tasks.setTarget(n, 'main', user))
    writeFileSync(lock, '')
    await expect(inWorkspace(w, () => tasks.setTarget(n, null, user))).resolves.toBeTruthy()
    expect(existsSync(lock)).toBe(true)
    execFileSync('cmd', ['/c', 'del', lock])
  })

  it('its git ending, or its input breaking, before the write: refused, nothing written; a prepare that never answers is refused and reaped', async () => {
    const { w, repo } = await workspace()
    const { n } = await started(w, repo)
    await release(w, repo)
    const { line } = (await stateOf(w, repo, n)).started as { line: string }
    const lock = join(repo, '.git', 'refs', 'heads', ...line.split('/')) + '.lock'
    for (const how of ['stdin', 'kill'] as const) {
      hold.refHoldTestHooks.prepared = async (child) => {
        // Killed hard, its whole tree (HI-2809): where PATH's git is Git for Windows' launcher (`cmd\git.exe`, as on
        // GitHub's runner), the real git is its child, and killing the launcher alone leaves that git to see its input
        // close and abort, removing its locks itself. Ended by identity through the handle held (#603); the lock left
        // (below) is what proves the kill.
        if (how === 'kill') endChildTree(child)
        else child.stdin?.destroy()
        await new Promise((r) => (child.exitCode !== null ? r(null) : child.once('exit', r)))
      }
      await expect(inWorkspace(w, () => tasks.setTarget(n, 'main', user))).rejects.toThrow(/changed while it was being moved/)
      expect((await stateOf(w, repo, n)).started?.target).toBe('1.2.0')
      expect(await kinds(w, repo, n)).not.toContain('Retargeted')
    }
    // Its input broken, git aborted and removed its locks itself; killed hard, git left them, and Combwork never removes
    // one: the next move says which file, for the user to remove once no git runs there.
    expect(existsSync(lock)).toBe(true)
    hold.refHoldTestHooks.prepared = undefined
    await expect(inWorkspace(w, () => tasks.setTarget(n, 'main', user))).rejects.toThrow(/Another git operation holds/)
    execFileSync('cmd', ['/c', 'del', lock])
    const mainLock = join(repo, '.git', 'refs', 'heads', 'main.lock')
    if (existsSync(mainLock)) execFileSync('cmd', ['/c', 'del', mainLock])
    hold.refHoldTestHooks.prepared = undefined
    const was = rc.REF_HOLD.prepareMs
    rc.REF_HOLD.prepareMs = 1
    try {
      await expect(inWorkspace(w, () => tasks.setTarget(n, 'main', user))).rejects.toThrow(/Combwork can’t tell whether everything .* \(git update-ref didn't prepare within 1 ms\)/)
    } finally {
      rc.REF_HOLD.prepareMs = was
    }
    expect((await stateOf(w, repo, n)).started?.target).toBe('1.2.0')
  })

  it('two moves at once: one moves, the other is refused (its card no longer as checked, or git holding it)', async () => {
    const { w, repo } = await workspace()
    const { n } = await started(w, repo)
    await release(w, repo, { keepBranch: true })
    const r = await Promise.allSettled([inWorkspace(w, () => tasks.setTarget(n, 'main', user)), inWorkspace(w, () => tasks.setTarget(n, 'main', user))])
    const kindsOf = (await kinds(w, repo, n)).filter((k) => k === 'Retargeted')
    expect(kindsOf).toHaveLength(1)
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(r.length - r.filter((x) => x.status === 'rejected').length)
    for (const x of r) if (x.status === 'rejected') expect(String(x.reason)).toMatch(/changed while it was being moved|Another git operation/)
  })
})

describe("a reviewed card's evidence when it moves (HI-2753, HR1's point 3)", () => {
  it('passed: the same commits on main keep its verdict and runs, its base the one with main; other commits refuse it', async () => {
    const { w, repo } = await workspace()
    const { n } = await started(w, repo)
    const wf = await wfOf(w, repo)
    expect(await store.boardWrite(w, async () => wf.submit(`#${n}`, agentActor('b1'), { summary: 'Done' }))).toMatchObject({ ok: true })
    expect(await store.boardWrite(w, async () => wf.verdict(`#${n}`, agentActor('r1'), { pass: true, comment: 'ok', startReview: true }))).toMatchObject({ ok: true })
    const before = await stateOf(w, repo, n)
    expect(before.stage).toBe('approved')
    await release(w, repo)
    await inWorkspace(w, () => tasks.setTarget(n, 'main', user))
    const s = await stateOf(w, repo, n)
    expect(s.verdicts.filter((v) => v.pass)).toHaveLength(1)
    expect(s.latest?.revision).toBe(before.latest?.revision)
    expect(s.latest?.base).toBe(git(repo, 'merge-base', s.latest!.revision!, 'main'))
    expect(s.approved).toMatchObject({ revision: before.latest?.revision, base: s.latest?.base })
    // The merge preview cached for the old target no longer counts (keyed by started.target).
    expect(s.started?.target).toBe('main')
  })

  it("a reviewed card whose change would bring other commits into main is refused, to go back through review", async () => {
    const { w, repo } = await workspace()
    const { n, folder } = await started(w, repo)
    const W1 = git(folder, 'rev-parse', 'HEAD')
    commitIn(folder, 'second.txt')
    const wf = await wfOf(w, repo)
    expect(await store.boardWrite(w, async () => wf.submit(`#${n}`, agentActor('b1'), { summary: 'Done' }))).toMatchObject({ ok: true })
    expect(await store.boardWrite(w, async () => wf.verdict(`#${n}`, agentActor('r1'), { pass: true, comment: 'ok', startReview: true }))).toMatchObject({ ok: true })
    // Part of its reviewed work reached main another way: its change into main isn't the one reviewed.
    git(repo, 'merge', '-q', '--no-ff', '-m', 'part of it', W1)
    await release(w, repo, { keepBranch: true })
    await expect(inWorkspace(w, () => tasks.setTarget(n, 'main', user))).rejects.toThrow(/its reviewed work would bring other commits into main than it was reviewed with/)
    expect((await stateOf(w, repo, n)).started?.target).toBe('1.2.0')
  })
})

describe('a running lane and its card in flight (HI-2753)', () => {
  it('a direct move of a lane card on another target is refused; the retarget moves the lane and its card together', async () => {
    const { w, repo } = await workspace()
    const c = await inWorkspace(w, async () => (await tasks.createTask({ title: 'Lane card', project: 'p' }, user)).number)
    const next = await inWorkspace(w, async () => (await tasks.createTask({ title: 'Next', project: 'p' }, user)).number)
    await lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [c, next], by: 'You' })
    const wf = await wfOf(w, repo)
    if (wf.state(wf.store.card(c)).stage === 'todo') expect(await store.boardWrite(w, async () => wf.start(`#${c}`, agentActor('b1')))).toMatchObject({ ok: true })
    const s0 = wf.state(wf.store.card(c))
    if (!existsSync(s0.started!.folder)) git(repo, 'worktree', 'add', '-q', '-b', s0.started!.line!, s0.started!.folder, s0.started!.base!)
    commitIn(s0.started!.folder, 'lane.txt')
    await release(w, repo, { keepBranch: true })
    await expect(inWorkspace(w, () => tasks.setTarget(c, 'main', user))).rejects.toThrow(/a lane and its card move together/)
    const p = await inWorkspace(w, () => retarget.retargetPreview(w, repo, '1.2.0', 'main'))
    expect(p.laneMoves).toEqual([expect.objectContaining({ builder: 'B1', card: expect.objectContaining({ number: c }) })])
    const r = await inWorkspace(w, () => retarget.retargetApply(w, repo, p, user))
    expect(r.moved.lanes).toHaveLength(1)
    expect(r.moved.cards.map((x) => x.number)).toEqual([c])
    expect(wf.state(wf.store.card(c)).started?.target).toBe('main')
    const laneRec = wf.lane(wf.store.card(c).lane!)!
    expect(targetOfRulesetId(laneRec.ruleset!)).toBe('main')
    // A stale preview applied again: the lane no longer as it was seen, nothing moved twice.
    const again = await inWorkspace(w, () => retarget.retargetApply(w, repo, p, user))
    expect(again.moved.lanes).toEqual([])
    expect(again.skipped[0]).toMatchObject({ why: 'changed' })
  })
})

describe("a lane as its preview saw it (HR2's round 1, finding 2)", () => {
  it('a card added to the running lane after the preview: the lane and its card stay (changed); a fresh preview moves them', async () => {
    const { w, repo } = await workspace()
    const c = await inWorkspace(w, async () => (await tasks.createTask({ title: 'Lane card', project: 'p' }, user)).number)
    await lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [c], by: 'You' })
    const wf = await wfOf(w, repo)
    if (wf.state(wf.store.card(c)).stage === 'todo') expect(await store.boardWrite(w, async () => wf.start(`#${c}`, agentActor('b1')))).toMatchObject({ ok: true })
    const s0 = wf.state(wf.store.card(c))
    if (!existsSync(s0.started!.folder)) git(repo, 'worktree', 'add', '-q', '-b', s0.started!.line!, s0.started!.folder, s0.started!.base!)
    commitIn(s0.started!.folder, 'lane.txt')
    await release(w, repo, { keepBranch: true })
    const p = await inWorkspace(w, () => retarget.retargetPreview(w, repo, '1.2.0', 'main'))
    expect(p.laneMoves).toHaveLength(1)
    // D joins the running lane after the preview (its list queued while C is in flight: either way not as seen).
    const d = await inWorkspace(w, async () => (await tasks.createTask({ title: 'Joins later', project: 'p' }, user)).number)
    await lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [c, d], by: 'You' })
    const r = await inWorkspace(w, () => retarget.retargetApply(w, repo, p, user))
    expect(r.moved.lanes).toEqual([])
    expect(r.moved.cards).toEqual([])
    expect(r.skipped).toEqual([expect.objectContaining({ card: c, why: 'changed' })])
    expect(wf.state(wf.store.card(c)).started?.target).toBe('1.2.0')
    expect(targetOfRulesetId(wf.lane(wf.store.card(c).lane!)!.ruleset!)).toBeNull()
    // Seen again: it moves with its new list.
    const p2 = await inWorkspace(w, () => retarget.retargetPreview(w, repo, '1.2.0', 'main'))
    const r2 = await inWorkspace(w, () => retarget.retargetApply(w, repo, p2, user))
    expect(r2.moved.lanes).toHaveLength(1)
    expect(wf.state(wf.store.card(c)).started?.target).toBe('main')
  })

  it('a lane with no card in flight whose list or rules changed after the preview stays (changed)', async () => {
    const { w, repo } = await workspace()
    const c = await inWorkspace(w, async () => (await tasks.createTask({ title: 'Todo in lane', project: 'p' }, user)).number)
    await lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [c], by: 'You' })
    const wf = await wfOf(w, repo)
    if (wf.state(wf.store.card(c)).stage !== 'todo') expect(await store.boardWrite(w, async () => wf.putBack(`#${c}`, 'user'))).toMatchObject({ ok: true })
    await release(w, repo, { keepBranch: true })
    const p = await inWorkspace(w, () => retarget.retargetPreview(w, repo, '1.2.0', 'main'))
    expect(p.laneMoves).toEqual([expect.objectContaining({ card: null })])
    const d = await inWorkspace(w, async () => (await tasks.createTask({ title: 'Joins later', project: 'p' }, user)).number)
    await lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [c, d], by: 'You' })
    const r = await inWorkspace(w, () => retarget.retargetApply(w, repo, p, user))
    expect(r.moved.lanes).toEqual([])
    expect(r.skipped).toEqual([expect.objectContaining({ why: 'changed', detail: 'the lane changed meanwhile' })])
    // Its rules as a stale preview saw them: stays too.
    const p2 = await inWorkspace(w, () => retarget.retargetPreview(w, repo, '1.2.0', 'main'))
    const stale = { ...p2, laneMoves: p2.laneMoves!.map((l) => ({ ...l, ruleset: `${l.ruleset}~target:other` })) }
    const r2 = await inWorkspace(w, () => retarget.retargetApply(w, repo, stale, user))
    expect(r2.moved.lanes).toEqual([])
    const r3 = await inWorkspace(w, () => retarget.retargetApply(w, repo, p2, user))
    expect(r3.moved.lanes).toHaveLength(1)
  })
})

describe("a restart keeps the card's branch (HI-2753, comment 2)", () => {
  it('put back, retitled and started again: the same line, its work there', async () => {
    const { w, repo } = await workspace()
    const { n, line } = await started(w, repo, 'Old title')
    const wf = await wfOf(w, repo)
    expect(await store.boardWrite(w, async () => wf.putBack(`#${n}`, 'user'))).toMatchObject({ ok: true })
    await inWorkspace(w, () => tasks.updateTask(n, { title: 'A new title' }, user))
    expect(await store.boardWrite(w, async () => wf.start(`#${n}`, agentActor('b1')))).toMatchObject({ ok: true })
    expect(wf.state(wf.store.card(n)).started?.line).toBe(line)
  })
})
