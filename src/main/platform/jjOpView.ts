// The Operations section's preview (HI-2800, J7; its design HI-2800/s12, s16 and s19, HR2's): what reverting one jj
// operation would change, worked out from the operation's whole view and never by running it. Pure: no process, no file,
// no Electron, so jj's worker thread runs it (jjWorker.ts) and the tests run it on recorded text.
//
// The view is jj 0.47.1's `debug object view` (the Rust Debug form of its `View`), and an operation is `debug object
// operation`. jj is pinned (J0: only the tested version is trusted), so this exact shape is the contract: every top-level
// field of a View is known, each one's nested shape is checked, and anything else (a field added or missing, text that
// doesn't parse, a size past the bounds) is no preview at all, never a partial one.
//
// A command (`jj op revert <id>`, for the user to run: Combwork runs nothing) is offered only when E1 to E7 all hold:
// E1 the tested jj, one operation head, the H shown; E2 one parent; E3 the whole view parsed within its bounds; E4 no
// working-copy change; E5 each Git ref or Git HEAD the operation changed is jj's own export of the jj ref it changed;
// E6 nothing it changed was changed again since (later overlap); E7 the project's workspace not stale.

import type { JjOpChange as OpChange, JjOpOverlap as OpOverlap, JjOpRefusal as OpRefusal } from '../../shared/jjViews'

/** Bounds (s16): each view's text, entries in any one dimension, commits in any one list. */
export const VIEW_TEXT_MAX = 4 * 1024 * 1024
export const VIEW_ENTRIES_MAX = 5000
export const OP_COMMITS_MAX = 200

const OP_ID = /^[0-9a-f]{128}$/
const COMMIT_ID = /^[0-9a-f]{40}$/

// ---- A Debug-form reader --------------------------------------------------------------------------------------------

/** A parsed Debug value. */
export type DNode =
  | { t: 'str'; v: string }
  | { t: 'word'; v: string }
  | { t: 'struct'; name: string; fields: [string, DNode][] }
  | { t: 'tuple'; name: string; items: DNode[] }
  | { t: 'list'; items: DNode[] }
  | { t: 'map'; entries: [DNode, DNode][] }
  | { t: 'set'; items: DNode[] }

class Malformed extends Error {}

