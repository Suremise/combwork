// A Combwork's copies store in a process of its own, for tests/copies.test.ts (#1435): two of these on one combwork.db copy are
// two Hives leasing at once. Bundled by the test (esbuild, Electron stubbed) and run by Node; it says `ready`, then takes
// a copy for the request on its first line of input and answers with one line: REPLY and JSON.
import { createInterface } from 'readline'
import { CopyStore } from '../src/main/copies'
import { fileSlotConn } from '../src/main/slots'

const [file, project, dir] = process.argv.slice(2)
const store = new CopyStore(fileSlotConn(file), project)
const REPLY = 'copies-host: '
console.log(`${REPLY}${JSON.stringify({ ready: true })}`)
createInterface({ input: process.stdin }).once('line', (line) => {
  void store
    .take(JSON.parse(line), { size: 1, dir, token: `o-${process.pid}`, holder: { pid: process.pid, started: 1 }, profile: `p${process.pid}` })
    .then(
      (r) => console.log(`${REPLY}${JSON.stringify(r)}`),
      (e: Error) => console.log(`${REPLY}${JSON.stringify({ error: e.message })}`)
    )
    .finally(() => store.conn.close())
})
