// An agent's footer (#217; one quiet line since #978: model · effort · mode on the left, the transcript's size · ctx ·
// cost on the right since #1013, warnings just left of them). The same layout in an agent's pane, its focus view and the
// Assistant's panel: the right side ends at the footer's right edge, with space between the two sides. Short of room: the
// size goes first while it isn't a warning, then the warnings give up their text for their icon in turn, each before its
// text would be cut (the background tasks', then the transcript's), then the permission mode's label shortens (its icon
// and caret stay), then the model's, and only then is the line cut off at the right; the context never shortens before
// that. Narrowed a few pixels at a time, a Claude Code agent's footer (priced, so it has a cost, with every warning: its
// context past the Compact threshold, a transcript past its warn size and a background task running) and a Codex agent's
// ("Approve for me", its longest label, no warnings), at 100% and 125% zoom, and the Assistant's (its plain transcript
// size): nothing overlaps, every step comes in that order and widening brings the text back. Screenshots of each step and of each place in both
// themes. The agents and the Assistant are the fake Claude Code and the fake Codex. Dev build, throwaway profile,
// workspace, CLAUDE_CONFIG_DIR and CODEX_HOME.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'footerfit-profile')
const ws = path.join(lib.WORK, 'footerfit-ws')
const claudeHome = path.join(lib.WORK, 'footerfit-claude-home')
const codexHome = path.join(lib.WORK, 'footerfit-codex-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = async (fn, ms = 10000) => {
  const t = Date.now()
  let v
  while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(150)
  return v
}

/**
 * In the page: narrows the agent's footer (or the footer a selector names) from `from` (null: its pane's width) to `to`
 * px (null: `from`), `step` at a time, and says what it shows at each width. `keep` leaves the footer at the last width (for a screenshot) instead of giving it back its own.
 */
function sweep([agent, from, to, step, keep]) {
  const r = (x) => x.getBoundingClientRect()
  const el = agent.startsWith('.') ? document.querySelector(agent) : [...document.querySelectorAll('.agent-pane')].filter((p) => p.querySelector('.pane-header-bar')?.textContent.includes(agent)).map((p) => p.querySelector('.pane-footer-bar')).find((f) => f && f.getBoundingClientRect().width > 0)
  if (!el) return [{ w: -1, fit: -1, overlaps: ['no footer shown for ' + agent + ': ' + [...document.querySelectorAll('.agent-pane')].map((p) => p.querySelector('.pane-header-bar')?.textContent + '=' + Math.round(p.querySelector('.pane-footer-bar')?.getBoundingClientRect().width ?? -1)).join(', ')] }]
  el.style.width = ''
  from = from ?? Math.floor(r(el).width)
  to = to ?? from
  const full = (x) => !!x && x.clientWidth > 0 && x.scrollWidth <= x.clientWidth + 1
  const gone = (x) => !x || x.clientWidth === 0
  const read = () => {
    const fb = r(el)
    const items = [...el.children].filter((k) => !k.classList.contains('grow') && r(k).width > 0)
    const overlaps = []
    for (let i = 0; i < items.length; i++)
      for (let j = i + 1; j < items.length; j++) {
        const [a, b] = [r(items[i]), r(items[j])]
        if (a.right > b.left + 0.5 && b.right > a.left + 0.5) overlaps.push(`${items[i].textContent.trim() || i} / ${items[j].textContent.trim() || j}`)
      }
    const tasks = el.querySelector('.tasks-text')
    const size = el.querySelector('.foot-transcript .size-text')
    const plain = el.querySelector('.foot-size .size-text')
    const ctx = el.querySelector('.ctx-text')
    const model = el.querySelector('.foot-model')
    const chip = el.querySelector('.mode-chip')
    const label = chip?.querySelector('.mode-label')
    const last = items.at(-1)
    // Where the items may end: the footer's right edge, inside its padding.
    const edge = fb.right - parseFloat(getComputedStyle(el).paddingRight)
    // The right side: the items after the space between the two sides.
    const grow = el.querySelector(':scope > .grow')
    const rightSide = grow ? items.filter((k) => grow.compareDocumentPosition(k) & Node.DOCUMENT_POSITION_FOLLOWING) : []
    const warn = (x) => (!x ? null : full(x) ? 'full' : gone(x) ? 'icon' : 'cut')
    return {
      w: Math.round(fb.width),
      fit: Number(el.dataset.fit ?? 0),
      tasks: warn(tasks),
      size: warn(size),
      plain: warn(plain),
      ctx: !ctx ? null : full(ctx) && r(ctx).right <= fb.right + 0.5 ? 'full' : 'cut',
      model: !model ? null : model.scrollWidth <= model.clientWidth + 1 ? 'full' : 'cut',
      label: !label ? null : full(label) ? 'full' : 'cut',
      labelWidth: label ? label.clientWidth : 0,
      chipIcons: !chip || [...chip.querySelectorAll('.codicon')].every((i) => r(i).width > 0 && r(i).left >= r(chip).left - 0.5 && r(i).right <= Math.min(r(chip).right, fb.right) + 0.5),
      // The line cut off at the right: its last item ends past the footer's edge.
      endCut: !!last && r(last).right > edge + 0.5,
      // The right side against the footer's right edge (none: nothing on the right yet), and the room between the sides.
      rightGap: rightSide.length ? Math.round(edge - r(rightSide.at(-1)).right) : null,
      between: grow ? Math.round(r(grow).width) : null,
      overlaps
    }
  }
  // The footer picks its level in a ResizeObserver. Resize observers are called in the order they were made, so one of
  // ours, made after the footer's, is called once the footer has measured the new width: that is when it has seen it.
  const measured = (w) =>
    new Promise((res) => {
      el.style.width = `${w}px`
      const ro = new ResizeObserver(() => {
        ro.disconnect()
        res()
      })
      ro.observe(el)
    })
  const frame = () => new Promise((res) => requestAnimationFrame(() => res()))
  // The longest a width waits for the footer to stop changing, in frames: a bound for a hung render, never the wait itself.
  const HUNG_FRAMES = 120
  return (async () => {
    const out = []
    for (let w = from; step > 0 ? w <= to : w >= to; w += step) {
      await measured(w)
      // A level change renders again (and is measured again): the footer has settled when a frame changes nothing.
      let s = read()
      let settled = false
      for (let i = 0; i < HUNG_FRAMES && !settled; i++) {
        await frame()
        const again = read()
        settled = JSON.stringify(again) === JSON.stringify(s)
        s = again
      }
      out.push(settled ? s : { ...s, overlaps: [...s.overlaps, 'still changing after ' + HUNG_FRAMES + ' frames'] })
    }
    if (!keep) el.style.width = ''
    return out
  })()
}

