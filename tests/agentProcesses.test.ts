// What an agent's launch leaves running (#507): its CLI joins a job as it starts, everything it starts joins with it
// (detached, through a process that has exited since), and only the job's processes are ever listed or ended. The real
// job host (PowerShell) on Windows; the labels shown for them anywhere.
import { createRequire } from 'module'
import { execFileSync, spawn, type ChildProcess } from 'child_process'
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { leftoversSummary, processLabel } from '../src/shared/agentProcesses'
import { tempDir } from './tempDir'
// What the test started that is still running: stopped by its command line (it names the test's folder) and start,
// never by a pid remembered from earlier, which Windows may have given another process since: under load that could
// be a concurrent run's Vitest worker (#547: a likely cause of one exiting with code 1, not reproduced).
const { stopProcessesIn, endExactly } = createRequire(import.meta.url)('./e2e/folderProcesses.cjs') as {
  stopProcessesIn: (folder: string, since?: number) => number
  endExactly: (targets: { pid: number; started: number }[]) => number
}

const events: unknown[] = []
vi.mock('../src/main/events', () => ({ emit: (e: unknown) => events.push(e) }))
// Hive's profile, where what is listed is kept across a restart (#614): this file's own, never the shared test root.
const profile = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', async (importOriginal) => {
  const stub = await importOriginal<typeof import('./electron-stub')>()
  return { ...stub, app: { ...stub.app, getPath: () => profile.dir } }
})
profile.dir = tempDir('hive-agentproc-profile-')

describe('the CLI a lost terminal leaves (HI-1819)', () => {
  it('is the gate’s child and the command its cmd.exe wrappers run, never what the CLI itself started', async () => {
    const { orphanedCli } = await import('../src/main/agentProcesses')
    const p = (pid: number, name: string, parent: number, created: string) => ({ pid, name, label: name, parent, created })
    const gate = 10
    const processes = [
      p(20, 'cmd.exe', gate, '1000'),
      // A .cmd launcher run from the wrapper: another cmd.exe, then the CLI.
      p(30, 'cmd.exe', 20, '1001'),
      p(40, 'node.exe', 30, '1002'),
      // What the CLI started (a dev server): a leftover, not the CLI.
      p(50, 'node.exe', 40, '1003'),
      // A process whose parent id is the wrapper's but which started before it: that id named another process then.
      p(60, 'node.exe', 20, '999'),
      // No start time: can't be told from a later process with its id.
      { pid: 70, name: 'node.exe', label: 'node', parent: gate }
    ]
    expect(orphanedCli(processes, gate).map((x) => x.pid)).toEqual([20, 30, 40])
    // A CLI started directly: only itself.
    expect(orphanedCli([p(40, 'node.exe', gate, '1'), p(50, 'node.exe', 40, '2')], gate).map((x) => x.pid)).toEqual([40])
  })
})

