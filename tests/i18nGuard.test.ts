// The i18n guard (scripts/i18nGuard.mjs, #768): no new hard-coded text in what the user sees. The spike's 24 fixtures
// (#756), each in a tree of its own, and Combwork's own source checked against the merge base's allowlists, as CI does.
import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join, resolve } from 'path'
import { tempDir } from './tempDir'
// @ts-expect-error: a plain .mjs module without types
import { ALLOW_DIR, allowName, baseLists, defaultBaseRef, growth, readLists, runGuard, sitesOf } from '../scripts/i18nGuard.mjs'

const ROOT = resolve(__dirname, '..')
const ctx = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }
const FILE = 'src/renderer/src/Panel.tsx'

type Lists = Map<string, Record<string, number>>
interface Result {
  exit: number
  lines: string[]
}

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** A tree with one source file, its allowlist made by --init from `base`. */
function tree(base: string, file = FILE) {
  const root = tempDir('hive-i18n-guard-')
  roots.push(root)
  const allowDir = join(root, ALLOW_DIR)
  const write = (src: string, rel = file) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), src)
  }
  const run = (mode: 'check' | 'init' | 'prune' = 'check', against?: Lists): Result => runGuard({ root, allowDir, mode, against })
  const list = (rel = file): Record<string, number> => (readLists(allowDir) as Lists).get(allowName(rel)) ?? {}
  write(base)
  expect(run('init').exit).toBe(0)
  return { root, allowDir, write, run, list }
}

/** A check's NEW UI TEXT and BARE IGNORE lines. */
const reported = (r: Result): string[] => r.lines.filter((l) => /^(NEW UI TEXT|BARE IGNORE|UNPARSEABLE|ALLOWLIST GREW)/.test(l))

