// The canary dialect (dialects, HI-2065; HI-2438, card 5) over a card's start prompt, the Agent API's stall reasons and a
// lane's brief: every word they say comes through the catalogue, and every prompt.*, stall.* and brief.lane.*/brief.rule.*
// id shows in some output.
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'path'
import { setProcessChain, type DialectChain } from '../src/shared/agentText'
import { canaryProblems, canaryTexts } from '../src/shared/agentText/canary'
import { laneBuilderSkill, laneOrderWaitReason, loopStepWaitReason, notWatchingReason, reviewStalled, reviewVerdictWaitReason, reviewWaitReason, stalledReason, startFailedReason, startWaitingReason, taskPrompt } from '../src/shared/tasks'
import { laneBrief, laneRules, type LaneBriefInput } from '../src/shared/laneBrief'
import type { TaskCard } from '../src/shared/types'
import { laneNextWaitReason } from '../src/main/cardStall'
// @ts-expect-error: a plain .mjs module without types
import { readCatalogue } from '../scripts/agentTextExtract.mjs'

const ROOT = join(__dirname, '..')
const catalogue = readCatalogue(ROOT) as Record<string, { text: string }>
const ids = new Set(Object.keys(catalogue))
const chain = (texts: Record<string, string>): DialectChain => ({ texts, files: ['test.json'], hash: 'test' })

afterEach(() => setProcessChain(null))

/** What a test put in an output (names, keys, titles, paths, column names): not Combwork's wording. */
const VALUES = ['Fix it', 'The details', 'Only the tests', 'First thoughts', 'Failed', 'the redirect loops', 'Reviewer', 'alpha', 'You', 'Agent2', 'B1', 'R1', 'R2', 'R3', 'AL-1', 'AL-2', 'Lane data', 'Lane hover', 'Keep the API stable', 'typecheck', 'lint', 'ui', 'api', 'slot', 'acme', 'Done', 'Review', 'Passed', 'docs', 'md', 'intro', 'setup', 'install', 'att', 'png', 'x', 'k', 'Slot', 'held', 'no', 'CLI']

function prompts(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = []
  const card = { number: 7, title: 'Fix it', description: 'The details.', blockedBy: [], comments: [], context: [] } as unknown as TaskCard
  const comments = [
    { at: '2026-10-01T10:00:00Z', by: 'You', text: 'First thoughts.' },
    { at: '2026-10-02T10:00:00Z', by: 'Reviewer (alpha)', text: 'Failed: the redirect loops.' }
  ]
  const atts = (n: number): { id: string; path: string }[] => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, path: `C:/att/f${i}.png` }))
  for (const withTools of [true, false])
    for (const inLane of [true, false])
      for (const from of [undefined, 'review', 'done'] as const)
        for (const cs of [[], comments.slice(0, 1), comments, [{ at: '2026-10-02T10:00:00Z', by: 'You', text: 'x'.repeat(5000) }]])
          for (const a of [0, 1, 12])
            out.push({ name: `prompt ${withTools} ${inLane} ${from} ${cs.length} ${a}`, text: taskPrompt({ ...card, comments: cs, blockedBy: a ? [3, 4] : [] } as never, withTools, { from, note: 'Only the tests.', inLane, attachments: atts(a) }) })
  const ok = [
    { ref: 'docs/A.md#intro', size: 1234 },
    { ref: 'docs/B.md', size: 23456 },
    { ref: 'docs/C.md' }
  ]
  for (const problem of ['notFound', 'noHeading', 'ambiguous', 'invalid', 'outside', 'hidden', 'notMarkdown', 'tooBig'] as const)
    for (const closest of [[], ['setup', 'install']])
      for (const withOk of [true, false])
        for (const two of [true, false]) {
          const bad = { ref: 'docs/X.md#setup', problem: { ref: 'docs/X.md#setup', problem, closest } }
          const context = [...(withOk ? ok : []), bad, ...(two ? [bad] : [])]
          for (const withTools of [true, false]) out.push({ name: `context ${problem} ${closest.length} ${withOk} ${two} ${withTools}`, text: taskPrompt(card, withTools, { context }) })
        }
  out.push({ name: 'lane builder skill', text: laneBuilderSkill() })
  return out
}