/** Reads Rust's pretty Debug form (`{:#?}`): structs, tuple structs, maps, sets, lists, strings, words and numbers. */
export function parseDebug(text: string): DNode | null {
  let at = 0
  const n = text.length
  const ws = (): void => {
    while (at < n && (text[at] === ' ' || text[at] === '\n' || text[at] === '\r' || text[at] === '\t')) at++
  }
  const peek = (): string => (ws(), text[at] ?? '')
  const take = (c: string): void => {
    if (peek() !== c) throw new Malformed(`expected ${c} at ${at}`)
    at++
  }
  const word = (): string => {
    ws()
    const m = /^[A-Za-z_][A-Za-z0-9_]*|^-?[0-9]+/.exec(text.slice(at, at + 200))
    if (!m) throw new Malformed(`expected a word at ${at}`)
    at += m[0].length
    return m[0]
  }
  const str = (): string => {
    take('"')
    let out = ''
    while (at < n) {
      const c = text[at++]
      if (c === '"') return out
      if (c === '\\') {
        const e = text[at++]
        if (e === '"' || e === '\\' || e === "'") out += e
        else if (e === 'n') out += '\n'
        else if (e === 'r') out += '\r'
        else if (e === 't') out += '\t'
        else if (e === '0') out += '\0'
        else if (e === 'u') {
          const m = /^\{([0-9a-fA-F]{1,6})\}/.exec(text.slice(at, at + 9))
          if (!m) throw new Malformed('bad escape')
          out += String.fromCodePoint(parseInt(m[1], 16))
          at += m[0].length
        } else throw new Malformed('bad escape')
      } else out += c
    }
    throw new Malformed('unterminated string')
  }
  // A comma-separated sequence up to `close` (a trailing comma allowed).
  const seq = <T>(close: string, one: () => T): T[] => {
    const out: T[] = []
    while (peek() !== close) {
      out.push(one())
      if (peek() === ',') at++
      else if (peek() !== close) throw new Malformed(`expected , or ${close} at ${at}`)
    }
    at++
    return out
  }
  const value = (depth: number): DNode => {
    if (depth > 64) throw new Malformed('too deep')
    const c = peek()
    if (c === '"') return { t: 'str', v: str() }
    if (c === '[') {
      at++
      return { t: 'list', items: seq(']', () => value(depth + 1)) }
    }
    if (c === '{') {
      at++
      if (peek() === '}') {
        at++
        return { t: 'map', entries: [] }
      }
      const first = value(depth + 1)
      if (peek() === ':') {
        at++
        const entries: [DNode, DNode][] = [[first, value(depth + 1)]]
        if (peek() === ',') at++
        entries.push(
          ...seq('}', (): [DNode, DNode] => {
            const k = value(depth + 1)
            take(':')
            return [k, value(depth + 1)]
          })
        )
        return { t: 'map', entries }
      }
      const items = [first]
      if (peek() === ',') at++
      items.push(...seq('}', () => value(depth + 1)))
      return { t: 'set', items }
    }
    const name = word()
    if (peek() === '(') {
      at++
      return { t: 'tuple', name, items: seq(')', () => value(depth + 1)) }
    }
    if (peek() === '{') {
      at++
      return {
        t: 'struct',
        name,
        fields: seq('}', (): [string, DNode] => {
          const f = word()
          take(':')
          return [f, value(depth + 1)]
        })
      }
    }
    return { t: 'word', v: name }
  }
  try {
    const v = value(0)
    if (peek() !== '') return null
    return v
  } catch (e) {
    if (e instanceof Malformed) return null
    throw e
  }
}

/** A node's compact canonical text: equal values, equal text. */
export function canon(d: DNode): string {
  switch (d.t) {
    case 'str':
      return JSON.stringify(d.v)
    case 'word':
      return d.v
    case 'struct':
      return `${d.name}{${d.fields.map(([k, v]) => `${k}:${canon(v)}`).join(',')}}`
    case 'tuple':
      return `${d.name}(${d.items.map(canon).join(',')})`
    case 'list':
      return `[${d.items.map(canon).join(',')}]`
    case 'map':
      return `{${d.entries.map(([k, v]) => `${canon(k)}:${canon(v)}`).join(',')}}`
    case 'set':
      return `{${d.items.map(canon).join(',')}}`
  }
}

// ---- The View's shape -----------------------------------------------------------------------------------------------

/** A View's top-level fields, exactly (jj 0.47.1). */
export const VIEW_FIELDS = ['head_ids', 'local_bookmarks', 'local_tags', 'remote_views', 'git_refs', 'git_heads', 'wc_commit_ids'] as const

/** A view's entries, by key (`bookmark:main`, `wc:default`…), each value its canonical text. */
export type ViewEntries = Map<string, string>

/** `Name("text")`: a newtype around a string; its text, or null. */
const newtype = (d: DNode, name: string): string | null => (d.t === 'tuple' && d.name === name && d.items.length === 1 && d.items[0].t === 'str' ? d.items[0].v : null)

const commitId = (d: DNode): string | null => {
  const id = newtype(d, 'CommitId')
  return id !== null && COMMIT_ID.test(id) ? id : null
}

/** `Some(CommitId(..))` or `None`. */
const optionalCommit = (d: DNode): boolean => (d.t === 'word' && d.v === 'None') || (d.t === 'tuple' && d.name === 'Some' && d.items.length === 1 && commitId(d.items[0]) !== null)

/** A ref target: `Resolved(Some(CommitId) | None)` or `Conflicted([Some(CommitId) | None, …])`. */
const isTarget = (d: DNode): boolean => {
  if (d.t !== 'tuple' || d.items.length !== 1) return false
  if (d.name === 'Resolved') return optionalCommit(d.items[0])
  if (d.name === 'Conflicted') return d.items[0].t === 'list' && d.items[0].items.length >= 2 && d.items[0].items.every(optionalCommit)
  return false
}