// Each case: the file it starts from (allowlisted by --init), then the change, and the check's exit with every site it
// must report (and none other).
const CASES: { name: string; file?: string; base: string; next: string; exit: 0 | 1; sites?: string[] }[] = [
  { name: 'base: an allowlisted file passes', base: `export const P = () => <button title="Save the file">Save</button>`, next: `export const P = () => <button title="Save the file">Save</button>`, exit: 0 },
  {
    name: 'same-count: one literal becomes a message, a new one is added on the same line',
    base: `import { msg, tr } from '@shared/i18n'\nexport const P = () => <div><button>Save</button><span>{12}</span></div>`,
    next: `import { msg, tr } from '@shared/i18n'\nexport const P = () => <div><button>{tr(msg({ id: 'p.save', defaultMessage: 'Save', description: 'A button' }))}</button><span>Saved just now</span></div>`,
    exit: 1,
    sites: ['jsx-text||Saved just now']
  },
  { name: "one-word label: { label: 'none' }", base: `export const o = [{ value: 'auto', label: 'Automatic' }]`, next: `export const o = [{ value: 'auto', label: 'Automatic' }, { value: 'none', label: 'none' }]`, exit: 1, sites: ['prop|label|none'] },
  { name: "conditional property: { label: on ? 'none' : 'all' }", base: `export const x = 1`, next: `declare const on: boolean\nexport const row = { label: on ? 'none' : 'all' }`, exit: 1, sites: ['prop|label|none', 'prop|label|all'] },
  { name: "JSX expression: <span>{'none'}</span>", base: `export const x = 1`, next: `export const row = <span>{'none'}</span>`, exit: 1, sites: ['jsx-expr||none'] },
  { name: "logical child: {n > 1 && 'more'}", base: `export const x = 1`, next: `declare const n: number\nexport const row = <span>{n > 1 && 'more'}</span>`, exit: 1, sites: ['jsx-expr||more'] },
  { name: "concatenated attribute: title={'Saved ' + n}", base: `export const x = 1`, next: `declare const n: number\nexport const row = <span title={'Saved ' + n} />`, exit: 1, sites: ['jsx-attr|title|Saved'] },
  {
    name: "UI call with a conditional: notify('error', ok ? 'Done' : 'Failed'), not the level",
    base: `export const x = 1`,
    next: `declare const ok: boolean\ndeclare function notify(l: string, t: string): void\nnotify('error', ok ? 'Done' : 'Failed')`,
    exit: 1,
    sites: ['call|notify|Done', 'call|notify|Failed']
  },
  { name: "joined list: {['first thing', 'second thing'].join(' · ')}", base: `export const x = 1`, next: `export const row = <span>{['first thing', 'second thing'].join(' · ')}</span>`, exit: 1, sites: ['jsx-expr||first thing', 'jsx-expr||second thing'] },
  { name: 'helper prose: return `Passed in ${took}`', base: `export const x = 1`, next: 'export const passed = (took: string): string => `Passed in ${took}`', exit: 1, sites: ['prose|return|Passed in {}'] },
  { name: "template property: { label: `${on ? 'none' : 'all'}` }", base: `export const x = 1`, next: "declare const on: boolean\nexport const row = { label: `${on ? 'none' : 'all'}` }", exit: 1, sites: ['prop|label|none', 'prop|label|all'] },
  { name: "template child: <span>{`${on ? 'none' : 'all'}`}</span>", base: `export const x = 1`, next: "declare const on: boolean\nexport const row = <span>{`${on ? 'none' : 'all'}`}</span>", exit: 1, sites: ['jsx-expr||none', 'jsx-expr||all'] },
  { name: "nested template in a conditional in a template: title={`${n ? `${n} files` : 'none'}`}", base: `export const x = 1`, next: "declare const n: number\nexport const row = <span title={`${n ? `${n} files` : 'none'}`} />", exit: 1, sites: ['jsx-attr|title|{} files', 'jsx-attr|title|none'] },
  { name: 'template in a template, text only inside: `${`${n} more`}`', base: `export const x = 1`, next: "declare const n: number\nexport const row = { label: `${`${n} more`}` }", exit: 1, sites: ['prop|label|{} more'] },
  {
    name: 'templates with translated, user-data and number substitutions pass',
    base: `export const x = 1`,
    next: [
      `import { msg, tr } from '@shared/i18n'`,
      `const M = { more: msg({ id: 'p.more', defaultMessage: '{n} more', description: 'A count' }) }`,
      `declare const name: string`,
      `declare const n: number`,
      'export const a = { label: `${tr(M.more, { n })}` }',
      'export const b = <span title={`${name}`}>{`${name} · ${n}`}</span>',
      'export const c = { label: `${n}` }'
    ].join('\n'),
    exit: 0
  },
  {
    name: 'exclusions: descriptors, tr(), variables, ids, class names, keys, data-*, logs, numbers',
    base: `export const x = 1`,
    next: [
      `import { msg, tr } from '@shared/i18n'`,
      `const M = { hi: msg({ id: 'panel.hello', defaultMessage: 'Hello, {name}', description: 'A greeting' }) }`,
      `const log = { info: (_: string) => undefined }`,
      `log.info('Panel rendered for the first time')`,
      `declare const name: string`,
      `const ids = { id: 'progress.title', key: 'general.language', column: 'doing', label: name }`,
      `export const P = () => <div className="panel wide" data-kind="settings" key="k1" id="panel-main" role="region" title={tr(M.hi, { name })}>{tr(M.hi, { name: ids.id })}<span>{12}</span></div>`
    ].join('\n'),
    exit: 0
  },
  {
    name: "an object's className is class names, never text; a column's header beside it still is (#1655)",
    base: `export const x = 1`,
    next: `export const cols = [{ key: 'result', className: 'nowrap git-queue-result', cls: 'wide cell' }, { key: 'when', header: 'Merged at' }]`,
    exit: 1,
    sites: ['prose|prop:other|Merged at']
  },
  { name: 'a file that does not parse fails the check (never skipped)', base: `export const x = 1`, next: `export const row = <span>Save</span><b>Oops</b>`, exit: 1 },
  { name: 'an agent-facing file is exempt', file: 'src/shared/toolReplies.ts', base: `export const x = 1`, next: 'export const reply = (n: number) => ({ text: `Changed ${n} cards: read them with cw_read_task` })', exit: 0 },
  {
    name: 'a sink marked // i18n-ignore: <reason>, on the line or the line above, passes',
    base: `export const x = 1`,
    next: `export const row = { label: 'none' } // i18n-ignore: deliberate name\n// i18n-ignore: the language's own name\nexport const own = { label: 'Polski' }`,
    exit: 0
  },
  { name: 'a bare // i18n-ignore, with no reason, fails', base: `export const x = 1`, next: `export const row = { label: 'none' } // i18n-ignore`, exit: 1 }
]

