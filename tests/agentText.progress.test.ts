// The canary dialect over hive-progress's text and its run links' refusals (dialects, HI-2438, card 5; design section 2,
// check 4): every word the wrapper prints, and every refusal of what a run names, comes through the catalogue.
import { afterEach, describe, expect, it } from 'vitest'
import { canaryProblems, canaryTexts } from '../src/shared/agentText/canary'
import { setProcessChain, type DialectChain } from '../src/shared/agentText'
import { parseArgs, revisionProblem, unansweredLine, uncountedLine, unrecordedLine, usage } from '../src/main/progressReporters/wrapper'
import { resolveRunLink, type RunLinkDeps } from '../src/main/workflow/runLink'
// @ts-expect-error: a plain .mjs module without types
import { readCatalogue } from '../scripts/agentTextExtract.mjs'
import { join } from 'path'
import { tempDir } from './tempDir'

const ROOT = join(__dirname, '..')
const catalogue = readCatalogue(ROOT) as Record<string, { text: string }>
const ids = new Set(Object.keys(catalogue))
const chain = (texts: Record<string, string>): DialectChain => ({ texts, files: ['test.json'], hash: 'test' })

afterEach(() => setProcessChain(null))

const seenIn = (texts: string[]): Set<string> => new Set(texts.flatMap((t) => [...t.matchAll(/⟦([^/⟧][^⟧]*)⟧/g)].map((m) => m[1])))

