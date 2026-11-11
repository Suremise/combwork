// The merge queue's git commands, traced (HI-2790, R7 of the 1.4.0 Git refactor; SPEC §16.3.6's rule 1 and port 4): a
// card's whole drain in each candidate style (merge, squash, rebase and fast-forward, linear or rebased; strict's update
// by merge and by rebase; a branch's own message), and the failures a candidate cleans up after (a conflict, a hook), run
// the same git commands (folder, argv, order: the queue's own git and the platform's reads) as the code before the
// integration port. The expected traces were recorded at the revision before the port (960c805f7) with
// `CW_RECORD_QUEUE_TRACES=1 npx vitest run tests/workflow/queueTraces.test.ts`, into tests/fixtures/queueTraces.json; a
// trace that differs is a behaviour change, which an R card never makes (a change found needed is its own card).
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { B1, commit, GIT_HEAVY_MS, moved, R1, setup, sh, type Env } from './harness'
import { preset, type WorkflowOptions } from '../../src/shared/workflow/options'
import { gitTree, type QueueConfig } from '../../src/main/workflow/mergeQueue'
import { git, gitTestHooks } from '../../src/main/git'

const FIXTURE = join(__dirname, '..', 'fixtures', 'queueTraces.json')
const RECORD = process.env.CW_RECORD_QUEUE_TRACES === '1'
const recorded: Record<string, string[]> = {}
const expected = (): Record<string, string[]> => (existsSync(FIXTURE) ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string[]>) : {})

let env: Env | null = null
afterEach(() => {
  gitTestHooks.started = undefined
  env?.close()
  env = null
})
afterAll(() => {
  if (RECORD) writeFileSync(FIXTURE, `${JSON.stringify({ ...expected(), ...recorded }, null, 2)}\n`)
})

const team = (o: Partial<WorkflowOptions> = {}): Env => (env = setup({ ...preset('git', 'team', { quick: [], tests: [] }), preChecks: [], mergeChecks: [], commitMessage: 'combwork', okBefore: { mode: 'never', labels: [] }, ...o }))

/** A card approved and queued: started by B1, its files committed, submitted, passed by R1. */
async function queued(e: Env, files: Record<string, string> = { 'src/c.txt': 'c\n' }, more?: Record<string, string>): Promise<string> {
  const card = e.wf.createCard({ title: 'Change' })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  const folder = s.data!.folder as string
  commit(folder, files, `${card.key}: change`)
  if (more) commit(folder, more, `${card.key}: more`)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  moved(await e.wf.startReview(card.key, R1))
  moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  return card.key
}

/**
 * One drain of `main`, traced: each git command in order, `<folder> :: <args>`, the queue's own (`q`) and the platform's
 * reads (`r`, through src/main/git), with the test's folders, full ids and the card's key made stable.
 */
async function drained(e: Env): Promise<{ trace: string[]; outcomes: string[] }> {
  const ran: string[] = []
  const at = resolve(e.home).toLowerCase().replace(/\\/g, '/')
  const stable = (s: string): string =>
    s
      .replace(/\\/g, '/')
      .toLowerCase()
      .split(at)
      .join('<home>')
      .replace(/\b[0-9a-f]{40}\b/g, '<id>')
      .replace(/\b[a-z]{2,}-\d+\b/g, '<card>')
  // The queue's own git through src/main/git starts its hook too: each counted once, as the queue's.
  const own: string[] = []
  const line = (cwd: string, args: readonly string[]): string => stable(`${resolve(cwd)} :: ${args.join(' ')}`)
  gitTestHooks.started = (cwd, args) => {
    const l = line(cwd, args)
    const i = own.indexOf(l)
    if (i >= 0) own.splice(i, 1)
    else ran.push(`r ${l}`)
  }
  const cfg: Partial<QueueConfig> = {
    git: (cwd, args, opts) => {
      const l = line(cwd, args)
      ran.push(`q ${l}`)
      if (!opts) own.push(l)
      return opts ? gitTree(cwd, args, opts) : git(cwd, args)
    }
  }
  try {
    const outcomes = (await e.queue(cfg).drain('main')).map((x) => x.outcome)
    return { trace: ran, outcomes }
  } finally {
    gitTestHooks.started = undefined
  }
}

/** Checks (or, recording, keeps) the trace of one drain. */
function same(step: string, trace: string[]): void {
  if (RECORD) recorded[step] = trace
  else expect(trace, step).toEqual(expected()[step])
}

/** A hook script (git runs it with its sh), LF only. */
function hook(e: Env, name: string, body: string): void {
  const p = join(e.project, '.git', 'hooks', name)
  writeFileSync(p, `#!/bin/sh\n${body}\n`)
  chmodSync(p, 0o755)
}