/** Everything wrong with a narrowing sweep (widest first): a text cut, a step out of order, an overlap. */
function problems(states, { hasTasks, hasSize, hasPlain }) {
  const most = hasSize ? 3 : hasTasks ? 2 : hasPlain ? 1 : 0
  const bad = []
  let prev = null
  for (const s of states) {
    const at = `${s.w}px`
    if (s.overlaps.length) bad.push(`${at}: overlap ${s.overlaps.join(', ')}`)
    if (s.tasks === 'cut' || s.size === 'cut' || s.plain === 'cut') bad.push(`${at}: a text cut (tasks ${s.tasks}, size ${s.size}, plain size ${s.plain})`)
    if (prev && s.fit < prev.fit) bad.push(`${at}: steps back (${prev.fit} → ${s.fit})`)
    if (hasPlain && (s.fit >= 1 ? s.plain !== 'icon' : s.plain !== 'full')) bad.push(`${at}: level ${s.fit} but the plain size ${s.plain}`)
    if (hasTasks && (s.fit >= 2 ? s.tasks !== 'icon' : s.tasks !== 'full')) bad.push(`${at}: level ${s.fit} but tasks ${s.tasks}`)
    if (hasSize && (s.fit >= 3 ? s.size !== 'icon' : s.size !== 'full')) bad.push(`${at}: level ${s.fit} but size ${s.size}`)
    if (!s.endCut && s.rightGap !== null && Math.abs(s.rightGap) > 1) bad.push(`${at}: the right side ends ${s.rightGap}px from the footer's right edge`)
    if (s.label === 'cut' && s.fit < most) bad.push(`${at}: the mode's label shortens before the warnings give way (level ${s.fit})`)
    if (s.model === 'cut' && s.labelWidth > 1) bad.push(`${at}: the model shortens while the mode still has ${s.labelWidth}px of label`)
    if (s.ctx === 'cut' && s.labelWidth > 1) bad.push(`${at}: the context is cut while the mode still has ${s.labelWidth}px of label`)
    if (s.endCut && s.labelWidth > 1) bad.push(`${at}: the line is cut off while the mode still has ${s.labelWidth}px of label`)
    if (!s.endCut && !s.chipIcons) bad.push(`${at}: the mode's icon or caret is cut`)
    prev = s
  }
  return bad
}

