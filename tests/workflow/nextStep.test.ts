// #1530 (SPEC §16.8.1): an intent's reply names what comes next on the card, and agents follow it rather than infer the
// step from a column (#1525). Over the grid (kind × review × who finishes × an OK before merging, Git and None), a card
// is walked from Todo by doing exactly the step each reply names: every step named must be allowed then, and the walk
// must end Done. HR2's #1530 round 1 cases are pinned too: the agent merging with no review, a pending OK, None's
// acceptance.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { B1, commit, moved, put, R1, setup, sh, type Env } from './harness'
import { allOff, contradictions, type Finisher, type FolderMode, type ReviewBy, type WorkflowOptions } from '../../src/shared/workflow/options'
import type { CardKind } from '../../src/shared/workflow/facts'
import type { NextStep } from '../../src/shared/workflow/nextStep'
import { intentText } from '../../src/shared/toolReplies'

interface Cell {
  platform: 'git' | 'none'
  review: ReviewBy
  finish: Finisher
  folder: FolderMode
  kind: CardKind
  ok: 'never' | 'every'
}

const cells: Cell[] = []
for (const platform of ['git', 'none'] as const)
  for (const review of ['none', 'agent', 'agentThenYou', 'you'] as ReviewBy[])
    for (const finish of (platform === 'git' ? ['hiveMerges', 'agentMerges', 'committed', 'notChecked'] : ['accept']) as Finisher[])
      for (const kind of ['code', 'no-code'] as const)
        for (const ok of ['never', 'every'] as const) cells.push({ platform, review, finish, folder: platform === 'git' && finish !== 'committed' ? 'slots' : 'project', kind, ok })

const optionsOf = (c: Cell): WorkflowOptions => ({
  ...allOff(c.platform),
  review: c.review,
  noSelfReview: c.review === 'agent' || c.review === 'agentThenYou',
  finish: c.finish,
  folder: c.folder,
  target: c.platform === 'git' && c.finish !== 'committed' ? 'main' : '',
  okBefore: { mode: c.ok, labels: [] }
})
const name = (c: Cell): string => `${c.platform} · review ${c.review} · ${c.finish} · ${c.kind} · OK before merging ${c.ok}`
const supported = cells.filter((c) => !contradictions(optionsOf(c)).length)