/** `RemoteRef { target, state }`: exactly those two fields, the state a word (`Tracked`, `New`). */
const isRemoteRef = (d: DNode): boolean => d.t === 'struct' && d.name === 'RemoteRef' && d.fields.length === 2 && d.fields[0][0] === 'target' && isTarget(d.fields[0][1]) && d.fields[1][0] === 'state' && d.fields[1][1].t === 'word' && /^(Tracked|New)$/.test(d.fields[1][1].v)

/** A map's entries keyed by a newtype's text, each value checked; null when any key or value isn't as expected. */
function keyed(d: DNode, keyName: string, ok: (v: DNode) => boolean): [string, DNode][] | null {
  if (d.t !== 'map') return null
  const out: [string, DNode][] = []
  const seen = new Set<string>()
  for (const [k, v] of d.entries) {
    const key = newtype(k, keyName)
    if (key === null || seen.has(key) || !ok(v)) return null
    seen.add(key)
    out.push([key, v])
  }
  return out
}

/**
 * A view's whole content as entries, or why not: `shape` when anything isn't jj 0.47.1's View exactly (a field added,
 * missing, reordered or of another shape), `bounds` past the bounds. Every dimension is in it: commits (`head:`),
 * bookmarks and tags, every remote's bookmarks and tags with their tracking state, Git's refs, Git's HEAD per workspace
 * and each workspace's working-copy commit.
 */
export function viewEntries(text: string): ViewEntries | 'shape' | 'bounds' {
  if (text.length > VIEW_TEXT_MAX) return 'bounds'
  const d = parseDebug(text)
  if (!d || d.t !== 'struct' || d.name !== 'View') return 'shape'
  if (d.fields.length !== VIEW_FIELDS.length || d.fields.some(([f], i) => f !== VIEW_FIELDS[i])) return 'shape'
  const field = new Map(d.fields)
  const out: ViewEntries = new Map()
  const heads = field.get('head_ids')!
  if (heads.t !== 'set' && !(heads.t === 'map' && heads.entries.length === 0)) return 'shape'
  const headItems = heads.t === 'set' ? heads.items : []
  if (headItems.length > VIEW_ENTRIES_MAX) return 'bounds'
  for (const h of headItems) {
    const id = commitId(h)
    if (!id) return 'shape'
    out.set(`head:${id}`, 'present')
  }
  const dims: [string, string, string, (v: DNode) => boolean][] = [
    ['local_bookmarks', 'RefNameBuf', 'bookmark', isTarget],
    ['local_tags', 'RefNameBuf', 'tag', isTarget],
    ['git_refs', 'GitRefNameBuf', 'gitref', isTarget],
    ['git_heads', 'WorkspaceNameBuf', 'githead', isTarget],
    ['wc_commit_ids', 'WorkspaceNameBuf', 'wc', (v) => commitId(v) !== null]
  ]
  const over = (n: DNode): boolean => n.t === 'map' && n.entries.length > VIEW_ENTRIES_MAX
  for (const [f, keyName, prefix, ok] of dims) {
    const node = field.get(f)!
    if (over(node)) return 'bounds'
    const rows = keyed(node, keyName, ok)
    if (!rows) return 'shape'
    for (const [k, v] of rows) out.set(`${prefix}:${k}`, canon(v))
  }
  const remoteViews = field.get('remote_views')!
  if (over(remoteViews)) return 'bounds'
  const remotes = keyed(remoteViews, 'RemoteNameBuf', (v) => v.t === 'struct' && v.name === 'RemoteView' && v.fields.length === 2 && v.fields[0][0] === 'bookmarks' && v.fields[1][0] === 'tags')
  if (!remotes) return 'shape'
  for (const [remote, rv] of remotes) {
    out.set(`remote:${remote}`, 'present')
    for (const [kind, node] of (rv as Extract<DNode, { t: 'struct' }>).fields) {
      if (over(node)) return 'bounds'
      const rows = keyed(node, 'RefNameBuf', isRemoteRef)
      if (!rows) return 'shape'
      for (const [k, v] of rows) out.set(`remote:${remote}:${kind === 'bookmarks' ? 'bookmark' : 'tag'}:${k}`, canon(v))
    }
  }
  return out
}

