// Agents under Combwork merges (#1354, SPEC §16.9.3): a builder never merges a card Combwork merges, and is told at each queue
// outcome what to do. What decides is the card's own ruleset (the options it started under), never the project's
// current options; with workflow rules off (Settings → Advanced) nothing here refuses: agents merge and report as before
// 1.0, and the queue drops the entry. On real temporary repositories (harness.ts).
import { afterEach, describe, expect, it } from 'vitest'
import { B1, commit, moved, R1, refusedBy, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { leftWake, NOT_RUN_HERE, pauseWait, queueLine, type PauseWait, queueOrder, queueStateOf, returnedText, WAKE_NOTE_MAX, type QueueLive } from '../../src/main/workflow/queueState'
import { keptLog, KEPT_LOG, type PauseReason } from '../../src/main/workflow/mergeQueue'
import { refusalLines } from '../../src/shared/workflow/refusals'
import { resubmittedIn, returnIn } from '../../src/main/queueReturn'
import { agentOf } from '../../src/shared/workflow/facts'
import { laneNextText } from '../../src/shared/lanes'
import { cardChange, loopWakeLine } from '../../src/shared/watch'
import type { FactData } from '../../src/shared/workflow/facts'
import type { QueueStuck } from '../../src/shared/workflow/queue'
import type { TaskCard } from '../../src/shared/types'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

const team = (extra: Parameters<typeof setup>[1] = {}) => (env = setup({ ...preset('git', 'team', { quick: ['quick'], tests: [] }), preChecks: [], okBefore: { mode: 'never', labels: [] }, commands: { quick: 'npm run quick' } }, extra))

/** A card approved and queued: started by B1, committed, submitted, passed by R1. */
async function queued(e: Env, title = 'Change', files: Record<string, string> = { [`src/${title}.txt`]: `${title}\n` }) {
  const card = e.wf.createCard({ title })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  const folder = s.data!.folder as string
  commit(folder, files, `${card.key}: ${title}`)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  moved(await e.wf.startReview(card.key, R1))
  moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  return { card, folder }
}

describe('refusals under Combwork merges (the card says what to do)', () => {
  it("report merge on a queued card: refused with its place in the queue and where the rule is set; the card untouched; Refused recorded", async () => {
    const e = team()
    const { card: first } = await queued(e, 'One')
    const { card } = await queued(e, 'Two')
    const r = refusedBy(await e.wf.reportMerge(card.key, B1), 'merge.combworkMerges')
    expect(r.message).toBe(`Combwork merges ${card.key}: agents don't merge it or report its merge.`)
    expect(r.next).toBe('It is in the merge queue for main (position 2) and moves to Done once merged: wait for that, or for it to come back.')
    expect(r.change).toBe('This rule is set in Version Control → Who merges. A card keeps the rules it started with.')
    expect(r.override).toBeNull()
    expect(e.wf.state(card).stage).toBe('merging')
    expect(e.wf.state(first).stage).toBe('merging')
    expect(e.kinds(card.id)).toContain('Refused')
    // The first is next in line.
    expect(refusedBy(await e.wf.reportMerge(first.key, B1), 'merge.combworkMerges').next).toContain('(position 1)')
  })

  it('before approval, and after a return: the next step fits where it is', async () => {
    const e = team()
    const card = e.wf.createCard({ title: 'Early' })
    moved(await e.wf.start(card.key, B1))
    expect(refusedBy(await e.wf.reportMerge(card.key, B1), 'merge.combworkMerges').next).toBe('Once it is approved, the merge queue merges it and moves it to Done: wait for that, or for it to come back.')
    const { card: red } = await queued(e, 'Red')
    await e.queue({ runCheck: async () => ({ ok: false, output: '1 failing' }) }).drain('main')
    expect(refusedBy(await e.wf.reportMerge(red.key, B1), 'merge.combworkMerges').next).toBe('It came back from the merge queue: fix it in your worktree, commit and submit again.')
  })

  it("an agent's move to Done names the queue, not report merge", async () => {
    const e = team()
    const { card } = await queued(e)
    const r = refusedBy(await e.wf.agentColumnMove(card.key, B1, 'done'), 'merge.combworkMerges')
    expect(r.next).toContain('merge queue for main')
    // Translated into report merge (P4 to P8): the same refusal.
    refusedBy(await e.wf.agentColumnMove(card.key, B1, 'done', { translate: true }), 'merge.combworkMerges')
    expect(e.wf.state(card).stage).toBe('merging')
    // Where the agent merges, the refusal names the intent to use, as before.
    e.options.finish = 'agentMerges'
    const theirs = e.wf.createCard({ title: 'Theirs' })
    expect(refusedBy(await e.wf.agentColumnMove(theirs.key, B1, 'done'), 'move.useIntent').next).toBe('Use the report merge intent instead.')
  })

  it('the merge slot: refused for a card Combwork merges (refuseCombworkMerge), nothing for an unknown card', async () => {
    const e = team()
    const { card } = await queued(e)
    const r = await e.wf.refuseCombworkMerge(card.key, B1, 'merge slot')
    expect(r).toMatchObject({ refused: true, rule: 'merge.combworkMerges', override: null })
    expect(await e.wf.refuseCombworkMerge('AM-999', B1, 'merge slot')).toBeNull()
  })

  it('the window shows the refusal in its own words, its next step by where the card is', async () => {
    const lines = refusalLines('merge.combworkMerges', { card: 'AM-3', queue: 'testing', target: 'main' }, { one: (m, v) => `${m.id}${v ? JSON.stringify(v) : ''}`, list: (x) => x.join(', '), names: true })
    expect(lines.next).toContain('workflow.refused.merge.combworkMerges.nextTesting')
    expect(refusalLines('merge.combworkMerges', { card: 'AM-3', queue: 'notYet' }, { one: (m) => m.id, list: (x) => x.join(', '), names: true }).next).toBe('workflow.refused.merge.combworkMerges.next')
    // A paused queue's next step by what the pause waits for (#1406).
    const paused = (waits?: string) => refusalLines('merge.combworkMerges', { card: 'AM-3', queue: 'paused', target: 'main', ...(waits ? { waits } : {}) }, { one: (m) => m.id, list: (x) => x.join(', '), names: true }).next
    expect([paused('resume'), paused('answer'), paused('fix'), paused('folder'), paused('rules'), paused()]).toEqual(['nextPaused', 'nextPausedAnswer', 'nextPausedFix', 'nextPausedFolder', 'nextPausedRules', 'nextPaused'].map((x) => `workflow.refused.merge.combworkMerges.${x}`))
  })

  it("a paused queue: the line and the refusal's next step say what the pause waits for, the agent's own step the same (#1406)", async () => {
    const e = team()
    const { card: first } = await queued(e, 'One')
    const { card } = await queued(e, 'Two')
    const tail = ': wait for Done, or for it to come back.'
    // A stuck advance (its terminal state, asked in For you), as the queue saves it.
    const stuck: QueueStuck = { folder: e.project, branch: 'main', ref: null, expected: 'a'.repeat(40), result: 'b'.repeat(40), phase: 'files', files: [{ path: 'a.txt', side: 'other' }], commands: [] }
    const cases: [PauseReason, PauseWait, string, string, QueueStuck?][] = [
      ['user', 'resume', 'it moves on once the user resumes it.', 'which is paused until it is resumed'],
      ['targetMovesFast', 'resume', 'it moves on once the user resumes it.', 'which is paused until it is resumed'],
      ['approval', 'answer', 'it moves on once the user answers, in For you, whether to update main now.', 'which is paused until the user answers in For you'],
      // needsYou with no question (git's error, an earlier runner's process): fixed, then Resume; a stuck advance: For you.
      ['needsYou', 'fix', 'it moves on once the user fixes what stopped it and resumes it.', 'which is paused until the user fixes what stopped it and resumes it'],
      ['needsYou', 'answer', 'it moves on once the user settles its interrupted advance (their answer in For you, or Resume).', 'which is paused until the user answers in For you', stuck],
      ['wrongBranch', 'folder', 'it moves on once the user puts right the folder main is checked out in and resumes it.', 'which is paused until the user puts right the folder main is checked out in and resumes it'],
      ['staged', 'folder', 'it moves on once the user puts right the folder main is checked out in and resumes it.', 'which is paused until the user puts right the folder main is checked out in and resumes it'],
      ['unstagedChanges', 'folder', 'it moves on once the user puts right the folder main is checked out in and resumes it.', 'which is paused until the user puts right the folder main is checked out in and resumes it'],
      ['folderBusy', 'folder', 'it moves on once the user puts right the folder main is checked out in and resumes it.', 'which is paused until the user puts right the folder main is checked out in and resumes it'],
      // Combwork resumes it once the rules are enforced again (queueHost's startOpen); one left from before, Resume.
      ['rulesOff', 'rules', 'it paused while workflow rules were off; it moves on once they are enforced again (if they already are, once the user resumes it).', 'which paused while workflow rules were off and moves on once they are enforced again (if they already are, once the user resumes it)']
    ]
    for (const [reason, waits, line, next, st] of cases) {
      e.store.setQueuePause('main', { reason, card: first.key, ...(st ? { stuck: st } : {}) })
      expect(pauseWait(reason, !!st)).toBe(waits)
      expect(e.wf.queueLineOf(card.key)).toBe(`Combwork merges this card (its rules): don't merge it yourself. It is in the merge queue for main, which is paused (${reason}, on ${first.key}); ${line}`)
      const r = refusedBy(await e.wf.reportMerge(card.key, B1), 'merge.combworkMerges')
      expect(r.next).toBe(`It is in the merge queue for main, ${next}${tail}`)
    }
    expect(e.wf.state(card).stage).toBe('merging')
  })
})

describe('old rules: the card keeps the ruleset it started under', () => {
  it('started under Combwork merges, the project switched to "The agent merges": still refused and still queued; a card started afterwards reports its merge', async () => {
    const e = team()
    const { card: old } = await queued(e, 'Old')
    e.options.finish = 'agentMerges'
    refusedBy(await e.wf.reportMerge(old.key, B1), 'merge.combworkMerges')
    expect(e.wf.state(old).stage).toBe('merging')
    expect(queueStateOf(e.wf, old)).toMatchObject({ state: 'queued', position: 1 })
    // A card started now: the agent merges it, and its report is taken.
    const { card: now, folder } = await queued(e, 'New')
    expect(e.wf.state(now).stage).toBe('approved')
    expect(queueStateOf(e.wf, now)).toBeNull()
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'by the agent', sh(folder, 'rev-parse', 'HEAD'))
    moved(await e.wf.reportMerge(now.key, B1))
    expect(e.wf.state(now).stage).toBe('done')
  })
})

