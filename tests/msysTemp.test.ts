// HI-3447: a test run never leaves Git Bash's /tmp at its own temp folder (tests/msysTemp.mts). Each test uses a copy of
// Git for Windows' MSYS runtime in a folder of its own: an MSYS installation's session mount table is its folder's, so the
// copy's first process is the first of its table, as on a PC where no Git Bash runs, and the PC's own table is never
// touched.
import { spawn, spawnSync } from 'child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { timing } from './timing.cjs'
import { gitMsysBin, startMsysKeeper } from './msysTemp.mts'

const git = gitMsysBin()

/** What the copy needs to run sh, cat, sleep and mount, with Git's fstab (its /tmp is `usertemp`). */
const RUNTIME = ['msys-2.0.dll', 'msys-iconv-2.dll', 'msys-intl-8.dll', 'msys-gcc_s-seh-1.dll', 'msys-ncursesw6.dll', 'msys-readline8.dll', 'sh.exe', 'cat.exe', 'mount.exe', 'sleep.exe', 'sort.exe']

/** A copy of Git's MSYS runtime, its own folders for a user's and a run's temp folders. */
function copied(): { bin: string; userTemp: string; runTemp: string; dir: string } {
  const dir = tempDir('cw-msys-')
  const root = join(dir, 'git')
  const bin = join(root, 'usr', 'bin')
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(root, 'etc'))
  for (const f of RUNTIME) copyFileSync(join(git!, f), join(bin, f))
  copyFileSync(join(git!, '..', '..', 'etc', 'fstab'), join(root, 'etc', 'fstab'))
  const userTemp = join(dir, 'user-temp')
  const runTemp = join(dir, 'run-temp')
  mkdirSync(userTemp)
  mkdirSync(runTemp)
  return { bin, userTemp, runTemp, dir }
}

