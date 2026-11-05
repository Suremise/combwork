// S50 for the merge queue: one runner across copies of Combwork (#1358; #1360's app-level proof, SPEC §16.9.3 The runner). Two test
// copies (two profiles, their own Agent API ports) open one test workspace whose project is set to "Combwork merges" into
// `integration` (queueFixture.cjs), with a card queued and a slow fake check:
// - A runs the queue (its check running); B, opened meanwhile, doesn't: its Merges tab says "Run by <A's profile>";
// - A's main process exits mid-check (no quit handler): B takes the queue over, the check process A recorded is
//   ended, and the queue runs in a new folder of its own and finishes: merged once.
// Screenshots of B's Merges tab before and after. Dev build, throwaway profiles, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const net = require('net')
const path = require('path')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47855))
const fx = q.queueProject('queuelease')
const HUNG_MS = 60000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
// Every wait here is bounded only against a hang (#570).
const waitHung = (fn) => lib.until(fn, HUNG_MS, 200)
const freePort = () =>
  new Promise((r) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => r(p))
    })
  })
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/** The queue's worktrees of the project (`queue-<hash>-<lease>`), as git lists them. */
const queueFolders = () =>
  lib
    .git(fx.alpha, ['worktree', 'list', '--porcelain'])
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => path.resolve(l.slice(9)))
    .filter((p) => path.basename(p).startsWith('queue-'))

;(async () => {
  q.prepare(fx)
  const fxB = q.otherProfile(fx, 'b')
  const profileA = path.basename(fx.userData)
  const hives = []
  try {
    // --- A opens the workspace, a card is approved and its check starts: A runs the queue.
    const a = await q.startHive(fx, { port: PORT })
    hives.push(a)
    a.page.on('pageerror', (e) => check('no page errors (A)', false, e.message))
    const reviewer = await q.agent(fx, a, 'R1')
    check('the reviewer has its token', !!reviewer.token)
    q.steer(fx, 'wait')
    const one = await q.approve(fx, a, reviewer, 'One', { 'one.txt': 'one\n' })
    check('the card is approved', Object.values(one.steps).every((s) => s.status === 200), JSON.stringify(one.steps))
    check("A runs the queue: the card's check is running", !!(await waitHung(() => fs.existsSync(fx.started))))
    const checkPid = Number(fs.readFileSync(fx.started, 'utf8'))
    const [oldFolder] = queueFolders()
    const viewA = (await a.inv('queue:list', fx.alpha, 'integration'))[0]
    check('…in a queue folder of its own, A the runner', !!oldFolder && viewA?.runHere === true && viewA.runBy === profileA, JSON.stringify({ viewA, oldFolder }))

    // --- B opens the same workspace: it doesn't run the queue, and says who does.
    const b = await q.startHive(fxB, { port: await freePort(), keepOptions: true })
    hives.push(b)
    b.page.on('pageerror', (e) => check('no page errors (B)', false, e.message))
    await lib.fitWindow(b.app, b.page, { width: 1400, height: 900 })
    const viewB = async () => (await b.inv('queue:list', fx.alpha, 'integration'))[0]
    check("B doesn't run it: its model says A's profile runs it", !!(await waitHung(async () => (await viewB())?.runBy === profileA && (await viewB()).runHere === false)), JSON.stringify(await viewB()))
    const tab = await q.mergesTab(b)
    check(`…B's Merges tab says "Run by ${profileA}"`, !!(await waitHung(async () => (await tab.text('integration')).includes(`Run by profile ${profileA}`))), await tab.text('integration'))
    check('…and only one check runs (A\'s)', fs.readFileSync(fx.started, 'utf8').trim() === String(checkPid) && queueFolders().length === 1)
    await b.page.mouse.move(5, 5)
    await b.page.screenshot({ path: path.join(fx.shots, 'queuelease-1-run-by-a.png') })

    // --- A's main process exits mid-check: B takes over, ends A's check, runs it again in a new folder, merges once.
    fs.rmSync(fx.started, { force: true })
    // Its main process, as it says itself (the process Playwright started may be a launcher in front of it), ends at
    // once from inside: app.exit runs no quit handler (before-quit, will-quit), so nothing is released, as in a crash.
    const aPid = await a.app.evaluate(() => process.pid)
    const launcher = a.app.process()
    await a.app.evaluate(({ app }) => app.exit(1)).catch(() => undefined)
    hives.shift()
    check("A's main process has exited", !!(await waitHung(() => !alive(aPid))))
    // Its launcher too, once the main process is gone (it has nothing left to close).
    if (launcher.pid !== aPid && alive(launcher.pid)) launcher.kill()
    check("…the check process A recorded is ended", !!(await waitHung(() => !alive(checkPid))), String(checkPid))
    const again = await waitHung(() => (fs.existsSync(fx.started) ? Number(fs.readFileSync(fx.started, 'utf8')) || null : null))
    check('B takes the queue over: it runs the check again', !!again && again !== checkPid && (await viewB())?.runHere === true, JSON.stringify(await viewB()))
    const [newFolder] = queueFolders()
    check("…in a new folder of its own, A's removed", !!newFolder && newFolder.toLowerCase() !== oldFolder?.toLowerCase() && !fs.existsSync(oldFolder ?? '') && queueFolders().length === 1, JSON.stringify({ oldFolder, now: queueFolders() }))
    fs.writeFileSync(fx.go, 'go')
    check('…and the card is merged: Done', !!(await waitHung(async () => (await b.card(one.n))?.column === 'done')), JSON.stringify(await b.kinds(one.n)))
    const integrated = (await b.facts(one.n)).filter((x) => x.kind === 'Integrated')
    check('…merged once: one Integrated, by Combwork, one merge commit on integration', integrated.length === 1 && integrated[0].data.by === 'combwork' && integrated[0].data.result === q.head(fx) && lib.git(fx.alpha, ['rev-list', '--merges', '--count', 'main..integration']).trim() === '1', JSON.stringify(integrated))
    check("B's Merges tab no longer names another runner", !!(await waitHung(async () => !(await tab.text('integration')).includes('Run by'))), await tab.text('integration'))
    await b.page.mouse.move(5, 5)
    await b.page.screenshot({ path: path.join(fx.shots, 'queuelease-2-taken-over.png') })
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    for (const h of hives) await h.app.close().catch(() => undefined)
  }
  console.log(`screenshots: ${fx.shots}`)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
