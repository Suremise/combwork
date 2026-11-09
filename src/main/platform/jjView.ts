// jj's state as its files show it, read synchronously with no process (SPEC §16.3.6 port 3, HI-2796's J3): the operation
// heads, a workspace's checkout record and, for a colocated repository, Git's own state beside it. Each read is bounded
// (a count, a size) and anything it can't read in full or doesn't recognise is null: unknown, never an empty or equal
// token (rule 3). jj's files are no API, so nothing here is trusted on its own: a head read here pins every jj read
// (jjReads.ts), and a pinned answer is used only while the heads are still the ones it was pinned to.
//
// Why the heads come from the files (HI-2796's probe on the pinned 0.47.1): with two operation heads (two commands that
// started from one operation), any jj command that loads the repository, `--ignore-working-copy` reads included, writes
// a merge operation to reconcile them. `--at-op <id>` never does. So a read first takes the heads from here, and with
// more than one it reads nothing through jj.

import { closeSync, existsSync, opendirSync, openSync, readSync, statSync } from 'original-fs'
import { isAbsolute, join, resolve } from 'path'
import { snapshotLine } from './snapshotLine'

/** At most this many operation heads are listed; more is unknown (a repository that busy is never settled). */
export const OP_HEADS_MAX = 64
/** A checkout record, or a Git marker file read here, is at most this long. */
export const RECORD_MAX = 4096
/** At most this many entries are walked under a Git refs folder; more is unknown. */
export const REFS_MAX = 1024
/** An operation id: 128 lower-case hex digits (jj 0.47.1's BLAKE2b-512). */
export const OP_ID = /^[0-9a-f]{128}$/
/** A commit id in a Git-backed store: 40 lower-case hex digits. */
export const COMMIT_ID = /^[0-9a-f]{40}$/
/** A change id: 32 letters k–z (jj's reverse hex). */
export const CHANGE_ID = /^[k-z]{32}$/

/** A workspace's checkout record: the operation it was last brought to, and its name. */
export interface Checkout {
  op: string
  workspace: string
}

/**
 * The repository's operation heads (`<jjRepo>/op_heads/heads`, a file per head named by its id), sorted; null when the
 * folder can't be read, holds a name that isn't an operation id, or more than OP_HEADS_MAX entries.
 */
export function readOpHeads(jjRepo: string): string[] | null {
  let dir
  try {
    dir = opendirSync(join(jjRepo, 'op_heads', 'heads'))
  } catch {
    return null
  }
  const heads: string[] = []
  try {
    for (let e = dir.readSync(); e; e = dir.readSync()) {
      if (heads.length === OP_HEADS_MAX || !OP_ID.test(e.name)) return null
      heads.push(e.name)
    }
  } catch {
    return null
  } finally {
    try {
      dir.closeSync()
    } catch {
      // closed already
    }
  }
  return heads.length ? heads.sort() : null
}

/** The single operation head, or null: none readable, or several (unsettled: nothing is read through jj then). */
export function singleHead(jjRepo: string): string | null {
  const h = readOpHeads(jjRepo)
  return h && h.length === 1 ? h[0] : null
}

/** A file's first RECORD_MAX + 1 bytes, or null when it can't be read; longer than RECORD_MAX is null too. */
function readBounded(file: string): Buffer | null {
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return null
  }
  try {
    const buf = Buffer.alloc(RECORD_MAX + 1)
    let n = 0
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, null)
      if (!got) break
      n += got
    }
    return n > RECORD_MAX ? null : buf.subarray(0, n)
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/** A protobuf varint at `at`: its value and the next offset, or null when truncated or longer than 5 bytes. */
function varint(b: Buffer, at: number): { v: number; next: number } | null {
  let v = 0
  for (let i = 0; i < 5; i++) {
    if (at + i >= b.length) return null
    const byte = b[at + i]
    v += (byte & 0x7f) * 2 ** (7 * i)
    if (!(byte & 0x80)) return { v, next: at + i + 1 }
  }
  return null
}

/**
 * Parses a checkout record (jj 0.47.1's `working_copy/checkout`, a protobuf message): field 2, the operation id (64
 * bytes, shown as hex), and field 3, the workspace's name (UTF-8, at most 255 bytes). Field 1 (an older commit id) is
 * allowed and ignored. Any other field or wire type, a duplicate, a truncated value or a missing field: null.
 */
export function parseCheckout(b: Buffer): Checkout | null {
  let op: string | null = null
  let workspace: string | null = null
  let seen1 = false
  let at = 0
  while (at < b.length) {
    const tag = varint(b, at)
    if (!tag || tag.v % 8 !== 2) return null
    const field = Math.floor(tag.v / 8)
    const len = varint(b, tag.next)
    if (!len || len.next + len.v > b.length) return null
    const value = b.subarray(len.next, len.next + len.v)
    at = len.next + len.v
    if (field === 1 && !seen1) seen1 = true
    else if (field === 2 && op === null && value.length === 64) op = value.toString('hex')
    else if (field === 3 && workspace === null && value.length > 0 && value.length <= 255) {
      const name = value.toString('utf8')
      if (Buffer.from(name, 'utf8').compare(value) !== 0 || /[\0\r\n]/.test(name)) return null
      workspace = name
    } else return null
  }
  return op !== null && workspace !== null ? { op, workspace } : null
}

