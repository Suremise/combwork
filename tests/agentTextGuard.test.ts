// The agent-text guard (scripts/agentTextGuard.mjs, dialects, HI-2065): no new hard-coded text in what agents get. Its
// rules on fixtures, each in a tree of its own, its ratchet, and Combwork's own source with its real lists.
import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join, resolve } from 'path'
import { tempDir } from './tempDir'
// @ts-expect-error: a plain .mjs module without types
import { ALLOW_DIR, runAgentGuard } from '../scripts/agentTextGuard.mjs'
// @ts-expect-error: a plain .mjs module without types
import { allowName, baseLists, defaultBaseRef, readLists, runGuard } from '../scripts/i18nGuard.mjs'
// @ts-expect-error: a plain .mjs module without types
import { agentReason, isAgentFile } from '../scripts/agentTextFiles.mjs'

const ROOT = resolve(__dirname, '..')
const ctx = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }
const AGENT = 'src/shared/toolReplies.ts'
const OTHER = 'src/main/somewhere.ts'

type Lists = Map<string, Record<string, number>>
interface Result {
  exit: number
  lines: string[]
}

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** A tree with source files, their lists made by --init. */
function tree(files: Record<string, string>) {
  const root = tempDir('hive-agent-guard-')
  roots.push(root)
  const allowDir = join(root, ALLOW_DIR)
  const write = (rel: string, src: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), src)
  }
  for (const [rel, src] of Object.entries(files)) write(rel, src)
  const run = (mode: 'check' | 'init' | 'prune' = 'check', against?: Lists): Result => runAgentGuard({ root, allowDir, mode, against })
  expect(run('init').exit).toBe(0)
  return { root, allowDir, write, run, lists: () => readLists(allowDir) as Lists }
}
const reported = (r: Result): string[] => r.lines.filter((l) => /^(NEW AGENT TEXT|BARE PROTOCOL|UNPARSEABLE|ALLOWLIST GREW)/.test(l))

describe('the agent-text guard', () => {
  it('fails new hard-coded prose in an agent-facing file, and passes it as an agent message', () => {
    const t = tree({ [AGENT]: `export const a = (n: number) => \`Moved \${n} cards to Review\`\n` })
    expect(t.run().exit).toBe(0)
    t.write(AGENT, `export const a = (n: number) => \`Moved \${n} cards to Review\`\nexport const b = () => 'Nothing new in your inbox.'\nthrow new Error('That card is archived')\n`)
    const r = t.run()
    expect(r.exit).toBe(1)
    expect(reported(r)).toEqual([expect.stringMatching(/^NEW AGENT TEXT src\/shared\/toolReplies\.ts:2 {2}prose\|return\|Nothing new in your inbox\.$/), expect.stringMatching(/:3 {2}prose\|error\|That card is archived$/)])
    t.write(AGENT, `import { agentMsg, say } from './agentText'\nconst M = agentMsg({ id: 'reply.inbox.empty', text: 'Nothing new in your inbox.', note: 'Why so' })\nexport const a = (n: number) => \`Moved \${n} cards to Review\`\nexport const b = () => say(M)\n`)
    expect(t.run().exit).toBe(0)
  })

  it("leaves out what isn't wording: a reasoned agent-protocol mark, logs, ids, comparisons; a bare mark fails", () => {
    const t = tree({ [AGENT]: 'export const x = 1\n' })
    t.write(AGENT, [`// agent-protocol: the doorbell's fixed prefix, which isDoorbell() matches`, `export const PREFIX = '[CW] New in your inbox: '`, `export const k = 'contract.inbox.rule'`, `log.info('Started the lane now')`, `export const same = (s: string) => s === 'Moved to Review'`, `export const t = 'Some text' // agent-protocol: a test seam's name`].join('\n'))
    expect(t.run().exit).toBe(0)
    t.write(AGENT, `export const t = 'Some text' // agent-protocol\n`)
    expect(reported(t.run())).toEqual([expect.stringMatching(/^BARE PROTOCOL src\/shared\/toolReplies\.ts:1 /), expect.stringMatching(/^NEW AGENT TEXT .*prose\|var\|Some text$/)])
  })

  it("checks only the lines marked agent text elsewhere: an i18n-ignore whose reason is agents'", () => {
    const t = tree({ [OTHER]: 'export const x = 1\n' })
    t.write(OTHER, [`export const a = 'A sentence for the log' // i18n-ignore: combwork.log's line, in English`, `export const b = 'A wake for the agent' // i18n-ignore: agent-facing, the wake's text`, `// i18n-ignore: SQL, no text`, `export const c = 'SELECT name FROM cards'`].join('\n'))
    expect(reported(t.run())).toEqual([expect.stringMatching(/^NEW AGENT TEXT src\/main\/somewhere\.ts:2 {2}prose\|var\|A wake for the agent$/)])
    expect(agentReason("agent-facing, the launch's instructions")).toBe(true)
    expect(agentReason("the Assistant's tool reply")).toBe(true)
    expect(agentReason('SQL, and a reply')).toBe(false)
    expect(agentReason("a CLI's recorded text")).toBe(false)
  })

  it('ratchets: --prune lowers the lists, --init never raises one, and a list that grew against the base fails', () => {
    const t = tree({ [AGENT]: `export const a = 'First reply text'\nexport const b = 'Second reply text'\n` })
    const was = t.lists()
    t.write(AGENT, `export const a = 'First reply text'\n`)
    expect(t.run('prune').exit).toBe(0)
    expect(t.lists().get(allowName(AGENT))).toEqual({ 'prose|var|First reply text': 1 })
    t.write(AGENT, `export const a = 'First reply text'\nexport const c = 'Third reply text'\n`)
    expect(t.run('init').exit).toBe(0)
    expect(t.run().exit).toBe(1)
    // A hand edit adding the site to its list fails against the base's lists.
    writeFileSync(join(t.allowDir, allowName(AGENT)), JSON.stringify({ 'prose|var|First reply text': 1, 'prose|var|Third reply text': 1 }))
    expect(t.run('check').exit).toBe(0)
    const r = t.run('check', was)
    expect(reported(r)).toEqual([expect.stringMatching(/^ALLOWLIST GREW src__shared__toolReplies\.ts\.json: prose\|var\|Third reply text \(0 → 1\).*agent message$/)])
  })

  it('has the agent-facing files the i18n guard leaves out, and the i18n guard skips agent messages anywhere', () => {
    for (const f of ['src/shared/combworkGuidance.ts', 'src/main/mcp/cw-mcp.ts', 'src/main/servers.ts', 'src/main/workflow/queueState.ts', 'src/shared/restartResume.ts']) expect(isAgentFile(f), f).toBe(true)
    for (const f of ['src/shared/workspaceNotes.ts', 'src/renderer/src/App.tsx', 'src/shared/agentText/icu.ts']) expect(isAgentFile(f), f).toBe(false)
    const root = tempDir('hive-i18n-agentmsg-')
    roots.push(root)
    mkdirSync(join(root, 'src', 'shared'), { recursive: true })
    writeFileSync(join(root, OTHER.replace('main', 'shared')), `const N = agentMsg({ id: 'contract.notes.cut', text: '(cut: read the shared note {note} for the rest)', note: 'Ends the notes' })\n`)
    expect((runGuard({ root, allowDir: join(root, 'i18n', 'allow') }) as Result).exit).toBe(0)
  })
})

