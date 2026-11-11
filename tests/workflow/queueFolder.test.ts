// Merging into a target checked out in a folder (#1351, SPEC §16.9.2; S27, S34, S42): the conditions checked under the
// repository lock and the folder's fence before anything is touched, each a pause naming its files; the journal and its
// rollback; HEAD seen naming the target after the swap; every row of the recovery table after a crash at each point of
// the journal, never merging twice; the terminal state's record (branch, ref, each file's side, the commands, For you);
// Ask each time (OP-40): the Approve bound to the entry and its test merge.
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { execFileSync } from 'child_process'
import { tempDir } from '../tempDir'
import { shellLine } from '../../src/shared/workflow/queue'
import { createRequire } from 'module'

const { baseEnv } = createRequire(import.meta.url)('../e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }
import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { B1, commit, GIT_HEAVY_MS, moved, R1, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { MergeQueue, type QueueConfig, type QueueHook } from '../../src/main/workflow/mergeQueue'
import { FactStore } from '../../src/main/workflow/factStore'
import { Workflow } from '../../src/main/workflow/runtime'
import { QUEUE_ADVANCE_GATE, QUEUE_STUCK_GATE } from '../../src/shared/workflow/facts'

let env: Env | null = null
const extra: FactStore[] = []
afterEach(() => {
  for (const s of extra.splice(0)) s.close()
  env?.close()
  env = null
})

// Combwork's commit message (G19, chosen: the branch's own is every preset's since HI-1997), so each merge names its card.
const pair = (): Env => (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [], commitMessage: 'combwork' }))

async function queued(e: Env, title = 'A', file = 'a.txt', content = `${title}\n`) {
  const card = e.wf.createCard({ title })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  commit(s.data!.folder as string, { [file]: content }, title)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  moved(await e.wf.startReview(card.key, R1))
  moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  return card
}

/** Another Combwork (a restart): its own store connection, Workflow and queue on the same files. */
function restarted(e: Env, cfg: Partial<QueueConfig> = {}): { wf: Workflow; q: MergeQueue } {
  const store = e.reopen()
  extra.push(store)
  const wf = new Workflow({ ...e.wf.cfg, store })
  return { wf, q: new MergeQueue(wf, { folder: join(e.home, 'queue'), runCheck: async () => ({ ok: true, output: '' }), ...cfg }) }
}

const head = (e: Env, ref = 'main'): string => sh(e.project, 'rev-parse', ref)
const crashAt = (point: QueueHook): Partial<QueueConfig> => ({ hooks: { [point]: () => Promise.reject(new Error('crash')) } })
const integratedFacts = (e: Env, card: number) => e.store.facts(card).filter((f) => f.kind === 'Integrated')
/** Combwork's merge commits of a card on main: never two. */
const merges = (e: Env, key: string): number => sh(e.project, 'log', '--format=%s', 'main').split('\n').filter((s) => s.startsWith(`${key}:`)).length
/** Moves main as another git client would: a commit on its tree, the ref moved to it (the folder's files untouched). */
const moveMain = (e: Env, branch = 'main'): string => {
  const at = head(e, branch)
  const c = sh(e.project, 'commit-tree', `${at}^{tree}`, '-p', at, '-m', 'elsewhere')
  sh(e.project, 'update-ref', `refs/heads/${branch}`, c, at)
  return c
}

/**
 * Runs a line in Windows PowerShell in a folder, as the user would paste it (HR4's #1351 round 1: the commands Combwork
 * gives must reach the program with their arguments as written). Its output.
 */
const powershell = (cwd: string, line: string): string =>
  // The run context's environment (never the shell's), with the unit tests' empty global git config (noGlobalGit.ts).
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', line], { cwd, encoding: 'utf8', env: { ...baseEnv(), GIT_CONFIG_GLOBAL: '/dev/null' }, windowsHide: true }).replace(/\r\n/g, '\n')

