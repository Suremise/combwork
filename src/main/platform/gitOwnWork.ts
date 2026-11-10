// The own-work proof's Git implementation (HI-2821; HI-2753's rules (a) to (d), which retargetCard.ts describes): the
// code retargetCard.ts ran itself before, moved here unchanged behind the history port's `ownWork`, so no git command is
// added, dropped or reordered and every refusal says the same (tests/retargetTraces.test.ts holds the commands).

import { readFile } from 'original-fs/promises'
import { join } from 'path'
import { git } from '../git'
import * as G from './git'
import type { OwnWorkAsk, OwnWorkProof, OwnWorkRefusal } from './history'
import { isUnknown } from './types'
import { samePlace } from '../places'

const ZERO = /^0+$/
const FULL = /^[0-9a-f]{40}([0-9a-f]{24})?$/

/** `git rev-list --count` of the revisions given (on stdin: any number of negatives). */
async function count(repo: string, revs: readonly string[], firstParent = false): Promise<number | { what: string }> {
  const r = await git(repo, ['rev-list', '--count', ...(firstParent ? ['--first-parent'] : []), '--stdin'], 1024 * 1024, revs.join('\n') + '\n')
  const n = r.ok ? Number(r.out.trim()) : NaN
  return Number.isInteger(n) ? n : { what: r.err || 'git rev-list failed' } // i18n-ignore: a reason's detail (English, as git's)
}

/** Whether `R ^target` and `R ^base` are the same commits (the reviewed change brings the same into the new target). */
async function sameCommits(repo: string, R: string, base: string, target: string): Promise<boolean | { what: string }> {
  const a = await count(repo, [R, `^${target}`])
  const b = await count(repo, [R, `^${base}`])
  const both = await count(repo, [R, `^${target}`, `^${base}`])
  if (typeof a !== 'number') return a
  if (typeof b !== 'number') return b
  if (typeof both !== 'number') return both
  return a === b && b === both
}

/**
 * Rules (a) to (d) for `head` against `target` (both full ids): null when every commit `head` would bring into `target`
 * is provably the line's own; else the rule that failed, or why it couldn't be read. `reflog`: rule (c) too (the line's
 * head; a reviewed revision behind it needs only the others).
 */