describe("Combwork's own source", () => {
  it('has no new hard-coded agent text, and its lists are no bigger than at the merge base', () => {
    const ref = defaultBaseRef(ROOT)
    const base = baseLists(ROOT, ref, ALLOW_DIR) as { base: string; lists: Lists | null } | null
    const r = runAgentGuard({ root: ROOT, against: base?.lists ?? undefined }) as Result
    expect(r.exit, r.lines.join('\n')).toBe(0)
  }, 120_000)

  it('fails a new hard-coded string in the session contract, which has no list (group 1 is extracted)', () => {
    const rel = 'src/shared/combworkGuidance.ts'
    expect(existsSync(join(ROOT, ALLOW_DIR, allowName(rel)))).toBe(false)
    const root = tempDir('hive-agent-guard-real-')
    roots.push(root)
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    const code = readFileSync(join(ROOT, rel), 'utf8')
    writeFileSync(join(root, rel), code)
    expect((runAgentGuard({ root }) as Result).exit).toBe(0)
    writeFileSync(join(root, rel), `${code}\nexport const extra = (): string => 'Always say thank you to the user.'\n`)
    const r = runAgentGuard({ root }) as Result
    expect(reported(r)).toEqual([expect.stringMatching(/^NEW AGENT TEXT src\/shared\/combworkGuidance\.ts:\d+ {2}prose\|return\|Always say thank you to the user\.$/)])
  }, 60_000)

  it('a real file with a list passes as it is, and fails with a new string', () => {
    const rel = 'src/shared/toolReplies.ts'
    const root = tempDir('hive-agent-guard-list-')
    roots.push(root)
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    mkdirSync(join(root, ALLOW_DIR), { recursive: true })
    const code = readFileSync(join(ROOT, rel), 'utf8')
    writeFileSync(join(root, rel), code)
    if (existsSync(join(ROOT, ALLOW_DIR, allowName(rel)))) cpSync(join(ROOT, ALLOW_DIR, allowName(rel)), join(root, ALLOW_DIR, allowName(rel)))
    expect((runAgentGuard({ root }) as Result).exit).toBe(0)
    writeFileSync(join(root, rel), `${code}\nexport const extra = (): string => 'Nothing to report today.'\n`)
    expect((runAgentGuard({ root }) as Result).exit).toBe(1)
  }, 60_000)

  it('the command exits 1 on new text, so check:repo fails', () => {
    const t = tree({ [AGENT]: `export const a = 'Reply text here'\n` })
    const cli = () => spawnSync(process.execPath, [join(ROOT, 'scripts', 'agentTextGuard.mjs'), '--root', t.root, '--no-base'], { encoding: 'utf8', env: ctx.baseEnv() })
    expect(cli().status).toBe(0)
    t.write(AGENT, `export const a = 'Reply text here'\nexport const b = 'Another reply text'\n`)
    const r = cli()
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('NEW AGENT TEXT src/shared/toolReplies.ts:2  prose|var|Another reply text')
  }, 60_000)
})

