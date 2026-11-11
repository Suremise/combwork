// Agent text (dialects, HI-2065), card 3a (HI-2435): the canary dialect over where a card is with the merge queue
// (queueState.ts: card reads, a lane's next, wakes, the queue's comment; gitIntegration.ts: a candidate's log, HI-2827)
// and the workflow runtime's replies and wakes.
// Every word of what they say comes through the catalogue, every queue id is said by some case, and text a record keeps
// (a wake's action, the queue's comment) stays the Default under any dialect until stored text is said when read (5b).
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { setChainResolver, setProcessChain, type DialectChain } from '../src/shared/agentText'
import { canaryProblems, canaryTexts } from '../src/shared/agentText/canary'
import { leftWake, queueLine, resubmittedText, returnedComment, returnedText, staleWake, type QueueState } from '../src/main/workflow/queueState'
import { candidateLog, signingPause } from '../src/main/platform/gitIntegration'
import { checkSigning, signingTestHooks, type SignDeps } from '../src/main/platform/gitSigning'
import type { QueueGitResult } from '../src/main/platform/integration'
import { tempDir } from './tempDir'
import { CAME_BACK } from '../src/shared/workflow/queue'
import type { FactData } from '../src/shared/workflow/facts'
// @ts-expect-error: a plain .mjs module without types
import { readCatalogue } from '../scripts/agentTextExtract.mjs'
import { B1, commit, moved, R1, setup, type Env } from './workflow/harness'
import { preset } from '../src/shared/workflow/options'

const ROOT = join(__dirname, '..')
const catalogue = readCatalogue(ROOT) as Record<string, { text: string }>
const ids = new Set(Object.keys(catalogue))
const chain = (texts: Record<string, string>): DialectChain => ({ texts, files: ['test.json'], hash: 'test' })
const canary = (): void => setProcessChain(chain(canaryTexts(catalogue)))

let env: Env | null = null
afterEach(() => {
  setProcessChain(null)
  setChainResolver(null)
  env?.close()
  env = null
})

type Failed = FactData['IntegrationFailed']
const base: Failed = { entry: 'HI-7/e3', revision: 'abc1234', target: 'main', reason: 'conflict', transient: false }
/** Every kind of return, with what a test passes in it. */
const FAILURES: Failed[] = [
  { ...base, files: ['src/a.ts', 'src/b.ts'], logPath: 'C:/logs/q.log', log: 'one\ntwo\nthree' },
  { ...base, files: Array.from({ length: 30 }, (_, i) => `src/file${i}.ts`) },
  { ...base, files: Array.from({ length: 30 }, (_, i) => `src/a-very-long-folder-name/and-another-one/file-number-${i}.ts`) },
  { ...base },
  // A log path too long for a wake: the pointer to the card instead.
  { ...base, reason: 'hook', logPath: `C:/logs/${'deep/'.repeat(120)}q.log` },
  { ...base, reason: 'checks', check: 'install' },
  { ...base, reason: 'checks', check: 'quick' },
  { ...base, reason: 'checks' },
  { ...base, reason: 'checks', check: 'quick', transient: true, cause: 'network', code: 'ECONNRESET' },
  { ...base, reason: 'checks', transient: true },
  { ...base, reason: 'hook' },
  { ...base, reason: 'targetMoved' },
  // HI-1183's follow mode: the push of the merge refused, and an unknown publication the user said didn't happen.
  { ...base, reason: 'pushRefused' },
  { ...base, reason: 'notPublished' },
  // HI-2892: a forward merge against the release path's direction, never merged.
  { ...base, reason: 'direction' },
  { ...base, reason: 'folderBusy' },
  { ...base, reason: 'notUpToDate' },
  { ...base, reason: 'notUpToDate', files: ['src/a.ts'] },
  { ...base, reason: 'focused', focused: { why: 'repick', paths: ['src/a.ts'] } as never },
  { ...base, reason: 'focused', focused: { why: 'repick' } as never },
  { ...base, reason: 'focused', focused: { why: 'noProof', tests: ['e2e:real-chat'] } as never },
  { ...base, reason: 'focused', focused: { why: 'newProof', tests: ['e2e:packaged'] } as never },
  { ...base, reason: 'focused', focused: { why: 'noRunner' } as never },
  { ...base, reason: 'focused' }
]
const STATES: QueueState[] = [
  { state: 'queued', target: 'main', position: 2 },
  // HI-2709: waiting for its blockers to be Done.
  { state: 'waiting', target: 'main', on: ['HI-4', 'HI-5'] },
  { state: 'testing', target: 'main', step: 'advance' },
  { state: 'testing', target: 'main', step: 'checks' },
  { state: 'testing', target: 'main', step: null },
  ...(['approval', 'mergeChoice', 'needsYou', 'pushFailed', 'folderBusy', 'rulesOff', 'user', 'publishUnknown'] as const).map((reason) => ({ state: 'paused' as const, target: 'main', reason, card: 'HI-6' })),
  { state: 'paused', target: 'main', reason: 'needsYou', card: 'HI-6', stuck: true },
  { state: 'returned', reason: 'conflict', transient: false, failure: FAILURES[0] },
  { state: 'left', why: 'stale' },
  { state: 'left', why: 'decision' },
  { state: 'stale', approved: 'abc1234def', current: null },
  { state: 'merged' },
  { state: 'notYet' }
]
/** What the tests pass in, which isn't Combwork's wording: names, codes, paths and the queue's fixed words. */
const VALUES = ['no-such-signer', '128', 'HI-7','HI-6', 'main', 'abc1234', 'quick', 'network', 'ECONNRESET', 'C:/logs/q.log', 'one | two | three', 'src/a.ts', 'src/b.ts', 'e2e:real-chat', 'e2e:packaged', 'Coder', 'fed4321', CAME_BACK, 'approval', 'mergeChoice', 'needsYou', 'pushFailed', 'folderBusy', 'rulesOff', 'user', 'publishUnknown', '—', 'line 3', 'lines 1, 2', ...FAILURES.flatMap((f) => f.files ?? [])]

