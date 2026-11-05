// HI-2079's test (tests/queueGitHost.test.ts), given to the queue's git host by NODE_OPTIONS=--require in the host's own
// environment: in the host only (CW_GIT_HOST_TEST_SIGNAL is in its environment, never in a request's, which is what
// its commands get), the first command it starts is ended by a signal through its own handle once it is running
// ('spawn'): the one way Node on Windows reports a signal for a child.
if (process.env.CW_GIT_HOST_TEST_SIGNAL) {
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