/** What an operation says of itself: its view, its parents, whether it is a snapshot and in which workspace. */
export interface OperationFacts {
  view: string
  parents: string[]
  snapshot: boolean
  workspace: string | null
  /** Its description, as jj wrote it (`import git refs`, `create bookmark …`), at most 500 characters kept. */
  description: string
}

/** An operation's own facts from `debug object operation`, or null when they aren't exactly there. */
export function operationFacts(text: string): OperationFacts | null {
  if (text.length > VIEW_TEXT_MAX) return null
  const d = parseDebug(text)
  if (!d || d.t !== 'struct' || d.name !== 'Operation') return null
  const f = new Map(d.fields)
  const view = f.get('view_id')
  const parents = f.get('parents')
  const meta = f.get('metadata')
  const viewId = view ? newtype(view, 'ViewId') : null
  if (!viewId || !/^[0-9a-f]{128}$/.test(viewId) || !parents || parents.t !== 'list' || !meta || meta.t !== 'struct') return null
  const ps = parents.items.map((p) => newtype(p, 'OperationId'))
  if (ps.some((p) => p === null || !OP_ID.test(p))) return null
  const m = new Map(meta.fields)
  const snap = m.get('is_snapshot')
  const wsNode = m.get('workspace_name')
  const desc = m.get('description')
  if (!snap || snap.t !== 'word' || !/^(true|false)$/.test(snap.v) || !wsNode || !desc || desc.t !== 'str') return null
  let workspace: string | null = null
  if (wsNode.t === 'tuple' && wsNode.name === 'Some' && wsNode.items.length === 1) workspace = newtype(wsNode.items[0], 'WorkspaceNameBuf')
  else if (!(wsNode.t === 'word' && wsNode.v === 'None')) return null
  if (wsNode.t === 'tuple' && workspace === null) return null
  return { view: viewId, parents: ps as string[], snapshot: snap.v === 'true', workspace, description: desc.v.slice(0, 500) }
}

// ---- The preview ----------------------------------------------------------------------------------------------------

export type { JjOpChange as OpChange, JjOpOverlap as OpOverlap, JjOpRefusal as OpRefusal } from '../../shared/jjViews'

/** The commit lists read at H (each at most OP_COMMITS_MAX + 1 read: one more than the cap says it was capped). */
export interface OpCommits {
  /** Commits O made visible (at O, not at P). */
  added: string[]
  /** Commits O hid (at P, not at O). */
  hidden: string[]
  /** Descendants at H of what O made visible and is still visible, themselves excluded. */
  descendants: string[]
  /** What O made visible that isn't at H. */
  gone: string[]
  /** What O hid that is visible again at H. */
  back: string[]
}

export interface OpPreviewInput {
  op: string
  facts: OperationFacts
  parent: string | null
  views: { parent: string; op: string; head: string }
  commits: OpCommits
  /** Whether the project folder's workspace is stale at H; null when that couldn't be read. */
  stale: boolean | null
}

export interface OpPreviewCore {
  did: OpChange[]
  commits: { added: string[]; hidden: string[] }
  later: OpOverlap[]
  /** Why no command, or null when one is offered. */
  refused: OpRefusal | null
}

/** jj 0.47.1's descriptions of its operations that record Git's own changes: an import, a fetch. */
const GIT_OWN_OPS = /^(import git (refs|head)|fetch from git remote)/

const PAIRED: [RegExp, string][] = [
  [/^gitref:refs\/heads\/(.+)$/, 'bookmark:'],
  [/^gitref:refs\/tags\/(.+)$/, 'tag:']
]