describe('what comes next on a card (#1530)', () => {
  const envs: Partial<Record<'git' | 'none', Env>> = {}
  beforeAll(() => {
    envs.git = setup({ platform: 'git' })
    envs.none = setup({ platform: 'none' })
  })
  afterAll(() => {
    envs.git?.close()
    envs.none?.close()
  })

  let n = 0
  it.each(supported.map((c) => [name(c), c] as const))('%s: each step named is allowed, and they end Done', async (_, c) => {
    const e = envs[c.platform]!
    const i = ++n
    Object.assign(e.options, optionsOf(c))
    const card = e.wf.createCard({ title: `Next ${i}`, kind: c.kind, ...(c.platform === 'none' ? { paths: [`n${i}.md`] } : {}) })
    const steps: string[] = []
    let next: NextStep | null = e.wf.nextFor(card.id)
    for (let k = 0; k < 12 && next && next.step !== 'done'; k++) {
      steps.push(next.step === 'intents' ? next.intents.join('|') : next.step)
      const s = e.wf.state(card)
      if (next.step === 'intents') {
        if (next.intents.includes('start')) moved(await e.wf.start(card.key, B1))
        else if (next.intents.includes('submit')) {
          if (c.kind === 'code' && !s.latest) {
            if (c.platform === 'git') {
              const folder = e.wf.folderOf(s)
              put(folder, `n${i}.txt`, `${i}\n`)
              commit(folder, {}, `${card.key}: work`, c.folder === 'project' ? { trailer: card.key } : {})
            } else put(e.project, `n${i}.md`, `${i}\n`)
          }
          moved(await e.wf.submit(card.key, B1, { summary: 'done' }))
        } else if (next.intents.includes('verdict')) moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
        else throw new Error(`${name(c)}: unexpected ${next.intents.join(', ')}`)
      } else if (next.step === 'review') {
        moved(await e.wf.startReview(card.key, R1))
        // After start review, the verdict is next (the reply says so: cardIntents).
        moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
      } else if (next.step === 'user') {
        const open = s.requests.find((r) => r.gate === 'review' || r.gate === 'okBefore')
        expect(open, `${name(c)}: a request for the user is open`).toBeDefined()
        moved(await e.wf.answer(card.key, open!.request, 'approved'))
      } else if (next.step === 'merge') {
        if (c.finish === 'agentMerges') sh(e.project, 'merge', '-q', '--no-ff', '-m', `merge ${card.key}`, (s.approved ?? s.latest)!.revision!)
        moved(await e.wf.reportMerge(card.key, B1))
      } else if (next.step === 'queue') {
        const [o] = await e.queue().drain('main')
        expect(o, name(c)).toMatchObject({ outcome: 'integrated' })
      }
      next = e.wf.nextFor(card.id)
    }
    expect(e.wf.state(card).stage, `${name(c)}: ${steps.join(' → ')}`).toBe('done')
    expect(next).toEqual({ step: 'done' })
    // An OK before every merge is asked whoever merges, Hive not checking it too (#1592): the user is a step.
    if (c.platform === 'git' && c.kind === 'code' && c.ok === 'every' && c.finish !== 'committed') expect(steps, `${name(c)}: ${steps.join(' → ')}`).toContain('user')
  })

  it("names the step HR2 found missing or wrong: the agent's merge with no review, a pending OK, None's acceptance", async () => {
    const e = envs.git!
    // Git, no review, the agent merges, no OK: submit leaves it Active, and the builder merges and reports.
    Object.assign(e.options, optionsOf({ platform: 'git', review: 'none', finish: 'agentMerges', folder: 'slots', kind: 'code', ok: 'never' }))
    const a = e.wf.createCard({ title: 'Agent merges' })
    moved(await e.wf.start(a.key, B1))
    const fa = e.wf.folderOf(e.wf.state(a))
    put(fa, 'a.txt', 'a\n')
    commit(fa, {}, `${a.key}: work`)
    moved(await e.wf.submit(a.key, B1, { summary: 'done' }))
    expect(e.wf.state(a).stage).toBe('active')
    expect(e.wf.nextFor(a.id)).toEqual({ step: 'merge' })
    // Agent review, the agent merges, an OK before every merge: the pass waits for the user, not the merge.
    Object.assign(e.options, optionsOf({ platform: 'git', review: 'agent', finish: 'agentMerges', folder: 'slots', kind: 'code', ok: 'every' }))
    const b = e.wf.createCard({ title: 'OK first' })
    moved(await e.wf.start(b.key, B1))
    const fb = e.wf.folderOf(e.wf.state(b))
    put(fb, 'b.txt', 'b\n')
    commit(fb, {}, `${b.key}: work`)
    moved(await e.wf.submit(b.key, B1, { summary: 'done' }))
    moved(await e.wf.startReview(b.key, R1))
    moved(await e.wf.verdict(b.key, R1, { pass: true, comment: 'ok' }))
    expect(e.wf.state(b).stage).toBe('approved')
    expect(e.wf.nextFor(b.id)).toEqual({ step: 'user' })
    // The same under not checked, by label (#1592): the user's OK, then the merge.
    Object.assign(e.options, { ...optionsOf({ platform: 'git', review: 'agent', finish: 'notChecked', folder: 'slots', kind: 'code', ok: 'never' }), okBefore: { mode: 'labels', labels: ['release'] } })
    const u = e.wf.createCard({ title: 'OK first, unchecked', labels: ['release'] })
    moved(await e.wf.start(u.key, B1))
    const fu = e.wf.folderOf(e.wf.state(u))
    put(fu, 'u.txt', 'u\n')
    commit(fu, {}, `${u.key}: work`)
    moved(await e.wf.submit(u.key, B1, { summary: 'done' }))
    moved(await e.wf.startReview(u.key, R1))
    moved(await e.wf.verdict(u.key, R1, { pass: true, comment: 'ok' }))
    expect(e.wf.state(u).stage).toBe('approved')
    expect(e.wf.nextFor(u.id)).toEqual({ step: 'user' })
    moved(await e.wf.answer(u.key, e.wf.state(u).requests.find((q) => q.gate === 'okBefore')!.request, 'approved'))
    expect(e.wf.nextFor(u.id)).toEqual({ step: 'merge' })
    // None, a reviewer agent then the user: the pass waits for the user's acceptance.
    const nn = envs.none!
    Object.assign(nn.options, optionsOf({ platform: 'none', review: 'agentThenYou', finish: 'accept', folder: 'project', kind: 'code', ok: 'never' }))
    const d = nn.wf.createCard({ title: 'Accept', paths: ['accept.md'] })
    moved(await nn.wf.start(d.key, B1))
    put(nn.project, 'accept.md', 'x\n')
    moved(await nn.wf.submit(d.key, B1, { summary: 'done' }))
    moved(await nn.wf.startReview(d.key, R1))
    moved(await nn.wf.verdict(d.key, R1, { pass: true, comment: 'ok' }))
    expect(nn.wf.nextFor(d.id)).toEqual({ step: 'user' })
  })

  it('says each step in a line of the reply', () => {
    const line = (next: NextStep): string => intentText({ ok: true, card: 'HI-1', from: 'active', to: 'approved', next })
    expect(line({ step: 'intents', intents: ['start review', 'verdict'] })).toBe('HI-1: active → approved. Next on it: cw_start_review or cw_verdict.')
    expect(line({ step: 'review' })).toBe("HI-1: active → approved. Next: a reviewer's verdict.")
    expect(line({ step: 'user' })).toBe("HI-1: active → approved. Next: the user's OK, asked under For you: wait for it.")
    expect(line({ step: 'merge' })).toBe('HI-1: active → approved. Next: its builder merges it, then reports the merge (cw_report_merge).')
    expect(line({ step: 'queue' })).toBe("HI-1: active → approved. Next: Combwork's merge queue merges it.")
    expect(line({ step: 'done' })).toBe('HI-1: active → approved. Done: nothing more on it.')
  })
})
