// The merge queue's checks as Hive's own runs (#1349, SPEC §16.9.1 steps 5 and 8, §16.13): the runner (queueChecks.ts)
// on real temporary repositories with P2's MergeQueue: only a counted green advances, a check that changed the folder is
// tested again and then pauses, installs from scratch when the manifests changed (or always), transient vs red, the
// environment a check gets, and S4's and S13's cores.
import { afterEach, describe, expect, it } from 'vitest'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tempDir } from '../tempDir'
import { B1, commit, moved, R1, setup, sh, type Env } from './harness'
import { allOff, preset, takesOption } from '../../src/shared/workflow/options'
import { resolveOptions } from '../../src/main/workflow/rulesets'
import { MAX_RETESTS } from '../../src/main/workflow/mergeQueue'
import { checkEnv, classifyCheckFailure, installPlan, MAX_LOG_BYTES, programFound, progressRuns, queueChecks, type LogIo, type QueueRuns } from '../../src/main/workflow/queueChecks'
import { HIVE_RUNS, keptRuns, ProgressStore } from '../../src/main/progress'
import { publicRun } from '../../src/main/apiEvents'
import type { RunCheck } from '../../src/shared/types'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

/** Team's options with one merge check, `check`, whose command is `check` (a card's ruleset takes it when it starts). */
const team = (over: Partial<ReturnType<typeof preset>> = {}, check = 'check') =>
  (env = setup({ ...preset('git', 'team', { quick: ['check'], tests: [] }), preChecks: [], okBefore: { mode: 'never', labels: [] }, mergeInstall: 'onManifestChange', commands: { check }, ...over }))

/** A card approved and queued: started by B1, committed, submitted, passed by R1. */
async function queued(e: Env, title = 'Change', files: Record<string, string> = { 'src/c.txt': 'c\n' }) {
  const card = e.wf.createCard({ title })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  const folder = s.data!.folder as string
  commit(folder, files, `${card.key}: ${title}`)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  moved(await e.wf.startReview(card.key, R1))
  moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  return { card, folder }
}

const mainHead = (e: Env) => sh(e.project, 'rev-parse', 'main')

/** A node script outside the repository, run as a check's command (the queue's folder is its working folder). */
function script(body: string): string {
  const f = join(tempDir('qc-script-'), 'check.cjs')
  writeFileSync(f, body)
  return `"${process.execPath}" "${f}"`
}

/** A check's environment base as a session's would have it, with what must never reach a check. */
const base = (): Record<string, string> => ({
  PATH: process.env.PATH ?? '',
  SystemRoot: process.env.SystemRoot ?? '',
  ComSpec: process.env.ComSpec ?? 'cmd.exe',
  HIVE_TOKEN: 'secret',
  Hive_Agent_Id: 'B1',
  ELECTRON_RUN_AS_NODE: '1'
})

/** Hive's runs as the runner reports them. */
function runsLog() {
  const started: Parameters<QueueRuns['start']>[0][] = []
  const finished: { id: string; ok: boolean; exitCode: number | null; logPath: string | null }[] = []
  const counted: { id: string; c: RunCheck }[] = []
  const runs: QueueRuns = {
    start: (r) => (started.push(r), `run${started.length}`),
    finish: (id, end) => void finished.push({ id, ...end }),
    counts: (id, c) => void counted.push({ id, c })
  }
  return { runs, started, finished, counted }
}

function runner(over: Partial<Parameters<typeof queueChecks>[0]> = {}) {
  const log = runsLog()
  const r = queueChecks({ env: base, runs: log.runs, logDir: tempDir('qc-logs-'), timeoutMs: () => 60_000, setupCommand: () => '', ...over })
  return { ...r, ...log }
}

