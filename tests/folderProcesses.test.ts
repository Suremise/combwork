import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { createRequire } from 'module'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

type Proc = { pid: number; parent?: number; commandLine: string; started: number }
type Tree = { pid: number; started: number }[]
const req = createRequire(import.meta.url)
const { namesFolder, namesFile, ownedBy, descendantsIn, stillRunning, filetimeMs, leftoverIdentities, processes, endExactly, suspendExactly, suspensions, childrenFirst, stopProcessesIn, identify, stillSame, endTreeExactly, endChildTree } = req('./e2e/folderProcesses.cjs') as {
  processes: () => Proc[]
  endExactly: (targets: Tree) => number
  suspendExactly: (targets: Tree, resume?: boolean) => { done: Tree; failed: { pid: number; why: string }[] }
  suspensions: (act?: (t: Tree, resume?: boolean) => { done: Tree; failed: { pid: number; why: string }[] }, end?: (t: Tree) => number) => { held: () => Tree; suspend: (t: Tree) => { done: Tree; failed: { pid: number; why: string }[] }; resume: () => { pid: number; why: string }[]; release: () => { failed: { pid: number; why: string }[]; ended: Tree } }
  childrenFirst: (list: Proc[], targets: Tree) => Tree
  namesFolder: (cmd: string, folder: string) => boolean
  namesFile: (list: Proc[], name: string) => boolean
  ownedBy: (list: Proc[], folder: string, since?: number, self?: number) => number[]
  descendantsIn: (list: Proc[], root: number) => Tree
  stillRunning: (list: Proc[], tree: Tree) => number[]
  filetimeMs: (created: string | undefined) => number | null
  leftoverIdentities: (list: Proc[], leftovers: { processes: { pid: number; created?: string }[] }[] | undefined) => Tree
  stopProcessesIn: (folder: string, since?: number, tree?: Tree) => number
  identify: (pids: number[]) => Tree
  stillSame: (ids: Tree) => number[]
  endTreeExactly: (root: { pid: number; started: number }, list?: Proc[]) => number
  endChildTree: (child: ChildProcess) => number
}
const { baseEnv } = req('./e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }

describe("a scenario's leftover processes (#542, #402)", () => {
  const dir = 'C:\\combwork-test\\scenarios\\lanes\\1\\scenario'
  it('the folder itself or inside it, in any spelling: backslashes, slashes, case, quoted', () => {
    expect(namesFolder(`cmd.exe /c "${dir}\\profile\\bin\\hive-progress.cmd" --title x`, dir)).toBe(true)
    expect(namesFolder('node C:/COMBWORK-TEST/scenarios/lanes/1/scenario/run.js', dir)).toBe(true)
    expect(namesFolder(`node -e x "${dir}"`, dir)).toBe(true)
    expect(namesFolder(`node -e x ${dir}`, dir + '\\')).toBe(true)
  })
  it("never a sibling whose name only starts the same, nor anything else", () => {
    expect(namesFolder(`node x ${dir}-2\\run.js`, dir)).toBe(false)
    expect(namesFolder(`node x "${dir}-2"`, dir)).toBe(false)
    expect(namesFolder(`node x ${dir}s`, dir)).toBe(false)
    expect(namesFolder('node x C:\\combwork-test\\scenarios\\lanes\\1', dir)).toBe(false)
  })
  it("a command naming the run's own file, as a whole name: another suite's file never counts (#658)", () => {
    const own = 'bg-done-4242-mfx1.txt'
    const proc = (commandLine: string) => ({ pid: 10, started: 1, commandLine })
    const ps = (file: string) => `pwsh.exe -Command "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\nStart-Sleep -Seconds 40; Set-Content -Path ${file} -Value done"`
    // Its own command, in either case and by a path too.
    expect(namesFile([proc(ps(own))], own)).toBe(true)
    expect(namesFile([proc(ps(`C:\\demo\\${own.toUpperCase()}`))], own)).toBe(true)
    // The own command never started, while another suite's runs: the run's own name isn't in theirs, nor at the end of a longer one.
    const others = [proc(ps('bg-done.txt')), proc(ps('bg-done-1111-abcd.txt')), proc(`node -e x other-suite-${own}`), proc(ps(`${own}.bak`)), proc('')]
    expect(namesFile(others, own)).toBe(false)
    expect(namesFile([], own)).toBe(false)
  })
  it('only processes started since the scenario did, and never this one', () => {
    const list: Proc[] = [
      { pid: 11, commandLine: `node ${dir}\\a`, started: 2000 },
      { pid: 12, commandLine: `node ${dir}\\b`, started: 500 },
      { pid: 13, commandLine: `node ${dir}-2\\c`, started: 2000 },
      { pid: 14, commandLine: `node ${dir}\\d`, started: 2000 }
    ]
    expect(ownedBy(list, dir, 1000, 14)).toEqual([11])
    expect(ownedBy(list, dir, 0, 14)).toEqual([11, 12])
  })

  it("its Combwork's tree: descendants only, a reused pid (started before its parent) never, and only while the same process", () => {
    const list = [
      { pid: 100, parent: 1, started: 1000, commandLine: 'electron .' },
      { pid: 101, parent: 100, started: 1100, commandLine: 'pty host' },
      { pid: 102, parent: 101, started: 1200, commandLine: '' },
      { pid: 103, parent: 102, started: 1300, commandLine: 'node -e x' },
      { pid: 104, parent: 101, started: 900, commandLine: 'reused pid' },
      { pid: 105, parent: 1, started: 1100, commandLine: 'unrelated' }
    ]
    const tree = descendantsIn(list, 100)
    expect(tree.map((t) => t.pid).sort()).toEqual([101, 102, 103])
    // Once Combwork closed: 103 still runs, 102 ended, and 101's pid now belongs to another process.
    const after = [list[3], { pid: 101, parent: 7, started: 5000, commandLine: 'someone else' }, list[5]]
    expect(stillRunning(after, tree)).toEqual([103])
  })

  it("what Combwork lists as its agents' leftovers: those processes by pid and start time, never a pid given to another since (HI-2217)", () => {
    // 2026-10-31T09:49:34.123Z as a FILETIME, and as ms.
    const at = Date.parse('2026-10-31T09:49:34.123Z')
    const ft = (ms: number, extra = 0n): string => String(BigInt(ms) * 10000n + 116444736000000000n + extra)
    expect(filetimeMs(ft(at, 9999n))).toBe(at)
    expect(filetimeMs('not a time')).toBeNull()
    expect(filetimeMs(undefined)).toBeNull()
    const list = [
      { pid: 90676, parent: 89920, started: at, commandLine: 'find.exe / -name cache.js' },
      { pid: 75552, parent: 30344, started: at + 1, commandLine: 'head.exe' },
      { pid: 4242, parent: 1, started: at + 60_000, commandLine: 'someone else, given the pid since' }
    ]
    const leftovers = [
      { projectPath: 'C:\\alpha', agentId: 'a-1', agentName: 'Coder', more: 0, since: '', processes: [
        { pid: 90676, name: 'find.exe', label: 'find / -name cache.js', created: ft(at) },
        // Its start time 1 ms off (the two clocks' rounding): the same process.
        { pid: 75552, name: 'head.exe', label: 'head', created: ft(at) },
        { pid: 4242, name: 'node.exe', label: 'node x', created: ft(at) },
        { pid: 777, name: 'gone.exe', label: 'gone', created: ft(at) },
        { pid: 90676, name: 'find.exe', label: 'no start time' }
      ] }
    ]
    expect(leftoverIdentities(list, leftovers)).toEqual([{ pid: 90676, started: at }, { pid: 75552, started: at + 1 }])
    expect(leftoverIdentities(list, [])).toEqual([])
    expect(leftoverIdentities(list, undefined)).toEqual([])
  })

  it('children are ended before their parents, which can take them with them (#615)', () => {
    // The GitHub runner's values: a parent naming the folder, its child (a lower pid), each start time as WMI and .NET
    // both gave it. Ending the parent first ended the child with it (Node's kill-on-close job), so it was never reached.
    const parent = { pid: 6440, parent: 1300, started: 1791740931617, commandLine: 'node -e x tree\\child.pid' }
    const child = { pid: 6252, parent: 6440, started: 1791740931655, commandLine: 'node -e y' }
    const grandchild = { pid: 7000, parent: 6252, started: 1791740931700, commandLine: 'node -e z' }
    const list = [child, grandchild, parent]
    const at = (p: Proc) => ({ pid: p.pid, started: p.started })
    expect(childrenFirst(list, [at(parent), at(child)])).toEqual([at(child), at(parent)])
    expect(childrenFirst(list, [at(parent), at(child), at(grandchild)])).toEqual([at(grandchild), at(child), at(parent)])
    expect(childrenFirst(list, [at(grandchild), at(parent), at(child)])).toEqual([at(grandchild), at(child), at(parent)])
    // A parent pid that is now another process (started after its "child") isn't its parent: the order given stays.
    const reused = { ...parent, started: 1791740940000 }
    expect(childrenFirst([child, reused], [at(reused), at(child)])).toEqual([at(reused), at(child)])
    // Unrelated targets keep their order.
    expect(childrenFirst(list, [at(grandchild), at(parent)])).toEqual([at(grandchild), at(parent)])
  })

  const tmp = tempDir('cw-folder-processes-')
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))
  it.runIf(process.platform === 'win32')('stops its own process; a sibling-prefix folder\'s and an unrelated one keep running', async () => {
    const own = join(tmp, 'scenario')
    const sibling = join(tmp, 'scenario-2')
    for (const d of [own, sibling]) mkdirSync(d, { recursive: true })
    const since = Date.now() - 1000
    const start = (arg: string): ChildProcess => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', arg], { env: baseEnv(), stdio: 'ignore' })
    const kids = { own: start(own), sibling: start(sibling), other: start(join(tmp, 'other')) }
    const exited = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null
    try {
      expect(stopProcessesIn(own, since)).toBe(1)
      await vi.waitFor(() => expect(exited(kids.own)).toBe(true), { timeout: 15000, interval: 100 })
      expect(exited(kids.sibling)).toBe(false)
      expect(exited(kids.other)).toBe(false)
      // Started before `since`: not the scenario's, so left alone.
      expect(stopProcessesIn(sibling, Date.now() + 60000)).toBe(0)
      expect(exited(kids.sibling)).toBe(false)
    } finally {
      for (const c of Object.values(kids)) if (!exited(c)) c.kill()
    }
  }, 30000)

  it.runIf(process.platform === 'win32')('never ends a pid that is now another process: only the one it was when listed (#547)', async () => {
    const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: baseEnv(), stdio: 'ignore' })
    const exited = () => kid.exitCode !== null || kid.signalCode !== null
    try {
      const listed = processes().find((p) => p.pid === kid.pid)!
      expect(listed).toBeTruthy()
      // As if the listed process had ended and Windows had given its pid to this one, started later: left alone.
      expect(endExactly([{ pid: kid.pid!, started: listed.started - 5000 }])).toBe(0)
      expect(exited()).toBe(false)
      // The process it was when listed: ended.
      expect(endExactly([{ pid: kid.pid!, started: listed.started }])).toBe(1)
      await vi.waitFor(() => expect(exited()).toBe(true), { timeout: 15000, interval: 100 })
      // Already gone: nothing to end, and no error.
      expect(endExactly([{ pid: kid.pid!, started: listed.started }])).toBe(0)
    } finally {
      if (!exited()) kid.kill()
    }
  }, 30000)

  it("a test's suspensions: what failed to resume stays held, what has gone is dropped, cleanup ends what can't be resumed (#600)", () => {
    // Stubs only: no process is touched. A resume of pid 2 fails (a native status), pid 3 has gone, pid 1 resumes.
    type Act = (t: Tree, resume?: boolean) => { done: Tree; failed: { pid: number; why: string }[] }
    const resumeFails = new Set([2])
    const calls: string[] = []
    const act: Act = (targets, resume = false) => {
      calls.push(`${resume ? 'resume' : 'suspend'} ${targets.map((t) => t.pid).join(',')}`)
      if (!resume) return { done: targets.filter((t) => t.pid !== 9), failed: targets.filter((t) => t.pid === 9).map((t) => ({ pid: t.pid, why: '0xC0000022' })) }
      return {
        done: targets.filter((t) => t.pid === 1),
        failed: targets.filter((t) => t.pid !== 1).map((t) => ({ pid: t.pid, why: t.pid === 3 ? 'gone' : resumeFails.has(t.pid) ? '0xC0000022' : 'another process' }))
      }
    }
    const ended: Tree[] = []
    const s = suspensions(act, (t: Tree) => (ended.push(t), t.length))
    const one = { pid: 1, started: 10 }
    const two = { pid: 2, started: 20 }
    const three = { pid: 3, started: 30 }
    // One that couldn't be suspended isn't held (nothing to resume).
    expect(s.suspend([one, two, three, { pid: 9, started: 90 }]).failed).toEqual([{ pid: 9, why: '0xC0000022' }])
    expect(s.held()).toEqual([one, two, three])
    // Resumed and gone leave the list; the one whose resume failed stays, by the identity it was suspended as.
    expect(s.resume()).toEqual([{ pid: 2, why: '0xC0000022' }, { pid: 3, why: 'gone' }])
    expect(s.held()).toEqual([two])
    // Cleanup tries again, and ends by its identity what still can't be resumed; nothing is left held.
    expect(s.release()).toEqual({ failed: [{ pid: 2, why: '0xC0000022' }], ended: [two] })
    expect(ended).toEqual([[two]])
    expect(s.held()).toEqual([])
    // Nothing held: cleanup does nothing.
    expect(s.release()).toEqual({ failed: [], ended: [] })
    expect(calls).toEqual(['suspend 1,2,3,9', 'resume 1,2,3', 'resume 2'])
  })

  it.runIf(process.platform === 'win32')('suspends and resumes only the process a pid was when listed, and says what it did (#600)', async () => {
    // A process of the test's own that counts up in a file, so whether it runs shows.
    const own = tempDir('suspend')
    const ticks = join(own, 'ticks')
    const kid = spawn(process.execPath, ['-e', `let n = 0; setInterval(() => require('fs').writeFileSync(${JSON.stringify(ticks)}, String(++n)), 50)`], { env: baseEnv(), stdio: 'ignore' })
    const exited = () => kid.exitCode !== null || kid.signalCode !== null
    const count = () => (existsSync(ticks) ? Number(readFileSync(ticks, 'utf8')) || 0 : 0)
    // Its identity, taken once, now: Node holds the child's handle until it exits, so its pid names no other process
    // yet. Every suspension and resume here, cleanup's too, goes by this identity, never by its pid looked up again.
    const me = identify([kid.pid!])[0]
    try {
      expect(me?.pid).toBe(kid.pid)
      await vi.waitFor(() => expect(count()).toBeGreaterThan(0), { timeout: 15000, interval: 50 })
      // As if its pid named another process by now (started later): nothing is done, and it says why.
      const other = suspendExactly([{ pid: me.pid, started: me.started - 5000 }])
      expect(other).toEqual({ done: [], failed: [{ pid: me.pid, why: 'another process' }] })
      // A pid that names nothing: not done either.
      expect(suspendExactly([{ pid: 4_000_000, started: me.started }]).failed).toEqual([{ pid: 4_000_000, why: 'gone' }])
      // The process it was: suspended (the call's status says so), then resumed, after which it counts on.
      expect(suspendExactly([me])).toEqual({ done: [me], failed: [] })
      const at = count()
      expect(suspendExactly([me], true)).toEqual({ done: [me], failed: [] })
      await vi.waitFor(() => expect(count()).toBeGreaterThan(at), { timeout: 15000, interval: 50 })
    } finally {
      // Resumed in case a check failed while it was suspended: by its identity, so a pid reused since is left alone.
      if (me) suspendExactly([me], true)
      if (!exited()) kid.kill()
    }
  }, 30000)

  it.runIf(process.platform === 'win32')('a process of its own and the child it started: each ended once, by what it was when listed', async () => {
    const own = join(tmp, 'tree')
    mkdirSync(own, { recursive: true })
    const childPid = join(own, 'child.pid')
    const since = Date.now() - 1000
    // A parent naming the folder, whose child doesn't (as a shell and the command it runs).
    const script = `require('fs').writeFileSync(process.argv[1], String(require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).pid)); setInterval(() => {}, 1000)`
    const parent = spawn(process.execPath, ['-e', script, childPid], { env: baseEnv(), stdio: 'ignore' })
    // Still that process (pid and start): a pid given to another process since counts as gone.
    const alive = (t: { pid: number; started: number }) => processes().some((p) => p.pid === t.pid && p.started === t.started)
    try {
      await vi.waitFor(() => expect(existsSync(childPid) && Number(readFileSync(childPid, 'utf8')) > 0).toBe(true), { timeout: 15000, interval: 100 })
      const childPidNow = Number(readFileSync(childPid, 'utf8'))
      const child = processes().find((p) => p.pid === childPidNow)!
      expect(child).toBeTruthy()
      // The child is in a job that ends with its parent (Node's): only ending it first reaches it (#615).
      expect(stopProcessesIn(own, since)).toBe(2)
      await vi.waitFor(() => expect(parent.exitCode !== null || parent.signalCode !== null).toBe(true), { timeout: 15000, interval: 100 })
      expect(alive(child)).toBe(false)
      expect(stopProcessesIn(own, since)).toBe(0)
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill()
    }
  }, 60000)

  it("a tree ends only from the root's own identity: a root whose pid names another process by now ends nothing (#603)", () => {
    // The root as it was when taken (pid 100, started 1000); its pid is now an unrelated process's, with a child of its own.
    const now = [
      { pid: 100, parent: 4, started: 9000, commandLine: 'node worker.js' },
      { pid: 101, parent: 100, started: 9100, commandLine: 'node worker-child.js' }
    ]
    expect(endTreeExactly({ pid: 100, started: 1000 }, now)).toBe(0)
    // Gone, or never given an identity: nothing either.
    expect(endTreeExactly({ pid: 100, started: 1000 }, [])).toBe(0)
    expect(endTreeExactly({ pid: 100, started: 0 }, now)).toBe(0)
  })

  it.runIf(process.platform === 'win32')("ends a root that is still itself and its child, children first; a stale identity of it, or an exited ChildProcess, ends nothing (#603)", async () => {
    const childPid = join(tmp, 'tree-603.pid')
    // A parent and the child it starts, the child in a job that ends with its parent (Node's): only ending it first reaches it.
    const script = `require('fs').writeFileSync(process.argv[1], String(require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).pid)); setInterval(() => {}, 1000)`
    const parent = spawn(process.execPath, ['-e', script, childPid], { env: baseEnv(), stdio: 'ignore' })
    const exited = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null
    try {
      await vi.waitFor(() => expect(existsSync(childPid) && Number(readFileSync(childPid, 'utf8')) > 0).toBe(true), { timeout: 15000, interval: 100 })
      const [root, child] = identify([parent.pid!, Number(readFileSync(childPid, 'utf8'))])
      expect(root && child).toBeTruthy()
      // As if the root had ended and Windows had given its pid to this process, started later: it and its child are left alone.
      expect(endTreeExactly({ pid: root.pid, started: root.started - 5000 })).toBe(0)
      expect(stillSame([root, child])).toEqual([root.pid, child.pid])
      // Its own identity: both ended, the child first (ending the parent first would take the child with it: 1).
      expect(endTreeExactly(root)).toBe(2)
      await vi.waitFor(() => expect(exited(parent)).toBe(true), { timeout: 15000, interval: 100 })
      expect(stillSame([root, child])).toEqual([])
      // Gone: nothing to end, and no error; an exited ChildProcess is never looked up by its pid.
      expect(endTreeExactly(root)).toBe(0)
      expect(endChildTree(parent)).toBe(0)
    } finally {
      if (!exited(parent)) parent.kill()
    }
  }, 60000)

  it.runIf(process.platform === 'win32')('ends a ChildProcess it holds, with what it started (#603)', async () => {
    const childPid = join(tmp, 'held-603.pid')
    const script = `require('fs').writeFileSync(process.argv[1], String(require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).pid)); setInterval(() => {}, 1000)`
    const parent = spawn(process.execPath, ['-e', script, childPid], { env: baseEnv(), stdio: 'ignore' })
    const exited = () => parent.exitCode !== null || parent.signalCode !== null
    try {
      await vi.waitFor(() => expect(existsSync(childPid) && Number(readFileSync(childPid, 'utf8')) > 0).toBe(true), { timeout: 15000, interval: 100 })
      const [child] = identify([Number(readFileSync(childPid, 'utf8'))])
      expect(endChildTree(parent)).toBe(2)
      await vi.waitFor(() => expect(exited()).toBe(true), { timeout: 15000, interval: 100 })
      expect(stillSame([child])).toEqual([])
    } finally {
      if (!exited()) parent.kill()
    }
  }, 60000)
})