/** A workspace's checkout record (`<workspace .jj>/working_copy/checkout`), or null when unreadable or malformed. */
export function readCheckout(workspaceJj: string): Checkout | null {
  const b = readBounded(join(workspaceJj, 'working_copy', 'checkout'))
  return b ? parseCheckout(b) : null
}

/** A small text file's first line (a Git marker), or null. */
function firstLine(file: string): string | null {
  const b = readBounded(file)
  if (!b || b.includes(0)) return null
  return b.toString('utf8').split(/\r?\n/)[0]
}

/** The Git folder of a colocated workspace's root: its `.git` folder, or the one its `.git` file names; null otherwise. */
export function workspaceGitDir(root: string): string | null {
  const dot = join(root, '.git')
  try {
    if (statSync(dot).isDirectory()) return dot
  } catch {
    return null
  }
  const line = firstLine(dot)
  const m = line ? /^gitdir: (.+)$/.exec(line.trim()) : null
  if (!m) return null
  return isAbsolute(m[1]) ? resolve(m[1]) : resolve(root, m[1])
}

/** A path's size and time as a stat line ("gone" when it isn't there). */
function statOf(path: string): string {
  try {
    const s = statSync(path)
    return snapshotLine(path, s)
  } catch {
    return snapshotLine(path, null)
  }
}

/** Every entry under a refs folder with its size and time, at most REFS_MAX; null past that or unreadable. */
function refsTree(dir: string, out: string[]): boolean {
  if (!existsSync(dir)) return true
  const walk = (d: string): boolean => {
    let h
    try {
      h = opendirSync(d)
    } catch {
      return false
    }
    try {
      for (let e = h.readSync(); e; e = h.readSync()) {
        if (out.length >= REFS_MAX) return false
        const p = join(d, e.name)
        out.push(statOf(p))
        if (e.isDirectory() && !walk(p)) return false
      }
      return true
    } catch {
      return false
    } finally {
      try {
        h.closeSync()
      } catch {
        // closed already
      }
    }
  }
  return walk(dir)
}

/**
 * A colocated workspace's Git state, as a token (null when unreadable): its HEAD's content, its index, its HEAD reflog's
 * and the store's (each entry grows them, so a checkout and back still shows), the store's packed refs and every ref and
 * ref log under `refs/heads` and `logs/refs/heads`, and an operation under way. A plain `git commit` or checkout that jj
 * hasn't imported yet moves this while the operation heads stay where they were (HI-2796's probe).
 */
export function gitState(gitDir: string, store: string): string | null {
  const head = firstLine(join(gitDir, 'HEAD'))
  if (head === null) return null
  const parts = [`HEAD:${head}`, statOf(join(gitDir, 'index')), statOf(join(gitDir, 'logs', 'HEAD')), statOf(join(store, 'logs', 'HEAD')), statOf(join(store, 'packed-refs'))]
  for (const m of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) parts.push(existsSync(join(gitDir, m)) ? m : '')
  const refs: string[] = []
  if (!refsTree(join(store, 'refs', 'heads'), refs) || !refsTree(join(store, 'logs', 'refs', 'heads'), refs)) return null
  return [...parts, ...refs].join('\n')
}

/** What the view reads of a workspace: the shared repository, the workspace's own `.jj`, its root and whether Git sees it. */
export interface ViewOf {
  jjRepo: string
  workspace: string
  root: string
  store: string
  colocated: boolean
}

/** A workspace's bounded state at one moment: the single head, its checkout record and (colocated) Git's state. */
export interface ViewNow {
  head: string
  checkout: Checkout
  git: string | null
}

/**
 * The view now, or null when any part can't be read: not exactly one head, a malformed checkout record, or a colocated
 * workspace whose Git state can't be read.
 */
export function viewNow(v: ViewOf): ViewNow | null {
  const head = singleHead(v.jjRepo)
  if (!head) return null
  const checkout = readCheckout(v.workspace)
  if (!checkout) return null
  let git: string | null = null
  if (v.colocated) {
    const gd = workspaceGitDir(v.root)
    git = gd ? gitState(gd, v.store) : null
    if (git === null) return null
  }
  // The heads again: a head that moved while the rest was read would mix two moments.
  if (singleHead(v.jjRepo) !== head) return null
  return { head, checkout, git }
}

/** Two views are the same moment: the same head, checkout record and Git state. */
export const sameView = (a: ViewNow | null, b: ViewNow | null): boolean => !!a && !!b && a.head === b.head && a.checkout.op === b.checkout.op && a.checkout.workspace === b.checkout.workspace && a.git === b.git

/**
 * The evidence an intent's fence compares (R3.4), read on main: bounded parts only, never a walk of the working tree.
 * The working tree's content is covered by the boundary (jjBoundary.ts): what a card submits is the immutable commit a
 * boundary recorded, which a later write can't change. Null when the view can't be read.
 */
export function jjFingerprint(v: ViewOf): string | null {
  const now = viewNow(v)
  return now ? `jj|${now.head}|${now.checkout.op}|${now.checkout.workspace}|${now.git ?? ''}` : null
}
