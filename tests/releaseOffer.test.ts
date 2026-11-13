// HI-3155 (design s11, HR1's notes): a project's release offer on real Git, through a real workspace.
// - What it offers: Work merges into released → move to the next version when it exists and isn't released, else start
//   it; released Other branches → taken off when nothing uses them, kept (named with their uses) when something does;
//   either part alone; nothing released → none.
// - Followed per workspace: read when what it rests on moves (the next branch made, a use freed, the options changed, an
//   unknown read becoming readable), not otherwise; after Start the next version, the cleanup-only offer.
// - Acting on it: Not now only on the current offer, kept, an old dismissal's undo never clearing a newer one; a save or
//   the Assistant's setting change with an offer id refused once the offer changed (nothing written), applied when current.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

// The real Git reads, with a switch making `released` unknown (an unreadable repository, for the recovery case).
const flaky = vi.hoisted(() => ({ unknown: false, watchNull: false }))
vi.mock('../src/main/platform/releaseReadsPorts', async (orig) => {
  const real = await orig<typeof import('../src/main/platform/releaseReadsPorts')>()
  return {
    ...real,
    releaseReadsOf: (p: Parameters<typeof real.releaseReadsOf>[0]) => {
      const r = real.releaseReadsOf(p)
      if (!r) return r
      return { ...r, released: async (path: string, line: string) => (flaky.unknown ? { unknown: true, what: 'stubbed', whatText: undefined } : r.released(path, line)), watch: async (path: string, line: string) => (flaky.watchNull ? null : r.watch(path, line)) }
    }
  }
})

const base = tempDir('cw-releaseoffer-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { offerFor, currentOffer, releaseOffers, dismissOffer, dismissedOffer, undoDismiss, startReleaseOffers, stopReleaseOffers, releaseOfferTiming, releaseOfferTestHooks, lookAgain } = await import('../src/main/workflow/releaseOffer')
const { offerOptions } = await import('../src/shared/releaseOffer')
const { setWorkflowOptions, workflowForm } = await import('../src/main/workflow/optionsForm')
const { startNextVersion } = await import('../src/main/workflow/nextVersion')
const { applySetting, entryOf, SettingRefused } = await import('../src/main/settingsTools')
const { preset } = await import('../src/shared/workflow/options')

type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
beforeAll(() => {
  releaseOfferTiming.tickMs = 150
  startReleaseOffers()
})
afterAll(async () => {
  stopReleaseOffers()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})
afterEach(() => {
  flaky.unknown = false
  flaky.watchNull = false
})

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
const user = { kind: 'user' } as const
let n = 0

/** Releases `line` (made from main if missing): a commit on it, an annotated tag v<line>, and it merged into main. */
function release(repo: string, line: string): void {
  if (!git(repo, 'branch', '--list', line)) git(repo, 'branch', line)
  git(repo, 'checkout', '-q', line)
  writeFileSync(join(repo, `${line}.txt`), `${line}\n`)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', line)
  git(repo, 'tag', '-a', `v${line}`, '-m', `release ${line}`)
  git(repo, 'checkout', '-q', 'main')
  git(repo, 'merge', '-q', '--no-ff', '-m', `release ${line}`, line)
}

/**
 * A Pair project working on 1.4.0 (released), listing 1.3.0 (released) and, unless `noNext`, 1.5.0 (made, not released)
 * as other branches work can merge into.
 */
async function project(o: { noNext?: boolean; released?: boolean } = {}): Promise<{ w: WS; repo: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  mkdirSync(join(ws, '.combwork'), { recursive: true })
  git(ws, 'init', '-q', '-b', 'main', repo)
  git(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  if (o.released !== false) {
    release(repo, '1.3.0')
    release(repo, '1.4.0')
  } else {
    git(repo, 'branch', '1.3.0')
    git(repo, 'branch', '1.4.0')
  }
  if (!o.noNext) git(repo, 'branch', '1.5.0')
  const { platform: _p, ...pair } = preset('git', 'pair')
  const others = o.noNext ? ['1.3.0'] : ['1.3.0', '1.5.0']
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents: [{ id: 'b1', name: 'B1', workflowRole: 'either' }], workflow: { platform: 'git', preset: 'pair', options: { ...pair, target: '1.4.0', otherTargets: others } } }))
  const w = createWorkspaceService()
  await w.open(ws)
  await w.refresh()
  opened.push(w)
  return { w, repo }
}

