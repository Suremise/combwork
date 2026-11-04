// HI-2485: an external file handle spans a fake CLI's writer release and the pool's detach.
// The same file must still hold the slot after the writer is gone, so a lend is refused until it closes.
// Dev build only: slots:test asks the real pool for that lend; no real CLI or Sandbox is started.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// A bound for a hung writer release or launch, never how long either should take.
const HUNG_MS = 60000
const at = (name) => path.join(lib.WORK, `slotwriterhold-${name}`)
const userData = at('profile')
const ws = at('ws')
const home = at('claude-home')
const alpha = path.join(ws, 'alpha')
const slotA = path.join(`${ws}.worktrees`, 'alpha', 'slot-a')
const PORT = Number(lib.port(47790))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
/** A probe's failure means held only when the slot still exists (a concurrent quiet look can rename it aside). */
const renameState = () => {
  try {
    fs.renameSync(slotA, `${slotA}.probe`)
  } catch (e) {
    return ['EPERM', 'EACCES', 'EBUSY'].includes(e.code) && fs.existsSync(slotA) ? 'held' : e.code
  }
  fs.renameSync(`${slotA}.probe`, slotA)
  return 'free'
}
const identity = (stat) => `${stat.dev}:${stat.ino}`

;(async () => {
  lib.gitProject(alpha, { 'a.txt': 'a\n', '.gitignore': '.combwork/\n' })
  lib.git(alpha, ['branch', '-M', 'main'])
  const env = lib.fakeClaude(userData, home, [alpha, ws, slotA])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  let h = null
  let fd = null
  try {
    h = await lib.launch({ userData, env: { ...env, HIVE_API_PORT: String(PORT) } })
    const { inv, page } = h
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(inv)
    await lib.openWorkspace(inv, page, ws)
    await inv('workflow:setOptions', alpha, { preset: null, options: { review: 'agent', noSelfReview: true, finish: 'hiveMerges', folder: 'slots', target: 'main', style: 'merge', preChecks: [], mergeChecks: [], identity: { name: 'Slot Writer Test', email: 'slotwriter@example.com' }, okBefore: { mode: 'never', labels: [] } } })
    const b1 = await lib.addAgent(inv, alpha, { name: 'B1', workflowRole: 'builder' })
    const r1 = await lib.addAgent(inv, alpha, { name: 'R1', workflowRole: 'reviewer' })
    await lib.setMaxAgents(inv, 1)
    const create = async (title) => (await inv('tasks:create', { title, project: 'alpha' })).number
    const c1 = await create('Writer holds the slot')
    const c2 = await create('After the writer')
    const live = async () => (await inv('session:live')).find((s) => same(s.projectPath, alpha) && s.agentId === b1.id)
    const slot = async () => (await inv('slots:list', alpha)).find((s) => s.name === 'slot-a')
    const until = (condition, ms) => lib.until(condition, ms, 100)
    const first = await inv('lanes:start', alpha, { builder: b1.id, reviewer: r1.id, cards: [c1] })
    check('first lane is lent slot-a', first.slot === 'slot-a', JSON.stringify(first))
    check('fake CLI runs in slot-a and owns its writer', !!(await until(async () => same((await live())?.cwd, slotA) && ['ready', 'finished'].includes((await live())?.status) && !!(await slot())?.writer, HUNG_MS)))
    const file = path.join(slotA, '.combwork', 'external.lock')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fd = fs.openSync(file, 'w')
    const before = identity(fs.fstatSync(fd, { bigint: true }))
    check('an open ignored file holds the slot before writer release', renameState() === 'held')
    await inv('lanes:end', first.lane.id, true)
    check('the CLI stopped and its writer and lease were released while the handle stayed open', !!(await until(async () => {
      const s = await slot()
      return !(await live()) && s?.state === 'ready' && !s.writer && !s.lease
    }, HUNG_MS)))
    const after = identity(fs.fstatSync(fd, { bigint: true }))
    const named = identity(fs.statSync(file, { bigint: true }))
    console.log(`INFO file identity before=${before} after=${after} path=${named}`)
    check('release and detach preserved the file behind the open handle', before === after && after === named)
    check('the pool detached the old card line', lib.git(slotA, ['branch', '--show-current']).trim() === '')
    check('the same open handle still holds the slot after writer release', renameState() === 'held')
    const tried = await inv('slots:test', alpha, { op: 'lend', agent: b1.id, card: c2 })
    check('the pool refuses to lend the held slot after writer release', tried?.ok === false && tried.refusal?.why === 'busy' && tried.refusal?.slot === 'slot-a' && tried.refusal?.held === 'process', JSON.stringify(tried))
    check('a refused lend leaves the file and its handle unchanged', identity(fs.fstatSync(fd, { bigint: true })) === named && identity(fs.statSync(file, { bigint: true })) === named)
    fs.closeSync(fd)
    fd = null
    check('the slot can be renamed after the file closes', renameState() === 'free')
    const next = await inv('lanes:start', alpha, { builder: b1.id, reviewer: r1.id, cards: [c2] })
    check('after closing the file the next lane is lent slot-a', next.slot === 'slot-a', JSON.stringify(next))
    check('the fake CLI starts there again', !!(await until(async () => same((await live())?.cwd, slotA), HUNG_MS)))
  } catch (e) {
    check('no exception', false, e?.stack ?? String(e))
  } finally {
    if (fd !== null) fs.closeSync(fd)
    await h?.app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
  process.exit(failed ? 1 : 0)
})()
