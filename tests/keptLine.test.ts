// HI-3112: a card put back with its line from 1.4.0, then Work merges into moved to main (which lacks 1.4.0's commits).
// It keeps merging into 1.4.0: its start (the target slot lending is asked for, the recorded Started.target, its review's
// files and where the queue merges it), a change of Work merges into's preview (kept, why `line`), a branch's uses
// (referencesTo, read against the destination: an untouched line is in 1.4.0 but not in main), and setting it back to
// 1.4.0. A line that can't be read keeps it too (never freed); one gone or already in main follows main; a lane on main
// refuses its start. On real git, through the workspace service and the merge queue (slot lending stood in for).
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

vi.setConfig({ testTimeout: 120_000 })
const base = tempDir('cw-kept-line-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const lanes = await import('../src/main/lanes')
const form = await import('../src/main/workflow/optionsForm')
const retarget = await import('../src/main/workflow/retarget')
const nv = await import('../src/main/workflow/nextVersion')
const { advanced } = await import('../src/main/advanced')
const { setSlotStarts, workflowFor } = await import('../src/main/workflow/service')
const { agentActor } = await import('../src/shared/workflow/facts')
const { preset } = await import('../src/shared/workflow/options')
const { MergeQueue } = await import('../src/main/workflow/mergeQueue')

advanced.load(join(base, 'profile'))
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
const user = { kind: 'user' } as const

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
const commitIn = (cwd: string, file: string): string => {
  writeFileSync(join(cwd, file), `${file}\n`)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-qm', file)
  return git(cwd, 'rev-parse', 'HEAD')
}

/** The targets slot lending was asked for, in order (the start's `slotFor`). */
const lent: string[] = []
let slotN = 0
setSlotStarts({
  leaseFor: async (_ws, _project, _card, _builder, o) => {
    if (!o.dry && o.target) lent.push(o.target)
    return { slot: `slot-${++slotN}`, folder: join(base, `slot-${slotN}`), lease: `l-${slotN}`, fresh: false }
  },
  unused: async () => undefined
})
afterAll(async () => {
  setSlotStarts(null)
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

let wsN = 0
/** A Pair project in slots merging into 1.4.0, which has three commits main lacks; main listed too. */
async function workspace(): Promise<{ w: WS; repo: string }> {
  const ws = join(base, `ws-${++wsN}`)
  const repo = join(ws, 'p')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  mkdirSync(join(ws, '.combwork'), { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'core.autocrlf', 'false')
  git(repo, 'config', 'user.name', 'T')
  git(repo, 'config', 'user.email', 't@example.invalid')
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  commitIn(repo, 'a.txt')
  git(repo, 'branch', '1.4.0')
  git(repo, 'checkout', '-q', '1.4.0')
  for (const f of ['feature-1.txt', 'feature-2.txt', 'feature-3.txt']) commitIn(repo, f)
  git(repo, 'checkout', '-q', 'main')
  const agents = ['b1', 'b2', 'r1'].map((id) => ({ id, name: id.toUpperCase() }))
  const { platform: _p, ...pair } = preset('git', 'pair')
  const options = { ...pair, preChecks: [], mergeChecks: [], maxAgents: 8, target: '1.4.0', otherTargets: ['main'] }
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents, workflow: { platform: 'git', preset: 'pair', options } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, repo }
}
const wfOf = async (w: WS, repo: string) => (await workflowFor(w, repo))!
const make = async (w: WS, title: string) => inWorkspace(w, async () => tasks.createTask({ title, project: 'p' }, user))
const labelOf = (c: { number: number; key?: string | null }) => c.key ?? `#${c.number}`

/** Starts a card for `builder` and makes its worktree as the slot's preparation would: the reply and its Started. */
async function start(w: WS, repo: string, n: number, builder: string) {
  const wf = await wfOf(w, repo)
  const reply = (await store.boardWrite(w, async () => wf.start(`#${n}`, agentActor(builder)))) as { ok?: boolean; refused?: boolean; rule?: string; warnings?: string[] }
  const s = wf.state(wf.store.card(n))
  if (!s.started || s.stage === 'todo') return { reply, started: null }
  const { folder, line, base: b } = s.started
  if (folder !== 'project' && !existsSync(folder)) {
    if (git(repo, 'branch', '--list', line!) !== '') {
      // Its old slot gave the line back (as a released slot waits detached).
      for (const blk of git(repo, 'worktree', 'list', '--porcelain').split(/\r?\n\r?\n/)) if (blk.includes(`branch refs/heads/${line}`)) git(blk.split(/\r?\n/)[0].replace(/^worktree /, ''), 'checkout', '-q', '--detach')
      git(repo, 'worktree', 'add', '-q', folder, line!)
    } else git(repo, 'worktree', 'add', '-q', '-b', line!, folder, b!)
    await wf.write(wf.store.card(n), null, 'combwork', (x) => void x.fact('SlotPrepared', { lease: s.started!.lease!, line: line!, revision: b! }))
  }
  return { reply, started: s.started }
}
const act = async (w: WS, repo: string, f: (wf: Awaited<ReturnType<typeof wfOf>>) => Promise<unknown>) => store.boardWrite(w, async () => f(await wfOf(w, repo)))
const putBack = (w: WS, repo: string, n: number) => act(w, repo, (wf) => wf.putBack(`#${n}`, 'user'))
/** Work merges into set to `target`, Other branches to `others`, as the tab saves it. */
async function saveTarget(w: WS, repo: string, target: string, others: string[]) {
  const f = await inWorkspace(w, () => form.workflowForm(w, repo))
  await inWorkspace(w, () => form.setWorkflowOptions(w, repo, { preset: f.preset, options: { ...f.own, target, otherTargets: others } }))
}
const preview = async (w: WS, repo: string, from: string, to: string) => inWorkspace(w, () => retarget.retargetPreview(w, repo, from, to))
const uses = (w: WS, repo: string, branch: string, dest?: string) => inWorkspace(w, () => retarget.referencesTo(w, repo, branch, () => [], dest))

/** A card started on 1.4.0, `work` committed on its line (or nothing), put back; Work merges into then saved as main. */
async function putBackThenMain(w: WS, repo: string, work: boolean) {
  const card = await make(w, work ? 'Small fix' : 'Started, nothing done')
  const first = await start(w, repo, card.number, 'b1')
  expect(first.started).toMatchObject({ target: '1.4.0' })
  if (work) commitIn(first.started!.folder, 'fix.txt')
  await putBack(w, repo, card.number)
  await saveTarget(w, repo, 'main', ['1.4.0'])
  return { card, line: first.started!.line!, folder: first.started!.folder }
}

describe('a card put back with its line from 1.4.0, Work merges into then main (HI-3112)', () => {
  it('keeps 1.4.0 with work on its line: the lending, the start, the review and the merge; kept in the preview and the uses', async () => {
    const { w, repo } = await workspace()
    const { card, line } = await putBackThenMain(w, repo, true)
    const label = labelOf(card)
    // The change's preview and a branch's uses say it, read against main.
    const p = await preview(w, repo, '1.4.0', 'main')
    expect(p.cards.keep).toEqual([expect.objectContaining({ number: card.number, why: 'line' })])
    expect(p.cards.move).toEqual([])
    expect(await uses(w, repo, '1.4.0')).toContain(label)
    // So 1.4.0 can't be taken out of Other branches from under it.
    await expect(saveTarget(w, repo, 'main', [])).rejects.toThrow(new RegExp(`while these use it: .*${label}`))
    // Its start: lent for 1.4.0, recorded on 1.4.0, the same line carried on, said so.
    lent.length = 0
    const again = await start(w, repo, card.number, 'b1')
    expect(lent).toEqual(['1.4.0'])
    expect(again.started).toMatchObject({ target: '1.4.0', line })
    expect(again.reply.warnings?.join(' ')).toMatch(/carries the line on there, as it was \(it merges into 1\.4\.0\)/)
    // Its review's files: its own fix alone.
    expect(git(repo, 'diff', '--name-only', again.started!.base!, line)).toBe('fix.txt')
    expect(await act(w, repo, (wf) => wf.submit(`#${card.number}`, agentActor('b1'), { summary: 'Done' }))).toMatchObject({ ok: true })
    const wf = await wfOf(w, repo)
    expect(wf.state(wf.store.card(card.number)).latest?.files.map((f) => f.path)).toEqual(['fix.txt'])
    expect(await act(w, repo, (x) => x.verdict(`#${card.number}`, agentActor('r1'), { pass: true, comment: 'ok', startReview: true }))).toMatchObject({ ok: true })
    await inWorkspace(w, () => new MergeQueue(wf, { folder: join(base, `queue-${wsN}`), runCheck: async () => ({ ok: true, output: '' }) }).drain('1.4.0'))
    // Merged into 1.4.0, never main: main still lacks 1.4.0's commits and the fix.
    expect(git(repo, 'log', '--format=%s', '1.4.0')).toMatch(/fix\.txt/)
    expect(git(repo, 'log', '--format=%s', 'main')).not.toMatch(/fix\.txt|feature-/)
    expect(wf.state(wf.store.card(card.number)).stage).toBe('done')
  })

  it('keeps 1.4.0 with no commits of its own, its line on 1.4.0’s history main lacks: the start, the preview and the uses', async () => {
    const { w, repo } = await workspace()
    const { card } = await putBackThenMain(w, repo, false)
    expect((await preview(w, repo, '1.4.0', 'main')).cards.keep).toEqual([expect.objectContaining({ number: card.number, why: 'line' })])
    // Read against main, the destination: the line is in 1.4.0 itself, which would never count it.
    expect(await uses(w, repo, '1.4.0', 'main')).toContain(labelOf(card))
    expect((await start(w, repo, card.number, 'b1')).started).toMatchObject({ target: '1.4.0' })
  })

  it('is set back to 1.4.0 by its Merges into: accepted, its line kept', async () => {
    const { w, repo } = await workspace()
    const { card, line } = await putBackThenMain(w, repo, true)
    expect((await inWorkspace(w, () => tasks.setTarget(card.number, '1.4.0', user))).number).toBe(card.number)
    expect(git(repo, 'branch', '--list', line)).not.toBe('')
    // Elsewhere it stays refused: it has work on its branch made from 1.4.0.
    await expect(inWorkspace(w, () => tasks.setTarget(card.number, 'main', user))).rejects.toThrow(/has work on its branch made from 1\.4\.0/)
  })

  it('follows main once its line is gone, or all of it is in main already', async () => {
    const { w, repo } = await workspace()
    const gone = await putBackThenMain(w, repo, true)
    git(gone.folder, 'checkout', '-q', '--detach')
    git(repo, 'branch', '-D', gone.line)
    expect((await preview(w, repo, '1.4.0', 'main')).cards.keep).toEqual([])
    expect(await uses(w, repo, '1.4.0')).toEqual([])
    lent.length = 0
    expect((await start(w, repo, gone.card.number, 'b1')).started).toMatchObject({ target: 'main' })
    expect(lent).toEqual(['main'])
    // 1.4.0 released into main: an untouched line's history is all in main.
    const second = await workspace()
    const contained = await putBackThenMain(second.w, second.repo, false)
    git(second.repo, 'merge', '-q', '--no-ff', '-m', 'release 1.4.0', '1.4.0')
    expect(await uses(second.w, second.repo, '1.4.0')).toEqual([])
    expect((await start(second.w, second.repo, contained.card.number, 'b1')).started).toMatchObject({ target: 'main' })
  })

  it('keeps it when its line can’t be read: the start refused, the preview keeps it (cantCheck), the uses name it', async () => {
    const { w, repo } = await workspace()
    const { card, line, folder } = await putBackThenMain(w, repo, true)
    // Its line at a commit this repository doesn't have: whether it is in main can't be read.
    git(folder, 'checkout', '-q', '--detach')
    writeFileSync(join(repo, '.git', 'refs', 'heads', ...line.split('/')), `${'1'.repeat(40)}\n`)
    expect((await preview(w, repo, '1.4.0', 'main')).cards.keep).toEqual([expect.objectContaining({ number: card.number, why: 'cantCheck' })])
    expect(await uses(w, repo, '1.4.0')).toContain(labelOf(card))
    const r = await start(w, repo, card.number, 'b1')
    expect(r.started).toBeNull()
    expect(r.reply).toMatchObject({ rule: 'platform.unknown' })
  })

  it('in a lane on main: its start is refused (platform.keptLine), the lane’s target its cards’', async () => {
    const { w, repo } = await workspace()
    const { card } = await putBackThenMain(w, repo, true)
    await lanes.startLane(w, { project: 'p', builder: 'b2', reviewer: 'r1', cards: [card.number], by: 'You' })
    const r = await start(w, repo, card.number, 'b2')
    expect(r.started).toBeNull()
    expect(r.reply).toMatchObject({ rule: 'platform.keptLine' })
  })

  it('Start the next version keeps it on 1.4.0 too: its plan and reply say so', async () => {
    const { w, repo } = await workspace()
    const card = await make(w, 'Release fix')
    const first = await start(w, repo, card.number, 'b1')
    commitIn(first.started!.folder, 'fix.txt')
    await putBack(w, repo, card.number)
    // 1.5.0 is made at 1.4.0's head: the fix's line is past it, so it stays on 1.4.0.
    const r = await inWorkspace(w, () => nv.startNextVersion(w, repo, { from: { ref: '1.4.0', commit: '' }, preview: true }))
    expect(r.preview?.cards.keep).toEqual([expect.objectContaining({ number: card.number, why: 'line' })])
    expect((await start(w, repo, card.number, 'b1')).started).toMatchObject({ target: '1.4.0' })
  })
})
