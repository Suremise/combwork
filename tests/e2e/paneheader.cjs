// An agent pane's header (#977): its state mark, its name, its status and its card, then Stop (Resume, or New Session
// with nothing to resume, while it isn't running) and ⋯, which has everything else. At every width, at 100% and 125%
// zoom, in one or two columns, running and stopped: Stop and ⋯ are always shown, fully inside the header and apart; the
// status gives way first, then the name; nothing spills out. Pictured in both themes. ⋯ (clicked, right-click on the
// header, and the palette's Agent Menu… from the keyboard) has Compact…, Hand Over to…, Review Changes (the worktree's branch as
// its detail) and Merge… (what is left to merge as its detail, whatever the count: •, 1, 12, 1234), Agent Settings and Remove.
// The agent's provider is in its name's tooltip; the worktree is its icon on the agent's tab only (#287), its branch,
// folder and base in one tooltip on hover and keyboard focus. Compact, from ⋯: the status says it is compacting for the
// whole compaction, Compact… is unavailable meanwhile and a second one is refused; it ends when it finishes, fails or is
// cancelled. The agents run the fake Claude Code (fake-claude/). Dev build, throwaway profile, workspace and
// CLAUDE_CONFIG_DIR.
// Dev build only (#1580): it starts this checkout's Electron itself, and its long-named agent and Three are 0.9
// worktree agents (agents:testLegacy, refused by a packaged build), for the header's branch.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000
// A compaction's hung-run bound: under load the fake took about 60 s to read the long focus Combwork typed (#725).
const COMPACT_HUNG_MS = 180000

const userData = path.join(lib.WORK, 'paneheader-profile')
const ws = path.join(lib.WORK, 'paneheader-ws')
const claudeHome = path.join(lib.WORK, 'paneheader-claude-home')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
// Git in the test repositories, waiting out the Combwork under test's own git (lib.git, #199).
const git = (cwd, ...a) => lib.git(cwd, ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a])

/**
 * `n` commits on top of a worktree's branch, each changing n.txt (fast-import: a four-digit count in a moment; empty
 * commits would count as merged already), and the worktree's files brought up to date.
 */
function commits(wt, n) {
  const branch = git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
  const head = git(wt, 'rev-parse', 'HEAD').trim()
  let s = ''
  for (let i = 0; i < n; i++) {
    const msg = `c${i}`
    const text = `${i}\n`
    s += `commit refs/heads/${branch}\ncommitter t <t@t> ${1700000000 + i} +0000\ndata ${msg.length}\n${msg}\n${i === 0 ? `from ${head}\n` : ''}M 644 inline n.txt\ndata ${text.length}\n${text}\n`
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: wt, input: s, env: lib.gitEnv() })
  git(wt, 'reset', '-q', '--hard', 'HEAD')
}