/** Polls (a condition, never a time) for the followed project's offer to be `ok`. */
async function offerSoon(w: WS, repo: string, ok: (o: ReturnType<typeof currentOffer>) => boolean, ms = 20_000) {
  const end = Date.now() + ms
  for (;;) {
    const o = currentOffer(w, repo)
    if (ok(o)) return o
    if (Date.now() > end) throw new Error(`offer never came: ${JSON.stringify(o)}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}
const readsOf = (repo: string): number => releaseOfferTestHooks.reads.get(repo.toLowerCase()) ?? 0

describe('what a release offer offers (HI-3155)', () => {
  it('Work merges into released, the next version made: move it there; a released, unused Other branch: take it off', async () => {
    const { w, repo } = await project()
    const o = (await offerFor(w, repo, 'p'))!
    expect(o.move).toMatchObject({ target: '1.4.0', tag: 'v1.4.0', into: 'main', moveTo: '1.5.0', startNext: null })
    expect(o.move?.date).toBeTruthy()
    expect(o.cleanup).toEqual({ drop: [{ branch: '1.3.0', tag: 'v1.3.0' }], kept: [] })
    // What Move… fills in: 1.5.0, the release joining the others (work on it finishes there), 1.3.0 off.
    expect(offerOptions(o)).toEqual({ target: '1.5.0', otherTargets: ['1.4.0'] })
  })

  it('the next version not made: start it; a released Other branch a card uses: kept, named with its use', async () => {
    const { w, repo } = await project({ noNext: true })
    const card = await inWorkspace(w, () => tasks.createTask({ title: 'On 1.3.0', project: 'p', target: '1.3.0' }, user))
    const o = (await offerFor(w, repo, 'p'))!
    expect(o.move).toMatchObject({ moveTo: null, startNext: '1.5.0' })
    expect(o.cleanup?.drop).toEqual([])
    expect(o.cleanup?.kept).toEqual([{ branch: '1.3.0', tag: 'v1.3.0', uses: [expect.stringContaining(String(card.number))] }])
  })

  it('nothing released: no offer', async () => {
    const { w, repo } = await project({ released: false })
    expect(await offerFor(w, repo, 'p')).toBeNull()
  })
})

describe('a release offer followed (HI-3155)', () => {
  it('read when what it rests on moves, not otherwise: the next branch made turns Start into Move', async () => {
    const { w, repo } = await project({ noNext: true })
    await offerSoon(w, repo, (o) => o?.move?.startNext === '1.5.0')
    // Ticks with nothing moved read nothing more.
    const before = readsOf(repo)
    const until = Date.now() + 1000
    while (Date.now() < until) await new Promise((r) => setTimeout(r, 100))
    expect(readsOf(repo)).toBe(before)
    git(repo, 'branch', '1.5.0')
    await offerSoon(w, repo, (o) => o?.move?.moveTo === '1.5.0')
    expect(readsOf(repo)).toBeGreaterThan(before)
  })

  it('a use freed: kept becomes removable; the options changed: read again', async () => {
    const { w, repo } = await project()
    const card = await inWorkspace(w, () => tasks.createTask({ title: 'On 1.3.0', project: 'p', target: '1.3.0' }, user))
    lookAgain(repo)
    await offerSoon(w, repo, (o) => !!o?.cleanup?.kept.length)
    await inWorkspace(w, () => tasks.setTarget(card.number, null, user))
    await offerSoon(w, repo, (o) => o?.cleanup?.drop[0]?.branch === '1.3.0')
    // 1.3.0 off the list by hand: the cleanup part goes.
    const form = await workflowForm(w, repo)
    await setWorkflowOptions(w, repo, { preset: form.preset, options: { ...form.own, otherTargets: ['1.5.0'] }, base: { preset: form.preset, options: form.own } })
    await offerSoon(w, repo, (o) => !!o && !o.cleanup)
  })

  it('an unknown read offers nothing and is read again; once readable, the offer comes', async () => {
    flaky.unknown = true
    const { w, repo } = await project()
    // Read and found unknown (more than once: it stays due), never an offer on it.
    const end = Date.now() + 20_000
    while (readsOf(repo) < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
    expect(readsOf(repo)).toBeGreaterThanOrEqual(2)
    expect(currentOffer(w, repo)).toBeNull()
    flaky.unknown = false
    await offerSoon(w, repo, (o) => o?.move?.moveTo === '1.5.0')
  })

  it('Start the next version: the release joins the other branches, and its cleanup-only offer comes', async () => {
    const { w, repo } = await project({ noNext: true })
    await offerSoon(w, repo, (o) => o?.move?.startNext === '1.5.0')
    const o0 = currentOffer(w, repo)!
    await startNextVersion(w, repo, { name: '1.5.0', offer: o0.id })
    const o = await offerSoon(w, repo, (x) => !!x && !x.move)
    expect(o?.cleanup?.drop.map((d) => d.branch).sort()).toEqual(['1.3.0', '1.4.0'])
  })
})

describe('acting on a release offer (HI-3155)', () => {
  it('Not now: only the current offer; hidden and kept; an old dismissal’s undo never clears a newer one', async () => {
    const { w, repo } = await project()
    const a = (await offerSoon(w, repo, (o) => !!o))!
    await expect(dismissOffer(w, repo, 'ro-nosuch')).rejects.toThrow(/changed since it was shown/)
    const was = await dismissOffer(w, repo, a.id)
    expect(dismissedOffer(w, repo)).toBe(a.id)
    expect(releaseOffers(w)).toEqual([])
    // The offer changes (the next branch's tip moves nothing; a new release does): a new id, shown again.
    release(repo, '1.5.0')
    const b = (await offerSoon(w, repo, (o) => !!o && o.id !== a.id))!
    expect(releaseOffers(w).map((o) => o.id)).toEqual([b.id])
    await dismissOffer(w, repo, b.id)
    // Undo of the first dismissal: the one kept is the newer, so nothing is cleared.
    expect(await undoDismiss(w, repo, a.id, was)).toBe(false)
    expect(dismissedOffer(w, repo)).toBe(b.id)
    expect(await undoDismiss(w, repo, b.id, a.id)).toBe(true)
    expect(dismissedOffer(w, repo)).toBe(a.id)
  })

  it('the Assistant answers offer A after the user changed the options: refused, nothing written; the current one applies', async () => {
    const { w, repo } = await project()
    const a = (await offerSoon(w, repo, (o) => !!o))!
    // The user takes 1.3.0 off by hand: a new basis, a new offer.
    const form = await workflowForm(w, repo)
    await setWorkflowOptions(w, repo, { preset: form.preset, options: { ...form.own, otherTargets: ['1.5.0'] }, base: { preset: form.preset, options: form.own } })
    const b = (await offerSoon(w, repo, (o) => !!o && o.id !== a.id))!
    const target = entryOf('project.workflow.target')
    const err = await inWorkspace(w, () => applySetting(target, '1.5.0', repo, undefined, undefined, a.id)).catch((e) => e)
    expect(err).toBeInstanceOf(SettingRefused)
    expect((err as InstanceType<typeof SettingRefused>).status).toBe(409)
    expect((await workflowForm(w, repo)).options.target).toBe('1.4.0')
    // The window's save of offer A: refused too.
    const f = await workflowForm(w, repo)
    await expect(setWorkflowOptions(w, repo, { preset: f.preset, options: { ...f.own, ...offerOptions(a) }, base: { preset: f.preset, options: f.own } }, { offer: a.id })).rejects.toThrow(/changed since it was shown/)
    expect((await workflowForm(w, repo)).options.target).toBe('1.4.0')
    // The current offer, B: applied.
    await inWorkspace(w, () => applySetting(target, '1.5.0', repo, undefined, undefined, b.id))
    expect((await workflowForm(w, repo)).options.target).toBe('1.5.0')
  })

  it('HR2’s round 1: a release made with the options unchanged refuses every action on the old offer at once, nothing written', async () => {
    const { w, repo } = await project()
    const a = (await offerSoon(w, repo, (o) => o?.move?.moveTo === '1.5.0'))!
    // 1.5.0 (its head already in main) tagged now: released, before any look of the follower's.
    git(repo, 'tag', '-a', 'v1.5.0', '-m', 'release 1.5.0', '1.5.0')
    const target = entryOf('project.workflow.target')
    const err = await inWorkspace(w, () => applySetting(target, '1.5.0', repo, undefined, undefined, a.id)).catch((e) => e)
    expect((err as InstanceType<typeof SettingRefused>).status).toBe(409)
    const f = await workflowForm(w, repo)
    await expect(setWorkflowOptions(w, repo, { preset: f.preset, options: { ...f.own, ...offerOptions(a) }, base: { preset: f.preset, options: f.own } }, { offer: a.id })).rejects.toThrow(/changed since it was shown/)
    await expect(dismissOffer(w, repo, a.id)).rejects.toThrow(/changed since it was shown/)
    expect((await workflowForm(w, repo)).options.target).toBe('1.4.0')
    expect(dismissedOffer(w, repo)).toBeNull()
  })

  it('a use changed with the options unchanged: Start the next version from the old offer refused, no branch made; an unknown read refuses too', async () => {
    const { w, repo } = await project({ noNext: true })
    const a = (await offerSoon(w, repo, (o) => o?.move?.startNext === '1.5.0'))!
    await inWorkspace(w, () => tasks.createTask({ title: 'On 1.3.0', project: 'p', target: '1.3.0' }, user))
    await expect(startNextVersion(w, repo, { name: '1.5.0', offer: a.id })).rejects.toThrow(/changed since it was shown/)
    expect(git(repo, 'branch', '--list', '1.5.0')).toBe('')
    const b = (await offerSoon(w, repo, (o) => !!o?.cleanup?.kept.length))!
    flaky.unknown = true
    const err = await inWorkspace(w, () => applySetting(entryOf('project.workflow.otherTargets'), [], repo, undefined, undefined, b.id)).catch((e) => e)
    expect((err as InstanceType<typeof SettingRefused>).status).toBe(409)
  })
})

describe('a release offer whose refs can’t be watched (HR2’s round 1)', () => {
  it('reads at most once a tick, never in a loop; once watchable, its checkers are made and the key holds', async () => {
    releaseOfferTiming.tickMs = 60_000
    flaky.watchNull = true
    const { w, repo } = await project()
    // Its first read (made once, at once); then nothing more for a while, whatever the follower is told.
    const until = Date.now() + 2000
    while (Date.now() < until) {
      releaseOfferTestHooks.look(repo)
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(readsOf(repo)).toBe(1)
    expect(currentOffer(w, repo)?.move?.moveTo).toBe('1.5.0')
    // Watchable again: forced once (as a workflow change would), its checkers made; an ordinary look then reads nothing.
    flaky.watchNull = false
    lookAgain(repo)
    const end = Date.now() + 20_000
    while (readsOf(repo) < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
    const now = readsOf(repo)
    for (let i = 0; i < 5; i++) {
      releaseOfferTestHooks.look(repo)
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(readsOf(repo)).toBe(now)
  })
})