describe('classifying a failed check (§16.9.1 step 8)', () => {
  it('a spawn error, the shell finding no such command, a time limit or a kill are transient; any other failure is red', () => {
    const end = { exitCode: 1, signal: null, output: '' }
    expect(classifyCheckFailure({ ...end, spawnError: true })).toBe('transient')
    expect(classifyCheckFailure({ ...end, timedOut: true })).toBe('transient')
    expect(classifyCheckFailure({ ...end, exitCode: null, signal: 'SIGTERM' })).toBe('transient')
    expect(classifyCheckFailure({ ...end, exitCode: 0xc000013a })).toBe('transient')
    expect(classifyCheckFailure({ ...end, exitCode: 9009 }, 'win32')).toBe('transient')
    expect(classifyCheckFailure({ ...end, exitCode: 127 }, 'linux')).toBe('transient')
    expect(classifyCheckFailure({ ...end, exitCode: 127 }, 'win32')).toBe('red')
    expect(classifyCheckFailure(end)).toBe('red')
    expect(classifyCheckFailure({ ...end, exitCode: 2, output: 'ENOTFOUND registry.npmjs.org' })).toBe('red') // #1362 decides this one
  })
})

describe("finding a check's program before it starts (Windows: cmd exits 1 for one it can't find)", () => {
  it('finds a program on PATH or by its path, quoted or not, and cmd\'s own commands; a variable is left to the shell', () => {
    const e = base()
    const cwd = tempDir('qc-find-')
    expect(programFound(`"${process.execPath}" -v`, e, cwd, 'win32')).toBe(true)
    expect(programFound('git status', e, cwd, 'win32')).toBe(true)
    expect(programFound('echo hi && exit 1', e, cwd, 'win32')).toBe(true)
    expect(programFound('%COMSPEC% /c exit 0', e, cwd, 'win32')).toBe(true)
    expect(programFound('hive-no-such-command-1349 --x', e, cwd, 'win32')).toBe(false)
    expect(programFound('"C:\\no\\such\\tool.exe"', e, cwd, 'win32')).toBe(false)
    expect(programFound('hive-no-such-command-1349', e, cwd, 'linux')).toBe(true)
  })
})

describe("a check's environment", () => {
  it('has no HIVE_* variable (in any case) and none of Electron\'s switches, and keeps the rest', () => {
    const e = checkEnv({ ...base(), hive_port: '47821', electron_run_as_node: '1', CHROME_CRASHPAD_PIPE_NAME: 'x', FOO: 'bar' })
    expect(Object.keys(e).filter((k) => /^hive_|^electron_|crashpad/i.test(k))).toEqual([])
    expect(e.FOO).toBe('bar')
    expect(e.PATH).toBe(process.env.PATH ?? '')
  })
})

describe('the install from scratch', () => {
  it("is a package manager's install in its clean form with its flags; anything else as written; npm ci for a lock file; else none", () => {
    const dir = tempDir('qc-install-')
    const clean = (command: string) => ({ command, how: 'clean' })
    const written = (command: string) => ({ command, how: 'asWritten' })
    expect(installPlan('npm install', dir)).toEqual(clean('npm ci'))
    expect(installPlan('npm i', dir)).toEqual(clean('npm ci'))
    expect(installPlan('npm install --no-audit --ignore-scripts --no-fund', dir)).toEqual(clean('npm ci --no-audit --ignore-scripts --no-fund'))
    expect(installPlan('npm.cmd i --legacy-peer-deps', dir)).toEqual(clean('npm ci --legacy-peer-deps'))
    expect(installPlan('npm ci --prefer-offline', dir)).toEqual(clean('npm ci --prefer-offline'))
    expect(installPlan('pnpm install --prefer-offline', dir)).toEqual(clean('pnpm install --frozen-lockfile --prefer-offline'))
    expect(installPlan('pnpm i --no-frozen-lockfile', dir)).toEqual(clean('pnpm install --frozen-lockfile'))
    expect(installPlan('yarn', dir)).toEqual(clean('yarn install --frozen-lockfile'))
    expect(installPlan('yarn --silent', dir)).toEqual(clean('yarn install --frozen-lockfile --silent'))
    // Packages named, a compound command, another tool: run as written, never called clean.
    // A flag that changes where it installs, or whether it installs at all, isn't a clean install's.
    for (const f of ['--dry-run', '--package-lock-only', '--prefix=../elsewhere', '-g', '--global', '--help', '-h', '--version', '--no-package-lock', '--install-links=false']) {
      expect(installPlan(`npm install --no-audit ${f}`, dir)).toEqual(written(`npm install --no-audit ${f}`))
    }
    expect(installPlan('pnpm install --lockfile-only', dir)).toEqual(written('pnpm install --lockfile-only'))
    expect(installPlan('yarn install --check-files --dry-run', dir)).toEqual(written('yarn install --check-files --dry-run'))
    expect(installPlan('npm install left-pad', dir)).toEqual(written('npm install left-pad'))
    expect(installPlan('npm install && npm run build:deps', dir)).toEqual(written('npm install && npm run build:deps'))
    expect(installPlan('npm i > install.log', dir)).toEqual(written('npm i > install.log'))
    expect(installPlan('make deps', dir)).toEqual(written('make deps'))
    expect(installPlan('', dir)).toBeNull()
    writeFileSync(join(dir, 'package-lock.json'), '{}')
    expect(installPlan('  ', dir)).toEqual(clean('npm ci'))
  })
})

