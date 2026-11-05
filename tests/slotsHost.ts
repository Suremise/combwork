// A Combwork's slot store in a process of its own, for tests/slots.test.ts (#1429): two of these on one hive.db copy are two
// Hives lending at once. Bundled by the test (esbuild, Electron stubbed) and run by Node; it opens its connection, says
// `ready`, then takes a slot for the request on its first line of input and answers with one line: REPLY and JSON.
import { createInterface } from 'readline'
import { fileSlotConn, SlotStore } from '../src/main/slots'

const [file, project, root] = process.argv.slice(2)
const store = new SlotStore(fileSlotConn(file), project)
const REPLY = 'slots-host: '
console.log(`${REPLY}${JSON.stringify({ ready: true })}`)
createInterface({ input: process.stdin }).once('line', (line) => {
  void store
    .take(JSON.parse(line), { size: 4, root, target: 'main', token: `o-${process.pid}`, holder: { pid: process.pid, started: 1 } })
    .then(
      (r) => console.log(`${REPLY}${JSON.stringify(r)}`),
      (e: Error) => console.log(`${REPLY}${JSON.stringify({ error: e.message })}`)
    )
    .finally(() => store.conn.close())
})
