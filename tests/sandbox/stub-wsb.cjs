// Tests only (tests/sandboxChecks.test.ts): stands in for wsb.exe, as WSB_STUB, for the Sandbox checks' own wsb.cjs.
// Its state is the JSON file WSB_STUB_STATE, which the fake server (fake-server.cjs) shares:
//   { sandboxes: [id], calls: [[verb, ...args, by]], fail: { stop: n } }
// fail.stop: how many stops fail from now on (-1: every one). Only list and stop are needed: the server starts them.
const fs = require('fs')

const file = process.env.WSB_STUB_STATE
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
const args = process.argv.slice(2).filter(a => a !== '--raw')
const save = () => fs.writeFileSync(file, JSON.stringify(state))
state.calls ||= []
state.sandboxes ||= []
state.fail ||= {}
const verb = args[0]
if (verb === 'list') {
  state.calls.push(['list', 'runner'])
  save()
  process.stdout.write(JSON.stringify({ WindowsSandboxEnvironments: state.sandboxes.map(Id => ({ Id })) }))
} else if (verb === 'stop') {
  const id = args[args.indexOf('--id') + 1]
  state.calls.push(['stop', id, 'runner'])
  if (state.fail.stop) {
    if (state.fail.stop > 0) state.fail.stop--
    save()
    process.stderr.write('stop failed (stub)')
    process.exitCode = 1
  } else {
    state.sandboxes = state.sandboxes.filter(s => s !== id)
    save()
  }
} else {
  process.stderr.write(`stub-wsb: unexpected ${args.join(' ')}`)
  process.exitCode = 2
}
