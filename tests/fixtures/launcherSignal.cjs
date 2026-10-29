// HI-2042's test (tests/queueRunner.test.ts), given to the queue's launcher by NODE_OPTIONS=--require in the run's own
// environment: in the launcher only (HIVE_QUEUE_LAUNCH is set while it loads, and taken out before its command starts,
// so the command, which inherits NODE_OPTIONS, does nothing here), the first command it starts is ended by a signal
// through its own handle once it is running ('spawn'): the one way Node on Windows reports a signal for a child.
if (process.env.HIVE_QUEUE_LAUNCH) {
  const cp = require('child_process')
  const spawn = cp.spawn
  let done = false
  cp.spawn = function (...args) {
    const c = spawn.apply(this, args)
    if (!done) {
      done = true
      c.once('spawn', () => c.kill('SIGTERM'))
    }
    return c
  }
}
