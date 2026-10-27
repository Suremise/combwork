// Where the fake's "shell:" writes a command's standard error so far, while it runs (HI-1816): one file per agent in its
// home, the agent's name made safe as the fake's other per-agent files are (a display name may hold "/" or ":").
// Shared by fake-claude.cjs, which writes it, and the suites that wait on it.
const path = require('path')

const shellStderrFile = (home, agent) => path.join(home, `fake-shell-stderr-${String(agent || 'agent').replace(/[^\w-]/g, '_')}.txt`)

module.exports = { shellStderrFile }
