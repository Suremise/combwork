// HI-3235 (HI-3235/s10 §D): Combwork's advance reaches a platform only through its descriptor's finish and the adapter's
// optional ports, never a platform id. Here None's descriptor is given the advance as its finish (a stand-in, as
// integrationModes.test.ts does), and its adapter stand-in ports (`advance`, `advanceAnswer`), driven through the real
// Workflow: the generic reconcile calls `advance` only for a card in Approved with its OK given and no advance unsettled;
// the host's records follow (attempted, stopped and asked, attested, integrated); the user's answer from the window's
// path (`wf.answer`, as tasks.answerTask calls it) becomes one durable action, dispatched to `advanceAnswer` bound to
// what was asked; an agent's or the Assistant's answer is refused; a repeated delivery changes nothing. No jj runs here.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setup, put, B1, moved } from './harness'
import { reconcile } from '../../src/main/workflow/reconcile'
import { isRefusal } from '../../src/main/workflow/runtime'
import { advanceHostOf } from '../../src/main/workflow/advanceHost'
import { ADVANCE_PREVIEW_GATE, ADVANCE_STOPPED_GATE, ADVANCE_UNCERTAIN_GATE, type CardState } from '../../src/shared/workflow/facts'
import type { AdvanceAnswer, AdvanceHost } from '../../src/main/platform/adapter'
import type { CardRecord } from '../../src/main/workflow/factStore'

const stand = vi.hoisted(() => ({ on: false, finish: 'combworkAdvances' as string }))

vi.mock('../../src/shared/platform/descriptors', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/shared/platform/descriptors')>()
  // None's descriptor as it is, its finishes Combwork's advance while a test turns the stand-in on.
  const none = new Proxy(real.PLATFORMS.none, { get: (t, k) => (stand.on && k === 'finishes' ? [stand.finish] : stand.on && k === 'defaultFinish' ? stand.finish : Reflect.get(t, k)) })
  return { ...real, PLATFORMS: { ...real.PLATFORMS, none } }
})


let env: ReturnType<typeof setup> | null = null
afterEach(() => {
  env?.close()
  env = null
  stand.on = false
  stand.finish = 'combworkAdvances'
})

/** A None project whose finish is the stand-in advance (OK before merging for the labels given), and a card in Approved. */
async function inApproved(o: { ok?: boolean; finish?: 'combworkAdvances' | 'previewAdvance' } = {}) {
  stand.on = true
  stand.finish = o.finish ?? 'combworkAdvances'
  env = setup({ platform: 'none', review: 'none', finish: stand.finish as 'combworkAdvances', ...(o.ok ? { okBefore: { mode: 'every', labels: [] } } : {}) }, { enforced: () => true })
  const e = env
  const card = e.wf.createCard({ title: 'work', paths: ['w.md'] })
  moved(await e.wf.start(card.key, B1))
  put(e.project, 'w.md', 'work\n')
  moved(await e.wf.submit(card.key, B1, { summary: 'done' }))
  expect(e.wf.state(card).stage).toBe('approved')
  return { e, card }
}

/** The stand-in ports on the card's adapter (None's): each call recorded; `advance` runs `step` with the host. */
function ports(e: NonNullable<typeof env>, card: CardRecord, step: (host: AdvanceHost, c: CardRecord, s: CardState) => Promise<unknown>) {
  const calls: string[] = []
  const answers: AdvanceAnswer[] = []
  const p = e.wf.platformOf(e.wf.store.card(card.id)) as unknown as Record<string, unknown>
  p.advance = async (c: CardRecord, s: CardState, host: AdvanceHost) => {
    calls.push('advance')
    await step(host, c, s)
    return 'notReady'
  }
  let answer: (a: AdvanceAnswer, host: AdvanceHost) => Promise<void> = async () => undefined
  p.advanceAnswer = async (_c: CardRecord, a: AdvanceAnswer, host: AdvanceHost) => {
    answers.push(a)
    await answer(a, host)
  }
  return { calls, answers, onAnswer: (f: typeof answer) => void (answer = f), done: () => ((p as { advance?: unknown }).advance = undefined) }
}

const pass = async (e: NonNullable<typeof env>, card: CardRecord) => {
  await reconcile(e.wf, e.wf.store.card(card.id), {})
  await e.wf.runActions()
}
const kinds = (e: NonNullable<typeof env>, card: CardRecord) => e.store.facts(card.id).map((f) => f.kind)
const words = { target: 'main', result: 'r'.repeat(40), why: 'other', detail: 'test' }