// HI-1453: a test copy of Combwork that outlived its suite (12 h, its runner gone). Each copy is recorded as it starts, and
// the runner ends those still running as the processes recorded (pid and start time): nothing else, never by name or by a
// command line (the Assistant's design call in round 3), never another process given the pid since. What only looks
// like a copy is listed for a person. The real processes: the harnessleftovers e2e.
describe("a suite's test copies of Combwork (HI-1453)", () => {
  type Copy = { pid: number; started: number; profile?: string | null }
  const { COPIES_FILE, recordCopy, recordedCopies, copiesIn, lookLikeCopies, launchedCopy } = req('./e2e/folderProcesses.cjs') as {
    COPIES_FILE: string
    recordCopy: (dir: string, copy: Copy) => void
    recordedCopies: (dir: string, depth?: number) => Copy[]
    copiesIn: (list: Proc[], copies: Copy[]) => Proc[]
    lookLikeCopies: (list: Proc[], folders: string[]) => Proc[]
    launchedCopy: (list: Proc[], launcher: number, from: number) => Proc | null
  }
  const lane = 'C:\\t\\combwork-test\\e2e\\lanes\\1'

  it('are read back from the folder and its own (a nested runner), a line cut short or without a start time skipped', () => {
    const dir = tempDir('cw-copies-')
    recordCopy(dir, { pid: 10, started: 1500, profile: join(dir, 'p') })
    mkdirSync(join(dir, 'suite', 'nested', 'inner'), { recursive: true })
    recordCopy(join(dir, 'suite', 'nested', 'inner'), { pid: 11, started: 3500 })
    writeFileSync(join(dir, 'suite', COPIES_FILE), '{"pid": 13, "from": 1000, "to": 2000}\n{"pid": 12, "sta\n')
    expect(recordedCopies(dir).map((c) => c.pid).sort()).toEqual([10, 11])
    expect(recordedCopies(dir, 1).map((c) => c.pid)).toEqual([10])
  })

  it('are the processes with their pid and start time, never a process given the pid since, however soon', () => {
    const list: Proc[] = [
      { pid: 10, commandLine: 'electron.exe .', started: 1500 },
      // The recorded copy (started 1500) has ended, and its pid went to another process 2 ms after: never it.
      { pid: 42, commandLine: 'node unrelated.js', started: 1502 },
      { pid: 12, commandLine: 'electron.exe .', started: 2601 }
    ]
    const copies = [
      { pid: 10, started: 1500 },
      { pid: 42, started: 1500 },
      // 1 ms apart: how the CIM and .NET start times round (endExactly's tolerance).
      { pid: 12, started: 2600 }
    ]
    expect(copiesIn(list, copies).map((p) => p.pid)).toEqual([10, 12])
  })

  it("the one recorded is the launcher shell's child started since, found by the process tree alone (no command line)", () => {
    const list: Proc[] = [
      { pid: 5, parent: 1, commandLine: '', started: 1000 },
      // A child from before the shell started (a parent id reused): not its.
      { pid: 6, parent: 5, commandLine: '', started: 900 },
      { pid: 8, parent: 5, commandLine: '', started: 1020 }
    ]
    expect(launchedCopy(list, 5, 1000)?.pid).toBe(8)
    // No shell in between: the launcher itself.
    expect(launchedCopy([{ pid: 9, parent: 1, commandLine: '', started: 2000 }], 9, 1990)?.pid).toBe(9)
    // The launcher's pid naming a process older than the launch (it ended, the pid was reused): nothing recorded.
    expect(launchedCopy([{ pid: 5, parent: 1, commandLine: '', started: 500 }, { pid: 8, parent: 5, commandLine: '', started: 1020 }], 5, 1000)).toBeNull()
    expect(launchedCopy([], 5, 1000)).toBeNull()
  })

  // HR5's round 3: the launcher (Playwright's shell) exiting and its pid going to another process before the background
  // listing returns. Trusted only while Node shows no exit of the launcher, checked after the listing (round 4's design).
  describe('recorded only while the launcher is still the process Node holds (recordMainProcess)', () => {
    const { recordMainProcess } = req('./e2e/folderProcesses.cjs') as {
      recordMainProcess: (dir: string, launcher: unknown, from: number, profile: string | null, list: () => Promise<Proc[]>) => Promise<void>
    }
    type Launcher = EventEmitter & { pid: number; exitCode: number | null; signalCode: string | null }
    const launcherOf = (pid: number): Launcher => Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null })
    /** Node's exit as it comes: exitCode set first, then 'exit'. */
    const exit = (l: Launcher) => {
      l.exitCode = 0
      l.emit('exit', 0, null)
    }
    const deferred = () => {
      let resolve!: (list: Proc[]) => void
      let reject!: (e: Error) => void
      const promise = new Promise<Proc[]>((res, rej) => ((resolve = res), (reject = rej)))
      return { promise, resolve, reject }
    }
    const recorded = (dir: string) => (existsSync(join(dir, COPIES_FILE)) ? readFileSync(join(dir, COPIES_FILE), 'utf8') : '')
    // The shell (pid 42, started 1000) and its Electron (8, started 1020).
    const shellNow: Proc[] = [
      { pid: 42, parent: 1, commandLine: '', started: 1000 },
      { pid: 8, parent: 42, commandLine: '', started: 1020 }
    ]
    // The shell has exited and its pid went to another program (started 2500), which has a child of its own.
    const reused: Proc[] = [
      { pid: 42, parent: 1, commandLine: 'user-app.exe', started: 2500 },
      { pid: 77, parent: 42, commandLine: 'user-app-helper.exe', started: 2600 }
    ]

    it.runIf(process.platform === 'win32')("the launcher's child, by its pid and start time, while the launcher runs; the exit listener removed", async () => {
      const dir = tempDir('cw-record-')
      const l = launcherOf(42)
      const d = deferred()
      const done = recordMainProcess(dir, l, 1000, 'p', () => d.promise)
      expect(l.listenerCount('exit')).toBe(1)
      d.resolve(shellNow)
      await done
      expect(recorded(dir)).toBe(`${JSON.stringify({ pid: 8, started: 1020, profile: 'p' })}\n`)
      expect(l.listenerCount('exit')).toBe(0)
    })

    it.runIf(process.platform === 'win32')('nothing, when the launcher exits while the listing is under way, its pid now a later process with a child', async () => {
      const dir = tempDir('cw-record-')
      const l = launcherOf(42)
      const d = deferred()
      const done = recordMainProcess(dir, l, 1000, 'p', () => d.promise)
      exit(l)
      d.resolve(reused)
      await done
      expect(recorded(dir)).toBe('')
      expect(l.listenerCount('exit')).toBe(0)
      // Its 'exit' alone, before Node's exitCode is seen, is enough too.
      const l2 = launcherOf(42)
      const d2 = deferred()
      const done2 = recordMainProcess(dir, l2, 1000, 'p', () => d2.promise)
      l2.emit('exit', 0, null)
      d2.resolve(reused)
      await done2
      expect(recorded(dir)).toBe('')
    })

    it.runIf(process.platform === 'win32')('nothing, when the launcher had exited already, is missing, or the listing fails', async () => {
      const dir = tempDir('cw-record-')
      let listed = 0
      const list = async () => (listed++, shellNow)
      const gone = launcherOf(42)
      gone.exitCode = 1
      await recordMainProcess(dir, gone, 1000, 'p', list)
      await recordMainProcess(dir, null, 1000, 'p', list)
      await recordMainProcess(dir, { pid: undefined }, 1000, 'p', list)
      expect(listed).toBe(0)
      const l = launcherOf(42)
      await expect(recordMainProcess(dir, l, 1000, 'p', async () => Promise.reject(new Error('powershell failed')))).rejects.toThrow('powershell failed')
      expect(l.listenerCount('exit')).toBe(0)
      expect(recorded(dir)).toBe('')
    })
  })

  it('what only looks like a copy in a folder (for the report, never ended) has a profile flag and names the folder', () => {
    const list: Proc[] = [
      { pid: 1, commandLine: `"electron.exe" "--combwork-test-profile=${lane}\\a\\profile"`, started: 1 },
      { pid: 2, commandLine: `photos.exe ${lane}\\x\\shot.png`, started: 1 },
      { pid: 3, commandLine: `electron.exe --combwork-test-profile=${lane}0\\x\\profile`, started: 1 }
    ]
    expect(lookLikeCopies(list, [lane]).map((p) => p.pid)).toEqual([1])
  })
})

