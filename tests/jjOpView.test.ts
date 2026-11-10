// The Operations section's preview core (HI-2800, J7; design HI-2800/s12, s16, s19): the strict reader of jj 0.47.1's
// `debug object view` and `debug object operation` text (recorded from the pinned jj in tests/fixtures/jj), and the
// eligibility rules E2 to E7 on built views. The real-jj proof (each rule against a real repository, the command run) is
// tests/jjOperationsReal.test.ts.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { canon, operationFacts, parseDebug, previewOf, revertCommand, viewEntries, VIEW_ENTRIES_MAX, VIEW_TEXT_MAX, OP_COMMITS_MAX, type OpPreviewInput } from '../src/main/platform/jjOpView'

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'jj', name), 'utf8')

const C1 = '1'.repeat(40)
const C2 = '2'.repeat(40)
const C3 = '3'.repeat(40)
const OP = (c: string): string => c.repeat(128)

const target = (c: string | null): string => (c ? `Resolved(\n Some(\n CommitId(\n "${c}",\n ),\n ),\n )` : 'Resolved(\n None,\n )')

/** A View in jj's pretty Debug form. */
function view(o: { heads?: string[]; bookmarks?: Record<string, string | null>; tags?: Record<string, string | null>; remotes?: Record<string, { bookmarks?: Record<string, [string | null, 'Tracked' | 'New']>; tags?: Record<string, [string | null, 'Tracked' | 'New']> }>; gitRefs?: Record<string, string | null>; gitHeads?: Record<string, string | null>; wc?: Record<string, string> } = {}): string {
  const map = (name: string, m: Record<string, string>): string => (Object.keys(m).length ? `{\n${Object.entries(m).map(([k, v]) => `${name}(\n"${k}",\n): ${v},`).join('\n')}\n}` : '{}')
  const tmap = (name: string, m: Record<string, string | null> = {}): string => map(name, Object.fromEntries(Object.entries(m).map(([k, v]) => [k, target(v)])))
  const rmap = (m: Record<string, [string | null, string]> = {}): string => map('RefNameBuf', Object.fromEntries(Object.entries(m).map(([k, [t, s]]) => [k, `RemoteRef {\n target: ${target(t)},\n state: ${s},\n }`])))
  const remotes = o.remotes ?? {}
  const heads = o.heads ?? [C1]
  return `View {
    head_ids: ${heads.length ? `{\n${heads.map((h) => `CommitId(\n"${h}",\n),`).join('\n')}\n}` : '{}'},
    local_bookmarks: ${tmap('RefNameBuf', o.bookmarks)},
    local_tags: ${tmap('RefNameBuf', o.tags)},
    remote_views: ${map('RemoteNameBuf', Object.fromEntries(Object.entries(remotes).map(([k, r]) => [k, `RemoteView {\n bookmarks: ${rmap(r.bookmarks)},\n tags: ${rmap(r.tags)},\n }`])))},
    git_refs: ${tmap('GitRefNameBuf', o.gitRefs)},
    git_heads: ${tmap('WorkspaceNameBuf', o.gitHeads)},
    wc_commit_ids: ${map('WorkspaceNameBuf', Object.fromEntries(Object.entries(o.wc ?? { default: C1 }).map(([k, v]) => [k, `CommitId(\n"${v}",\n)`])))},
}`
}

const NO_COMMITS = { added: [], hidden: [], descendants: [], gone: [], back: [] }
const input = (p: string, o: string, h: string, extra: Partial<OpPreviewInput> = {}): OpPreviewInput => ({ op: OP('b'), facts: { view: OP('e'), parents: [OP('a')], snapshot: false, workspace: 'default', description: 'create bookmark feature' }, parent: OP('a'), views: { parent: p, op: o, head: h }, commits: NO_COMMITS, stale: false, ...extra })

