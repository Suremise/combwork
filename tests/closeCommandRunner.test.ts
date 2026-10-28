// HI-1368's close command runner and runs: the output kept is bounded (the last 64 KB, however much the command writes),
// written whole and at most every 250 ms; the command never blocks on its output; a real command writing megabytes is
// followed to its end with the tail never over its bound; Hive reads only the end of the tail; what runs, with its
// placeholders filled, and what doesn't (none, a test copy of Hive, an update restart without the tick); the runs kept,
// never one still running.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { EventEmitter } from 'events'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { runJob, TailRing, TAIL_BYTES, WRITE_MS, type RunnerDeps } from '../src/main/closeCommand/runner'
import { planRun, pruneRuns, runFolderName, runPrefix, runsCloseCommands, tailLines, READ_TAIL_BYTES, PANEL_LINES, LINE_CHARS } from '../src/main/closeCommand/runs'
import { fillCloseCommand } from '../src/shared/closeCommand'

const base = tempDir('hive-close-runner-')
afterAll(() => rmSync(base, { recursive: true, force: true }))
let n = 0
const folder = (): string => {
  const d = join(base, `run-${++n}`)
  mkdirSync(d, { recursive: true })
  return d
}

describe('the tail ring', () => {
  it('keeps exactly the last bytes, however they come', () => {
    const r = new TailRing(10)
    r.push(Buffer.from('abcdef'))
    r.push(Buffer.from('ghijkl'))
    expect(r.bytes().toString()).toBe('cdefghijkl')
    expect([r.seen, r.dropped]).toEqual([12, true])
    r.push(Buffer.from('0123456789ABC'))
    expect(r.bytes().toString()).toBe('3456789ABC')
  })

  it('10 MB in chunks: the last 64 KB, the count of all of it', () => {
    const r = new TailRing()
    const chunk = Buffer.alloc(4096, 'x')
    for (let i = 0; i < 2560; i++) r.push(chunk)
    r.push(Buffer.from('END'))
    const b = r.bytes()
    expect(b.length).toBe(TAIL_BYTES)
    expect(b.subarray(-3).toString()).toBe('END')
    expect(r.seen).toBe(2560 * 4096 + 3)
  })
})

/** A command stand-in: emits output and its end as the test says. */
function fakeChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number } {
  return Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 4242 })
}

describe('the runner, its command stood in for', () => {
  const deps = (child: ReturnType<typeof fakeChild>, written: { file: string; data: string }[]): RunnerDeps & { fire: () => void } => {
    let pending: (() => void) | null = null
    return {
      spawn: vi.fn(() => child as never),
      write: (file, data) => written.push({ file, data: data.toString() }),
      now: () => new Date('2026-10-28T12:00:00.000Z'),
      pid: 99,
      setTimer: (fn) => ((pending = fn), 1),
      clearTimer: () => (pending = null),
      fire: () => {
        const p = pending
        pending = null
        p?.()
      }
    }
  }

  it('writes the status at once, then at most once per timer however much output comes, and the end at once', async () => {
    const child = fakeChild()
    const written: { file: string; data: string }[] = []
    const d = deps(child, written)
    const done = runJob('D:\\run', { command: 'echo hi', cwd: 'D:\\ws' }, d, { ComSpec: 'C:\\cmd.exe', ELECTRON_RUN_AS_NODE: '1', PATH: 'p' })
    const statuses = () => written.filter((w) => w.file.endsWith('status.json')).map((w) => JSON.parse(w.data))
    expect(statuses()).toHaveLength(1)
    // The command's own environment: not the runner's way of running as Node.
    expect((d.spawn as ReturnType<typeof vi.fn>).mock.calls[0][2].env).toEqual({ ComSpec: 'C:\\cmd.exe', PATH: 'p' })
    for (let i = 0; i < 100; i++) child.stdout.emit('data', Buffer.from(`line ${i}\n`))
    child.stderr.emit('data', Buffer.from('oops\n'))
    expect(statuses()).toHaveLength(1)
    d.fire()
    expect(statuses().at(-1)).toMatchObject({ state: 'running', commandPid: 4242, runnerPid: 99 })
    expect(written.filter((w) => w.file.endsWith('tail.txt')).at(-1)!.data.endsWith('line 99\noops\n')).toBe(true)
    child.emit('close', 3, null)
    await expect(done).resolves.toMatchObject({ state: 'exited', exitCode: 3 })
    expect(statuses().at(-1)).toMatchObject({ state: 'exited', exitCode: 3, endedAt: '2026-10-28T12:00:00.000Z' })
  })

  it("a command that can't start: spawnFailed, with why", async () => {
    const child = fakeChild()
    const written: { file: string; data: string }[] = []
    const done = runJob('D:\\run', { command: 'nope', cwd: 'D:\\gone' }, deps(child, written))
    child.emit('error', new Error('spawn ENOENT'))
    await expect(done).resolves.toMatchObject({ state: 'spawnFailed', error: 'spawn ENOENT' })
  })
})