// #603: a remembered pid ended after its process had gone can be another's by then (a concurrent run's Vitest worker,
// which exits with code 1); taskkill /T follows parent ids that may be stale. Test tooling ends processes by identity
// (folderProcesses.cjs: identify, stillSame, endExactly, endTreeExactly, stopProcessesIn) or through a handle it holds
// (a ChildProcess's kill()). A line that must use a pid says why, with "its handle is held".
describe('test tooling ends processes by identity, never by a remembered pid (#603)', () => {
  const root = join(__dirname, '..')
  const files = (dir: string): string[] =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? (['node_modules', 'fixtures'].includes(e.name) ? [] : files(join(dir, e.name))) : /\.(c|m)?[jt]s$/.test(e.name) ? [join(dir, e.name)] : []
    )
  // And in Combwork itself: hive-progress ends its command's tree by identity too (wrapper.ts endTree, #655).
  it('no process.kill on a pid (other than signal 0) and no taskkill, in tests, scripts or src', () => {
    const found: string[] = []
    for (const f of [...files('tests'), ...files('scripts'), ...files('src')]) {
      readFileSync(join(root, f), 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          const code = line.replace(/\/\/.*$/, '')
          if (/^\s*\*/.test(line) || /its handle is held/.test(line)) return
          if (/process\.kill\((?![^)]*,\s*0\))/.test(code) || /['"`]taskkill/.test(code)) found.push(`${f}:${i + 1}: ${line.trim()}`)
        })
    }
    expect(found).toEqual([])
  })
})