function stalls(): { name: string; text: string | null }[] {
  const now = Date.parse('2026-10-07T12:00:00.000Z')
  const at = (minAgo: number): string => new Date(now - minAgo * 60_000).toISOString()
  const doing = { column: 'doing', archived: false, agent: 'a2', agentName: 'Agent2', number: 9, project: 'alpha', review: null, blocked: null, history: [] }
  const review = { ...doing, column: 'review', history: [{ at: at(125), by: 'You', what: 'Moved to Review' }] }
  const out: { name: string; text: string | null }[] = [
    { name: 'no agent', text: stalledReason({ ...doing, agent: null } as never, null) },
    { name: 'removed', text: stalledReason(doing as never, null) },
    { name: 'removed unnamed', text: stalledReason({ ...doing, agentName: null } as never, null) },
    { name: 'not running', text: stalledReason(doing as never, { name: 'Agent2', running: false }) },
    { name: 'start waiting', text: startWaitingReason(doing as never, { name: 'B1', running: false, waiting: 'slot held' }) },
    { name: 'start failed', text: startFailedReason(doing as never, { name: 'B1', running: false, failed: 'no CLI' }) },
    { name: 'reviewer not running', text: reviewStalled({ review: { agent: 'r', agentName: 'R1' }, archived: false } as never, { name: 'R1', running: false }) },
    { name: 'wake untaken', text: notWatchingReason(doing as never, [{ name: 'B1', project: 'alpha', notWatching: [9], untaken: true }]) },
    { name: 'not watching', text: notWatchingReason(doing as never, [{ name: 'B1', project: 'alpha', notWatching: [9] }]) }
  ]
  for (const [minAgo, label] of [[40, 'minutes'], [120, 'hours'], [125, 'hours and minutes']] as const) {
    const r = { ...review, history: [{ at: at(minAgo), by: 'You', what: 'Moved to Review' }] }
    for (const w of [{}, { status: 'working' }, { silentMinutes: 25 }]) out.push({ name: `review wait ${label} ${JSON.stringify(w)}`, text: reviewWaitReason(r as never, [{ name: 'R1', project: 'alpha', agentId: 'r', cards: [9], ...w }], now) })
  }
  out.push({ name: 'no verdict', text: reviewVerdictWaitReason({ ...review, review: { agent: 'r', agentName: 'R1', since: at(60) } } as never, [{ name: 'R1', project: 'alpha', agentId: 'r', cards: [9], status: 'watching', watchSince: at(30) }], now) })
  out.push({
    name: 'lane order',
    text: laneOrderWaitReason(
      review as never,
      { builder: 'b', reviewer: 'r', cards: [{ number: 8, column: 'todo', movedAt: at(60) }, { number: 9, column: 'review' }] } as never,
      [
        { name: 'R1', project: 'alpha', agentId: 'r', cards: [8], status: 'watching', watchSince: at(60) },
        { name: 'B1', project: 'alpha', agentId: 'b', cards: [9], status: 'watching', watchSince: at(60) }
      ],
      now
    )
  })
  // A lane's next card whose dependencies all went Done, not started since (HI-2618's DEPS_DONE; HI-2637).
  out.push({
    name: 'lane next, dependencies done',
    text: laneNextWaitReason(
      { number: 9, key: 'AL-2', column: 'todo', archived: false, blocked: null },
      { builder: 'b', reviewer: 'r', state: 'active', startedAt: at(120), cards: [{ number: 8, key: 'AL-1', column: 'done', movedAt: at(90) }, { number: 9, key: 'AL-2', column: 'todo', movedAt: null }], due: { card: 9, open: [], readyAt: at(30) } } as never,
      { name: 'B1', status: 'watching' },
      now
    )
  })
  for (const step of ['design', 'follow-up'])
    out.push({
      name: `loop step ${step}`,
      text: loopStepWaitReason({ ...doing, column: step === 'design' ? 'doing' : 'review', history: [{ at: at(120), by: 'B1', what: `Posted a ${step} for the reviewer to check: x` }] } as never, [{ name: 'B1', project: 'alpha', agentId: 'a2', cards: [9], status: 'watching' }], 60_000, now)
    })
  return out
}

