// A list of the user's commands run by one runner (HI-1954, src/main/closeCommand/listRunner.ts; design HI-1954/s19 §2):
// steps in order, a failure waiting while watched for Rerun, Skip it and continue or Stop here (controls bound to the
// step and attempt, each taken once), Don't wait at any time (never rerunning the step under way), the rule when nobody
// watches (a needed step stops the list, another goes on), and a placeholder or folder it can't use failing the step
// before anything runs. The commands are stood in for; the run's folder is in memory.
import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import { runList, OBSERVER_STALE_MS, type ListDeps, type ListJob, type ListStatus } from '../src/main/closeCommand/listRunner'

const DIR = 'D:\\run'
/** The longest a wait here waits for what it expects: a bound for a hung run, never how long it should take. */
const HUNG_MS = 10_000

/** A stand-in for the run's folder and the commands: each spawn exits with the next of `codes` once the test lets it. */
function world(codes: number[], opts: { observer?: boolean } = {}) {
  const files = new Map<string, { data: string; mtime: number }>()
  const dirs = new Set(['D:\\ws', 'D:\\home'])
  const spawned: { command: string; cwd: string }[] = []
  let clock = Date.parse('2026-10-29T10:00:00.000Z')
  const children: EventEmitter[] = []
  const deps: ListDeps = {
    spawn: vi.fn((_cmd: string, args: string[], o: { cwd?: string }) => {
      const child = Object.assign(new EventEmitter(), { pid: 1000 + spawned.length, stdout: new EventEmitter(), stderr: new EventEmitter() })
      spawned.push({ command: args.at(-1)!.replace(/^"|"$/g, ''), cwd: String(o.cwd) })
      const code = codes.shift() ?? 0
      children.push(child)
      setTimeout(() => child.emit('close', code, null), 0)
      return child as never
    }) as unknown as ListDeps['spawn'],
    write: (file, data) => files.set(file, { data: data.toString(), mtime: clock }),
    now: () => new Date(clock),
    pid: 77,
    setTimer: (fn) => setTimeout(fn, 0),
    clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
    exists: (p) => files.has(p),
    read: (p) => files.get(p)?.data ?? null,
    take: (p) => files.delete(p),
    mtime: (p) => files.get(p)?.mtime ?? null,
    isDir: (p) => dirs.has(p),
    mkdir: () => undefined
  }
  const status = (): ListStatus => JSON.parse(files.get(`${DIR}\\status.json`)!.data)
  const say = (name: string, c: object): void => void files.set(`${DIR}\\${name}`, { data: JSON.stringify(c), mtime: clock })
  if (opts.observer !== false) say('observer', {})
  return { deps, files, dirs, spawned, status, say, tick: (ms: number) => (clock += ms) }
}

const step = (name: string, command: string, needed = false, folder = '') => ({ name, command, folder, needed })
const job = (steps: ReturnType<typeof step>[], values: ListJob['values'] = { workspace: 'D:\\ws', name: 'ws', reason: 'open' }): ListJob => ({ list: true, steps, values, home: 'D:\\home' })
const until = (fn: () => void): Promise<void> => vi.waitFor(fn, { timeout: HUNG_MS, interval: 5 })

