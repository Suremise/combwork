// A card's move to another target, its git commands traced (HI-2821, the tail of the 1.4.0 Git refactor; SPEC §16.3.6's
// rule 1): the own-work proof (rules a to d), a card's check and its move, run through the history port's own-work proof
// and port 1's ref holds, are the same git commands (folder, argv, order) as before the port. The expected traces were
// recorded at the revision before the port (d2662263a) with `CW_RECORD_RETARGET_TRACES=1 npx vitest run
// tests/retargetTraces.test.ts`, into tests/fixtures/retargetTraces.json; a trace that differs is a behaviour change.
// The hold's own `git update-ref --stdin` is spawned directly (refHold.ts), so it isn't traced: retargetCard.test.ts
// holds what it does.
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

vi.setConfig({ testTimeout: 60_000 })

const base = tempDir('cw-retargettraces-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const rc = await import('../src/main/workflow/retargetCard')
const { gitTestHooks } = await import('../src/main/git')
const { forgetKeptAnswers } = await import('../src/main/platform/git')
const { advanced } = await import('../src/main/advanced')
const { setSlotStarts, workflowFor } = await import('../src/main/workflow/service')
const { agentActor } = await import('../src/shared/workflow/facts')
const { allOff } = await import('../src/shared/workflow/options')

const FIXTURE = join(__dirname, 'fixtures', 'retargetTraces.json')
const RECORD = process.env.CW_RECORD_RETARGET_TRACES === '1'
const recorded: Record<string, string[]> = {}
const expected = (): Record<string, string[]> => (existsSync(FIXTURE) ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string[]>) : {})

advanced.load(join(base, 'profile'))
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
const user = { kind: 'user' } as const

let slotN = 0
setSlotStarts({ leaseFor: async () => ({ slot: `slot-${++slotN}`, folder: join(base, `slot-${slotN}`), lease: `l-${slotN}`, fresh: false }), unused: async () => undefined })
afterAll(async () => {
  setSlotStarts(null)
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})
afterEach(() => {
  gitTestHooks.started = undefined
  if (RECORD) writeFileSync(FIXTURE, `${JSON.stringify({ ...expected(), ...recorded }, null, 2)}\n`)
})

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
const commitIn = (cwd: string, file: string): string => {
  writeFileSync(join(cwd, file), `${file}\n`)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-qm', file)
  return git(cwd, 'rev-parse', 'HEAD')
}
const head = (repo: string, ref: string): string => git(repo, 'rev-parse', ref)

/**
 * The git commands `fn` started in `under` (its folders: the repository and the card's), each `<folder> :: <args>`, with
 * those folders and full ids made stable. Commands elsewhere (the workspace's own reads of its profile) are left out.
 */
async function traced(under: Record<string, string>, fn: () => Promise<unknown>): Promise<string[]> {
  const ran: string[] = []
  const norm = (s: string): string => s.replace(/\\/g, '/').toLowerCase()
  const places = Object.entries(under)
    .map(([name, p]) => [name, norm(resolve(p))] as const)
    .sort((a, b) => b[1].length - a[1].length)
  const stable = (s: string): string => places.reduce((x, [name, p]) => x.split(p).join(`<${name}>`), norm(s)).replace(/\b[0-9a-f]{40}\b/g, '<id>')
  forgetKeptAnswers()
  gitTestHooks.started = (cwd, args) => {
    const at = norm(resolve(cwd))
    if (places.some(([, p]) => at === p || at.startsWith(`${p}/`))) ran.push(stable(`${resolve(cwd)} :: ${args.join(' ')}`))
  }
  try {
    await fn()
  } finally {
    gitTestHooks.started = undefined
  }
  return ran
}

/** Checks (or, recording, keeps) the trace of one step. */
function same(step: string, trace: string[]): void {
  if (RECORD) recorded[step] = trace
  else expect(trace, step).toEqual(expected()[step])
}

/** A repository on main (C), with the integration branch A one commit ahead (A0). */
function history(): { repo: string; A0: string } {
  const repo = join(tempDir('rt-proof-'), 'repo')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'core.autocrlf', 'false')
  commitIn(repo, 'c.txt')
  git(repo, 'switch', '-q', '-c', 'A')
  const A0 = commitIn(repo, 'a0.txt')
  git(repo, 'switch', '-q', 'main')
  return { repo, A0 }
}
const LINE = 'cw/AM/AM-1-x'
function lineFrom(repo: string, from: string): string {
  const wt = join(repo, '..', 'wt')
  git(repo, 'worktree', 'add', '-q', '-b', LINE, wt, from)
  commitIn(wt, 'w.txt')
  return wt
}
const prove = (repo: string, wt: string, anchors: string[]) =>
  traced({ repo, wt }, () => rc.proveOwn(repo, { line: LINE, head: head(repo, LINE), target: head(repo, 'main'), anchors, own: rc.ownRefs('AM-1', [LINE]), folder: wt, reflog: true }))

