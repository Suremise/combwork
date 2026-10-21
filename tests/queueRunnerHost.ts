// A Hive's merge queue runner in a process of its own, for tests/queueRunner.test.ts (#1360): two of these on one hive.db
// copy are two Hives on one workspace. Bundled by the test (esbuild, Electron stubbed) and run by Node; it reads one
// JSON command a line on stdin and answers each with one line on stdout: REPLY and JSON (Hive's log lines go there too).
import { createInterface } from 'readline'
import { FactStore } from '../src/main/workflow/factStore'
import { QueueRunner } from '../src/main/workflow/queueRunner'

const [file, project, root, profile, target] = process.argv.slice(2)
const store = FactStore.open(file, { project: 'project', key: 'AM' })
let runner: QueueRunner | null = null
let renew = true
const REPLY = 'queue-host: '

type Command = { id: number; op: 'acquire' | 'holds' | 'stall' | 'worktree' | 'sleeper' | 'release' }

async function run(c: Command): Promise<Record<string, unknown>> {
  switch (c.op) {
    case 'acquire': {
      const r = await QueueRunner.acquire({ store, project, target, root, profile, renewMs: 50, hooks: { renew: () => renew } })
      if (!r.ok) return { ok: false, heldBy: r.heldBy }
      runner = r.runner
      return { ok: true, lease: runner.lease, folder: runner.folder() }
    }
    case 'holds':
      return { holds: runner?.holds() ?? false }
    case 'stall':
      // A Hive that stops renewing (stalled), however long: its lease is noted as last seen then.
      renew = false
      return {}
    case 'worktree': {
      // The queue's first test merge makes its folder (MergeQueue.testMerge): the same command, through the runner.
      const r = await runner!.git(project, ['worktree', 'add', '--detach', runner!.folder(), 'HEAD'])
      return { ok: r.ok, err: r.err }
    }
    case 'sleeper': {
      // A check that outlives its Hive, with a process of its own, both sleeping. Detached: Node's other children are in
      // its job object, which Windows ends with it; these stand for what breaks away from it (a detached server, a shell's).
      const script = "const k = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true }); console.log(k.pid); setInterval(() => {}, 1000)"
      const child = await runner!.spawn('check', process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], detached: true })
      const grandchild = await new Promise<number>((res) => child.stdout!.once('data', (d) => res(Number(String(d).trim()))))
      return { pid: child.pid, grandchild }
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