describe('a list run by one runner', () => {
  it('runs each step in order, in the workspace folder, its placeholders filled, then ends done', async () => {
    const w = world([0, 0])
    const r = await runList(DIR, job([step('A', 'a {name}'), step('B', 'b "{workspace}"')]), w.deps, {})
    expect(w.spawned).toEqual([{ command: 'a ws', cwd: 'D:\\ws' }, { command: 'b "D:\\ws"', cwd: 'D:\\ws' }])
    expect(r).toMatchObject({ state: 'exited', ended: 'done', steps: [{ state: 'ok', attempt: 1 }, { state: 'ok', attempt: 1 }] })
  })

  it('a failure waits for its choice; Rerun runs it again as the next attempt; a stale or repeated control does nothing', async () => {
    const w = world([1, 2, 0, 0])
    const done = runList(DIR, job([step('A', 'a'), step('B', 'b')]), w.deps, {})
    await until(() => expect(w.status().awaiting).toEqual({ step: 0, attempt: 1 }))
    w.say('control-0-1.json', { action: 'rerun' })
    await until(() => expect(w.status().awaiting).toEqual({ step: 0, attempt: 2 }))
    // The first attempt's control again, or a second one for it: not this attempt's, so nothing happens.
    w.say('control-0-1.json', { action: 'stop' })
    expect(w.spawned).toHaveLength(2)
    w.say('control-0-2.json', { action: 'rerun' })
    const r = await done
    expect(w.spawned.map((s) => s.command)).toEqual(['a', 'a', 'a', 'b'])
    expect(r).toMatchObject({ ended: 'done', steps: [{ state: 'ok', attempt: 3 }, { state: 'ok' }] })
  })

  it('Skip it and continue runs the rest; Stop here skips the rest and ends stopped', async () => {
    const skip = world([1, 0])
    const d1 = runList(DIR, job([step('A', 'a', true), step('B', 'b')]), skip.deps, {})
    await until(() => expect(skip.status().awaiting).toEqual({ step: 0, attempt: 1 }))
    skip.say('control-0-1.json', { action: 'skip' })
    expect(await d1).toMatchObject({ ended: 'done', steps: [{ state: 'failed', exitCode: 1 }, { state: 'ok' }] })
    const stop = world([1, 0])
    const d2 = runList(DIR, job([step('A', 'a'), step('B', 'b'), step('C', 'c')]), stop.deps, {})
    await until(() => expect(stop.status().awaiting).toEqual({ step: 0, attempt: 1 }))
    stop.say('control-0-1.json', { action: 'stop' })
    expect(await d2).toMatchObject({ ended: 'stopped', steps: [{ state: 'failed' }, { state: 'skipped' }, { state: 'skipped' }] })
    expect(stop.spawned).toHaveLength(1)
  })

  it("Don't wait while a step runs: it isn't run again; after that, a needed step failing stops the list and another goes on", async () => {
    const w = world([1, 1, 0])
    w.say('control-detach.json', { action: 'detach' })
    const r = await runList(DIR, job([step('A', 'a'), step('B', 'b', true), step('C', 'c')]), w.deps, {})
    expect(w.spawned.map((s) => s.command)).toEqual(['a', 'b'])
    expect(r).toMatchObject({ attended: false, ended: 'stopped', steps: [{ state: 'failed', attempt: 1 }, { state: 'failed', attempt: 1 }, { state: 'skipped' }] })
    expect(r.unattended).toMatch(/^B: needed/)
  })

  it("Don't wait while a failure waits for its choice: settled by the rule at once", async () => {
    const w = world([1, 0])
    const done = runList(DIR, job([step('A', 'a'), step('B', 'b')]), w.deps, {})
    await until(() => expect(w.status().awaiting).toEqual({ step: 0, attempt: 1 }))
    w.say('control-detach.json', { action: 'detach' })
    expect(await done).toMatchObject({ attended: false, ended: 'done', steps: [{ state: 'failed' }, { state: 'ok' }] })
  })

  it('nobody watching (the observer stale) while a failure waits: the rule settles it', async () => {
    const w = world([1, 0])
    const done = runList(DIR, job([step('A', 'a', true), step('B', 'b')]), w.deps, {})
    await until(() => expect(w.status().awaiting).toEqual({ step: 0, attempt: 1 }))
    w.tick(OBSERVER_STALE_MS + 1)
    expect(await done).toMatchObject({ attended: false, ended: 'stopped', steps: [{ state: 'failed' }, { state: 'skipped' }] })
  })

  it("a placeholder it can't fill, or a folder that isn't there, fails the step before anything runs; Rerun with values now runs it", async () => {
    const w = world([0])
    const done = runList(DIR, job([step('A', 'deploy "{project:api}"'), step('B', 'b', false, 'D:\\gone')]), w.deps, {})
    await until(() => expect(w.status().awaiting).toEqual({ step: 0, attempt: 1 }))
    expect(w.status().steps[0]).toMatchObject({ state: 'failed', failure: 'placeholder', detail: '{project:api}' })
    expect(w.spawned).toHaveLength(0)
    w.say('control-0-1.json', { action: 'rerun', values: { workspace: 'D:\\ws', name: 'ws', reason: 'open', projects: { api: 'D:\\ws\\api' } } })
    await until(() => expect(w.status().awaiting).toEqual({ step: 1, attempt: 1 }))
    expect(w.spawned.map((s) => s.command)).toEqual(['deploy "D:\\ws\\api"'])
    expect(w.status().steps[1]).toMatchObject({ state: 'failed', failure: 'folder', detail: 'D:\\gone' })
    w.say('control-1-1.json', { action: 'skip' })
    expect(await done).toMatchObject({ ended: 'done' })
  })
})