describe("the own-work proof's git commands (HI-2821)", () => {
  it('a line that moves (the integration branch merged, then deleted)', async () => {
    const { repo, A0 } = history()
    const wt = lineFrom(repo, 'A')
    git(repo, 'merge', '-q', '--no-ff', '-m', 'A into main', 'A')
    git(repo, 'branch', '-D', 'A')
    same('prove: moves', await prove(repo, wt, [A0]))
  })

  it('nothing to bring', async () => {
    const { repo, A0 } = history()
    const wt = join(repo, '..', 'wt')
    git(repo, 'merge', '-q', '--ff-only', 'A')
    git(repo, 'worktree', 'add', '-q', '-b', LINE, wt, 'main')
    same('prove: nothing to bring', await prove(repo, wt, [A0]))
  })

  it('(a) a merge of history main lacks', async () => {
    const { repo, A0 } = history()
    const wt = lineFrom(repo, 'A')
    git(repo, 'merge', '-q', '--ff-only', 'A')
    git(repo, 'switch', '-q', 'A')
    commitIn(repo, 'a1.txt')
    git(repo, 'switch', '-q', 'main')
    git(wt, 'merge', '-q', '--no-ff', '-m', 'A1 in', 'A')
    git(repo, 'branch', '-D', 'A')
    same('prove: firstParent', await prove(repo, wt, [A0]))
  })

  it('(b) its commits on another ref', async () => {
    const { repo, A0 } = history()
    git(repo, 'merge', '-q', '--ff-only', 'A')
    git(repo, 'switch', '-q', 'A')
    const A1 = commitIn(repo, 'a1.txt')
    git(repo, 'switch', '-q', 'main')
    const wt = join(repo, '..', 'wt')
    git(repo, 'worktree', 'add', '-q', '-b', LINE, wt, A1)
    commitIn(wt, 'w.txt')
    git(repo, 'tag', 'old-A', A1)
    git(repo, 'branch', '-D', 'A')
    same('prove: otherRef', await prove(repo, wt, [A0]))
  })

  it('(c) its reflog: a fast-forward main lacks, a rebase, a log cut short', async () => {
    const { repo, A0 } = history()
    git(repo, 'merge', '-q', '--ff-only', 'A')
    git(repo, 'switch', '-q', 'A')
    const A1 = commitIn(repo, 'a1.txt')
    git(repo, 'switch', '-q', 'main')
    const wt = join(repo, '..', 'wt')
    git(repo, 'worktree', 'add', '-q', '-b', LINE, wt, A0)
    git(wt, 'merge', '-q', '--ff-only', A1)
    commitIn(wt, 'w.txt')
    git(repo, 'branch', '-D', 'A')
    same('prove: reflog', await prove(repo, wt, [A0]))
    const r = history()
    const rw = lineFrom(r.repo, 'A')
    git(r.repo, 'merge', '-q', '--ff-only', 'A')
    commitIn(r.repo, 'm.txt')
    git(rw, 'rebase', '-q', 'main')
    git(r.repo, 'branch', '-D', 'A')
    same('prove: rebase', await prove(r.repo, rw, [r.A0]))
    const g = history()
    const gw = lineFrom(g.repo, 'A')
    git(g.repo, 'merge', '-q', '--ff-only', 'A')
    git(g.repo, 'reflog', 'expire', '--expire=all', `refs/heads/${LINE}`)
    same('prove: reflog cut short', await prove(g.repo, gw, [g.A0]))
  })

  it('(d) started from a commit main lacks', async () => {
    const { repo, A0 } = history()
    const wt = lineFrom(repo, 'A')
    git(repo, 'branch', '-D', 'A')
    same('prove: anchor', await prove(repo, wt, [A0]))
  })
})

let wsN = 0
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

async function started(w: WS, repo: string): Promise<{ n: number; folder: string }> {
  const n = await inWorkspace(w, async () => (await tasks.createTask({ title: 'Card', project: 'p' }, user)).number)
  const wf = await wfOf(w, repo)
  expect(await store.boardWrite(w, async () => wf.start(`#${n}`, agentActor('b1')))).toMatchObject({ ok: true })
  const s = wf.state(wf.store.card(n))
  const folder = s.started!.folder
  if (!existsSync(folder)) git(repo, 'worktree', 'add', '-q', '-b', s.started!.line!, folder, s.started!.base!)
  commitIn(folder, `work-${n}.txt`)
  return { n, folder }
}
async function release(w: WS, repo: string): Promise<void> {
  git(repo, 'merge', '-q', '--no-ff', '-m', '1.2.0 into main', '1.2.0')
  git(repo, 'branch', '-D', '1.2.0')
  await w.mutateProjectConfig(repo, (cfg) => ({ workflow: { ...cfg.workflow!, options: { ...cfg.workflow!.options, target: 'main', otherTargets: [] } } }))
}

describe("a card's check and move: their git commands (HI-2821)", () => {
  it('a card in Doing checked, a reviewed one checked, and a move', async () => {
    const { w, repo } = await workspace()
    const a = await started(w, repo)
    const b = await started(w, repo)
    const wf = await wfOf(w, repo)
    // b submitted on 1.2.0: in Review, its reviewed revision checked too.
    expect(await store.boardWrite(w, async () => wf.submit(`#${b.n}`, agentActor('b1'), { summary: 'Done' }))).toMatchObject({ ok: true })
    await release(w, repo)
    const under = { repo, a: a.folder, b: b.folder }
    let ok: unknown
    same('check: a card in Doing', await traced(under, async () => (ok = await rc.checkCardMove(wf, repo, wf.store.card(a.n), 'main'))))
    expect(ok).toMatchObject({ ok: true })
    same('check: a reviewed card', await traced(under, async () => (ok = await rc.checkCardMove(wf, repo, wf.store.card(b.n), 'main'))))
    expect(ok).toMatchObject({ ok: true })
    same('check: a target that is gone', await traced(under, async () => (ok = await rc.checkCardMove(wf, repo, wf.store.card(a.n), '1.2.0'))))
    expect(ok).toMatchObject({ ok: false, why: 'targetMissing' })
    same('move', await traced(under, () => inWorkspace(w, () => tasks.setTarget(a.n, 'main', user))))
    expect(wf.state(wf.store.card(a.n)).started?.target).toBe('main')
  })
})
