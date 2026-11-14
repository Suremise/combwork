// HI-2050: the git processes one card's queue step runs, counted, each style bounded at what it runs now (a merge 27 to
// 26): the identity in one git. git answers every read (Darren's decision: no reads from the `.git` files beside it). What
// each step checks still runs: the checks' bracket (status before and after), where the target is checked out (outside the lock
// and again under it), the conditions under the lock, and the branch read after the swap. The second card of two is
// counted (the queue's folder reused, as it is from then on), with the target moved meanwhile in the project.
import { afterEach, describe, expect, it } from 'vitest'
import { B1, commit, GIT_HEAVY_MS, moved, R1, setup, type Env } from './harness'
import { preset, type WorkflowOptions } from '../../src/shared/workflow/options'
import { gitTree, type QueueConfig } from '../../src/main/workflow/mergeQueue'
import { git, gitTestHooks } from '../../src/main/git'

let env: Env | null = null
afterEach(() => {
  gitTestHooks.started = undefined
  env?.close()
  env = null
})

/** Each git a two-card drain runs, in order: `read` (the platform's, through src/main/git) or the queue's own. */
async function drained(o: Partial<WorkflowOptions>): Promise<{ kind: 'read' | 'queue'; line: string }[]> {
  const e = (env = setup({ ...preset('git', 'team', { quick: [], tests: [] }), preChecks: [], mergeChecks: ['quick'], commands: { quick: 'quick' }, okBefore: { mode: 'never', labels: [] }, ...o }))
  for (const title of ['A', 'B']) {
    const card = e.wf.createCard({ title })
    const s = await e.wf.start(card.key, B1)
    moved(s)
    commit(s.data!.folder as string, { [`${title}.txt`]: `${title}\n` }, `${card.key}: ${title}`)
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  }
  commit(e.project, { 'other.txt': 'meanwhile\n' }, 'meanwhile')
  const ran: { kind: 'read' | 'queue'; line: string }[] = []
  // The queue's own git starts src/main/git's too: counted once, as the queue's.
  let own = false
  gitTestHooks.started = (_cwd, args) => {
    if (!own) ran.push({ kind: 'read', line: args.join(' ') })
  }
  const cfg: Partial<QueueConfig> = {
    git: (cwd, args, opts) => {
      ran.push({ kind: 'queue', line: args.join(' ') })
      own = true
      const p = opts ? gitTree(cwd, args, opts) : git(cwd, args)
      own = false
      return p
    }
  }
  expect((await e.queue(cfg).drain('main')).map((x) => x.outcome)).toEqual(['integrated', 'integrated'])
  gitTestHooks.started = undefined
  return ran
}

/** The second card's: from just after the first card's advance (main's ref moved, and the branch read after it). */
function second(ran: { kind: string; line: string }[]): { kind: string; line: string }[] {
  let at = ran.findIndex((r) => r.kind === 'queue' && r.line.startsWith('update-ref refs/heads/main ')) + 1
  if (ran[at]?.line.startsWith('symbolic-ref')) at++
  expect(at).toBeGreaterThan(0)
  return ran.slice(at)
}

describe("the git a queue step runs for a card (HI-2050)", () => {
  // Measured before HI-2050 (6e11c0403), card 2: merge 27, squash 28, rebase 34, strict 38. HI-3111 adds one git a round
  // (whether any onbranch condition is set: the target's signing read in the queue's folder only when one is).
  // [what, options, at most, the commits the queue makes for it (each read back by its own git)]
  const styles: [string, Partial<WorkflowOptions>, number, number][] = [
    ['a merge', {}, 27, 1],
    ['a squash', { style: 'squash' }, 28, 1],
    ['Rebase and fast-forward', { style: 'rebase' }, 34, 1],
    ['strict, the card behind its target', { strict: true }, 38, 2]
  ]
  for (const [what, o, most, commits] of styles)
    // GIT_HEAVY_MS: two cards' whole course and drain, about 70 git processes in all.
    it(`${what}: at most ${most} git, every check of the step still read`, { timeout: GIT_HEAVY_MS }, async () => {
      const card = second(await drained(o))
      expect(card.length).toBeLessThanOrEqual(most)
      const count = (re: RegExp, kind?: string): number => card.filter((r) => re.test(r.line) && (!kind || r.kind === kind)).length
      // The identity in one git; each commit the queue made read back by git.
      expect(count(/^config --null --get-regexp \^user/)).toBe(1)
      expect(count(/^config user\./)).toBe(0)
      expect(count(/^rev-parse --verify -q HEAD$/)).toBe(commits)
      // The checks' bracket: the folder's status before the checks and after them.
      expect(count(/^status --porcelain=v2 /, 'read')).toBe(2)
      // Where the target is checked out: outside the lock, and again under it.
      expect(count(/^worktree list --porcelain$/, 'read')).toBe(2)
      // Under the lock: the folder's branch and the target's head (one git), what is staged, what the merge changes, what
      // the user has edited; then the swap, and the branch read again after it.
      expect(count(/^rev-parse HEAD refs\/heads\/main --symbolic-full-name HEAD$/)).toBe(1)
      expect(count(/^diff --cached --name-only -z /, 'queue')).toBe(1)
      expect(count(/^diff --name-only -z --no-renames /, 'queue')).toBe(1)
      expect(count(/^status --porcelain -z /, 'queue')).toBe(1)
      expect(count(/^read-tree -m -u /, 'queue')).toBe(1)
      const swap = card.findIndex((r) => r.line.startsWith('update-ref refs/heads/main '))
      expect(swap).toBeGreaterThan(0)
      expect(card[swap + 1]?.line).toBe('symbolic-ref -q HEAD')
    })
})