/** Works out a preview from what was read (E2 to E7; E1 is the reader's). */
export function previewOf(input: OpPreviewInput): OpPreviewCore {
  const empty = (refused: OpRefusal): OpPreviewCore => ({ did: [], commits: { added: [], hidden: [] }, later: [], refused })
  // E2: exactly one parent (not the root, not a merge of operations).
  if (input.facts.parents.length !== 1 || input.parent === null) return empty('parents')
  // E3: the three views whole, within the bounds.
  const parsed = [input.views.parent, input.views.op, input.views.head].map(viewEntries)
  for (const p of parsed) if (p === 'shape' || p === 'bounds') return empty(p)
  const [P, O, H] = parsed as ViewEntries[]
  const c = input.commits
  if ([c.added, c.hidden, c.descendants, c.gone, c.back].some((l) => l.length > OP_COMMITS_MAX)) return empty('bounds')
  const did: OpChange[] = []
  for (const key of [...new Set([...P.keys(), ...O.keys()])].sort()) {
    const before = P.get(key) ?? null
    const after = O.get(key) ?? null
    if (before !== after) did.push({ key, before, after })
  }
  const later: OpOverlap[] = []
  for (const d of did) {
    const now = H.get(d.key) ?? null
    if (now !== d.after) later.push({ key: d.key, now, why: 'changedSince' })
  }
  for (const id of c.descendants) later.push({ key: `commit:${id}`, now: id, why: 'descendant' })
  for (const id of c.gone) later.push({ key: `commit:${id}`, now: null, why: 'rewrittenSince' })
  for (const id of c.back) later.push({ key: `commit:${id}`, now: id, why: 'restoredSince' })
  const core = { did, commits: { added: c.added, hidden: c.hidden }, later }
  if (!did.length && !c.added.length && !c.hidden.length) return { ...core, refused: 'nothing' }
  // E4: no working-copy change (the user's command would update files there, which the preview can't see).
  if (did.some((d) => d.key.startsWith('wc:'))) return { ...core, refused: 'workingCopy' }
  // E5: a Git ref changed only as jj's export of the jj ref it changed to the same value; Git's HEAD never. jj's import
  // of Git's own change (its `import git refs` and `import git head` operations, 0.47.1's words) and a fetch change both
  // sides alike, so they are known by the operation's own description: reverting one changes nothing in Git, and jj
  // would import it again.
  if (GIT_OWN_OPS.test(input.facts.description)) return { ...core, refused: 'gitOwn' }
  for (const d of did) {
    if (d.key.startsWith('githead:')) return { ...core, refused: 'gitOwn' }
    if (!d.key.startsWith('gitref:')) continue
    const pair = PAIRED.map(([re, prefix]) => {
      const m = re.exec(d.key)
      return m ? prefix + m[1] : null
    }).find((k) => k !== null)
    const jjRef = pair ? did.find((x) => x.key === pair) : undefined
    if (!jjRef || jjRef.after !== d.after) return { ...core, refused: 'gitOwn' }
  }
  // E6: nothing it changed changed again since.
  if (later.length) return { ...core, refused: 'overlap' }
  // E7: the project's workspace, where the command runs, not stale (unknown counts as stale).
  if (input.stale !== false) return { ...core, refused: 'stale' }
  return { ...core, refused: null }
}

/** The command the user runs (s19: plain, the full id, never `--at-op`). */
export const revertCommand = (op: string): string => `jj op revert ${op}`

/** The parent of an operation's facts, when it has exactly one. */
export const soleParent = (f: OperationFacts): string | null => (f.parents.length === 1 ? f.parents[0] : null)

/** A revset's commit list output (one full commit id a line), or null when malformed. */
export function commitList(out: string): string[] | null {
  const ids = out.split(/\r?\n/).filter(Boolean)
  return ids.every((l) => COMMIT_ID.test(l)) ? ids : null
}

/** Whether a string is a full operation id. */
export const isOpId = (s: string): boolean => OP_ID.test(s)
