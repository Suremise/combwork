// Waiting on cards (#128): what counts as a change (shared/watch.ts), the reply and wake lines, the watching status's
// hook steps, and the watches themselves (main/watches.ts): a watch is kept in the workspace, fires once when a watched
// card changes or its limit passes, wakes its agent only when it is idle and the user isn't typing (else later), and
// ends on wake or cancel. The sessions are stand-ins here (the e2e cardloop suite runs real ones).
import { readCard, writeCard } from './boardDb'
import { moveFolder } from './moveFolder'
import { closeAllBoards } from '../src/main/boardStore'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { alreadyThere, loopWakeLine, changesBetween, decodeSince, encodeSince, limitLine, markOf, movedIntoSince, readCondition, returnRound, WAKE_MAX_BYTES, wakeAbout, wakeLine, wakeLines, carriedOver, changesSince, entryWithin, seenOf, watchLabel, cardChange, lanesRunningTail, withLanesTail, brief, handoffsSince, hearsHandoffs } from '../src/shared/watch'
import { taskWaitText } from '../src/shared/toolReplies'
import { resubmittedText, returnedWake } from '../src/main/workflow/queueState'
import { hookStep } from '../src/main/hookStatus'
import type { TaskCard } from '../src/shared/types'
import type { WatchCondition } from '../src/shared/watch'
import { tempDir } from './tempDir'
import { putStoreDocs, storeDocs, storeMeta } from './storeDocs'
import { follow, toldOf } from './followDoorbell'

// The longest a test waits for what it is waiting on: a bound for a hung run, never how long it should take.
const HUNG_MS = 10000
const at = (m: number): string => new Date(Date.UTC(2026, 9, 3, 12, m)).toISOString()
const cardOf = (over: Partial<TaskCard> = {}): TaskCard => ({ number: 7, title: 'T', description: '', project: 'alpha', agent: 'a1', column: 'doing', order: 1, labels: [], blocked: null, blockedBy: [], links: [], comments: [], history: [], archived: false, createdAt: at(0), createdBy: 'You', updatedAt: at(0), ...over })