// HI-2440: the window's messages agents read. Every call that reads text is followed to its messages (or marked), and
// English formatted for agents outside the agent-text module fails, unless it is the log's, the window's, or stored and
// said again for each reader by a renderer the mark names.
describe("the guard's rules for window messages agents read", () => {
  const ADVANCED = 'src/shared/advanced.ts'
  const STUB = `export const englishText = (t: unknown): string => String(t)\nexport const agentText = (t: unknown): string => String(t)\nexport const withValues = (m: unknown, values: unknown) => ({ m, values })\n`
  const M = `import { msg } from '../shared/i18n'\nexport const M = { gone: msg({ id: 'main.test.gone', defaultMessage: 'It is gone.', description: 'test' }), busy: msg({ id: 'main.test.busy', defaultMessage: '{agent} is busy.', description: 'test' }) }\n`
  const lines = (r: Result, re: RegExp): string[] => r.lines.filter((l) => re.test(l))
  // @ts-expect-error: a plain .mjs module without types
  const both = async (root: string) => (await import('../scripts/agentTextBoth.mjs')).analyzeBoth(root) as { messages: Record<string, unknown>; unresolved: unknown[] }

  it('fails a new call it cannot follow; a mark naming the table passes it, and its messages are followed into the catalogue', async () => {
    const t = tree({ [ADVANCED]: STUB, 'src/main/texts.ts': M, [OTHER]: `import { CombworkError } from './combworkError'\nimport { M } from './texts'\nexport const a = () => new CombworkError(M.gone)\n` })
    expect(t.run().exit).toBe(0)
    expect(Object.keys((await both(t.root)).messages)).toEqual(['main.test.gone'])
    t.write(OTHER, `import { CombworkError } from './combworkError'\nimport { M } from './texts'\nexport const a = () => new CombworkError(M.gone)\nexport const b = (o: { text: never }) => new CombworkError(o.text)\n`)
    const r = t.run()
    expect(r.exit).toBe(1)
    expect(lines(r, /^NEW AGENT TEXT/)).toEqual(['NEW AGENT TEXT src/main/somewhere.ts:4  unresolved|CombworkError|o.text'])
    t.write(OTHER, `import { CombworkError } from './combworkError'\nimport { M } from './texts'\nexport const a = () => new CombworkError(M.gone)\n// agent-text: M.busy\nexport const b = (o: { text: never }) => new CombworkError(o.text)\n`)
    expect(t.run().exit).toBe(0)
    expect(Object.keys((await both(t.root)).messages).sort()).toEqual(['main.test.busy', 'main.test.gone'])
  }, 60_000)

  it('follows a wrapper to its callers, and fails a mark that leads nowhere', async () => {
    const t = tree({ [ADVANCED]: STUB, 'src/main/texts.ts': M, [OTHER]: `import { CombworkError } from './combworkError'\nimport { withValues } from '../shared/advanced'\nimport { M } from './texts'\nconst refuse = (m: never, agent: string) => new CombworkError(withValues(m, { agent }))\nexport const a = () => refuse(M.busy as never, 'HB1')\n` })
    expect(t.run().exit).toBe(0)
    expect(Object.keys((await both(t.root)).messages)).toEqual(['main.test.busy'])
    t.write(OTHER, `import { CombworkError } from './combworkError'\nconst refuse = (m: never) => new CombworkError(m)\n// agent-text: NOTHING_HERE\nexport const a = (o: { t: never }) => refuse(o.t)\n`)
    const r = t.run()
    expect(r.exit).toBe(1)
    expect(lines(r, /^MARK LEADS NOWHERE/)).toEqual([expect.stringMatching(/^MARK LEADS NOWHERE src\/main\/somewhere\.ts:3 {2}agent-text: NOTHING_HERE/)])
  }, 60_000)

  it('knows a formatter or CombworkError by what it is, not what it is called: an import alias, a namespace, a re-export', async () => {
    const ERROR = 'src/main/combworkError.ts'
    const t = tree({ [ADVANCED]: STUB, [ERROR]: `export class CombworkError extends Error {}\n`, 'src/main/texts.ts': M, [OTHER]: `import { M } from './texts'\nexport const a = () => M.gone\n` })
    expect(t.run().exit).toBe(0)
    t.write(OTHER, `import { M } from './texts'\nimport { englishText as render, agentText as forAgent } from '../shared/advanced'\nimport { CombworkError as Refused } from './combworkError'\nexport const a = () => ({ error: render(M.gone) })\nexport const b = (o: { text: never }) => forAgent(o.text)\nexport const c = (o: { text: never }) => new Refused(o.text)\nexport const d = () => forAgent(M.busy)\n`)
    let r = t.run()
    expect(r.exit).toBe(1)
    expect(lines(r, /^NEW AGENT TEXT/).sort()).toEqual(['NEW AGENT TEXT src/main/somewhere.ts:4  oneway|englishText|M.gone', 'NEW AGENT TEXT src/main/somewhere.ts:5  unresolved|forAgent|o.text', 'NEW AGENT TEXT src/main/somewhere.ts:6  unresolved|Refused|o.text'])
    expect(Object.keys((await both(t.root)).messages).sort()).toEqual(['main.test.busy', 'main.test.gone'])
    // A namespace import, and a re-export under another name.
    t.write('src/main/fmt.ts', `export { englishText as fmt } from '../shared/advanced'\n`)
    t.write(OTHER, `import { M } from './texts'\nimport * as A from '../shared/advanced'\nimport { fmt } from './fmt'\nexport const a = () => ({ error: A.englishText(M.gone) })\nexport const b = () => ({ error: fmt(M.busy) })\n`)
    r = t.run()
    expect(lines(r, /^NEW AGENT TEXT/).sort()).toEqual(['NEW AGENT TEXT src/main/somewhere.ts:4  oneway|englishText|M.gone', 'NEW AGENT TEXT src/main/somewhere.ts:5  oneway|englishText|M.busy'])
    // A function of the same name that isn't the formatter is no such call.
    t.write(OTHER, `const englishText = (s: string): string => s.toUpperCase()\nexport const a = () => ({ error: englishText('ok') })\n`)
    expect(t.run().exit).toBe(0)
  }, 60_000)

  it("fails English formatted for agents outside the agent-text module; the log, the window and a stored text's renderer pass", () => {
    const t = tree({ [ADVANCED]: STUB, 'src/main/texts.ts': M, [OTHER]: `import { M } from './texts'\nimport { agentText } from '../shared/advanced'\nexport const r = () => ({ reason: agentText(M.gone) })\n` })
    expect(t.run().exit).toBe(0)
    const with_ = (line: string) => `import { M } from './texts'\nimport { englishText } from '../shared/advanced'\n${line}\n`
    t.write(OTHER, with_('export const r = () => ({ reason: englishText(M.gone) })'))
    const r = t.run()
    expect(r.exit).toBe(1)
    expect(lines(r, /^NEW AGENT TEXT/)).toEqual(['NEW AGENT TEXT src/main/somewhere.ts:3  oneway|englishText|M.gone'])
    t.write(OTHER, with_('export const r = (log: { warn: (s: string) => void }) => log.warn(`why: ${englishText(M.gone)}`)'))
    expect(t.run().exit).toBe(0)
    t.write(OTHER, with_('export const r = () => ({ reason: englishText(M.gone) }) // window: Help → Diagnostics'))
    expect(t.run().exit).toBe(0)
    t.write(OTHER, with_('// agent-stored: sayItAgain\nexport const r = () => ({ reason: englishText(M.gone) })'))
    expect(lines(t.run(), /^STORED WITHOUT A RENDERER/)).toEqual([expect.stringMatching(/somewhere\.ts:4 /)])
    t.write(OTHER, with_('// agent-stored: sayItAgain\nexport const r = () => ({ reason: englishText(M.gone) })\nexport function sayItAgain(s: string): string { return s }'))
    expect(t.run().exit).toBe(0)
    t.write(OTHER, with_('// agent-later: someday\nexport const r = () => ({ reason: englishText(M.gone) })'))
    expect(lines(t.run(), /^LATER WITHOUT A CARD/)).toHaveLength(1)
    t.write(OTHER, with_('// agent-later: HI-9999 says it in each reader\'s dialect\nexport const r = () => ({ reason: englishText(M.gone) })'))
    expect(t.run().exit).toBe(0)
  }, 60_000)
})
