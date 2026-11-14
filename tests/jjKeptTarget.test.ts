// A jj card put back with its work kept starts on the bookmark that work is on, whatever the project's target is now
// (HI-3129, Darren's decision (a), 13 Nov): only a fresh start follows the project's new target. Its kept slot's binding
// is the proof; unproved, or the card's own Merges into or its lane naming another bookmark, the start is refused before
// any slot is lent. And the repository's bookmarks are the targets a jj card may name, read through the port. On the
// real jj, colocated and not; skipped without the fetched jj (npm run jj:fetch).

import { afterEach, describe, expect, it } from 'vitest'
import { branchExists } from '../src/main/workflow/targets'
import { registerWorkspacePort } from '../src/main/platform/workspacePorts'
import type { WorkflowConfig } from '../src/main/workflow/runtime'
import { isUnknown } from '../src/main/platform/types'
import { B1, B2, moved, refusedBy } from './workflow/harness'
import { closers, opts, started, world, type World } from './jjCardsWorld'
import { jjExe } from './jjWorkspaceHarness'

afterEach(() => {
  for (const c of closers.splice(0).reverse()) c()
  opts.target = 'main'
})

type SlotAsk = Parameters<NonNullable<WorkflowConfig['slotFor']>>[2]

/**
 * Card 1 started on main in slot-a, a commit made there, put back: its work kept in slot-a, bound to main. Then a
 * bookmark `next` made at main and the project's target changed to it. The runtime's `keptHere` names slot-a for card
 * 1 (`keptFor`, or another slot to make its binding unproved); every `slotFor` call is recorded.
 */
async function keptThenRetargeted(w: World, keptFor: 'slot-a' | 'slot-b' = 'slot-a') {
  const card = await started(w, 'kept work')
  const a = w.slots['slot-a']
  w.commitIn(a.folder, 'kept.txt', a.identity.workspace)
  moved(await w.wf.putBack(card.key, B1))
  w.h.jj(w.repo, 'bookmark', 'create', 'next', '-r', 'main')
  opts.target = 'next'
  const cfg = w.wf.cfg as { -readonly [K in keyof WorkflowConfig]: WorkflowConfig[K] }
  const asked: SlotAsk[] = []
  const lend = cfg.slotFor!
  cfg.slotFor = async (c, b, o) => {
    asked.push(o)
    return lend(c, b, o)
  }
  cfg.keptHere = async (c) => (c.id === card.id ? { slot: keptFor, folder: w.slots[keptFor].folder } : null)
  return { card, asked, binding: async () => w.port.binding(a.folder) }
}

const startedTarget = (w: World, card: number): string | null | undefined => w.wf.state(card).started?.target

describe.skipIf(!jjExe)('a jj card with kept work after the project\'s target changed (HI-3129)', { timeout: 120_000 }, () => {
  // HI-3152: why a target change leaves free jj slots alone. A slot last used on main, lent for a card on next (ahead of
  // main), is prepared at next's head: the start bases it on its card's bookmark, whatever the slot held before.
  it.each([true, false])("a slot used on main, lent for a card on next: prepared at next's head (colocated: %s)", async (colocated) => {
    const w = await world(colocated)
    const first = await started(w, 'on main')
    moved(await w.wf.putBack(first.key, B1))
    w.h.jj(w.repo, '--ignore-working-copy', 'new', '--no-edit', 'main', '-m', 'ahead')
    const ahead = w.h.jj(w.repo, '--ignore-working-copy', 'log', '--no-graph', '-r', 'latest(description(exact:"ahead\n"))', '-T', 'commit_id').trim()
    w.h.jj(w.repo, '--ignore-working-copy', 'bookmark', 'create', 'next', '-r', ahead)
    opts.target = 'next'
    const card = w.wf.createCard({ title: 'on next' })
    moved(await w.wf.start(card.key, B1))
    expect(w.wf.state(card.id).started).toMatchObject({ target: 'next', base: ahead })
    expect(await w.prepare(card.id)).toEqual({ ok: true, err: '' })
    expect(w.h.id(w.slots['slot-a'].folder, '@-')).toBe(ahead)
  })

  it.each([true, false])('starts on the bookmark its work is on; a fresh card on the new one (colocated: %s)', async (colocated) => {
    const w = await world(colocated)
    const k = await keptThenRetargeted(w)
    moved(await w.wf.start(k.card.key, B1))
    expect(startedTarget(w, k.card.id)).toBe('main')
    expect(k.asked[0]).toMatchObject({ target: 'main', kept: { slot: 'slot-a', target: 'main' } })
    // A fresh card follows the project's target now.
    const fresh = w.wf.createCard({ title: 'fresh' })
    moved(await w.wf.start(fresh.key, B2))
    expect(startedTarget(w, fresh.id)).toBe('next')
  })

  it.each([true, false])('its own Merges into naming another bookmark: refused before any slot is lent, nothing changed (colocated: %s)', async (colocated) => {
    const w = await world(colocated)
    const k = await keptThenRetargeted(w)
    const before = await k.binding()
    w.wf.store.updateCard(k.card.id, { target: 'next' })
    const r = refusedBy(await w.wf.start(k.card.key, B1), 'platform.keptOnTarget')
    expect(r.values).toMatchObject({ why: 'mismatch', slot: 'slot-a', target: 'main', now: 'next' })
    expect(k.asked).toEqual([])
    expect(await k.binding()).toEqual(before)
    expect(w.wf.state(k.card.id).stage).toBe('todo')
  })

  it.each([true, false])('its lane merging into another bookmark: refused before any slot is lent (colocated: %s)', async (colocated) => {
    const w = await world(colocated)
    const k = await keptThenRetargeted(w)
    // A lane started on the rules as they are now: its cards merge into the project's new target.
    const rules = w.wf.currentRuleset()
    w.wf.store.saveRuleset(rules)
    w.wf.store.startLane('lane-1', [k.card.id], rules.id)
    const r = refusedBy(await w.wf.start(k.card.key, B1), 'platform.keptLine')
    expect(r.values).toMatchObject({ kept: 'main', target: 'next' })
    expect(k.asked).toEqual([])
  })

  it.each([true, false])('its kept binding unproved: refused, never started on the project\'s target (colocated: %s)', async (colocated) => {
    const w = await world(colocated)
    // keptHere names a slot whose binding isn't this card's: unproved.
    const k = await keptThenRetargeted(w, 'slot-b')
    const r = refusedBy(await w.wf.start(k.card.key, B1), 'platform.keptOnTarget')
    expect(r.values).toMatchObject({ why: 'unread', slot: 'slot-b' })
    expect(k.asked).toEqual([])
    expect(w.wf.state(k.card.id).stage).toBe('todo')
  })
})

