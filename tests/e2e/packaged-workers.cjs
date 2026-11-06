// Combwork's worker threads in the packaged build (HI-1880): rc.7's ran none. Their scripts are inside app.asar, which
// original-fs sees as one file, so each "is its script there?" said no: the usage history, the WAL checkpoints and the
// repository lock ran their work on main's thread (the usage.db opens filling the stall lines), and git's worker, the
// log's writer and the stall watchdog didn't start. Here dist/win-unpacked's Combwork is made to use each (a git project,
// a branch switch, a card), and Copy Diagnostics' Worker threads section must say each is its own thread: one that
// started but couldn't load its code (Electron, which a thread can't load) says it ended. Throwaway profile and workspace.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000
const WORKERS = ['usage history', 'git', 'repository lock', 'WAL checkpoints', 'stall watchdog', 'log writer']
// Listed too, but started only by a Codex session's first look at its log (HI-1972), or a card's start in a project
// without version control (HI-2340): none runs here.
const LISTED = [...WORKERS, "Codex's log", 'None baseline']

const userData = path.join(lib.WORK, 'pworkers-profile')
const ws = path.join(lib.WORK, 'pworkers-ws')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** Each worker's line in the report's Worker threads section, by name. */
const threadLines = (report) => {
  const section = report.split('### Worker threads')[1]?.split('\n### ')[0] ?? ''
  return Object.fromEntries([...section.matchAll(/^- ([^:]+): (.+)$/gm)].map((m) => [m[1], m[2]]))
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  const first = lib.git(alpha, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  lib.git(alpha, ['branch', 'other'])
  const env = lib.combworkEnv({ CW_USER_DATA: userData })
  const app = await _electron.launch({ executablePath: lib.PACKAGED_EXE, args: [], cwd: lib.ROOT, env })
  // Closed whatever fails from here on, not only when every step does.
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await page.getByText('alpha', { exact: true }).first().click()

    // Git's worker runs git; a switch to a branch the folder isn't on takes the repository lock; a card is a board write
    // (its WAL checkpoints) and a board change the usage history shares out again (its worker's reads). The log's writer
    // and the stall watchdog start with Combwork.
    await inv('git:switch', alpha, 'other')
    await inv('git:switch', alpha, first)
    await inv('tasks:create', { title: 'A card', project: 'alpha' })

    let lines = {}
    const allRunning = await lib.until(async () => {
      lines = threadLines(await inv('app:diagnostics'))
      // One that ended or runs on main won't change: no need to wait for it.
      if (WORKERS.some((n) => /^(ended|on main's thread)/.test(lines[n] ?? ''))) return true
      return WORKERS.every((n) => lines[n] === 'its own thread')
    }, HUNG_MS)
    check('Copy Diagnostics lists the worker threads', Object.keys(lines).length === LISTED.length, JSON.stringify(lines))
    for (const n of WORKERS) check(`${n}: its own thread`, !!allRunning && lines[n] === 'its own thread', lines[n] ?? 'not listed')
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
