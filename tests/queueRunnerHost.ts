// A Combwork's merge queue runner in a process of its own, for tests/queueRunner.test.ts (#1360): two or three of these on
// one hive.db copy are Hives on one workspace. Bundled by the test (esbuild, Electron stubbed) and run by Node; it reads
// one JSON command a line on stdin and answers each with one line on stdout: REPLY and JSON (Combwork's log lines go there
// too). Its seams come from its environment: QR_LINGER (its job's supervisor outlives it), QR_STALL_SETTLE (a takeover
// that never gets past its first step); and from commands: `block` (its board writes wait for ever, as behind a busy
// board), `other` (a second target's acquire that fails part way).
import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { FactStore } from '../src/main/workflow/factStore'
import { QueueRunner } from '../src/main/workflow/queueRunner'

const [file, project, root, profile, target] = process.argv.slice(2)
const store = FactStore.open(file, { project: 'project', key: 'AM' })
let runner: QueueRunner | null = null
let renew = true
let blocked = false
/** Its board writes, as the app's boardWrite would run them: waiting for ever once `block` was asked (a busy board). */
const locked = <T>(fn: () => T): Promise<T> => (blocked ? new Promise<T>(() => undefined) : Promise.resolve().then(fn))
const REPLY = 'queue-host: '

type Command = { id: number; op: 'acquire' | 'holds' | 'stall' | 'worktree' | 'sleeper' | 'server' | 'follow' | 'block' | 'other' | 'release' }

/** A check (`node -e`) that starts a detached process of its own and prints both pids; `stay`: it runs on, else it exits. */
const check = (stay: boolean): string =>
  `const k = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true }); k.unref(); console.log(process.pid + ' ' + k.pid); ${stay ? 'setInterval(() => {}, 1000)' : ''}`

async function run(c: Command): Promise<Record<string, unknown>> {
  switch (c.op) {
    case 'acquire': {
      const r = await QueueRunner.acquire({
        store,
        project,
        target,
        root,
        profile,
        locked,
        renewMs: 50,
        hooks: { renew: () => renew, lingeringJob: !!process.env.QR_LINGER, ...(process.env.QR_STALL_SETTLE ? { beforeSettle: () => new Promise<void>(() => undefined) } : {}) }
      })
      if (!r.ok) return { ok: false, heldBy: r.heldBy, problem: r.problem }
      runner = r.runner
      return { ok: true, lease: runner.lease, folder: runner.folder(), paused: r.paused ?? null, supervisor: runner.supervisorPid }
    }
    case 'other': {
      // Another target in this same Combwork (its supervisor shared), whose start fails part way: its folder's record.
      const set = store.setQueueFolder.bind(store)
      store.setQueueFolder = () => {
        throw new Error('disk full')
      }
      try {
        await QueueRunner.acquire({ store, project, target: 'other', root, profile, locked })
        return { failed: false }
      } catch (e) {
        return { failed: true, why: (e as Error).message }
      } finally {
        store.setQueueFolder = set
      }
    }
    case 'block':
      blocked = true
      return {}
    case 'holds':
      return { holds: runner?.holds() ?? false }
    case 'stall':
      // A Combwork that stops renewing (stalled), however long: its lease is noted as last seen then.
      renew = false
      return {}
    case 'worktree': {
      // The queue's first test merge makes its folder (MergeQueue.testMerge): the same command, through the runner.
      const r = await runner!.git(project, ['worktree', 'add', '--detach', runner!.folder(), 'HEAD'])
      return { ok: r.ok, err: r.err }
    }
    case 'sleeper':
    case 'server': {
      // sleeper: a check that runs on, with a detached child; server: a check that starts a detached server and exits.
      const child = await runner!.spawn('check', process.execPath, ['-e', check(c.op === 'sleeper')])
      const line = await new Promise<string>((res) => child.stdout!.once('data', (d) => res(String(d).trim())))
      const [checkPid, detached] = line.split(' ').map(Number)
      return { launcher: child.pid, check: checkPid, detached }
    }
    case 'follow': {
      // A process outside the job that the supervisor follows, as it does a packaged app's escaped one (the Store's
      // PowerShell's children): a detached sleeper of this host's.
      const k = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true, windowsHide: true })
      k.unref()
      return { followed: await runner!.followForTests(k.pid!), pid: k.pid }
    }
    case 'release':
      await runner?.release()
      return {}
  }
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const c = JSON.parse(line) as Command
  run(c).then(
    (r) => process.stdout.write(`${REPLY}${JSON.stringify({ id: c.id, ...r })}\n`),
    (e: Error) => process.stdout.write(`${REPLY}${JSON.stringify({ id: c.id, error: e.message })}\n`)
  )
})
rl.on('close', () => process.exit(0))