describe('what counts as a change', () => {
  it('column, comment, verdict, agent; only the kinds asked for; a card gone always counts', () => {
    const before = markOf(cardOf())
    const after = markOf(cardOf({ column: 'review', comments: [{ at: at(5), by: 'Codex', text: 'Round 1: FAILED\nmore' }], history: [{ at: at(6), by: 'Codex', what: 'Review failed' }], agent: 'a2' }))
    expect(changesBetween(before, after, { changes: ['column', 'comment', 'verdict', 'agent'] })).toEqual(['column', 'comment', 'verdict', 'agent'])
    expect(changesBetween(before, after, { changes: ['verdict'] })).toEqual(['verdict'])
    expect(changesBetween(before, markOf(cardOf()), { changes: ['column'] })).toEqual([])
    expect(changesBetween(before, markOf(null), { changes: ['comment'] })).toBe('gone')
    expect(changesBetween(before, markOf(cardOf({ archived: true })), { changes: ['comment'] })).toBe('gone')
    // A column to arrive in: a move elsewhere doesn't count.
    expect(changesBetween(before, markOf(cardOf({ column: 'todo' })), { changes: ['column'], column: 'review' })).toEqual([])
    expect(changesBetween(before, markOf(cardOf({ column: 'review' })), { changes: ['column'], column: 'review' })).toEqual(['column'])
  })

  it('in a column, or a move into it: at once if already there (#434); a fresh move into it must leave and come back', () => {
    const inReview = markOf(cardOf({ column: 'review' }))
    expect(alreadyThere(inReview, { column: 'review' })).toBe(true)
    expect(alreadyThere(inReview, { column: 'review', moveInto: true })).toBe(true)
    expect(alreadyThere(inReview, { column: 'review', moveInto: true, fresh: true })).toBe(false)
    // Left and came back between two looks: the marks are the same; the history says it moved.
    const back = cardOf({ column: 'review', history: [{ at: at(10), by: 'B', what: 'Moved to Doing' }, { at: at(11), by: 'B', what: 'Moved to Review' }] })
    expect(movedIntoSince(back, 'review', at(9))).toBe(true)
    expect(movedIntoSince(back, 'review', at(12))).toBe(false)
    expect(movedIntoSince(cardOf({ history: [{ at: at(10), by: 'B', what: 'Moved to the top of Review' }] }), 'review', at(9))).toBe(true)
    expect(movedIntoSince(cardOf({ history: [{ at: at(10), by: 'B', what: 'Moved to Reviewers' }] }), 'review', at(9))).toBe(false)
    const cond = { changes: ['column' as const], column: 'review' as const, moveInto: true as const }
    expect(changesBetween(inReview, markOf(back), cond, false)).toEqual([])
    expect(changesBetween(inReview, markOf(back), cond, true)).toEqual(['column'])
  })

  it('several changes in one line: each card with its verdict; comments, then cards, give way to the size (#224)', () => {
    const h = (m: number, what: string, by = 'Codex (hive)') => ({ at: at(m), by, what })
    const change = (n: number, v: 'passed' | 'failed', comment = `Round 1: ${v.toUpperCase()}`) => {
      const card = cardOf({ number: n, agent: 'a1', agentName: 'Claudette', column: 'review', history: [h(1, 'Moved to Review', 'Claudette (hive)'), h(2, `Review ${v}`)], comments: [{ at: at(2), by: 'Codex (hive)', text: comment }] })
      return { ...cardChange(n, card, ['verdict' as const]), about: wakeAbout(card, ['verdict'], 'a2') }
    }
    expect(wakeLines([change(217, 'passed'), change(119, 'failed')])).toBe(
      `[CW] #217 (Claudette's card) is in Review: Codex (hive) passed it (latest comment by Codex (hive): "Round 1: PASSED"); #119 (Claudette's card) is in Review: Codex (hive) failed it (latest comment by Codex (hive): "Round 1: FAILED"). Your card watch has ended: carry on (cw_read_task with latestComment on each card for its comment in full).`
    )
    // One change: the single line as before.
    expect(wakeLines([change(217, 'passed')])).toBe(wakeLine(change(217, 'passed')))
    // Long comments are cut; many cards: as many as fit, the rest counted. Always within the line's limit, one line.
    const long = Array.from({ length: 5 }, (_, i) => change(100 + i, 'failed', '評'.repeat(400)))
    const five = wakeLines(long)
    expect(Buffer.byteLength(JSON.stringify(five))).toBeLessThanOrEqual(WAKE_MAX_BYTES)
    expect(five).toMatch(/#100 .*#101 .*#102 .*#103 .*#104 /)
    // Twenty (the most a watch has): every card is still named, in a few words, and the agent is told to read them (#226).
    const many = wakeLines(Array.from({ length: 20 }, (_, i) => change(100 + i, i % 2 ? 'passed' : 'failed')))
    expect(Buffer.byteLength(JSON.stringify(many))).toBeLessThanOrEqual(WAKE_MAX_BYTES)
    for (let n = 100; n < 120; n++) expect(many).toContain(`#${n} in Review, ${n % 2 ? 'passed' : 'failed'}`)
    expect(many).toMatch(/Details were left out to fit: read each card \(cw_read_task\) before you carry on\.$/)
    expect(many).not.toMatch(/\n|more watched card/)
  })

  it('too many changes to tell in full: every card is named, briefly or by number, within the size; gone ones say nothing more (#226)', () => {
    const long = (s: string) => s.repeat(300)
    // Twenty cards with long Unicode owners, reviewers and comments; some returned, some gone, one moved by hand.
    const card = (n: number) =>
      cardOf({ number: n, agent: 'a1', agentName: long('建造者'), column: n % 5 === 0 ? 'done' : 'review', history: [{ at: at(1), by: long('🐝'), what: n % 3 ? 'Review failed' : 'Review passed' }, ...(n % 7 === 0 ? [{ at: at(2), by: 'You', what: 'Returned for review, round 3' }] : [])], comments: [{ at: at(2), by: long('評'), text: long('Ünïcødé ') }] })
    const changes = Array.from({ length: 20 }, (_, i) => {
      const n = 300 + i
      if (n % 4 === 0) return cardChange(n, null, 'gone')
      const c = card(n)
      return { ...cardChange(n, c, ['verdict', 'column']), about: wakeAbout(c, ['verdict', 'column'], 'a2') }
    })
    const line = wakeLines(changes)
    expect(Buffer.byteLength(JSON.stringify(line))).toBeLessThanOrEqual(WAKE_MAX_BYTES)
    expect(line).not.toMatch(/\n/)
    for (const c of changes) expect(line).toMatch(new RegExp(`#${c.number}\\b`))
    // A gone card: its number only, nothing of its state (it may be another project's now).
    expect(line).toContain('#300 gone')
    expect(line).not.toMatch(/#300 (in|returned)/)
    // No names or comments in the short form.
    expect(line).not.toMatch(/建造者|🐝|評|Ünïcødé/)
    expect(line).toMatch(/Details were left out to fit/)
    // Numbers alone when even the short form can't fit (huge numbers); past what a watch can hold, counted.
    const huge = Array.from({ length: 20 }, (_, i) => cardChange(10 ** 15 + i, null, ['comment']))
    const byNumber = wakeLines(huge)
    expect(Buffer.byteLength(JSON.stringify(byNumber))).toBeLessThanOrEqual(WAKE_MAX_BYTES)
    for (const c of huge) expect(byNumber).toContain(`#${c.number}`)
    const beyond = wakeLines(Array.from({ length: 200 }, (_, i) => cardChange(10 ** 15 + i, null, ['comment'])))
    expect(Buffer.byteLength(JSON.stringify(beyond))).toBeLessThanOrEqual(WAKE_MAX_BYTES)
    expect(beyond).toMatch(/ and \d+ more watched cards changed\. /)
  })

  it('a watch counts what came after where its view of a card ended, not by time: an entry sharing the millisecond counts (#224)', () => {
    const h = (m: number, what: string, by: string) => ({ at: at(m), by, what })
    const before = cardOf({ column: 'review', agent: 'a1', history: [h(1, 'Moved to Review', 'B (alpha)'), h(2, 'Started reviewing', 'R (alpha)')], comments: [{ at: at(2), by: 'R (alpha)', text: 'looking' }] })
    const base = { mark: markOf(before), seen: seenOf(before), since: at(2) }
    const cond = { changes: ['verdict' as const, 'comment' as const, 'column' as const, 'agent' as const] }
    expect(changesSince(before, base, cond)).toEqual([])
    // The verdict and its comment land in the same millisecond as what was seen: still news.
    const same = { ...before, history: [...before.history, h(2, 'Review failed', 'R (alpha)')], comments: [...before.comments, { at: at(2), by: 'R (alpha)', text: 'Round 1: FAILED' }] }
    expect(changesSince(same, base, cond)).toEqual(['comment', 'verdict'])
    // Given to another agent, archived: against the starting mark.
    expect(changesSince({ ...before, agent: 'a2', history: [...before.history, h(2, 'Given to X', 'You')] }, base, cond)).toEqual(['agent'])
    expect(changesSince({ ...before, archived: true }, base, cond)).toBe('gone')
    // Out and back into Review: a move into it, seen by the entries after.
    const back = { ...before, history: [...before.history, h(3, 'Moved to Doing', 'B (alpha)'), h(3, 'Moved to Review', 'B (alpha)')] }
    expect(changesSince(back, base, { changes: ['column'], column: 'review', moveInto: true })).toEqual(['column'])
    // A history capped past the entry seen: what is newer than its time counts.
    expect(changesSince({ ...back, history: back.history.slice(-1) }, base, { changes: ['column'], column: 'review', moveInto: true })).toEqual(['column'])
  })

  it("the watcher's own comment isn't news; another's is (#1074: a builder's Review comment after it starts its watch)", () => {
    const h = (m: number, what: string, by: string) => ({ at: at(m), by, what })
    const doing = cardOf({ column: 'doing', agent: 'a1', history: [h(1, 'Moved to Doing', 'B (alpha)')], comments: [] })
    const base = { mark: markOf(doing), seen: seenOf(doing), since: at(1), watcher: 'B (alpha)' }
    const cond = { changes: ['verdict' as const, 'column' as const, 'comment' as const], column: 'passed' as const, moveInto: true as const }
    const sent = { ...doing, column: 'review' as const, history: [...doing.history, h(2, 'Moved to Review', 'B (alpha)')], comments: [{ at: at(2), by: 'B (alpha)', text: 'Round 1 ready' }] }
    expect(changesSince(sent, base, cond)).toEqual([])
    const asked = { ...sent, comments: [...sent.comments, { at: at(3), by: 'R (alpha)', text: 'Please commit' }] }
    expect(changesSince(asked, base, cond)).toEqual(['comment'])
    // Without a watcher (the Assistant's watches), every comment counts as before.
    expect(changesSince(sent, { ...base, watcher: undefined }, cond)).toEqual(['comment'])
  })

  it("the watcher's own moves aren't news; another's are (HI-2015: a builder's submission moving its card into Review woke its watch)", () => {
    const h = (m: number, what: string, by: string) => ({ at: at(m), by, what })
    const doing = cardOf({ column: 'doing', agent: 'a1', history: [h(1, 'Moved to Doing', 'B (alpha)')], comments: [] })
    const base = { mark: markOf(doing), seen: seenOf(doing), since: at(1), watcher: 'B (alpha)' }
    const anyMove = { changes: ['verdict' as const, 'column' as const, 'comment' as const] }
    const sent = { ...doing, column: 'review' as const, history: [...doing.history, h(2, 'Moved to Review', 'B (alpha)')] }
    expect(changesSince(sent, base, anyMove)).toEqual([])
    // Nor a move into the column it waits for, of its own.
    expect(changesSince(sent, base, { changes: ['column'], column: 'review', moveInto: true })).toEqual([])
    // Another's move counts: the reviewer's verdict sending it back, a move into Passed.
    const back = { ...sent, column: 'passed' as const, history: [...sent.history, h(3, 'Review passed', 'R (alpha)'), h(3, 'Moved to Passed', 'R (alpha)')] }
    expect(changesSince(back, base, anyMove)).toEqual(['column', 'verdict'])
    expect(changesSince(back, base, { changes: ['column'], column: 'passed', moveInto: true })).toEqual(['column'])
    // Without a watcher (the Assistant's watches), every move counts as before.
    expect(changesSince(sent, { ...base, watcher: undefined }, anyMove)).toEqual(['column'])
  })

  it('a watch on any move counts a card that left and came back by another, not by its own moves alone (HI-2143: HR2 on HI-2122)', () => {
    const h = (m: number, what: string, by: string) => ({ at: at(m), by, what })
    // HR2's watch begun in Review, before its pass.
    const review = cardOf({ column: 'review', agent: 'a1', history: [h(1, 'Moved to Review', 'B (alpha)'), h(2, 'Started reviewing', 'R (alpha)')] })
    const base = { mark: markOf(review), seen: seenOf(review), since: at(2), watcher: 'R (alpha)' }
    const anyMove = { changes: ['column' as const] }
    // Its pass, and the queue's return in its name: its own moves, no news.
    const returned = { ...review, column: 'doing' as const, history: [...review.history, h(3, 'Review passed', 'R (alpha)'), h(3, 'Moved to Passed', 'R (alpha)'), h(4, 'Moved to Doing', 'R (alpha)')] }
    expect(changesSince(returned, base, anyMove)).toEqual([])
    // Submitted again: in Review as when the watch began, but moved there by the builder.
    const again = { ...returned, column: 'review' as const, history: [...returned.history, h(5, 'Moved to Review', 'B (alpha)')] }
    expect(changesSince(again, base, anyMove)).toEqual(['column'])
    // Back where it was by its own moves only: still no news.
    const own = { ...review, history: [...review.history, h(3, 'Moved to Doing', 'R (alpha)'), h(4, 'Moved to Review', 'R (alpha)')] }
    expect(changesSince(own, base, anyMove)).toEqual([])
  })

  it("a reviewer's request and the user's decisions count for a watch that counts a verdict, a move or a comment; not for one waiting only for a column, nor the watcher's own (#1272, #912)", () => {
    const h = (m: number, what: string, by: string) => ({ at: at(m), by, what })
    const review = cardOf({ column: 'review', agent: 'a1', history: [h(1, 'Moved to Review', 'B (alpha)'), h(2, 'Started reviewing', 'R (alpha)')], comments: [{ at: at(1), by: 'B (alpha)', text: 'Round 1 ready' }] })
    const base = { mark: markOf(review), seen: seenOf(review), since: at(2), watcher: 'B (alpha)' }
    // #912's case: the builder's watch asked for its verdict and Passed only, not comments.
    const builder = { changes: ['verdict' as const, 'column' as const], column: 'passed' as const, moveInto: true as const }
    const asked = { ...review, history: [...review.history, h(3, 'Asked the builder: "Which commit?"', 'R (alpha)')], comments: [...review.comments, { at: at(3), by: 'R (alpha)', text: 'Which commit?' }] }
    expect(changesSince(asked, base, builder)).toEqual(['request'])
    // With comments counted too: the comment and the request, one wake.
    expect(changesSince(asked, base, { changes: ['verdict', 'column', 'comment'], column: 'passed', moveInto: true })).toEqual(['comment', 'request'])
    for (const what of ['Recorded a decision: "Keep it short"', 'Changed a decision to "Shorter" (was "Keep it short")', 'Removed a decision: "Shorter"']) {
      expect(changesSince({ ...review, history: [...review.history, h(3, what, 'You')] }, base, builder)).toEqual(['decision'])
      // Any of verdict, column or comment, and a watch on any change.
      expect(changesSince({ ...review, history: [...review.history, h(3, what, 'Assistant')] }, base, { changes: ['comment'] })).toEqual(['decision'])
      expect(changesSince({ ...review, history: [...review.history, h(3, what, 'Assistant')] }, base, { changes: [] })).toEqual(['decision'])
    }
    // A reviewer waiting only for the card to arrive in Review, and a watch on its agent only: neither counts them.
    const decided = { ...asked, history: [...asked.history, h(4, 'Recorded a decision: "Keep it short"', 'You')] }
    expect(changesSince(decided, { ...base, watcher: 'R (alpha)' }, { changes: ['column'], column: 'review' })).toEqual([])
    expect(changesSince(decided, base, { changes: ['agent'] })).toEqual([])
    // Its own request (the reviewer's watch after asking) and a decision it wrote down itself aren't news to it.
    expect(changesSince(asked, { ...base, watcher: 'R (alpha)' }, { changes: ['comment'] })).toEqual([])
    expect(changesSince({ ...review, history: [...review.history, h(3, 'Recorded a decision: "Keep it short"', 'B (alpha)')] }, base, builder)).toEqual([])
    // A wait that compares marks (a bounded wait) finds them by the history since it began.
    expect(handoffsSince(decided, at(2), builder)).toEqual(['request', 'decision'])
    expect(handoffsSince(decided, at(3), builder)).toEqual(['decision'])
    expect(handoffsSince(decided, at(2), { changes: ['column'], column: 'review' })).toEqual([])
    expect(handoffsSince(null, at(2), builder)).toEqual([])
    expect(hearsHandoffs({ changes: ['column'], column: 'passed', moveInto: true })).toBe(true)
    expect(hearsHandoffs({ changes: ['column'], column: 'review' })).toBe(false)
    // The wake line says so, with the request's words as the latest comment; the short form too.
    const line = wakeLine({ ...cardChange(7, decided, ['request', 'decision']), about: wakeAbout(decided, ['request', 'decision'], 'a1') })
    expect(line).toBe('[CW] #7 is in Review (its reviewer asks you something; a new decision from the user: read its decisions); latest comment by R (alpha): "Which commit?". Your card watch has ended: carry on (cw_read_task with latestComment for the comment in full).')
    expect(brief(cardChange(7, decided, ['request']))).toBe('#7 in Review, a request')
  })

  it('an entry exactly like the one seen (time, author, words) is still a new one; the one seen is never counted again (#224)', () => {
    const e = (what: string, id?: string) => ({ at: at(2), by: 'R (alpha)', what, ...(id ? { id } : {}) })
    const cond = { changes: ['verdict' as const, 'comment' as const] }
    // With ids (every entry written since #224).
    const seenCard = cardOf({ column: 'review', history: [e('Started reviewing', 'aaaa01'), e('Review failed', 'aaaa02')], comments: [{ at: at(2), by: 'R (alpha)', text: 'no', id: 'cccc01' }] })
    const base = { mark: markOf(seenCard), seen: seenOf(seenCard), since: at(2) }
    expect(changesSince(seenCard, base, cond)).toEqual([])
    const again = { ...seenCard, history: [...seenCard.history, e('Started reviewing', 'aaaa03'), e('Review failed', 'aaaa04')], comments: [...seenCard.comments, { at: at(2), by: 'R (alpha)', text: 'no', id: 'cccc02' }] }
    expect(changesSince(again, base, cond)).toEqual(['comment', 'verdict'])
    // The entry seen dropped from the front of a capped history: everything kept came after it.
    expect(changesSince({ ...again, history: again.history.slice(-1), comments: again.comments.slice(-1) }, base, cond)).toEqual(['comment', 'verdict'])
    // Entries from before ids: by their place.
    const old = cardOf({ column: 'review', history: [e('Started reviewing'), e('Review failed')], comments: [{ at: at(2), by: 'R (alpha)', text: 'no' }] })
    const oldBase = { mark: markOf(old), seen: seenOf(old), since: at(2) }
    expect(changesSince(old, oldBase, cond)).toEqual([])
    expect(changesSince({ ...old, history: [...old.history, e('Started reviewing'), e('Review failed')], comments: [...old.comments, { at: at(2), by: 'R (alpha)', text: 'no' }] }, oldBase, cond)).toEqual(['comment', 'verdict'])
  })

  it('after a wake, a card starts from what the wake told, past only what the agent did itself since (#224)', () => {
    const h = (m: number, what: string, by: string) => ({ at: at(m), by, what })
    const card = cardOf({ column: 'review', agent: 'a1', history: [h(1, 'Moved to Review', 'B (alpha)')], comments: [] })
    const told = { mark: markOf(card), seen: seenOf(card) }
    const cond = { changes: ['verdict' as const, 'comment' as const, 'column' as const, 'agent' as const] }
    const since = at(9)
    const from = (now: TaskCard, self = 'B (alpha)') => ({ mark: carriedOver(now, told, self), seen: told.seen, since, self })
    // The agent's own work since the wake (a comment, a move to Doing): not news.
    const own = { ...card, column: 'doing' as const, history: [...card.history, h(5, 'Moved to Doing', 'B (alpha)')], comments: [{ at: at(5), by: 'B (alpha)', text: 'fixing' }] }
    expect(changesSince(own, from(own), cond)).toEqual([])
    // Someone else's verdict, comment, reassignment or archiving since: news, whatever their times.
    const theirs = { ...card, agent: 'a2', history: [...card.history, h(1, 'Review failed', 'R (alpha)'), h(1, 'Given to Other', 'You')], comments: [{ at: at(1), by: 'R (alpha)', text: 'no' }] }
    expect(changesSince(theirs, from(theirs), cond)).toEqual(['comment', 'verdict', 'agent'])
    expect(changesSince({ ...card, archived: true }, from({ ...card, archived: true }), cond)).toBe('gone')
    // Mixed: another's comment and the agent's own after it: the comment kind is still news.
    const mixed = { ...card, comments: [{ at: at(3), by: 'R (alpha)', text: 'q' }, { at: at(4), by: 'B (alpha)', text: 'a' }] }
    expect(changesSince(mixed, from(mixed), cond)).toEqual(['comment'])
    // The agent's own changes after the watch began count, as they always have.
    const later = { ...card, comments: [{ at: at(10), by: 'B (alpha)', text: 'later' }] }
    expect(changesSince(later, from(later), cond)).toEqual(['comment'])
  })


  it('a failed card returned for review comes back into Review; its round and wake line say so (#214)', () => {
    const h = (m: number, what: string, by = 'Codex (hive)') => ({ at: at(m), by, what })
    const review = (history: TaskCard['history']) => cardOf({ column: 'review', agentName: 'Claudette', history })
    const failed = [h(1, 'Moved to Review', 'Claudette (hive)'), h(2, 'Started reviewing'), h(3, 'Review failed')]
    // Returnable after a failed review, with nothing since; its round counts the failures since the last pass.
    expect(returnRound(review(failed))).toBe(2)
    expect(returnRound(review([h(0, 'Review failed'), h(0, 'Review passed'), ...failed]))).toBe(2)
    expect(returnRound(review([...failed, h(4, 'Moved to Doing'), h(5, 'Moved to Review'), h(6, 'Review failed')]))).toBe(3)
    // Not after a pass, with none, once returned or reviewed again, under review, or out of Review.
    for (const history of [[h(1, 'Review passed')], [h(1, 'Moved to Review')], [...failed, h(4, 'Returned for review, round 2')], [...failed, h(4, 'Started reviewing')]]) expect(returnRound(review(history))).toBeNull()
    expect(returnRound({ ...review(failed), review: { agent: 'r', agentName: 'R', since: at(4) } })).toBeNull()
    expect(returnRound(cardOf({ column: 'doing', history: failed }))).toBeNull()
    // Returned counts as moving into Review (only Review), and starts a new round: the old failure isn't named.
    const returned = review([...failed, h(4, 'Returned for review, round 2', 'Claudette (hive)')])
    expect(movedIntoSince(returned, 'review', at(3))).toBe(true)
    expect(movedIntoSince(returned, 'review', at(5))).toBe(false)
    expect(movedIntoSince({ ...returned, column: 'doing' }, 'doing', at(3))).toBe(false)
    const line = (card: TaskCard, changes: Parameters<typeof wakeAbout>[1]) => wakeLine({ ...cardChange(7, card, changes), about: wakeAbout(card, changes, 'r1') })
    expect(line(returned, ['column'])).toMatch(/^\[CW\] #7 \(Claudette's card\) was returned for review \(round 2\)\. Your card watch has ended/)
    // Moved to Doing and back since: an ordinary arrival.
    expect(line(review([...returned.history, h(6, 'Moved to Doing'), h(7, 'Moved to Review')]), ['column'])).toMatch(/^\[CW\] #7 \(Claudette's card\) is in Review\. /)
    // A comment alone isn't the return.
    expect(line(returned, ['comment'])).toMatch(/is in Review/)
  })

  it('since: marks and time out and back; anything else refused', () => {
    const marks = new Map([
      [3, markOf(cardOf({ number: 3, agent: 'a-1:x', comments: [{ at: at(1), by: 'Y', text: 'hi' }] }))],
      [4, markOf(null)]
    ])
    const back = decodeSince(encodeSince(marks, 1234567))
    expect(back?.at).toBe(1234567)
    expect([...back!.marks]).toEqual([...marks])
    for (const bad of ['', 'nope', '@zz;x:review:0:0::0', '@1;3:sideways:0:0::0', '@1;3:review:0:0::2', 'x'.repeat(5000)]) expect(decodeSince(bad), bad).toBeNull()
  })

  it('a condition from arguments: cards, kinds, column; refused when wrong', () => {
    expect(readCondition({ cards: [3, 4] })).toEqual({ cards: [3, 4], changes: ['column', 'comment', 'verdict', 'agent'] })
    // A column alone: only arriving there counts (a comment while it is still in Doing doesn't).
    expect(readCondition({ cards: [3], column: 'review' })).toEqual({ cards: [3], changes: ['column'], column: 'review' })
    expect(readCondition({ cards: [3], column: 'review', changes: ['column'] })).toEqual({ cards: [3], changes: ['column'], column: 'review', moveInto: true })
    // Fresh (#434): only the next move into the column; it needs one.
    expect(readCondition({ cards: [3], column: 'review', fresh: true })).toEqual({ cards: [3], changes: ['column'], column: 'review', moveInto: true, fresh: true })
    expect(readCondition({ cards: [3], column: 'review', changes: ['column'], fresh: false })).toEqual({ cards: [3], changes: ['column'], column: 'review', moveInto: true })
    expect(readCondition({ cards: [3], fresh: true })).toMatch(/fresh needs a column/)
    expect(readCondition({ cards: [3], column: 'review', fresh: 'yes' })).toMatch(/fresh must be true or false/)
    // The builder's: a verdict, or a move into Done.
    expect(readCondition({ cards: [3], column: 'done', changes: ['verdict', 'column'] })).toEqual({ cards: [3], changes: ['verdict', 'column'], column: 'done', moveInto: true })
    expect(readCondition({ cards: [3], column: 'review', changes: ['comment'] })).toMatch(/must include "column"/)
    expect(readCondition({ cards: [] })).toMatch(/at least one/)
    expect(readCondition({ cards: [3, 3] })).toMatch(/no repeats/)
    expect(readCondition({ cards: ['x'] })).toMatch(/card numbers/)
    expect(readCondition({ cards: Array.from({ length: 21 }, (_, i) => i + 1) })).toMatch(/at most 20/)
    expect(readCondition({ cards: [1], changes: ['everything'] })).toMatch(/changes must be/)
    expect(readCondition({ cards: [1], column: 'archive' })).toMatch(/column must be/)
  })

  it("HI-2087: a card the merge queue returned: the line leads with the return and its reason, never the review's pass; alone or with others", () => {
    const c = cardOf({ column: 'doing', comments: [{ at: at(5), by: 'HR1 (hive)', text: 'Round 2: PASSED — no findings' }] })
    const back = '#7 came back from the merge queue: a conflict with main in src/main/bundledHistory.json. Merge main into your worktree, resolve the conflict, commit and submit again (cw_submit).'
    const returned = { ...cardChange(7, c, ['column']), about: { owner: null, verdict: null, queueReturn: back } }
    const line = wakeLine(returned)
    expect(line).toBe(`[CW] ${back.slice(0, -1)}. Your card watch has ended: carry on (cw_read_task with latestComment for the comment in full).`)
    expect(line).not.toMatch(/PASSED|latest comment by/)
    expect(Buffer.byteLength(JSON.stringify(line))).toBeLessThanOrEqual(WAKE_MAX_BYTES)
    // With another card: still its reason first.
    const other = cardChange(8, cardOf({ column: 'review' }), ['column'])
    expect(wakeLines([returned, other])).toMatch(/^\[CW\] #7 came back from the merge queue: a conflict with main in src\/main\/bundledHistory\.json[.;]/)
    // The queue's own wake (a loop wake's note, HB2's on HI-2046): the return first too, not the column and the pass.
    const passed = { ...cardChange(7, c, ['column']), about: { owner: null, verdict: { passed: true, by: 'HR1 (hive)' } } }
    const note = loopWakeLine(passed, 'note', back)
    expect(note).toBe(`[CW] ${back.slice(0, -1)}. This is your card in its loop: carry on (cw_read_task with latestComment for the comment in full).`)
    // Within the wake's bytes (HR3's round 1 finding 2), whatever the return carries: output in another script (three
    // bytes a character), paths with quotes and backslashes (escaped in JSON). The card, why and what to do stay whole.
    const failed = { entry: 'HI-7/e1', revision: 'a', target: 'main', reason: 'checks' as const, transient: false, check: 'typecheck', logPath: 'C:\\logs\\"quoted"\\check.log', log: `型エラー: "x" \\ y ${'型'.repeat(150)}\n`.repeat(20) }
    const big = returnedWake('HI-7', failed)
    for (const l of [wakeLine({ ...returned, about: { owner: null, verdict: null, queueReturn: big } }), loopWakeLine(passed, 'note', big)]) {
      expect(Buffer.byteLength(JSON.stringify(l))).toBeLessThanOrEqual(WAKE_MAX_BYTES)
      expect(l).not.toMatch(/\n/)
      expect(l).toMatch(/^\[CW\] HI-7 came back from the merge queue: the merge check typecheck failed on the merged result\. .*… Fix it in your worktree, commit and submit again \(cw_submit\)\. (Your card watch has ended|This is your card in its loop)/)
    }
    // Another note of Hive's (a stale pass) is quoted after where the card is, as before.
    expect(loopWakeLine(passed, 'note', '#7: its pass is stale')).toMatch(/^\[CW\] #7 is in Doing: HR1 \(hive\) passed it; latest comment by HR1 \(hive\): "Round 2: PASSED — no findings"\. Combwork: "#7: its pass is stale"/)
  })

  it("HI-2143: a card submitted again after the merge queue returned it: its reviewer's line leads with the return and the files resolved, never its own pass", () => {
    const c = cardOf({ column: 'review', agentName: 'HB1', comments: [{ at: at(5), by: 'HR2 (hive)', text: 'Pass: submission 38. No blocking findings.' }] })
    const hunk = (line: number) => ({ line, before: [], ours: ['a'], theirs: ['b'], after: [] })
    const conflict = { entry: 'HI-2122/e1', revision: 'a', target: '1.0.0', reason: 'conflict' as const, transient: false, files: ['src/main/projectAgents.ts', 'tests/providerDetect.test.ts'], conflicts: { oursIs: 'target' as const, files: [{ file: 'src/main/projectAgents.ts', hunks: [hunk(447)] }, { file: 'tests/providerDetect.test.ts', hunks: [hunk(78), hunk(89)] }] } }
    const again = resubmittedText('HI-2122', conflict as never, 'HB1')
    expect(again).toBe('HI-2122 is back in Review after the merge queue returned it (a conflict with 1.0.0 in src/main/projectAgents.ts (1 conflict, line 447), tests/providerDetect.test.ts (2 conflicts, lines 78 and 89)); HB1 resolved it and submitted it again: review the resolution')
    const change = { ...cardChange(7, c, ['column']), about: { ...wakeAbout(c, ['column'], 'r1'), resubmitted: again } }
    // Its own watch's line, and Hive's loop wake for it.
    expect(wakeLine(change)).toBe(`[CW] ${again}. Your card watch has ended: carry on (cw_read_task with latestComment for the comment in full).`)
    expect(loopWakeLine(change, 'review')).toBe(`[CW] ${again}. You review this card in its loop: carry on with it (cw_read_task with latestComment for the comment in full).`)
    expect(wakeLines([change, cardChange(8, cardOf({ number: 8, column: 'doing' }), ['column'])])).toMatch(/^\[CW\] HI-2122 is back in Review after the merge queue returned it \(a conflict with 1\.0\.0 in src\/main\/projectAgents\.ts/)
    // A merge check that failed: what changed, not a resolution; many files: within the line, one line.
    expect(resubmittedText('HI-9', { entry: 'e', revision: 'a', target: 'main', reason: 'checks', transient: false, check: 'typecheck' }, 'HB1')).toBe('HI-9 is back in Review after the merge queue returned it (the merge check typecheck failed on the merged result); HB1 changed it and submitted it again: review what changed')
    const many = resubmittedText('HI-9', { ...conflict, files: Array.from({ length: 40 }, (_, i) => `src/${'深'.repeat(30)}/f${i}.ts`), conflicts: undefined } as never, 'HB1')
    const l = loopWakeLine({ ...change, about: { ...change.about, resubmitted: many } }, 'review')
    expect(Buffer.byteLength(JSON.stringify(l))).toBeLessThanOrEqual(WAKE_MAX_BYTES)
    expect(l).not.toMatch(/\n/)
    expect(l).toMatch(/^\[CW\] HI-9 is back in Review after the merge queue returned it \(a conflict with 1\.0\.0 in .* and \d+ more\); HB1 resolved it/)
  })

  it('the wake line is one short line with the card, its column and the latest comment; the reply is lean', () => {
    const c = cardOf({ column: 'review', comments: [{ at: at(5), by: 'Codex (hive)', text: '\n  Review round 2: FAILED — two findings\n1. …' }] })
    const line = wakeLine(cardChange(7, c, ['column']), 1)
    expect(line).not.toMatch(/\n/)
    expect(line).toMatch(/^\[CW\] #7 is in Review; latest comment by Codex \(hive\): "Review round 2: FAILED — two findings" \(and 1 more watched card changed\)/)
    expect(wakeLine(cardChange(7, null, 'gone'))).toMatch(/#7 is gone from your board \(archived, deleted or moved to another project\)/)
    // Archived (one card, or a batch, #351): said so, and that only the user brings it back.
    expect(wakeLine(cardChange(7, cardOf({ archived: true }), 'gone'))).toMatch(/^\[CW\] #7 was archived \(off the board: only the user brings it back\)\. Your card watch has ended/)
    expect(taskWaitText({ changes: [{ number: 7, column: 'gone', changes: 'gone', by: null, comment: null, archived: true }] })).toBe('#7 was archived')
    expect(limitLine({ cards: [7, 8], changes: [] }, 120)).toMatch(/No change on #7, #8 in 2 h/)
    // HI-2295: a card in Review is said to be there; only the others ask the agent to tell the user.
    expect(limitLine({ cards: [7], changes: [] }, 30)).toBe('[CW] No change on #7 in 30 min: your card watch has ended. Tell the user (cw_notify) and ask what to do.')
    expect(limitLine({ cards: [7], changes: [] }, 30, [], [{ number: 7, state: 'reviewing', reviewer: 'CR1 (cli)' }])).toBe("[CW] No change on #7 in 30 min: your card watch has ended. #7 is in Review, being reviewed by CR1 (cli). Watch #7 again for its verdict (in a card loop, Combwork wakes you with it); don't tell the user about it.")
    expect(limitLine({ cards: [7], changes: [] }, 30, [], [{ number: 7, state: 'pool' }])).toMatch(/#7 is in Review, waiting for the reviewer pool to give it to a reviewer\. Watch #7 again/)
    expect(limitLine({ cards: [7], changes: [] }, 30, [], [{ number: 7, state: 'assigned', reviewer: 'CR2' }])).toMatch(/the reviewer pool gave it to CR2, who hasn't started yet\. Watch #7/)
    expect(limitLine({ cards: [7], changes: [] }, 30, [], [{ number: 7, state: 'review' }])).not.toMatch(/tell the user \(cw_notify\)/)
    // HI-2381: a card waiting on another agent's card in progress, and that card, are watched again quietly.
    expect(limitLine({ cards: [8, 10], changes: [] }, 30, [], [{ number: 10, state: 'waits', on: [8] }, { number: 8, state: 'working', reviewer: 'CB1 (cli)' }])).toBe("[CW] No change on #8, #10 in 30 min: your card watch has ended. #10 waits on #8; #8 is in Doing with CB1 (cli). Watch #10, #8 again: another agent's work is going on; don't tell the user about them.")
    expect(limitLine({ cards: [10, 11], changes: [] }, 30, [], [{ number: 10, state: 'waits', on: [8] }])).toMatch(/#10 waits on #8\. Watch #10 again: another agent's work is going on; don't tell the user about it; for the rest, tell the user \(cw_notify\) and ask what to do\.$/)
    // Mixed: the card in Review, and the rest told as before.
    expect(limitLine({ cards: [7, 8], changes: [] }, 30, [], [{ number: 7, state: 'pool' }])).toMatch(/don't tell the user about it; for the rest, tell the user \(cw_notify\) and ask what to do\.$/)
    // With a card that left the watch: dropped first, as before.
    expect(limitLine({ cards: [7, 8], changes: [] }, 30, [{ number: 9, why: 'done', detail: null }])).toMatch(/^\[CW\] #9 is in Done \(your watch on it ended\)\. No change on #7, #8 in 30 min: your card watch has ended\. Drop the first from your list; for the rest, tell the user \(cw_notify\) and ask what to do\.$/)
    expect(limitLine({ cards: [7], changes: [] }, 30, [{ number: 9, why: 'done', detail: null }], [{ number: 7, state: 'review' }])).toMatch(/Drop the first from your list; watch #7 again for its verdict \(in a card loop, Combwork wakes you with it\); don't tell the user about it\.$/)
    // Many cards with long names still fit, shortened.
    const many = Array.from({ length: 20 }, (_, i) => i + 100)
    const long = limitLine({ cards: many, changes: [] }, 30, [], many.map((number) => ({ number, state: 'reviewing' as const, reviewer: 'R'.repeat(60) })))
    expect(Buffer.byteLength(JSON.stringify(long))).toBeLessThanOrEqual(WAKE_MAX_BYTES)
    expect(long).toMatch(/are in Review\. Watch/)
    expect(watchLabel({ cards: [7], column: 'review' })).toBe('Waiting for #7 → Review')
    expect(taskWaitText({ watching: 'Waiting for #7 → Review', limitAt: 'x' })).toMatch(/End your turn now/)
    expect(taskWaitText({ timedOut: true, since: '@1;' })).toBe('No change.\nsince: @1;')
    expect(taskWaitText({ changes: [{ number: 7, column: 'review', changes: ['column'], by: 'B', comment: null }], since: 's' })).toBe('#7 is in Review (column, by B)\nsince: s')
  })

  it("the wake line says whose card it is when it's another agent's, the reviewer's verdict, and that Passed isn't merged (#143; Passed since #170)", () => {
    const passed = { at: at(6), by: 'Codex (hive)', what: 'Review passed' }
    const comment = [{ at: at(6), by: 'Codex (hive)', text: 'Round 3: PASSED' }]
    const line = (card: TaskCard | null, changes: Parameters<typeof wakeAbout>[1], watcher: string) => wakeLine({ ...cardChange(7, card, changes), about: wakeAbout(card, changes, watcher) })
    // Another agent's card (a dependency) moved to Passed: whose it is, who passed it, and that Passed isn't merged (Done is).
    const dep = cardOf({ agent: 'a1', agentName: 'Claude', column: 'passed', comments: comment, history: [{ at: at(1), by: 'Claude (hive)', what: 'Moved to Review' }, passed, { ...passed, what: 'Moved to Passed' }] })
    expect(line(dep, ['column'], 'a2')).toMatch(/^\[CW\] #7 \(Claude's card\) is in Passed: Codex \(hive\) passed it \(Passed isn't merged\); latest comment by Codex \(hive\): "Round 3: PASSED"\. Your card watch has ended/)
    // Moved to Passed by hand, with no review: no verdict to name, still not merged.
    expect(line(cardOf({ agent: 'a1', agentName: 'Claude', column: 'passed' }), ['column'], 'a2')).toMatch(/^\[CW\] #7 \(Claude's card\) is in Passed \(Passed isn't merged\)\. /)
    // The watcher's own card: short as before, with the verdict when that is what changed.
    expect(line(dep, ['verdict', 'column'], 'a1')).toMatch(/^\[CW\] #7 is in Passed: Codex \(hive\) passed it; latest comment/)
    const failed = cardOf({ agent: 'a1', column: 'review', history: [{ at: at(2), by: 'Codex (hive)', what: 'Review passed' }, { at: at(9), by: 'Codex (hive)', what: 'Review failed' }] })
    expect(line(failed, ['verdict'], 'a1')).toMatch(/^\[CW\] #7 is in Review: Codex \(hive\) failed it\. /)
    // A move with no verdict among the changes names none; a reviewer waiting for the builder's card hears whose it is.
    expect(line(cardOf({ agent: 'a1', agentName: 'Claude', column: 'review' }), ['column'], 'r1')).toMatch(/^\[CW\] #7 \(Claude's card\) is in Review\. /)
    expect(line(failed, ['column'], 'a1')).toMatch(/^\[CW\] #7 is in Review\. /)
    // A card without an agent, or gone: nothing about whose it is.
    expect(line(cardOf({ agent: null, column: 'passed' }), ['column'], 'a2')).toMatch(/^\[CW\] #7 is in Passed\. /)
    expect(line(null, 'gone', 'a2')).toMatch(/^\[CW\] #7 is gone from your board/)
    // Still one line, short.
    expect(line(dep, ['column'], 'a2')).not.toMatch(/\n/)
    expect(line(dep, ['column'], 'a2').length).toBeLessThan(260)
  })

  it('a verdict is named only for the round it belongs to: not after the card went back to work, was reviewed again or reassigned', () => {
    const line = (card: TaskCard, changes: Parameters<typeof wakeAbout>[1], watcher = 'a2') => wakeLine({ ...cardChange(7, card, changes), about: wakeAbout(card, changes, watcher) })
    const h = (m: number, what: string, by = 'Codex (hive)') => ({ at: at(m), by, what })
    const dep = (history: TaskCard['history']) => cardOf({ agent: 'a1', agentName: 'Claude', column: 'passed', history })
    // Passed, then moved to Passed in another call; and passed and moved in one call (same time): the pass is named.
    expect(line(dep([h(1, 'Moved to Review', 'Claude (hive)'), h(2, 'Review passed'), h(3, 'Moved to Passed', 'You')]), ['column'])).toMatch(/#7 \(Claude's card\) is in Passed: Codex \(hive\) passed it \(Passed isn't merged\)/)
    expect(line(dep([h(1, 'Moved to Review', 'Claude (hive)'), h(2, 'Review passed'), h(2, 'Moved to Passed')]), ['column'])).toMatch(/is in Passed: Codex \(hive\) passed it/)
    // Passed, reopened (back to Doing), more work, then moved to Passed by hand with no new review: no verdict is named.
    const reopened = dep([h(1, 'Moved to Review', 'Claude (hive)'), h(2, 'Review passed', 'Old reviewer (hive)'), h(3, 'Moved to Passed'), h(4, 'Moved to Doing', 'You'), h(5, 'Moved to Passed', 'You')])
    expect(line(reopened, ['column'])).toMatch(/^\[CW\] #7 \(Claude's card\) is in Passed \(Passed isn't merged\)\. /)
    expect(line(reopened, ['column'])).not.toMatch(/passed it/)
    // Reviewed again since (in Review once more), or given to another agent: the old verdict doesn't carry over.
    expect(line(dep([h(2, 'Review passed'), h(3, 'Moved to the top of Review', 'You'), h(4, 'Moved to Passed', 'You')]), ['column'])).not.toMatch(/passed it/)
    expect(line(dep([h(2, 'Review passed'), h(3, 'Given to Claude', 'You'), h(4, 'Moved to Passed', 'You')]), ['column'])).not.toMatch(/passed it/)
    // Passed and left in Review; another agent starts a new review (tasks.ts's "Started reviewing"), it stops, and the user
    // moves the card to Done: the old pass isn't named. A verdict from that new review is.
    const second = [h(1, 'Moved to Review', 'Claude (hive)'), h(2, 'Started reviewing', 'Old reviewer (hive)'), h(3, 'Review passed', 'Old reviewer (hive)'), h(4, 'Started reviewing', 'New reviewer (hive)'), h(5, 'Review by New reviewer stopped', 'You'), h(5, 'Moved to Passed', 'You')]
    expect(line(dep(second), ['column'])).toMatch(/is in Passed \(Passed isn't merged\)\. /)
    expect(line(dep(second), ['column'])).not.toMatch(/Old reviewer/)
    const secondPassed = [...second.slice(0, 4), h(6, 'Review passed', 'New reviewer (hive)'), h(6, 'Moved to Passed', 'New reviewer (hive)')]
    expect(line(dep(secondPassed), ['column'])).toMatch(/is in Passed: New reviewer \(hive\) passed it \(Passed isn't merged\)/)
    // Failed, then moved to Passed by hand: Passed names no pass, nor the failure.
    expect(line(dep([h(2, 'Review failed'), h(3, 'Moved to Passed', 'You')]), ['column'])).toMatch(/is in Passed \(Passed isn't merged\)\. /)
    // A verdict that is what changed is always named, on the watcher's own card too.
    expect(line(cardOf({ agent: 'a1', column: 'review', history: [h(2, 'Review failed')] }), ['verdict'], 'a1')).toMatch(/is in Review: Codex \(hive\) failed it/)
  })

  it('long or odd names never push out the card, its state or what to do: each name is cut, the comment gives way', () => {
    const bytes = (s: string) => Buffer.byteLength(JSON.stringify(s))
    const names = ['Builder ' + 'x'.repeat(1100), '建造者'.repeat(400), '🐝'.repeat(500), '  Spaced\n\tout   name  ' + ' '.repeat(50)]
    for (const name of names) {
      const card = cardOf({
        agent: 'a1', agentName: name, column: 'passed',
        comments: [{ at: at(6), by: name, text: `"Quoted" ${'評'.repeat(2000)}` }],
        history: [{ at: at(5), by: name, what: 'Review passed' }, { at: at(5), by: name, what: 'Moved to Passed' }]
      })
      const line = wakeLine({ ...cardChange(7, card, ['column']), about: wakeAbout(card, ['column'], 'a2') }, 2)
      // Within the saved limit as it is, so nothing is cut from the end.
      expect(bytes(line)).toBeLessThanOrEqual(WAKE_MAX_BYTES)
      expect(line).not.toMatch(/\n|\t/)
      expect(line).toMatch(/^\[CW\] #7 \(.{1,40}'s card\) is in Passed: .{1,40} passed it \(Passed isn't merged\); latest comment by .{1,40}: "/u)
      expect(line).toMatch(/…" \(and 2 more watched cards changed\)\. Your card watch has ended: carry on \(cw_read_task with latestComment for the comment in full\)\.$/)
    }
    // Whitespace in a name becomes single spaces, trimmed.
    const spaced = cardOf({ agent: 'a1', agentName: '  Spaced\n\tout   name  ', column: 'review' })
    expect(wakeLine({ ...cardChange(7, spaced, ['column']), about: wakeAbout(spaced, ['column'], 'a2') })).toMatch(/^\[CW\] #7 \(Spaced out name's card\) is in Review\. /)
    // A short comment is kept whole.
    const short = cardOf({ comments: [{ at: at(1), by: 'Codex (hive)', text: 'Round 1: PASSED' }] })
    expect(wakeLine(cardChange(7, short, ['comment']))).toContain('latest comment by Codex (hive): "Round 1: PASSED". ')
  })

  it("tells whether a history entry is within a view's boundary by which entry it is, not its time (#578)", () => {
    // Three entries in the same millisecond: a view that ended at the second had the first two, not the third.
    const t = at(1)
    const history = [
      { id: 'a00001', at: t, by: 'B1 (alpha)', what: 'Moved to Review' },
      { id: 'a00002', at: t, by: 'R1 (alpha)', what: 'Review failed' },
      { id: 'a00003', at: t, by: 'B1 (alpha)', what: 'Returned for review, round 2' }
    ]
    const seen = seenOf(cardOf({ history: history.slice(0, 2) })).h
    expect(entryWithin(history, history[0], seen)).toBe(true)
    expect(entryWithin(history, history[1], seen)).toBe(true)
    expect(entryWithin(history, history[2], seen)).toBe(false)
    // No view yet, or one whose entry is no longer kept: nothing shows it was seen.
    expect(entryWithin(history, history[0], null)).toBe(false)
    expect(entryWithin(history.slice(2), history[2], seen)).toBe(false)
    // An entry the list doesn't have.
    expect(entryWithin(history, { id: 'a00009', at: t, by: 'X', what: 'Other' }, seen)).toBe(false)
  })

  it('a watching agent prompted (a wake, or the user) works again; a tool ending while watching is work too', () => {
    const s = { status: 'watching' as const, askedAtStart: false, compacting: null, tasks: 0, attention: 'hooks' as const, reviewed: false, titleAsks: false, open: [], waitingOn: null, question: false, reviewing: false, safeguardPrompt: false, backgroundWakes: false }
    expect(hookStep({ kind: 'prompt' } as never, s).next).toBe('working')
    expect(hookStep({ kind: 'toolEnd', call: { tool: 'x' } } as never, s).next).toBe('working')
  })
})

describe('watches (main/watches.ts)', async () => {
  const base = tempDir('hive-watch-')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  afterAll(() => {
    closeAllBoards()
    rmSync(base, { recursive: true, force: true })
  })
  const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
  const tasks = await import('../src/main/tasks')
  const watches = await import('../src/main/watches')
  const writer = await import('../src/main/lineWriter')
  const deliveries = await import('../src/main/deliveries')
  const messages = await import('../src/main/agentMessages')
  // Typed at once here; the settle (changes landing together told together, #224) has tests of its own.
  watches.testHooks.settleMs = 0
  /**
   * Checks the watches and waits until what that started has finished (#570): a comment's board change can start a
   * delivery in the background, which evaluateWatches doesn't wait for (it skips a watch already delivering). So a check
   * after it reads the outcome, not a moment.
   */
  const evaluated = async (w: Parameters<typeof watches.evaluateWatches>[0]): Promise<void> => {
    await watches.evaluateWatches(w)
    await watches.settled()
  }
  /**
   * A card failed by its reviewer (`by`, as history names it) as before HI-1946, when a failed card stayed in Review for
   * its fixes: a card failed then may still be there (#214, #434). Today's verdict sends it back to Doing, so the card is
   * written as that rule left it, in one change: its review ended, "Review failed" in its history, still in Review.
   */
  const failedInReview = async (w: Parameters<typeof watches.evaluateWatches>[0], num: number, by: string): Promise<void> => {
    const doc = readCard(w, num)
    const when = new Date().toISOString()
    const history = [...(doc.history as unknown[]), { at: when, by, what: 'Review failed', whatText: { id: 'tasks.history.reviewFailed' }, id: `failed-${num}-${Date.now()}` }]
    const { review: _review, ...rest } = doc
    await writeCard(w, num, { ...rest, history, updatedAt: when })
  }
  const { sessions } = await import('../src/main/sessions')
  const { tableTestHooks: storeTestHooks } = await import('../src/main/storeTables')
  /** The watches a workspace has saved (#1018: rows in its database, what watches.json's `watches` held). */
  // oxlint-disable-next-line typescript/no-explicit-any -- saved entries read as JSON, as the file's were
  const savedOf = (path: string): any[] => storeDocs(path, 'watches')
  /** Saves a workspace's watches as Hive would have (what writing watches.json by hand was). */
  const putSaved = (path: string, list: unknown[], invalid?: unknown[]): Promise<void> => putStoreDocs(path, 'watches', list, invalid ? { meta: { invalid } } : {})
  const user = { kind: 'user' } as const
  let n = 0
  const open = async () => {
    const path = join(base, `ws-${++n}`)
    const alpha = join(path, 'alpha')
    mkdirSync(join(alpha, '.combwork'), { recursive: true })
    writeFileSync(join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Builder' }, { id: 'a2', name: 'Reviewer' }] }))
    const w = createWorkspaceService()
    await w.open(path)
    return { w, path, alpha }
  }
  /**
   * Stand-in sessions: an agent's status, whether the user is typing, what Hive typed, the prompts its CLI took, and what
   * it read (#650: it follows Hive's doorbell with cw_inbox, as a model does: a wake is received, and its watch ends,
   * once it is read).
   */
  const fake = (alpha: string) => {
    const state = { status: 'watching' as string, typing: false, typed: [] as string[], told: [] as string[], prompts: 0 }
    Object.assign(sessions, {
      liveFor: (p: string, id: string) => (p.toLowerCase() === alpha.toLowerCase() && id === 'a1' ? ({ projectPath: alpha, agentId: 'a1', status: state.status, runId: 'run-1', sessionId: 's1' } as never) : null),
      promptsTaken: (p: string, id: string) => (p.toLowerCase() === alpha.toLowerCase() && id === 'a1' ? { runId: 'run-1', count: state.prompts } : null),
      userMayBeTyping: () => state.typing,
      sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
        guard?.()
        state.typed.push(text)
        state.prompts++
        state.status = 'working'
        state.told.push(await follow(alpha, 'a1', text))
      },
      watchChanged: () => undefined
    })
    return state
  }

  it("a watch's wake with a message waiting, whose offer is saved slowly while the user's own prompt is taken: one line, the message first; its confirmation counts from this line's Enter (#647, #649)", async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const cli = { count: 0, enters: 0 }
    let release = (): void => undefined
    const held = new Promise<void>((r) => (release = r))
    let waiting = false
    let saves = 0
    let holdAt = -1
    Object.assign(sessions, {
      promptsTaken: () => ({ runId: 'run-1', count: cli.count }),
      lineNotTaken: () => undefined,
      sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
        guard?.()
        st.typed.push(text)
        st.status = 'finished'
      },
      submitAgain: () => {
        cli.enters++
        cli.count++
        st.status = 'working'
        return true
      }
    })
    // The offer's save (its deliveries saved as offered, before the first key) is held while the user's prompt is taken.
    deliveries.setBeforeSaveForTests(async () => {
      if (++saves !== holdAt) return
      waiting = true
      await held
    })
    writer.testHooks.takeMs = 150
    try {
      const c = await inWorkspace(w, () => tasks.createTask({ title: 'Slow offer', project: 'alpha' }, user))
      await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
      // A message left while it works waits for its next line.
      st.status = 'working'
      expect((await messages.leaveMessage(alpha, 'a1', 'Builder', { kind: 'hive', name: 'Hive' }, 'hello')).fate).toBe('queued')
      st.status = 'watching'
      // The saves from here: the wake handed over (1), then the offer of the message and the wake together (2), held.
      holdAt = saves + 2
      await inWorkspace(w, () => tasks.commentTask(c.number, 'news', user))
      // The evaluation types the wake, so it waits for the held save: not awaited until that is released.
      const evaluating = evaluated(w)
      await vi.waitFor(() => expect(waiting).toBe(true), { timeout: HUNG_MS })
      cli.count++
      release()
      await evaluating
      await vi.waitFor(() => expect(st.typed).toHaveLength(1), { timeout: HUNG_MS })
      expect(st.typed[0]).toMatch(/^\[CW\] New in your inbox: 1 message and 1 card event \(#\d+\) \(m1, m2\)\. /)
      // Counted from just before its Enter (the user's prompt already in), so its lost Enter is pressed again; taken
      // then, the agent reads both (#650: received then, not when taken), the message first, and the watch ends.
      await vi.waitFor(() => expect(cli.enters).toBe(1), { timeout: HUNG_MS })
      await vi.waitFor(() => expect(writer.confirmsInFlight()).toBe(0), { timeout: HUNG_MS })
      expect(toldOf((await deliveries.readInbox(alpha, 'a1')).items)).toMatch(/^hello \[CW\] #\d+ /)
      await watches.settled()
      expect((await deliveries.deliveriesOf(alpha, 'a1')).map((r) => `${r.id} ${r.state} ${r.receivedVia ?? ''}`)).toEqual(['m1 received inbox', 'm2 received inbox'])
      expect(watches.watchFor(alpha, 'a1')).toBeNull()
    } finally {
      release()
      deliveries.setBeforeSaveForTests(null)
      writer.testHooks.takeMs = undefined
      for (const k of ['promptsTaken', 'submitAgain', 'lineNotTaken']) delete (sessions as unknown as Record<string, unknown>)[k]
    }
    await disposeWorkspaceService(w)
  })

  it("a typed wake the CLI doesn't take (#376) gets Enter again, once; one it takes gets nothing more", async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    // The CLI's prompt count: a stand-in that takes the line only when told to (as Codex dropped an Enter on 7 Oct).
    const cli = { count: 0, takeOnType: false, takeOnEnter: true, enters: 0 }
    // A line still not taken is marked (#430), and nothing more is typed into it while it is.
    const marks: string[] = []
    let untaken = false
    Object.assign(sessions, {
      lineNotTaken: (_p: string, _id: string, runId: string, text: string) => {
        expect(runId).toBe('run-1')
        marks.push(text)
      },
      lineWaiting: () => untaken,
      promptsTaken: () => ({ runId: 'run-1', count: cli.count }),
      sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
        guard?.()
        st.typed.push(text)
        if (cli.takeOnType) {
          cli.count++
          st.status = 'working'
        } else st.status = 'finished'
      },
      submitAgain: (_p: string, _id: string, runId: string) => {
        expect(runId).toBe('run-1')
        cli.enters++
        if (cli.takeOnEnter) {
          cli.count++
          st.status = 'working'
        }
        return true
      }
    })
    writer.testHooks.takeMs = 150
    try {
      const c = await inWorkspace(w, () => tasks.createTask({ title: 'Dropped Enter', project: 'alpha' }, user))
      await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
      await inWorkspace(w, () => tasks.commentTask(c.number, 'news', user))
      await evaluated(w)
      // Typed by this evaluation, or by one the comment started meanwhile (which this one then leaves to it).
      await vi.waitFor(() => expect(st.typed).toHaveLength(1), { timeout: HUNG_MS })
      // Not taken: Enter once more after the wait, and it is taken then.
      await vi.waitFor(() => expect(cli.enters).toBe(1), { timeout: HUNG_MS })
      // Taken then: no Enter after its check has ended.
      await vi.waitFor(() => expect(writer.confirmsInFlight()).toBe(0), { timeout: HUNG_MS })
      expect(cli.enters).toBe(1)
      // Never taken: Enter once more only, never a third time.
      cli.takeOnEnter = false
      st.status = 'watching'
      await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
      await inWorkspace(w, () => tasks.commentTask(c.number, 'more news', user))
      await evaluated(w)
      await vi.waitFor(() => expect(cli.enters).toBe(2), { timeout: HUNG_MS })
      await vi.waitFor(() => expect(writer.confirmsInFlight()).toBe(0), { timeout: HUNG_MS })
      expect(cli.enters).toBe(2)
      // Still not taken: marked once, with the line (#430); the next wake waits while it is, then goes in.
      expect(marks).toHaveLength(1)
      expect(marks[0]).toMatch(/^\[CW\] New in your inbox: 1 card event \(#\d+\) \(m\d+\)\. Call cw_inbox to read it\.$/)
      untaken = true
      st.status = 'watching'
      await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
      await inWorkspace(w, () => tasks.commentTask(c.number, 'while marked', user))
      await evaluated(w)
      await watches.tick()
      expect(st.typed).toHaveLength(2)
      cli.takeOnType = true
      untaken = false
      await watches.tick()
      await vi.waitFor(() => expect(st.typed).toHaveLength(3), { timeout: HUNG_MS })
      // Taken as typed: no Enter again.
      st.status = 'watching'
      await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
      await inWorkspace(w, () => tasks.commentTask(c.number, 'last news', user))
      await evaluated(w)
      await vi.waitFor(() => expect(st.typed).toHaveLength(4), { timeout: HUNG_MS })
      expect(marks).toHaveLength(1)
      await vi.waitFor(() => expect(writer.confirmsInFlight()).toBe(0), { timeout: HUNG_MS })
      expect(cli.enters).toBe(2)
    } finally {
      writer.testHooks.takeMs = undefined
      delete (sessions as unknown as Record<string, unknown>).promptsTaken
      delete (sessions as unknown as Record<string, unknown>).submitAgain
      delete (sessions as unknown as Record<string, unknown>).lineNotTaken
      delete (sessions as unknown as Record<string, unknown>).lineWaiting
    }
    await disposeWorkspaceService(w)
  })

  it("settled() waits for a wake's line while the delivery service types it, and for its receipt (#570, #649)", async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    let release = (): void => undefined
    const held = new Promise<void>((r) => (release = r))
    let sending = false
    Object.assign(sessions, {
      sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
        guard?.()
        sending = true
        await held
        st.typed.push(text)
        st.prompts++
        st.status = 'working'
        st.told.push(await follow(alpha, 'a1', text))
      }
    })
    try {
      const c = await inWorkspace(w, () => tasks.createTask({ title: 'Held', project: 'alpha' }, user))
      await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
      await inWorkspace(w, () => tasks.commentTask(c.number, 'news', user))
      const evaluating = watches.evaluateWatches(w)
      await vi.waitFor(() => expect(sending).toBe(true), { timeout: HUNG_MS })
      let done = false
      const settling = watches.settled().then(() => (done = true))
      // Being typed (its send held): in flight, so settled() can't have resolved.
      expect(watches.inFlightNow()).toBe(true)
      expect(done).toBe(false)
      release()
      await evaluating
      await settling
      // Resolved only once it was typed, taken, read (received) and the watch had ended.
      expect(st.typed).toHaveLength(1)
      expect(watches.watchFor(alpha, 'a1')).toBeNull()
      expect(writer.confirmsInFlight()).toBe(0)
    } finally {
      release()
      await watches.settled()
      await disposeWorkspaceService(w)
    }
  })

  it("a watch's label names its card by key, read outside any request too (HI-1688)", async () => {
    const path = join(base, `ws-${++n}`)
    for (const p of ['alpha', 'beta']) {
      mkdirSync(join(path, p, '.combwork'), { recursive: true })
      writeFileSync(join(path, p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Builder' }] }))
    }
    const w = createWorkspaceService()
    await w.open(path)
    const { keyProjects } = await import('../src/main/projectKeys')
    await inWorkspace(w, () => keyProjects(w))
    const alpha = join(path, 'alpha')
    fake(alpha)
    const mine = await inWorkspace(w, () => tasks.createTask({ title: 'Mine', project: 'alpha' }, user))
    expect(mine.key).toMatch(/^[A-Z]{2,4}-\d+$/)
    const r = await watches.registerWatch(w, alpha, 'a1', { cards: [mine.number], changes: ['column'], column: 'review' })
    const label = `Waiting for ${mine.key} → Review`
    expect(r).toMatchObject({ watching: { label } })
    // As the Agent API's status, the project list and the inbox's offer line read it: outside any request, no names of
    // their own (before HI-1688 it said "#N" there).
    expect(watches.watchFor(alpha, 'a1')?.label).toBe(label)
    await watches.settled()
    await disposeWorkspaceService(w)
  })

  it('fires once when a watched card changes, waking an idle agent; a column already reached answers at once', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    const r = await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    expect(r).toMatchObject({ watching: { label: `Waiting for #${c.number}` } })
    expect(watches.watchFor(alpha, 'a1')?.cards).toEqual([c.number])
    // Something that doesn't count: nothing.
    await inWorkspace(w, () => tasks.updateTask(c.number, { column: 'doing' }, user))
    await evaluated(w)
    expect(st.typed).toEqual([])
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Round 1: FAILED\nDetails', { kind: 'agent', name: 'Codex (hive)' }))
    await evaluated(w)
    expect(st.typed).toHaveLength(1)
    expect(st.told[0]).toMatch(new RegExp(`^\\[CW\\] #${c.number} is in Doing; latest comment by Codex \\(hive\\): "Round 1: FAILED"`))
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    // Once: another change wakes nothing.
    await inWorkspace(w, () => tasks.commentTask(c.number, 'again', user))
    await evaluated(w)
    expect(st.typed).toHaveLength(1)
    // Already in the column asked for: answered at once, no watch.
    const r2 = await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['column'], column: 'doing' })
    expect(r2).toMatchObject({ already: { number: c.number, column: 'doing' } })
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    await disposeWorkspaceService(w)
  })

  it('started from a card as an intent left it (#1639): a change made before the watch was in place fires it', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha', agent: 'a1', column: 'review' }, user))
    // The card as the builder's submission left it, and then the reviewer's verdict before Hive armed the watch.
    const submitted = await inWorkspace(w, () => tasks.getTask(c.number, w))
    await inWorkspace(w, () => tasks.updateTask(c.number, { column: 'doing' }, { kind: 'agent', name: 'Reviewer (alpha)' }, { comment: 'Round 1: FAILED\n1. Add a test.' }))
    const cond = (): WatchCondition => ({ cards: [c.number], changes: ['verdict', 'column', 'comment'], column: 'passed', moveInto: true })
    const r = await watches.registerWatch(w, alpha, 'a1', cond(), 360, { card: submitted, at: submitted.updatedAt })
    expect(r).toMatchObject({ watching: { label: expect.any(String) } })
    await evaluated(w)
    expect(st.typed).toHaveLength(1)
    expect(st.told[0]).toMatch(new RegExp(`^\\[CW\\] #${c.number} is in Doing; latest comment by Reviewer \\(alpha\\): "Round 1: FAILED"`))
    // Without it, the same watch starts from the card as it is now: nothing to tell.
    await watches.registerWatch(w, alpha, 'a1', cond(), 360)
    await evaluated(w)
    expect(st.typed).toHaveLength(1)
    await watches.cancelWatch(w, alpha, 'a1')
    await disposeWorkspaceService(w)
  })

  it("started from the watcher's own last change to the card in its launch (HI-2302): a reply between its question and its watch fires it", async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    // a1 reviews here; its launch began before the card's story.
    const live = sessions.liveFor
    let launched = new Date(Date.now() - 60_000).toISOString()
    Object.assign(sessions, { liveFor: (p: string, id: string) => (live(p, id) ? ({ ...live(p, id), startedAt: launched } as never) : null) })
    const asker = { kind: 'agent', name: 'Builder (alpha)' } as const
    const other = { kind: 'agent', name: 'Reviewer (alpha)' } as const
    const cond = (): WatchCondition => ({ cards: [c.number], changes: ['comment', 'column'] })
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha', agent: 'a2', column: 'review' }, user))
    // PE-39: the question, the answer, and only then the watch.
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Please attach the logs.', asker))
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Logs attached.', other))
    await watches.registerWatch(w, alpha, 'a1', cond())
    await evaluated(w)
    expect(st.typed).toHaveLength(1)
    expect(st.told[0]).toContain('latest comment by Reviewer (alpha): "Logs attached."')
    // The answer after the watch began fires it, as before.
    st.status = 'watching'
    await inWorkspace(w, () => tasks.commentTask(c.number, 'And the screenshots?', asker))
    await watches.registerWatch(w, alpha, 'a1', cond())
    await evaluated(w)
    expect(st.typed).toHaveLength(1)
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Attached too.', other))
    await evaluated(w)
    expect(st.typed).toHaveLength(2)
    expect(st.told[1]).toContain('latest comment by Reviewer (alpha): "Attached too."')
    // Its own change from before its launch doesn't reach back (a card no wake told it of): the watch starts from now.
    st.status = 'watching'
    const d = await inWorkspace(w, () => tasks.createTask({ title: 'B', project: 'alpha', agent: 'a2', column: 'review' }, user))
    await inWorkspace(w, () => tasks.commentTask(d.number, 'A question from an earlier launch.', asker))
    await inWorkspace(w, () => tasks.commentTask(d.number, 'An answer from before this launch.', other))
    launched = new Date(Date.now() + 1000).toISOString()
    await watches.registerWatch(w, alpha, 'a1', { cards: [d.number], changes: ['comment', 'column'] })
    await evaluated(w)
    expect(st.typed).toHaveLength(2)
    await watches.cancelWatch(w, alpha, 'a1')
    Object.assign(sessions, { liveFor: live })
    await disposeWorkspaceService(w)
  })

  it("started from the watcher's own last change, a reassignment by someone else after it still counts (HI-2302, HR1's round 1 finding)", async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const live = sessions.liveFor
    const launched = new Date(Date.now() - 60_000).toISOString()
    Object.assign(sessions, { liveFor: (p: string, id: string) => (live(p, id) ? ({ ...live(p, id), startedAt: launched } as never) : null) })
    const asker = { kind: 'agent', name: 'Builder (alpha)' } as const
    const other = { kind: 'agent', name: 'Reviewer (alpha)' } as const
    const agentWatch = (card: number): WatchCondition => ({ cards: [card], changes: ['agent'] })
    // No wake told it of the card: its own comment, then the user takes the card from a2, then the watch.
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha', agent: 'a2', column: 'review' }, user))
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Please attach the logs.', asker))
    await inWorkspace(w, () => tasks.updateTask(c.number, { agent: null }, user))
    await watches.registerWatch(w, alpha, 'a1', agentWatch(c.number))
    await evaluated(w)
    expect(st.typed).toHaveLength(1)
    // After a wake that told it of the card (a2's): its own comment, a reassignment, then the watch.
    st.status = 'watching'
    const d = await inWorkspace(w, () => tasks.createTask({ title: 'B', project: 'alpha', agent: 'a2', column: 'review' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [d.number], changes: ['comment'] })
    await inWorkspace(w, () => tasks.commentTask(d.number, 'Ready.', other))
    await evaluated(w)
    expect(st.typed).toHaveLength(2)
    st.status = 'watching'
    await inWorkspace(w, () => tasks.commentTask(d.number, 'Please attach the logs.', asker))
    await inWorkspace(w, () => tasks.updateTask(d.number, { agent: null }, user))
    await watches.registerWatch(w, alpha, 'a1', agentWatch(d.number))
    await evaluated(w)
    expect(st.typed).toHaveLength(3)
    // Its own change after the reassignment: nothing new since, so nothing fires.
    st.status = 'watching'
    const e = await inWorkspace(w, () => tasks.createTask({ title: 'C', project: 'alpha', agent: 'a2', column: 'review' }, user))
    await inWorkspace(w, () => tasks.updateTask(e.number, { agent: null }, user))
    await inWorkspace(w, () => tasks.commentTask(e.number, 'Noted.', asker))
    await watches.registerWatch(w, alpha, 'a1', agentWatch(e.number))
    await evaluated(w)
    expect(st.typed).toHaveLength(3)
    // HI-2315: the same, both in one millisecond (a loaded machine wrote them back to back): the card's later change is
    // still told apart, so nothing fires.
    st.status = 'watching'
    const f = await inWorkspace(w, () => tasks.createTask({ title: 'D', project: 'alpha', agent: 'a2', column: 'review' }, user))
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
    try {
      await inWorkspace(w, () => tasks.updateTask(f.number, { agent: null }, user))
      await inWorkspace(w, () => tasks.commentTask(f.number, 'Noted.', asker))
    } finally {
      vi.useRealTimers()
    }
    await watches.registerWatch(w, alpha, 'a1', agentWatch(f.number))
    await evaluated(w)
    expect(st.typed).toHaveLength(3)
    await watches.cancelWatch(w, alpha, 'a1')
    Object.assign(sessions, { liveFor: live })
    await disposeWorkspaceService(w)
  })

  it("a verdict, move and comment in one call are saved together: the builder's wake names the reviewer's comment (#138)", async () => {
    const { onHiveEvent } = await import('../src/main/events')
    const { w, alpha } = await open()
    const st = fake(alpha)
    const reviewer = { kind: 'agent', name: 'Reviewer (alpha)', self: { project: 'alpha', agentId: 'a2' }, scope: 'alpha' } as const
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha', agent: 'a1', column: 'review' }, user))
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Ready for review (round 1)', { kind: 'agent', name: 'Builder (alpha)' }))
    await inWorkspace(w, () => tasks.updateTask(c.number, { review: 'start' }, reviewer))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['verdict', 'column'], column: 'done' })
    // What anything reading the card sees the moment a change is announced (a watch waking its agent reads it then).
    const seen: { column: string; latest: string | undefined }[] = []
    const off = onHiveEvent((e) => {
      if (e.type !== 'tasks-changed') return
      const card = readCard(w, c.number) as unknown as TaskCard
      seen.push({ column: card.column, latest: card.comments.at(-1)?.text })
    })
    const said: string[] = []
    await inWorkspace(w, () => tasks.updateTask(c.number, { review: 'passed', column: 'done' }, reviewer, { said, comment: 'Passed review, round 1.' }))
    off()
    // Before, the move was saved and announced, then the comment: the first announcement showed Done with the builder's comment.
    expect(seen).toEqual([{ column: 'done', latest: 'Passed review, round 1.' }])
    expect(said).toEqual(['Review passed', 'Moved to Done'])
    await evaluated(w)
    expect(st.typed).toHaveLength(1)
    // The builder's own card: no owner, but the reviewer's verdict.
    expect(st.told[0]).toContain(`#${c.number} is in Done: Reviewer (alpha) passed it; latest comment by Reviewer (alpha): "Passed review, round 1."`)
    // A comment that can't be saved stops the whole change: nothing moves without it.
    const d = await inWorkspace(w, () => tasks.createTask({ title: 'B', project: 'alpha', column: 'review' }, user))
    await expect(inWorkspace(w, () => tasks.updateTask(d.number, { column: 'done' }, user, { comment: '   ' }))).rejects.toThrow('The comment is empty.')
    expect((await inWorkspace(w, () => tasks.getTask(d.number))).column).toBe('review')
    await disposeWorkspaceService(w)
  })

  it('not typed while the agent works or the user types: kept, fired, and typed when it can be', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    st.status = 'working'
    await inWorkspace(w, () => tasks.commentTask(c.number, 'x', user))
    await evaluated(w)
    expect(st.typed).toEqual([])
    expect(watches.watchFor(alpha, 'a1')).not.toBeNull()
    st.status = 'watching'
    st.typing = true
    await watches.tick()
    expect(st.typed).toEqual([])
    st.typing = false
    await watches.tick()
    expect(st.typed).toHaveLength(1)
    await disposeWorkspaceService(w)
  })

  it("its limit on a card in Review says it is there and who reviews it, with no 'tell the user' (HI-2295)", async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha', agent: 'a1' }, user))
    const doc = readCard(w, c.number)
    await writeCard(w, c.number, { ...doc, column: 'review', updatedAt: new Date().toISOString() })
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['verdict'] }, 30)
    await watches.tick(Date.now() + 31 * 60_000)
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.told[0]).toMatch(/No change on #\d+ in 30 min: your card watch has ended\. #\d+ is in Review, waiting for its reviewer\. Watch #\d+ again for its verdict/)
    expect(st.told[0]).not.toMatch(/tell the user \(cw_notify\)/)
    // Being reviewed: named.
    await writeCard(w, c.number, { ...readCard(w, c.number), review: { agent: 'a2', agentName: 'Reviewer', since: new Date().toISOString() }, updatedAt: new Date().toISOString() })
    st.status = 'watching'
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['verdict'] }, 30)
    await watches.tick(Date.now() + 31 * 60_000)
    await vi.waitFor(() => expect(st.told).toHaveLength(2), { timeout: HUNG_MS })
    expect(st.told[1]).toMatch(/#\d+ is in Review, being reviewed by Reviewer\./)
    expect(st.told[1]).not.toMatch(/tell the user \(cw_notify\)/)
    // Back in Doing: the line as before.
    await writeCard(w, c.number, { ...readCard(w, c.number), column: 'doing', review: undefined, updatedAt: new Date().toISOString() })
    st.status = 'watching'
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['verdict'] }, 30)
    await watches.tick(Date.now() + 31 * 60_000)
    await vi.waitFor(() => expect(st.told).toHaveLength(3), { timeout: HUNG_MS })
    expect(st.told[2]).toMatch(/your card watch has ended\. Tell the user \(cw_notify\) and ask what to do\.$/)
    await disposeWorkspaceService(w)
  })

  it('a limit that fired while the agent was busy is told as its card is when handed over: moved to Review, reviewed, sent back (HI-2295)', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha', agent: 'a1' }, user))
    const put = (over: Record<string, unknown>) => writeCard(w, c.number, { ...readCard(w, c.number), ...over, updatedAt: new Date().toISOString() })
    // Doing → Review while the line is held: told in Review.
    await put({ column: 'doing' })
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['verdict'] }, 30)
    st.status = 'working'
    await watches.tick(Date.now() + 31 * 60_000)
    expect(st.typed).toEqual([])
    await put({ column: 'review' })
    st.status = 'watching'
    await watches.tick(Date.now() + 31 * 60_000)
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.told[0]).toMatch(/#\d+ is in Review, waiting for its reviewer\. Watch #\d+ again for its verdict/)
    expect(st.told[0]).not.toMatch(/tell the user \(cw_notify\)/)
    // A reviewer starts while the line is held: named.
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['verdict'] }, 30)
    st.status = 'working'
    await watches.tick(Date.now() + 31 * 60_000)
    await put({ review: { agent: 'a2', agentName: 'Reviewer', since: new Date().toISOString() } })
    st.status = 'watching'
    await watches.tick(Date.now() + 31 * 60_000)
    await vi.waitFor(() => expect(st.told).toHaveLength(2), { timeout: HUNG_MS })
    expect(st.told[1]).toMatch(/#\d+ is in Review, being reviewed by Reviewer\./)
    // Review → Doing while the line is held: the line as before, no stale Review.
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['verdict'] }, 30)
    st.status = 'working'
    await watches.tick(Date.now() + 31 * 60_000)
    await put({ column: 'doing', review: undefined })
    st.status = 'watching'
    await watches.tick(Date.now() + 31 * 60_000)
    await vi.waitFor(() => expect(st.told).toHaveLength(3), { timeout: HUNG_MS })
    expect(st.told[2]).toMatch(/your card watch has ended\. Tell the user \(cw_notify\) and ask what to do\.$/)
    expect(st.told[2]).not.toMatch(/in Review/)
    await disposeWorkspaceService(w)
  })

  it('its limit with no change wakes it to say so; cancel ends it; it is kept on disk and read back', async () => {
    const { w, path, alpha } = await open()
    const st = fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['verdict'] }, 30)
    expect(savedOf(path)[0]).toMatchObject({ agentId: 'a1', limitMinutes: 30, cond: { cards: [c.number], changes: ['verdict'] } })
    // Read back after the workspace's watches are forgotten (Hive restarted): the same watch.
    watches.forgetWatches(w)
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    await vi.waitFor(() => expect(watches.watchFor(alpha, 'a1')?.cards).toEqual([c.number]), { timeout: HUNG_MS })
    await watches.tick(Date.now() + 29 * 60_000)
    expect(st.typed).toEqual([])
    await watches.tick(Date.now() + 31 * 60_000)
    expect(st.typed).toHaveLength(1)
    expect(st.told[0]).toMatch(/No change on #\d+ in 30 min/)
    // Cancel.
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['verdict'] })
    expect(await watches.cancelWatch(w, alpha, 'a1')).toBe(true)
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    expect(await watches.cancelWatch(w, alpha, 'a1')).toBe(false)
    await disposeWorkspaceService(w)
  })

  it('a move into a column fires when the card leaves and comes back, also between two looks', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha', column: 'review' }, user))
    // Already in Review: only a fresh move into it waits (#434).
    const r = await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['column'], column: 'review', moveInto: true, fresh: true })
    expect('watching' in r).toBe(true)
    await new Promise((res) => setTimeout(res, 5))
    await inWorkspace(w, () => tasks.updateTask(c.number, { column: 'doing' }, user))
    await inWorkspace(w, () => tasks.updateTask(c.number, { column: 'review' }, user))
    await evaluated(w)
    expect(st.typed).toHaveLength(1)
    expect(st.told[0]).toMatch(/is in Review/)
    await disposeWorkspaceService(w)
  })
  it('a watch for a move into a column the card is already in answers at once, for anyone and after a failed review; one for a card elsewhere waits (#434)', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const passed = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha', agent: 'a1', column: 'passed' }, user))
    const inReview = await inWorkspace(w, () => tasks.createTask({ title: 'B', project: 'alpha', agent: 'a1', column: 'review' }, user))
    const verdictOrPassed = { changes: ['verdict' as const, 'column' as const], column: 'passed' as const, moveInto: true as const }
    const r = await watches.registerWatch(w, alpha, 'a1', { cards: [passed.number], ...verdictOrPassed })
    expect(r).toEqual({ already: expect.objectContaining({ number: passed.number, column: 'passed', changes: ['column'] }) })
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    // A card in Review after a failed review (one failed before HI-1946, still there): "→ Review" holds, whoever asks (its
    // reviewer, the card's own agent, the Assistant) and whatever its history.
    const failed = await inWorkspace(w, () => tasks.createTask({ title: 'C', project: 'alpha', agent: 'a2', column: 'review' }, user))
    const rev = { kind: 'agent', name: 'R (alpha)', self: { project: 'alpha', agentId: 'a1' }, scope: 'alpha' } as const
    await inWorkspace(w, () => tasks.updateTask(failed.number, { review: 'start' }, rev))
    const intoReview = { cards: [failed.number], changes: ['column' as const], column: 'review' as const, moveInto: true as const }
    // Its reviewer, mid-review.
    expect(await watches.registerWatch(w, alpha, 'a1', intoReview)).toEqual({ already: expect.objectContaining({ number: failed.number, column: 'review' }) })
    await failedInReview(w, failed.number, 'R (alpha)')
    for (const [host, id] of [[alpha, 'a1'], [alpha, 'a2'], [w.assistantHome, 'assistant']] as const) {
      expect(await watches.registerWatch(w, host, id, intoReview)).toEqual({ already: expect.objectContaining({ number: failed.number, column: 'review' }) })
      expect(watches.watchFor(host, id)).toBeNull()
    }
    // Fresh: the reviewer's wait for its next round waits.
    expect('watching' in (await watches.registerWatch(w, alpha, 'a1', { ...intoReview, fresh: true }))).toBe(true)
    // With a card still in Review among them: the one in Passed answers.
    expect('already' in (await watches.registerWatch(w, alpha, 'a1', { cards: [inReview.number, passed.number], ...verdictOrPassed }))).toBe(true)
    // A card in Review alone waits for its verdict or move.
    const waiting = await watches.registerWatch(w, alpha, 'a1', { cards: [inReview.number], ...verdictOrPassed })
    expect('watching' in waiting).toBe(true)
    await evaluated(w)
    expect(st.typed).toEqual([])
    await inWorkspace(w, () => tasks.updateTask(inReview.number, { column: 'passed' }, user))
    await evaluated(w)
    expect(st.typed).toHaveLength(1)
    expect(st.told[0]).toMatch(/is in Passed/)
    await disposeWorkspaceService(w)
  })

  it('a failed card its agent returns for review without leaving Review wakes the reviewer waiting for it to come back (#214; a card failed before HI-1946)', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    // a1 reviews here (the stand-in session); a2 did the work.
    const agent = (id: string, name: string) => ({ kind: 'agent', name: `${name} (alpha)`, self: { project: 'alpha', agentId: id }, scope: 'alpha' }) as const
    const rev = agent('a1', 'Builder')
    const builder = agent('a2', 'Reviewer')
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha', agent: 'a2', column: 'review' }, user))
    await inWorkspace(w, () => tasks.updateTask(c.number, { review: 'start' }, rev))
    // The reviewer watches for the card's next round (fresh, #434) just before its failed verdict (card-loop), and again
    // after it: both wait, and its own verdict doesn't wake it.
    const back = { cards: [c.number], changes: ['column' as const], column: 'review' as const, moveInto: true as const, fresh: true as const }
    expect('watching' in (await watches.registerWatch(w, alpha, 'a1', back))).toBe(true)
    await failedInReview(w, c.number, 'Builder (alpha)')
    await evaluated(w)
    expect(st.typed).toEqual([])
    expect('watching' in (await watches.registerWatch(w, alpha, 'a1', back))).toBe(true)
    await new Promise((res) => setTimeout(res, 5))
    // A move in place by anyone else, or a comment: no wake.
    await inWorkspace(w, () => tasks.updateTask(c.number, { column: 'review' }, { kind: 'assistant' }))
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Working on it', builder))
    await evaluated(w)
    expect(st.typed).toEqual([])
    await inWorkspace(w, () => tasks.updateTask(c.number, { column: 'review' }, builder, { comment: 'Fixed both findings' }))
    await evaluated(w)
    expect(st.typed).toHaveLength(1)
    expect(st.told[0]).toMatch(new RegExp(`^\\[CW\\] #${c.number} \\(Reviewer's card\\) was returned for review \\(round 2\\); latest comment by Reviewer \\(alpha\\): "Fixed both findings"\\. Your card watch has ended`))
    await disposeWorkspaceService(w)
  })

  describe('two cards changing together (#224)', () => {
    const agent = (id: string, name: string) => ({ kind: 'agent', name: `${name} (alpha)`, self: { project: 'alpha', agentId: id }, scope: 'alpha' }) as const
    // a1 builds (the stand-in session), a2 reviews.
    const builder = agent('a1', 'Builder')
    const rev = agent('a2', 'Reviewer')
    const verdictOrDone = { changes: ['verdict' as const, 'column' as const], column: 'done' as const, moveInto: true as const }
    const twoInReview = async (w: Parameters<typeof inWorkspace>[0]) => {
      const make = () => inWorkspace(w, () => tasks.createTask({ title: 'T', project: 'alpha', agent: 'a1', column: 'review' }, user))
      const [a, b] = [await make(), await make()]
      for (const c of [a, b]) await inWorkspace(w, () => tasks.updateTask(c.number, { review: 'start' }, rev))
      return [a.number, b.number]
    }
    const verdict = (w: Parameters<typeof inWorkspace>[0], num: number, v: 'passed' | 'failed') => inWorkspace(w, () => tasks.updateTask(num, { review: v }, rev, { comment: `Round 1: ${v.toUpperCase()}` }))

    it('a second change landing just after the first is told in the same line', async () => {
      const { w, alpha } = await open()
      const st = fake(alpha)
      const [a, b] = await twoInReview(w)
      const SETTLE_MS = 400
      watches.testHooks.settleMs = SETTLE_MS
      // The clock stands still while both changes land, so the second is inside the first's settle however long a loaded
      // machine takes to make it; then it moves past the settle, and the line goes.
      const frozenAt = Date.now()
      vi.useFakeTimers({ toFake: ['Date'], now: frozenAt })
      try {
        await watches.registerWatch(w, alpha, 'a1', { cards: [a, b], ...verdictOrDone })
        await verdict(w, a, 'passed')
        await watches.evaluateWatches(w)
        await verdict(w, b, 'failed')
        await watches.evaluateWatches(w)
        expect(st.typed).toEqual([])
        vi.setSystemTime(frozenAt + SETTLE_MS + 100)
        await watches.evaluateWatches(w)
        await vi.waitFor(() => expect(st.typed).toHaveLength(1), { timeout: HUNG_MS })
      } finally {
        vi.useRealTimers()
        watches.testHooks.settleMs = 0
      }
      expect(st.told[0]).toMatch(new RegExp(`^\\[CW\\] #${a} is in Review: Reviewer \\(alpha\\) passed it \\(latest comment by Reviewer \\(alpha\\): "Round 1: PASSED"\\); #${b} is in Doing: Reviewer \\(alpha\\) failed it \\(latest comment by Reviewer \\(alpha\\): "Round 1: FAILED"\\)\\. Your card watch has ended`))
      await disposeWorkspaceService(w)
    })

    it('a watch started after a wake sees what changed in between, and not what the agent did itself', async () => {
      const { w, alpha } = await open()
      const st = fake(alpha)
      const [a, b] = await twoInReview(w)
      await watches.registerWatch(w, alpha, 'a1', { cards: [a, b], ...verdictOrDone })
      await verdict(w, a, 'passed')
      await evaluated(w)
      expect(st.typed).toHaveLength(1)
      expect(st.told[0]).toContain(`#${a} is in Review: Reviewer (alpha) passed it`)
      // #b fails a moment after the wake, before the builder watches again (what deadlocked #119/#217).
      await new Promise((r) => setTimeout(r, 5))
      await verdict(w, b, 'failed')
      st.status = 'watching'
      const r = await watches.registerWatch(w, alpha, 'a1', { cards: [b], ...verdictOrDone })
      expect('watching' in r).toBe(true)
      await vi.waitFor(() => expect(st.told).toHaveLength(2), { timeout: HUNG_MS })
      expect(st.told[1]).toMatch(new RegExp(`^\\[CW\\] #${b} is in Doing: Reviewer \\(alpha\\) failed it`))
      // After that wake, the builder's own work (a comment in Doing, where the failure sent it, and a move back to Review)
      // isn't news to its next watch…
      st.status = 'watching'
      await inWorkspace(w, () => tasks.updateTask(b, { column: 'doing' }, builder, { comment: 'Fixing' }))
      await inWorkspace(w, () => tasks.updateTask(b, { column: 'review' }, builder, { comment: 'Fixed' }))
      await watches.registerWatch(w, alpha, 'a1', { cards: [b], changes: ['comment', 'column', 'verdict', 'agent'] })
      await evaluated(w)
      expect(st.typed).toHaveLength(2)
      // …the reviewer's is.
      await inWorkspace(w, () => tasks.commentTask(b, 'Looking at it', rev))
      await evaluated(w)
      expect(st.typed).toHaveLength(3)
      expect(st.told[2]).toContain('latest comment by Reviewer (alpha): "Looking at it"')
      await disposeWorkspaceService(w)
    })

    it("HI-2016: a failed verdict's move back to Doing is its own, however slowly its lines are written: the wake says it failed", async () => {
      const { w, alpha } = await open()
      const st = fake(alpha)
      const [, b] = await twoInReview(w)
      await watches.registerWatch(w, alpha, 'a1', { cards: [b], ...verdictOrDone })
      // A loaded machine between the verdict's lines (the flake's cause): the clock moves on by a millisecond each read.
      const RealDate = Date
      let tick = 0
      ;(globalThis as { Date: DateConstructor }).Date = class extends RealDate {
        constructor(...args: unknown[]) {
          if (args.length) super(...(args as [number]))
          else super(RealDate.now() + tick++)
        }
        static now(): number {
          return RealDate.now() + tick++
        }
      } as DateConstructor
      try {
        await verdict(w, b, 'failed')
      } finally {
        ;(globalThis as { Date: DateConstructor }).Date = RealDate
      }
      await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
      expect(st.told[0]).toMatch(new RegExp(`^\\[CW\\] #${b} is in Doing: Reviewer \\(alpha\\) failed it`))
      // One change, one time: its lines share it, so its move is known as its own.
      const card = await inWorkspace(w, () => tasks.getTask(b, w))
      const failed = card.history.findLast((h) => h.what.startsWith('Review failed'))!
      const moved = card.history.findLast((h) => h.what.startsWith('Moved to Doing'))!
      expect(moved.at).toBe(failed.at)
      await disposeWorkspaceService(w)
    })

    it('a change between watches is news even in the same millisecond as the wake read the cards', async () => {
      const { w, alpha } = await open()
      const st = fake(alpha)
      const [a, b] = await twoInReview(w)
      await watches.registerWatch(w, alpha, 'a1', { cards: [a, b], ...verdictOrDone })
      // Every write and read from here at one instant (only Date is frozen; timers and I/O stay real).
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60_000 })
      try {
        await verdict(w, a, 'passed')
        await evaluated(w)
        expect(st.typed).toHaveLength(1)
        await verdict(w, b, 'failed')
        st.status = 'watching'
        await watches.registerWatch(w, alpha, 'a1', { cards: [b], ...verdictOrDone })
        await vi.waitFor(() => expect(st.told).toHaveLength(2), { timeout: HUNG_MS })
        expect(st.told[1]).toContain(`#${b} is in Doing: Reviewer (alpha) failed it`)
      } finally {
        vi.useRealTimers()
      }
      await disposeWorkspaceService(w)
    })

    it('the same verdict again in the same millisecond, after the wake told the first: the next watch is woken', async () => {
      const { w, alpha } = await open()
      const st = fake(alpha)
      const [a, b] = await twoInReview(w)
      await watches.registerWatch(w, alpha, 'a1', { cards: [a, b], ...verdictOrDone })
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60_000 })
      try {
        await verdict(w, a, 'passed')
        await verdict(w, b, 'failed')
        await evaluated(w)
        expect(st.typed).toHaveLength(1)
        expect(st.told[0]).toMatch(new RegExp(`#${a} is in Review: Reviewer \\(alpha\\) passed it.*#${b} is in Doing: Reviewer \\(alpha\\) failed it`))
        // Submitted again, reviewed again and failed again, word for word, in the same millisecond as the first failure.
        await inWorkspace(w, () => tasks.updateTask(b, { column: 'review' }, builder))
        await inWorkspace(w, () => tasks.updateTask(b, { review: 'start' }, rev))
        await verdict(w, b, 'failed')
        st.status = 'watching'
        await watches.registerWatch(w, alpha, 'a1', { cards: [b], ...verdictOrDone })
        await vi.waitFor(() => expect(st.told).toHaveLength(2), { timeout: HUNG_MS })
        expect(st.told[1]).toContain(`#${b} is in Doing: Reviewer (alpha) failed it`)
        // The failure the wake told isn't told again: watching once more without a new change, nothing comes.
        st.status = 'watching'
        await watches.registerWatch(w, alpha, 'a1', { cards: [b], ...verdictOrDone })
        await evaluated(w)
        expect(st.typed).toHaveLength(2)
      } finally {
        vi.useRealTimers()
      }
      await disposeWorkspaceService(w)
    })

    it('given to another agent, or archived, between watches: the next watch is woken', async () => {
      const { w, alpha } = await open()
      const st = fake(alpha)
      const [a, b] = await twoInReview(w)
      const c = (await inWorkspace(w, () => tasks.createTask({ title: 'C', project: 'alpha', agent: 'a1', column: 'review' }, user))).number
      await watches.registerWatch(w, alpha, 'a1', { cards: [a, b, c], changes: ['agent', 'verdict'] })
      await verdict(w, a, 'passed')
      await evaluated(w)
      expect(st.typed).toHaveLength(1)
      await new Promise((r) => setTimeout(r, 5))
      await inWorkspace(w, () => tasks.updateTask(b, { agent: 'a2' }, user))
      st.status = 'watching'
      await watches.registerWatch(w, alpha, 'a1', { cards: [b], changes: ['agent'] })
      await vi.waitFor(() => expect(st.told).toHaveLength(2), { timeout: HUNG_MS })
      expect(st.told[1]).toMatch(new RegExp(`^\\[CW\\] #${b} \\(Reviewer's card\\) is in Review`))
      // Archived between watches: told as gone.
      await inWorkspace(w, () => tasks.archiveTask(c, true))
      st.status = 'watching'
      // The previous wake told #b only; #c was in the watch before it, so it starts from what that wake told of it.
      await watches.registerWatch(w, alpha, 'a1', { cards: [b, c], changes: ['agent', 'verdict'] })
      await vi.waitFor(() => expect(st.told).toHaveLength(3), { timeout: HUNG_MS })
      expect(st.told[2]).toContain(`#${c} was archived (off the board`)
      await disposeWorkspaceService(w)
    })
  })

  it('a column alone waits for the card to arrive there: a comment while it is still in Doing wakes nothing', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha', column: 'doing' }, user))
    const cond = readCondition({ cards: [c.number], column: 'review' })
    if (typeof cond === 'string') throw new Error(cond)
    await watches.registerWatch(w, alpha, 'a1', cond)
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Still building', user))
    await evaluated(w)
    expect(st.typed).toEqual([])
    await inWorkspace(w, () => tasks.updateTask(c.number, { column: 'review' }, user))
    await evaluated(w)
    expect(st.typed).toHaveLength(1)
    expect(st.told[0]).toMatch(/is in Review/)
    await disposeWorkspaceService(w)
  })

  it('a condition already met ends the earlier watch too', async () => {
    const { w, alpha } = await open()
    fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha', column: 'review' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    const answer = await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['column'], column: 'review' })
    expect(answer).toHaveProperty('already')
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    await disposeWorkspaceService(w)
  })

  it('HI-2153: a watch set on a card already in Done or archived answers at once with its state, whatever it waits for; none is kept', async () => {
    const { w, alpha } = await open()
    fake(alpha)
    const done = await inWorkspace(w, () => tasks.createTask({ title: 'Merged', project: 'alpha', column: 'done' }, user))
    for (const cond of [{ changes: ['column' as const] }, { changes: ['comment' as const, 'verdict' as const] }, { changes: ['column' as const], column: 'review' as const }]) {
      expect(await watches.registerWatch(w, alpha, 'a1', { cards: [done.number], ...cond })).toMatchObject({ already: { number: done.number, column: 'done' } })
      expect(watches.watchFor(alpha, 'a1')).toBeNull()
    }
    const archived = await inWorkspace(w, () => tasks.createTask({ title: 'Archived', project: 'alpha' }, user))
    await inWorkspace(w, () => tasks.archiveTask(archived.number, true))
    expect(await watches.registerWatch(w, alpha, 'a1', { cards: [archived.number], changes: ['comment'] })).toMatchObject({ already: { number: archived.number, changes: 'gone', archived: true } })
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    await disposeWorkspaceService(w)
  })

  it("HI-2197: a new conversation ends the agent's watch from before, its wake cancelled before it returns; the next conversation's watch stays", async () => {
    const { w, path, alpha } = await open()
    const st = fake(alpha)
    // Not fired: removed and saved without it.
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'Old card', project: 'alpha', column: 'passed' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['column'] })
    await watches.endConversationWatch(alpha, 'a1')
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    expect(savedOf(path)).toEqual([])
    // Fired and handed over, its line typed but never taken (HB3's: its input blocked): the old conversation's watch.
    const takes = sessions.sendPrompt
    Object.assign(sessions, {
      sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
        guard?.()
        st.typed.push(text)
        st.status = 'finished'
      }
    })
    writer.testHooks.takeMs = 20
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['column'] })
    await inWorkspace(w, () => tasks.updateTask(c.number, { column: 'done' }, user))
    await evaluated(w)
    expect(st.typed).toHaveLength(1)
    const wake = savedOf(path)[0].fired.delivery as string
    expect((await deliveries.deliveriesOf(alpha, 'a1')).find((r) => r.id === wake)?.state).toBe('offered')
    // Its wake's cancel held: the end isn't over until it is done.
    let release = (): void => undefined
    let holding = false
    watches.testHooks.beforeWakeCancel = () => {
      holding = true
      return new Promise<void>((r) => (release = r))
    }
    try {
      let over = false
      const ending = watches.endConversationWatch(alpha, 'a1').then(() => (over = true))
      await vi.waitFor(() => expect(holding).toBe(true), { timeout: HUNG_MS })
      expect(over).toBe(false)
      expect(watches.watchFor(alpha, 'a1')).toBeNull()
      expect((await deliveries.deliveriesOf(alpha, 'a1')).find((r) => r.id === wake)?.state).not.toBe('cancelled')
      // The new conversation's own watch, set while the old wake's cancel is still under way, isn't the one it ends.
      const mine = await inWorkspace(w, () => tasks.createTask({ title: 'New card', project: 'alpha', column: 'doing' }, user))
      await watches.registerWatch(w, alpha, 'a1', { cards: [mine.number], changes: ['comment'] })
      release()
      await ending
      expect((await deliveries.deliveriesOf(alpha, 'a1')).find((r) => r.id === wake)?.state).toBe('cancelled')
      expect(watches.watchFor(alpha, 'a1')?.cards).toEqual([mine.number])
    } finally {
      watches.testHooks.beforeWakeCancel = undefined
      Object.assign(sessions, { sendPrompt: takes })
      writer.testHooks.takeMs = undefined
      await writer.settled()
      await disposeWorkspaceService(w)
    }
  })

  it('HI-2197: a start resumes or carries on its own work and keeps its watch; any other start ends it before it launches', async () => {
    const { w, alpha } = await open()
    const s = sessions as unknown as { startReserved: unknown; conversationEnds: (p: string, id: string) => Promise<void> }
    const was = { startReserved: s.startReserved, conversationEnds: s.conversationEnds }
    const order: string[] = []
    let release = (): void => undefined
    s.conversationEnds = async (_p, id) => {
      order.push(`ends ${id}`)
      await new Promise<void>((r) => (release = r))
    }
    s.startReserved = async (_p: string, id: string, _l: string, opts: { resumeId?: string }) => {
      order.push(`launch ${id}${opts.resumeId ? ' resumed' : ''}`)
      return { agentId: id } as never
    }
    try {
      // A new conversation (a lane's brief, a placement's, a handover from another agent): its old watch ended first.
      const fresh = inWorkspace(w, () => sessions.start(alpha, { agentId: 'a1', prompt: 'Your next card', handedOverFrom: 'other-agents-session' }))
      await vi.waitFor(() => expect(order).toEqual(['ends a1']), { timeout: HUNG_MS })
      release()
      await fresh
      expect(order).toEqual(['ends a1', 'launch a1'])
      // A resume, and an agent's handover to itself: the same work goes on, its watch kept.
      order.length = 0
      await inWorkspace(w, () => sessions.start(alpha, { agentId: 'a1', resumeId: '3554f946-b2e3-4971-8ecf-732c805ef95a' }))
      await inWorkspace(w, () => sessions.start(alpha, { agentId: 'a1', prompt: 'Read the handover', handedOverFrom: 'its-own-session', keepWatch: true }))
      expect(order).toEqual(['launch a1 resumed', 'launch a1'])
    } finally {
      Object.assign(s, was)
      await disposeWorkspaceService(w)
    }
  })

  it("HI-2197: an old watch that can't be ended stops the start: nothing launched, the watch and its wake kept for the next try, the start's reservation released", async () => {
    const { w, path, alpha } = await open()
    const st = fake(alpha)
    const takes = sessions.sendPrompt
    // Its wake typed but never taken (HB3's: its input blocked), so the wake stays offered.
    Object.assign(sessions, {
      sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
        guard?.()
        st.typed.push(text)
        st.status = 'finished'
      }
    })
    writer.testHooks.takeMs = 20
    const s = sessions as unknown as { startReserved: unknown; conversationEnds: (p: string, id: string) => Promise<void> }
    const was = { startReserved: s.startReserved, conversationEnds: s.conversationEnds }
    const launched: string[] = []
    s.conversationEnds = watches.endConversationWatch
    s.startReserved = async (_p: string, id: string) => (launched.push(id), { agentId: id } as never)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'Old card', project: 'alpha', column: 'passed' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['column'] })
    // Its watch can't be saved without it (a full disk, a locked database).
    storeTestHooks.failSave = (store) => store === 'watches'
    try {
      await expect(inWorkspace(w, () => sessions.start(alpha, { agentId: 'a1', prompt: 'Your next card' }))).rejects.toThrow(/Could not end the watch \(its conversation ended\)/)
      expect(launched).toEqual([])
      expect(watches.watchFor(alpha, 'a1')?.cards).toEqual([c.number])
      expect(savedOf(path)).toHaveLength(1)
      expect(sessions.pendingStart(alpha, 'a1')).toBeFalsy()
      // Its cancel failing too (the inbox's save): the start fails, and nothing launches.
      storeTestHooks.failSave = null
      watches.testHooks.beforeWakeCancel = async () => {
        throw new Error('the inbox could not be saved')
      }
      await watches.cancelWatch(w, alpha, 'a1')
      await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['column'] })
      await inWorkspace(w, () => tasks.updateTask(c.number, { column: 'done' }, user))
      await evaluated(w)
      const wake = savedOf(path)[0]?.fired?.delivery as string
      expect(wake).toMatch(/^m\d+$/)
      await expect(inWorkspace(w, () => sessions.start(alpha, { agentId: 'a1', prompt: 'Your next card' }))).rejects.toThrow(/inbox could not be saved/)
      expect(launched).toEqual([])
      expect((await deliveries.deliveriesOf(alpha, 'a1')).find((r) => r.id === wake)?.state).toBe('offered')
      // The watch put back, so the next try ends both.
      expect(watches.watchFor(alpha, 'a1')?.cards).toEqual([c.number])
      expect(savedOf(path)[0]?.fired?.delivery).toBe(wake)
      expect(sessions.pendingStart(alpha, 'a1')).toBeFalsy()
      // Released: the next start, once nothing fails, ends the watch and cancels its wake, then goes ahead.
      watches.testHooks.beforeWakeCancel = undefined
      await inWorkspace(w, () => sessions.start(alpha, { agentId: 'a1', prompt: 'Your next card' }))
      expect(launched).toEqual(['a1'])
      expect(watches.watchFor(alpha, 'a1')).toBeNull()
      expect((await deliveries.deliveriesOf(alpha, 'a1')).find((r) => r.id === wake)?.state).toBe('cancelled')
    } finally {
      storeTestHooks.failSave = null
      watches.testHooks.beforeWakeCancel = undefined
      Object.assign(s, was)
      Object.assign(sessions, { sendPrompt: takes })
      writer.testHooks.takeMs = undefined
      await writer.settled()
      await disposeWorkspaceService(w)
    }
  })

  it("HI-2153: Archive All counts a watch on a card in work as someone on it, never a stale one on a card in Done", async () => {
    const { w, alpha } = await open()
    const { cardBusy } = await import('../src/main/cardBusy')
    const inReview = await inWorkspace(w, () => tasks.createTask({ title: 'Watched', project: 'alpha', column: 'review' }, user))
    const merged = await inWorkspace(w, () => tasks.createTask({ title: 'Merged', project: 'alpha', column: 'done' }, user))
    // A2 is running and its watch (from before HI-2153, or not yet ended) names both cards.
    const was = { liveStates: sessions.liveStates, watchFor: sessions.watchFor }
    Object.assign(sessions, {
      liveStates: () => [{ projectPath: alpha, agentId: 'a2', agentName: 'Reviewer', status: 'watching' }],
      watchFor: (p: string, id: string) => (p.toLowerCase() === alpha.toLowerCase() && id === 'a2' ? { cards: [inReview.number, merged.number] } : null)
    })
    try {
      expect(cardBusy(w, inReview)).toBe('Reviewer is watching it')
      expect(cardBusy(w, merged)).toBeNull()
    } finally {
      Object.assign(sessions, was)
      await disposeWorkspaceService(w)
    }
  })

  it('HI-2153: a watch on a card that reaches Done ends, also one that waits only for comments or another column; one saved on a Done card ends at the next check', async () => {
    const { w, path, alpha } = await open()
    const st = fake(alpha)
    for (const cond of [{ changes: ['comment' as const] }, { changes: ['column' as const], column: 'passed' as const }]) {
      st.status = 'watching'
      const c = await inWorkspace(w, () => tasks.createTask({ title: 'Card', project: 'alpha', column: 'review' }, user))
      await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], ...cond })
      const before = st.told.length
      await inWorkspace(w, () => tasks.updateTask(c.number, { column: 'done' }, user))
      await evaluated(w)
      await vi.waitFor(() => expect(st.told).toHaveLength(before + 1), { timeout: HUNG_MS })
      expect(st.told.at(-1)).toMatch(new RegExp(`^\\[CW\\] #${c.number} is in Done \\(your watch on it ended\\)`))
      await vi.waitFor(() => expect(watches.watchFor(alpha, 'a1')).toBeNull(), { timeout: HUNG_MS })
    }
    // Saved before HI-2153 on a card already Done, waiting for a column change that never comes (HR2 on HI-2148).
    st.status = 'watching'
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'Stale', project: 'alpha', column: 'review' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['column'] })
    const data = savedOf(path)
    await watches.cancelWatch(w, alpha, 'a1')
    const merged = await inWorkspace(w, () => tasks.updateTask(c.number, { column: 'done' }, user))
    await evaluated(w)
    // Its view of the card ends with it in Done: no change since will ever fire it.
    data[0].marks[c.number] = markOf(merged)
    data[0].seen[c.number] = seenOf(merged)
    await putSaved(path, data)
    watches.forgetWatches(w)
    const before = st.told.length
    await vi.waitFor(async () => {
      await evaluated(w)
      expect(st.told).toHaveLength(before + 1)
    }, { timeout: HUNG_MS })
    expect(st.told.at(-1)).toMatch(new RegExp(`^\\[CW\\] #${c.number} is in Done \\(your watch on it ended\\)`))
    await vi.waitFor(() => expect(watches.watchFor(alpha, 'a1')).toBeNull(), { timeout: HUNG_MS })
    await disposeWorkspaceService(w)
  })

  it("a card moved to another project is gone to the agent: nothing of its new project's comments is told", async () => {
    const { w, path, alpha } = await open()
    const st = fake(alpha)
    mkdirSync(join(path, 'beta'), { recursive: true })
    await w.refresh()
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    // A scope written into the file by hand is ignored: the agent's own project decides.
    const saved = savedOf(path)
    saved[0].scope = null
    await putSaved(path, saved)
    watches.forgetWatches(w)
    await inWorkspace(w, () => tasks.updateTask(c.number, { project: 'beta' }, user))
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Private beta information', user))
    await evaluated(w)
    expect(st.typed).toHaveLength(1)
    expect(st.told[0]).toMatch(/is gone from your board/)
    expect(st.told[0]).not.toMatch(/Private|beta/)
    // A card outside the agent's view can't be watched at all.
    await expect(watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })).rejects.toThrow(/Unknown task/)
    await disposeWorkspaceService(w)
  })

  it('a line fired while the card was visible is checked again before it is typed', async () => {
    const { w, path, alpha } = await open()
    const st = fake(alpha)
    mkdirSync(join(path, 'beta'), { recursive: true })
    await w.refresh()
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    st.status = 'working'
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Ready for you', user))
    await evaluated(w)
    expect(st.typed).toEqual([])
    await inWorkspace(w, () => tasks.updateTask(c.number, { project: 'beta' }, user))
    st.status = 'watching'
    await watches.tick()
    expect(st.typed).toHaveLength(1)
    expect(st.told[0]).toMatch(/is gone from your board/)
    expect(st.told[0]).not.toMatch(/Ready for you/)
    await disposeWorkspaceService(w)
  })

  /** sendPrompt held after its first check (before Enter) until released; it checks again before Enter. */
  const gated = (st: { typed: string[]; status: string }) => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const ready = new Promise<void>((r) => (entered = r))
    ;(sessions as unknown as { sendPrompt: unknown }).sendPrompt = async (_p: string, _id: string, text: string, guard?: () => void) => {
      guard?.()
      entered()
      await gate
      guard?.()
      st.typed.push(text)
      st.status = 'working'
    }
    return { release: () => release(), ready }
  }

  it('Cancel while the line is being typed stops it before Enter; the agent stays watching until then', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const g = gated(st)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Ready', user))
    const waking = watches.evaluateWatches(w)
    await g.ready
    // Still watching while it is typed: no other work can be given to it.
    expect(watches.watchFor(alpha, 'a1')).not.toBeNull()
    expect(await watches.cancelWatch(w, alpha, 'a1')).toBe(true)
    g.release()
    await waking
    expect(st.typed).toEqual([])
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    // Never put back by a later try.
    await watches.tick()
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    expect(st.typed).toEqual([])
    await disposeWorkspaceService(w)
  })

  it('a new watch while the old one is being typed replaces it: the old line is not typed, the new watch stays', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const g = gated(st)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Ready', user))
    const waking = watches.evaluateWatches(w)
    await g.ready
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['verdict'] })
    g.release()
    await waking
    expect(st.typed).toEqual([])
    expect(watches.watchFor(alpha, 'a1')?.changes).toEqual(['verdict'])
    await disposeWorkspaceService(w)
  })

  it('a wake refused (the agent got busy) is kept for the next try; cancelled meanwhile, it never comes back', async () => {
    const { w, alpha } = await open()
    fake(alpha)
    ;(sessions as unknown as { sendPrompt: unknown }).sendPrompt = async () => {
      throw new Error('The agent got busy.')
    }
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Ready', user))
    await evaluated(w)
    expect(watches.watchFor(alpha, 'a1')).not.toBeNull()
    expect(await watches.cancelWatch(w, alpha, 'a1')).toBe(true)
    const st = fake(alpha)
    await watches.tick()
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    expect(st.typed).toEqual([])
    await disposeWorkspaceService(w)
  })

  it('a change while the watch is being set up is not lost', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha', column: 'doing' }, user))
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const ready = new Promise<void>((r) => (entered = r))
    watches.testHooks.afterRead = async () => {
      entered()
      await gate
    }
    try {
      const registering = watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['column'], column: 'review', moveInto: true })
      await ready
      // The card was read in Doing; it moves to Review before the watch is in place. The check that move makes waits for it.
      await inWorkspace(w, () => tasks.updateTask(c.number, { column: 'review' }, user))
      const checking = watches.evaluateWatches(w)
      release()
      await registering
      await checking
      await evaluated(w)
      expect(st.typed).toHaveLength(1)
      expect(st.told[0]).toMatch(/is in Review/)
    } finally {
      release()
      watches.testHooks.afterRead = undefined
      await disposeWorkspaceService(w)
    }
  })

  it("a workspace closed or switched while its watches load never gets another's watch, and the call fails", async () => {
    const { w, path, alpha } = await open()
    fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    const other = join(path, '..', `other-${n}`)
    mkdirSync(other, { recursive: true })
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const ready = new Promise<void>((r) => (entered = r))
    watches.testHooks.afterLoad = async () => {
      entered()
      await gate
    }
    try {
      const registering = watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
      await ready
      watches.testHooks.afterLoad = undefined
      await w.open(other)
      release()
      await expect(registering).rejects.toThrow(/closed/)
      expect(existsSync(join(other, '.combwork', 'watches.json'))).toBe(false)
      expect(existsSync(join(path, '.combwork', 'watches.json'))).toBe(false)
    } finally {
      release()
      watches.testHooks.afterLoad = undefined
      await disposeWorkspaceService(w)
    }
  })

  it('a wake being offered when Hive stopped (its CLI never took it) is offered once more after the restart, saying it may repeat; its watch ends once that is received (#649)', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const takes = sessions.sendPrompt
    // Typed, but its CLI never takes it (no Enter again lands either).
    Object.assign(sessions, {
      sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
        guard?.()
        st.typed.push(text)
        st.status = 'finished'
      }
    })
    writer.testHooks.takeMs = 20
    try {
      const c = await inWorkspace(w, () => tasks.createTask({ title: 'Lost Enter', project: 'alpha' }, user))
      await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
      await inWorkspace(w, () => tasks.commentTask(c.number, 'news', user))
      await evaluated(w)
      expect(st.typed).toHaveLength(1)
      expect((await deliveries.deliveriesOf(alpha, 'a1')).map((r) => r.state)).toEqual(['offered'])
      expect(watches.watchFor(alpha, 'a1')).not.toBeNull()
      // Hive stops (memory forgotten, the files read again), and the CLI takes what is typed after the restart.
      await deliveries.forgetDeliveriesForTests()
      watches.forgetWatches(w)
      Object.assign(sessions, { sendPrompt: takes })
      st.status = 'watching'
      await vi.waitFor(() => expect(watches.watchFor(alpha, 'a1')).not.toBeNull(), { timeout: HUNG_MS })
      await watches.settled()
      expect((await deliveries.deliveriesOf(alpha, 'a1')).map((r) => `${r.state}: ${r.detail}`)).toEqual(['uncertain: may not have reached it: Combwork stopped while offering it'])
      await deliveries.offerAllForTests()
      expect(st.typed).toEqual([st.typed[0], `${st.typed[0]} (m1 again: Combwork restarted while offering it, so it may repeat.)`])
      await watches.settled()
      expect((await deliveries.deliveriesOf(alpha, 'a1')).map((r) => r.state)).toEqual(['received'])
      expect(watches.watchFor(alpha, 'a1')).toBeNull()
      // Offered once more only: nothing typed a third time.
      await deliveries.offerAllForTests()
      expect(st.typed).toHaveLength(2)
    } finally {
      Object.assign(sessions, { sendPrompt: takes })
      writer.testHooks.takeMs = undefined
      await writer.settled()
      await disposeWorkspaceService(w)
    }
  })

  it("two projects' wakes with the same delivery id (each project's m1): a receipt ends only its own project's watch (#649 round 2)", async () => {
    const { w, path, alpha } = await open()
    const beta = join(path, 'beta')
    mkdirSync(join(beta, '.combwork'), { recursive: true })
    writeFileSync(join(beta, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'Bee' }] }))
    await w.refresh()
    const st = { typed: [] as string[], taken: new Map<string, number>([['a1', 0], ['b1', 0]]), status: new Map<string, string>([['a1', 'watching'], ['b1', 'watching']]) }
    const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
    const who = (p: string, id: string): string | null => ((same(p, alpha) && id === 'a1') || (same(p, beta) && id === 'b1') ? id : null)
    Object.assign(sessions, {
      liveFor: (p: string, id: string) => (who(p, id) ? ({ projectPath: p, agentId: id, status: st.status.get(id), runId: `run-${id}`, sessionId: `s-${id}` } as never) : null),
      promptsTaken: (p: string, id: string) => (who(p, id) ? { runId: `run-${id}`, count: st.taken.get(id)! } : null),
      userMayBeTyping: () => false,
      sendPrompt: async (_p: string, id: string, text: string, guard?: () => void) => {
        guard?.()
        st.typed.push(`${id}: ${text}`)
        st.status.set(id, 'finished')
      },
      watchChanged: () => undefined
    })
    writer.testHooks.takeMs = 20
    try {
      const ca = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
      const cb = await inWorkspace(w, () => tasks.createTask({ title: 'B', project: 'beta' }, user))
      await watches.registerWatch(w, alpha, 'a1', { cards: [ca.number], changes: ['comment'] })
      await watches.registerWatch(w, beta, 'b1', { cards: [cb.number], changes: ['comment'] })
      await inWorkspace(w, () => tasks.commentTask(ca.number, 'for alpha', user))
      await inWorkspace(w, () => tasks.commentTask(cb.number, 'for beta', user))
      await evaluated(w)
      expect(st.typed).toHaveLength(2)
      expect((await deliveries.deliveriesOf(alpha, 'a1')).map((r) => r.id)).toEqual(['m1'])
      expect((await deliveries.deliveriesOf(beta, 'b1')).map((r) => r.id)).toEqual(['m1'])
      // Alpha's agent takes its doorbell and reads its inbox (#650: the receipt): only alpha's watch ends.
      st.taken.set('a1', 1)
      st.status.set('a1', 'working')
      expect((await deliveries.readInbox(alpha, 'a1')).items.map((i) => i.ids.join())).toEqual(['m1'])
      await watches.settled()
      expect(watches.watchFor(alpha, 'a1')).toBeNull()
      expect(watches.watchFor(beta, 'b1')?.cards).toEqual([cb.number])
      // Beta's then.
      st.taken.set('b1', 1)
      st.status.set('b1', 'working')
      await deliveries.readInbox(beta, 'b1')
      await watches.settled()
      expect(watches.watchFor(beta, 'b1')).toBeNull()
    } finally {
      writer.testHooks.takeMs = undefined
      await writer.settled()
      await disposeWorkspaceService(w)
    }
  })

  it("a lane wake's marks move only once it is received: one not received (cancelled, expired) fires again on the same events; kept pending across a restart (#649 round 2)", async () => {
    const lanes = await import('../src/main/lanes')
    const { w, path, alpha } = await open()
    const st = fake(alpha)
    // The CLI doesn't take what is typed.
    Object.assign(sessions, {
      sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
        guard?.()
        st.typed.push(text)
        st.status = 'finished'
      }
    })
    writer.testHooks.takeMs = 20
    try {
      const c = await inWorkspace(w, () => tasks.createTask({ title: 'Laned', project: 'alpha', agent: 'a1', column: 'doing' }, user))
      const lane = (await lanes.startLane(w, { project: 'alpha', builder: 'a1', reviewer: 'a2', cards: [c.number], by: 'Builder (alpha)' })).lane
      await watches.registerLaneWatch(w, alpha, 'a1', { ids: [lane.id], events: ['failed', 'blocked', 'stalled', 'merge-due', 'ended', 'abandoned'] })
      const marksBefore = savedOf(path)[0].laneMarks
      await lanes.endLane(w, lane.id, { abandoned: true })
      await evaluated(w)
      expect(st.typed).toHaveLength(1)
      // Handed over, not received: the watch's own marks haven't moved; the line's are pending with it, saved.
      const saved = savedOf(path)[0]
      expect(saved.laneMarks).toEqual(marksBefore)
      expect(saved.fired.laneMarks[lane.id].state).toBe('abandoned')
      // Cancelled without a receipt: the watch fires again on the same event.
      await deliveries.cancelFromSource(alpha, 'watch', null, 'cancelled: a test')
      await watches.settled()
      await vi.waitFor(() => expect(st.typed).toHaveLength(2), { timeout: HUNG_MS })
      expect(st.typed[1]).toBe(st.typed[0].replace('(m1)', '(m2)'))
      // Read back after a restart before its receipt: still pending, and the watch's marks still as they were.
      await deliveries.forgetDeliveriesForTests()
      watches.forgetWatches(w)
      await vi.waitFor(() => expect(watches.watchFor(alpha, 'a1')).not.toBeNull(), { timeout: HUNG_MS })
      await watches.settled()
      const back = savedOf(path)[0]
      expect(back.laneMarks).toEqual(marksBefore)
      expect(back.fired.laneMarks[lane.id].state).toBe('abandoned')
    } finally {
      writer.testHooks.takeMs = undefined
      await writer.settled()
      await disposeWorkspaceService(w)
    }
  })

  it('a watch read back from before #649 marked as being typed (`sending`) is an attempt, not a receipt: handed over once more, saying it may repeat (#649 round 2)', async () => {
    const { w, path, alpha } = await open()
    const st = fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'Legacy', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    await watches.settled()
    // The file as a build from before #649 left it, typing when Hive stopped.
    const data = savedOf(path)
    data[0].fired = { line: `[CW] #${c.number} has news. Your card watch has ended: carry on.`, at: new Date().toISOString(), cards: [c.number], sending: new Date().toISOString() }
    await putSaved(path, data)
    watches.forgetWatches(w)
    // Read back (as its agent's state asks for it), handed over and typed.
    watches.watchFor(alpha, 'a1')
    await vi.waitFor(() => expect(st.typed).toHaveLength(1), { timeout: HUNG_MS })
    await watches.settled()
    expect(st.typed[0]).toMatch(/ \(m1 again: Combwork restarted while typing it, so it may repeat\.\)$/)
    // Received (its agent read it): the watch ends.
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    await disposeWorkspaceService(w)
  })

  it('a wake fired before HI-2463 ("[Hive] ", hive_ tools) is read back and handed over word for word: its prefix made current, a note on the old names (HR1, HI-2463)', async () => {
    const { w, path, alpha } = await open()
    const st = fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'Renamed', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    await watches.settled()
    // As an older build left it: fired, not handed over yet, in its own words.
    const data = savedOf(path)
    // Its latest comment, quoted, names the old tools: a person's words, never rewritten.
    const words = `#${c.number} has news; latest comment by the user: "keep hive_inbox and hive-progress in the old example". Read it (hive_read_task), then watch again (hive_wait_for_tasks).`
    data[0].fired = { line: `[Hive] ${words}`, at: new Date().toISOString(), cards: [c.number] }
    await putSaved(path, data)
    watches.forgetWatches(w)
    watches.watchFor(alpha, 'a1')
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    await watches.settled()
    expect(st.typed[0]).toMatch(/^\[CW\] New in your inbox: /)
    expect(st.told[0]).toBe(`[CW] ${words} (Combwork has renamed what agents use: a hive_<tool> named here is now cw_<tool>, mcp__hive__ is mcp__combwork__, and hive-progress is cw-progress.)`)
    await disposeWorkspaceService(w)
  })

  it("a watch whose wake its CLI never took (marked) isn't shown as waiting on cards: nothing will wake its agent, so its loop is checked as one with no watch; taken and read, its watch ends as received (#649 round 3, #650)", async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    let untaken = false
    Object.assign(sessions, {
      lineUntaken: () => untaken,
      sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
        guard?.()
        st.typed.push(text)
        st.status = 'finished'
      }
    })
    writer.testHooks.takeMs = 20
    try {
      const c = await inWorkspace(w, () => tasks.createTask({ title: 'Untaken', project: 'alpha' }, user))
      await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
      await inWorkspace(w, () => tasks.commentTask(c.number, 'news', user))
      await evaluated(w)
      expect(st.typed).toHaveLength(1)
      // Handed over, not received: still its watch.
      expect(watches.watchFor(alpha, 'a1')?.cards).toEqual([c.number])
      // Marked not taken: not shown as waiting on cards (its status is finished, with no watch).
      untaken = true
      expect(watches.watchFor(alpha, 'a1')).toBeNull()
      // Taken after all (the user pressed Enter), and read: received, and the watch has ended.
      untaken = false
      st.prompts++
      st.status = 'working'
      await deliveries.readInbox(alpha, 'a1')
      await watches.settled()
      expect((await deliveries.deliveriesOf(alpha, 'a1')).map((r) => r.state)).toEqual(['received'])
      expect(watches.watchFor(alpha, 'a1')).toBeNull()
    } finally {
      delete (sessions as unknown as Record<string, unknown>).lineUntaken
      writer.testHooks.takeMs = undefined
      await writer.settled()
      await disposeWorkspaceService(w)
    }
  })

  it("a watches file at a workspace's first load is moved in (#1018): entries that aren't valid are kept aside and never stop the others; the file is kept as a backup, one found later never read", async () => {
    // A workspace whose watches file is from before #1018 (made from a watch saved in another, with this one's folder).
    const t = await open()
    fake(t.alpha)
    const tc = await inWorkspace(t.w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(t.w, t.alpha, 'a1', { cards: [tc.number], changes: ['comment'] })
    const json = (x: unknown) => JSON.stringify(x).slice(1, -1)
    const { projectId: _id, ...template } = JSON.parse(JSON.stringify(savedOf(t.path)[0]).split(json(t.alpha)).join(json(join(base, `ws-${n + 1}`, 'alpha'))))
    await disposeWorkspaceService(t.w)
    const { w, path, alpha } = await open()
    const st = fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    expect(c.number).toBe(tc.number)
    expect(template.projectPath).toBe(alpha)
    const file = join(path, '.combwork', 'watches.json')
    const bad = { id: 'bad', projectPath: alpha, agentId: 'a2', cond: { cards: [c.number], changes: ['column'] }, limitAt: new Date(Date.now() + 100000).toISOString() }
    // In another folder, saved before ids or with an id no project of this workspace has (#508: one with alpha's id is alpha's).
    const elsewhere = { ...template, id: 'far', agentId: 'a3', projectPath: join(path, '..', 'not-here', 'alpha') }
    const stranger = { ...template, id: 'stranger', agentId: 'a4', projectId: 'p-000000000000', projectPath: join(path, '..', 'not-here', 'alpha') }
    // One the file kept aside already.
    const earlier = { id: 'earlier', junk: true }
    const text = JSON.stringify({ version: 1, watches: [bad, elsewhere, stranger, template], invalid: [earlier] })
    writeFileSync(file, text)
    // Moved in (in the background) before the change it waits for.
    await vi.waitFor(() => expect(watches.watchFor(alpha, 'a1')).not.toBeNull(), { timeout: HUNG_MS })
    const backups = () => readdirSync(join(path, '.combwork')).filter((f) => f.startsWith('watches.json.imported-'))
    expect(existsSync(file)).toBe(false)
    expect(backups().map((f) => readFileSync(join(path, '.combwork', f), 'utf8'))).toEqual([text])
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Ready', user))
    await expect(watches.evaluateWatches(w)).resolves.toBeUndefined()
    await watches.settled()
    expect(st.typed).toHaveLength(1)
    // The entries that aren't valid are still kept, as they were.
    expect(storeMeta(path, 'watches', 'invalid')).toEqual([earlier, bad, elsewhere, stranger])
    expect(savedOf(path)).toEqual([])
    // A watches file found after that (an older Hive's) is kept as a backup too, never read, even one that isn't JSON.
    writeFileSync(file, '{ not json')
    watches.forgetWatches(w)
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    expect(existsSync(file)).toBe(false)
    expect(readdirSync(join(path, '.combwork')).some((f) => f.startsWith('watches.json.damaged-'))).toBe(false)
    expect(backups().map((f) => readFileSync(join(path, '.combwork', f), 'utf8')).sort()).toEqual([text, '{ not json'].sort())
    expect(savedOf(path)).toHaveLength(1)
    await disposeWorkspaceService(w)
  })

  it("a watch saved under another folder with an id this workspace has is that project's: the id decides, not the saved folder (#536)", async () => {
    // The other side of the boundary (the test above): saved under a folder outside the workspace with no id, or an id
    // no project here has, it stays set aside.
    const { w, path, alpha } = await open()
    const st = fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    const saved = savedOf(path)
    const id = JSON.parse(readFileSync(join(alpha, '.combwork', 'project.json'), 'utf8')).id
    expect(saved[0].projectId).toBe(id)
    const foreign = join(path, '..', 'not-here', 'alpha')
    await putSaved(path, [{ ...saved[0], projectPath: foreign }])
    watches.forgetWatches(w)
    await watches.stampWatchProjects(w)
    // alpha's, at alpha's folder: it sees alpha's cards and wakes alpha's agent, nothing of the foreign folder's.
    expect(watches.watchFor(alpha, 'a1')?.cards).toEqual([c.number])
    expect(watches.watchFor(foreign, 'a1')).toBeNull()
    expect(savedOf(path).map((x: { projectPath: string; projectId?: string }) => [x.projectPath, x.projectId])).toEqual([[alpha, id]])
    expect(storeMeta(path, 'watches', 'invalid') ?? []).toEqual([])
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Ready', user))
    await evaluated(w)
    expect(st.told).toEqual([expect.stringContaining('Ready')])
    await disposeWorkspaceService(w)
  })

  it("a saved watch follows its project's id to the folder's new name (#508); one from before gets the id", async () => {
    const { w, path, alpha } = await open()
    fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    const id = JSON.parse(readFileSync(join(alpha, '.combwork', 'project.json'), 'utf8')).id
    expect(savedOf(path)[0].projectId).toBe(id)
    // Renamed while Hive was closed: read back, the watch is the project's under its new name.
    await disposeWorkspaceService(w)
    const gamma = join(path, 'gamma')
    await moveFolder(alpha, gamma)
    fake(gamma)
    const w2 = createWorkspaceService()
    await w2.open(path)
    await evaluated(w2)
    expect(watches.watchFor(gamma, 'a1')?.cards).toEqual([c.number])
    // A watch from before ids gets its project's id.
    const saved = savedOf(path)
    delete saved[0].projectId
    saved[0].projectPath = gamma
    await putSaved(path, saved)
    watches.forgetWatches(w2)
    await evaluated(w2)
    await watches.registerWatch(w2, gamma, 'a2', { cards: [c.number], changes: ['column'] })
    expect(savedOf(path).map((x: { projectPath: string; projectId?: string }) => [x.projectPath, x.projectId])).toEqual([
      [gamma, id],
      [gamma, id]
    ])
    await disposeWorkspaceService(w2)
  })

  it("a watch whose project is gone while another project has its folder is set aside, never the new project's (#508)", async () => {
    const { w, path, alpha } = await open()
    fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    const before = savedOf(path)[0]
    await disposeWorkspaceService(w)
    // alpha leaves the workspace, and a new alpha comes, with an agent of the same id.
    await moveFolder(alpha, join(path, '..', `${basename(path)}-alpha-elsewhere`))
    mkdirSync(join(alpha, '.combwork'), { recursive: true })
    writeFileSync(join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Someone else' }] }))
    fake(alpha)
    const w2 = createWorkspaceService()
    await w2.open(path)
    await evaluated(w2)
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    await watches.stampWatchProjects(w2)
    expect(storeMeta(path, 'watches', 'invalid')).toEqual([before])
    await disposeWorkspaceService(w2)
  })

  it('Repair gives a watch saved before ids in a renamed project\'s old folder to the project (#508)', async () => {
    const { w, path, alpha } = await open()
    fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    const saved = savedOf(path)
    delete saved[0].projectId
    await putSaved(path, saved)
    await disposeWorkspaceService(w)
    const gamma = join(path, 'gamma')
    await moveFolder(alpha, gamma)
    fake(gamma)
    const w2 = createWorkspaceService()
    await w2.open(path)
    const { movePlan, repairMove } = await import('../src/main/workspaceMove')
    const plan = await movePlan(w2)
    expect(plan?.cards).toEqual([expect.objectContaining({ from: 'alpha', to: 'gamma', watches: 1 })])
    const report = await repairMove(w2)
    expect(report.failed).toEqual([])
    expect(watches.watchFor(gamma, 'a1')?.cards).toEqual([c.number])
    const id = JSON.parse(readFileSync(join(gamma, '.combwork', 'project.json'), 'utf8')).id
    expect(savedOf(path)[0]).toMatchObject({ projectPath: gamma, projectId: id })
    await disposeWorkspaceService(w2)
  })

  it('the whole workspace moved while Hive was closed: its watches come with it, by their ids, and still wake their agents (#508 round 3)', async () => {
    // A workspace with no record of where it was (lastPath, #146): the watches with ids say where.
    const { w, path, alpha } = await open()
    fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    // One saved before ids too, by the Assistant's folder.
    await watches.registerWatch(w, w.assistantHome, 'assistant', { cards: [c.number], changes: ['comment'] })
    expect(savedOf(path).map((x: { projectId?: string }) => !!x.projectId)).toEqual([true, false])
    await disposeWorkspaceService(w)
    const to = `${path}-moved`
    // Tried again while Windows holds it a moment (#555): the board's database was just written and closed (#1017).
    await moveFolder(path, to)
    const gamma = join(to, 'alpha')
    const st = fake(gamma)
    const w2 = createWorkspaceService()
    await w2.open(to)
    await watches.stampWatchProjects(w2)
    expect(watches.watchFor(gamma, 'a1')?.cards).toEqual([c.number])
    expect(watches.watchFor(w2.assistantHome, 'assistant')?.cards).toEqual([c.number])
    expect(savedOf(to).map((x: { projectPath: string }) => x.projectPath)).toEqual([gamma, w2.assistantHome])
    await inWorkspace(w2, () => tasks.commentTask(c.number, 'Moved and ready', user))
    await evaluated(w2)
    expect(st.told).toEqual([expect.stringContaining('Moved and ready')])
    await disposeWorkspaceService(w2)
  })

  it('a project renamed while Hive runs keeps its watches: a change to the card still wakes its agent (#508)', async () => {
    const { w, path, alpha } = await open()
    fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    const gamma = join(path, 'gamma')
    // Tried again while Windows holds the folder a moment (#1365: EPERM under load, Hive's own watchers or a scanner).
    await moveFolder(alpha, gamma)
    const st = fake(gamma)
    // Once Hive's project ids have the folder by its new name (they're read again a second on, #508), not after a time.
    await vi.waitFor(async () => expect((await w.projectIds()).byPath.has(gamma.toLowerCase())).toBe(true), { timeout: HUNG_MS })
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Ready', user))
    await evaluated(w)
    expect(st.told).toEqual([expect.stringContaining(`#${c.number}`)])
    expect(st.told[0]).toContain('Ready')
    await disposeWorkspaceService(w)
  })

  it("a watch that can't be saved isn't reported as started, nor a cancel that can't be saved as done", async () => {
    const { w, path, alpha } = await open()
    fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    const before = savedOf(path)
    // A full disk: every save of the watches fails.
    let tries = 0
    storeTestHooks.failSave = (store) => store === 'watches' && ++tries > 0
    try {
      await expect(watches.cancelWatch(w, alpha, 'a1')).rejects.toThrow(/Could not cancel/)
      expect(watches.watchFor(alpha, 'a1')).not.toBeNull()
      await expect(watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['verdict'] })).rejects.toThrow(/Could not save/)
      expect(watches.watchFor(alpha, 'a1')?.changes).toEqual(['comment'])
      // Both were saves that failed, and what is saved is as it was.
      expect(tries).toBe(2)
      expect(savedOf(path)).toEqual(before)
    } finally {
      storeTestHooks.failSave = null
    }
    await disposeWorkspaceService(w)
  })
  /** A gate a hook can wait at: `ready` once something reached it, `release()` lets it go on. */
  const gate = () => {
    let release!: () => void
    let entered!: () => void
    const opened = new Promise<void>((r) => (release = r))
    const ready = new Promise<void>((r) => (entered = r))
    return { release: () => release(), ready, wait: async () => (entered(), await opened) }
  }

  it('a save under way when the workspace closes fails with nothing saved: the watch fails, what was saved is as it was (#1018)', async () => {
    const { w, path, alpha } = await open()
    fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    // A first watch saved normally, so there is something saved to keep.
    await watches.registerWatch(w, alpha, 'a2', { cards: [c.number], changes: ['comment'] })
    const before = savedOf(path)
    expect(before).toHaveLength(1)
    const other = join(path, '..', `closed-${n}`)
    mkdirSync(other, { recursive: true })
    const g = gate()
    let held = false
    // The change waits after reading its card, before it is saved; the workspace closes meanwhile.
    watches.testHooks.afterRead = async () => {
      if (held) return
      held = true
      await g.wait()
    }
    try {
      const registering = watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['verdict'] })
      await g.ready
      await w.open(other)
      g.release()
      await expect(registering).rejects.toThrow(/closed/)
      expect(savedOf(path)).toEqual(before)
      expect(existsSync(join(path, '.combwork', 'watches.json'))).toBe(false)
    } finally {
      g.release()
      watches.testHooks.afterRead = undefined
      await disposeWorkspaceService(w)
    }
  })

  it("a damaged file that can't be set aside is left as it is and nothing is saved over it", async () => {
    const { w, path, alpha } = await open()
    fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    const file = join(path, '.combwork', 'watches.json')
    writeFileSync(file, '{ damaged original')
    watches.testHooks.rename = async () => {
      throw Object.assign(new Error('file locked'), { code: 'EACCES' })
    }
    try {
      await expect(watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })).rejects.toThrow(/couldn't be set aside/)
      expect(readFileSync(file, 'utf8')).toBe('{ damaged original')
    } finally {
      watches.testHooks.rename = undefined
    }
    // Once it can be set aside, it is, and the watch is kept.
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    expect(readdirSync(join(path, '.combwork')).some((f) => f.startsWith('watches.json.damaged-'))).toBe(true)
    expect(watches.watchFor(alpha, 'a1')).not.toBeNull()
    await disposeWorkspaceService(w)
    // The locked file is tried 20 times with a growing pause (about 2.2 s): more than the default 5 s on a loaded machine.
  }, 20_000)

  it("a watches file that can't be read is an error, not \"no watches\"; one too big is set aside", async () => {
    const { w, path, alpha } = await open()
    fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    const file = join(path, '.combwork', 'watches.json')
    mkdirSync(join(file, 'inside'), { recursive: true })
    await expect(watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })).rejects.toThrow(/Could not read the card watches/)
    expect(existsSync(join(file, 'inside'))).toBe(true)
    rmSync(file, { recursive: true })
    // One byte over the limit: read only up to it, and set aside.
    writeFileSync(file, `{"version":1,"watches":[],"invalid":["${'x'.repeat(1024 * 1024)}"]}`)
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    expect(readdirSync(join(path, '.combwork')).some((f) => f.startsWith('watches.json.too-big-'))).toBe(true)
    expect(savedOf(path)).toHaveLength(1)
    await disposeWorkspaceService(w)
  })

  it('the limits hold when a watch is made: at most 500 (replacing one is fine), no file too big to read back; overflow is kept', async () => {
    const { w, path, alpha } = await open()
    fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    const one = savedOf(path)[0]
    // 501 saved (a hand edit, or an older build): 500 are used, the 501st is kept aside as it was.
    const many = Array.from({ length: 501 }, (_, i) => ({ ...one, id: `w${i}`, agentId: `a${i + 1}` }))
    await putSaved(path, many)
    watches.forgetWatches(w)
    await expect(watches.registerWatch(w, alpha, 'new', { cards: [c.number], changes: ['comment'] })).rejects.toThrow(/500 card watches/)
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['verdict'] })
    expect(savedOf(path)).toHaveLength(500)
    expect(storeMeta(path, 'watches', 'invalid')).toEqual([many[500]])
    await disposeWorkspaceService(w)
  })

  it('a wake typed and received is never typed again, even when saving its end fails (the tick saves it later; read back, its delivery says it was received)', async () => {
    const { w, path, alpha } = await open()
    const st = fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    // Every save after the line is typed fails.
    let failing = false
    ;(sessions as unknown as { sendPrompt: unknown }).sendPrompt = async (_p: string, _id: string, text: string, guard?: () => void) => {
      guard?.()
      st.typed.push(text)
      st.prompts++
      st.status = 'working'
      // From the moment it is typed: its agent reads it at once, and the save of the watch's end (in the background) fails.
      failing = true
      st.told.push(await follow(alpha, 'a1', text))
    }
    storeTestHooks.failSave = (store) => failing && store === 'watches'
    try {
      await inWorkspace(w, () => tasks.commentTask(c.number, 'Ready', user))
      await evaluated(w)
      expect(st.typed).toHaveLength(1)
      // What is saved still has the watch, with the delivery it was handed over as: received, so read back it has ended.
      expect(savedOf(path)[0].fired.delivery).toBe('m1')
      expect((await deliveries.deliveriesOf(alpha, 'a1')).map((r) => r.state)).toEqual(['received'])
      watches.forgetWatches(w)
      st.status = 'watching'
      await vi.waitFor(() => expect(watches.watchFor(alpha, 'a1')).toBeNull(), { timeout: HUNG_MS })
      await evaluated(w)
      await watches.tick()
      expect(st.typed).toHaveLength(1)
      expect(watches.watchFor(alpha, 'a1')).toBeNull()
      // Saving works again: the tick saves the watches without it.
      failing = false
      await watches.tick()
      expect(savedOf(path)).toEqual([])
    } finally {
      storeTestHooks.failSave = null
      await disposeWorkspaceService(w)
    }
  })

  it("a wake isn't typed if Hive can't first save the delivery it is handed over as; it is tried again", async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Ready', user))
    let fail = false
    // Saving the delivery fails (every save of the watches, while it does).
    storeTestHooks.failSave = (store) => fail && store === 'watches'
    try {
      st.status = 'working'
      await evaluated(w)
      fail = true
      st.status = 'watching'
      await watches.tick()
      expect(st.typed).toEqual([])
      expect(watches.watchFor(alpha, 'a1')).not.toBeNull()
      fail = false
      await watches.tick()
      expect(st.typed).toHaveLength(1)
    } finally {
      storeTestHooks.failSave = null
      await disposeWorkspaceService(w)
    }
  })
  const keptAside = (path: string) => readdirSync(join(path, '.combwork')).filter((f) => f.startsWith('watches.json.kept-aside-'))

  it('a watch taken near the 1 MB limit can still fire, be typed and end: entries kept aside move out to make room', async () => {
    const { w, path, alpha } = await open()
    const st = fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    // The watches 20 bytes under the limit (measured as their file's text), most of it an entry kept aside (not a watch).
    const seed = { version: 1, watches: savedOf(path), invalid: [''] }
    const seedBytes = Buffer.byteLength(JSON.stringify(seed, null, 2) + '\n')
    seed.invalid[0] = 'x'.repeat(1024 * 1024 - 20 - seedBytes)
    expect(watches.savedFileBytes(seed.watches, seed.invalid)).toBe(1024 * 1024 - 20)
    await putSaved(path, seed.watches, seed.invalid)
    watches.forgetWatches(w)
    const answer = await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    expect(answer).toHaveProperty('watching')
    // The entry moved, whole, to a file of its own.
    const aside = keptAside(path)
    expect(aside).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(path, '.combwork', aside[0]), 'utf8')).invalid).toEqual(seed.invalid)
    await inWorkspace(w, () => tasks.commentTask(c.number, 'Ready', user))
    await evaluated(w)
    expect(st.typed).toHaveLength(1)
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    // And its limit, the same way.
    st.status = 'watching'
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['verdict'] })
    await watches.tick(Date.now() + 121 * 60_000)
    expect(st.typed).toHaveLength(2)
    expect(st.told[1]).toMatch(/No change/)
    await disposeWorkspaceService(w)
  })

  it('watches read back too big for each to end: the last ones move to a file of their own; a new one that cannot fit is refused', async () => {
    const { w, path, alpha } = await open()
    fake(alpha)
    const cards: number[] = []
    for (let i = 0; i < 20; i++) cards.push((await inWorkspace(w, () => tasks.createTask({ title: `C${i}`, project: 'alpha' }, user))).number)
    await watches.registerWatch(w, alpha, 'a1', { cards, changes: ['comment'] })
    const one = savedOf(path)[0]
    // As many watches on 20 cards each as fit in 1 MB as saved (the most Hive reads), but not at their longest (fired,
    // being typed): about 1 KB more each.
    const count = Math.floor((1024 * 1024 - 1024) / (Buffer.byteLength(JSON.stringify(one)) + 16))
    const many = Array.from({ length: count }, (_, i) => ({ ...one, id: `w${i}`, agentId: `b${String(i).padStart(3, '0')}` }))
    await putSaved(path, many)
    watches.forgetWatches(w)
    // The refusal is cheap (#321): every watch measured once (not the whole file's text again for each one set aside),
    // and each card read once for all the watches on it (not 20 cards for each of the 400). Counted (what JSON.stringify
    // writes, which cards are read while it reads the file back and refuses) and timed.
    const stringify = JSON.stringify
    let written = 0
    JSON.stringify = ((...a: Parameters<typeof JSON.stringify>) => {
      const s = stringify(...a)
      written += s?.length ?? 0
      return s
    }) as typeof JSON.stringify
    const reads: number[] = []
    watches.testHooks.cardRead = (c) => reads.push(c)
    try {
      await expect(watches.registerWatch(w, alpha, 'zzzz', { cards, changes: ['comment'] })).rejects.toThrow(/Too many card watches/)
      await evaluated(w)
    } finally {
      JSON.stringify = stringify
      delete watches.testHooks.cardRead
    }
    // The work counted, not timed (#570): before #321 this refusal took 2.3–2.5 s idle because it measured the watches
    // again and again (JSON.stringify) and read each card once for every watch on it. A time limit failed on a loaded
    // machine with the fix in (2.6 s); the bytes measured and the reads below count that work on any machine.
    expect(written).toBeLessThan(8 * 1024 * 1024)
    // A few reads a card (the registration, each check of the watches), not one for each of the 400 watches on it.
    for (const c of cards) expect(reads.filter((x) => x === c).length, `#${c} read`).toBeLessThanOrEqual(6)
    // The saved watches are rewritten without them by the tick.
    await watches.tick()
    const kept = savedOf(path)
    const aside = keptAside(path)
    expect(aside).toHaveLength(1)
    const moved = JSON.parse(readFileSync(join(path, '.combwork', aside[0]), 'utf8')).watches
    // Nothing lost: every watch is in one file or the other, the last ones moved.
    expect(kept.length + moved.length).toBe(count)
    expect(moved.at(-1).agentId).toBe(`b${String(count - 1).padStart(3, '0')}`)
    expect(watches.savedFileBytes(kept, storeMeta<unknown[]>(path, 'watches', 'invalid') ?? [])).toBeLessThanOrEqual(1024 * 1024)
    // Replacing one of them is still fine.
    await watches.registerWatch(w, alpha, kept[0].agentId, { cards, changes: ['verdict'] })
    await disposeWorkspaceService(w)
  })

  it("the watches file's size, measured watch by watch as its limit is checked (#321), is its text's exactly", () => {
    const one = { id: 'a1b2c3', projectPath: 'C:\\ws\\alpha', agentId: 'a1', cond: { cards: [1, 2], changes: ['comment'] }, marks: { 1: { column: 'doing', comment: 0, verdict: 0, agent: '', archived: false } }, since: '2026-10-08T00:00:00.000Z', limitMinutes: 120, limitAt: '2026-10-08T02:00:00.000Z' }
    const odd = { ...one, id: 'ffff00', agentId: 'b🐝', fired: { line: '[CW] "quoted" ünïcødé\nline', at: '2026-10-08T01:00:00.000Z', cards: [], sending: '2026-10-08T01:00:01.000Z' }, released: [{ number: 3, why: 'blocked', detail: null }] }
    const text = (ws: object[], invalid: unknown[]) => Buffer.byteLength(JSON.stringify({ version: 1, watches: ws, ...(invalid.length ? { invalid } : {}) }, null, 2) + '\n')
    for (const ws of [[], [one], [one, odd], Array.from({ length: 30 }, (_, i) => ({ ...odd, id: `w${i}` }))])
      for (const invalid of [[], [{ junk: true }, 'text', 42]]) expect(watches.savedFileBytes(ws, invalid), `${ws.length} watches, ${invalid.length} invalid`).toBe(text(ws, invalid))
  })

  it('a watcher keeps "Quit when agents finish" waiting only while another agent works on a card it watches', async () => {
    const { w, alpha } = await open()
    fake(alpha)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, user))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['verdict'] })
    const st = { projectPath: alpha, agentId: 'a1', status: 'watching', watch: watches.watchFor(alpha, 'a1') } as never
    const keeps = async (patch: Parameters<typeof tasks.updateTask>[1]) => {
      await inWorkspace(w, () => tasks.updateTask(c.number, patch, user))
      await evaluated(w)
      return watches.watchKeepsQuitWaiting(st)
    }
    expect(await keeps({ column: 'todo' })).toBeNull()
    expect(await keeps({ column: 'doing', agent: '' })).toBeNull()
    expect(await keeps({ column: 'doing', agent: 'a1' })).toBeNull()
    expect(await keeps({ column: 'doing', agent: 'a2' })).toMatch(/^Waiting for #/)
    expect(await keeps({ column: 'review', agent: 'a2' })).toMatch(/^Waiting for #/)
    expect(await keeps({ column: 'done' })).toBeNull()
    // Not watching: never.
    expect(watches.watchKeepsQuitWaiting({ ...(st as object), status: 'finished' } as never)).toBeNull()
    await disposeWorkspaceService(w)
  })
})

