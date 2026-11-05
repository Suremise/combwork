// A watch from a builder's previous conversation never holds off its next card (HI-2197, HB3's stall), on the fake
// Claude Code, alpha's cards in slots:
// 1. B1's first lane is lent slot-a; given its card there, B1 watches it by key. The lane ends: Combwork types /exit, B1's
//    CLI exits, and its watch outlives it (watches outlive a launch, for a resume).
// 2. B1's next lane (slot-b) starts it in a new conversation: the old watch ends before it launches (no "waiting on
//    cards"), and Combwork gives B1 the lane's card.
// 3. In that conversation B1 watches by a plain number that reads as another card's key (beta's cards made first, so
//    alpha's numbers run ahead of its keys): refused, naming both; nothing is watched. A Done card by key answers at
//    once (HI-2153).
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000

const at = (x) => path.join(lib.WORK, `stalewatch-${x}`)
const userData = at('profile')
const ws = at('ws')
const home = at('claude-home')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
const slotA = path.join(`${ws}.worktrees`, 'alpha', 'slot-a')
const slotB = path.join(`${ws}.worktrees`, 'alpha', 'slot-b')
const PORT = Number(lib.port(47707))
const identity = { name: 'Hive Stale Watch Test', email: 'stalewatch@example.com' }
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
  lib.gitProject(alpha, { 'a.txt': 'a\n', '.gitignore': '.combwork/\n' })
  lib.git(alpha, ['branch', '-M', 'main'])
  lib.gitProject(beta, { 'b.txt': 'b\n', '.gitignore': '.combwork/\n' })
  const env = lib.fakeClaude(userData, home, [alpha, beta, ws, slotA, slotB])
  // B1 follows Combwork's notices as a model does: cw_inbox, then the ack.
  fs.writeFileSync(path.join(home, 'fake-follow-notices.txt'), '')
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const h = await lib.launch({ userData, env: { ...env, CW_API_PORT: String(PORT), CW_TEST_TIPS: 'off' } })
  const { page, inv } = h
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(inv)
    await lib.openWorkspace(inv, page, ws)
    const until = (fn, ms = HUNG_MS) => lib.until(fn, ms, 250)
    const log = () => lib.combworkLogLines(userData)
    await inv('workflow:setOptions', alpha, { preset: null, options: { review: 'agent', noSelfReview: true, finish: 'agentMerges', folder: 'slots', target: 'main', style: 'merge', preChecks: [], mergeChecks: [], identity, okBefore: { mode: 'never', labels: [] }, reviewerMode: 'pool', commands: {} } })
    const b1 = await lib.addAgent(inv, alpha, { name: 'B1', workflowRole: 'builder' })
    // A second builder: a pool of two slots, so the next lane needn't wait for the first card's.
    await lib.addAgent(inv, alpha, { name: 'B2', workflowRole: 'builder' })
    await lib.addAgent(inv, alpha, { name: 'R1', workflowRole: 'reviewer' })
    const live = async (id) => (await inv('session:live')).find((s) => same(s.projectPath, alpha) && s.agentId === id) ?? null
    // beta's cards first: alpha's numbers then run ahead of its keys (its first card is #4, its key's number 1).
    for (const t of ['b1', 'b2', 'b3']) await inv('tasks:create', { title: t, project: 'beta' })
    const cards = []
    // The fifth is made in Done, as a merged card is.
    for (const t of ['First lane card', 'Next lane card', 'Third', 'Fourth', 'Fifth']) {
      const c = await inv('tasks:create', { title: t, project: 'alpha', ...(t === 'Fifth' ? { column: 'done' } : {}) })
      cards.push({ n: c.number, key: (await inv('tasks:list')).find((x) => x.number === c.number)?.key })
    }
    const [c1, c2] = cards
    const say = (text) => lib.typeLine(inv, lib.ptyKey(alpha, b1.id), home, null, text, { live: () => live(b1.id) })
    const idleIn = (folder) => until(async () => {
      const s = await live(b1.id)
      return s && same(s.cwd, folder) && ['ready', 'finished', 'watching'].includes(s.status) ? s : null
    }, HUNG_MS)

    // --- 1. The first lane: B1 in slot-a, given its card, watches it by key; the lane ends and B1's CLI exits, the
    //        card still in Active (its slot kept for it) and the watch kept.
    const first = await inv('lanes:start', alpha, { builder: b1.id, reviewer: null, pool: true, cards: [c1.n], name: 'First' })
    check('the first lane is lent slot-a', first.slot === 'slot-a', JSON.stringify(first))
    check(`B1 is given ${c1.key} in slot-a, and is idle`, !!(await until(async () => transcripts().includes(`Work on task ${c1.key}`) && (await idleIn(slotA)), HUNG_MS)), JSON.stringify(await live(b1.id)))
    await say(`cw cw_wait_for_tasks ${JSON.stringify({ cards: [c1.key], changes: ['column'], wake: true })}`)
    check('B1 watches its card', !!(await until(async () => (await live(b1.id))?.status === 'watching', HUNG_MS)), JSON.stringify(await live(b1.id)))
    // Told the lane is finished (that wake ends its watch), B1 watches its card again, as HB3 did: that watch is the one
    // its next conversation would inherit.
    fs.writeFileSync(path.join(home, 'fake-wakes-B1.txt'), `cw cw_wait_for_tasks ${JSON.stringify({ cards: [c1.key], changes: ['column'], wake: true })}\n`)
    const ending = Math.max(0, log().length - 1)
    await inv('lanes:end', first.lane.id)
    check('…told the lane ended, B1 watches its card again', !!(await until(() => log().slice(ending).filter((l) => l.includes(' watches #')).length >= 1, HUNG_MS)), log().slice(ending).filter((l) => l.includes('[watches]')).join('\n'))
    check("…the lane ends and B1's CLI exits", !!(await until(async () => !(await live(b1.id)), HUNG_MS)))

    // --- 2. The next lane (in slot-b: slot-a is still the first card's): a new conversation, its old watch ended first,
    //        and the card given to it.
    const since = Math.max(0, log().length - 1)
    const next = await inv('lanes:start', alpha, { builder: b1.id, reviewer: null, pool: true, cards: [c2.n], name: 'Next' })
    check('the next lane is lent slot-b', next.slot === 'slot-b', JSON.stringify(next))
    check("B1's watch from its previous conversation ended as the new one started", !!(await until(() => log().slice(since).some((l) => l.includes("'s watch ended: its conversation ended")), HUNG_MS)), log().slice(since).join('\n'))
    check(`…and B1 is given ${c2.key} in slot-b`, !!(await until(() => transcripts().includes(`Work on task ${c2.key}`), HUNG_MS)), log().slice(since).filter((l) => l.includes('slots') || l.includes('watch')).join('\n'))
    const after = log().slice(since)
    check('…never held off as "waiting on cards"', !after.some((l) => l.includes('waiting on cards')), after.filter((l) => l.includes('waiting on cards')).join('\n'))
    check('B1 is idle in slot-b, watching nothing', !!(await until(async () => {
      const s = await idleIn(slotB)
      return s && !s.watch
    }, HUNG_MS)), JSON.stringify(await live(b1.id)))

    // --- 3. A plain number that reads as another card's key: refused, naming both; a Done card by key answers at once.
    const clash = cards.find((c) => cards.some((o) => o.key === `${c.key.split('-')[0]}-${c.n}`))
    check('a number of alpha reads as another of its keys', !!clash, JSON.stringify(cards))
    const other = `${clash.key.split('-')[0]}-${clash.n}`
    await say(`cw cw_wait_for_tasks ${JSON.stringify({ cards: [clash.n], wake: true })}`)
    check(`watching ${clash.n} is refused, naming ${clash.key} and ${other}`, !!(await until(() => transcripts().includes(`${clash.n} is ${clash.key}'s number (#${clash.n}), not ${other}, which is another card. Name cards by key`), HUNG_MS)))
    check('…and nothing is watched', !(await live(b1.id))?.watch, JSON.stringify(await live(b1.id)))
    await say(`cw cw_wait_for_tasks ${JSON.stringify({ cards: [cards[4].key], wake: true })}`)
    check(`a watch on ${cards[4].key}, in Done, answers at once`, !!(await until(() => transcripts().includes(`${cards[4].key} is in Done`), HUNG_MS)), transcripts().split('\n').filter((l) => l.includes(cards[4].key)).slice(-3).join('\n'))
    check('…and nothing is watched', !(await live(b1.id))?.watch, JSON.stringify(await live(b1.id)))
  } catch (err) {
    check('no unexpected error', false, err.stack)
  } finally {
    await h.app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} failed` : 'all passed')
  process.exit(failed ? 1 : 0)
})()