describe('the runner, with a real command', () => {
  it('a command writing about 5 MB as fast as it can: followed to its end, the tail never over its bound, the command never held up', async () => {
    const dir = folder()
    const marker = join(dir, 'finished.txt')
    // 5,000 lines of 1 KB, then a marker of its own: it ends only if its output never blocked it.
    const script = `const l='y'.repeat(1023)+'\\n';for(let i=0;i<5000;i++)process.stdout.write(l);process.stderr.write('last line\\n');require('fs').writeFileSync(${JSON.stringify(marker)},'done')`
    const scriptFile = join(dir, 'chatty.js')
    writeFileSync(scriptFile, script)
    let biggest = 0
    const deps = { ...(await import('../src/main/closeCommand/runner')).nodeDeps() }
    const write = deps.write
    deps.write = (file, data) => {
      write(file, data)
      if (file.endsWith('tail.txt')) biggest = Math.max(biggest, statSync(file).size)
    }
    const status = await runJob(dir, { command: `"${process.execPath}" "${scriptFile}"`, cwd: dir }, deps)
    expect(status).toMatchObject({ state: 'exited', exitCode: 0, dropped: true })
    expect(status.bytesSeen).toBeGreaterThan(5_000_000)
    expect(existsSync(marker)).toBe(true)
    expect(biggest).toBeLessThanOrEqual(TAIL_BYTES)
    expect(statSync(join(dir, 'tail.txt')).size).toBe(TAIL_BYTES)
    expect(readFileSync(join(dir, 'tail.txt'), 'utf8').endsWith('last line\n')).toBe(true)
    expect(WRITE_MS).toBe(250)
  }, 60_000)
})

describe('what Hive reads of a run', () => {
  it('the last lines, from the end of the tail only, each cut short', async () => {
    const dir = folder()
    const file = join(dir, 'tail.txt')
    writeFileSync(file, `${'head\n'.repeat(10_000)}${'z'.repeat(1000)}\r\n${Array.from({ length: 12 }, (_, i) => `out ${i}`).join('\n')}\n\n`)
    const lines = await tailLines(file)
    expect(lines).toHaveLength(PANEL_LINES)
    expect(lines.at(-1)).toBe('out 11')
    expect(READ_TAIL_BYTES).toBeLessThan(statSync(file).size)
    writeFileSync(file, `${'w'.repeat(1000)}\n`)
    const [long] = await tailLines(file)
    expect(long.length).toBe(LINE_CHARS)
    expect(long.endsWith('…')).toBe(true)
    await expect(tailLines(join(dir, 'none.txt'))).resolves.toEqual([])
  })
})

describe('what runs', () => {
  it('fills the placeholders as written; an unknown one, or one with no value, stays', () => {
    expect(fillCloseCommand('replica run hive --workspace "{workspace}" --name {name} --why {reason} {other}', { workspace: 'D:\\My Work', name: 'My Work', reason: 'switch' })).toBe('replica run hive --workspace "D:\\My Work" --name My Work --why switch {other}')
    expect(fillCloseCommand('backup {workspace} {reason}', { reason: 'quit' })).toBe('backup {workspace} quit')
  })

  it('none set, a test copy, an update restart without the tick: nothing; with the tick it runs, its reason update', () => {
    const on = { runs: true }
    expect(planRun(undefined, 'window', {}, on)).toEqual({ skip: 'none' })
    expect(planRun({ command: '   ', onUpdate: true }, 'window', {}, on)).toEqual({ skip: 'none' })
    expect(planRun({ command: 'b {name}', onUpdate: false }, 'window', { workspace: 'D:\\ws\\Work' }, { runs: false })).toEqual({ skip: 'test' })
    expect(planRun({ command: 'b {name}', onUpdate: false }, 'update', { workspace: 'D:\\ws\\Work' }, on)).toEqual({ skip: 'update' })
    expect(planRun({ command: 'b {name} {reason}', onUpdate: true }, 'update', { workspace: 'D:\\ws\\Work' }, on)).toEqual({ command: 'b Work update' })
    expect(planRun({ command: ' b "{workspace}" {reason} ', onUpdate: false }, 'quit', { workspace: 'D:\\ws\\Work' }, on)).toEqual({ command: 'b "D:\\ws\\Work" quit' })
  })

  it("a test copy never runs them, shown or quiet; only an unpackaged build's seam does", () => {
    expect(runsCloseCommands({}, true)).toBe(true)
    expect(runsCloseCommands({}, false)).toBe(true)
    // A test profile, quiet or shown (HIVE_TEST_QUIET=0 is still a test copy).
    expect(runsCloseCommands({ HIVE_USER_DATA: 'x' }, false)).toBe(false)
    expect(runsCloseCommands({ HIVE_USER_DATA: 'x', HIVE_TEST_QUIET: '0' }, false)).toBe(false)
    expect(runsCloseCommands({ HIVE_TEST_QUIET: '1' }, true)).toBe(false)
    // The seam: an unpackaged build only.
    expect(runsCloseCommands({ HIVE_USER_DATA: 'x', HIVE_TEST_RUN_ON_CLOSE: '1' }, false)).toBe(true)
    expect(runsCloseCommands({ HIVE_TEST_QUIET: '1', HIVE_TEST_RUN_ON_CLOSE: '1' }, true)).toBe(false)
  })
})

describe('the runs kept', () => {
  it('the newest five per name, never one still running, and none of another name', async () => {
    const root = folder()
    const made = (name: string, i: number, status: object | null): string => {
      const f = runFolderName('workspace', name, new Date(Date.UTC(2026, 9, 28, 12, 0, i)))
      mkdirSync(join(root, f), { recursive: true })
      if (status) writeFileSync(join(root, f, 'status.json'), JSON.stringify(status))
      return f
    }
    const ended = { state: 'exited', runnerPid: 1 }
    // The oldest still running (its runner alive: this test's own process); seven ended after it.
    const running = made('Work', 0, { state: 'running', runnerPid: process.pid })
    const old = Array.from({ length: 7 }, (_, i) => made('Work', i + 1, ended))
    const other = made('Work-2', 1, ended)
    const quit = runFolderName('quit', null, new Date())
    mkdirSync(join(root, quit))
    await pruneRuns(root, runPrefix('workspace', 'Work'))
    expect(readdirSync(root).sort()).toEqual([running, ...old.slice(2), other, quit].sort())
  })
})