async function proveOwn(repo: string, p: OwnWorkAsk): Promise<OwnWorkRefusal | null> {
  const n = await count(repo, [p.head, `^${p.target}`])
  if (typeof n !== 'number') return { why: 'cantCheck', detail: n.what } // i18n-ignore: a reason's code, said in words where it is shown
  // Nothing to bring: every commit of it is in the target already.
  if (n === 0) return null
  // (a) on the first-parent chain.
  const fp = await count(repo, [p.head, `^${p.target}`], true)
  if (typeof fp !== 'number') return { why: 'cantCheck', detail: fp.what } // i18n-ignore: a reason's code, said in words where it is shown
  if (fp !== n) return { why: 'notInTarget', rule: 'firstParent', detail: `${n - fp} of its commits came in by a merge of history ${p.target} doesn't have` } // i18n-ignore: a reason's detail (English)
  // (b) reachable from no other ref, nor another worktree's detached HEAD.
  const refs = await git(repo, ['for-each-ref', '--format=%(objectname) %(refname)'])
  if (!refs.ok) return { why: 'cantCheck', detail: refs.err } // i18n-ignore: a reason's code, said in words where it is shown
  const others = new Set<string>()
  for (const l of refs.out.split(/\r?\n/)) {
    const at = l.indexOf(' ')
    if (at < 0) continue
    const oid = l.slice(0, at)
    if (!p.own(l.slice(at + 1)) && FULL.test(oid)) others.add(oid)
  }
  const wts = await git(repo, ['worktree', 'list', '--porcelain'])
  if (!wts.ok) return { why: 'cantCheck', detail: wts.err } // i18n-ignore: a reason's code, said in words where it is shown
  for (const block of wts.out.split(/\r?\n\r?\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1]
    const head = /^HEAD ([0-9a-f]+)$/m.exec(block)?.[1]
    if (path && head && /^detached$/m.test(block) && !samePlace(path, p.folder) && FULL.test(head)) others.add(head)
  }
  const alone = await count(repo, [p.head, `^${p.target}`, ...[...others].map((o) => `^${o}`)])
  if (typeof alone !== 'number') return { why: 'cantCheck', detail: alone.what } // i18n-ignore: a reason's code, said in words where it is shown
  if (alone !== n) return { why: 'notInTarget', rule: 'otherRef', detail: `${n - alone} of its commits are on another branch, tag or worktree` } // i18n-ignore: a reason's detail (English)
  // (c) the line's reflog, from its creation.
  const anchors = [...p.anchors]
  if (p.reflog) {
    const log = await reflogOf(repo, p.line)
    if ('what' in log) return { why: 'cantCheck', rule: 'reflog', detail: log.what } // i18n-ignore: a reason's code, said in words where it is shown
    const seen = new Set<string>([log.created])
    anchors.push(log.created)
    for (const e of log.entries) {
      if (!OWN_ENTRY.test(e.msg) && !seen.has(e.new)) {
        if (/^rebase/i.test(e.msg)) return { why: 'notInTarget', rule: 'reflog', detail: `its branch was rebased (${e.msg})` } // i18n-ignore: a reason's detail (English)
        const inT = await G.isAncestor(repo, e.new, p.target)
        if (isUnknown(inT)) return { why: 'cantCheck', rule: 'reflog', detail: inT.what } // i18n-ignore: a reason's code, said in words where it is shown
        if (!inT) return { why: 'notInTarget', rule: 'reflog', detail: `its branch was moved to ${e.new.slice(0, 7)} (${e.msg || 'update-ref'}), which ${p.target} doesn't have` } // i18n-ignore: a reason's detail (English)
      }
      seen.add(e.new)
    }
  }
  // (d) every point it was created or started from is in the target.
  for (const a of new Set(anchors)) {
    const inT = await G.isAncestor(repo, a, p.target)
    if (isUnknown(inT)) return { why: 'cantCheck', rule: 'anchor', detail: inT.what } // i18n-ignore: a reason's code, said in words where it is shown
    if (!inT) return { why: 'notInTarget', rule: 'anchor', detail: `it was started from ${a.slice(0, 7)}, which ${p.target} doesn't have` } // i18n-ignore: a reason's detail (English)
  }
  return null
}

/** A reflog entry that is the line's own work (rule c): a commit of any kind, a cherry-pick, a revert, a real merge. */
const OWN_ENTRY = /^(commit( \((amend|merge|initial)\))?|cherry-pick|revert): |^merge [^:]+: Merge made by /

/**
 * A line's reflog (its file in the repository's common git dir), oldest first: its creation's commit and every later
 * entry. Read only when its first entry is the creation (an old id of zeros): one cut short (expired, or the line older
 * than its log) can't prove where it began, nor can a repository whose refs aren't files.
 */
export async function reflogOf(repo: string, line: string): Promise<{ created: string; entries: { old: string; new: string; msg: string }[] } | { what: string }> {
  const common = await G.commonDirFast(repo)
  if (isUnknown(common)) return { what: common.what }
  let text: string
  try {
    text = await readFile(join(common, 'logs', 'refs', 'heads', ...line.split('/')), 'utf8')
  } catch {
    return { what: `no reflog for ${line}` } // i18n-ignore: a reason's detail (English)
  }
  const entries: { old: string; new: string; msg: string }[] = []
  for (const l of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]+) ([0-9a-f]+) [^\t]*\t?(.*)$/.exec(l)
    if (m) entries.push({ old: m[1], new: m[2], msg: m[3] })
  }
  const first = entries.shift()
  if (!first || !ZERO.test(first.old) || !FULL.test(first.new)) return { what: `the reflog of ${line} doesn't start where it was created` } // i18n-ignore: a reason's detail (English)
  return { created: first.new, entries }
}

export const gitOwnWork: OwnWorkProof = { prove: proveOwn, sameCommits }