describe('with workflow rules off (Settings → Advanced)', () => {
  it('report merge of a queued Combwork-merges card works as before 1.0: Done, and the queue drops its entry', async () => {
    let enforced = true
    const e = team({ enforced: () => enforced })
    const { card, folder } = await queued(e)
    enforced = false
    expect(e.wf.combworkMergesRefusal(card)).toBeNull()
    expect(await e.wf.refuseCombworkMerge(card.key, B1, 'merge slot')).toBeNull()
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'by hand', sh(folder, 'rev-parse', 'HEAD'))
    moved(await e.wf.reportMerge(card.key, B1))
    const s = e.wf.state(card)
    expect(s.stage).toBe('done')
    expect(s.entries.at(-1)?.state).toBe('cancelled')
    expect(s.entries.at(-1)?.cancelled).toBe('integratedOutside')
    enforced = true
    expect(await e.queue().runOnce('main')).toBeNull()
    expect(queueLine({ state: 'queued', target: 'main', position: 1 }, false)).toContain("workflow rules aren't enforced")
  })
})

describe('wakes at each queue outcome (what came back and what to do)', () => {
  it("a card the queue returned waits for its builder, as its facts say (HI-1721's returnIn): when, its wake, its builder; none once it is submitted again, queued or merged", async () => {
    const e = team()
    const { card, folder } = await queued(e, 'Back')
    expect(returnIn(e.wf, card.id)).toBeNull()
    await e.queue({ runCheck: async () => ({ ok: false, output: '1 failing' }) }).drain('main')
    const back = returnIn(e.wf, card.id)
    expect(back).toMatchObject({ builder: agentOf(B1), text: e.wakes.find((w) => w.card === card.key && w.why.includes('merge queue'))!.why })
    expect(Date.parse(back!.at)).toBeGreaterThan(0)
    // Fixed and submitted again: not waiting for its builder any more.
    commit(folder, { 'src/fix.txt': 'fix\n' }, `${card.key}: fix`)
    moved(await e.wf.submit(card.key, B1, { summary: 'fixed' }))
    expect(returnIn(e.wf, card.id)).toBeNull()
    expect(returnIn(e.wf, 99999)).toBeNull()
  })

  it("a returned card submitted again is one for its reviewer, as its facts say (HI-2143's resubmittedIn): until a verdict on it, or the queue takes it again", async () => {
    const e = team()
    const { card, folder } = await queued(e, 'Again')
    await e.queue({ runCheck: async () => ({ ok: false, output: '1 failing' }) }).drain('main')
    // Returned, not submitted yet: the builder's, not the reviewer's.
    expect(resubmittedIn(e.wf, card.id, 'B1')).toBeNull()
    commit(folder, { 'src/fix.txt': 'fix\n' }, `${card.key}: fix`)
    moved(await e.wf.submit(card.key, B1, { summary: 'fixed' }))
    expect(resubmittedIn(e.wf, card.id, 'B1')).toBe(`${card.key} is back in Review after the merge queue returned it (the merge check quick failed on the merged result); B1 changed it and submitted it again: review what changed`)
    // Reviewed and passed again: no longer.
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
    expect(resubmittedIn(e.wf, card.id, 'B1')).toBeNull()
    expect(resubmittedIn(e.wf, 99999, 'B1')).toBeNull()
  })

  it('red checks: the check, its log, its last lines and the next step; within the wake line', async () => {
    const e = team()
    const { card } = await queued(e)
    const output = ['ok 1', 'ok 2', 'not ok 3 - adds', '# 1 failing'].join('\n')
    await e.queue({ runCheck: async () => ({ ok: false, output, logPath: 'C:\\logs\\check.log' }) }).drain('main')
    const wake = e.wakes.find((w) => w.card === card.key && w.why.includes('merge queue'))!.why
    expect(wake).toBe(`${card.key} came back from the merge queue: the merge check quick failed on the merged result. Its log: C:\\logs\\check.log. Its last lines: "ok 1 | ok 2 | not ok 3 - adds | # 1 failing". Fix it in your worktree, commit and submit again (cw_submit).`)
    expect(e.wf.state(card).entries.at(-1)?.failure).toMatchObject({ check: 'quick', logPath: 'C:\\logs\\check.log' })
    // The card read says it too.
    expect(e.wf.queueLineOf(card.key)).toContain('Its log: C:\\logs\\check.log.')
  })

  it('a transient failure: submit the same revision again, at most twice', async () => {
    const e = team()
    const { card } = await queued(e)
    await e.queue({ runCheck: async () => ({ ok: false, transient: true, cause: { cause: 'network', code: 'ENOTFOUND' }, output: 'npm error code ENOTFOUND' }) }).drain('main')
    const wake = e.wakes.find((w) => w.card === card.key && w.why.includes('merge queue'))!.why
    expect(wake).toContain('the merge check quick failed for the environment, not the work (network: ENOTFOUND)')
    expect(wake).toContain('Submit the same revision again (cw_submit): it goes straight back into the queue, at most twice in a row.')
  })

  it('a conflict: the files, and merging the target in', () => {
    const f: FactData['IntegrationFailed'] = { entry: 'AM-1/e1', revision: 'a', target: 'main', reason: 'conflict', transient: false, files: Array.from({ length: 10 }, (_, i) => `f${i}.ts`) }
    expect(returnedText('AM-1', f)).toBe('AM-1 came back from the merge queue: a conflict with main in f0.ts, f1.ts, f2.ts, f3.ts, f4.ts, f5.ts, f6.ts, f7.ts and 2 more. Merge main into your worktree, resolve the conflict, commit and submit again (cw_submit).')
  })

  it("a conflict's hunks (HI-1181): where each file's are, or why it wasn't read; the files alone when that doesn't fit", () => {
    const hunk = (line: number) => ({ line, before: [], ours: ['o'], theirs: ['t'], after: [] })
    const f: FactData['IntegrationFailed'] = { entry: 'AM-1/e1', revision: 'a', target: 'main', reason: 'conflict', transient: false, files: ['a.ts', 'b.png'], conflicts: { oursIs: 'target', files: [{ file: 'a.ts', hunks: [hunk(10), hunk(40)] }, { file: 'b.png', notRead: 'binary', hunks: [] }] } }
    expect(returnedText('AM-1', f)).toContain('a conflict with main in a.ts (2 conflicts, lines 10 and 40), b.png (not read: binary).')
    const many: FactData['IntegrationFailed'] = { ...f, files: Array.from({ length: 10 }, (_, i) => `f${i}.ts`), conflicts: { oursIs: 'target', files: Array.from({ length: 10 }, (_, i) => ({ file: `f${i}.ts`, hunks: [hunk(1)] })) } }
    expect(returnedText('AM-1', many)).toContain('in f0.ts, f1.ts, f2.ts, f3.ts, f4.ts, f5.ts, f6.ts, f7.ts and 2 more.')
    expect(returnedText('AM-1', many).length).toBeLessThanOrEqual(WAKE_NOTE_MAX)
    // Strict's update conflicting (not up to date, HR4's round 1): its files and where too; without files, as before.
    const strict: FactData['IntegrationFailed'] = { ...f, reason: 'notUpToDate', files: ['a.ts'], conflicts: { oursIs: 'card', files: [{ file: 'a.ts', hunks: [hunk(10)] }] } }
    expect(returnedText('AM-1', strict)).toContain("it isn't up to date with main: a conflict in a.ts (1 conflict, line 10).")
    expect(returnedText('AM-1', { ...strict, files: undefined, conflicts: undefined })).toContain("it isn't up to date with main.")
  })

  it('a long log: its end kept, the next step always there, the whole within the wake note', () => {
    const f: FactData['IntegrationFailed'] = { entry: 'AM-1/e1', revision: 'a', target: 'main', reason: 'checks', transient: false, check: 'tests', logPath: 'C:\\l.log', log: Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(150)}`).join('\n') }
    const t = returnedText('AM-1', f)
    expect(t.length).toBeLessThanOrEqual(WAKE_NOTE_MAX)
    expect(t).toContain('line 49')
    expect(t.endsWith('Fix it in your worktree, commit and submit again (cw_submit).')).toBe(true)
    // The wake line quotes Combwork's note whole (up to 600), a reviewer's request still at 200.
    const change = cardChange(5, { number: 5, title: 'T', column: 'doing', comments: [], history: [] } as unknown as TaskCard, ['column'])
    expect(loopWakeLine(change, 'note', t)).toContain(t.slice(-60))
    expect(loopWakeLine(change, 'request', t)).not.toContain(t.slice(-60))
  })

  it('long names: what came back and the next step always whole, in the note and the wake line; what is left out is said', () => {
    const nested = (i: number) => `packages/feature-${i}/src/components/deeply/nested/folder/structure/Component${i}.test.tsx`.padEnd(92, 'x')
    const files = Array.from({ length: 8 }, (_, i) => nested(i))
    const longPath = `C:\\Users\\someone\\AppData\\Local\\demo\\queue-logs\\${'very-long-folder-name\\'.repeat(16)}check.log`
    const longName = 'release/' + 'a-very-long-branch-name-'.repeat(8)
    const longCheck = 'npm run ' + 'check:'.repeat(30)
    const base = { entry: 'AM-1/e1', revision: 'a', transient: false } as const
    const log = Array.from({ length: 30 }, (_, i) => `line ${i} ${'y'.repeat(120)}`).join('\n')
    const cases: [string, FactData['IntegrationFailed']][] = [
      ['eight long files', { ...base, target: 'main', reason: 'conflict', files }],
      ['long files and a long target', { ...base, target: longName, reason: 'conflict', files, log }],
      ['a long log path', { ...base, target: 'main', reason: 'checks', check: 'tests', logPath: longPath, log }],
      ['a long check, path and target', { ...base, target: longName, reason: 'checks', check: longCheck, logPath: longPath, log }],
      ['transient, a long code', { ...base, transient: true, target: longName, reason: 'checks', check: longCheck, cause: 'network', code: 'E'.repeat(200), logPath: longPath, log }],
      ['a hook, long everything', { ...base, target: longName, reason: 'hook', logPath: longPath, log }]
    ]
    const change = cardChange(5, { number: 5, title: 'T', column: 'doing', comments: [], history: [] } as unknown as TaskCard, ['column'])
    for (const [what, f] of cases) {
      const t = returnedText('AM-1', f)
      const next = f.transient ? 'Submit the same revision again (cw_submit): it goes straight back into the queue, at most twice in a row.' : f.reason === 'conflict' ? 'resolve the conflict, commit and submit again (cw_submit).' : 'Fix it in your worktree, commit and submit again (cw_submit).'
      expect(t.length, what).toBeLessThanOrEqual(WAKE_NOTE_MAX)
      expect(t.endsWith(next), `${what}: ${t}`).toBe(true)
      expect(t.startsWith('AM-1 came back from the merge queue: '), what).toBe(true)
      expect(loopWakeLine(change, 'note', t), what).toContain(next)
      // The reason is said whole, before anything that gives way.
      expect(t, what).toMatch(f.reason === 'conflict' ? /: a conflict with \S+ in / : f.reason === 'hook' ? /: a git hook refused its merge commit\./ : /: the merge check .+ failed /)
    }
    // Files that don't all fit: as many as fit, then how many more, never a name cut in two.
    const conflict = returnedText('AM-1', cases[0][1])
    expect(conflict).toMatch(/ and \d+ more\. Merge main/)
    for (const f of files) if (conflict.includes(f.slice(0, 20))) expect(conflict).toContain(f)
    // A log path that doesn't fit whole points to the card instead of a cut path.
    const pathless = returnedText('AM-1', cases[3][1])
    expect(pathless).not.toContain('check.log')
    expect(pathless).toContain('Its log path: cw_read_task.')
    // A card read has the room for it.
    expect(returnedText('It', cases[2][1], 1500, 15)).toContain(`Its log: ${longPath}.`)
  })

  it("the output's real ending is kept and quoted, past KEPT_LOG characters (through the queue's return)", async () => {
    const e = team()
    const { card } = await queued(e)
    const output = `${Array.from({ length: 400 }, (_, i) => `ok ${i} passing step`).join('\n')}\nFINAL_FAILURE_MARKER: 1 failing`
    expect(output.length).toBeGreaterThan(KEPT_LOG)
    await e.queue({ runCheck: async () => ({ ok: false, output }) }).drain('main')
    const kept = e.wf.state(card).entries.at(-1)!.failure!.log!
    expect(kept.length).toBeLessThanOrEqual(KEPT_LOG)
    expect(kept.endsWith('FINAL_FAILURE_MARKER: 1 failing')).toBe(true)
    expect(kept.startsWith('ok 0 passing step')).toBe(true)
    expect(kept).toMatch(/\n… \(\d+ characters left out\) …\n/)
    const wake = e.wakes.find((w) => w.card === card.key && w.why.includes('merge queue'))!.why
    expect(wake).toContain('FINAL_FAILURE_MARKER: 1 failing". Fix it in your worktree')
    expect(e.wf.queueLineOf(card.key)).toContain('FINAL_FAILURE_MARKER: 1 failing')
  })

  it('keptLog: whole when short; else its start, a line saying exactly how much was left out, and its end', () => {
    expect(keptLog('short')).toBe('short')
    for (const n of [4001, 9999, 10_000, 123_456]) {
      const log = Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26))).join('')
      const k = keptLog(log)
      expect(k.length).toBeLessThanOrEqual(KEPT_LOG)
      const m = /\n… \((\d+) characters left out\) …\n/.exec(k)!
      const head = k.slice(0, m.index)
      const tail = k.slice(m.index + m[0].length)
      expect(log.startsWith(head) && log.endsWith(tail)).toBe(true)
      expect(head.length + Number(m[1]) + tail.length).toBe(n)
    }
  })

  it('left the queue: why (its pass stale, or a decision since) and what to do', async () => {
    const e = team()
    const { card } = await queued(e, 'Decided')
    // A decision while queued: the runtime cancels the entry itself (its own wake).
    moved(await e.wf.recordDecision(card.key, 'Use the other name'))
    expect(queueStateOf(e.wf, card)).toMatchObject({ state: 'left', why: 'decision' })
    expect(e.wf.queueLineOf(card.key)).toContain('a decision since its approval needs it reviewed again')
    // The queue's own skip says the same, by why and where the card went.
    expect(leftWake('AM-4', 'stale', 'review')).toBe('AM-4 left the merge queue: its pass is stale (its revision changed since it was approved). Submit the current revision (cw_submit) for review.')
    expect(leftWake('AM-4', 'decision', 'review')).toBe('AM-4 left the merge queue: a decision since its approval needs it reviewed again. Read its decisions (cw_read_task); it is back in Review, and queued again once approved.')
    expect(leftWake('AM-4', 'decision', 'active')).toContain('then submit again (cw_submit).')
  })
})

describe('where a card is, for its readers (queueState.ts)', () => {
  it('queued, testing, merged; nothing for a card the agent merges', async () => {
    const e = team()
    const { card } = await queued(e)
    expect(e.wf.queueLineOf(card.key)).toBe("Combwork merges this card (its rules): don't merge it yourself. It is in the merge queue for main, position 1; it moves to Done once merged.")
    await e.queue().drain('main')
    expect(queueStateOf(e.wf, card)).toEqual({ state: 'merged' })
    // Done: nothing more to say on a card read.
    expect(e.wf.queueLineOf(card.key)).toBeNull()
    expect(queueLine({ state: 'testing', target: 'main', step: 'testMerge' })).toContain('testing its merge into main now')
    expect(queueLine({ state: 'testing', target: 'main', step: 'checks' })).toContain('running the merge checks on its merge into main now')
    expect(queueLine({ state: 'testing', target: 'main', step: null })).toContain('testing its merge into main now')
    expect(queueLine({ state: 'paused', target: 'main', reason: 'folderBusy', card: 'AM-2' })).toContain('which is paused (folderBusy, on AM-2)')
  })

  it("the queue's order is the window's (#1353's queueView): the one testing now at its step, the next behind it position 1", async () => {
    let live: QueueLive = NOT_RUN_HERE
    const e = team({ queueLive: () => live })
    const { card: first } = await queued(e, 'One')
    const { card } = await queued(e, 'Two')
    expect(queueStateOf(e.wf, first)).toMatchObject({ state: 'queued', position: 1 })
    expect(queueStateOf(e.wf, card)).toMatchObject({ state: 'queued', position: 2 })
    // This Combwork's queue takes the first and runs its checks: it is testing (its entry still open), the second next.
    const entry = e.wf.state(first).entries.at(-1)!
    live = { running: true, run: null, now: { card: first.key, number: first.id, entry: entry.id, revision: entry.revision, expected: null, step: 'checks', started: new Date().toISOString() } }
    expect(e.wf.state(first).entries.at(-1)!.state).toBe('open')
    expect(queueStateOf(e.wf, first)).toEqual({ state: 'testing', target: 'main', step: 'checks' })
    expect(queueStateOf(e.wf, card)).toMatchObject({ state: 'queued', position: 1 })
    expect(queueOrder(e.wf, 'main').queued.map((q) => q.key)).toEqual([card.key])
    expect(refusedBy(await e.wf.reportMerge(card.key, B1), 'merge.combworkMerges').next).toContain('(position 1)')
    expect(refusedBy(await e.wf.reportMerge(first.key, B1), 'merge.combworkMerges').next).toContain('is merging it into main now')
  })

  it("cw_lane next: a passed card Combwork merges is named with where it is, and the next card waits for it", () => {
    const lane = { state: 'running' } as unknown as Parameters<typeof laneNextText>[0]['lane']
    expect(laneNextText({ lane, next: { card: 9, title: 'Next one', carryOn: false }, waits: null, queue: [{ card: 8, line: 'Combwork merges this card (its rules): queued.' }] })).toBe('#8: Combwork merges this card (its rules): queued. Next: #9 Next one, once it is Done.')
    expect(laneNextText({ lane, next: null, waits: null, queue: [{ card: 8, line: 'Queued.' }] })).toBe('#8: Queued. Nothing else to start: the lane ends by itself once all are Done.')
    expect(laneNextText({ lane, next: { card: 9, title: 'Next one', carryOn: false }, waits: null })).toBe('Next: #9 Next one. Start it.')
  })
})