function queueTexts(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = []
  for (const q of STATES) out.push({ name: `line ${JSON.stringify(q)}`, text: queueLine(q) })
  out.push({ name: 'line unenforced', text: queueLine({ state: 'notYet' }, false) })
  for (const [i, f] of FAILURES.entries()) {
    out.push({ name: `returned ${i}`, text: returnedText('HI-7', f) })
    out.push({ name: `returned ${i} short`, text: returnedText('HI-7', f, 160) })
    out.push({ name: `resubmitted ${i}`, text: resubmittedText('HI-7', f, 'Coder') })
  }
  // HI-2959: a forward merge's return names the user's choices, not a builder's step.
  out.push({ name: 'returned forward', text: returnedText('HI-7', FAILURES[0], undefined, undefined, { from: 'main', to: 'main' }) })
  out.push({ name: 'stale', text: staleWake('HI-7', 'abc1234', null) })
  for (const to of ['review', 'active'] as const) out.push({ name: `left decision ${to}`, text: leftWake('HI-7', 'decision', to) })
  out.push({ name: 'left stale', text: leftWake('HI-7', 'stale', 'review') })
  // HI-2827: the card's log when its candidate isn't what was reviewed, which R8 (HI-2791) moved into gitIntegration.ts.
  for (const kind of ['notSame', 'notOnTop', 'mergeCommit', 'rebasedNotSame'] as const) out.push({ name: `candidate ${kind}`, text: candidateLog(kind, { card: 'HI-7', revision: 'abc1234def', target: 'main', expected: 'fed4321abc' }) })
  return out
}

/** A git whose config reads answer `settings` (key → value; unset when absent), its other commands as `rest` says. */
const configGit = (settings: Record<string, string>, rest: QueueGitResult = { ok: true, out: '', err: '', code: 0 }): SignDeps['git'] => async (_cwd, args) => {
  if (args[0] !== 'config') return rest
  const key = args.find((a) => settings[a] !== undefined)
  return key ? { ok: true, out: `local\t${settings[key]}\n`, err: '', code: 0 } : { ok: false, out: '', err: '', code: 1 }
}
/** A pause's detail, or an again's message, as the queue gets it. */
const pauseText = (p: ReturnType<typeof signingPause>): string => (p && 'pause' in p ? p.message : p && 'again' in p ? p.again.message : '') ?? ''