describe('the i18n guard: what a check finds', () => {
  it.each(CASES)('$name', (c) => {
    const t = tree(c.base, c.file)
    t.write(c.next)
    const r = t.run()
    expect(r.exit, r.lines.join('\n')).toBe(c.exit)
    if (c.sites) expect(reported(r).map((l) => l.replace(/^NEW UI TEXT \S+\s+/, '')).sort()).toEqual([...c.sites].sort())
    if (c.name.startsWith('a bare')) expect(reported(r).join('\n')).toMatch(/BARE IGNORE .*needs a reason/)
    if (c.name.startsWith('a file that does not parse')) expect(reported(r).join('\n')).toMatch(/^UNPARSEABLE src\/renderer\/src\/Panel\.tsx/)
  })
})

describe('the i18n guard: the allowlists only shrink', () => {
  it('--prune cannot approve new text', () => {
    const t = tree(`export const row = <span>Save</span>`)
    t.write(`export const row = <span>Saved just now</span>`)
    expect(t.run().exit).toBe(1)
    expect(t.run('prune').exit).toBe(0)
    expect(t.run().exit).toBe(1)
    expect(t.list()).not.toHaveProperty(['jsx-text||Saved just now'])
  })

  it('--init never rewrites an existing allowlist', () => {
    const t = tree(`export const row = <div><span>Save</span></div>`)
    t.write(`export const row = <div><span>Save</span><b>Saved just now</b></div>`)
    expect(t.run('init').exit).toBe(0)
    expect(t.run().exit).toBe(1)
    expect(t.list()).not.toHaveProperty(['jsx-text||Saved just now'])
  })

  it("a hand-grown allowlist passes alone but fails against the base branch's", () => {
    const t = tree(`export const row = <span>Save</span>`)
    const base = readLists(t.allowDir) as Lists
    t.write(`export const row = <span>Saved just now</span>`)
    const file = join(t.allowDir, allowName(FILE))
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), 'jsx-text||Saved just now': 1 }))
    expect(t.run().exit).toBe(0)
    const r = t.run('check', base)
    expect(r.exit).toBe(1)
    expect(reported(r)).toEqual([`ALLOWLIST GREW ${allowName(FILE)}: jsx-text||Saved just now (0 → 1): the allowlist only shrinks; write the text as a message`])
  })

  it("--prune shrinks, and a pruned text can't come back", () => {
    const t = tree(`export const row = <div><span>Save</span><span>Cancel</span></div>`)
    t.write(`export const row = <div><span>Save</span></div>`)
    expect(t.run().exit).toBe(0)
    expect(t.run('prune').exit).toBe(0)
    expect(t.list()).not.toHaveProperty(['jsx-text||Cancel'])
    t.write(`export const row = <div><span>Save</span><span>Cancel</span></div>`)
    expect(t.run().exit).toBe(1)
  })

  it("--prune with no files also drops the list of a file that's gone", () => {
    const t = tree(`export const row = <span>Save</span>`)
    t.write(`export const row = <span>Save</span>`, 'src/renderer/src/Other.tsx')
    expect(t.run('init').exit).toBe(0)
    rmSync(join(t.root, FILE))
    expect(runGuard({ root: t.root, allowDir: t.allowDir, mode: 'prune', files: ['src/renderer/src/Other.tsx'] }).exit).toBe(0)
    expect([...(readLists(t.allowDir) as Lists).keys()].sort()).toEqual([allowName('src/renderer/src/Other.tsx'), allowName(FILE)].sort())
    expect(t.run('prune').exit).toBe(0)
    expect([...(readLists(t.allowDir) as Lists).keys()]).toEqual([allowName('src/renderer/src/Other.tsx')])
  })

  it('a list moved with its file (git mv) is the same list; one moved and grown is not', () => {
    const t = tree(`export const row = <div><span>Save</span><span>Cancel</span></div>`)
    const base = readLists(t.allowDir) as Lists
    const moved = 'src/renderer/src/Moved.tsx'
    rmSync(join(t.root, FILE))
    t.write(`export const row = <div><span>Save</span><span>Cancel</span></div>`, moved)
    const from = join(t.allowDir, allowName(FILE))
    const to = join(t.allowDir, allowName(moved))
    cpSync(from, to)
    rmSync(from)
    expect(t.run('check', base).exit).toBe(0)
    writeFileSync(to, JSON.stringify({ ...JSON.parse(readFileSync(to, 'utf8')), 'jsx-text||Saved just now': 1 }))
    expect(reported(t.run('check', base))).toEqual([`ALLOWLIST GREW ${allowName(moved)}: jsx-text||Saved just now (0 → 1): the allowlist only shrinks; write the text as a message`])
  })

  it("reads the merge base's lists from git: a branch's own growth fails, the base branch compares with its previous commit", () => {
    const t = tree(`export const row = <span>Save</span>`)
    const git = (...args: string[]) => {
      const r = spawnSync('git', args, { cwd: t.root, encoding: 'utf8', env: ctx.baseEnv() })
      expect(r.status, r.stderr).toBe(0)
      return r.stdout.trim()
    }
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.com')
    git('add', '-A')
    git('commit', '-q', '-m', 'guard')
    // On main itself, the merge base is HEAD: the lists of its previous commit, and the first commit has none.
    expect(baseLists(t.root, 'main')).toBeNull()
    git('checkout', '-q', '-b', 'feature')
    const file = join(t.allowDir, allowName(FILE))
    writeFileSync(file, JSON.stringify({ 'jsx-text||Save': 1, 'jsx-text||Saved just now': 1 }))
    git('commit', '-q', '-am', 'grow by hand')
    const b = baseLists(t.root, 'main') as { base: string; lists: Lists }
    expect(b.base).toBe(git('rev-parse', 'main'))
    expect(b.lists.get(allowName(FILE))).toEqual({ 'jsx-text||Save': 1 })
    expect(reported(t.run('check', b.lists))).toEqual([`ALLOWLIST GREW ${allowName(FILE)}: jsx-text||Saved just now (0 → 1): the allowlist only shrinks; write the text as a message`])
    git('checkout', '-q', 'main')
    git('merge', '-q', '--no-ff', '-m', 'merge', 'feature')
    expect((baseLists(t.root, 'main') as { lists: Lists }).lists.get(allowName(FILE))).toEqual({ 'jsx-text||Save': 1 })
  })

  it('growth() counts a raised count and a new list', () => {
    const was: Lists = new Map([['a.json', { 'prop|label|Save': 1 }]])
    expect(growth(new Map([['a.json', { 'prop|label|Save': 1 }]]), was)).toEqual([])
    expect(growth(new Map([['a.json', { 'prop|label|Save': 2 }]]), was)).toHaveLength(1)
    expect(growth(new Map([...was, ['b.json', { 'prop|label|Save': 1 }]]), was)).toHaveLength(1)
  })

  it('several files moved at once are matched one to one, whatever order the base lists come in (review round 2)', () => {
    const save = 'prop|label|Save'
    const cancel = 'prop|label|Cancel'
    const now: Lists = new Map<string, Record<string, number>>([['c.json', { [save]: 1 }], ['d.json', { [save]: 1, [cancel]: 1 }]])
    // b → c and a → d: no text gained, in either order of the base's lists.
    expect(growth(now, new Map([['a.json', { [save]: 1, [cancel]: 1 }], ['b.json', { [save]: 1 }]]))).toEqual([])
    expect(growth(now, new Map([['b.json', { [save]: 1 }], ['a.json', { [save]: 1, [cancel]: 1 }]]))).toEqual([])
    expect(growth(new Map([...now].reverse()), new Map([['b.json', { [save]: 1 }], ['a.json', { [save]: 1, [cancel]: 1 }]]))).toEqual([])
    // Genuine growth on one of the moves is reported, and only it.
    const grown: Lists = new Map<string, Record<string, number>>([['c.json', { [save]: 1 }], ['d.json', { [save]: 1, [cancel]: 1, 'prop|label|New text': 1 }]])
    for (const base of [new Map([['a.json', { [save]: 1, [cancel]: 1 }], ['b.json', { [save]: 1 }]]), new Map([['b.json', { [save]: 1 }], ['a.json', { [save]: 1, [cancel]: 1 }]])] as Lists[])
      expect(growth(grown, base)).toEqual(['ALLOWLIST GREW d.json: prop|label|New text (0 → 1): the allowlist only shrinks; write the text as a message'])
    // Three new lists from two vanished ones: one of them is new, whichever it is.
    expect(growth(new Map([...now, ['e.json', { [save]: 1 }]]), new Map([['a.json', { [save]: 1, [cancel]: 1 }], ['b.json', { [save]: 1 }]]))).toHaveLength(1)
  })

  it('a list moved once is the same list; the same list in two new files is not (review round 1)', () => {
    const was: Lists = new Map([['a.json', { 'prop|label|none': 1 }]])
    expect(growth(new Map([['b.json', { 'prop|label|none': 1 }]]), was)).toEqual([])
    expect(growth(new Map([['b.json', { 'prop|label|none': 1 }], ['c.json', { 'prop|label|none': 1 }]]), was)).toEqual([
      'ALLOWLIST GREW c.json: prop|label|none (0 → 1): the allowlist only shrinks; write the text as a message'
    ])
  })
})