describe('the mergeInstall option', () => {
  it('takes its two values; Pair installs on a manifest change, Team before every merge, all-off on a change', () => {
    expect(takesOption('mergeInstall', 'onManifestChange')).toBe(true)
    expect(takesOption('mergeInstall', 'always')).toBe(true)
    expect(takesOption('mergeInstall', 'sometimes')).toBe(false)
    expect(allOff('git').mergeInstall).toBe('onManifestChange')
    expect(preset('git', 'pair').mergeInstall).toBe('onManifestChange')
    expect(preset('git', 'team').mergeInstall).toBe('always')
  })

  it('pasted or set at a level, it resolves; a value it does not take falls back to all-off', () => {
    expect(resolveOptions('git', { project: { mergeInstall: 'always' } })).toMatchObject({ options: { mergeInstall: 'always' }, origins: { mergeInstall: 'project' }, invalid: null })
    expect(resolveOptions('git', { project: { mergeInstall: 'sometimes' as never } }).invalid).toContain('mergeInstall')
  })
})

describe("Hive's runs in the Progress panel", () => {
  const caller = { source: 'hive' as const, workspacePath: 'C:\\ws', projectPath: 'C:\\ws\\app' }
  const store = () => new ProgressStore({ now: () => Date.now(), changed: () => undefined, ownerRunning: () => false })

  it('are "Hive (merge queue)" in the project, no agent; only Hive changes them; they never go stale; kept as they were', () => {
    const p = store()
    const r = p.start({ ...caller, noInstall: true }, { title: 'AM-1 · check · a3f2c1d', command: 'npm test' }, { card: 1, revision: 'a'.repeat(40), testedCheckout: 'a'.repeat(40) })
    expect(r).toMatchObject({ source: 'hive', agentName: HIVE_RUNS, defaultName: 'mergeQueue', projectPath: caller.projectPath, agentId: null, provider: null, noInstall: true, card: 1 })
    // A script (the workspace's token) can't end it, and neither can another project's queue.
    expect(() => p.finish({ source: 'api', workspacePath: caller.workspacePath }, r.id, { ok: true })).toThrow('Unknown progress run')
    expect(() => p.finish({ ...caller, projectPath: 'C:\\ws\\other' }, r.id, { ok: true })).toThrow('Unknown progress run')
    // Its owner isn't a session: the sweep leaves it running.
    p.sweep()
    expect(p.list(caller.workspacePath)[0].state).toBe('running')
    p.finish(caller, r.id, { ok: false, exitCode: 1, logPath: 'C:\\logs\\x.log' })
    p.noteCheck(caller.workspacePath, r.id, { name: 'check', counted: false, whyNot: 'changed' })
    const [kept] = keptRuns(JSON.parse(JSON.stringify({ runs: p.list(caller.workspacePath) })), caller.workspacePath)
    expect(kept).toMatchObject({ source: 'hive', agentName: HIVE_RUNS, defaultName: 'mergeQueue', projectPath: caller.projectPath, noInstall: true, logPath: 'C:\\logs\\x.log', counts: { name: 'check', counted: false, whyNot: 'changed' } })
  })
})