/** HI-1185's signing check (gitSigning.ts) and the pause it gives (gitIntegration.ts), HI-2883: a case for each of its texts. */
async function signingTexts(): Promise<{ name: string; text: string }[]> {
  const cwd = tempDir('cw-agenttext-signing-')
  const deps = (git: SignDeps['git']): SignDeps => ({ git, spawn: async () => ({ ok: true, out: '', err: '', code: 0 }), cwd, who: [], env: { PATH: '' } })
  const ssh = { 'commit.gpgsign': 'true', 'gpg.format': 'ssh' }
  const check = async (git: SignDeps['git']): Promise<string> => pauseText(signingPause((await checkSigning(deps(git))).status))
  const out = [
    // A config read that failed saying nothing: its exit code.
    { name: 'signing exited', text: await check(async () => ({ ok: false, out: '', err: '', code: 128 })) },
    // The signer named isn't on the commit's PATH.
    { name: 'signing notFound', text: await check(configGit({ ...ssh, 'gpg.ssh.program': 'no-such-signer' })) },
    { name: 'signing unfinished', text: pauseText(signingPause({ kind: 'couldNotComplete', format: 'ssh' })) }
  ]
  // ssh with no key and no key command: a signer that exists, taken as a known installation (the test-only seam).
  signingTestHooks.eligible = () => true
  try {
    out.push({ name: 'signing noSshKey', text: await check(configGit({ ...ssh, 'gpg.ssh.program': process.execPath })) })
  } finally {
    signingTestHooks.eligible = undefined
  }
  return out
}

describe("the canary dialect over the merge queue lines (queueState.ts, and gitIntegration.ts's candidate logs and signing pauses)", () => {
  it('finds every word in the catalogue, and every queue id in some case', async () => {
    canary()
    const seen = new Set<string>()
    for (const { name, text } of [...queueTexts(), ...(await signingTexts())]) {
      expect(text, name).not.toBe('')
      expect(canaryProblems(text, ids, VALUES), name).toEqual([])
      for (const m of text.matchAll(/⟦([^/⟧][^⟧]*)⟧/g)) seen.add(m[1])
    }
    expect([...ids].filter((id) => id.startsWith('queue.') && !seen.has(id))).toEqual([])
  })

  it('says each the same as before in the Default', () => {
    expect(queueLine({ state: 'queued', target: 'main', position: 2 })).toBe("Combwork merges this card (its rules): don't merge it yourself. It is in the merge queue for main, position 2; it moves to Done once merged.")
    expect(queueLine({ state: 'testing', target: 'main', step: null })).toBe("Combwork merges this card (its rules): don't merge it yourself. The merge queue is testing its merge into main now; it moves to Done once merged.")
    expect(leftWake('HI-7', 'decision', 'active')).toBe('HI-7 left the merge queue: a decision since its approval needs it reviewed again. Read its decisions (cw_read_task), then submit again (cw_submit).')
    expect(resubmittedText('HI-7', { ...base, files: ['src/a.ts'] }, 'Coder')).toBe('HI-7 is back in Review after the merge queue returned it (a conflict with main in src/a.ts); Coder resolved it and submitted it again: review the resolution')
    expect(returnedText('HI-7', { ...base, reason: 'checks', check: 'quick', transient: true })).toBe(`HI-7 ${CAME_BACK}: the merge check quick failed for the environment, not the work (temporary). Submit the same revision again (cw_submit): it goes straight back into the queue, at most twice in a row.`)
  })

  it("keeps the queue's comment on a returned card in the Default: it is stored, and any reader reads it", () => {
    const before = returnedComment('HI-7', FAILURES[0]).text
    canary()
    expect(returnedComment('HI-7', FAILURES[0]).text).toBe(before)
    expect(before).not.toContain('⟦')
  })
})

describe('the canary dialect over the workflow runtime (runtime.ts)', () => {
  const team = (): Env => (env = setup({ ...preset('git', 'team', { quick: ['quick'], tests: [] }), preChecks: [], okBefore: { mode: 'never', labels: [] }, commands: { quick: 'npm run quick' } }))

  it("says a reply's warnings in the caller's dialect, and keeps the wakes it records in the Default", async () => {
    const e = team()
    const card = e.wf.createCard({ title: 'Change' })
    canary()
    const s = await e.wf.start(card.key, B1)
    moved(s)
    for (const w of s.warnings ?? []) expect(canaryProblems(w, ids, [card.key, String(s.data?.slot ?? ''), String(s.data?.line ?? ''), String(s.data?.target ?? '')]), w).toEqual([])
    commit(s.data!.folder as string, { 'src/a.txt': 'a\n' }, `${card.key}: change`)
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: false, comment: 'no' }))
    const wakes = e.wakes.map((w) => w.why)
    expect(wakes).toContain(`${card.key} failed review`)
    for (const w of wakes) expect(w).not.toContain('⟦')
  })
})

// The schema has every id this card's files say, each with the placeholders its text has (agentTextExtract.mjs --check
// keeps it current; this names the areas so a missing file fails here).
it('has the queue and runtime areas in the catalogue', () => {
  for (const area of ['queue', 'runtime']) expect(Object.keys(JSON.parse(readFileSync(join(ROOT, 'agent-text', 'schema', `${area}.json`), 'utf8'))).length).toBeGreaterThan(10)
})