// The Assistant woken from a card watch while lanes run (#402): the line says to watch them all again, kept whole.
describe("the lanes-running tail of the Assistant's wake", () => {
  const bytes = (x: string) => Buffer.byteLength(JSON.stringify(x))
  it('is added once, after the line', () => {
    const line = '[CW] #1 is in Doing. Your card watch has ended: carry on.'
    expect(withLanesTail(line)).toBe(line + lanesRunningTail())
    expect(withLanesTail(withLanesTail(line))).toBe(line + lanesRunningTail())
    // #726: a card outside the lanes goes in the same watch.
    expect(lanesRunningTail()).toMatch(/one lane watch, with any card outside them as cards \(cw_wait_for_tasks with lanes \["all"\], cards, wake; run-lanes\)/)
  })
  it('a long line is cut to make room: the tail is always whole, and the line fits', () => {
    const out = withLanesTail('[CW] ' + 'x'.repeat(2000))
    expect(out.endsWith('…' + lanesRunningTail())).toBe(true)
    expect(bytes(out)).toBeLessThanOrEqual(WAKE_MAX_BYTES)
  })
})

describe("a card's history read by its lines' messages, not their words (dialects, HI-2437)", () => {
  // A line written since #845 keeps its message (whatText): watches read that, so a line's English (here made up, as a
  // dialect might word it) never decides. A line from before, with only its English, is read by that English.
  const line = (m: number, id: string, values?: Record<string, string | number>, what = '(worded otherwise)', by = 'B') => ({ at: at(m), by, what, whatText: { id, ...(values ? { values } : {}) } })

  it('moves, returns and verdicts by id', () => {
    const moved = cardOf({ column: 'review', history: [line(10, 'tasks.history.moved', { column: 'doing' }), line(11, 'tasks.history.movedTop', { column: 'review' })] })
    expect(movedIntoSince(moved, 'review', at(9))).toBe(true)
    expect(movedIntoSince(moved, 'doing', at(9))).toBe(true)
    expect(movedIntoSince(moved, 'passed', at(9))).toBe(false)
    // English that reads as a move, on a line whose message isn't one: not a move.
    expect(movedIntoSince(cardOf({ history: [line(10, 'tasks.history.toProject', { project: 'Review' }, 'Moved to Review')] }), 'review', at(9))).toBe(false)
    // Placed before another card in a column, or Nth in it: not a move into it (as their English never read as one).
    expect(movedIntoSince(cardOf({ history: [line(10, 'tasks.history.movedBeforeIn', { column: 'review', before: '#3' })] }), 'review', at(9))).toBe(false)
    expect(movedIntoSince(cardOf({ column: 'review', history: [line(10, 'tasks.history.returned', { round: 2 })] }), 'review', at(9))).toBe(true)
    const verdict = cardOf({ history: [line(5, 'tasks.history.reviewFailed', undefined, 'Review passed')] })
    expect(markOf(verdict).verdict).toBe(Date.parse(at(5)))
    expect(markOf(cardOf({ history: [line(5, 'tasks.history.description', undefined, 'Review passed')] })).verdict).toBe(0)
    // Its round: the failures since it last passed, by id.
    const failed = cardOf({ column: 'review', history: [line(1, 'tasks.history.reviewPassed', undefined, 'x'), line(2, 'tasks.history.reviewFailed', undefined, 'y'), line(3, 'tasks.history.moved', { column: 'review' }), line(4, 'tasks.history.reviewFailed', undefined, 'z')] })
    expect(returnRound(failed)).toBe(3)
    expect(wakeAbout(cardOf({ column: 'review', history: [line(4, 'tasks.history.reviewFailed'), line(5, 'tasks.history.returned', { round: 4 })] }), ['column'], 'a1').returned).toBe(4)
  })

  it('requests, decisions and loop steps by id, also in a wait that compares marks', () => {
    const cond = { changes: ['verdict' as const, 'column' as const] }
    expect(handoffsSince(cardOf({ history: [line(3, 'tasks.history.reviewerRequest', { text: 'logs?' })] }), at(2), cond)).toEqual(['request'])
    expect(handoffsSince(cardOf({ history: [line(3, 'tasks.history.decisionChanged', { decision: 'a', was: 'b' })] }), at(2), cond)).toEqual(['decision'])
    expect(handoffsSince(cardOf({ history: [line(3, 'tasks.history.loopStep', { step: 'design', text: 't' })] }), at(2), cond)).toEqual(['step'])
    expect(handoffsSince(cardOf({ history: [line(3, 'tasks.history.builderReply', { text: 't' })] }), at(2), cond)).toEqual(['step'])
    expect(handoffsSince(cardOf({ history: [line(3, 'tasks.history.labels', { labels: 'x' }, 'Asked the builder: "logs?"')] }), at(2), cond)).toEqual([])
  })

  it('a line from before #845 is still read by its English', () => {
    expect(movedIntoSince(cardOf({ history: [{ at: at(10), by: 'B', what: 'Returned for review, round 2' }] }), 'review', at(9))).toBe(true)
    expect(handoffsSince(cardOf({ history: [{ at: at(3), by: 'B', what: 'Recorded a decision: "x"' }] }), at(2), { changes: ['verdict'] })).toEqual(['decision'])
  })
})