describe("the advance's generic dispatch (HI-3235)", () => {
  it('calls the adapter’s advance only through the descriptor’s finish: in Approved, its OK given, no advance unsettled; its records follow', async () => {
    const { e, card } = await inApproved({ ok: true })
    const { calls } = ports(e, card, async (host, c, s) => {
      expect(await host.attempted(c, s.cycle, 'plan-1', 'att-1')).toBe(true)
      expect(await host.advanced(c, { cycle: s.cycle, attempt: 'att-1' }, { revision: 'x', target: 'main', result: 'r', method: 'merge' })).toBe(true)
    })
    // The OK not given yet: not called.
    await pass(e, card)
    expect(calls).toEqual([])
    const ok = e.wf.state(card).requests.find((r) => r.gate === 'okBefore')!
    moved(await e.wf.answer(card.key, ok.request, 'approved', { by: 'user' }))
    await pass(e, card)
    expect(calls).toEqual(['advance'])
    expect(kinds(e, card)).toEqual(expect.arrayContaining(['AdvanceAttempted', 'Integrated']))
    expect(e.wf.state(card).integrated).toMatchObject({ by: 'combwork', platform: { attempt: 'att-1' } })
    expect(e.wf.state(card).stage).toBe('done')
    // Done: never called again.
    await pass(e, card)
    expect(calls).toEqual(['advance'])
  })

  it('is never called for another finish, nor while an advance is unsettled; a late outcome for another attempt records nothing', async () => {
    const { e, card } = await inApproved()
    let n = 0
    const { calls } = ports(e, card, async (host, c, s) => {
      if (n++) return
      await host.attempted(c, s.cycle, 'plan-1', 'att-1')
      await host.stopped(c, { cycle: s.cycle, attempt: 'att-1' }, 'plan-1', { code: 'x', undo: false, uncertain: true }, words)
    })
    await pass(e, card)
    expect(calls).toEqual(['advance'])
    // Unsettled now: the generic step still asks (its adapter settles earlier attempts first), but a second attempt's fact
    // can't be written, nor an outcome for another attempt.
    const host = advanceHostOf(e.wf)
    const s = e.wf.state(card)
    expect(await host.attempted(e.wf.store.card(card.id), s.cycle, 'plan-2', 'att-2')).toBe(false)
    expect(await host.advanced(e.wf.store.card(card.id), { cycle: s.cycle, attempt: 'att-2' }, { revision: 'x', target: 'main', result: 'r', method: 'merge' })).toBe(false)
    expect(e.wf.state(card).integrated).toBeNull()
    // Another finish: not called at all.
    Object.assign(e.options, { finish: 'accept' })
    stand.on = false
    await pass(e, card)
    expect(calls.length).toBeLessThanOrEqual(2)
  })

  it('the user’s answer becomes one durable action, dispatched bound to what was asked; an agent’s and the Assistant’s are refused; a repeat changes nothing; the attestation is an Override, never Integrated', async () => {
    const { e, card } = await inApproved()
    const { answers, onAnswer } = ports(e, card, async (host, c, s) => {
      if (e.wf.state(c).advance) return
      await host.attempted(c, s.cycle, 'plan-1', 'att-1')
      await host.stopped(c, { cycle: s.cycle, attempt: 'att-1' }, 'plan-1', { code: 'x', undo: false, uncertain: true }, words)
    })
    await pass(e, card)
    const req = e.wf.state(card).requests.find((r) => r.gate === ADVANCE_UNCERTAIN_GATE)!
    expect(req).toMatchObject({ entry: 'att-1', result: 'plan-1' })
    expect(isRefusal(await e.wf.answer(card.key, req.request, 'approved', { by: 'agent' }))).toBe(true)
    expect(isRefusal(await e.wf.answer(card.key, req.request, 'approved', { by: 'assistant' }))).toBe(true)
    expect(isRefusal(await e.wf.answer(card.key, req.request, 'answered', { by: 'user', note: 'hm' }))).toBe(true)
    onAnswer(async (a, host) => {
      await host.attested(e.wf.store.card(card.id), { cycle: a.cycle, attempt: a.attempt }, a, 'the user says so')
    })
    moved(await e.wf.answer(card.key, req.request, 'approved', { by: 'user' }))
    // One durable action for the answer (the harness runs it straight after the write).
    await e.wf.runActions()
    expect(answers).toHaveLength(1)
    expect(answers).toEqual([{ request: req.request, gate: ADVANCE_UNCERTAIN_GATE, attempt: 'att-1', plan: 'plan-1', cycle: e.wf.state(card).cycle, state: 'uncertain', answer: 'approved', project: e.wf.cfg.project }])
    const s = e.wf.state(card)
    expect(s.stage).toBe('done')
    expect(s.integrated).toBeNull()
    expect(s.finished).toMatchObject({ how: 'override' })
    expect(kinds(e, card)).not.toContain('Integrated')
    // The same answer again (a replayed action): the attempt is settled, so the host records nothing.
    const n = e.store.facts(card.id).length
    const host = advanceHostOf(e.wf)
    expect(await host.attested(e.wf.store.card(card.id), { cycle: answers[0].cycle, attempt: 'att-1' }, answers[0], 'again')).toBe(false)
    expect(e.store.facts(card.id).length).toBe(n)
  })

  it('HI-3236: a previewing finish asks the adapter’s advancePreview, never advance; the preview is bound to its plan, and its click reaches advanceAnswer as a preview answer', async () => {
    const { e, card } = await inApproved({ finish: 'previewAdvance' })
    const calls: string[] = []
    const answers: AdvanceAnswer[] = []
    const p = e.wf.platformOf(e.wf.store.card(card.id)) as unknown as Record<string, unknown>
    p.advance = async () => (calls.push('advance'), 'notReady')
    p.advancePreview = async (c: CardRecord, s: CardState, host: AdvanceHost) => {
      calls.push('advancePreview')
      if (!e.wf.state(c).requests.length) await host.askPreview(c, s.cycle, 'plan-1', { target: 'main', expected: 'e'.repeat(40), result: 'r'.repeat(40), style: 'merge', commits: 'r1 one', more: 0 })
      return 'notReady'
    }
    p.advanceAnswer = async (_c: CardRecord, a: AdvanceAnswer) => void answers.push(a)
    await pass(e, card)
    expect(calls).toEqual(['advancePreview'])
    const req = e.wf.state(card).requests.find((r) => r.gate === ADVANCE_PREVIEW_GATE)!
    expect(req).toMatchObject({ entry: 'plan-1', result: 'plan-1', kind: 'approve' })
    expect(isRefusal(await e.wf.answer(card.key, req.request, 'approved', { by: 'agent' }))).toBe(true)
    moved(await e.wf.answer(card.key, req.request, 'approved', { by: 'user' }))
    await e.wf.runActions()
    expect(answers).toMatchObject([{ request: req.request, gate: ADVANCE_PREVIEW_GATE, plan: 'plan-1', state: 'preview', answer: 'approved' }])
    // Another finish (Combwork's advance): advance, never advancePreview.
    stand.finish = 'combworkAdvances'
    Object.assign(e.options, { finish: 'combworkAdvances' })
    expect(calls).not.toContain('advance')
  })

  it('a stop with its undo offered asks the stopped question; asked again, the consumed question is retired and one stays open', async () => {
    const { e, card } = await inApproved()
    ports(e, card, async (host, c, s) => {
      if (e.wf.state(c).advance) return
      await host.attempted(c, s.cycle, 'plan-1', 'att-1')
      await host.stopped(c, { cycle: s.cycle, attempt: 'att-1' }, 'plan-1', { code: 'x', undo: true, uncertain: false }, words)
    })
    await pass(e, card)
    const open = () => e.wf.state(card).requests.filter((r) => r.gate === ADVANCE_STOPPED_GATE || r.gate === ADVANCE_UNCERTAIN_GATE)
    expect(open().map((r) => r.gate)).toEqual([ADVANCE_STOPPED_GATE])
    const host = advanceHostOf(e.wf)
    const s = e.wf.state(card)
    expect(await host.askAgain(e.wf.store.card(card.id), { cycle: s.cycle, attempt: 'att-1' }, 'plan-1', 'uncertain', { ...words, again: 'stale' }, null)).toBe(true)
    expect(open().map((r) => r.gate)).toEqual([ADVANCE_UNCERTAIN_GATE])
    expect(open()[0].text).toMatch(/^Asked again: an answer arrived that no longer applied/)
    expect(e.wf.state(card).advance).toMatchObject({ state: 'uncertain' })
  })
})
