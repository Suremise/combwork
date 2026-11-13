// HI-3108: a repository's merge.ff (false, only) never stops Combwork's own merges. A squash says --ff (it makes no
// merge commit, so the setting has nothing to say about it), and a merge commit --no-ff: the Merge dialog's, into the
// checked-out branch and into one checked out nowhere, and the merge queue's, each with the target moved on since the
// work left it. From hunt 7's probe (HG1), which found 7 of these 16 refused.
import { execFileSync } from 'child_process'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorktree, mergeWorktree } from '../../src/main/worktrees'
import { B1, GIT_HEAVY_MS, moved, setup, sh, type Env } from './harness'
import { preset, type WorkflowOptions } from '../../src/shared/workflow/options'
import { tempDir } from '../tempDir'

const run = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

/** main moved on since cw/a left it (diverged); release, checked out nowhere, at main's head too. merge.ff set to `ff`. */
async function repo(ff: string) {
  const root = tempDir('cw-merge-ff-')
  const project = join(root, 'project')
  run(root, 'init', '-q', '-b', 'main', project)
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.invalid'], ['core.autocrlf', 'false'], ['merge.ff', ff]]) run(project, 'config', k, v)
  writeFileSync(join(project, 'f.txt'), 'base\n')
  run(project, 'add', '-A')
  run(project, 'commit', '-qm', 'base')
  const a = { path: join(root, 'wt', 'a'), branch: 'cw/a', base: 'main' }
  await createWorktree(project, a.path, a.branch, 'main')
  writeFileSync(join(a.path, 'a.txt'), 'A\n')
  run(a.path, 'add', '-A')
  run(a.path, 'commit', '-qm', 'work A')
  writeFileSync(join(project, 'm.txt'), 'main moved\n')
  run(project, 'add', '-A')
  run(project, 'commit', '-qm', 'main moves on')
  run(project, 'branch', 'release')
  return { project, a }
}

describe("the Merge dialog with the repository's merge.ff (HI-3108)", () => {
  for (const ff of ['only', 'false'])
    for (const squash of [true, false])
      for (const target of [undefined, 'release']) {
        it(`merge.ff=${ff}, ${squash ? 'squash' : 'merge commit'}, ${target ? 'into a branch checked out nowhere' : 'into the checked-out branch'} (the target moved on)`, async () => {
          const { project, a } = await repo(ff)
          const res = await mergeWorktree(project, a, { squash, message: 'M', ...(target ? { target } : {}) })
          expect(res).toMatchObject({ ok: true })
          const into = target ?? 'main'
          // The work is there; a squash is one commit of one parent, a merge commit two.
          expect(run(project, 'show', `${into}:a.txt`)).toBe('A')
          expect(run(project, 'rev-list', '--parents', '-n', '1', into).split(' ').length).toBe(squash ? 2 : 3)
          expect(run(project, 'status', '--porcelain')).toBe('')
        })
      }
})

function work(folder: string, files: Record<string, string>, message: string): void {
  for (const [f, text] of Object.entries(files)) writeFileSync(join(folder, f), text)
  sh(folder, 'add', '-A')
  sh(folder, '-c', 'user.name=Combwork Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', message)
}

describe("the merge queue with the repository's merge.ff (HI-3108)", () => {
  for (const ff of ['only', 'false'])
    for (const style of ['squash', 'merge'] as const)
      for (const strict of [false, true]) {
        it(`merge.ff=${ff}, style ${style}${strict ? ', strict' : ''}, the target moved on since the card started`, { timeout: GIT_HEAVY_MS }, async () => {
          const o: Partial<WorkflowOptions> = { style, strict }
          const e = (env = setup({ ...preset('git', 'pair'), review: 'none', noSelfReview: false, preChecks: [], mergeChecks: [], ...o }))
          sh(e.project, 'checkout', '-q', '--detach')
          sh(e.project, 'config', 'merge.ff', ff)
          const card = e.wf.createCard({ title: 'A' })
          const s = await e.wf.start(card.key, B1)
          moved(s)
          work(s.data!.folder as string, { 'a.txt': 'A\n' }, 'A')
          moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
          sh(e.project, 'checkout', '-q', 'main')
          work(e.project, { 'other.txt': 'x\n' }, 'moved on')
          sh(e.project, 'checkout', '-q', '--detach')
          const out = await e.queue().drain('main')
          expect(out.map((x) => x.outcome)).toContain('integrated')
          expect(sh(e.project, 'show', 'main:a.txt').trim()).toBe('A')
        })
      }
})