describe('a process as the user recognises it', () => {
  it('drops the executable path and cuts paths in arguments to their last part', () => {
    expect(processLabel('node.exe', '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npm-cli.js" run serve')).toBe('node npm-cli.js run serve')
    expect(processLabel('tail.exe', 'C:\\Program Files\\Git\\usr\\bin\\tail.exe -f .cache/capture-1.log')).toBe('tail -f .cache/capture-1.log')
    expect(processLabel('bash.exe', '/usr/bin/bash -c "npm run serve > .cache/serve.log 2>&1"')).toBe('bash -c "npm run serve > .cache/serve.log 2>&1"')
    // A switch keeps its slash (HI-1743: "cmd d s c"), a path after it still cut.
    expect(processLabel('cmd.exe', 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "node -e x"')).toBe('cmd /d /s /c "node -e x"')
    expect(processLabel('cmd.exe', 'cmd.exe /c C:\\tools\\run.bat')).toBe('cmd /c run.bat')
  })

  it('is the name alone without a command line, and short', () => {
    expect(processLabel('grep.exe', '')).toBe('grep')
    const long = processLabel('node.exe', `node.exe ${'x'.repeat(200)}`)
    expect(long.length).toBe(80)
    expect(long.endsWith('…')).toBe(true)
  })

  it('sums several up in a line: each label once with its count, the rest counted', () => {
    const p = (label: string, pid: number) => ({ pid, name: 'x.exe', label })
    expect(leftoversSummary({ processes: [p('node serve.js', 1), p('tail -f a.log', 2), p('tail -f a.log', 3)], more: 0 })).toBe('node serve.js, 2 × tail -f a.log')
    expect(leftoversSummary({ processes: [p('a', 1), p('b', 2), p('c', 3)], more: 2 }, 2)).toBe('a, b and 3 more processes')
  })
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Each test ends what it leaves running (#675), so the afterAll's sweep, for what a failed test left, usually finds
// nothing: one process listing rather than three PowerShell calls (list, end, list again), which under heavy load
// took most of its 30 s bound.
/** Ends a process the test started and still holds: while it runs, Node holds its handle, so its pid is still its own. */
async function endHeld(p: ChildProcess): Promise<void> {
  if (p.exitCode !== null || p.signalCode !== null) return
  const exited = new Promise((r) => p.once('exit', r))
  p.kill()
  await exited
}

/** Ends processes as the tracker identified them (pid and creation time), never by a pid alone: endExactly's identities. */
const endListed = (processes: { pid: number; created?: string }[]): number =>
  endExactly(processes.filter((p) => p.created).map((p) => ({ pid: p.pid, started: Number(BigInt(p.created!) / 10000n - 11644473600000n) })))

async function until(fn: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return fn()
}

describe.runIf(process.platform === 'win32')('the processes a launch leaves running', () => {
  const dir = tempDir('hive-agentproc-')
  // A stand-in CLI: waits for "go", then starts a detached child that starts a detached grandchild (each writes its pid),
  // and exits, as an agent leaving a server behind does. A lingering process sleeps (at most 2 minutes, in case).
  const script = join(dir, 'proc.cjs')
  writeFileSync(
    script,
    `const { spawn } = require('child_process'), fs = require('fs'), path = require('path')
const [role, out] = process.argv.slice(2)
const start = (r) => spawn(process.execPath, [__filename, r, out], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
if (role === 'cli') process.stdin.once('data', () => { start('child'); setTimeout(() => process.exit(0), 800) })
// What the Store's PowerShell does (#543): its children start outside every job. Stood in for by starting the child
// before this CLI joins its job: the child's parent is in the job, the child in none.
else if (role === 'escaper') { start('child'); process.stdin.once('data', () => process.exit(0)) }
// A CLI that keeps running and, on each line "<n>", starts n more lingering processes (leaf0, leaf1, …), as an agent
// starting commands after its turn does (#1134).
else if (role === 'spawner') { let k = 0; process.stdin.on('data', (d) => { for (let i = Number(String(d).trim()); i > 0; i--) start('leaf' + k++) }); setTimeout(() => process.exit(0), 120000) }
// The real Store PowerShell (where it is installed), as Codex runs a background command: on "go", it runs a process
// that keeps running (the shell's id said too), and this CLI exits once that has started.
else if (role === 'storepwsh') process.stdin.once('data', () => {
  // Windows may refuse to start it (#585), as a throw (EPERM) or an error: said, for the test to tell from a tracking failure.
  const refused = (e) => { fs.appendFileSync(out, 'pwsh-error ' + JSON.stringify(e.message) + '\\n'); process.exit(3) }
  let ps
  try {
    ps = spawn(process.env.STORE_PWSH, ['-NoProfile', '-Command', '& $env:LONE_NODE $env:LONE_SCRIPT lone $env:LONE_OUT'], { stdio: 'ignore', windowsHide: true, env: { ...process.env, LONE_NODE: process.execPath, LONE_SCRIPT: __filename, LONE_OUT: out } })
  } catch (e) {
    refused(e)
  }
  if (ps.pid) fs.appendFileSync(out, 'pwsh ' + ps.pid + '\\n')
  ps.on('error', refused)
  ps.on('exit', (code) => { fs.appendFileSync(out, 'pwsh-exit ' + code + '\\n'); process.exit(4) })
  const started = setInterval(() => { if (fs.existsSync(out) && fs.readFileSync(out, 'utf8').includes('lone ')) { clearInterval(started); process.exit(0) } }, 100)
})
else {
  fs.appendFileSync(out, role + ' ' + process.pid + '\\n')
  if (role === 'child') start('grandchild')
  setTimeout(() => process.exit(0), 120000)
}
`
  )
  const since = Date.now()
  const pidsIn = (file: string): Record<string, number> => (existsSync(file) ? Object.fromEntries(readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => [l.split(' ')[0], Number(l.split(' ')[1])])) : {})

  async function launch(runId: string, out: string, agentId = 'a1'): Promise<ChildProcess> {
    const { trackLaunch } = await import('../src/main/agentProcesses')
    const cli = spawn(process.execPath, [script, 'cli', out], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    expect(await trackLaunch({ runId, projectPath: dir, agentId, agentName: 'Website' }, cli.pid!)).toEqual({ tracked: true })
    cli.stdin!.write('go\n')
    await new Promise((r) => cli.once('exit', r))
    expect(await until(() => Object.keys(pidsIn(out)).length === 2, 10000)).toBe(true)
    return cli
  }

  afterAll(async () => {
    const { closeProcessTracking } = await import('../src/main/agentProcesses')
    await closeProcessTracking()
    stopProcessesIn(dir, since)
  })

  it('lists what a stopped launch left running, ends only that, and leaves a process it did not start alone', async () => {
    const { launchEnded, leftoversOf, settleLeftovers } = await import('../src/main/agentProcesses')
    // Started by someone else, in the same folder, at the same time: never the launch's.
    const other = join(dir, 'other.txt')
    const strangerProc = spawn(process.execPath, [script, 'stranger', other], { detached: true, stdio: 'ignore', windowsHide: true })
    strangerProc.unref()
    expect(await until(() => !!pidsIn(other).stranger, 10000)).toBe(true)
    const stranger = pidsIn(other).stranger

    const out = join(dir, 'run1.txt')
    await launch('run1', out)
    const { child, grandchild } = pidsIn(out)
    const left = await launchEnded('run1')
    expect(left?.processes.map((p) => p.pid).sort()).toEqual([child, grandchild].sort())
    expect(left?.processes.every((p) => p.label.startsWith('node proc.cjs'))).toBe(true)
    expect(leftoversOf(dir, 'a1').processes).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({ type: 'agent-leftovers', leftovers: { agentId: 'a1', agentName: 'Website' } })

    expect(await settleLeftovers(dir, 'a1', 'end')).toBe(2)
    expect(await until(() => !alive(child) && !alive(grandchild), 5000)).toBe(true)
    expect(alive(stranger)).toBe(true)
    expect(leftoversOf(dir, 'a1').processes).toHaveLength(0)
    expect(events.at(-1)).toMatchObject({ type: 'agent-leftovers', leftovers: { agentId: 'a1', processes: [] } })
    // Another agent's call, or the same again, ends nothing more.
    expect(await settleLeftovers(dir, 'a2', 'end')).toBe(0)
    expect(await settleLeftovers(dir, 'a1', 'end')).toBe(0)
    await endHeld(strangerProc)
  }, 60000)

  it("says each running launch's process's parent state (HI-2111): the exited CLI's child is an orphan, the child's own child isn't", async () => {
    const { launchLineage, launchEnded, settleLeftovers } = await import('../src/main/agentProcesses')
    const { isOrphan, parseLineage } = await import('../src/main/orphanProcesses')
    const out = join(dir, 'lineage.txt')
    await launch('lineage1', out, 'lin')
    const pids = pidsIn(out)
    const lineage = parseLineage((await launchLineage(['lineage1']))?.lineage1)
    const of = (pid: number) => lineage.find((l) => l.pid === pid)
    expect(of(pids.child)).toBeDefined()
    expect(isOrphan(of(pids.child)!)).toBe(true)
    expect(of(pids.grandchild)).toMatchObject({ parent: pids.child })
    expect(isOrphan(of(pids.grandchild)!)).toBe(false)
    await launchEnded('lineage1')
    await settleLeftovers(dir, 'lin', 'end')
  })

  it("measures the memory running agents take (#562): each running launch's processes, summed", async () => {
    const { agentsMemory, launchEnded, trackLaunch } = await import('../src/main/agentProcesses')
    const out = join(dir, 'mem.txt')
    // A CLI that keeps running: no "go" needed, it writes its pid and sleeps.
    const cli = spawn(process.execPath, [script, 'holder', out], { stdio: 'ignore', windowsHide: true })
    expect(await trackLaunch({ runId: 'mem1', projectPath: dir, agentId: 'm1', agentName: 'Busy' }, cli.pid!)).toEqual({ tracked: true })
    expect(await until(() => !!pidsIn(out).holder, 10000)).toBe(true)
    const m = await agentsMemory()
    expect(m?.agents).toBe(1)
    // A Node process's own private memory is several MB at least, far below a GB.
    expect(m!.bytes).toBeGreaterThan(5 * 1024 ** 2)
    expect(m!.bytes).toBeLessThan(1024 ** 3)
    await endHeld(cli)
    await launchEnded('mem1')
    expect(await agentsMemory()).toBeNull()
  }, 60000)

  it("Hive quitting keeps a run as ended for its slot writer only once its job is seen empty, never while what its CLI started still runs (HI-1886)", async () => {
    const { endedEarlier, launchEnded, recordEndedLaunches, runningProcesses, runTookWriter, trackLaunch } = await import('../src/main/agentProcesses')
    // Both slots' writers' runs (HI-2299: only those are kept).
    runTookWriter('quit1')
    runTookWriter('quit2')
    // A CLI that started a detached server and exited, its exit not yet seen (Hive quitting): its job isn't empty.
    const out = join(dir, 'quit1.txt')
    const cli = spawn(process.execPath, [script, 'cli', out], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    expect(await trackLaunch({ runId: 'quit1', projectPath: dir, agentId: 'q1', agentName: 'Quitter' }, cli.pid!)).toEqual({ tracked: true })
    cli.stdin!.write('go\n')
    await new Promise((r) => cli.once('exit', r))
    expect(await until(() => Object.keys(pidsIn(out)).length === 2, 10000)).toBe(true)
    // A CLI that ended with nothing left: its job empty.
    const holderOut = join(dir, 'quit2.txt')
    const holder = spawn(process.execPath, [script, 'holder', holderOut], { stdio: 'ignore', windowsHide: true })
    expect(await trackLaunch({ runId: 'quit2', projectPath: dir, agentId: 'q2', agentName: 'Done' }, holder.pid!)).toEqual({ tracked: true })
    expect(await until(() => !!pidsIn(holderOut).holder, 10000)).toBe(true)
    await endHeld(holder)
    const left = (await runningProcesses()).find((l) => l.runId === 'quit1')?.processes ?? []
    expect(left.map((p) => p.pid).sort()).toEqual(Object.values(pidsIn(out)).sort())
    await recordEndedLaunches()
    expect(await endedEarlier('quit2')).toBe(true)
    expect(await endedEarlier('quit1')).toBe(false)
    endListed(left)
    expect(await until(() => Object.values(pidsIn(out)).every((pid) => !alive(pid)), 10000)).toBe(true)
    await launchEnded('quit1')
    await launchEnded('quit2')
  }, 60000)

  it('tells when a process joins a running launch (#1134), once until its processes are listed again', async () => {
    const { launchEnded, onLaunchProcessJoined, runningProcesses, settleLeftovers, trackLaunch } = await import('../src/main/agentProcesses')
    // As the running marker does: each notice lists the running launches' processes (one listing at a time here too).
    let joined = 0
    let relist = true
    const seen = new Set<number>()
    let listing: Promise<void> = Promise.resolve()
    const stop = onLaunchProcessJoined(() => {
      joined++
      if (!relist) return
      listing = listing.then(async () => {
        for (const l of await runningProcesses()) for (const p of l.processes) seen.add(p.pid)
      })
    })
    const out = join(dir, 'joins.txt')
    const cli = spawn(process.execPath, [script, 'spawner', out], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    try {
      expect(await trackLaunch({ runId: 'joins1', projectPath: dir, agentId: 'j1', agentName: 'Busy' }, cli.pid!)).toEqual({ tracked: true })
      // The CLI joining its job as the launch starts is told, and so is a process it starts later, each found by the
      // listing its notice leads to: nothing here lists on a timer.
      expect(await until(() => seen.has(cli.pid!), 10000)).toBe(true)
      cli.stdin!.write('1\n')
      expect(await until(() => !!pidsIn(out).leaf0 && seen.has(pidsIn(out).leaf0), 10000)).toBe(true)
      // With no listing, told at most once however many processes start (other processes joining included: a console
      // host taken in, #543).
      relist = false
      await listing
      const told = joined
      cli.stdin!.write('20\n')
      expect(await until(() => Object.keys(pidsIn(out)).length === 21, 20000)).toBe(true)
      expect(joined - told).toBeLessThanOrEqual(1)
      const all = (await runningProcesses()).flatMap((l) => l.processes).map((p) => p.pid)
      expect(Object.values(pidsIn(out)).every((pid) => all.includes(pid))).toBe(true)
    } finally {
      stop()
      await endHeld(cli)
      await launchEnded('joins1')
      await settleLeftovers(dir, 'j1', 'end')
    }
  }, 60000)

  it('keeps them running when asked, and stops listing them', async () => {
    const { launchEnded, leftoversOf, settleLeftovers } = await import('../src/main/agentProcesses')
    const out = join(dir, 'run2.txt')
    await launch('run2', out)
    const { child, grandchild } = pidsIn(out)
    const listed = (await launchEnded('run2'))?.processes ?? []
    expect(listed).toHaveLength(2)
    expect(await settleLeftovers(dir, 'a1', 'keep')).toBe(2)
    expect(leftoversOf(dir, 'a1').processes).toHaveLength(0)
    expect(alive(child) && alive(grandchild)).toBe(true)
    expect(endListed(listed)).toBe(2)
  }, 60000)

  it("keeps listing what it couldn't end, says so, and ends it when tried again", async () => {
    const { launchEnded, leftoversOf, settleLeftovers } = await import('../src/main/agentProcesses')
    const out = join(dir, 'run4.txt')
    await launch('run4', out)
    const { child, grandchild } = pidsIn(out)
    expect((await launchEnded('run4'))?.processes).toHaveLength(2)
    process.env.HIVE_TEST_JOB_KILL_FAILS = '1'
    try {
      await expect(settleLeftovers(dir, 'a1', 'end')).rejects.toThrow(/2 processes are still running/)
    } finally {
      delete process.env.HIVE_TEST_JOB_KILL_FAILS
    }
    expect(leftoversOf(dir, 'a1').processes).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({ type: 'agent-leftovers', leftovers: { agentId: 'a1', processes: [{}, {}] } })
    expect(alive(child) && alive(grandchild)).toBe(true)
    expect(await settleLeftovers(dir, 'a1', 'end')).toBe(2)
    expect(await until(() => !alive(child) && !alive(grandchild), 5000)).toBe(true)
    expect(leftoversOf(dir, 'a1').processes).toHaveLength(0)
  }, 60000)

  it('adopts what escaped the job (#543): a child outside every job whose parent is in it, and its own child, listed and ended', async () => {
    const { launchEnded, leftoversOf, settleLeftovers, trackLaunch } = await import('../src/main/agentProcesses')
    const out = join(dir, 'run5.txt')
    const cli = spawn(process.execPath, [script, 'escaper', out], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    // Both started before the CLI joins its job: neither is in it.
    expect(await until(() => Object.keys(pidsIn(out)).length === 2, 10000)).toBe(true)
    const { child, grandchild } = pidsIn(out)
    expect(await trackLaunch({ runId: 'run5', projectPath: dir, agentId: 'a5', agentName: 'Escaper' }, cli.pid!)).toEqual({ tracked: true })
    // The CLI exits at once: they are adopted as it ends (its id held meanwhile), not left to a later look.
    cli.stdin!.write('go\n')
    await new Promise((r) => cli.once('exit', r))
    const left = await launchEnded('run5')
    expect(left?.processes.map((p) => p.pid).sort()).toEqual([child, grandchild].sort())
    expect(await settleLeftovers(dir, 'a5', 'end')).toBe(2)
    expect(await until(() => !alive(child) && !alive(grandchild), 5000)).toBe(true)
    expect(leftoversOf(dir, 'a5').processes).toHaveLength(0)
  }, 60000)

  // The Store's PowerShell 7 is a packaged app: what it starts leaves every job (#543). Only where it is installed.
  const storePwsh = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'pwsh.exe')
  // An app execution alias: lstat, which stat (existsSync) can't follow.
  const hasStorePwsh = ((): boolean => {
    try {
      return !!lstatSync(storePwsh)
    } catch {
      return false
    }
  })()
  // The two tests that start it run only when asked (#1027): run from a Store PowerShell (every Codex agent's shell),
  // they can end that shell and every other Store PowerShell on the PC, other agents' commands included. Why is #1056.
  const storePwshWanted = process.env.HIVE_TEST_STORE_PWSH === '1'
  const STORE_PWSH_OFF = "starts the Store's PowerShell, which can end other agents' Store PowerShells (#1027, why: #1056): HIVE_TEST_STORE_PWSH=1 runs it"
  it.runIf(hasStorePwsh)("adopts the Store's PowerShell and what it runs, left running by a CLI that has exited", async (ctx) => {
    if (!storePwshWanted) ctx.skip(STORE_PWSH_OFF)
    const { launchEnded, settleLeftovers, trackLaunch } = await import('../src/main/agentProcesses')
    const out = join(dir, 'run6.txt')
    const cli = spawn(process.execPath, [script, 'storepwsh', out], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, env: { ...process.env, STORE_PWSH: storePwsh } })
    expect(await trackLaunch({ runId: 'run6', projectPath: dir, agentId: 'a6', agentName: 'Store shell' }, cli.pid!)).toEqual({ tracked: true })
    cli.stdin!.write('go\n')
    const code = await new Promise<number | null>((r) => cli.once('exit', r))
    const said = existsSync(out) ? readFileSync(out, 'utf8') : ''
    // The Store's PowerShell didn't start, or ended before what it runs had: Windows', not the tracker's (#585).
    if (code !== 0) {
      await launchEnded('run6')
      ctx.skip(`the Store's PowerShell didn't run its command (exit ${code}): ${said.trim()}`)
    }
    const { pwsh, lone } = pidsIn(out)
    const left = await launchEnded('run6')
    // The launch's own and no other's (#659): the shell and what it runs (its console host isn't listed).
    const listed = (left?.processes.map((p) => p.pid) ?? []).sort((a, b) => a - b)
    const own = [pwsh, lone].sort((a, b) => a - b)
    const unlisted = own.filter((p) => !listed.includes(p))
    // What was running then, if not: the shells and the process it ran, with their parents.
    const seen = (): string => (listed.join() === own.join() ? '' : String(execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq ${lone} -or $_.Name -eq 'pwsh.exe' } | ForEach-Object { "$($_.ProcessId) <- $($_.ParentProcessId) $($_.Name)" }`], { windowsHide: true })))
    const why = `CLI ${cli.pid}, ${said.trim()}: ${seen()}`
    expect(listed.filter((p) => !own.includes(p)), why).toEqual([])
    expect(unlisted.filter(alive), why).toEqual([])
    expect(await settleLeftovers(dir, 'a6', 'end')).toBe(listed.length)
    expect(await until(() => !alive(pwsh) && !alive(lone), 5000)).toBe(true)
    // Ended before it was listed, not by this launch: the shell is in its package's job, which another program's job on
    // the PC can take in (as this tracker's did before #659) and end with its own.
    if (unlisted.length) ctx.skip(`the Store's PowerShell or what it ran had ended before it was listed (${unlisted.join(', ')}): ${why}`)
  }, 60000)

  // An escaped process already in a job is followed, never assigned to the launch's (#659): Windows would nest one job in
  // the other. The Store PowerShell's job is its package's, which every Store PowerShell joins: when it had no parent,
  // assigning one made it this launch's, and the next ones (any agent's or app's, other test runs') were listed and
  // ended with it. A test can't make a job without a parent here (Hive's own runs in one, which refuses breakaway), but
  // a launch's job that is still empty has none: assigning nested it the other way, which is as wrong, and shows.
  it('follows an escaped process that is already in another job, never nesting the jobs (#659)', async () => {
    const { HOST_SOURCE } = await import('../src/main/agentProcesses')
    const src = join(dir, 'host.cs')
    writeFileSync(src, HOST_SOURCE)
    const probe = join(dir, 'injob.ps1')
    writeFileSync(
      probe,
      `param($src, $node)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Management -TypeDefinition (Get-Content -Raw $src)
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class OtherJob {
  [DllImport("kernel32.dll")] public static extern IntPtr CreateJobObject(IntPtr a, IntPtr n);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a, bool i, int p);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static bool Assign(IntPtr job, int pid) { IntPtr h = OpenProcess(0x0101 | 0x1000, false, pid); bool ok = AssignProcessToJobObject(job, h); CloseHandle(h); return ok; }
}
'@
$sleeper = { $s = [System.Diagnostics.ProcessStartInfo]::new($node, '-e "setTimeout(() => {}, 60000)"'); $s.UseShellExecute = $false; $s.CreateNoWindow = $true; [System.Diagnostics.Process]::Start($s) }
$r = [ordered]@{}
# In a job of another's, as the Store PowerShell is in its package's.
$a = & $sleeper
$r.inOther = [OtherJob]::Assign([OtherJob]::CreateJobObject([IntPtr]::Zero, [IntPtr]::Zero), $a.Id)
# A launch whose job has nothing in it yet (its CLI exited before it could join).
$gone = & $sleeper
$gone.Kill()
$null = $gone.WaitForExit(10000)
$r.added = [HiveJobs]::Add('t', $gone.Id)
$r.taken = [HiveJobs]::Take('t', $a.Id, $PID, [HiveJobs]::CreatedOf($a.Id))
$r.followed = [HiveJobs]::IsFollowed($a.Id)
$r.inJob = [HiveJobs]::List('t') -contains $a.Id
$r.listed = [HiveJobs]::Members('t') -contains $a.Id
$r.ended = [HiveJobs]::Kill('t') -and $a.WaitForExit(10000)
if (-not $a.HasExited) { Stop-Process -Id $a.Id -Force }
$r | ConvertTo-Json -Compress
`
    )
    const out = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe, src, process.execPath], { windowsHide: true, timeout: 120000 })
    expect(JSON.parse(String(out).trim().split(/\r?\n/).at(-1)!)).toEqual({ inOther: true, added: 'the process has exited', taken: true, followed: true, inJob: false, listed: true, ended: true })
  }, 120000)

  // HI-2304: a job's listing gives each process's executable path (a system broker is known by it), and "running" says
  // which executable names run on the machine (whether a Windows Sandbox does), from a whole snapshot.
  it("lists each process's executable path, and which executable names run now (HI-2304)", async () => {
    const { HOST_SOURCE } = await import('../src/main/agentProcesses')
    const src = join(dir, 'host-running.cs')
    writeFileSync(src, HOST_SOURCE)
    const probe = join(dir, 'running.ps1')
    writeFileSync(
      probe,
      `param($src, $node)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Management -TypeDefinition (Get-Content -Raw $src)
$s = [System.Diagnostics.ProcessStartInfo]::new($node, '-e "setTimeout(() => {}, 60000)"'); $s.UseShellExecute = $false; $s.CreateNoWindow = $true
$a = [System.Diagnostics.Process]::Start($s)
$r = [ordered]@{}
$r.added = [HiveJobs]::Add('t', $a.Id)
$r.listed = [HiveJobs]::Describe('t', 10)
$r.running = [HiveJobs]::Running('NODE.exe,hive-no-such-process-2304.exe')
$r.ended = [HiveJobs]::Kill('t') -and $a.WaitForExit(10000)
if (-not $a.HasExited) { Stop-Process -Id $a.Id -Force }
$r | ConvertTo-Json -Compress
`
    )
    const out = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe, src, process.execPath], { windowsHide: true, timeout: 120000 })
    const r = JSON.parse(String(out).trim().split(/\r?\n/).at(-1)!) as { added: string; listed: string; running: string; ended: boolean }
    expect(r.added).toBe('ok')
    expect(r.ended).toBe(true)
    const listed = JSON.parse(r.listed) as { processes: { name: string; path: string }[] }
    // Its console host (conhost) is in the job too; main leaves it out of what it lists.
    expect(listed.processes.find((p) => p.name.toLowerCase() === 'node.exe')?.path.toLowerCase()).toBe(process.execPath.toLowerCase())
    expect(JSON.parse(r.running)).toEqual(['node.exe'])
  }, 120000)

  // A packaged app's process (the Store's PowerShell) is in no job for its first few ms, until Windows puts it in its
  // package's job (#678). A sweep that sees it then must follow it, not assign it: assigned, Windows nested the package's
  // job in the launch's as it put it there, so the next Store PowerShell anyone started was listed and ended with this
  // launch (#659's harm). A helper takes it in (Take, as a sweep does) the moment a snapshot shows it; the moment is short,
  // so it tries again until it caught one in no job. It ends only what it started, by handles it started them with or
  // checked by start time against the snapshot that saw them (a process an id names by now is never kept).
  it.runIf(hasStorePwsh)("follows a packaged app's process caught before it joins its package's job, never nesting that job (#678)", async (ctx) => {
    if (!storePwshWanted) ctx.skip(STORE_PWSH_OFF)
    const { HOST_SOURCE } = await import('../src/main/agentProcesses')
    const src = join(dir, 'catch.cs')
    writeFileSync(
      src,
      HOST_SOURCE +
        `
public static class Catch {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a, bool i, int p);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool IsProcessInJob(IntPtr p, IntPtr j, out bool r);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr p, uint c);
  [DllImport("kernel32.dll")] static extern void GetSystemTimeAsFileTime(out long now);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint f, int p);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr s, ref PE e);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr s, ref PE e);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct PE { public uint size, usage, pid; public IntPtr heap; public uint module, threads, parent; public int priority; public uint flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string exe; }
  /** The Store PowerShell caught (Pid), held open from when it was checked to be the one seen until End. */
  static IntPtr caught = IntPtr.Zero;
  public static int Pid;
  static long Created(IntPtr h) { long c, x, k, u; return GetProcessTimes(h, out c, out x, out k, out u) ? c : 0; }
  /**
   * Keeps pid as the one caught only if the process it opens is the one a snapshot taken at "at" saw: started after
   * notBefore (its CLI) and not after "at". A process the id names by now (started later) is closed, never kept, so End
   * never ends it: an identity is the id and start time, never the id alone.
   */
  public static bool Hold(int pid, long notBefore, long at) {
    if (caught != IntPtr.Zero) return Pid == pid;
    // PROCESS_TERMINATE | SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION
    IntPtr h = OpenProcess(0x0001 | 0x100000 | 0x1000, false, pid);
    if (h == IntPtr.Zero) return false;
    long created = Created(h);
    if (created == 0 || created < notBefore || created > at) { CloseHandle(h); return false; }
    caught = h;
    Pid = pid;
    return true;
  }
  /** Spins on snapshots until cli's pwsh.exe shows, and takes it into job id as soon as Take will: whether it was in no job just before. */
  public static bool Take(string id, int cli, int ms) {
    // SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION: the CLI exits at once when Windows refuses to start the Store PowerShell (#585).
    IntPtr c = OpenProcess(0x100000 | 0x1000, false, cli);
    try { return Spin(id, cli, c, ms); } finally { CloseHandle(c); }
  }
  static bool Spin(string id, int cli, IntPtr c, int ms) {
    var clock = System.Diagnostics.Stopwatch.StartNew();
    long cliCreated = Created(c);
    while (cliCreated != 0 && clock.ElapsedMilliseconds < ms && WaitForSingleObject(c, 0) != 0) {
      long at; GetSystemTimeAsFileTime(out at);
      IntPtr snap = CreateToolhelp32Snapshot(2, 0);
      var e = new PE(); e.size = (uint)Marshal.SizeOf(typeof(PE));
      int pid = 0;
      for (bool more = Process32FirstW(snap, ref e); more; more = Process32NextW(snap, ref e)) if (e.parent == cli && string.Equals(e.exe, "pwsh.exe", StringComparison.OrdinalIgnoreCase)) pid = (int)e.pid;
      CloseHandle(snap);
      // Not kept when this snapshot is the first to show it (it started after "at"), as Take refuses it then: the next
      // snapshot is looked at.
      if (pid == 0 || !Hold(pid, cliCreated, at)) continue;
      bool any;
      bool none = IsProcessInJob(caught, IntPtr.Zero, out any) && !any;
      if (HiveJobs.Take(id, pid, cli, at)) return none;
    }
    return false;
  }
  public static bool In(int pid) { IntPtr h = OpenProcess(0x1000, false, pid); bool r = false; if (h != IntPtr.Zero) { IsProcessInJob(h, IntPtr.Zero, out r); CloseHandle(h); } return r; }
  public static void End() { if (caught == IntPtr.Zero) return; TerminateProcess(caught, 1); CloseHandle(caught); caught = IntPtr.Zero; Pid = 0; }
}
`
    )
    const probe = join(dir, 'packaged.ps1')
    writeFileSync(
      probe,
      `param($src, $node, $pwsh, $cli)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Management -TypeDefinition (Get-Content -Raw $src)
function Start-Quiet($exe, $arguments, [switch]$stdin) { $s = [System.Diagnostics.ProcessStartInfo]::new($exe, $arguments); $s.UseShellExecute = $false; $s.CreateNoWindow = $true; $s.RedirectStandardInput = [bool]$stdin; [System.Diagnostics.Process]::Start($s) }
function Wait-Until($test) { $clock = [System.Diagnostics.Stopwatch]::StartNew(); while ($clock.ElapsedMilliseconds -lt 10000 -and -not (& $test)) { Start-Sleep -Milliseconds 20 } }
$r = [ordered]@{ caught = $false; tries = 0; refused = 0 }
# The helper itself: a process its snapshot's id names by now, started after that snapshot, is never kept, so never
# ended by its clean-up; the one the snapshot saw is (a sleeper of this script's stands in for both).
$u = Start-Quiet $node '-e "setTimeout(() => {}, 60000)"'
try {
  $uc = [HiveJobs]::CreatedOf($u.Id)
  $r.staleKept = [Catch]::Hold($u.Id, 0, $uc - 1)
  [Catch]::End()
  $r.staleSurvived = [HiveJobs]::CreatedOf($u.Id) -eq $uc
  $r.ownKept = [Catch]::Hold($u.Id, 0, $uc)
  [Catch]::End()
  $r.ownEnded = $u.WaitForExit(10000)
} finally {
  [Catch]::End()
  if (-not $u.HasExited) { $u.Kill() }
}
for ($i = 1; $i -le 10 -and -not $r.caught; $i++) {
  $r.tries = $i
  $job = "t$i"
  $c = $null
  $b = $null
  try {
    # The launch: its CLI joins the job, then on "go" starts the Store PowerShell, which joins its package's job.
    $c = Start-Quiet $node ('"' + $cli + '" "' + $pwsh + '"') -stdin
    $null = [HiveJobs]::Add($job, $c.Id)
    $c.StandardInput.WriteLine('go')
    $r.caught = [Catch]::Take($job, $c.Id, 10000)
    $a = [Catch]::Pid
    if ($r.caught) {
      Wait-Until { [Catch]::In($a) }
      # Another's Store PowerShell, started afterwards outside the launch: never the launch's.
      try { $b = Start-Quiet $pwsh '-NoProfile -Command Start-Sleep 10' } catch { $r.refused++; $r.caught = $false }
      if ($b) {
        Wait-Until { [Catch]::In($b.Id) }
        $r.shellFollowed = [HiveJobs]::IsFollowed($a)
        $r.shellInJob = [HiveJobs]::List($job) -contains $a
        $r.otherInJob = [HiveJobs]::List($job) -contains $b.Id
        $r.otherListed = [HiveJobs]::Members($job) -contains $b.Id
      }
    } elseif ($c.WaitForExit(0) -and $c.ExitCode -eq 3) { $r.refused++ }
  } finally {
    # Only this script's own, each by the handle it started or checked it with.
    if ($b -and -not $b.HasExited) { $b.Kill() }
    [Catch]::End()
    if ($c -and -not $c.HasExited) { $c.Kill() }
    [HiveJobs]::Forget($job)
  }
}
$r | ConvertTo-Json -Compress
`
    )
    const cli = join(dir, 'packagedcli.cjs')
    // Exits with 3 when Windows refuses to start the Store PowerShell (#585), as a throw (EPERM) or an error.
    writeFileSync(cli, `process.stdin.once('data', () => { try { require('child_process').spawn(process.argv[2], ['-NoProfile', '-Command', 'Start-Sleep 10'], { stdio: 'ignore', windowsHide: true }).on('error', () => process.exit(3)) } catch { process.exit(3) } setTimeout(() => process.exit(0), 20000) })\n`)
    const out = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe, src, process.execPath, storePwsh, cli], { windowsHide: true, timeout: 240000 })
    const r = JSON.parse(String(out).trim().split(/\r?\n/).at(-1)!)
    expect(r).toMatchObject({ staleKept: false, staleSurvived: true, ownKept: true, ownEnded: true })
    // Windows' refusals (#585), and a moment never caught, aren't the tracker's.
    if (!r.caught) ctx.skip(`no Store PowerShell was caught before it joined its package's job in ${r.tries} tries (${r.refused} refused by Windows)`)
    expect(r).toMatchObject({ caught: true, shellFollowed: true, shellInJob: false, otherInJob: false, otherListed: false })
  }, 240000)

  // The host's C# driven directly, in a PowerShell of the test's own, with identities a late snapshot or a late port
  // notification could carry (#543): an id that names another process by now is never taken in, and a followed
  // process Windows won't end keeps End failing, and listed, until it is ended.
  it('never takes in a process by a stale id, and End fails while a followed process it could not end runs', async () => {
    const { HOST_SOURCE } = await import('../src/main/agentProcesses')
    const src = join(dir, 'host.cs')
    writeFileSync(src, HOST_SOURCE)
    const probe = join(dir, 'stale.ps1')
    writeFileSync(
      probe,
      `param($src, $node)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Management -TypeDefinition (Get-Content -Raw $src)
$sleeper = { $s = [System.Diagnostics.ProcessStartInfo]::new($node, '-e "console.log(''up''); setTimeout(() => {}, 60000)"'); $s.UseShellExecute = $false; $s.CreateNoWindow = $true; $s.RedirectStandardOutput = $true; [System.Diagnostics.Process]::Start($s) }
$r = [ordered]@{}
$m = & $sleeper
$r.added = [HiveJobs]::Add('t', $m.Id)
# The port holds the member it reports.
for ($i = 0; $i -lt 100 -and -not [HiveJobs]::IsHeld($m.Id); $i++) { Start-Sleep -Milliseconds 50 }
$r.memberHeld = [HiveJobs]::IsHeld($m.Id)
# Started after "the snapshot", by this shell: no child of the member's, whatever a stale snapshot said.
$u = & $sleeper
$r.unrelatedHeld = [HiveJobs]::Hold('t', $u.Id)
# Snapshot times from its exact creation stamp, not a clock read (#616): DateTime.UtcNow is the coarse system clock,
# which can still be before the stamp of a process started before it was read.
$created = [HiveJobs]::CreatedOf($u.Id)
$r.staleTaken = [HiveJobs]::Take('t', $u.Id, $m.Id, $created - 1)
# The same pair, from a snapshot taken as it started, is taken: it is the snapshot's time that refuses it above.
$r.freshTaken = [HiveJobs]::Take('t', $u.Id, $m.Id, $created)
# Followed: one through a handle that can't end it, one that can.
$v = & $sleeper
$w = & $sleeper
# Running its script, so past starting up (#616): Kill ends the console host it was given (adopted, as its child), and
# a process whose console host ends while it starts fails to start (0xC0000142), which is not End's to prevent.
$r.survivorStarted = $v.StandardOutput.ReadLine() -eq 'up'
$r.followed = [HiveJobs]::Follow('t', $v.Id, 0) -and [HiveJobs]::Follow('t', $w.Id, 1)
$r.kill = [HiveJobs]::Kill('t')
$r.endedOne = $w.WaitForExit(10000)
$r.survivorRuns = -not $v.HasExited
$r.survivorFollowed = [HiveJobs]::IsFollowed($v.Id)
$r.survivorListed = [HiveJobs]::Members('t') -contains $v.Id
$r.followedAgain = [HiveJobs]::Follow('t', $v.Id, 1)
$r.killAgain = [HiveJobs]::Kill('t')
$r.survivorEnded = $v.WaitForExit(10000)
$r.othersEnded = $m.WaitForExit(10000) -and $u.WaitForExit(10000)
foreach ($p in @($m, $u, $v, $w)) { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force } }
$r | ConvertTo-Json -Compress
`
    )
    const out = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe, src, process.execPath], { windowsHide: true, timeout: 120000 })
    const r = JSON.parse(String(out).trim().split(/\r?\n/).at(-1)!)
    expect(r).toEqual({
      added: 'ok',
      memberHeld: true,
      unrelatedHeld: false,
      staleTaken: false,
      freshTaken: true,
      survivorStarted: true,
      followed: true,
      kill: false,
      endedOne: true,
      survivorRuns: true,
      survivorFollowed: true,
      survivorListed: true,
      followedAgain: true,
      killAgain: true,
      survivorEnded: true,
      othersEnded: true
    })
  }, 150000)

  // The port's events in an order of the test's own (#604): an exit is gathered, then let go of at the batch's end
  // (Settle). Only the entry held as that exit was read is let go of, once its process has exited: an entry whose
  // process still runs isn't the one that exited; and with its job forgotten meanwhile, the id may name another job's
  // process by now, held under the same id (here the same process, put in a second job: a new entry by that id), which
  // stays held until its own exit. The test holds the host's lock throughout, so the port's thread can't settle a batch
  // of its own in between.
  it('lets go of an exit only for the entry held as it was read, never a later one by the same id (#604)', async () => {
    const { HOST_SOURCE } = await import('../src/main/agentProcesses')
    const src = join(dir, 'host.cs')
    writeFileSync(src, HOST_SOURCE)
    const probe = join(dir, 'exits.ps1')
    writeFileSync(
      probe,
      `param($src, $node)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Management -TypeDefinition (Get-Content -Raw $src)
$s = [System.Diagnostics.ProcessStartInfo]::new($node, '-e "setTimeout(() => {}, 60000)"'); $s.UseShellExecute = $false; $s.CreateNoWindow = $true
$m = [System.Diagnostics.Process]::Start($s)
$r = [ordered]@{}
$r.added = [HiveJobs]::Add('old', $m.Id)
# The port holds the member it reports.
for ($i = 0; $i -lt 200 -and [HiveJobs]::HeldBy($m.Id) -ne 'old'; $i++) { Start-Sleep -Milliseconds 50 }
$r.heldOld = [HiveJobs]::HeldBy($m.Id)
$turn = [HiveJobs].GetField('turn', [System.Reflection.BindingFlags]'NonPublic,Static').GetValue($null)
[System.Threading.Monitor]::Enter($turn)
try {
  # Its exit gathered while it still runs.
  [HiveJobs]::Notify('old', 7, $m.Id)
  [HiveJobs]::Settle()
  $r.runningKept = [HiveJobs]::HeldBy($m.Id)
  # Its exit gathered, then its job forgotten before the batch ends, and the id held again by another job, whose process
  # has exited too as the batch ends.
  [HiveJobs]::Notify('old', 7, $m.Id)
  [HiveJobs]::Forget('old')
  $r.forgotten = [HiveJobs]::HeldBy($m.Id)
  $r.addedNew = [HiveJobs]::Add('new', $m.Id)
  [HiveJobs]::Notify('new', 6, $m.Id)
  $r.heldNew = [HiveJobs]::HeldBy($m.Id)
  $m.Kill()
  $r.exited = $m.WaitForExit(10000)
  [HiveJobs]::Settle()
  $r.newKept = [HiveJobs]::HeldBy($m.Id)
  # Its own exit lets it go.
  [HiveJobs]::Notify('new', 7, $m.Id)
  [HiveJobs]::Settle()
  $r.letGo = [HiveJobs]::HeldBy($m.Id)
  [HiveJobs]::Forget('new')
} finally {
  [System.Threading.Monitor]::Exit($turn)
  if (-not $m.HasExited) { Stop-Process -Id $m.Id -Force }
}
$r | ConvertTo-Json -Compress
`
    )
    const out = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe, src, process.execPath], { windowsHide: true, timeout: 120000 })
    const r = JSON.parse(String(out).trim().split(/\r?\n/).at(-1)!)
    expect(r).toEqual({ added: 'ok', heldOld: 'old', runningKept: 'old', forgotten: null, addedNew: 'ok', heldNew: 'new', exited: true, newKept: 'new', letGo: null })
  }, 150000)

  // Joins and listings in an order of the test's own (#1134, round 1): a notice due for one launch's process is never
  // taken back by listing another launch (the port's thread had told it, the input thread listed B before the notice was
  // written); each launch is told once until it is listed again, however many processes join it.
  it('tells each launch once until it is listed again, and listing one never takes back the notice due for another (#1134)', async () => {
    const { HOST_SOURCE } = await import('../src/main/agentProcesses')
    const src = join(dir, 'host-notices.cs')
    writeFileSync(src, HOST_SOURCE)
    const probe = join(dir, 'notices.ps1')
    writeFileSync(
      probe,
      `param($src)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Management -TypeDefinition (Get-Content -Raw $src)
$w = [System.IO.StringWriter]::new()
[HiveJobs]::Notices = $w
$told = { ($w.ToString() -split "\`n" | Where-Object { $_.Trim() -eq 'new' }).Count }
$r = [ordered]@{}
# A joins; B is listed before the notice is written.
[HiveJobs]::Joined('a'); $null = [HiveJobs]::Describe('b', 5); [HiveJobs]::Tell()
$r.otherListed = & $told
# A again, not listed since: nothing more.
[HiveJobs]::Joined('a'); [HiveJobs]::Tell()
$r.again = & $told
# B joins: told on its own.
[HiveJobs]::Joined('b'); [HiveJobs]::Tell()
$r.otherJob = & $told
# A listed, then many join it: told once.
$null = [HiveJobs]::Describe('a', 5)
for ($i = 0; $i -lt 20; $i++) { [HiveJobs]::Joined('a') }
[HiveJobs]::Tell(); [HiveJobs]::Tell()
$r.afterListing = & $told
$r | ConvertTo-Json -Compress
`
    )
    const out = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe, src], { windowsHide: true, timeout: 120000 })
    const r = JSON.parse(String(out).trim().split(/\r?\n/).at(-1)!)
    expect(r).toEqual({ otherListed: 1, again: 1, otherJob: 2, afterListing: 3 })
  }, 150000)

  it('lists nothing for a launch that left nothing running, nor for one it never tracked', async () => {
    const { launchEnded, trackLaunch } = await import('../src/main/agentProcesses')
    const cli = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { stdio: 'ignore', windowsHide: true })
    expect(await trackLaunch({ runId: 'run3', projectPath: dir, agentId: 'a3', agentName: 'Quiet' }, cli.pid!)).toEqual({ tracked: true })
    await new Promise((r) => cli.once('exit', r))
    expect(await launchEnded('run3')).toBeNull()
    expect(await launchEnded('never')).toBeNull()
  }, 30000)

  it('keeps what is listed across a restart, by pid and start time, and ends exactly those processes (#614)', async () => {
    const kept = join(profile.dir, 'leftovers.json')
    const before = await import('../src/main/agentProcesses')
    const out = join(dir, 'run7.txt')
    await launch('run7', out, 'a7')
    const { child, grandchild } = pidsIn(out)
    const left = await before.launchEnded('run7')
    expect(left?.processes.map((p) => p.pid).sort()).toEqual([child, grandchild].sort())
    expect(left?.processes.every((p) => /^\d+$/.test(p.created ?? ''))).toBe(true)
    await before.leftoversSaved()
    const saved = JSON.parse(readFileSync(kept, 'utf8'))
    expect(saved.launches).toHaveLength(1)
    expect(saved.launches[0]).toMatchObject({ runId: 'run7', projectPath: dir, agentId: 'a7', agentName: 'Website' })
    expect(saved.launches[0].processes.map((p: { pid: number }) => p.pid).sort()).toEqual([child, grandchild].sort())

    // Someone else's process, which a kept record names by its pid with another start time: as if the pid were reused.
    const other = join(dir, 'other7.txt')
    const strangerProc = spawn(process.execPath, [script, 'stranger', other], { detached: true, stdio: 'ignore', windowsHide: true })
    strangerProc.unref()
    expect(await until(() => !!pidsIn(other).stranger, 10000)).toBe(true)
    const stranger = pidsIn(other).stranger
    saved.launches[0].processes.push({ pid: stranger, name: 'node.exe', label: 'node old.js', created: '116444736000000000' })
    // An older launch's record of the child's pid with another start time (a process the pid named before): two
    // records share the pid, and only the one that is the same process is listed.
    const [first] = saved.launches[0].processes
    const older = String(BigInt(saved.launches[0].processes.find((p: { pid: number }) => p.pid === child).created) - 10_000_000n)
    saved.launches.unshift({ runId: 'run-old', projectPath: dir, agentId: 'a8', agentName: 'Old', since: saved.launches[0].since, processes: [{ ...first, pid: child, created: older }] })
    // More launches for one agent than Hive keeps (5 an agent): the newest are kept, however often Hive restarts.
    for (let i = 1; i <= 7; i++) saved.launches.push({ runId: `many${i}`, projectPath: dir, agentId: 'a9', agentName: 'Many', since: saved.launches[1].since, processes: saved.launches[1].processes.filter((p: { pid: number }) => p.pid === grandchild) })
    writeFileSync(kept, JSON.stringify(saved))

    // Hive restarts: its tracker and its memory go (the processes keep running), the kept list stays.
    const restart = async (mod: typeof before): Promise<typeof before> => {
      await mod.closeProcessTracking()
      vi.resetModules()
      return import('../src/main/agentProcesses')
    }
    let after = await restart(before)
    expect(after.leftoversOf(dir, 'a7').processes).toHaveLength(0)
    const found = await after.restoreLeftovers()
    expect(found.map((l) => l.agentId).sort()).toEqual(['a7', 'a9'])
    expect(after.leftoversOf(dir, 'a7').processes.map((p) => p.pid).sort()).toEqual([child, grandchild].sort())
    expect(after.leftoversOf(dir, 'a8').processes).toHaveLength(0)
    const keptNow = async (): Promise<{ runId: string; agentId: string }[]> => {
      await after.leftoversSaved()
      return JSON.parse(readFileSync(kept, 'utf8')).launches
    }
    const many = async (): Promise<string[]> => (await keptNow()).filter((l) => l.agentId === 'a9').map((l) => l.runId)
    expect(after.leftoversOf(dir, 'a9').processes).toHaveLength(5)
    expect(await many()).toEqual(['restored:many3', 'restored:many4', 'restored:many5', 'restored:many6', 'restored:many7'])
    // Again: still the same five, not more.
    after = await restart(after)
    await after.restoreLeftovers()
    expect(after.leftoversOf(dir, 'a9').processes).toHaveLength(5)
    expect(await many()).toEqual(['restored:many3', 'restored:many4', 'restored:many5', 'restored:many6', 'restored:many7'])
    expect((await keptNow()).some((l) => l.agentId === 'a8')).toBe(false)

    expect(await after.settleLeftovers(dir, 'a9', 'keep')).toBe(5)
    expect(await after.settleLeftovers(dir, 'a7', 'end')).toBe(2)
    expect(await until(() => !alive(child) && !alive(grandchild), 5000)).toBe(true)
    expect(alive(stranger)).toBe(true)
    expect(after.leftoversOf(dir, 'a7').processes).toHaveLength(0)
    expect(await keptNow()).toEqual([])
    await after.closeProcessTracking()
    await endHeld(strangerProc)
  }, 90000)
})