;(async () => {
  for (const d of [userData, ws, ws + '.worktrees', claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  // Every read of the agents' input recorded, for typeLine (#1560).
  lib.logFakeInput(claudeHome)
  lib.gitProject(alpha)
  lib.gitProject(beta)
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  // The smallest terminal font, so two columns stay two down to 150 px panes: narrower than a terminal fits, they would
  // show one at a time (#1037).
  cfg.settings.appearance = { ...cfg.settings.appearance, terminalFontSize: 8 }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47908), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  const HEIGHT = 850
  let viewport = 1400
  await lib.fitWindow(app, page, { width: viewport, height: HEIGHT })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const until = (fn, ms = HUNG_MS) => lib.until(fn, ms)
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)

  await page.getByText('alpha', { exact: true }).first().click()
  // A running worktree agent with a long name, branch and card, and a stopped one beside it.
  const long = await lib.addAgent(inv, alpha, { name: 'Agent with a rather long name', location: 'new-worktree' })
  const other = await lib.addAgent(inv, alpha, { name: 'Three', location: 'new-worktree' })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha, long.worktree.path, other.worktree.path].map((p) => p.toLowerCase())))
  await inv('tasks:create', { title: 'A card with a long title that takes up a lot of the header', project: 'alpha', agent: long.id, column: 'doing' })
  await inv('session:start', alpha, { agentId: long.id })
  check('the agent starts', !!(await until(async () => (await live(long.id))?.status === 'ready', 15000)))
  const key = lib.ptyKey(alpha, long.id)
  let turns = 0
  // A turn, typed once the fake takes prompts and waited for by its own end (#684, lib.fakePrompts), and over on the
  // fake's side too: Compact types /compact next, which the fake drops while it still ends the turn (#679: Combwork showed it
  // compacting, and it never was ready again).
  const prompts = lib.fakePrompts(inv, key, () => live(long.id), { home: claudeHome })
  const turn = async () => {
    turns++
    check(`turn ${turns} is answered`, !!(await prompts.say(`turn ${turns}`)))
    check(`…and the fake takes input again`, !!(await lib.until(prompts.takesPrompts, lib.TURN_HUNG_MS)))
  }
  await turn()
  await page.getByRole('button', { name: 'Two columns' }).click()
  await until(async () => (await page.locator('.pane-header-bar').count()) === 2, 5000)

  const header = (a) => page.locator('.pane-header-bar', { has: page.locator('.agent-name', { hasText: a.name }) })
  const tips = async () => (await page.locator('.tip').allInnerTexts()).map((t) => t.trim())
  const away = () => page.locator('.agents-area').hover({ position: { x: 40, y: 300 }, force: true })

  // What the header holds: no provider icon, worktree mark, Compact or Merge… any more (#977), and its name's tooltip
  // says its provider.
  for (const a of [long, other]) {
    const h = header(a)
    const has = await h.evaluate((el) => ({ provider: !!el.querySelector('.provider-icon, [class*="provider-"]'), branch: !!el.querySelector('.agent-branch'), compact: !!el.querySelector('[aria-label="Compact"]'), merge: !!el.querySelector('[aria-label="Merge…"]'), more: !!el.querySelector('.pane-more') }))
    check(`${a.name}: the header has ⋯, and no provider icon, worktree mark, Compact or Merge…`, has.more && !has.provider && !has.branch && !has.compact && !has.merge, JSON.stringify(has))
  }
  // Its state mark (#973) comes first: both agents are idle (a ring), named by their state for screen readers. The turn's
  // end is main's (session:live); the window's mark follows once its status event is in, read until it is (HI-2194:
  // under load, read at once, it still said Working).
  for (const a of [long, other]) {
    const read = () =>
      header(a).evaluate((el) => {
        const m = el.querySelector('.state-mark')
        return m ? { first: el.firstElementChild?.contains(m), idle: m.classList.contains('idle'), name: m.getAttribute('aria-label') } : null
      })
    const ok = (m) => !!m && m.first && m.idle && m.name === 'Idle'
    let mark = null
    const first = await read()
    const t = Date.now()
    check(`${a.name}: the header starts with its state mark, a ring while idle`, !!(await until(async () => ok((mark = await read())))), JSON.stringify(mark))
    if (!ok(first)) console.log(`  (${a.name}'s mark read ${JSON.stringify(first)} at first, idle ${Date.now() - t} ms later)`)
  }
  await header(long).locator('.agent-name').hover()
  check("the name's tooltip says the agent and its provider (#975: with what its strip tab said)", !!(await until(async () => (await tips()).some((t) => t.startsWith(`${long.name} (Claude Code): `)), HUNG_MS)), JSON.stringify(await tips()))
  await away()
  await until(async () => (await tips()).length === 0, HUNG_MS)

  /** #287, #975: the worktree's branch, folder and base are in the name's tooltip; no header shows worktree text. */
  const worktreeMark = async (tag) => {
    const full = (t) => t.length === 1 && t[0].includes(`Worktree ${long.worktree.path} on ${long.worktree.branch}, branched from`)
    await away()
    await until(async () => (await tips()).length === 0, HUNG_MS)
    await header(long).locator('.agent-name').hover()
    await until(async () => full(await tips()), HUNG_MS)
    check(`${tag}hovered, the name's tooltip has its worktree, branch and base`, full(await tips()), JSON.stringify(await tips()))
    await away()
    await until(async () => (await tips()).length === 0, HUNG_MS)
    check(`${tag}no worktree text in any header`, (await page.locator('.pane-header-bar').allInnerTexts()).every((t) => !t.includes('hive/')))
  }
  await worktreeMark('')

  // One colour per action (#344): the running agent's Stop, the stopped one's New Session (nothing to resume yet).
  const actOf = (a, name) => header(a).getByRole('button', { name, exact: true }).evaluate((b) => [...b.classList].filter((c) => c.startsWith('act-')).join(' ')).catch(() => null)
  const acts = [await actOf(long, 'Stop'), await actOf(other, 'New Session')]
  check("the headers' Stop and New Session wear their actions' colours", JSON.stringify(acts) === JSON.stringify(['act-stop', 'act-start']), JSON.stringify(acts))
  check('nothing to resume: no Resume on the stopped header', (await header(other).getByRole('button', { name: 'Resume', exact: true }).count()) === 0)

  /** The menu's entries, as label (detail). */
  const menuItems = async () => page.locator('.menu .menu-item, .menu .menu-header').evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()))
  const closeMenu = async () => {
    await page.keyboard.press('Escape')
    await until(async () => (await page.locator('.menu').count()) === 0, HUNG_MS)
  }
  /** Opens agent a's ⋯ and returns its entries. */
  const moreMenu = async (a) => {
    await header(a).getByRole('button', { name: 'More', exact: true }).click()
    await until(async () => (await page.locator('.menu .menu-item').count()) > 0, HUNG_MS)
    return menuItems()
  }
  const has = (items, start) => items.some((t) => t.startsWith(start))
  let items = await moreMenu(long)
  check("a running agent's ⋯ has Stop, Compact…, Archive and Start New…, Hand Over to…, Review Changes (its branch), Merge…, Agent Settings and Remove", ['Stop', 'Compact…', 'Archive and Start New…', 'Hand Over to…', `Review Changes ${long.worktree.branch}`, 'Merge…', 'Agent Settings', 'Remove Agent…'].every((s) => has(items, s)), JSON.stringify(items))
  await closeMenu()
  items = await moreMenu(other)
  check("a stopped agent's ⋯ has Resume, Resume a Session…, New Session and Merge…", ['Resume', 'Resume a Session…', 'New Session', 'Merge…'].every((s) => has(items, s)), JSON.stringify(items))
  await closeMenu()
  // Right-click on the header: the same menu.
  await header(other).locator('.agent-name').click({ button: 'right' })
  await until(async () => (await page.locator('.menu .menu-item').count()) > 0, HUNG_MS)
  check('right-click on the header opens the same menu', JSON.stringify(await menuItems()) === JSON.stringify(items), JSON.stringify(await menuItems()))
  // An action's menu entry hovered (which also makes it the keyboard's choice): its own wash and icon colour, not the accent.
  const removeItem = page.locator('.menu .menu-item', { hasText: 'Remove Agent…' })
  await removeItem.hover()
  /** What a CSS colour (`var(--x)`) computes to where `el` is. */
  const tokenAt = (loc, value) =>
    loc.evaluate((el, v) => {
      const probe = document.createElement('span')
      probe.style.color = v
      el.appendChild(probe)
      const c = getComputedStyle(probe).color
      probe.remove()
      return c
    }, value)
  const on = await removeItem.evaluate((el) => ({ active: el.classList.contains('active'), background: getComputedStyle(el).backgroundColor, icon: getComputedStyle(el.querySelector('.codicon')).color }))
  check("a hovered Remove Agent… keeps Remove's colour, not the accent", on.active && on.icon === (await tokenAt(removeItem, 'var(--act-remove-fg)')) && on.background !== (await tokenAt(removeItem, 'var(--accent)')), JSON.stringify(on))
  await closeMenu()
  // From the keyboard: the palette's Agent Menu… opens the focused agent's ⋯, on its first entry.
  await header(long).locator('.agent-name').click()
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Shift+P')
  await page.locator('.palette input').fill('Agent Menu')
  await until(async () => (await page.locator('.palette-item', { hasText: 'Agent Menu…' }).count()) > 0, HUNG_MS)
  await page.keyboard.press('Enter')
  check("the palette's Agent Menu… opens the focused agent's ⋯ on its first entry", !!(await until(async () => (await page.locator('.menu .menu-item.active').count()) === 1 && has(await menuItems(), 'Stop'), HUNG_MS)), JSON.stringify(await menuItems()))
  const anchor = await page.evaluate(() => {
    const m = document.querySelector('.menu')?.getBoundingClientRect()
    const b = [...document.querySelectorAll('.pane-header-bar')].find((h) => h.textContent.includes('rather long'))?.querySelector('.pane-more')?.getBoundingClientRect()
    return m && b ? Math.abs(m.top - b.bottom) < 8 : false
  })
  check('…under its ⋯', anchor)
  await closeMenu()

  /** Everything wrong with a header's layout at its width. */
  const inspect = (a) =>
    header(a).evaluate((h) => {
      const box = h.getBoundingClientRect()
      const bad = []
      const inside = (r, o, what) => {
        if (r.width === 0) bad.push(`${what} has no width`)
        else if (r.left < o.left - 0.5 || r.right > o.right + 0.5) bad.push(`${what} ${Math.round(r.left)}..${Math.round(r.right)} outside ${Math.round(o.left)}..${Math.round(o.right)}`)
      }
      if (h.scrollWidth > h.clientWidth) bad.push(`header content ${h.scrollWidth} wider than ${h.clientWidth}`)
      const controls = [...h.querySelectorAll(':scope > .tip-wrap > .pane-btn, :scope > .tip-wrap > .pane-more')]
      if (controls.length !== 2) bad.push(`${controls.length} controls, not Stop's place and ⋯`)
      let prev = null
      for (const b of controls) {
        const name = b.getAttribute('aria-label')
        const r = b.getBoundingClientRect()
        inside(r, box, name)
        if (b.scrollWidth > b.clientWidth) bad.push(`${name}: content ${b.scrollWidth} wider than ${b.clientWidth}`)
        if (prev && r.left < prev.right) bad.push(`${name} overlaps the control before it`)
        prev = r
      }
      // The agent's details end before the first control.
      const first = controls[0]?.getBoundingClientRect()
      for (const d of h.querySelectorAll('.agent-name, .pane-status, .card-chip, :scope > .tip-wrap:has(> .review-mark), :scope > .tip-wrap:has(> .safeguard-mark)')) {
        const r = d.getBoundingClientRect()
        if (first && r.width > 0 && r.right > first.left + 0.5) bad.push(`${d.className} runs under the controls`)
      }
      const name = h.querySelector('.agent-name').getBoundingClientRect().width
      const status = h.querySelector('.pane-status')?.getBoundingClientRect().width ?? 0
      return { width: h.clientWidth, bad, name, status }
    })
  /** A picture of both headers. */
  const shot = async (file) => {
    const box = await page.evaluate(() => {
      const r = [...document.querySelectorAll('.pane-header-bar')].map((h) => h.getBoundingClientRect())
      return { x: Math.min(...r.map((b) => b.left)), y: Math.min(...r.map((b) => b.top)), width: Math.max(...r.map((b) => b.right)) - Math.min(...r.map((b) => b.left)), height: 30 }
    })
    for (const k of Object.keys(box)) box[k] *= zoom
    // Nothing focused (a focus ring on ⋯ isn't what the picture is of).
    await page.evaluate(() => document.activeElement?.blur())
    // The mouse stays where the last click was, and resizing moves controls under it: their tooltip would cover the
    // headers. Into the panes below them, and wait for it to go.
    await page.mouse.move(box.x + 20 * zoom, box.y + 200 * zoom)
    await until(async () => (await tips()).length === 0, HUNG_MS)
    await page.screenshot({ path: path.join(lib.WORK, file), clip: box })
  }
  let zoom = 1
  /** Sizes the page so agent a's header (the running one's, unless said) is `target` CSS pixels wide. */
  const widthTo = async (target, a = long) => {
    for (let i = 0; i < 8; i++) {
      const w = (await inspect(a)).width
      if (w === target) return true
      viewport = Math.max(200, Math.round(viewport + (target - w) * zoom * 2))
      await page.setViewportSize({ width: viewport, height: HEIGHT })
      // A short bound on purpose: a size the window can't take (its minimum) leaves the width as it is, and the next step tries again.
      await until(async () => (await inspect(a)).width !== w, 1000)
    }
    for (let i = 0; i < 40; i++) {
      const w = (await inspect(a)).width
      if (w === target) return true
      viewport += w < target ? 1 : -1
      await page.setViewportSize({ width: viewport, height: HEIGHT })
      // A short bound on purpose, as above: one pixel the window can't take changes nothing.
      await until(async () => (await inspect(a)).width !== w, 500)
    }
    return (await inspect(a)).width === target
  }
  /** Both headers lay out with nothing out of place. */
  const fits = async (what) => {
    for (const a of [long, other]) {
      const r = await until(async () => {
        const x = await inspect(a)
        return x.bad.length ? null : x
      }, HUNG_MS)
      const x = r ?? (await inspect(a))
      check(`${what}: ${a.name === 'Three' ? 'stopped' : 'running'} agent's header fits at ${x.width}px`, !x.bad.length, x.bad.join('; '))
    }
  }
  /** Sets both agents' unmerged work: n commits, • for an uncommitted file alone, 0 for none. */
  const setCount = async (n) => {
    const base = git(alpha, 'rev-parse', 'HEAD').trim()
    for (const a of [long, other]) {
      git(a.worktree.path, 'reset', '-q', '--hard', base)
      fs.rmSync(path.join(a.worktree.path, 'dirty.txt'), { force: true })
      if (n === '•') fs.writeFileSync(path.join(a.worktree.path, 'dirty.txt'), 'x')
      else if (n) commits(a.worktree.path, n)
      await inv('agents:branchStatus', alpha, a.id)
    }
    const ahead = typeof n === 'number' ? n : 0
    const dirty = n === '•' ? 1 : 0
    const told = await until(async () => {
      const all = await inv('agents:branchStatuses')
      return [long, other].every((a) => {
        const st = all.find((b) => b.agentId === a.id)?.status
        return st?.ahead === ahead && st?.dirty === dirty
      })
    }, 8000)
    return !!told
  }
  /** The theme, for the pictures (the layout checks don't depend on it). */
  const theme = async (t) => {
    await inv('settings:update', { appearance: { theme: t } })
    await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme ?? document.body.className)).includes(t), HUNG_MS)
  }

  // Merge…'s detail in ⋯ says what is left to merge, whatever the count.
  for (const n of ['•', 1, 12, 1234]) {
    check(`the unmerged work is ${n}`, await setCount(n))
    const want = n === '•' ? 'uncommitted' : `${n.toLocaleString('en')} commit`
    const merge = async () => {
      const all = await moreMenu(long)
      await closeMenu()
      return all.find((t) => t.startsWith('Merge…')) ?? ''
    }
    const got = await until(async () => ((await merge()).includes(want) ? merge() : null), HUNG_MS)
    check(`…Merge… in ⋯ says so (${want})`, !!got, String(got))
  }

  // Every width, both panes in turn: the status gives way first, then the name; Stop and ⋯ stay.
  const WIDTHS = [900, 600, 420, 320, 240, 180, 150]
  const atWidths = async (label, prefix) => {
    for (const [a, role] of [[long, 'running'], [other, 'stopped']]) {
      let prev = null
      for (const w of WIDTHS) {
        check(`${label}${role} pane's header sized to ${w}px`, await widthTo(w, a))
        await fits(`${label}${role} pane at ${w}px`)
        const r = await inspect(a)
        // Narrower: the name never shrinks while the status still has room to give.
        if (prev && r.name < prev.name - 0.5) check(`${label}${role} at ${w}px: the name shortens only once the status has given way`, r.status <= 1 || prev.status <= 1, JSON.stringify({ prev, r }))
        prev = r
        if (![900, 420, 320, 240].includes(w)) continue
        await shot(`${prefix}-${role}-${w}.png`)
        await theme('light')
        await fits(`${label}light theme, ${role} pane at ${w}px`)
        await shot(`${prefix}-${role}-${w}-light.png`)
        await theme('dark')
      }
    }
  }
  await atWidths('', 'paneheader')

  // An unknown state (#648), with both shields (an automatic review, #606's safeguard switch), sent to the window as
  // Combwork sends a status: at every width Stop and ⋯ stay whole and the shields give way with the status; Mark idle is
  // beside the status from 300 px, and below only in ⋯ (with the safeguard's note), whose dot then says so.
  const sendStatus = (state) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'session-status', state })
  const known = await live(long.id)
  await sendStatus({ ...known, status: 'working', turn: { ...known.turn, state: 'unknown', silentSince: new Date(Date.now() - 6 * 60000).toISOString() }, review: 'a long command under review', safeguard: { at: new Date().toISOString(), model: 'claude-fake', tools: [], stops: 1, switched: { from: 'claude-fake', to: 'claude-other', at: new Date().toISOString() } } })
  check('an unknown state shows in the header, with both shields', !!(await until(async () => (await header(long).locator('.unknown-state').count()) === 1 && (await header(long).locator('.review-mark, .safeguard-mark').count()) === 2, HUNG_MS)))
  for (const w of WIDTHS) {
    check(`unknown state: header sized to ${w}px`, await widthTo(w))
    await fits(`unknown state at ${w}px`)
    const placed = await until(async () => {
      const r = { markIdle: await header(long).getByRole('button', { name: 'Mark idle' }).count(), dot: await header(long).locator('.pane-more-badge').count() }
      return (w >= 300 ? r.markIdle === 1 : r.markIdle === 0 && r.dot === 1) && r
    }, HUNG_MS)
    check(`unknown state at ${w}px: Mark idle ${w >= 300 ? 'beside the status' : "in ⋯, with ⋯'s dot"}`, !!placed)
    if (w !== 150) continue
    await shot('paneheader-unknown-150.png')
    await theme('light')
    await fits('unknown state, light theme, at 150px')
    await shot('paneheader-unknown-150-light.png')
    await theme('dark')
  }
  await header(long).getByRole('button', { name: 'More', exact: true }).click()
  check('…and ⋯ offers Mark idle and says what the safeguard did', !!(await until(async () => (await page.locator('.menu .menu-item', { hasText: 'Mark idle' }).count()) === 1 && (await page.locator('.menu .menu-item', { hasText: 'claude-other' }).count()) === 1, HUNG_MS)), JSON.stringify(await menuItems()))
  await closeMenu()
  // Back to what Combwork knows of it.
  await sendStatus(await live(long.id))
  check('the unknown state is gone again', !!(await until(async () => (await header(long).locator('.unknown-state').count()) === 0, HUNG_MS)))

  // Hidden while the width changes: another project is shown, the window grows, alpha comes back.
  await widthTo(300)
  await page.getByText('beta', { exact: true }).first().click()
  await until(async () => !(await header(long).isVisible().catch(() => false)), 5000)
  viewport += 600
  await page.setViewportSize({ width: viewport, height: HEIGHT })
  await page.getByText('alpha', { exact: true }).first().click()
  await until(() => header(long).isVisible(), 5000)
  await fits('shown again after growing while hidden')

  // One column: the focused header gets the whole width.
  await header(long).locator('.agent-name').click()
  await page.getByRole('button', { name: 'One at a time' }).click()
  await until(async () => (await page.locator('.pane-header-bar').count()) === 1, 5000)
  const single = await inspect(long)
  check('one column: it fits at its full width', !single.bad.length, JSON.stringify(single))
  await page.getByRole('button', { name: 'Two columns' }).click()
  await until(async () => (await page.locator('.pane-header-bar').count()) === 2, 5000)
  await fits('two columns again')

  // Display scaling: the same widths in CSS pixels at 125%.
  zoom = 1.25
  await app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z), zoom)
  await until(async () => (await page.evaluate(() => window.devicePixelRatio)) >= 1.24, HUNG_MS)
  await atWidths('125%: ', 'paneheader-125')
  await worktreeMark('125%: ')
  zoom = 1
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  await setCount(0)
  await widthTo(700)

  // Compact, from ⋯.
  const statusOf = () => header(long).locator('.pane-status').innerText().catch(() => '')
  const compactItem = async () => {
    await header(long).getByRole('button', { name: 'More', exact: true }).click()
    const item = page.locator('.menu .menu-item', { hasText: 'Compact…' })
    await until(() => item.isVisible(), HUNG_MS)
    return item
  }
  const compactOffered = async () => {
    const item = await compactItem()
    const off = await item.evaluate((el) => el.classList.contains('disabled'))
    await closeMenu()
    return !off
  }
  const compactVia = async (focus) => {
    await (await compactItem()).click()
    const dialog = page.locator('[role=dialog]', { hasText: 'Compact alpha' })
    await until(() => dialog.isVisible(), HUNG_MS)
    await dialog.locator('textarea').fill(focus)
    await dialog.getByRole('button', { name: 'Compact', exact: true }).click()
    return !!(await until(async () => (await dialog.count()) === 0, 30000))
  }
  const LONG_FOCUS = `hold 6 ${'keep the header decisions, the merge badge findings and the open questions; drop the test runs. '.repeat(9)}`
  /** Compactions in the fake's transcripts so far: each one it runs writes a compact_boundary. */
  const compactionsRun = () => {
    const dir = path.join(claudeHome, 'projects')
    const files = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.jsonl')) : []
    return files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('"compact_boundary"').length - 1).reduce((x, y) => x + y, 0)
  }
  /** The fake's last compaction has ended and it has drawn its prompt again: it takes prompts (it drops them while busy). */
  const promptAfterCompaction = async () => {
    const b = await prompts.screen()
    const at = b.lastIndexOf('Conversation compacted.')
    return at > b.lastIndexOf('Compacting conversation…') && b.indexOf('❯', at) > at
  }
  await turn()
  check('idle: Compact… is offered in ⋯', await compactOffered())
  check('the dialog closes after a long focus is entered', await compactVia(LONG_FOCUS))
  check('the agent is compacting', !!(await until(async () => (await live(long.id))?.statusMessage === 'Compacting the conversation…', 5000)))
  check('its header says so', !!(await until(async () => (await statusOf()).includes('Compacting'), HUNG_MS)), await statusOf())
  check('Compact… is unavailable meanwhile', !(await compactOffered()))
  await fits('while compacting')
  const again = await inv('session:compact', alpha, 'again', long.id).then(() => 'sent', (e) => String(e.message ?? e))
  check('a second compaction is refused', again.includes('already compacting'), again)
  // The compaction it asked for has run, and the fake takes prompts again (#725). Bounded only for a hung run.
  check('the compaction ran', !!(await until(() => compactionsRun() >= 1, COMPACT_HUNG_MS)), String(compactionsRun()))
  check('the agent is ready once it has compacted', !!(await until(async () => (await live(long.id))?.status === 'ready' && (await promptAfterCompaction()), COMPACT_HUNG_MS)), JSON.stringify({ status: (await live(long.id))?.status, screen: (await prompts.screen()).slice(-200) }))
  check('and Compact… is offered again', !!(await until(compactOffered, HUNG_MS)))
  check('exactly one compaction ran', compactionsRun() === 1, String(compactionsRun()))

  // A compaction that fails: it ends, and the agent is ready.
  await turn()
  check('a failing compaction is sent', await compactVia('compactfail hold 2'))
  check('after the failure the agent is ready', !!(await until(async () => (await live(long.id))?.status === 'ready', 15000)))
  check('and Compact… is offered', !!(await until(compactOffered, HUNG_MS)))

  // Cancelled by stopping the agent: Resume is offered in Stop's place.
  await turn()
  check('a long compaction is sent', await compactVia('hold 30'))
  check('it is compacting', !!(await until(async () => (await live(long.id))?.statusMessage === 'Compacting the conversation…', 5000)))
  await inv('session:stop', alpha, long.id)
  check("stopped mid-compaction: the header offers Resume in Stop's place", !!(await until(() => header(long).getByRole('button', { name: 'Resume', exact: true }).isVisible(), HUNG_MS)))
  check("…in Resume's colour", (await actOf(long, 'Resume')) === 'act-resume')
  await fits('stopped after a cancelled compaction')

  // A new session from ⋯: Stop is back, and a compaction with nothing to compact ends by itself.
  await header(long).getByRole('button', { name: 'More', exact: true }).click()
  await page.locator('.menu .menu-item', { hasText: 'New Session' }).click()
  check('a new session starts', !!(await until(async () => (await live(long.id))?.status === 'ready', 15000)))
  check('Stop is back', !!(await until(() => header(long).getByRole('button', { name: 'Stop', exact: true }).isVisible(), HUNG_MS)))
  await inv('session:compact', alpha, '', long.id)
  check('nothing to compact: it ends by itself', !!(await until(async () => (await live(long.id))?.status === 'ready' && !(await statusOf()).includes('Compacting'), 8000)))

  await inv('session:stop', alpha, long.id).catch(() => undefined)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