describe("the runner's own runs, outside the queue", () => {
  const ctx = { card: 'AM-1', number: 1, revision: 'a'.repeat(40) }

  it("an install's command line (a token in it) stays in Hive: the Agent API's public run and its event give no part of it", async () => {
    const store = new ProgressStore({ now: () => Date.now(), changed: () => undefined, ownerRunning: () => false })
    const ws = tempDir('qc-ws-')
    const project = join(ws, 'app')
    const r = queueChecks({ env: base, runs: progressRuns(store, () => true, ws, project), logDir: tempDir('qc-logs-'), timeoutMs: () => 60_000, setupCommand: () => 'echo fake-token-review-1349' })
    expect(await r.install(tempDir('qc-folder-'), true, ctx)).toMatchObject({ ok: true })
    const [run] = store.list(ws)
    expect(run).toMatchObject({ source: 'hive', titleFromCommand: true, installAsWritten: true, state: 'passed' })
    expect(run.title).toContain('fake-token-review-1349')
    const pub = publicRun(run)
    expect(pub).toMatchObject({ titleFromCommand: true, source: 'hive' })
    expect(JSON.stringify(pub)).not.toContain('fake-token')
    // A check's title is its name, which the project gave it: kept.
    await r.runCheck('lint', 'echo ok', tempDir('qc-folder-'), ctx)
    expect(publicRun(store.list(ws)[0])).toMatchObject({ title: 'AM-1 · lint · aaaaaaa', titleFromCommand: false })
  })

  /** A log whose writes fail after it opened (a full disk). */
  function fullDisk(): LogIo & { closed: number } {
    const io = {
      closed: 0,
      openSync: (path: string, flags: string) => openSync(path, flags),
      writeSync: (): number => {
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
      },
      closeSync: (fd: number) => {
        io.closed++
        closeSync(fd)
      }
    }
    return io
  }

  it('a log that can\'t be written (a full disk) never escapes: the check ends, its run finishes with no log, the file is closed', async () => {
    const io = fullDisk()
    const r = runner({ logIo: io })
    const out = await r.runCheck('check', script("console.log('x'.repeat(1000)); console.error('y')"), tempDir('qc-folder-'), ctx)
    expect(out).toMatchObject({ ok: true, output: expect.stringContaining('x') })
    expect(r.finished).toEqual([{ id: 'run1', ok: true, exitCode: 0, logPath: null }])
    expect(io.closed).toBe(1)
  })

  it("a full disk on the startup failure's own line (a program not found) still finishes the run, transient, the file closed", async () => {
    const io = fullDisk()
    const r = runner({ logIo: io })
    const out = await r.runCheck('check', 'hive-no-such-command-1349', tempDir('qc-folder-'), ctx)
    expect(out).toMatchObject({ ok: false, transient: true })
    expect(r.finished).toEqual([{ id: 'run1', ok: false, exitCode: null, logPath: null }])
    expect(io.closed).toBe(1)
  })

  it('a long output keeps its first MAX_LOG_BYTES and its end in the log', async () => {
    const r = runner()
    await r.runCheck('check', script(`process.stdout.write('a'.repeat(${MAX_LOG_BYTES + 200000})); process.stdout.write('THE END')`), tempDir('qc-folder-'), ctx)
    const log = readFileSync(r.finished[0].logPath!, 'utf8')
    expect(log.startsWith('a'.repeat(1000))).toBe(true)
    expect(log).toContain('bytes of output not kept')
    expect(log.endsWith('THE END')).toBe(true)
    expect(log.length).toBeLessThan(MAX_LOG_BYTES + 100_000)
  })

  it('a setup command with no clean form runs as written after node_modules is removed (a junction as a link, never through)', async () => {
    const folder = tempDir('qc-folder-')
    const other = tempDir('qc-other-')
    mkdirSync(join(other, 'pkg'), { recursive: true })
    writeFileSync(join(other, 'pkg', 'index.js'), 'kept\n')
    symlinkSync(other, join(folder, 'node_modules'), 'junction')
    const seen = join(tempDir('qc-seen-'), 'seen.json')
    const r = runner({ setupCommand: () => `${script(`require('fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify(require('fs').existsSync('node_modules')))`)} && echo done` })
    expect(await r.install(folder, true, ctx)).toMatchObject({ ok: true })
    expect(JSON.parse(readFileSync(seen, 'utf8'))).toBe(false)
    expect(readFileSync(join(other, 'pkg', 'index.js'), 'utf8')).toBe('kept\n')
    expect(r.started[0]).toMatchObject({ installAsWritten: true, titleFromCommand: true })
    // A real folder of stale packages goes too.
    mkdirSync(join(folder, 'node_modules', 'stale'), { recursive: true })
    expect(await r.install(folder, true, ctx)).toMatchObject({ ok: true })
    expect(JSON.parse(readFileSync(seen, 'utf8'))).toBe(false)
  })
})

describe('the install from scratch with real npm (offline, a local tarball)', () => {
  const ctx = { card: 'AM-1', number: 1, revision: 'a'.repeat(40) }

  it('no warm package survives: a dry run leaves none (as written), and npm install with flags is npm ci and installs it fresh', async () => {
    const root = tempDir('qc-npm-')
    const npmEnv = (): Record<string, string> => ({ ...base(), npm_config_cache: join(root, 'cache'), npm_config_userconfig: join(root, 'empty.npmrc'), npm_config_update_notifier: 'false' })
    writeFileSync(join(root, 'empty.npmrc'), '')
    mkdirSync(join(root, 'dep'))
    writeFileSync(join(root, 'dep', 'package.json'), '{"name":"dep","version":"1.0.0","main":"index.js"}')
    writeFileSync(join(root, 'dep', 'index.js'), "module.exports = 'fresh'\n")
    const prep = runner({ env: npmEnv, setupCommand: () => 'npm install --no-audit --no-fund --offline' })
    expect(await prep.runCheck('pack', 'npm pack --silent', join(root, 'dep'), ctx)).toMatchObject({ ok: true })
    const app = join(root, 'app')
    mkdirSync(app)
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { dep: `file:${join(root, 'dep', 'dep-1.0.0.tgz').split('\\').join('/')}` } }))
    // The worktree warm: installed, then its package changed in place (ignored by git, invisible to the bracket).
    expect(await prep.runCheck('warm', 'npm install --no-audit --no-fund --offline', app, ctx)).toMatchObject({ ok: true })
    const installed = join(app, 'node_modules', 'dep', 'index.js')
    expect(readFileSync(installed, 'utf8')).toContain('fresh')
    writeFileSync(installed, "module.exports = 'stale warm file'\n")
    // A dry run installs nothing: called as written, and the warm package is gone with node_modules.
    const dry = runner({ env: npmEnv, setupCommand: () => 'npm install --dry-run --no-audit --no-fund --offline' })
    expect(await dry.install(app, true, ctx)).toMatchObject({ ok: true })
    expect(dry.started[0]).toMatchObject({ installAsWritten: true })
    expect(existsSync(installed)).toBe(false)
    // npm install with known flags: its clean form, npm ci with them, installs it fresh.
    mkdirSync(join(app, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(installed, "module.exports = 'stale warm file'\n")
    const clean = runner({ env: npmEnv, setupCommand: () => 'npm install --no-audit --no-fund --offline' })
    expect(await clean.install(app, true, ctx)).toMatchObject({ ok: true, command: 'npm ci --no-audit --no-fund --offline' })
    expect(clean.started[0].installAsWritten).toBeUndefined()
    expect(readFileSync(installed, 'utf8')).toContain('fresh')
  })
})

describe('merge checks as Hive\'s runs (temporary repositories)', () => {
  it('a green check runs in the queue\'s folder as "Hive (merge queue)" for the result revision, counted; the target advances', async () => {
    const out = join(tempDir('qc-env-'), 'env.json')
    const e = team({}, script(`require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ env: process.env, cwd: process.cwd() }))`))
    const r = runner()
    const { card } = await queued(e)
    const q = e.queue({ runCheck: r.runCheck, install: r.install, manifests: [] })
    const [o] = await q.drain('main')
    expect(o).toMatchObject({ outcome: 'integrated' })
    const result = mainHead(e)
    // What the check saw: the queue's folder, and no HIVE_* or ELECTRON_RUN_AS_NODE.
    const seen = JSON.parse(readFileSync(out, 'utf8')) as { env: Record<string, string>; cwd: string }
    expect(seen.cwd.toLowerCase()).toBe(join(e.home, 'queue').toLowerCase())
    expect(Object.keys(seen.env).filter((k) => /^hive_|^electron_run_as_node$/i.test(k))).toEqual([])
    // Its run, and its CheckRan at the result revision, counted.
    expect(r.started[0]).toMatchObject({ title: `${card.key} · check · ${result.slice(0, 7)}`, card: card.id, revision: result })
    expect(r.finished[0]).toMatchObject({ ok: true, exitCode: 0 })
    expect(readFileSync(r.finished[0].logPath!, 'utf8')).toBe('')
    expect(r.counted[0].c).toEqual({ name: 'check', counted: true })
    const ran = e.wf.state(card).checks.at(-1)!
    expect(ran).toMatchObject({ name: 'check', revision: result, tested: result, result: 'passed', by: HIVE_RUNS, counted: true, run: 'run1' })
    // Nothing installed (no setup command, no lock file): said once, on that check's run.
    expect(r.started[0].noInstall).toBe(true)
  })

  it('uncounted: a check that edits a tracked file and restores it passes but proves nothing → no advance, retested, then paused', async () => {
    const e = team({}, script("const fs = require('fs'); const t = fs.readFileSync('README.md'); fs.writeFileSync('README.md', 'x'); fs.writeFileSync('README.md', t)"))
    const r = runner()
    const { card } = await queued(e)
    const before = mainHead(e)
    const q = e.queue({ runCheck: r.runCheck, manifests: [] })
    const [o] = await q.drain('main')
    expect(o).toMatchObject({ outcome: 'paused', reason: 'uncounted' })
    expect(mainHead(e)).toBe(before)
    const s = e.wf.state(card)
    expect(s.stage).toBe('merging')
    expect(s.checks).toHaveLength(MAX_RETESTS + 1)
    expect(s.checks.every((c) => c.result === 'passed' && !c.counted && c.whyNot === 'changed')).toBe(true)
    expect(r.counted.map((c) => c.c.whyNot)).toEqual(Array(MAX_RETESTS + 1).fill('changed'))
    expect(q.paused('main')).toMatchObject({ reason: 'uncounted', card: card.key })
  })

  it('uncounted: a check that checks out another commit and back → no advance, paused', async () => {
    const e = team({}, script("const { execFileSync: x } = require('child_process'); const h = x('git', ['rev-parse', 'HEAD']).toString().trim(); x('git', ['checkout', '-q', '--detach', 'HEAD~1']); x('git', ['checkout', '-q', '--detach', h])"))
    const r = runner()
    const { card } = await queued(e)
    const before = mainHead(e)
    const [o] = await e.queue({ runCheck: r.runCheck, manifests: [] }).drain('main')
    expect(o).toMatchObject({ outcome: 'paused', reason: 'uncounted' })
    expect(mainHead(e)).toBe(before)
    expect(e.wf.state(card).checks.at(-1)).toMatchObject({ result: 'passed', counted: false, whyNot: 'changed' })
  })

  it('red: a check that fails returns the card (not transient) with its output; its log keeps the output', async () => {
    const e = team({}, script("console.log('3 failing tests'); process.exit(1)"))
    const r = runner()
    const { card } = await queued(e)
    const before = mainHead(e)
    const [o] = await e.queue({ runCheck: r.runCheck, manifests: [] }).drain('main')
    expect(o).toMatchObject({ outcome: 'returned', reason: 'checks', transient: false })
    expect(mainHead(e)).toBe(before)
    expect(e.wf.state(card).entries.at(-1)?.failure?.log).toContain('3 failing tests')
    expect(readFileSync(r.finished[0].logPath!, 'utf8')).toContain('3 failing tests')
    expect(e.wf.state(card).checks.at(-1)).toMatchObject({ result: 'failed', counted: true })
  })

  it("transient: a command the shell can't find returns the card marked transient; the builder sends the same revision straight back", async () => {
    const e = team({}, 'hive-no-such-command-1349')
    const { card } = await queued(e)
    const [o] = await e.queue({ runCheck: runner().runCheck, manifests: [] }).drain('main')
    expect(o).toMatchObject({ outcome: 'returned', reason: 'checks', transient: true })
    expect(e.wf.state(card).entries.at(-1)?.failure).toMatchObject({ reason: 'checks', transient: true })
    // requeue.allowed: unchanged, straight back into the queue (no review again).
    moved(await e.wf.submit(card.key, B1, { summary: 'again' }))
    const s = e.wf.state(card)
    expect(s.stage).toBe('merging')
    expect(s.entries.at(-1)).toMatchObject({ state: 'open', requeue: 'transient' })
  })

  it('transient: a check ended by its time limit (its whole tree) returns the card marked transient', async () => {
    const e = team({}, script('setTimeout(() => {}, 120000)'))
    await queued(e)
    const slow = runner({ timeoutMs: () => 1500 })
    const [o] = await e.queue({ runCheck: slow.runCheck, manifests: [] }).drain('main')
    expect(o).toMatchObject({ outcome: 'returned', reason: 'checks', transient: true })
    expect(slow.finished[0]).toMatchObject({ ok: false })
  })

  it('with no merge checks (G9 empty) nothing is installed or run: a clean test merge alone merges', async () => {
    const e = team({ mergeChecks: [] })
    const r = runner({ setupCommand: () => script('process.exit(1)') })
    await queued(e)
    const [o] = await e.queue({ runCheck: r.runCheck, install: r.install }).drain('main')
    expect(o).toMatchObject({ outcome: 'integrated' })
    expect(r.started).toEqual([])
  })
})

describe('installing from scratch before the merge checks (S13, #187)', () => {
  /** The queue with a counting install, each card changing (or not) package.json. */
  async function installs(mergeInstall: 'onManifestChange' | 'always', manifests: (string | null)[]) {
    const e = team({ mergeInstall })
    let n = 0
    const q = e.queue({ install: async () => (n++, { ok: true, output: '' }) })
    const counts: number[] = []
    for (const [i, m] of manifests.entries()) {
      await queued(e, `Card ${i}`, { [`src/c${i}.txt`]: `${i}\n`, ...(m ? { 'package.json': m } : {}) })
      expect((await q.drain('main'))[0]).toMatchObject({ outcome: 'integrated' })
      counts.push(n)
    }
    return counts
  }

  it('onManifestChange: installs for the first entry, not again while the manifests are unchanged, again when they change', async () => {
    expect(await installs('onManifestChange', [null, null, '{"dependencies":{}}\n'])).toEqual([1, 1, 2])
  })

  it('always: installs before every entry\'s checks', async () => {
    expect(await installs('always', [null, null])).toEqual([1, 2])
  })

  it("the install is one of Hive's runs, the setup command with its clean state; it fails → the card returns", async () => {
    const e = team()
    const r = runner({ setupCommand: () => script("console.error('npm ERR! missing script'); process.exit(1)") })
    const { card } = await queued(e)
    const [o] = await e.queue({ runCheck: r.runCheck, install: r.install }).drain('main')
    expect(o).toMatchObject({ outcome: 'returned', reason: 'checks', transient: false })
    expect(r.started).toHaveLength(1)
    expect(r.started[0].title).toContain(`${card.key} · "`)
    expect(e.wf.state(card).entries.at(-1)?.failure?.log).toContain('missing script')
  })

  it("S13's core: a package missing from package.json while the warm worktree still has it → clean install → the check fails → the target doesn't move", async () => {
    const e = team({}, script("const fs = require('fs'); const missing = fs.readdirSync('.').filter((f) => f.endsWith('.js')).flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/require\\('([^']+)'\\)/g)].map((m) => m[1])).filter((d) => !fs.existsSync('node_modules/' + d)); if (missing.length) { console.error(\"Cannot find module '\" + missing[0] + \"'\"); process.exit(1) }"))
    commit(e.project, { 'package.json': '{"dependencies":{"left-pad":"1"}}\n', 'index.js': "require('left-pad')\n", '.gitignore': 'node_modules/\n' }, 'deps')
    // The setup command: node_modules from package.json's dependencies, from scratch.
    const install = script("const fs = require('fs'); fs.rmSync('node_modules', { recursive: true, force: true }); for (const d of Object.keys(JSON.parse(fs.readFileSync('package.json', 'utf8')).dependencies || {})) fs.mkdirSync('node_modules/' + d, { recursive: true })")
    const r = runner({ setupCommand: () => install })
    const q = e.queue({ runCheck: r.runCheck, install: r.install })
    const { card: c1 } = await queued(e, 'Add is-odd', { 'package.json': '{"dependencies":{"left-pad":"1","is-odd":"1"}}\n' })
    expect((await q.drain('main'))[0]).toMatchObject({ outcome: 'integrated' })
    expect(e.wf.state(c1).stage).toBe('done')
    const { card: c2 } = await queued(e, 'Use is-odd', { 'package.json': '{"dependencies":{"left-pad":"1"}}\n', 'odd.js': "require('is-odd')\n" })
    const before = mainHead(e)
    const [o] = await q.drain('main')
    expect(o).toMatchObject({ outcome: 'returned', reason: 'checks', transient: false })
    expect(e.wf.state(c2).entries.at(-1)?.failure?.log).toContain("Cannot find module 'is-odd'")
    expect(mainHead(e)).toBe(before)
  })
})

describe("S4's core", () => {
  it('two approved changes, each fine alone and broken together → the second\'s checks fail → the target doesn\'t move', async () => {
    // The check: a.txt and b.txt may each say "on", but not both.
    const e = team({}, script("const fs = require('fs'); const on = (f) => fs.existsSync(f) && fs.readFileSync(f, 'utf8').trim() === 'on'; if (on('a.txt') && on('b.txt')) { console.error('a and b are both on'); process.exit(1) }"))
    const r = runner()
    const q = e.queue({ runCheck: r.runCheck, manifests: [] })
    const { card: c1 } = await queued(e, 'A on', { 'a.txt': 'on\n' })
    const { card: c2 } = await queued(e, 'B on', { 'b.txt': 'on\n' })
    const [o1, o2] = await q.drain('main')
    expect(o1).toMatchObject({ card: c1.key, outcome: 'integrated' })
    const after1 = mainHead(e)
    expect(o2).toMatchObject({ card: c2.key, outcome: 'returned', reason: 'checks', transient: false })
    expect(mainHead(e)).toBe(after1)
    expect(e.wf.state(c2).entries.at(-1)?.failure?.log).toContain('a and b are both on')
  })
})
