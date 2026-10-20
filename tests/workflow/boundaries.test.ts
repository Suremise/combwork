// Round 2's review of the spike (#1118, HR2 and HB3): what an intent decides on is checked again where it writes.
// Platform evidence (refs, None's content) and the cards it waits for, fingerprinted before the slow reads and inside
// the transaction; the queue's authority to advance, decided in the transaction that writes `IntegrationStarted`;
// drags out of On Hold running the intents they stand for.
import { afterEach, describe, expect, it } from 'vitest'
import { B1, B2, commit, moved, put, R1, refusedBy, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { gitTestHooks } from '../../src/main/git'

let env: Env | null = null
afterEach(() => {
  gitTestHooks.started = undefined
  env?.close()
  env = null
})

const pairOpts = { ...preset('git', 'pair'), preChecks: [], mergeChecks: [] }

async function queued(e: Env, title: string, file: string) {
  const card = e.wf.createCard({ title, reviewer: 'R1' })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  commit(s.data!.folder as string, { [file]: `${title}\n` }, title)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  moved(await e.wf.startReview(card.key, R1))
  moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  return card
}

describe('evidence checked where the intent writes', () => {
  it('None: the paths edited while a passing verdict is on its way → refused, nothing accepted; the next verdict finds it stale', async () => {
    const e = (env = setup({ ...preset('none', 'pair'), preChecks: [] }, { files: { 'a.md': 'a\n' } }))
    const card = e.wf.createCard({ title: 'Doc', paths: ['a.md'] })
    moved(await e.wf.start(card.key, B1))
    put(e.project, 'a.md', 'reviewed\n')
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.startReview(card.key, R1))
    e.wf.cfg.hooks = {
      beforeWrite: async (move) => {
        if (move !== 'verdict') return
        e.wf.cfg.hooks = {}
        put(e.project, 'a.md', 'edited after the reviewer read it\n')
        e.wf.noteWrite('a.md', { agents: [], user: true })
      }
    }
    refusedBy(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }), 'evidence.changed')
    expect(e.wf.state(card)).toMatchObject({ stage: 'review', accepted: null, verdicts: [] })
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
    const s = e.wf.state(card)
    expect(s).toMatchObject({ stage: 'review', accepted: null })
    expect(s.stale?.why).toBe('change')
  })

  it("Git: the dependency's target reset while the start is on its way → refused; started again, the dependency blocks", async () => {
    const e = (env = setup({ ...pairOpts, finish: 'agentMerges' }))
    const before = sh(e.project, 'rev-parse', 'main')
    const a = await queued(e, 'A', 'a.txt')
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'A', e.wf.state(a).latest!.revision!)
    moved(await e.wf.reportMerge(a.key, B1))
    const b = e.wf.createCard({ title: 'Needs A', blockedBy: [a.id] })
    e.wf.cfg.hooks = {
      beforeWrite: async (move) => {
        if (move !== 'start') return
        e.wf.cfg.hooks = {}
        sh(e.project, 'reset', '-q', '--hard', before)
      }
    }
    refusedBy(await e.wf.start(b.key, B2), 'evidence.changed')
    expect(e.wf.state(b).stage).toBe('todo')
    refusedBy(await e.wf.start(b.key, B2), 'start.dependenciesIntegrated')
  })

  it("a dependency's own facts changing while the start is on its way → refused", async () => {
    const e = (env = setup({ ...pairOpts, finish: 'agentMerges' }))
    const a = await queued(e, 'A', 'a.txt')
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'A', e.wf.state(a).latest!.revision!)
    moved(await e.wf.reportMerge(a.key, B1))
    const b = e.wf.createCard({ title: 'Needs A', blockedBy: [a.id] })
    e.wf.cfg.hooks = {
      beforeWrite: async (move) => {
        if (move !== 'start') return
        e.wf.cfg.hooks = {}
        moved(await e.wf.move(a.key, 'todo', 'user'))
      }
    }
    refusedBy(await e.wf.start(b.key, B2), 'evidence.changed')
  })
})

describe("the queue's authority to advance", () => {
  for (const checkedOut of [false, true]) {
    it(`a decision just before IntegrationStarted stops the advance; git isn't touched (target ${checkedOut ? 'checked out' : 'checked out nowhere'})`, async () => {
      const e = (env = setup(pairOpts))
      if (!checkedOut) sh(e.project, 'checkout', '-q', '--detach')
      const card = await queued(e, 'A', 'a.txt')
      const before = sh(e.project, 'rev-parse', 'main')
      // The decision lands after the queue's last check, while it reads where the target is checked out.
      gitTestHooks.started = (_cwd, args) => {
        if (args.includes('worktree') && args.includes('list')) {
          gitTestHooks.started = undefined
          void e.wf.recordDecision(card.key, 'Not yet')
        }
      }
      const [o] = await e.queue().drain('main')
      expect(o).toMatchObject({ outcome: 'skipped', why: 'cancelled' })
      expect(sh(e.project, 'rev-parse', 'main')).toBe(before)
      const s = e.wf.state(card)
      expect(s).toMatchObject({ stage: 'review', integrated: null })
      expect(e.kinds(card.id)).not.toContain('IntegrationStarted')
    })
  }
})

describe('drags out of On Hold', () => {
  it('Active → Hold → Review submits; Active → Hold → Merging submits, asks for the review skipped, then queues', async () => {
    const e = (env = setup(pairOpts))
    const a = e.wf.createCard({ title: 'Held, then to review' })
    const sa = await e.wf.start(a.key, B1)
    moved(sa)
    commit(sa.data!.folder as string, { 'a.txt': 'a\n' }, 'a')
    moved(await e.wf.move(a.key, 'hold', 'user'))
    moved(await e.wf.move(a.key, 'review', 'user'))
    expect(e.wf.state(a)).toMatchObject({ stage: 'review' })
    expect(e.wf.state(a).latest).not.toBeNull()

    const b = e.wf.createCard({ title: 'Held, then to merging' })
    const sb = await e.wf.start(b.key, B1)
    moved(sb)
    commit(sb.data!.folder as string, { 'b.txt': 'b\n' }, 'b')
    moved(await e.wf.move(b.key, 'hold', 'user'))
    expect(await e.wf.move(b.key, 'merging', 'user')).toEqual({ ask: true, card: b.key, rules: ['integrate.approved'] })
    moved(await e.wf.move(b.key, 'merging', 'user', { confirm: true, reason: 'hotfix' }))
    const s = e.wf.state(b)
    expect(s.stage).toBe('merging')
    expect(s.entries.at(-1)?.state).toBe('open')
  })

  it('Todo → Hold → Review starts the card and stops at an empty submit: never a Review with nothing to review', async () => {
    const e = (env = setup(pairOpts))
    const card = e.wf.createCard({ title: 'Never started' })
    moved(await e.wf.move(card.key, 'hold', 'user'))
    refusedBy(await e.wf.move(card.key, 'review', 'user', { builder: 'B1' }), 'submit.empty')
    const s = e.wf.state(card)
    expect(s.stage).toBe('active')
    expect(s.started).not.toBeNull()
    expect(s.latest).toBeNull()
  })
})