describe("the merge queue's git commands through the integration port (HI-2790)", { timeout: GIT_HEAVY_MS }, () => {
  it('a merge commit, the target moved meanwhile', async () => {
    const e = team()
    await queued(e)
    commit(e.project, { 'other.txt': 'meanwhile\n' }, 'meanwhile')
    const d = await drained(e)
    expect(d.outcomes).toEqual(['integrated'])
    same('merge', d.trace)
  })

  it('a squash', async () => {
    const e = team({ style: 'squash' })
    await queued(e)
    const d = await drained(e)
    expect(d.outcomes).toEqual(['integrated'])
    same('squash', d.trace)
  })

  it("the branch's own message", async () => {
    const e = team({ commitMessage: 'branch' })
    await queued(e, { 'src/c.txt': 'c\n' }, { 'src/d.txt': 'd\n' })
    const d = await drained(e)
    expect(d.outcomes).toEqual(['integrated'])
    same('branch message', d.trace)
  })

  it('rebase and fast-forward: a linear card already on top lands as it is', async () => {
    const e = team({ style: 'rebase' })
    await queued(e)
    const d = await drained(e)
    expect(d.outcomes).toEqual(['integrated'])
    same('rebase on top', d.trace)
  })

  it('rebase and fast-forward: rebased onto a target that moved', async () => {
    const e = team({ style: 'rebase' })
    await queued(e)
    commit(e.project, { 'other.txt': 'meanwhile\n' }, 'meanwhile')
    const d = await drained(e)
    expect(d.outcomes).toEqual(['integrated'])
    same('rebase onto', d.trace)
  })

  it("strict: brought up to date by merging the target in", async () => {
    const e = team({ strict: true })
    await queued(e)
    commit(e.project, { 'other.txt': 'meanwhile\n' }, 'meanwhile')
    const d = await drained(e)
    expect(d.outcomes).toEqual(['integrated'])
    same('strict merge', d.trace)
  })

  it('strict, squash: brought up to date by a rebase', async () => {
    const e = team({ strict: true, style: 'squash' })
    await queued(e)
    commit(e.project, { 'other.txt': 'meanwhile\n' }, 'meanwhile')
    const d = await drained(e)
    expect(d.outcomes).toEqual(['integrated'])
    same('strict squash', d.trace)
  })

  it('a conflict: its files read, the merge aborted and the folder put back', async () => {
    const e = team()
    await queued(e, { 'src/x.txt': 'card\n' })
    commit(e.project, { 'src/x.txt': 'target\n' }, 'the target adds the same file')
    const d = await drained(e)
    expect(d.outcomes).toEqual(['returned'])
    same('conflict', d.trace)
  })

  it('strict: a conflict updating it', async () => {
    const e = team({ strict: true })
    await queued(e, { 'src/x.txt': 'card\n' })
    commit(e.project, { 'src/x.txt': 'target\n' }, 'the target adds the same file')
    const d = await drained(e)
    expect(d.outcomes).toEqual(['returned'])
    same('strict conflict', d.trace)
  })

  it('rebase: a conflict rebasing it', async () => {
    const e = team({ style: 'rebase' })
    await queued(e, { 'src/x.txt': 'card\n' })
    commit(e.project, { 'src/x.txt': 'target\n' }, 'the target adds the same file')
    const d = await drained(e)
    expect(d.outcomes).toEqual(['returned'])
    same('rebase conflict', d.trace)
  })

  it("a commit-msg hook that refuses: the card returned, the folder cleaned", async () => {
    const e = team()
    await queued(e)
    hook(e, 'commit-msg', 'echo "message rejected by policy" >&2\nexit 1')
    const d = await drained(e)
    expect(d.outcomes).toEqual(['returned'])
    same('hook', d.trace)
  })

  it('squash: a pre-commit hook that refuses its commit', async () => {
    const e = team({ style: 'squash' })
    await queued(e)
    hook(e, 'pre-commit', 'echo "policy" >&2\nexit 1')
    const d = await drained(e)
    expect(d.outcomes).toEqual(['returned'])
    same('squash hook', d.trace)
  })

  it('two cards: the queue\'s folder reused for the second', async () => {
    const e = team()
    await queued(e, { 'a.txt': 'a\n' })
    await queued(e, { 'b.txt': 'b\n' })
    const d = await drained(e)
    expect(d.outcomes).toEqual(['integrated', 'integrated'])
    same('two cards', d.trace)
    sh(e.project, 'rev-parse', 'main')
  })
})