describe('the Debug reader', () => {
  it('reads the recorded view whole: a conflicted bookmark, the git and origin remotes with their tracking, Git refs and HEAD', () => {
    const v = viewEntries(fixture('view-0.47.1-conflicted.txt'))
    expect(v).toBeInstanceOf(Map)
    const m = v as Map<string, string>
    expect(m.get('bookmark:main')).toMatch(/^Conflicted\(\[Some\(CommitId\("0f80b7ab/)
    expect(m.get('remote:origin:bookmark:main')).toMatch(/state:Tracked\}$/)
    expect(m.get('remote:git')).toBe('present')
    expect(m.get('gitref:refs/remotes/origin/main')).toMatch(/^Resolved\(Some/)
    expect(m.has('githead:default')).toBe(true)
    expect(m.has('wc:default')).toBe(true)
    expect([...m.keys()].filter((k) => k.startsWith('head:')).length).toBeGreaterThan(0)
  })

  it("reads an operation's own facts, and a merge of operations has two parents", () => {
    const merge = operationFacts(fixture('operation-0.47.1-merge.txt'))
    expect(merge?.parents).toHaveLength(2)
    expect(merge?.snapshot).toBe(false)
    expect(merge?.workspace).toBe('default')
    expect(operationFacts(fixture('operation-0.47.1-single.txt'))?.parents).toHaveLength(1)
  })

  it('refuses unknown, missing or reordered fields, other shapes, truncation and trailing text', () => {
    const good = view({ bookmarks: { main: C1 } })
    expect(viewEntries(good)).toBeInstanceOf(Map)
    expect(viewEntries(good.replace('git_heads:', 'git_head:'))).toBe('shape')
    expect(viewEntries(good.replace(/\s+git_heads:[\s\S]*?(?=\s+wc_commit_ids)/, ''))).toBe('shape')
    expect(viewEntries(good.replace('    wc_commit_ids:', '    extra: {},\n    wc_commit_ids:'))).toBe('shape')
    expect(viewEntries(good.slice(0, good.length - 40))).toBe('shape')
    expect(viewEntries(good + ' x')).toBe('shape')
    expect(viewEntries(good.replace('Resolved(', 'Unknown('))).toBe('shape')
    expect(viewEntries(good.replace('"' + C1 + '"', '"abc"'))).toBe('shape')
    expect(viewEntries(view({ remotes: { origin: { bookmarks: { main: [C1, 'Tracked'] } } } }).replace('Tracked', 'Maybe'))).toBe('shape')
    expect(viewEntries('Operation {}')).toBe('shape')
    expect(viewEntries('')).toBe('shape')
  })

  it('holds the bounds: text over the limit, a dimension over its entries', () => {
    expect(viewEntries(' '.repeat(VIEW_TEXT_MAX + 1))).toBe('bounds')
    const many = Object.fromEntries(Array.from({ length: VIEW_ENTRIES_MAX + 1 }, (_, i) => [`b${i}`, C1]))
    expect(viewEntries(view({ bookmarks: many }))).toBe('bounds')
  })

  it('canonical text: equal values, equal text, whatever the layout', () => {
    const a = parseDebug('Some(\n  CommitId(\n "x",\n ),\n)')!
    const b = parseDebug('Some(CommitId("x"))')!
    expect(canon(a)).toBe(canon(b))
    expect(parseDebug('"a\\"b\\u{e9}"')).toEqual({ t: 'str', v: 'a"bé' })
  })
})

describe('the preview: E2 to E7', () => {
  const P = view({ bookmarks: {}, gitRefs: {} })
  const O = view({ bookmarks: { feature: C1 }, remotes: { git: { bookmarks: { feature: [C1, 'Tracked'] } } }, gitRefs: { 'refs/heads/feature': C1 } })

  it('a bookmark created (with its export) and nothing after: a command', () => {
    const r = previewOf(input(P, O, O))
    expect(r.refused).toBeNull()
    expect(r.did.map((d) => d.key)).toEqual(['bookmark:feature', 'gitref:refs/heads/feature', 'remote:git', 'remote:git:bookmark:feature'])
    expect(revertCommand(OP('b'))).toBe(`jj op revert ${OP('b')}`)
  })

  it('an unrelated later change leaves it eligible', () => {
    const H = view({ bookmarks: { feature: C1, other: C2 }, remotes: { git: { bookmarks: { feature: [C1, 'Tracked'], other: [C2, 'Tracked'] } } }, gitRefs: { 'refs/heads/feature': C1, 'refs/heads/other': C2 } })
    expect(previewOf(input(P, O, H)).refused).toBeNull()
  })

  it('the same bookmark moved since: overlap (E6), listed with what it is now', () => {
    const H = view({ bookmarks: { feature: C2 }, remotes: { git: { bookmarks: { feature: [C2, 'Tracked'] } } }, gitRefs: { 'refs/heads/feature': C2 } })
    const r = previewOf(input(P, O, H))
    expect(r.refused).toBe('overlap')
    expect(r.later.map((l) => l.key)).toContain('bookmark:feature')
  })

  it('tracking only: eligible alone, overlap once untracked again', () => {
    const p = view({ remotes: { origin: { bookmarks: { main: [C1, 'New'] } } } })
    const o = view({ remotes: { origin: { bookmarks: { main: [C1, 'Tracked'] } } } })
    const r = previewOf(input(p, o, o))
    expect(r.refused).toBeNull()
    expect(r.did.map((d) => d.key)).toEqual(['remote:origin:bookmark:main'])
    expect(previewOf(input(p, o, p)).refused).toBe('overlap')
  })

  it('a bookmark deleted, and a conflicted target since: overlap', () => {
    const before = view({ bookmarks: { old: C1 }, remotes: { git: { bookmarks: { old: [C1, 'Tracked'] } } }, gitRefs: { 'refs/heads/old': C1 } })
    const after = view({ remotes: { git: {} } })
    expect(previewOf(input(before, after, after)).refused).toBeNull()
    const conflicted = view({ remotes: { git: {} } }).replace('local_bookmarks: {}', `local_bookmarks: {\nRefNameBuf(\n"old",\n): Conflicted(\n[\nSome(\nCommitId(\n"${C2}",\n),\n),\nSome(\nCommitId(\n"${C3}",\n),\n),\n],\n),\n}`)
    expect(previewOf(input(before, after, conflicted)).refused).toBe('overlap')
  })

  it('a working-copy change gives no command (E4)', () => {
    const p = view({ wc: { default: C1 } })
    const o = view({ heads: [C2], wc: { default: C2 } })
    expect(previewOf(input(p, o, o)).refused).toBe('workingCopy')
    // A workspace added or forgotten is a working-copy entry too.
    expect(previewOf(input(p, view({ wc: { default: C1, ws2: C3 } }), view({ wc: { default: C1, ws2: C3 } }))).refused).toBe('workingCopy')
  })

  it("Git's own change (an import, Git's HEAD) gives no command (E5); jj's export of the same value does", () => {
    const p = view({ bookmarks: { main: C1 }, gitRefs: { 'refs/heads/main': C1 } })
    const both = view({ bookmarks: { main: C2 }, gitRefs: { 'refs/heads/main': C2 } })
    // A Git ref moved alone (jj recording Git's move), and jj's import of it: both sides alike, known by its description.
    expect(previewOf(input(p, view({ bookmarks: { main: C1 }, gitRefs: { 'refs/heads/main': C2 } }), view({ bookmarks: { main: C1 }, gitRefs: { 'refs/heads/main': C2 } }))).refused).toBe('gitOwn')
    const facts = (description: string) => ({ facts: { view: OP('e'), parents: [OP('a')], snapshot: false, workspace: 'default', description } })
    expect(previewOf(input(p, both, both, facts('import git refs'))).refused).toBe('gitOwn')
    expect(previewOf(input(p, both, both, facts('fetch from git remote(s) origin'))).refused).toBe('gitOwn')
    // jj's own move with its export: eligible; a jj move not exported yet is jj's alone, eligible too.
    expect(previewOf(input(p, both, both, facts('point bookmark main to commit 2222'))).refused).toBeNull()
    expect(previewOf(input(p, view({ bookmarks: { main: C2 }, gitRefs: { 'refs/heads/main': C1 } }), view({ bookmarks: { main: C2 }, gitRefs: { 'refs/heads/main': C1 } }))).refused).toBeNull()
    expect(previewOf(input(view(), view({ gitHeads: { default: C1 } }), view({ gitHeads: { default: C1 } }))).refused).toBe('gitOwn')
    expect(previewOf(input(view({ gitRefs: {} }), view({ gitRefs: { 'refs/remotes/origin/x': C1 } }), view({ gitRefs: { 'refs/remotes/origin/x': C1 } }))).refused).toBe('gitOwn')
  })

  it('later work on its commits: descendants, rewritten since, restored since (E6)', () => {
    const p = view()
    const o = view({ heads: [C2] })
    expect(previewOf(input(p, o, o, { commits: { ...NO_COMMITS, added: [C2], descendants: [C3] } })).later).toContainEqual({ key: `commit:${C3}`, now: C3, why: 'descendant' })
    expect(previewOf(input(p, o, o, { commits: { ...NO_COMMITS, added: [C2], descendants: [C3] } })).refused).toBe('overlap')
    expect(previewOf(input(p, o, o, { commits: { ...NO_COMMITS, added: [C2], gone: [C2] } })).refused).toBe('overlap')
    expect(previewOf(input(p, o, o, { commits: { ...NO_COMMITS, hidden: [C3], back: [C3] } })).refused).toBe('overlap')
  })

  it('two parents, a list past its cap, a stale or unknown workspace, and nothing to revert', () => {
    expect(previewOf(input(P, O, O, { facts: { view: OP('e'), parents: [OP('a'), OP('c')], snapshot: false, workspace: null, description: 'reconcile divergent operations' }, parent: null })).refused).toBe('parents')
    expect(previewOf(input(P, O, O, { facts: { view: OP('e'), parents: [], snapshot: false, workspace: null, description: '' }, parent: null })).refused).toBe('parents')
    expect(previewOf(input(P, O, O, { commits: { ...NO_COMMITS, added: Array.from({ length: OP_COMMITS_MAX + 1 }, () => C1) } })).refused).toBe('bounds')
    expect(previewOf(input(P, O, O, { stale: true })).refused).toBe('stale')
    expect(previewOf(input(P, O, O, { stale: null })).refused).toBe('stale')
    expect(previewOf(input(P, P, P)).refused).toBe('nothing')
    expect(previewOf(input(P, 'View {', O)).refused).toBe('shape')
  })
})