function briefs(): { name: string; text: string }[] {
  const input = (over: Partial<LaneBriefInput> = {}): LaneBriefInput => ({
    project: 'alpha',
    cards: [
      { key: 'AL-1', title: 'Lane data' },
      { key: 'AL-2', title: 'Lane hover' }
    ],
    builder: { name: 'B1', folder: 'D:/acme/b1', branch: 'cw/b1' },
    reviewer: { name: 'R1' },
    options: { review: 'agent', preChecks: ['typecheck', 'lint'], finish: 'agentMerges', okBefore: { mode: 'labels', labels: ['ui', 'api'] }, target: 'main' },
    rounds: 10,
    note: 'Keep the API stable.',
    ...over
  })
  const out: { name: string; text: string }[] = []
  const builders = [{ name: 'B1', folder: 'D:/acme/b1', branch: 'cw/b1' }, { name: 'B1', folder: 'D:/acme/b1', branch: null }, { name: 'B1', folder: null, branch: null }, { name: 'B1', folder: null, branch: null, slot: 'slot-b' }]
  const reviewers: Partial<LaneBriefInput>[] = [{}, { reviewer: null }, { reviewer: null, pool: [] }, { reviewer: null, pool: ['R1', 'R2', 'R3'] }]
  for (const [i, builder] of builders.entries()) for (const [j, r] of reviewers.entries()) for (const role of ['builder', 'reviewer'] as const) out.push({ name: `brief ${i} ${j} ${role}`, text: laneBrief(input({ builder, ...r }), role) })
  out.push({ name: 'brief no target, no note', text: laneBrief(input({ options: { review: 'none', preChecks: [], finish: 'combworkMerges', okBefore: { mode: 'none' } } as never, note: '' }), 'builder') })
  for (const review of ['none', 'agent', 'agentThenYou', 'you'] as const)
    for (const finish of ['combworkMerges', 'agentMerges', 'committed', 'notChecked', 'accept'] as const)
      for (const okBefore of [{ mode: 'every' }, { mode: 'labels', labels: ['ui'] }])
        out.push({ name: `rules ${review} ${finish} ${okBefore.mode}`, text: laneRules({ review, finish, preChecks: ['lint'], okBefore, target: 'main' } as never).join('\n') })
  out.push({ name: 'rules off', text: laneRules(null).join('\n') })
  return out
}

describe('the canary dialect over prompts, stall reasons and lane briefs (card 5)', () => {
  it('finds every word of them in the catalogue, and every catalogued text of them in some output', () => {
    setProcessChain(chain(canaryTexts(catalogue)))
    const seen = new Set<string>()
    for (const { name, text } of [...prompts(), ...stalls(), ...briefs()]) {
      expect(text, name).not.toBeNull()
      expect(canaryProblems(text!, ids, VALUES), name).toEqual([])
      for (const m of text!.matchAll(/⟦([^/⟧][^⟧]*)⟧/g)) seen.add(m[1])
    }
    const mine = [...ids].filter((id) => /^(prompt|stall|brief\.(lane|rule))\./.test(id))
    expect(mine.length).toBeGreaterThan(50)
    expect(mine.filter((id) => !seen.has(id))).toEqual([])
  })

  it('finds text glued on in code', () => {
    setProcessChain(chain(canaryTexts(catalogue)))
    expect(canaryProblems(`${laneRules(null)[0]} Also, hurry.`, ids)).toEqual([expect.stringMatching(/^text outside the catalogue: Also, hurry/)])
  })
})