/** A file's sites, as `<site>` strings, and its problems. */
function sitesIn(code: string, file = FILE): { sites: string[]; problems: string[] } {
  const r = sitesOf(file, code) as { sites: { site: string }[]; problems: string[] }
  return { sites: r.sites.map((s) => s.site), problems: r.problems }
}

describe('the i18n guard: what review round 1 found', () => {
  const lines = (...l: string[]): string => l.join('\n')

  it('a long text is a site in full: two that share their first 137 characters are different sites', () => {
    const head = 'Long message '.repeat(14)
    const a = sitesIn(`export const f = (): string => { return '${head}first ending' }`).sites
    const b = sitesIn(`export const f = (): string => { return '${head}new untranslated ending' }`).sites
    expect(a).toEqual([`prose|return|${head.trim()} first ending`])
    expect(b).toEqual([`prose|return|${head.trim()} new untranslated ending`])
    const t = tree(`export const f = (): string => { return '${head}first ending' }`)
    t.write(`export const f = (): string => { return '${head}new untranslated ending' }`)
    const r = t.run()
    expect(r.exit).toBe(1)
    expect(reported(r)).toEqual([expect.stringMatching(/^NEW UI TEXT .*prose\|return\|Long message .*\.\.\.$/)])
  })

  it('only a comment exempts: the marker in a string, or a string on the line above, exempts nothing', () => {
    expect(sitesIn(`export const row = { label: 'i18n-ignore: none' }`)).toEqual({ sites: ['prop|label|i18n-ignore: none'], problems: [] })
    expect(sitesIn(lines(`export const note = 'i18n-ignore: a reason'`, `export const row = { label: 'none' }`)).sites).toContain('prop|label|none')
    // A comment after code on the line above is that line's, not the next one's.
    expect(sitesIn(lines('export const a = 1 // i18n-ignore: about this line', `export const row = { label: 'none' }`)).sites).toEqual(['prop|label|none'])
    // A comment on its own line above, a block comment, and one in JSX.
    expect(sitesIn(lines('// i18n-ignore: a deliberate name', `export const row = { label: 'none' }`))).toEqual({ sites: [], problems: [] })
    expect(sitesIn(`export const row = { label: 'none' } /* i18n-ignore: a deliberate name */`)).toEqual({ sites: [], problems: [] })
    expect(sitesIn(`export const row = <span>{/* i18n-ignore: a product name */}Hive Desktop</span>`)).toEqual({ sites: [], problems: [] })
    // A bare marker anywhere fails, and exempts nothing.
    expect(sitesIn(lines('/* i18n-ignore */', `export const row = { label: 'none' }`))).toEqual({ sites: ['prop|label|none'], problems: [expect.stringMatching(/^BARE IGNORE src\/renderer\/src\/Panel\.tsx:1 /)] })
  })

  it('an optional UI call is a UI call: tray?.setToolTip, and notify?.() with a conditional and a template', () => {
    const tooltip = lines('declare const tray: { setToolTip(t: string): void } | undefined', `tray?.setToolTip('none')`)
    expect(sitesIn(tooltip).sites).toEqual(['call|setToolTip|none'])
    const code = lines('declare const ui: { notify(l: string, t: string): void } | undefined', 'declare const ok: boolean', 'declare const n: number', "ui?.notify('error', ok ? 'Done' : `${n} more`)")
    expect(sitesIn(code).sites.sort()).toEqual(['call|notify|Done', 'call|notify|{} more'])
    const t = tree(`export const x = 1`)
    t.write(tooltip)
    expect(t.run().exit).toBe(1)
  })

  it("text anywhere in a log call's arguments is the log's, at a sink or not; the same data outside a log is the user's", () => {
    const logs = lines(
      'declare const log: { info(...a: unknown[]): void; warn(...a: unknown[]): void }',
      'declare const on: boolean',
      `log.info({ message: 'none' })`,
      "log.warn('Retrying the push', { detail: `${on ? 'a reason here' : 'none'}`, label: ['first thing'].join(', ') })",
      `console.error({ title: 'Could not save the file' })`
    )
    expect(sitesIn(logs)).toEqual({ sites: [], problems: [] })
    const ui = lines('declare function show(x: unknown): void', 'declare const on: boolean', `show({ message: 'none' })`, "show({ detail: `${on ? 'a reason here' : 'none'}` })")
    expect(sitesIn(ui).sites.sort()).toEqual(['prop|detail|a reason here', 'prop|detail|none', 'prop|message|none'])
  })
})

