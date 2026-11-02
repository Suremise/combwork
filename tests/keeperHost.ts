// A Hive's process helper in a process of its own, for tests/keeperKilled.test.ts (HI-2314): the real JobHost, started
// as Hive starts it, configured as the keeper for Hive `hive` in folder `dir` (HI-2055), holding launch `run`'s job
// with process `member` in it. Bundled by the test (esbuild) and run by Node; once set up it prints one line,
// "ready <helper's pid> <helper's identity>", and waits to be ended from outside, as a crash would end Hive.
import { JobHost } from '../src/main/processSupervisor'

const [hive, dir, run, member] = process.argv.slice(2)
const host = new JobHost({
  waitMs: () => 30_000,
  testMode: () => '',
  log: { warn: (msg) => console.error(msg) },
  onJoined: () => undefined,
  onLost: (why) => console.error(`lost: ${why}`),
  onFailed: (why) => console.error(`failed: ${JSON.stringify(why)}`)
})

;(async () => {
  if (!(await host.ensure())) throw new Error('the helper did not start')
  const helper = await host.request('keeper', hive, Buffer.from(dir, 'utf8').toString('base64url'))
  const added = await host.request('add', run, Number(member))
  if (typeof helper !== 'string' || added !== 'ok') throw new Error(`not set up: ${JSON.stringify({ helper, added })}`)
  console.log(`ready ${host.pid} ${helper}`)
  setInterval(() => undefined, 60_000)
})().catch((e) => {
  console.error((e as Error).message)
  process.exit(1)
})
