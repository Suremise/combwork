// A process an agent leaves running (fake-claude's "linger N", #507): "starter" starts a detached, hidden "linger" and
// exits, so what is left has no living parent, as a server started through a shell has; "linger" records its pid in
// the file given and stays (two minutes at most, in case a test leaves it). "app-starter" does the same with a dev copy
// of an Electron app (fake-claude's "devapp", #614): Electron's executable with Playwright's --inspect=0
// --remote-debugging-port=0 and the app's folder (devapp/main.js records its pid in the file once its window is made).
const { spawn } = require('child_process')
const fs = require('fs')
const [role, file, agent, appDir] = process.argv.slice(2)
if (role === 'app-starter') {
  const env = { ...process.env, FAKE_DEVAPP_FILE: file }
  delete env.ELECTRON_RUN_AS_NODE
  spawn(require('electron'), ['--inspect=0', '--remote-debugging-port=0', appDir], { detached: true, stdio: 'ignore', windowsHide: true, env }).unref()
  setTimeout(() => process.exit(0), 200)
} else if (role === 'starter') {
  spawn(process.execPath, [__filename, 'linger', file, agent], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  setTimeout(() => process.exit(0), 200)
} else if (role === 'unnamed-starter') {
  // fake-claude's "hidden-linger" (HI-2217): the same, but what is left names no test folder on its command line (its
  // file comes in its environment), as a model's `find / -name x` did: only its launch's job (Hive's) knows it.
  spawn(process.execPath, [__filename, 'linger-unnamed', agent], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, FAKE_LINGER_FILE: file } }).unref()
  setTimeout(() => process.exit(0), 200)
} else {
  const to = role === 'linger-unnamed' ? process.env.FAKE_LINGER_FILE : file
  const who = role === 'linger-unnamed' ? file : agent
  fs.appendFileSync(to, JSON.stringify({ agent: who, pid: process.pid, at: new Date().toISOString() }) + '\n')
  setTimeout(() => process.exit(0), 120000)
}