describe.skipIf(!jjExe)("a kept slot's binding read where its start records the target (HI-3129)", { timeout: 120_000 }, () => {
  it.each([true, false])("the port's heldTarget: the card's binding's target; another card's, none; another generation, none (colocated: %s)", async (colocated) => {
    const w = await world(colocated)
    const card = await started(w, 'kept work')
    const a = w.slots['slot-a']
    expect(await w.port.heldTarget!(a.folder, a.identity, card.id)).toBe('main')
    expect(await w.port.heldTarget!(a.folder, a.identity, card.id + 1)).toBeNull()
    // Another generation (the folder's .jj replaced): not this binding's any more.
    w.replaceJj(a.folder)
    expect(await w.port.heldTarget!(a.folder, a.identity, card.id)).toBeNull()
  })
})

describe.skipIf(!jjExe)("a jj project's targets: its repository's bookmarks, through the port (HI-3129)", { timeout: 120_000 }, () => {
  it.each([true, false])('lists local bookmarks, a conflicted one left out; a pick checked through the port (colocated: %s)', async (colocated) => {
    const w = await world(colocated)
    registerWorkspacePort('jj', w.port)
    w.h.jj(w.repo, 'bookmark', 'create', 'release-1', '-r', 'main')
    const lines = await w.port.targetLines!(w.repo)
    expect(isUnknown(lines)).toBe(false)
    expect(lines).toEqual(expect.arrayContaining(['main', 'release-1']))
    // A local bookmark that is neither the default nor configured: there; one that doesn't exist: not.
    expect(await branchExists(w.repo, 'release-1', 'jj')).toBe(true)
    expect(await branchExists(w.repo, 'no-such-bookmark', 'jj')).toBe(false)
    // A conflicted bookmark (two operations from the same head set it to two sibling commits; jj resolves one an
    // ancestor of the other by itself): left out of the list, and unknown if named.
    const sibling = (m: string): string => {
      w.h.jj(w.repo, '--ignore-working-copy', 'new', '--no-edit', 'main', '-m', m)
      return w.h.jj(w.repo, '--ignore-working-copy', 'log', '--no-graph', '-r', `latest(description(exact:"${m}\n"))`, '-T', 'commit_id').trim()
    }
    const left = sibling('left')
    const right = sibling('right')
    const op = w.h.jj(w.repo, '--ignore-working-copy', 'op', 'log', '--no-graph', '-n', '1', '-T', 'id').trim()
    w.h.jj(w.repo, '--at-op', op, '--ignore-working-copy', 'bookmark', 'create', 'split', '-r', left)
    w.h.jj(w.repo, '--at-op', op, '--ignore-working-copy', 'bookmark', 'create', 'split', '-r', right)
    w.h.jj(w.repo, '--ignore-working-copy', 'log', '-r', 'root()', '--no-graph', '-T', '""')
    const after = await w.port.targetLines!(w.repo)
    expect(isUnknown(after)).toBe(false)
    expect(after).not.toContain('split')
    expect(await branchExists(w.repo, 'split', 'jj')).toBe('unknown')
  })
})