describe('the conditions before anything is touched (§16.9.2)', () => {
  it('an agent building in the folder pauses folderBusy, naming what it holds; nothing started', async () => {
    const e = pair()
    const card = await queued(e)
    const before = head(e)
    const lock = join(e.project, 'src', 'a.txt')
    const [o] = await e.queue({ folderBusy: (f) => (f === e.project ? [lock] : null) }).drain('main')
    expect(o).toMatchObject({ outcome: 'paused', reason: 'folderBusy', files: [lock] })
    expect(head(e)).toBe(before)
    expect(e.kinds(card.id)).not.toContain('IntegrationStarted')
  })

  it('the folder on another branch at the check pauses wrongBranch, naming the folder (S34b); nothing started', async () => {
    const e = pair()
    const card = await queued(e)
    const before = head(e)
    // Switched just before the branch is read (git listed the folder on main a moment earlier).
    const [o] = await e.queue({ folderBusy: () => (sh(e.project, 'checkout', '-q', '-b', 'other'), null) }).drain('main')
    expect(o).toMatchObject({ outcome: 'paused', reason: 'wrongBranch', files: [e.project] })
    expect(head(e)).toBe(before)
    expect(e.kinds(card.id)).not.toContain('IntegrationStarted')
  })

  it('anything staged pauses staged, naming the files (S34c); the staged change is untouched', async () => {
    const e = pair()
    const card = await queued(e)
    writeFileSync(join(e.project, 'staged.txt'), 'the user staged this\n')
    sh(e.project, 'add', 'staged.txt')
    const [o] = await e.queue().drain('main')
    expect(o).toMatchObject({ outcome: 'paused', reason: 'staged', files: ['staged.txt'] })
    expect(sh(e.project, 'diff', '--cached', '--name-only')).toBe('staged.txt')
    expect(e.kinds(card.id)).not.toContain('IntegrationStarted')
  })

  it("an untracked file where the merge adds one pauses, named; the user's other edits stay and don't stop it", async () => {
    const e = pair()
    const card = await queued(e, 'A', 'new.txt')
    writeFileSync(join(e.project, 'new.txt'), 'the user made this\n')
    const [o] = await e.queue().drain('main')
    expect(o).toMatchObject({ outcome: 'paused', reason: 'unstagedChanges', files: ['new.txt'] })
    expect(readFileSync(join(e.project, 'new.txt'), 'utf8')).toBe('the user made this\n')
    // Moved aside: the merge goes on, an edit in another file kept as it is.
    sh(e.project, 'clean', '-fq')
    writeFileSync(join(e.project, 'README.md'), 'the user is editing this\n')
    e.queue().resume('main')
    expect((await e.queue().drain('main'))[0]).toMatchObject({ outcome: 'integrated' })
    expect(e.wf.state(card).stage).toBe('done')
    expect(readFileSync(join(e.project, 'new.txt'), 'utf8')).toBe('A\n')
    expect(readFileSync(join(e.project, 'README.md'), 'utf8')).toBe('the user is editing this\n')
  })

  it("HI-2944's repro: Files' shared exclude left uncommitted, and a card that also changes .gitignore, pauses naming .gitignore", async () => {
    const e = pair()
    writeFileSync(join(e.project, '.gitignore'), 'node_modules/\n')
    sh(e.project, 'add', '.gitignore')
    sh(e.project, 'commit', '-q', '-m', 'ignore')
    const card = await queued(e, 'A', '.gitignore', 'node_modules/\nout/\n')
    // Files' own Exclude from git, in a workspace holding the project.
    const { createWorkspaceService, disposeWorkspaceService } = await import('../../src/main/workspace')
    const { gitExclude } = await import('../../src/main/filesGit')
    const w = createWorkspaceService()
    w.path = dirname(e.project)
    onTestFinished(() => disposeWorkspaceService(w))
    expect(await gitExclude(e.project, [{ rel: 'reference', isDir: true }], 'shared', false)).toMatchObject({ file: '.gitignore', lines: ['/reference/'] })
    const before = head(e)
    const [o] = await e.queue().drain('main')
    expect(o).toMatchObject({ outcome: 'paused', reason: 'unstagedChanges', files: ['.gitignore'] })
    expect(head(e)).toBe(before)
    expect(readFileSync(join(e.project, '.gitignore'), 'utf8')).toBe('node_modules/\n/reference/\n')
    expect(e.kinds(card.id)).not.toContain('IntegrationStarted')
  })

  it("HI-2944: a start whose target's folder has uncommitted changes says so and tells the window, before it is written; never refused", async () => {
    const e = pair()
    const told: unknown[] = []
    const cfg = e.wf.cfg as { targetChanges?: (c: unknown, card: string) => void }
    cfg.targetChanges = (c, card) => told.push({ ...(c as object), card })
    // Clean: nothing said.
    const clean = e.wf.createCard({ title: 'clean' })
    const s0 = await e.wf.start(clean.key, B1)
    moved(s0)
    expect(s0.warnings ?? []).toEqual([])
    expect(told).toEqual([])
    // The user's .gitignore line, uncommitted where main is checked out: said, the start written all the same.
    writeFileSync(join(e.project, '.gitignore'), '/reference/\n')
    const card = e.wf.createCard({ title: 'A' })
    cfg.targetChanges = (c, key) => told.push({ ...(c as object), card: key, written: e.kinds(card.id).includes('Started') })
    const s = await e.wf.start(card.key, B1)
    moved(s)
    expect((s.warnings ?? []).join('\n')).toMatch(/^main's folder .+ has uncommitted changes \(\.gitignore\): a merge into main that changes them pauses/m)
    expect(told).toMatchObject([{ target: 'main', files: ['.gitignore'], card: card.key, written: false }])
    expect(e.kinds(card.id)).toContain('Started')
  })

  it('the conditions are checked inside the lock and the fence, and the fence names the folder', async () => {
    const e = pair()
    await queued(e)
    const seen: string[] = []
    let inside = false
    const q = e.queue({
      lock: async (fn) => {
        seen.push('lock')
        return fn()
      },
      fence: async (folder, fn) => {
        seen.push(`fence ${folder === e.project}`)
        inside = true
        try {
          return await fn()
        } finally {
          inside = false
        }
      },
      folderBusy: () => (seen.push(`busy ${inside}`), null)
    })
    expect((await q.drain('main'))[0]).toMatchObject({ outcome: 'integrated' })
    expect(seen).toEqual(['lock', 'fence true', 'busy true'])
  })
})

describe('the journal (§16.9.2)', () => {
  it('advances the folder: IntegrationStarted with the listed files, phases files then ref, Integrated; the folder clean at the result', async () => {
    const e = pair()
    const card = await queued(e, 'A', 'src/a.txt', 'merged\n')
    const [o] = await e.queue().drain('main')
    expect(o).toMatchObject({ outcome: 'integrated' })
    const s = e.wf.state(card)
    expect(s.entries[0]).toMatchObject({ state: 'integrated', phases: ['files', 'ref'], started: { files: ['src/a.txt'], checkedOut: e.project } })
    expect(head(e)).toBe((o as { result: string }).result)
    expect(readFileSync(join(e.project, 'src/a.txt'), 'utf8')).toBe('merged\n')
    expect(sh(e.project, 'status', '--porcelain')).toBe('')
  })

  it('S34a: main reset by another client just before the swap: the swap fails, the files are rolled back, tested again, merged once', async () => {
    const e = pair()
    const card = await queued(e)
    let raced = ''
    const q = e.queue({ hooks: { beforeRef: () => void (raced ||= moveMain(e)) } })
    const [o] = await q.drain('main')
    expect(o).toMatchObject({ outcome: 'integrated', retests: 1 })
    const s = e.wf.state(card)
    expect(s.entries.map((x) => x.state)).toEqual(['failed', 'integrated'])
    expect(s.entries[0].phases).toEqual(['files', 'ref', 'rollback'])
    expect(sh(e.project, 'rev-parse', 'main^1')).toBe(raced)
    expect(merges(e, card.key)).toBe(1)
    expect(sh(e.project, 'status', '--porcelain')).toBe('')
  })

  it('a rollback git refuses (a listed file edited meanwhile) is the terminal state: needs you, its state recorded, asked in For you', async () => {
    const e = pair()
    const card = await queued(e)
    const before = head(e)
    const q = e.queue({
      hooks: {
        beforeRef: () => {
          moveMain(e)
          writeFileSync(join(e.project, 'a.txt'), 'edited while Combwork merged\n')
        }
      }
    })
    const [o] = await q.drain('main')
    expect(o).toMatchObject({ outcome: 'paused', reason: 'needsYou', files: ['a.txt'] })
    const p = e.store.queuePause('main')!
    expect(p.stuck).toMatchObject({ folder: e.project, branch: 'main', expected: before, phase: 'rollback', files: [{ path: 'a.txt', side: 'other' }], commands: [] })
    expect(p.stuck!.ref).not.toBe(before)
    expect(readFileSync(join(e.project, 'a.txt'), 'utf8')).toBe('edited while Combwork merged\n')
    const ask = e.wf.state(card).requests.find((r) => r.gate === QUEUE_STUCK_GATE)
    expect(ask).toMatchObject({ kind: 'decide', requestText: { id: 'workflow.forYou.queueStuck', values: { how: 'none', folder: e.project, target: 'main' } } })
    // Paused: the queue runs nothing more until it is settled.
    expect(await e.queue().drain('main')).toEqual([])
  })

  it("HEAD no longer names the target after the swap (the folder switched in that instant): merged, paused with the files to restore", async () => {
    const e = pair()
    const card = await queued(e)
    const before = head(e)
    // The folder switched to a new branch at the same commit, its index carried over (git checkout -b keeps changes).
    const [o] = await e.queue({ hooks: { beforeRef: () => void sh(e.project, 'checkout', '-q', '-b', 'other') } }).drain('main')
    expect(o).toMatchObject({ outcome: 'paused', reason: 'needsYou', files: ['a.txt'] })
    expect(e.wf.state(card).stage).toBe('done')
    expect(integratedFacts(e, card.id)).toHaveLength(1)
    const p = e.store.queuePause('main')!
    const result = head(e)
    expect(p.stuck).toMatchObject({ branch: 'other', ref: result, expected: before, result, phase: 'done', files: [{ path: 'a.txt', side: 'result' }], commands: [{ purpose: 'undo', place: 'folder', args: ['git', 'read-tree', '-m', '-u', result, before], command: `git read-tree -m -u ${result} ${before}` }] })
    // The undo puts the other branch's files back as they were.
    sh(e.project, 'read-tree', '-m', '-u', result, before)
    expect(sh(e.project, 'status', '--porcelain')).toBe('')
    expect(e.wf.state(card).requests.some((r) => r.gate === QUEUE_STUCK_GATE)).toBe(true)
  })

  it('a runner that lost its lease mid-journal writes nothing more and touches nothing', async () => {
    const e = pair()
    const card = await queued(e)
    const before = head(e)
    let holds = true
    const q = e.queue({ holds: () => holds, hooks: { afterFiles: () => void (holds = false) } })
    expect(await q.drain('main')).toEqual([])
    expect(head(e)).toBe(before)
    expect(e.wf.state(card).entries[0].phases).toEqual(['files'])
    expect(e.store.queuePause('main')).toBeNull()
  })
})

describe("recovery after a crash at each point of the journal (S34d, §16.9.2's table)", () => {
  // Each crash point, what a restart's recovery does, and that the card ends merged exactly once with the folder clean.
  const rows: { point: QueueHook; outcome: 'rerun' | 'integrated' | 'failed' }[] = [
    { point: 'afterStarted', outcome: 'rerun' },
    { point: 'beforeFiles', outcome: 'rerun' },
    { point: 'afterFiles', outcome: 'integrated' },
    { point: 'beforeRef', outcome: 'integrated' },
    { point: 'afterAdvance', outcome: 'integrated' }
  ]
  for (const { point, outcome } of rows) {
    it(`crash at ${point}: recovery ${outcome}s; merged once, the folder at the result and clean`, async () => {
      const e = pair()
      const card = await queued(e)
      await expect(e.queue(crashAt(point)).drain('main')).rejects.toThrow('crash')
      const r = restarted(e)
      expect(await r.q.recover('main')).toEqual([{ card: card.key, entry: expect.any(String), outcome }])
      if (outcome === 'rerun') expect((await r.q.drain('main'))[0]).toMatchObject({ outcome: 'integrated' })
      expect(r.wf.state(card).stage).toBe('done')
      expect(integratedFacts(e, card.id)).toHaveLength(1)
      expect(merges(e, card.key)).toBe(1)
      expect(readFileSync(join(e.project, 'a.txt'), 'utf8')).toBe('A\n')
      expect(sh(e.project, 'status', '--porcelain')).toBe('')
    })
  }

  for (const point of ['inRollback', 'afterRollback'] as const) {
    it(`crash at ${point} (the ref moved): the files rolled back, failed, queued again and merged once on the new head`, async () => {
      const e = pair()
      const card = await queued(e)
      let raced = ''
      await expect(e.queue({ hooks: { beforeRef: () => void (raced ||= moveMain(e)), [point]: () => Promise.reject(new Error('crash')) } }).drain('main')).rejects.toThrow('crash')
      const r = restarted(e)
      expect(await r.q.recover('main')).toEqual([{ card: card.key, entry: expect.any(String), outcome: 'failed' }])
      expect(sh(e.project, 'status', '--porcelain')).toBe('')
      expect((await r.q.drain('main'))[0]).toMatchObject({ outcome: 'integrated' })
      expect(r.wf.state(card).entries.map((x) => x.state)).toEqual(['failed', 'integrated'])
      expect(sh(e.project, 'rev-parse', 'main^1')).toBe(raced)
      expect(merges(e, card.key)).toBe(1)
    })
  }

  it('the ref moved after a crash past the files: rolled back, then tested again (the table\'s "if the ref moved")', async () => {
    const e = pair()
    const card = await queued(e)
    await expect(e.queue(crashAt('afterFiles')).drain('main')).rejects.toThrow('crash')
    moveMain(e)
    const r = restarted(e)
    expect(await r.q.recover('main')).toEqual([{ card: card.key, entry: expect.any(String), outcome: 'failed' }])
    expect(r.wf.state(card).entries[0].phases).toEqual(['files', 'rollback'])
    expect((await r.q.drain('main'))[0]).toMatchObject({ outcome: 'integrated' })
    expect(merges(e, card.key)).toBe(1)
  })

  it('a rerun keeps a journal of its own: the earlier attempt\'s phases never count', async () => {
    const e = pair()
    const card = await queued(e)
    await expect(e.queue(crashAt('beforeFiles')).drain('main')).rejects.toThrow('crash')
    const r = restarted(e, crashAt('afterStarted'))
    expect(await r.q.recover('main')).toMatchObject([{ outcome: 'rerun' }])
    await expect(r.q.drain('main')).rejects.toThrow('crash')
    // Begun again, no phase yet: read-tree never ran in this attempt, so it runs again (not a swap from the old phase).
    expect(r.wf.state(card).entries[0].phases).toEqual([])
    const again = restarted(e)
    expect(await again.q.recover('main')).toMatchObject([{ outcome: 'rerun' }])
    expect((await again.q.drain('main'))[0]).toMatchObject({ outcome: 'integrated' })
    expect(merges(e, card.key)).toBe(1)
  })

  it('a listed file edited after the crash: the terminal state, its sides and no command; settled by hand, Resume\'s check lets recovery finish', async () => {
    const e = pair()
    const card = await queued(e)
    const before = head(e)
    await expect(e.queue(crashAt('afterFiles')).drain('main')).rejects.toThrow('crash')
    writeFileSync(join(e.project, 'a.txt'), 'edited by the user\n')
    const r = restarted(e)
    expect(await r.q.recover('main')).toEqual([{ card: card.key, entry: expect.any(String), outcome: 'needsYou' }])
    expect(e.store.queuePause('main')!.stuck).toMatchObject({ branch: 'main', ref: before, phase: 'files', files: [{ path: 'a.txt', side: 'other' }], commands: [] })
    expect(await r.q.stillStuck('main')).toEqual(['a.txt'])
    sh(e.project, 'checkout', '--', 'a.txt')
    expect(await r.q.stillStuck('main')).toBeNull()
    r.q.resume('main')
    expect(await r.q.recover('main')).toEqual([{ card: card.key, entry: expect.any(String), outcome: 'integrated' }])
    expect(merges(e, card.key)).toBe(1)
  })

  it('stopped in a rollback, then main put back: terminal with both commands; running the finish settles it, merged once', async () => {
    const e = pair()
    const card = await queued(e)
    const before = head(e)
    await expect(e.queue({ hooks: { beforeRef: () => void moveMain(e), inRollback: () => Promise.reject(new Error('crash')) } }).drain('main')).rejects.toThrow('crash')
    sh(e.project, 'update-ref', 'refs/heads/main', before)
    const r = restarted(e)
    expect(await r.q.recover('main')).toEqual([{ card: card.key, entry: expect.any(String), outcome: 'needsYou' }])
    const st = e.store.queuePause('main')!.stuck!
    expect(st).toMatchObject({ branch: 'main', ref: before, phase: 'rollback', files: [{ path: 'a.txt', side: 'result' }] })
    expect(st.commands).toEqual([
      { purpose: 'finish', place: 'project', args: ['git', 'update-ref', 'refs/heads/main', st.result, before], command: `git update-ref refs/heads/main ${st.result} ${before}` },
      { purpose: 'undo', place: 'folder', args: ['git', 'read-tree', '-m', '-u', st.result, before], command: `git read-tree -m -u ${st.result} ${before}` }
    ])
    expect(e.wf.state(card).requests.find((x) => x.gate === QUEUE_STUCK_GATE)?.requestText).toMatchObject({ values: { how: 'both', finish: st.commands[0].command, undo: st.commands[1].command } })
    sh(e.project, ...st.commands[0].args.slice(1))
    expect(await r.q.stillStuck('main')).toBeNull()
    r.q.resume('main')
    expect(await r.q.recover('main')).toEqual([{ card: card.key, entry: expect.any(String), outcome: 'integrated' }])
    expect(integratedFacts(e, card.id)).toHaveLength(1)
    expect(sh(e.project, 'status', '--porcelain')).toBe('')
  })

  it('the folder switched to another branch after a crash: the terminal state, nothing more changed', async () => {
    const e = pair()
    const card = await queued(e)
    const before = head(e)
    await expect(e.queue(crashAt('afterFiles')).drain('main')).rejects.toThrow('crash')
    sh(e.project, 'checkout', '-q', '-b', 'other')
    const r = restarted(e)
    expect(await r.q.recover('main')).toEqual([{ card: card.key, entry: expect.any(String), outcome: 'needsYou' }])
    expect(e.store.queuePause('main')!.stuck).toMatchObject({ branch: 'other', ref: before, files: [{ path: 'a.txt', side: 'result' }] })
    expect(head(e)).toBe(before)
    expect(e.wf.state(card).stage).toBe('merging')
  })
})

describe('Ask each time (OP-40)', () => {
  const ask: Partial<QueueConfig> = { checkedOutTarget: () => 'ask' }
  const request = (e: Env, card: { id: number }) => e.wf.state(e.store.card(card.id)).requests.find((r) => r.gate === QUEUE_ADVANCE_GATE)

  it("a target checked out nowhere doesn't ask", async () => {
    const e = pair()
    sh(e.project, 'checkout', '-q', '--detach')
    const card = await queued(e)
    expect((await e.queue(ask).drain('main'))[0]).toMatchObject({ outcome: 'integrated' })
    expect(request(e, card)).toBeUndefined()
  })

  it('the Approve is bound to the entry and its test merge: main moved meanwhile, tested again and asked again', async () => {
    const e = pair()
    const card = await queued(e)
    const q = e.queue(ask)
    expect((await q.drain('main'))[0]).toMatchObject({ outcome: 'paused', reason: 'approval' })
    const first = request(e, card)!
    const moved1 = commit(e.project, { 'other.txt': 'meanwhile\n' }, 'meanwhile')
    moved(await e.wf.answer(card.key, first.request, 'approved'))
    expect((await q.drain('main'))[0]).toMatchObject({ outcome: 'paused', reason: 'approval' })
    const second = request(e, card)!
    expect(second.request).not.toBe(first.request)
    expect(second.revision).toBe(moved1)
    // One open request: the earlier one was retired.
    expect(e.wf.state(card).requests.filter((r) => r.gate === QUEUE_ADVANCE_GATE)).toHaveLength(1)
    moved(await e.wf.answer(card.key, second.request, 'approved'))
    expect((await q.drain('main'))[0]).toMatchObject({ outcome: 'integrated' })
    expect(sh(e.project, 'rev-parse', 'main^1')).toBe(moved1)
  })

  it('the answer is an enqueue of its target, so the app runs the queue at once', async () => {
    const e = pair()
    const card = await queued(e)
    await e.queue(ask).drain('main')
    const r = request(e, card)!
    moved(await e.wf.answer(card.key, r.request, 'approved'))
    const answer = e.store.facts(card.id).filter((f) => f.kind === 'Approval').at(-1)!
    expect(e.store.hasAction(card.id, 'enqueue', answer.seq)).toBe(true)
  })

  it('declined: the entry leaves the queue, the card back to Approved, and the queue goes on with the next', async () => {
    const e = pair()
    const a = await queued(e, 'A', 'a.txt')
    const b = await queued(e, 'B', 'b.txt')
    const q = e.queue(ask)
    expect((await q.drain('main'))[0]).toMatchObject({ card: a.key, outcome: 'paused', reason: 'approval' })
    moved(await e.wf.answer(a.key, request(e, a)!.request, 'declined'))
    const out = await q.drain('main')
    expect(out[0]).toMatchObject({ card: a.key, outcome: 'skipped', why: 'declined' })
    expect(out[1]).toMatchObject({ card: b.key, outcome: 'paused', reason: 'approval' })
    expect(e.wf.state(a)).toMatchObject({ stage: 'approved' })
    expect(e.wf.state(a).entries[0]).toMatchObject({ state: 'cancelled', cancelled: 'user' })
  })

  it("an entry removed while it waits for the Approve: the pause lifted, its request retired", async () => {
    const e = pair()
    const card = await queued(e)
    const q = e.queue(ask)
    await q.drain('main')
    moved(await e.wf.removeFromQueue(card.key, 'not now'))
    expect(request(e, card)).toBeUndefined()
    expect(await q.drain('main')).toEqual([])
    expect(e.store.queuePause('main')).toBeNull()
  })
})

describe("every target write authorised in the lock, from state read there (HR4's round 1)", () => {
  it('Automatically before the lock, Ask each time inside it: no IntegrationStarted; asked in For you, paused for the approval', async () => {
    const e = pair()
    const card = await queued(e)
    const before = head(e)
    let mode: 'ask' | 'auto' = 'auto'
    const q = e.queue({
      checkedOutTarget: () => mode,
      lock: async (fn) => {
        mode = 'ask'
        return fn()
      }
    })
    const [o] = await q.drain('main')
    expect(o).toMatchObject({ outcome: 'paused', reason: 'approval' })
    expect(head(e)).toBe(before)
    expect(e.kinds(card.id)).not.toContain('IntegrationStarted')
    expect(e.wf.state(card).requests.filter((r) => r.gate === QUEUE_ADVANCE_GATE)).toHaveLength(1)
    expect(sh(e.project, 'status', '--porcelain')).toBe('')
  })

  it("the user's Pause queue saved just as the queue asks stands: no question, no approval pause in its place", async () => {
    const e = pair()
    const card = await queued(e)
    let paused = false
    const q = e.queue({
      checkedOutTarget: () => {
        // Read just before the ask: the user pauses the queue in that instant.
        if (!paused) e.store.setQueuePause('main', { reason: 'user', card: '', by: 'user' })
        paused = true
        return 'ask'
      }
    })
    expect((await q.drain('main'))[0]).toMatchObject({ outcome: 'paused', reason: 'user' })
    expect(e.store.queuePause('main')).toMatchObject({ reason: 'user', by: 'user' })
    expect(e.wf.state(card).requests.filter((r) => r.gate === QUEUE_ADVANCE_GATE)).toHaveLength(0)
    expect(e.kinds(card.id)).not.toContain('IntegrationStarted')
  })

  it('Ask each time switched to Automatically wakes the waiting queue: it advances the asked test merge, its question retired', async () => {
    const e = pair()
    const card = await queued(e)
    let mode: 'ask' | 'auto' = 'ask'
    const q = e.queue({ checkedOutTarget: () => mode })
    expect((await q.drain('main'))[0]).toMatchObject({ outcome: 'paused', reason: 'approval' })
    const asked = e.wf.state(card).requests.find((r) => r.gate === QUEUE_ADVANCE_GATE)!
    // Still Ask: a run of the queue (another card's enqueue) waits on.
    expect(await q.drain('main')).toEqual([])
    mode = 'auto'
    expect((await q.drain('main'))[0]).toMatchObject({ outcome: 'integrated', retests: 0 })
    const s = e.wf.state(card)
    expect(s.stage).toBe('done')
    expect(s.requests.some((r) => r.request === asked.request)).toBe(false)
    expect(sh(e.project, 'rev-parse', 'main^1')).toBe(asked.revision)
    expect(e.store.queuePause('main')).toBeNull()
  })

  it("a run under a user's pause that replaced the approval lifts nothing", async () => {
    const e = pair()
    const card = await queued(e)
    const q = e.queue({ checkedOutTarget: () => 'ask' })
    await q.drain('main')
    e.store.setQueuePause('main', { reason: 'user', card: '', by: 'user' })
    const r = e.wf.state(card).requests.find((x) => x.gate === QUEUE_ADVANCE_GATE)!
    moved(await e.wf.answer(card.key, r.request, 'approved'))
    expect(await q.drain('main')).toEqual([])
    expect(e.store.queuePause('main')).toMatchObject({ reason: 'user' })
    expect(e.kinds(card.id)).not.toContain('IntegrationStarted')
  })

  it("a terminal pause freezes the target: put back but not answered, a fresh queue's or another Combwork's recovery writes nothing", async () => {
    const e = pair()
    const card = await queued(e)
    const before = head(e)
    await expect(e.queue(crashAt('afterFiles')).drain('main')).rejects.toThrow('crash')
    writeFileSync(join(e.project, 'a.txt'), 'edited by the user\n')
    expect(await restarted(e).q.recover('main')).toMatchObject([{ outcome: 'needsYou' }])
    // Put back as the journal left it (recovery could finish now), but neither answered nor resumed.
    sh(e.project, 'checkout', '--', 'a.txt')
    const facts = e.store.facts(card.id).length
    for (const r of [restarted(e), restarted(e)]) {
      expect(await r.q.recover('main')).toEqual([{ card: card.key, entry: expect.any(String), outcome: 'needsYou' }])
      expect(await r.q.drain('main')).toEqual([])
    }
    expect(head(e)).toBe(before)
    expect(e.store.facts(card.id)).toHaveLength(facts)
    expect(e.store.queuePause('main')).toMatchObject({ reason: 'needsYou', card: card.key, stuck: { phase: 'files' } })
    // The user's word (Resume, which checks first): recovered, once.
    const r = restarted(e)
    expect(await r.q.stillStuck('main')).toBeNull()
    r.q.resume('main')
    expect(await r.q.recover('main')).toMatchObject([{ outcome: 'integrated' }])
    expect(merges(e, card.key)).toBe(1)
  })

  it('a stuck advance found by a run of the queue another card started writes nothing either', async () => {
    const e = pair()
    const a = await queued(e, 'A', 'a.txt')
    await expect(e.queue(crashAt('afterFiles')).drain('main')).rejects.toThrow('crash')
    writeFileSync(join(e.project, 'a.txt'), 'edited by the user\n')
    expect(await restarted(e).q.recover('main')).toMatchObject([{ outcome: 'needsYou' }])
    sh(e.project, 'checkout', '--', 'a.txt')
    const b = await queued(e, 'B', 'b.txt')
    const before = head(e)
    const r = restarted(e)
    expect(await r.q.recover('main')).toMatchObject([{ card: a.key, outcome: 'needsYou' }])
    expect(await r.q.drain('main')).toEqual([])
    expect(head(e)).toBe(before)
    expect(r.wf.state(b).stage).toBe('merging')
    expect(r.wf.state(a).stage).toBe('merging')
  })

  // GIT_HEAVY_MS (HI-2453's decision, HI-2025's rule): a card built, approved, drained to a crash and recovered by another
  // queue, 76 git processes, 9.0 s alone with no wait between them; past 20 s in HI-2499's run of 353 files (3 workers).
  it("the commands keep a ref as it is: a branch named topic$part, run in PowerShell as given, finishes the merge", { timeout: GIT_HEAVY_MS }, async () => {
    const branch = 'topic$part'
    const e = (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [], target: branch }))
    sh(e.project, 'branch', '-m', 'main', branch)
    await queued(e)
    const before = head(e, branch)
    await expect(e.queue({ hooks: { beforeRef: () => void moveMain(e, branch), inRollback: () => Promise.reject(new Error('crash')) } }).drain(branch)).rejects.toThrow('crash')
    sh(e.project, 'update-ref', `refs/heads/${branch}`, before)
    const r = restarted(e)
    expect(await r.q.recover(branch)).toMatchObject([{ outcome: 'needsYou' }])
    const [finish] = e.store.queuePause(branch)!.stuck!.commands
    expect(finish.args).toEqual(['git', 'update-ref', `refs/heads/${branch}`, expect.any(String), before])
    expect(finish.command).toBe(`git update-ref 'refs/heads/${branch}' ${finish.args[3]} ${before}`)
    powershell(e.project, finish.command)
    expect(head(e, branch)).toBe(finish.args[3])
    expect(await r.q.stillStuck(branch)).toBeNull()
  })

  it('shellLine: what PowerShell hands the program is each argument exactly as given', () => {
    const args = ['refs/heads/topic$part', 'a&b', 'x;y', '(p)', "it's", '@splat', '{b}', '$(echo no)', '`n', '-m', '0123abcd', 'refs/heads/feature/x-1']
    const line = shellLine(['show', ...args])
    expect(line).toContain(' 0123abcd ')
    expect(line).toContain(' refs/heads/feature/x-1')
    // A function stands in for git: it prints each argument it was given, on a line of its own.
    const out = powershell(tempDir('shell-'), `function show { foreach ($a in $args) { [Console]::Out.WriteLine('<' + $a + '>') } }; ${line}`)
    expect(out.trim().split('\n')).toEqual(args.map((a) => `<${a}>`))
  })
})