;(async () => {
  for (const d of [userData, ws, claudeHome, codexHome]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, codexHome]) fs.mkdirSync(d, { recursive: true })
  lib.gitProject(alpha)
  // The fake trusts the project and the workspace folder, where the Assistant runs.
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase(), ws.toLowerCase()]))
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  // Every warning the footer has (#978): the context past a low Compact threshold, the transcript past 1 MB.
  cfg.settings.sessions = { ...cfg.settings.sessions, compactSuggestTokens: 10, transcriptWarnMB: 1 }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47916), CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.waitForProvider(inv, 'codex')
  // A price for the fake model, so the Claude Code agent has a cost.
  await inv('settings:setProviderPrices', 'claude-code', { 'claude-fake': { input: 1000, cachedInput: 100, cacheWrite: 1000, output: 1000 } })
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('alpha', { exact: true }).first().click()

  const claude = await lib.addAgent(inv, alpha, { name: 'Writer' })
  const codex = await lib.addAgent(inv, alpha, { name: 'Checker', provider: 'codex', permissionMode: 'approve-for-me' })
  const live = async (id) => (await inv('session:live')).find((s) => s.agentId === id)
  for (const a of [claude, codex]) await inv('session:start', alpha, { agentId: a.id })
  check('both agents start', !!(await until(async () => (await live(claude.id))?.status === 'ready' && (await live(codex.id))?.status === 'ready', 25000)))
  const key = lib.ptyKey(alpha, claude.id)
  // A turn that pads its transcript past 1 MB and leaves a background task running (ten minutes: past the suite's end).
  await inv('pty:write', key, 'hello window 1000 pad 1200 background 600')
  await lib.sleep(100)
  await inv('pty:write', key, '\r')
  await until(async () => (await live(claude.id))?.backgroundTasks > 0 && (await live(claude.id))?.transcriptBytes > 1024 * 1024, 20000)

  const footerOf = (name) => page.locator('.agent-pane:visible', { has: page.locator('.pane-header-bar', { hasText: name }) }).locator('.pane-footer-bar')
  const cf = footerOf('Writer')
  // Every item there: the context with its percentage, the cost, and the warnings (the context's, the transcript's size,
  // the background task).
  const ready = await until(async () => {
    const t = await cf.innerText().catch(() => '')
    return /ctx \d+%/.test(t) && /≈\$/.test(t) && /\d+(\.\d+)? MB/.test(t) && /1 background task/.test(t) && (await cf.locator('.foot-ctx.warn').count()) === 1
  }, 20000)
  check("the Claude Code agent's footer has every item", !!ready, await cf.innerText().catch(() => ''))
  check("the Codex agent's footer says Approve for me", /Approve for me/.test(await footerOf('Checker').innerText().catch(() => '')), await footerOf('Checker').innerText().catch(() => ''))
  // One agent at a time, so each footer has the pane's whole width to give up, at 125% too.
  // The switch is asynchronous (it saves the project's layout, then the workspace refreshes): a sweep started before it
  // has applied would measure a two-column pane's footer as the widest. Ready once the project says single and the
  // window shows one pane, as wide as the agents' area.
  await page.locator('.layout-switch button[aria-label="One at a time"]').click()
  const oneAtATime = async () => {
    const p = (await inv('workspace:get'))?.projects?.find((x) => x.path.toLowerCase() === alpha.toLowerCase())
    if (p?.config?.layout !== 'single') return false
    return page.evaluate(() => {
      const headers = [...document.querySelectorAll('.agent-pane .pane-header-bar')].filter((h) => h.getBoundingClientRect().width > 0)
      const area = document.querySelector('.agents-area')?.getBoundingClientRect().width ?? 0
      return headers.length === 1 && area > 0 && headers[0].getBoundingClientRect().width >= area - 2
    })
  }
  check('one at a time: the project and the window have switched', !!(await until(oneAtATime, HUNG_MS)))
  /** Shows the agent (one at a time), alone and at the pane's whole width; each sweep then waits for the footer to have measured each width it sets. */
  const show = async (name, tag) => {
    await lib.showAgent(page, name)
    const shown = await until(async () => (await footerOf(name).count()) === 1 && (await oneAtATime()), HUNG_MS)
    if (!shown) await page.screenshot({ path: path.join(lib.WORK, `footerfit-show-${tag}.png`) })
    check(`${name} is shown alone, at the pane's whole width (${tag})`, !!shown)
  }
  // The window's zoom is in its device pixel ratio once it has applied (the ratio at 100% is the screen's own).
  const ratio = () => page.evaluate(() => window.devicePixelRatio)
  const atFull = await ratio()
  const zoomed = (zoom) => until(async () => Math.abs((await ratio()) - atFull * zoom) < 0.01, HUNG_MS)

  for (const zoom of [1, 1.25]) {
    await app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z), zoom)
    await zoomed(zoom)
    const z = `${zoom * 100}%`
    // Claude Code: every step.
    await show('Writer', 'claude')
    const states = await page.evaluate(sweep, ['Writer', null, 120, -3])
    const bad = problems(states, { hasTasks: true, hasSize: true, hasPlain: false })
    check(`${z}: Claude Code footer: every step in order, nothing cut early, nothing overlapping`, !bad.length, bad.slice(0, 6).join('; '))
    const first = (fit) => states.find((s) => s.fit === fit)
    check(`${z}: …starts with everything in full, the right side at the right edge, space between the sides`, states[0].fit === 0 && states[0].tasks === 'full' && states[0].size === 'full' && states[0].ctx === 'full' && states[0].label === 'full' && !states[0].endCut && Math.abs(states[0].rightGap) <= 1 && states[0].between > 20, JSON.stringify(states[0]))
    check(`${z}: …then the background tasks are their icon, the rest in full`, !!first(2) && first(2).size === 'full' && first(2).ctx === 'full' && first(2).label === 'full' && !first(2).endCut, JSON.stringify(first(2)))
    check(`${z}: …then the transcript size its icon, the rest in full`, !!first(3) && first(3).ctx === 'full' && first(3).label === 'full' && !first(3).endCut, JSON.stringify(first(3)))
    const labelCut = states.find((s) => s.label === 'cut')
    check(`${z}: …then the mode's label shortens, its icon and caret stay, the context whole`, !!labelCut && labelCut.chipIcons && labelCut.ctx === 'full' && !labelCut.endCut, JSON.stringify(labelCut))
    const modelCut = states.find((s) => s.model === 'cut')
    check(`${z}: …then the model, the context still whole`, !!modelCut && modelCut.ctx === 'full' && modelCut.labelWidth <= 1, JSON.stringify(modelCut))
    check(`${z}: …and only very narrow is the line cut off`, states.at(-1).endCut && states.at(-1).labelWidth <= 1, JSON.stringify(states.at(-1)))
    // Widening brings the text back, step by step.
    const back = await page.evaluate(sweep, ['Writer', 120, states[0].w, 8])
    check(`${z}: widening brings each back`, back.at(-1).fit === 0 && back.at(-1).tasks === 'full' && back.at(-1).size === 'full' && back.at(-1).ctx === 'full' && Math.abs(back.at(-1).rightGap) <= 1 && back.every((s, i) => i === 0 || s.fit <= back[i - 1].fit), JSON.stringify(back.at(-1)))
    // Codex: its longest label shortens before anything is cut off.
    await show('Checker', 'codex')
    const cx = await page.evaluate(sweep, ['Checker', null, 100, -3])
    const cxBad = problems(cx, { hasTasks: cx.some((s) => s.tasks), hasSize: cx.some((s) => s.size), hasPlain: cx.some((s) => s.plain) })
    check(`${z}: Codex footer: in order, nothing overlapping, its icon and caret always shown`, !cxBad.length, cxBad.slice(0, 6).join('; '))
    // A level flipping back and forth on a rounding edge would loop until React gives up (the window's error view).
    check(`${z}: the window survives every width (no render loop)`, (await page.locator('.error-boundary').count()) === 0 && (await lib.agentCount(page)) === 2)
    check(`${z}: …"Approve for me" in full when there is room, shortened when not`, cx[0].label === 'full' && cx.some((s) => s.label === 'cut' && s.chipIcons), JSON.stringify(cx.find((s) => s.label === 'cut')))
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  await zoomed(1)

  // Screenshots of each step, both themes, with nothing over the footer (the long conversation's notification, a tip).
  await page.addStyleTag({ content: '.toasts, .tip-card { display: none !important; }' })
  await show('Writer', 'claude')
  const all = await page.evaluate(sweep, ['Writer', null, 120, -3])
  const shots = [
    ['0-full', (s) => s.fit === 0],
    ['1-tasks', (s) => s.fit === 2],
    ['2-size', (s) => s.fit === 3 && s.label === 'full'],
    ['3-label', (s) => s.label === 'cut' && s.model === 'full'],
    ['4-model', (s) => s.model === 'cut' && !s.endCut]
  ]
  const wants = shots.map(([, pred]) => all.find(pred))
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await until(async () => (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === theme, HUNG_MS)
    for (let i = 0; i < shots.length; i++) {
      const want = wants[i]
      if (!want) continue
      // The footer at that width, once it has measured it and settled: the screenshot shows the step the sweep found.
      const [at] = await page.evaluate(sweep, ['Writer', want.w, want.w, -1, true])
      check(`screenshot ${shots[i][0]} (${theme}) shows its step`, at.w === want.w && at.fit === want.fit && at.label === want.label && !at.overlaps.length, JSON.stringify(at))
      const box = await cf.boundingBox()
      await page.screenshot({ path: path.join(lib.WORK, `footerfit-${shots[i][0]}-${theme}.png`), clip: { x: box.x, y: box.y - 4, width: Math.max(box.width, 200), height: box.height + 8 } })
    }
    await cf.evaluate((el) => (el.style.width = ''))
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await until(async () => (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark', HUNG_MS)

  // --- The same layout everywhere the footer is (#1013): the pane (above), the focus view and the Assistant's panel.
  /** The footer as it is at its own width: the right side at the right edge, space between the sides, nothing over another. */
  const layoutOk = (s) => !!s && s.fit === 0 && !s.endCut && Math.abs(s.rightGap) <= 1 && s.between > 20 && !s.overlaps.length && s.ctx === 'full'
  await page.locator('.view-switch [data-view="tiles"]').click()
  const writerTile = page.locator('.agent-tile', { has: page.locator('.tile-name', { hasText: /^Writer$/ }) })
  await until(async () => (await writerTile.count()) === 1, HUNG_MS)
  await writerTile.click()
  const inFocus = await until(async () => (await page.locator('.agents-area.shown.tile-focus').count()) === 1 && (await footerOf('Writer').count()) === 1, HUNG_MS)
  check("Writer's focus view is shown", !!inFocus)
  const [focusState] = await page.evaluate(sweep, ['Writer', null, null, -1])
  check('the focus view: the same layout, size · ctx · cost at the right edge', layoutOk(focusState), JSON.stringify(focusState))

  // The Assistant, running the fake Claude Code, after a turn (so it has a context and a cost).
  const home = (await inv('workspace:refresh')).assistant.path
  const assistantLive = async () => (await inv('session:live')).find((x) => x.projectPath.toLowerCase() === home.toLowerCase() && x.agentId === 'assistant')
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Alt+I')
  const aHeader = page.locator('.assistant-panel .assistant-header')
  await until(async () => (await aHeader.count()) === 1, HUNG_MS)
  await aHeader.getByRole('button', { name: 'Start', exact: true }).click()
  check('the Assistant runs', !!(await until(async () => (await assistantLive())?.status === 'ready', 25000)))
  await inv('pty:write', lib.ptyKey(home, 'assistant'), 'hello')
  await lib.sleep(300) // on purpose: the fake reads a typed line before its Enter, as a CLI does
  await inv('pty:write', lib.ptyKey(home, 'assistant'), '\r')
  const af = page.locator('.assistant-footer .pane-footer-bar')
  const aReady = await until(async () => {
    const t = await af.innerText().catch(() => '')
    return /ctx /.test(t) && /\$/.test(t) && (await af.locator('.foot-size').count()) === 1
  }, 20000)
  check("the Assistant's footer has its size, context and cost", !!aReady, await af.innerText().catch(() => ''))
  const [assistantState] = await page.evaluate(sweep, ['.assistant-footer .pane-footer-bar', null, null, -1])
  check("the Assistant's panel: the same layout, size · ctx · cost at the right edge", layoutOk(assistantState), JSON.stringify(assistantState))
  // Its transcript's size, under the warn size: plain, and the first to go as it narrows.
  const aStates = await page.evaluate(sweep, ['.assistant-footer .pane-footer-bar', null, 120, -3])
  const aBad = problems(aStates, { hasTasks: false, hasSize: false, hasPlain: true })
  check("the Assistant's footer narrowed: in order, nothing overlapping", !aBad.length, aBad.slice(0, 6).join('; '))
  const plainGone = aStates.find((s) => s.fit === 1)
  check("…its plain transcript size shows, then goes first, the mode's label and the context still whole", aStates[0].plain === 'full' && !!plainGone && plainGone.plain === 'icon' && plainGone.label === 'full' && plainGone.ctx === 'full' && Math.abs(plainGone.rightGap) <= 1, JSON.stringify([aStates[0], plainGone]))

  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await until(async () => (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === theme, HUNG_MS)
    for (const [tag, loc] of [['focus', footerOf('Writer')], ['assistant', af]]) {
      const box = await loc.boundingBox()
      await page.screenshot({ path: path.join(lib.WORK, `footerfit-place-${tag}-${theme}.png`), clip: { x: box.x, y: box.y - 4, width: box.width, height: box.height + 8 } })
    }
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await inv('session:stop', home, 'assistant').catch(() => undefined)

  for (const a of [claude, codex]) await inv('session:stop', alpha, a.id).catch(() => undefined)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
