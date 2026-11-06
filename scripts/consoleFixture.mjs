// Turns a developer console recording into a test fixture (#638): `npm run console-fixture -- <recording.jsonl> <fixture.json>`.
// The recording is one Combwork wrote (Developer Console → Record, in %APPDATA%\Combwork\console-recordings), without text: one
// with prompt and reply text is refused. The fixture keeps what the CLI sent and what Combwork made of it (hooks, status
// lines, transcript reads, terminal markers, launch and exit), in order, with every absolute path as "<path>", and the
// CLI's and Combwork's versions. Contract suites compare what a CLI sends now with it (tests/fixtures/console/README.md).
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { recordingToFixture } from '../src/shared/consoleFixtures.mts'

const [from, to] = process.argv.slice(2)
if (!from || !to) {
  console.error('Usage: npm run console-fixture -- <recording.jsonl> <fixture.json>')
  process.exit(2)
}
let fixture
try {
  fixture = recordingToFixture(readFileSync(from, 'utf8'))
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
}
const text = `${JSON.stringify(fixture, null, 2)}\n`
// A fixture is committed: nothing of this machine's user may be in it.
const own = [homedir(), userInfo().username].filter((x) => x && x.length > 2)
const found = own.find((x) => text.toLowerCase().includes(x.toLowerCase()))
if (found) {
  console.error(`The fixture still names this machine's user (${found === homedir() ? 'the home folder' : 'the user name'}): not written.`)
  process.exit(1)
}
writeFileSync(to, text)
const kinds = [...new Set(fixture.events.map((e) => `${e.kind} ${e.name}`))]
console.log(`${to}: ${fixture.events.length} events from ${fixture.provider ?? 'an unknown CLI'} ${fixture.cli ?? ''} (${kinds.length} kinds: ${kinds.slice(0, 12).join(', ')}${kinds.length > 12 ? ', …' : ''})`)