describe('S42: the checks run without the lock', () => {
  // GIT_HEAVY_MS (HI-2453's decision, HI-2025's rule): a card built, approved and drained, tested twice as the user commits,
  // 76 git processes, 10.4 s alone with no wait between them; past 20 s in HI-2499's run of 353 files (3 workers).
  it("a user's commit in the folder during the checks isn't held up; the swap catches it and tests again", { timeout: GIT_HEAVY_MS }, async () => {
    const e = setup({ ...preset('git', 'team', { quick: ['quick'], tests: [] }), preChecks: [], okBefore: { mode: 'never', labels: [] }, commands: { quick: 'npm run quick' } })
    env = e
    const card = await queued(e)
    let locked = false
    let committed = ''
    const q = e.queue({
      lock: async (fn) => {
        locked = true
        try {
          return await fn()
        } finally {
          locked = false
        }
      },
      runCheck: async () => {
        expect(locked).toBe(false)
        committed ||= commit(e.project, { 'user.txt': 'the user commits\n' }, 'the user commits')
        return { ok: true, output: '' }
      }
    })
    const [o] = await q.drain('main')
    expect(o).toMatchObject({ outcome: 'integrated', retests: 1 })
    expect(sh(e.project, 'rev-parse', 'main^1')).toBe(committed)
    expect(e.wf.state(card).checks.length).toBeGreaterThanOrEqual(2)
    expect(sh(e.project, 'status', '--porcelain')).toBe('')
  })
})