describe("Combwork's own source", () => {
  it('has no new hard-coded UI text, and its allowlists are no bigger than at the merge base', () => {
    const ref = defaultBaseRef(ROOT)
    const base = baseLists(ROOT, ref) as { base: string; lists: Lists | null } | null
    // CI checks out the history (fetch-depth 0), so it always has a base to compare with.
    if (process.env.CI) expect(base, `no merge base with ${ref}`).not.toBeNull()
    const r = runGuard({ root: ROOT, against: base?.lists ?? undefined }) as Result
    expect(r.exit, r.lines.join('\n')).toBe(0)
  }, 120_000)

  it('a new hard-coded string in a real file fails, against its real allowlist', () => {
    const rel = 'src/renderer/src/components/Board.tsx'
    const root = tempDir('hive-i18n-guard-real-')
    roots.push(root)
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    mkdirSync(join(root, ALLOW_DIR), { recursive: true })
    const code = readFileSync(join(ROOT, rel), 'utf8')
    writeFileSync(join(root, rel), code)
    // Its list, while it has one: a file whose text is all converted has none (#798 emptied Board.tsx's).
    if (existsSync(join(ROOT, ALLOW_DIR, allowName(rel)))) cpSync(join(ROOT, ALLOW_DIR, allowName(rel)), join(root, ALLOW_DIR, allowName(rel)))
    expect(runGuard({ root }).exit).toBe(0)
    writeFileSync(join(root, rel), `${code}\nexport const Saved = () => <span title="Saved">Saved just now</span>\n`)
    const r = runGuard({ root }) as Result
    expect(r.exit).toBe(1)
    expect(reported(r)).toEqual([expect.stringMatching(/^NEW UI TEXT .*jsx-attr\|title\|Saved$/), expect.stringMatching(/^NEW UI TEXT .*jsx-text\|\|Saved just now$/)])
  }, 60_000)

  it('the command exits 1 on new text, so CI fails', () => {
    const t = tree(`export const row = <span>Save</span>`)
    const cli = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'i18nGuard.mjs'), '--root', t.root, '--no-base', ...args], { encoding: 'utf8', env: ctx.baseEnv() })
    expect(cli().status).toBe(0)
    t.write(`export const row = <span>Saved just now</span>`)
    const r = cli()
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('NEW UI TEXT src/renderer/src/Panel.tsx:1  jsx-text||Saved just now')
  }, 60_000)
})
