// S36 (#1118, SPEC §16.5.4, §16.7.2): the compiled table is total. Every combination of review, quorum, who finishes,
// folder and card kind is walked from Todo to Done on a real repository (or a None folder), through each refusal's next
// step, approvals and a quorum of two; every contradiction is refused when saved.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { B1, commit, moved, put, R1, R2, setup, sh, type Env } from './harness'
import { allOff, contradictions, type Finisher, type FolderMode, type ReviewBy, type WorkflowOptions } from '../../src/shared/workflow/options'
import { compile } from '../../src/shared/workflow/compile'
import { isRefusal } from '../../src/main/workflow/runtime'
import type { CardKind } from '../../src/shared/workflow/facts'

interface Combo {
  platform: 'git' | 'none'
  review: ReviewBy
  reviewers: 1 | 2
  finish: Finisher
  folder: FolderMode
  kind: CardKind
}

const REVIEWS: ReviewBy[] = ['none', 'agent', 'agentThenYou', 'you']
const all: Combo[] = []
for (const platform of ['git', 'none'] as const)
  for (const review of REVIEWS)
    for (const reviewers of [1, 2] as const)
      for (const finish of (platform === 'git' ? ['hiveMerges', 'agentMerges', 'committed', 'notChecked'] : ['accept']) as Finisher[])
        for (const folder of (platform === 'git' ? ['slots', 'project'] : ['project']) as FolderMode[])
          for (const kind of ['code', 'no-code'] as const) all.push({ platform, review, reviewers, finish, folder, kind })

const optionsOf = (c: Combo): WorkflowOptions => ({ ...allOff(c.platform), review: c.review, reviewers: c.reviewers, noSelfReview: c.review === 'agent' || c.review === 'agentThenYou', finish: c.finish, folder: c.folder, target: c.platform === 'git' && c.finish !== 'committed' ? 'main' : '' })
const name = (c: Combo) => `${c.platform} · review ${c.review} ×${c.reviewers} · ${c.finish} · ${c.folder} · ${c.kind}`

const supported = all.filter((c) => !contradictions(optionsOf(c)).length)
const contradictory = all.filter((c) => contradictions(optionsOf(c)).length)

describe('S36: every combination', () => {
  it('has the contradictions §16.7.2 names, refused when saved, and nothing else', () => {
    for (const c of contradictory) {
      const r = compile(optionsOf(c))
      expect(r.ok, name(c)).toBe(false)
      const why = contradictions(optionsOf(c))
      // Each is one of the table's: a merge needs its own folder, committed needs the project folder, a quorum needs an agent.
      for (const w of why) expect(['mergeNeedsSlots', 'committedNeedsFolder', 'quorumNeedsAgent']).toContain(w)
    }
    expect(supported.length).toBe(60 + 12)
  })

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
  it.each(supported.map((c) => [name(c), c] as const))('%s: Todo → Done', async (_, c) => {
    const e = envs[c.platform]!
    const i = ++n
    Object.assign(e.options, optionsOf(c))
    const card = e.wf.createCard({ title: `Combination ${i}`, kind: c.kind, ...(c.platform === 'none' ? { paths: [`c${i}.md`] } : {}) })
    const refusals: string[] = []
    const tryIt = async (r: unknown) => {
      if (isRefusal(r)) {
        expect(r.next, `${r.rule}'s next step`).toBeTruthy()
        refusals.push(r.rule)
        return false
      }
      return true
    }
    moved(await e.wf.start(card.key, B1))
    const folder = e.wf.folderOf(e.wf.state(card))
    if (c.kind === 'code') {
      // Submitting before the work is committed (Git: written, not committed; None: not written) is refused…
      if (c.platform === 'git') put(folder, `c${i}.txt`, `${i}\n`)
      expect(await tryIt(await e.wf.submit(card.key, B1, { summary: 'too soon' }))).toBe(false)
      expect(['submit.clean', 'submit.empty']).toContain(refusals.at(-1))
      // …and its next step leads on.
      if (c.platform === 'git') commit(folder, {}, `${card.key}: work`, c.folder === 'project' ? { trailer: card.key } : {})
      else put(e.project, `c${i}.md`, `${i}\n`)
    }
    moved(await e.wf.submit(card.key, B1, { summary: 'done' }))
    // One round goes wrong first: a decision mid-review, then a failed verdict (or the user's decline); the builder
    // checks the decision and submits the same work again with a note.
    let failed = false
    for (let step = 0; step < 10 && e.wf.state(card).stage === 'review'; step++) {
      const s = e.wf.state(card)
      const passes = new Set(s.verdicts.filter((v) => v.pass && v.submission === s.latest!.id && v.generation === s.generation).map((v) => v.reviewer))
      let open = s.requests.find((r) => r.gate === 'review')
      if (!failed) {
        failed = true
        moved(await e.wf.recordDecision(card.key, 'Keep it small'))
        for (const a of ['B1', 'R1', 'R2']) await e.wf.received(card.key, a)
        // The decision retired the request made before it; under "you" the user is asked again at once.
        if (open) {
          expect(e.wf.state(card).requests.some((r) => r.request === open!.request)).toBe(false)
          open = e.wf.state(card).requests.find((r) => r.gate === 'review')
          expect(open, 'asked again after the decision').toBeDefined()
          moved(await e.wf.answer(card.key, open!.request, 'declined'))
        }
        else {
          moved(await e.wf.startReview(card.key, R1))
          moved(await e.wf.verdict(card.key, R1, { pass: false, failKind: 'explanation', comment: 'why?' }))
        }
        expect(e.wf.state(card).stage).toBe('active')
        moved(await e.wf.submit(card.key, B1, { summary: 'again', note: 'It is small: see the comment.' }))
        continue
      }
      if (open) {
        moved(await e.wf.answer(card.key, open.request, 'approved'))
        continue
      }
      // The builder can't review its own work; R1, then R2 for a quorum of two.
      if (!passes.size) expect(await tryIt(await e.wf.startReview(card.key, B1))).toBe(false)
      const reviewer = passes.has('R1') ? R2 : R1
      moved(await e.wf.startReview(card.key, reviewer))
      moved(await e.wf.verdict(card.key, reviewer, { pass: true, comment: 'ok' }))
    }
    if (e.wf.state(card).stage === 'merging') {
      const [o] = await e.queue().drain('main')
      expect(o, name(c)).toMatchObject({ outcome: 'integrated' })
    }
    if (e.wf.state(card).stage === 'approved') {
      if (c.finish === 'agentMerges') {
        // Reporting a merge before merging is refused; its next step is the merge.
        expect(await tryIt(await e.wf.reportMerge(card.key, B1))).toBe(false)
        expect(refusals.at(-1)).toBe('done.contained')
        sh(e.project, 'merge', '-q', '--no-ff', '-m', `merge ${card.key}`, e.wf.state(card).approved!.revision!)
      }
      moved(await e.wf.reportMerge(card.key, B1))
    }
    const end = e.wf.state(card)
    expect(end.stage, `${name(c)} (refusals: ${refusals.join(', ')})`).toBe('done')
    if (c.kind === 'no-code') expect(end.integrated).toBeNull()
    if (c.platform === 'none' && c.kind === 'code') expect(end.accepted?.revision).toBe(end.latest!.revision)
    if (c.review !== 'none' && c.reviewers === 2 && c.review !== 'you') expect(new Set(end.verdicts.filter((v) => v.pass).map((v) => v.reviewer)).size).toBe(2)
    if (c.review !== 'none') expect(end.rounds, 'one failed round').toBe(1)
  })
})