const msysEnv = (bin: string, temp: string): NodeJS.ProcessEnv => ({ SystemRoot: process.env.SystemRoot, PATH: bin, TMP: temp, TEMP: temp })
/** Where the copy's table has /tmp, asked by a process of its own with `temp` as its temp folder. */
const tmpOf = (bin: string, temp: string): string => {
  const out = spawnSync(join(bin, 'mount.exe'), [], { env: msysEnv(bin, temp), encoding: 'utf8', timeout: timing('spawn.hang') }).stdout
  const line = out.split('\n').find((l) => / on \/tmp /.test(l))
  if (!line) throw new Error(`no /tmp in mount's table: ${out}`)
  return line.slice(0, line.indexOf(' on /tmp ')).replace(/\//g, '\\').toLowerCase()
}
/**
 * An MSYS process of the copy's, with `temp` as its temp folder, running until it is ended (a hook's sh, an agent's shell):
 * once MSYS has started in it (it echoes a line back), so it holds the table from then on.
 */
async function msysRunning(bin: string, temp: string): Promise<{ gone: Promise<void>; end: () => void }> {
  const proc = spawn(join(bin, 'cat.exe'), [], { env: msysEnv(bin, temp), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  const gone = new Promise<void>((r) => proc.once('exit', () => r()))
  await new Promise<void>((r) => {
    proc.stdout.once('data', () => r())
    proc.stdin.write('up\n')
  })
  return { gone, end: () => proc.stdin.end() }
}

describe.runIf(git)("a test run and Git Bash's /tmp (HI-3447)", () => {
  it("the premise: the session's first MSYS process sets /tmp from its temp folder for every one after it, for as long as one runs", async () => {
    const c = copied()
    const run = await msysRunning(c.bin, c.runTemp)
    const agent = await msysRunning(c.bin, c.userTemp)
    try {
      expect(tmpOf(c.bin, c.userTemp)).toBe(c.runTemp.toLowerCase())
      run.end()
      await run.gone
      // The run gone, its folder still /tmp while the agent's shell runs.
      expect(tmpOf(c.bin, c.userTemp)).toBe(c.runTemp.toLowerCase())
    } finally {
      agent.end()
      run.end()
      await agent.gone
    }
    // None running: the next first process makes it afresh.
    expect(tmpOf(c.bin, c.userTemp)).toBe(c.userTemp.toLowerCase())
  })

  it("the keeper, started first with the user's temp folder, keeps it there for the run's processes and after them; it ends as its stdin closes", async () => {
    const c = copied()
    const keeper = startMsysKeeper(c.bin, c.userTemp)
    expect(await keeper.ready).toBeNull()
    const keeperGone = new Promise<void>((r) => keeper.child!.once('exit', () => r()))
    const run = await msysRunning(c.bin, c.runTemp)
    const agent = await msysRunning(c.bin, c.userTemp)
    try {
      expect(tmpOf(c.bin, c.runTemp)).toBe(c.userTemp.toLowerCase())
      run.end()
      keeper.child!.stdin!.end()
      await Promise.all([run.gone, keeperGone])
      expect(tmpOf(c.bin, c.runTemp)).toBe(c.userTemp.toLowerCase())
    } finally {
      agent.end()
      run.end()
      await agent.gone
    }
  })

  it("a run's start (startRunTemp, msysTempKept) keeps it at the temp folder it was started with, though the run's processes have the run's, and its keeper ends with the run", async () => {
    const c = copied()
    const local = join(c.dir, 'local')
    mkdirSync(local)
    const script = join(c.dir, 'run.mjs')
    const runTempModule = pathToFileURL(join(import.meta.dirname, 'runTemp.mts')).href
    writeFileSync(script, [
      `import { spawnSync } from 'child_process'`,
      `import { join } from 'path'`,
      `import { msysTempKept, startRunTemp } from ${JSON.stringify(runTempModule)}`,
      `const dir = startRunTemp()`,
      `await msysTempKept()`,
      // The run's first MSYS process, with the run's temp folder, as all it starts has.
      `const out = spawnSync(join(process.env.CW_TEST_MSYS_BIN, 'mount.exe'), [], { env: { ...process.env, PATH: process.env.CW_TEST_MSYS_BIN }, encoding: 'utf8' }).stdout`,
      `console.log(JSON.stringify({ dir, temp: process.env.TEMP, tmp: out.split('\\n').find((l) => / on \\/tmp /.test(l)) }))`,
      // Until the test has its agent's shell running.
      `process.stdin.once('data', () => process.exit(0))`
    ].join('\n'))
    const env = { SystemRoot: process.env.SystemRoot, LOCALAPPDATA: local, TMP: c.userTemp, TEMP: c.userTemp, CW_TEST_MSYS_BIN: c.bin }
    const child = spawn(process.execPath, [script], { env, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
    const childGone = new Promise<void>((r) => child.once('exit', () => r()))
    let out = ''
    child.stdout.on('data', (d) => (out += String(d)))
    let agent: { gone: Promise<void>; end: () => void } | null = null
    try {
      await vi.waitFor(() => expect(out).toContain('\n'), { timeout: timing('wait.hang'), interval: timing('wait.interval') })
      const said = JSON.parse(out) as { dir: string; temp: string; tmp: string }
      // The run's temp folder is its own, in the test area; Git Bash's /tmp the one it started with.
      expect(said.temp).toBe(said.dir)
      expect(said.dir.toLowerCase().startsWith(join(local, 'combwork-test', 'tmp').toLowerCase())).toBe(true)
      expect(said.tmp.slice(0, said.tmp.indexOf(' on /tmp ')).replace(/\//g, '\\').toLowerCase()).toBe(c.userTemp.toLowerCase())
      agent = await msysRunning(c.bin, c.userTemp)
      child.stdin.write('done\n')
      await childGone
      // The run over, its keeper gone with it (nothing kept the run's process): /tmp is still the user's.
      expect(tmpOf(c.bin, c.runTemp)).toBe(c.userTemp.toLowerCase())
    } finally {
      agent?.end()
      child.stdin.end()
      await Promise.all([agent?.gone, childGone])
    }
    // Nothing of the copy's runs any more: the run's keeper ended with it.
    expect(tmpOf(c.bin, c.runTemp)).toBe(c.runTemp.toLowerCase())
  })

  // HR1's round 1: a keeper that doesn't start is ended by its own handle, says why, and the run starts nothing.
  it("a keeper that doesn't start says why, and one still running is ended by its handle: ended first, never answering (ended at its bound), not startable", async () => {
    const c = copied()
    // sleep with no operand ends at once; sort answers nothing until its input ends.
    const as = (exe: string): string => {
      const bin = join(c.dir, `as-${exe}`)
      mkdirSync(bin)
      for (const f of RUNTIME) copyFileSync(join(c.bin, f), join(bin, f))
      copyFileSync(join(c.bin, exe), join(bin, 'cat.exe'))
      return bin
    }
    const endedFirst = startMsysKeeper(as('sleep.exe'), c.userTemp)
    expect(await endedFirst.ready).toMatch(/^it ended \(\d+\) before it answered$/)
    const silent = startMsysKeeper(as('sort.exe'), c.userTemp, timing('msys.keeperReadyShortMs'))
    const silentGone = new Promise<void>((r) => (silent.child!.exitCode !== null ? r() : silent.child!.once('exit', () => r())))
    expect(await silent.ready).toBe(`it didn't answer within ${timing('msys.keeperReadyShortMs')} ms`)
    // Ended by the keeper's own handle, not left running.
    await silentGone
    expect(silent.child!.killed).toBe(true)
    expect(await startMsysKeeper(join(c.dir, 'none'), c.userTemp).ready).toMatch(/^it couldn't be started: spawn .*ENOENT/)
  })

  // Each runner, as `npm test`, `npm run e2e` and `npm run scenarios` start it, its keeper's Git a folder that isn't there:
  // it says so and stops, before a worker, a build or a suite starts.
  // The unit run's control has its keeper's Git a working copy: the same file runs then, so what's missing is the keeper's doing.
  const RUNNERS: { name: string; args: string[]; started: RegExp; control?: boolean }[] = [
    { name: 'the unit run', args: [join('node_modules', 'vitest', 'vitest.mjs'), 'run', 'tests/timing.test.ts'], started: /Test Files {2}1 passed/, control: true },
    { name: 'the e2e runner', args: [join('tests', 'e2e', 'run.mjs'), 'gitdirect'], started: /Suite|Building|build|gitdirect: / },
    { name: 'the scenario runner', args: [join('tests', 'scenarios', 'run.mjs'), '--only', 'none-such'], started: /Scenario|scenario .* (pass|fail)|unknown/i }
  ]
  for (const r of RUNNERS) {
    it(`${r.name} whose keeper doesn't start starts nothing`, () => {
      const dir = tempDir('cw-msys-refused-')
      const run = (msysBin: string): { status: number | null; out: string } => {
        const local = join(dir, `local-${Date.now()}`)
        const user = join(dir, `user-temp-${Date.now()}`)
        mkdirSync(local)
        mkdirSync(user)
        const env = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, LOCALAPPDATA: local, TMP: user, TEMP: user, CW_TEST_MSYS_BIN: msysBin, CW_TEST_NO_BOARD: '1' }
        const res = spawnSync(process.execPath, r.args, { cwd: join(import.meta.dirname, '..'), env, encoding: 'utf8', timeout: timing('spawn.hang'), windowsHide: true })
        return { status: res.status, out: `${res.stdout}\n${res.stderr}`.replace(/\x1b\[[0-9;]*m/g, '') }
      }
      const refused = run(join(dir, 'no-git'))
      expect(refused.status, refused.out).not.toBe(0)
      expect(refused.out).toMatch(/Git Bash's \/tmp keeper didn't start \(HI-3447\): it couldn't be started: spawn .*ENOENT\. The run starts nothing/)
      expect(refused.out).not.toMatch(r.started)
      if (!r.control) return
      const kept = run(copied().bin)
      expect(kept.status, kept.out).toBe(0)
      expect(kept.out).toMatch(r.started)
    })
  }
})