describe('the canary dialect over hive-progress (card 5)', () => {
  it("finds every word of the wrapper's text in the catalogue, and each progress id in some line", () => {
    setProcessChain(chain(canaryTexts(catalogue)))
    const out: { text: string; values: string[] }[] = []
    const add = (text: string | null, values: string[] = []): void => {
      if (text !== null) out.push({ text, values })
    }
    add(usage())
    for (const argv of [['--check', 'focused:b'], ['--check', 'lint', '--', 'x'], ['--check=', '--', 'x'], ['--isolated', '--', 'x'], ['--card'], ['--title'], ['--x'], ['--'], []]) {
      const r = parseArgs(argv)
      add('error' in r ? r.error : null, ['focused:b', 'lint', 'title', '--x'])
    }
    add(revisionProblem(process.cwd(), '-x', process.env))
    add(revisionProblem(process.cwd(), 'nosuchref123', process.env), [process.cwd(), 'nosuchref123'])
    add(revisionProblem(process.cwd(), 'HEAD~1', process.env), ['HEAD~1'])
    const bare = tempDir('cw-progress-canary-')
    add(revisionProblem(bare, 'HEAD', process.env), [bare, 'HEAD'])
    for (const why of ['notCheck', 'notContained', 'dirty', 'moved', 'changed', 'revisionChanged'])
      for (const changes of [[], ['a.ts', ':reflog', ':edit']]) for (const isolated of [true, false]) add(uncountedLine({ check: { name: 'lint', counted: false, whyNot: why, changes, platform: 'git' } }, isolated), ['lint', 'a.ts'])
    for (const o of ['noStart', 'noReply', 'refused', 'endedBefore'] as const) add(unrecordedLine(o, 'lint'), ['lint'])
    for (const check of ['lint', null])
      for (const asked of [1, 2]) {
        add(unansweredLine({ unreachable: true, why: 'slow', detail: 'TimeoutError' }, check, 5400, 'http://x', asked), ['lint', '5', '2', 'http://x'])
        for (const d of ['ECONNREFUSED', 'EACCES']) add(unansweredLine({ unreachable: true, why: 'refused', detail: d }, check, 1, 'http://x', asked), ['lint', 'EACCES', 'http://x'])
        for (const st of [500, null]) add(unansweredLine({ unreachable: true, why: 'failed', detail: '', status: st }, check, 1, 'u', asked), ['lint', '500'])
        add(unansweredLine({ unreachable: true, why: 'failed', detail: 'boom' }, check, 1, 'u', asked), ['lint', 'boom'])
      }
    for (const { text, values } of out) expect(canaryProblems(text, ids, values), text).toEqual([])
    // The lines runWrapped writes itself (the outside-Combwork refusal, the wait, the isolated launcher's, a command not
    // found, a failed run's stored detail) are said in its I/O: the e2e progressreport suite runs them. They are listed.
    const inRun = ['progress.check.outsideCombwork', 'progress.check.waiting', 'progress.run.exitCode', 'progress.run.commandNotFound', 'progress.isolated.launcherDidntStart', 'progress.isolated.notRun', 'progress.isolated.notRunStatus', 'progress.isolated.notRunUnreachable']
    const seen = seenIn(out.map((o) => o.text))
    expect([...ids].filter((id) => id.startsWith('progress.') && !seen.has(id) && !inRun.includes(id))).toEqual([])
    expect(inRun.filter((id) => !ids.has(id))).toEqual([])
  })

  it("finds every word of a run link's refusals in the catalogue, and each check id in some refusal", async () => {
    setProcessChain(chain(canaryTexts(catalogue)))
    const deps = (o: { copy?: { copy: string; card: number | null; revision: string | null }; cardRun?: unknown; head?: string | null; commit?: string | null } = {}): RunLinkDeps => ({
      card: async (n) => (n === 99 ? null : { project: 'alpha', column: 'doing', agent: 'a1' }),
      doing: async () => [12],
      cardRun: async () => (o.cardRun ?? null) as never,
      head: async () => (o.head === undefined ? 'a'.repeat(40) : o.head),
      commitOf: async () => (o.commit === undefined ? 'b'.repeat(40) : o.commit),
      projectName: () => 'alpha',
      keyCard: (k) => (k === 'HI-404' ? null : 12),
      checkCommand: async () => null,
      copyAt: async () => o.copy ?? null
    })
    const agent = { source: 'agent', projectPath: 'C:/ws/alpha', agentId: 'a1', workspacePath: 'C:/ws' } as never
    const script = { source: 'script', workspacePath: 'C:/ws' } as never
    const F = 'C:/ws/alpha'
    const cases: [unknown, Record<string, unknown>, RunLinkDeps][] = [
      [agent, { card: 12 }, deps()],
      [agent, { folder: 'rel' }, deps()],
      [agent, { card: 'HI-404' }, deps()],
      [agent, { folder: F, card: '#13' }, deps({ copy: { copy: 'copy-2', card: 12, revision: 'r' } })],
      [agent, { folder: F, revision: '-x' }, deps()],
      [agent, { revision: 'abc' }, deps()],
      [agent, { folder: F, revision: 'abc' }, deps({ cardRun: { tested: null, revision: null, testedIs: 'content' } })],
      [agent, { folder: F, revision: 'abc' }, deps({ cardRun: { tested: 'f'.repeat(64), revision: 'x', testedIs: 'content' } })],
      [agent, { folder: F, revision: 'abc' }, deps({ head: null })],
      [agent, { folder: F, revision: 'abc' }, deps({ commit: null })],
      [agent, { folder: F, revision: 'abc' }, deps()],
      [agent, { check: 'focused:a\u0001' }, deps()],
      [agent, { check: 'bad name!' }, deps()],
      [script, { check: 'lint' }, deps()],
      [agent, { check: 'lint' }, deps()]
    ]
    const texts: string[] = []
    for (const [caller, asked, d] of cases) {
      const text = await resolveRunLink(caller as never, asked, d).then(() => 'resolved', (e: Error) => e.message)
      expect(canaryProblems(text, ids, ['HI-404', '#12', '#13', 'copy-2', 'abc', 'fffffff', 'aaaaaaa', F, 'alpha', 'lint']), JSON.stringify(asked)).toEqual([])
      texts.push(text)
    }
    const seen = seenIn(texts)
    expect([...ids].filter((id) => id.startsWith('check.') && !seen.has(id))).toEqual([])
  })
})
