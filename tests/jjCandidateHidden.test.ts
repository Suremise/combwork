// A jj candidate whose reviewed commit the user rewrote (HI-3100, from HI-3058's hunt): `jj describe` hides the reviewed
// commit R behind its rewritten self. A candidate step still naming R refuses it, unwritten, and when the rewrite lands
// right before jj runs the write (the narrow window), jj's own resolution of `R & ::visible_heads()` makes it fail
// having made nothing: never R brought back beside its rewritten self (divergent), never a stray candidate or scratch
// commit left. Controls (not rewritten) still get their candidate. On the real jj, through the candidate step; skipped
// without the fetched jj (npm run jj:fetch).

import { execFile } from 'child_process'
import { writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { gitHistory } from '../src/main/platform/gitHistory'
import { jjCandidateStep, type JjAttemptEntry, type JjCandidateFingerprint } from '../src/main/platform/jjCandidateStep'
import type { JjCandidatePoint, JjCandidateStyle } from '../src/main/platform/jjCandidates'
import { jjContextOf } from '../src/main/platform/jjDetect'
import type { RunResult } from '../src/main/platform/repoContext'
import { harness, jjExe } from './jjWorkspaceHarness'

let n = 0
const token = (): string => `t${Date.now().toString(36)}${(++n).toString(36)}`

describe.skipIf(!jjExe)('a candidate after the user rewrote the reviewed commit (HI-3100)', { timeout: 180_000 }, () => {
  const h = harness()
  const gitOn =
    (store: string) =>
    (args: readonly string[]): Promise<RunResult> =>
      new Promise((done) => {
        execFile('git', ['--git-dir', store, ...args], { env: h.env, windowsHide: true, encoding: 'buffer', timeout: 60_000 }, (e, out, err) => {
          const code = e ? (typeof (e as { code?: unknown }).code === 'number' ? (e as unknown as { code: number }).code : -1) : 0
          done({ ok: !e, out: out.toString('utf8'), buf: out, err: err.toString('utf8'), code })
        })
      })

  /** A target, a card's reviewed commit R in its slot, Combwork's control; `when`: the user's rewrite of R, if any. */
  async function world(style: JjCandidateStyle, label: string, strict = false) {
    const { repo } = h.repo(`rw${style}${label}`, true)
    const top = resolve(repo, '..')
    writeFileSync(join(repo, 'f.txt'), 'a\n')
    h.jj(repo, 'commit', '-m', 'f')
    h.jj(repo, 'bookmark', 'set', 'main', '-r', '@-')
    const fBase = h.id(repo, 'main')
    h.jj(repo, 'new', 'main')
    writeFileSync(join(repo, 't.txt'), 'target\n')
    h.jj(repo, 'commit', '-m', 'target')
    h.jj(repo, 'bookmark', 'set', 'main', '-r', '@-')
    const T = h.id(repo, 'main')
    const builder = join(top, 'builder')
    h.jj(repo, 'workspace', 'add', builder, '--name', 'builder', '-r', fBase, '--colocate')
    writeFileSync(join(builder, 'k.txt'), 'card\n')
    h.jj(builder, 'commit', '-m', 'card work')
    const R = h.id(builder, 'builder@-')
    const control = join(top, 'control')
    h.jj(repo, 'workspace', 'add', control, '--name', 'control', '--sparse-patterns', 'empty', '-r', 'root()', '--colocate')
    const d = await jjContextOf(control, h.runner)
    if (!('jj' in d)) throw new Error('not detected')
    const read = (...args: string[]): string => h.jj(repo, '--ignore-working-copy', ...args)
    const visible = (): string => read('log', '--no-graph', '-r', '::visible_heads() ~ root()', '-T', 'change_id.short(8) ++ " " ++ commit_id.short(8) ++ (if(divergent, " DIVERGENT", "")) ++ " [" ++ description.first_line() ++ "]|"')
    const reword = (): void => void h.jj(repo, 'describe', '-r', R, '-m', 'card work, reworded by the user after review')
    const entries: JjAttemptEntry[] = []
    const fp: JjCandidateFingerprint = { cycle: 1, submission: 1, revision: R, base: fBase, key: null, commit: R, target: 'main', ruleset: 'r', style, strict, generation: 1, approval: 2 }
    const step = (hook?: (p: JjCandidatePoint) => void): ReturnType<typeof jjCandidateStep> =>
      jjCandidateStep(
        {
          j4: { runner: h.runner, view: { jjRepo: d.jj.jjRepo, store: d.jj.store }, folder: control, git: gitOn(d.jj.store), lock: (fn) => fn(), sameChange: (a, b) => gitHistory.sameChange(d.jj.store, a, b), ...(hook ? { hook } : {}) },
          targetHead: async () => ({ head: T }),
          entries: () => structuredClone(entries),
          save: async (e) => {
            const i = entries.findIndex((x) => x.record.attempt === e.record.attempt)
            if (i >= 0) entries[i] = structuredClone(e)
            else entries.push(structuredClone(e))
          },
          still: () => true,
          token
        },
        'HI-1',
        fp,
        { message: 'HI-1: candidate', updateMessage: 'HI-1: update' }
      )
    return { R, visible, reword, step, entries }
  }

  /** Nothing the attempt made is left visible, and nothing divergent. */
  const clean = (log: string): void => {
    expect(log).not.toContain('DIVERGENT')
    expect(log).not.toContain('HI-1: candidate')
    expect(log).not.toContain('combwork scratch')
  }

  for (const style of ['merge', 'squash', 'rebase'] as JjCandidateStyle[]) {
    it(`${style}, control (not rewritten): a candidate offered`, async () => {
      const w = await world(style, 'c')
      expect('offer' in (await w.step())).toBe(true)
      expect(w.visible()).not.toContain('DIVERGENT')
    })

    it(`${style}, R rewritten before the step: refused unwritten, again on the next step; nothing divergent or left`, async () => {
      const w = await world(style, 'y')
      w.reword()
      const first = await w.step()
      expect('offer' in first).toBe(false)
      clean(w.visible())
      expect('offer' in (await w.step())).toBe(false)
      clean(w.visible())
      expect(w.entries.filter((e) => e.state === 'kept')).toEqual([])
    })
  }

  for (const style of ['merge', 'squash', 'rebase'] as JjCandidateStyle[]) {
    const point = (style === 'merge' ? 'run:merge' : style === 'squash' ? 'run:scratch' : 'run:duplicate') as JjCandidatePoint
    it(`${style}, R rewritten right before jj runs its write (after every check): jj makes nothing; nothing divergent or left`, async () => {
      const w = await world(style, 'r')
      let done = false
      const first = await w.step((p) => {
        if (p === point && !done) {
          done = true
          w.reword()
        }
      })
      expect(done).toBe(true)
      expect('offer' in first).toBe(false)
      clean(w.visible())
      expect('offer' in (await w.step())).toBe(false)
      clean(w.visible())
      expect(w.entries.filter((e) => e.state === 'kept')).toEqual([])
    })
  }
  // HR1's round 1: strict's update (the target past the card's base, so it runs first) through the same guarded writes:
  // merge's by a merge, squash's by a rebase (its duplicate). A rebase candidate runs no update.
  for (const style of ['merge', 'squash'] as JjCandidateStyle[]) {
    it(`strict ${style}, R rewritten right before jj runs the update's write: jj makes nothing; nothing divergent or left`, async () => {
      const w = await world(style, 's', true)
      let done = false
      const first = await w.step((p) => {
        if (p === 'run:update' && !done) {
          done = true
          w.reword()
        }
      })
      expect(done).toBe(true)
      expect('offer' in first).toBe(false)
      clean(w.visible())
      expect(w.visible()).not.toContain('HI-1: update')
      expect('offer' in (await w.step())).toBe(false)
      clean(w.visible())
      expect(w.entries.filter((e) => e.state === 'kept')).toEqual([])
    })
  }
})
