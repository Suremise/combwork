// Reconciliation in the dev build (#1217; with workflow rules enforced since #1263, a Doing card still only gets marks): a card started by its agent, which works in a git worktree
// (P7: its carried slot once the opening has adopted it, HI-2126, where the slot's preparation makes the card's own line;
// never taken for gone before, #1551);
// a commit made there with plain git, outside Combwork, is seen by the watcher and recorded on the card as
// an observed HeadMoved within the debounce, read over IPC; the card doesn't move. Then the branch merged into main by
// hand: Integrated, by outside, the card still where it was. No agents run. Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'reconcile-profile')
const ws = path.join(lib.WORK, 'reconcile-ws')
const alpha = path.join(ws, 'alpha')
const wt = path.join(ws, 'alpha-card')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd, env: lib.gitEnv(), encoding: 'utf8' }).trim()

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha, { 'a.txt': 'one\n', '.gitignore': '.combwork/\n' })
  git(alpha, 'branch', '-M', 'main')
  git(alpha, 'worktree', 'add', '-q', '-b', 'card', wt, 'main')
  // The builder works in that worktree, on `card`, merging back into main.
  fs.mkdirSync(path.join(alpha, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'Builder', provider: 'claude-code', worktree: { path: wt, branch: 'card', base: 'main' } }] }))
  lib.enableProviders(userData)

  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47930) })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    // HI-2126: the opening adopts Builder's worktree as its carried slot after the window shows the workspace; a card
    // started before that is started as 0.9 did (an agent not migrated yet works in its worktree), so wait for it.
    const carried = await lib.until(async () => (await inv('slots:list', alpha)).find((s) => s.lease?.kind === 'carried' && s.lease.agent === 'b1'), HUNG_MS)
    check("Builder's worktree adopted as its carried slot", !!carried, JSON.stringify(await inv('slots:list', alpha)))

    const n = (await inv('tasks:create', { title: 'Work in the worktree', project: 'alpha' })).number
    await inv('tasks:update', n, { column: 'doing', agent: 'b1' })
    const facts = () => inv('tasks:facts', n)
    const started = (await facts()).find((f) => f.kind === 'Started')
    // P7 (#1441): Builder's 0.9 worktree is its carried slot; the card's own line is made there by the slot's preparation.
    check('started in its worktree (its carried slot), on a line of its own, toward main', started?.data.folder.toLowerCase() === wt.toLowerCase() && !!started.data.slot && /^hive\/AL\/AL-\d+-/.test(started.data.line) && started.data.target === 'main', JSON.stringify(started?.data))
    const prepared = await lib.until(async () => (await facts()).find((f) => f.kind === 'SlotPrepared'), HUNG_MS)
    const branch = () => git(wt, 'branch', '--show-current')
    check('…its slot prepared: the worktree on the card\'s line', !!prepared && !!(await lib.until(() => branch() === started.data.line, HUNG_MS)), JSON.stringify({ prepared: prepared?.data, branch: branch() }))
    // #1551: its line didn't exist until then, and was never taken for gone, nor its head for moved to nothing.
    check('…its line never taken for gone before it was made', !(await facts()).some((f) => (f.kind === 'Gone' && f.data.what === 'line') || (f.kind === 'HeadMoved' && f.data.to === null)), JSON.stringify((await facts()).map((f) => f.kind)))

    // A commit made with plain git, outside Combwork.
    fs.writeFileSync(path.join(wt, 'b.txt'), 'two\n')
    git(wt, 'add', '-A')
    git(wt, 'commit', '-qm', 'outside Combwork')
    const head = git(wt, 'rev-parse', 'HEAD')
    const seen = await lib.until(async () => (await facts()).find((f) => f.kind === 'HeadMoved' && f.data.to === head), HUNG_MS)
    check('the commit is observed: HeadMoved to it, by outside', !!seen && seen.actor === 'outside' && seen.source === 'observed', JSON.stringify((await facts()).map((f) => f.kind)))
    check('…and the card stays in Doing', (await inv('tasks:list')).find((c) => c.number === n)?.column === 'doing')

    // Merged into main by hand: Integrated by outside; nothing moves in P3.
    git(alpha, 'merge', '-q', '--no-ff', '-m', 'merge card', started.data.line)
    // An unfinished card's integration shows once it has passed; here, its branch's work is in main: MergedInPart.
    const part = await lib.until(async () => (await facts()).find((f) => f.kind === 'MergedInPart' || f.kind === 'Integrated'), HUNG_MS)
    check('the hand merge is observed (its work in main), recorded and nothing else', !!part && part.source === 'observed' && (await facts()).filter((f) => f.kind === 'Moved').length === 1, JSON.stringify((await facts()).map((f) => [f.kind, f.source])))
    check('…the card still in Doing', (await inv('tasks:list')).find((c) => c.number === n)?.column === 'doing')
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