// Stop Them's whole tree (#1008): EndTree picks what to end by the parent ids of a snapshot, holding a handle on each
// process it checked. Driven here with the OS's answers given (PickTree's open, absent, createdOf, running), so the
// races are deterministic: an id another process took between the snapshot and the check, a root Hive can't open, a
// root gone, a root whose id names another process now, a child that has exited, a child Hive can't open or read
// (reported, never passed over). Nothing real is ended.
describe.runIf(process.platform === 'win32')("what Stop Them ends of a test run's tree (#1008)", () => {
  const dir = tempDir('hive-picktree-')

  it('takes each root only while it is that process, and below it only children started after their parent and by the snapshot', async () => {
    const { HOST_SOURCE } = await import('../src/main/agentProcesses')
    const src = join(dir, 'host.cs')
    writeFileSync(src, HOST_SOURCE)
    const probe = join(dir, 'pick.ps1')
    writeFileSync(
      probe,
      `param($src)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Management -TypeDefinition (Get-Content -Raw $src)
# A case: the snapshot's parent ids (parent = children), and each process as the check finds it (id = created, running,
# open: whether Hive can open it to end it, peek: what a query-only look says of one it can't, the start time, 0 gone
# or -1 unreadable); one not listed has gone (no process has its id). The snapshot is at 200.
function Pick($roots, $tree, $now) {
  $children = New-Object 'System.Collections.Generic.Dictionary[int,System.Collections.Generic.List[int]]'
  foreach ($k in $tree.Keys) { $l = New-Object 'System.Collections.Generic.List[int]'; foreach ($c in $tree[$k]) { $l.Add([int]$c) }; $children[[int]$k] = $l }
  $closed = New-Object 'System.Collections.Generic.List[int]'
  $failed = New-Object 'System.Collections.Generic.List[string]'
  $unverified = New-Object 'System.Collections.Generic.List[int]'
  $open = [Func[int,IntPtr]]{ param($id) if ($now.ContainsKey($id) -and $now[$id].open -ne $false) { [IntPtr]$id } else { [IntPtr]::Zero } }
  $absent = [Func[int,bool]]{ param($id) -not $now.ContainsKey($id) }
  $created = [Func[IntPtr,long]]{ param($h) [long]$now[[int]$h].created }
  $running = [Func[IntPtr,bool]]{ param($h) $now[[int]$h].running -ne $false }
  $close = [Action[IntPtr]]{ param($h) $closed.Add([int]$h) }
  $peek = [Func[int,long]]{ param($id) if ($now.ContainsKey($id)) { [long]$now[$id].peek } else { 0 } }
  $picked = [HiveJobs]::PickTree($roots, $children, 200, $open, $absent, $created, $running, $close, $peek, $failed, $unverified)
  [ordered]@{ picked = @($picked | ForEach-Object { '{0}:{1}' -f $_.pid, $_.created }); closed = @($closed); failed = @($failed); unverified = @($unverified) }
}
$r = [ordered]@{}
# A run: 10 → 20 → 30; 40 names 10 as its parent but started before it (an id a later process took).
$r.tree = Pick '10:100' @{ 10 = @(20, 40); 20 = @(30) } @{ 10 = @{ created = 100 }; 20 = @{ created = 150 }; 30 = @{ created = 160 }; 40 = @{ created = 50 } }
# 20 ended after the snapshot and another process took its id before the check: started after the snapshot, not taken.
$r.reused = Pick '10:100' @{ 10 = @(20) } @{ 10 = @{ created = 100 }; 20 = @{ created = 300 } }
# The root runs but can't be opened: nothing below it followed, and it is reported (it still runs).
$r.unreadable = Pick '10:100' @{ 10 = @(20) } @{ 10 = @{ created = 100; open = $false }; 20 = @{ created = 150 } }
# The root has gone: nothing below it followed (what it started that was listed is a root of its own), nothing reported.
$r.gone = Pick '10:100' @{ 10 = @(20) } @{ 20 = @{ created = 150 } }
# The root's id names another process now: never taken or followed.
$r.other = Pick '10:100' @{ 10 = @(20) } @{ 10 = @{ created = 999 }; 20 = @{ created = 1000 } }
# A child that has exited (its id still held): not taken.
$r.exited = Pick '10:100' @{ 10 = @(20) } @{ 10 = @{ created = 100 }; 20 = @{ created = 150; running = $false } }
# Children that run and Hive can't open to end: one a query-only look shows is the run's (reported by its identity), one
# it can't read at all (unverified), one that has gone by then, one whose id a later process took: never passed over in
# silence, nor anything below them followed. A child opened whose start time can't be read, running: unverified too.
$r.unopenable = Pick '10:100' @{ 10 = @(21, 22, 23, 24, 25) } @{ 10 = @{ created = 100 }; 21 = @{ created = 151; open = $false; peek = 151 }; 22 = @{ open = $false; peek = -1 }; 23 = @{ open = $false; peek = 0 }; 24 = @{ open = $false; peek = 300 }; 25 = @{ created = 0 } }
# The root runs, but its start time can't be read: reported, not followed.
$r.rootUnread = Pick '10:100' @{ 10 = @(20) } @{ 10 = @{ created = 0 }; 20 = @{ created = 150 } }
# Two roots of one run, one below the other: each taken once.
$r.twice = Pick '10:100,20:150' @{ 10 = @(20) } @{ 10 = @{ created = 100 }; 20 = @{ created = 150 } }
$r | ConvertTo-Json -Compress -Depth 4
`
    )
    const out = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe, src], { windowsHide: true, timeout: 120000 })
    const r = JSON.parse(String(out).trim().split(/\r?\n/).at(-1)!) as Record<string, { picked: string[]; closed: number[]; failed: string[] }>
    expect(r.tree).toEqual({ picked: ['10:100', '20:150', '30:160'], closed: [40], failed: [], unverified: [] })
    expect(r.reused).toEqual({ picked: ['10:100'], closed: [20], failed: [], unverified: [] })
    expect(r.unreadable).toEqual({ picked: [], closed: [], failed: ['10:100'], unverified: [] })
    expect(r.gone).toEqual({ picked: [], closed: [], failed: [], unverified: [] })
    expect(r.other).toEqual({ picked: [], closed: [10], failed: [], unverified: [] })
    expect(r.exited).toEqual({ picked: ['10:100'], closed: [20], failed: [], unverified: [] })
    expect(r.unopenable).toEqual({ picked: ['10:100'], closed: [25], failed: ['21:151'], unverified: [22, 25] })
    expect(r.rootUnread).toEqual({ picked: [], closed: [10], failed: ['10:100'], unverified: [] })
    expect(r.twice).toEqual({ picked: ['10:100', '20:150'], closed: [], failed: [], unverified: [] })
  }, 120000)
})

