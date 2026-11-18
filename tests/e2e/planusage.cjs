// Plan usage from several sessions (#383): each Claude Code session relays the reading of its own latest API call, so
// two agents can report the same week differently (98% and 96%), alternating. The status bar keeps the higher one,
// Week 98%, never flipping to 96%, and its tooltip says which agent reported each limit. The agents are the fake
// Claude Code, whose "planusage F W" reports the 5-hour limit at F% and the weekly at W% (as Claude Code 2.1.303 does:
// tests/fixtures/planusage-2026-10-19.json). Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR, quiet.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'planusage-profile')
const ws = path.join(lib.WORK, 'planusage-ws')
const claudeHome = path.join(lib.WORK, 'planusage-claude-home')
const alpha = path.join(ws, 'alpha')
// The longest a check waits for what it waits on: a bound for a hung run, never how long it should take.
const HUNG_MS = lib.timing('hang.ui')
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(alpha, { recursive: true })
  const env = lib.fakeClaude(userData, claudeHome, [alpha])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const { app, page, inv } = await lib.launch({ userData, env, viewport: { width: 1300, height: 800 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    await lib.waitForProvider(inv)
    const busy = await lib.addAgent(inv, alpha, { name: 'Busy' })
    const other = await lib.addAgent(inv, alpha, { name: 'Other' })
    const live = async (a) => (await inv('session:live')).find((s) => s.agentId === a.id)
    for (const a of [busy, other]) await inv('session:start', alpha, { agentId: a.id })
    check('both agents start', !!(await lib.until(async () => (await live(busy))?.status === 'ready' && (await live(other))?.status === 'ready', HUNG_MS)))
    // A prompt, and its turn over: the status line it posts is in by then.
    const send = async (a, text) => {
      const since = (await live(a))?.statusSince
      const moved = async () => (await live(a))?.statusSince !== since
      const sent = await lib.sendPrompt(inv, lib.ptyKey(alpha, a.id), text, { submitted: moved })
      return sent > 0 && !!(await lib.until(async () => (await moved()) && (await live(a))?.status === 'finished', HUNG_MS))
    }

    // Busy reports the week at 98%; the status bar shows it.
    const item = page.locator('.statusbar .status-item', { hasText: '5h' })
    const shows = (re) => lib.until(async () => (await item.count()) === 1 && re.test(await item.innerText()), HUNG_MS)
    check('the first report shows: 5h 40% · Week 98%', (await send(busy, 'planusage 40 98')) && !!(await shows(/5h\s*40%\s*·\s*Week\s*98%/)), await item.innerText().catch(() => ''))

    // Everything the status bar shows while they alternate, sampled every 50 ms in the page.
    await page.evaluate(() => {
      const w = window
      w.__planSeen = new Set()
      w.__planTimer = setInterval(() => {
        for (const el of document.querySelectorAll('.statusbar .status-item')) if (/5h/.test(el.textContent)) w.__planSeen.add(el.textContent.replace(/\s+/g, ' ').trim())
      }, 50)
    })
    let sentAll = true
    for (let i = 0; i < 3; i++) {
      sentAll = (await send(other, 'planusage 40 96')) && sentAll
      sentAll = (await send(busy, 'planusage 41 98')) && sentAll
    }
    check('the agents report alternately, Other 96% and Busy 98%, three times each', sentAll)
    check('…the 5-hour limit follows the higher report (41%)', !!(await shows(/5h\s*41%/)), await item.innerText())
    const seen = await page.evaluate(() => {
      clearInterval(window.__planTimer)
      return [...window.__planSeen]
    })
    check('the bar stays on Week 98% throughout: never 96%', seen.length > 0 && seen.every((t) => /Week\s*98%/.test(t)), JSON.stringify(seen))
    const stored = (await inv('app:planUsage'))['claude-code']
    const week = stored?.limits.find((l) => l.id === 'seven_day')
    check('the week kept is 98%, with the agent that reported it', week?.usedPercent === 98 && week?.reportedBy === 'Busy' && !!week?.reportedAt, JSON.stringify(week))

    // The tooltip: each limit, its reset, and the agent that reported it.
    const tip = await lib.hoverTip(page, item, (t) => /Reported by/.test(t))
    check('the tooltip says which agent reported each limit', /5-hour limit: 41% used, resets .+\nReported by Busy, /.test(tip) && /Weekly limit: 98% used, resets .+\nReported by Busy, /.test(tip), tip)
    await page.screenshot({ path: path.join(lib.WORK, 'planusage-tip.png') })

    for (const a of [busy, other]) await inv('session:stop', alpha, a.id).catch(() => undefined)
    await lib.until(async () => (await inv('session:live')).length === 0, HUNG_MS)
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
