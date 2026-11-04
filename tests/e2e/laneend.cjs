// A lane's end lets its builder finish (HI-1706, SPEC §16.10.2) on the fake Claude Code, alpha's cards in slots:
// 1. B1's lane is lent slot-a and B1 starts in it; B1 is mid-turn when the lane ends: its session goes on, and Hive
//    waits ("waiting: it is in a turn"), its slot still B1's.
// 2. The turn ends: B1 is told at its Stop (the drain) that the lane is finished, with its card, reads it with
//    cw_inbox, and its turn ends. Then Hive types /exit, and B1's CLI exits by itself (code 0): no pty kill for it.
// 3. Only then is slot-a free (no writer, no lease).
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000

const at = (x) => path.join(lib.WORK, `laneend-${x}`)
const userData = at('profile')
const ws = at('ws')
const home = at('claude-home')
const alpha = path.join(ws, 'alpha')
const slotA = path.join(`${ws}.worktrees`, 'alpha', 'slot-a')
const PORT = Number(lib.port(47796))
const identity = { name: 'Hive Lane End Test', email: 'laneend@example.com' }
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
/** Every line of the fake's transcripts in its home (each conversation's JSONL). */
const transcripts = () => {
  const out = []
  const walk = (d) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.jsonl') && path.basename(d) !== home) out.push(fs.readFileSync(p, 'utf8'))
    }
  }
  walk(path.join(home, 'projects'))
  return out.join('\n')
}

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha, { 'a.txt': 'a\n', '.gitignore': '.hive/\n' })
  lib.git(alpha, ['branch', '-M', 'main'])
  const env = lib.fakeClaude(userData, home, [alpha, ws, slotA])
  // B1 follows Hive's notices as a model does: cw_inbox, then the ack.
  fs.writeFileSync(path.join(home, 'fake-follow-notices.txt'), '')
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const h = await lib.launch({ userData, env: { ...env, HIVE_API_PORT: String(PORT), HIVE_TEST_TIPS: 'off' } })
  const { page, inv } = h
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(inv)
    await lib.openWorkspace(inv, page, ws)
    const until = (fn, ms = HUNG_MS) => lib.until(fn, ms, 250)
    const log = () => lib.hiveLogLines(userData)
    await inv('workflow:setOptions', alpha, { preset: null, options: { review: 'agent', noSelfReview: true, finish: 'agentMerges', folder: 'slots', target: 'main', style: 'merge', preChecks: [], mergeChecks: [], identity, okBefore: { mode: 'never', labels: [] }, reviewerMode: 'pool', commands: {} } })
    const b1 = await lib.addAgent(inv, alpha, { name: 'B1', workflowRole: 'builder' })
    await lib.addAgent(inv, alpha, { name: 'R1', workflowRole: 'reviewer' })
    const live = async (id) => (await inv('session:live')).find((s) => same(s.projectPath, alpha) && s.agentId === id) ?? null
    const c1 = (await inv('tasks:create', { title: 'Lane end card', project: 'alpha' })).number
    const key1 = (await inv('tasks:list')).find((c) => c.number === c1)?.key

    // --- 1. The lane, lent slot-a; B1 starts there and is mid-turn when the lane ends.
    const lane = await inv('lanes:start', alpha, { builder: b1.id, reviewer: null, pool: true, cards: [c1], name: 'Gentle end' })
    check('the lane is lent slot-a', lane.slot === 'slot-a', JSON.stringify(lane))
    const s1 = await until(async () => {
      const s = await live(b1.id)
      return s && same(s.cwd, slotA) && ['ready', 'finished'].includes(s.status) ? s : null
    }, HUNG_MS)
    check('B1 runs in slot-a, idle', !!s1, JSON.stringify(await live(b1.id)))
    await lib.typeLine(inv, lib.ptyKey(alpha, b1.id), home, null, 'holduntil lane-go', { live: () => live(b1.id) })
    check('B1 is in a turn', !!(await until(async () => (await live(b1.id))?.status === 'working', HUNG_MS)))
    const since = Math.max(0, log().length - 1) // the last element is the empty one after the final newline
    await inv('lanes:end', lane.lane.id)
    check("the lane's lease ends", !!(await until(() => log().slice(since).some((l) => l.includes(`Lane ${lane.lane.id} ended: its lease`)), HUNG_MS)), log().slice(since).join('\n'))
    check('…and Hive waits for B1\'s turn, its session still running', !!(await until(() => log().slice(since).some((l) => l.includes("'s end, ") && l.includes('waiting: it is in a turn')), HUNG_MS)) && (await live(b1.id))?.status === 'working', log().slice(since).join('\n'))
    check('…slot-a is still B1\'s', (await inv('slots:list', alpha)).find((s) => s.name === 'slot-a')?.writer?.agent === b1.id)

    // --- 2. The turn ends: B1 reads the lane's note at its Stop, then Hive types /exit and B1's CLI exits by itself.
    fs.writeFileSync(path.join(home, 'lane-go'), '')
    check('B1 read that the lane is finished, with its card, with cw_inbox', !!(await until(() => transcripts().includes(`Lane Gentle end is finished: ${key1} not merged`), HUNG_MS)), key1)
    check('…its session ended', !!(await until(async () => !(await live(b1.id)), HUNG_MS)))
    const after = log().slice(since)
    const runKey = `#${b1.id}`
    check('…by its exit command, once its turn was over', after.some((l) => l.includes('typed /exit (its lane ended and its turn is over)')), after.join('\n'))
    check('…exiting by itself (code 0), never killed', after.some((l) => l.includes('[pty] exit') && l.includes(runKey) && /: 0⁩?$/.test(l.trim())) && !after.some((l) => l.includes('[pty] kill') && l.includes(runKey)), after.filter((l) => l.includes(runKey)).join('\n'))

    // --- 3. Only now is slot-a free.
    check('slot-a is free afterwards: no writer, no lease', !!(await until(async () => {
      const a = (await inv('slots:list', alpha)).find((s) => s.name === 'slot-a')
      return a && !a.writer && !a.lease
    }, HUNG_MS)), JSON.stringify((await inv('slots:list', alpha)).find((s) => s.name === 'slot-a')))
  } catch (err) {
    check('no unexpected error', false, err.stack)
  } finally {
    await h.app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} failed` : 'all passed')
  process.exit(failed ? 1 : 0)
})()
