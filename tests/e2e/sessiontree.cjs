// The Sessions tab as a tree (#239): provider → agent → session → the sub-sessions it started (Codex guardian reviews
// nest under their session; one whose session isn't listed stays with its own), counts on every branch, branches
// folded except the focused agent's and remembered per project, search that filters the tree and opens what matches,
// the Files tree's keyboard, markers and a disabled Resume (with the reason) on sessions that can't be resumed, and
// Archive all / Delete all on any branch: one confirmation, a running session and a file another program holds open
// skipped and said so, the rest done, the CLIs' own transcripts untouched.
// Fake Claude Code (fake-claude/) runs the one live session; Codex's rollouts are fixtures in a test CODEX_HOME (the
// fake Codex is its CLI, so it counts as installed). Dev build, throwaway profile, workspace, CLAUDE_CONFIG_DIR and
// CODEX_HOME; quiet test copy.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const { sessionsOf, putSessions } = require('./storeDocs.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000
// The whole list held 20 s by the test seam below, then read: a bound for a hung read beyond that.
const HELD_LIST_HUNG_MS = 40000

const userData = path.join(lib.WORK, 'sessiontree-profile')
const ws = path.join(lib.WORK, 'sessiontree-ws')
const claudeHome = path.join(lib.WORK, 'sessiontree-claude-home')
const codexHome = path.join(lib.WORK, 'sessiontree-codex-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

const id = (n) => `0f5c2a8e-2222-4333-8444-5555666${String(n).padStart(5, '0')}`
const at = (h) => new Date(Date.UTC(2026, 9, 4, h, 0, 0)).toISOString()
const old = new Date(Date.UTC(2026, 9, 4, 0, 0, 0))
/** A Claude Code transcript (Combwork's backup of it, or the CLI's own). */
const claudeLines = (sid, h, text) =>
  [
    { type: 'user', sessionId: sid, timestamp: at(h), message: { role: 'user', content: text } },
    { type: 'assistant', sessionId: sid, requestId: `r${h}`, timestamp: at(h), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 50 } } }
  ]
    .map((l) => JSON.stringify(l))
    .join('\n') + '\n'
/** A Codex rollout; `parent`: a guardian review of that session. */
const rollout = (sid, h, text, parent, cwd = alpha) =>
  [
    {
      timestamp: at(h),
      type: 'session_meta',
      payload: parent
        ? { id: sid, session_id: parent, parent_thread_id: parent, timestamp: at(h), cwd, originator: 'codex-tui', cli_version: '0.135.0', source: { subagent: { other: 'guardian' } }, thread_source: 'guardian_review' }
        : { id: sid, session_id: sid, timestamp: at(h), cwd, originator: 'codex-tui', cli_version: '0.135.0', source: 'cli', thread_source: 'user' }
    },
    { timestamp: at(h), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
    { timestamp: at(h), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 40 }, last_token_usage: { input_tokens: 500, output_tokens: 40 }, model_context_window: 258400 } } }
  ]
    .map((l) => JSON.stringify(l))
    .join('\n') + '\n'
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  // Written long ago: a transcript changed in the last few seconds counts as still being written.
  fs.utimesSync(file, old, old)
}
const backup = (sid) => path.join(alpha, '.combwork', 'sessions', `${sid}.jsonl`)
const rolloutFile = (sid, h) => path.join(codexHome, 'sessions', '2026', '10', '04', `rollout-2026-10-04T${String(h).padStart(2, '0')}-00-00-${sid}.jsonl`)

;(async () => {
  for (const d of [userData, ws, claudeHome, codexHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  fs.mkdirSync(codexHome, { recursive: true })
  lib.gitProject(alpha)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47923), CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 950 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const live = async (agentId) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === agentId)
  await page.getByText('alpha', { exact: true }).first().click()

  // --- Agents: Claude runs a session now (the live one); Codexette's session is a fixture.
  const claude = await lib.addAgent(inv, alpha, { name: 'Claude' })
  const codexette = await lib.addAgent(inv, alpha, { name: 'Codexette', provider: 'codex' })
  await inv('session:start', alpha, { agentId: claude.id })
  await lib.until(async () => ['waiting', 'ready'].includes((await live(claude.id))?.status), 20000)
  if ((await live(claude.id))?.status === 'waiting') await inv('pty:write', lib.ptyKey(alpha, claude.id), '\r')
  await lib.until(async () => (await live(claude.id))?.status === 'ready', 20000)
  await inv('pty:write', lib.ptyKey(alpha, claude.id), 'hello')
  await lib.sleep(300)
  await inv('pty:write', lib.ptyKey(alpha, claude.id), '\r')
  check('Claude runs a session', !!(await lib.until(async () => (await live(claude.id))?.status === 'finished', 20000)))
  const liveId = (await live(claude.id)).sessionId
  await inv('session:rename', alpha, liveId, 'Running now')

  // --- History: Claude's sessions (one with no transcript left anywhere), a removed agent's, Codexette's with three
  // guardian reviews under it, a guardian review whose session isn't listed, and one started in a terminal.
  const C = { tray: id(1), notes: id(2), gone: id(3), coder: id(4), codex: id(5), g1: id(6), g2: id(7), g3: id(8), lost: id(9), terminal: id(10), adopted: id(11), wt: id(12), wtReview: id(13) }
  // A worktree Codexette worked in (its folder needn't exist for the list).
  const wtDir = path.join(ws, '.worktrees', 'alpha-spike')
  // The records are in the workspace's database (#1061).
  const file = sessionsOf(alpha)
  const rec = (sid, name, h, more = {}) => ({ id: sid, agent: 'claude-code', name, createdAt: at(h), lastActiveAt: at(h), archived: false, ...more })
  file.sessions.push(
    rec(C.tray, 'Tray fixes', 10, { agentId: claude.id, agentName: 'Claude' }),
    rec(C.notes, 'Old notes', 6, { agentId: claude.id, agentName: 'Claude' }),
    rec(C.gone, 'Gone session', 5, { agentId: claude.id, agentName: 'Claude' }),
    rec(C.coder, 'Coder work', 4, { agentId: 'a-0c0de00', agentName: 'Coder' }),
    rec(C.codex, 'Codex work', 9, { agent: 'codex', agentId: codexette.id, agentName: 'Codexette', transcriptPath: rolloutFile(C.codex, 9) }),
    // A guardian review adopted before Combwork told sub-sessions apart: its record doesn't say so.
    rec(C.adopted, 'Adopted review', 5, { agent: 'codex', transcriptPath: rolloutFile(C.adopted, 5) }),
    // A session in a worktree, with a guardian review there.
    rec(C.wt, 'Worktree work', 1, { agent: 'codex', agentId: codexette.id, agentName: 'Codexette', cwd: wtDir, branch: 'cw/spike', transcriptPath: rolloutFile(C.wt, 1) })
  )
  putSessions(alpha, file)
  write(backup(C.tray), claudeLines(C.tray, 10, 'Fix the tray icon'))
  write(backup(C.notes), claudeLines(C.notes, 6, 'Tidy the zebra notes'))
  write(backup(C.coder), claudeLines(C.coder, 4, 'Refactor the loader'))
  write(rolloutFile(C.codex, 9), rollout(C.codex, 9, 'Port the build script'))
  write(rolloutFile(C.g1, 8), rollout(C.g1, 8, 'Judge: rm -rf build', C.codex))
  write(rolloutFile(C.g2, 7), rollout(C.g2, 7, 'Judge: git push', C.codex))
  write(rolloutFile(C.g3, 6), rollout(C.g3, 6, 'Judge: npm install', C.codex))
  write(rolloutFile(C.lost, 3), rollout(C.lost, 3, 'Judge: curl', id(99)))
  write(rolloutFile(C.adopted, 5), rollout(C.adopted, 5, 'Judge: rm notes', C.codex))
  write(rolloutFile(C.wt, 1), rollout(C.wt, 1, 'Spike the parser', undefined, wtDir))
  write(rolloutFile(C.wtReview, 1), rollout(C.wtReview, 1, 'Judge: cargo build', C.wt, wtDir))
  fs.writeFileSync(path.join(codexHome, 'session_index.jsonl'), [[C.g1, 'Review rm'], [C.g2, 'Review push'], [C.g3, 'Review install'], [C.lost, 'Lost review'], [C.wtReview, 'Worktree review']].map(([i, n]) => JSON.stringify({ id: i, thread_name: n })).join('\n') + '\n')
  const terminalFile = path.join(claudeHome, 'projects', alpha.replace(/[^a-zA-Z0-9]/g, '-'), `${C.terminal}.jsonl`)
  write(terminalFile, claudeLines(C.terminal, 2, 'Started in a terminal') + JSON.stringify({ type: 'custom-title', customTitle: 'From the terminal' }) + '\n')

  // HI-1941: what the Archived box's row says, at the list's narrowest width (the resizer's least), in English and German,
  // both themes: it wraps under the box, never past the list's edge. Screenshots for the Assistant's OK.
  const list = page.locator('.sessions-list')
  const DE = path.join(lib.ROOT, 'locales', 'de')
  const german = Object.assign({}, ...fs.readdirSync(DE).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(DE, f), 'utf8'))))
  const base = (await inv('app:info')).language
  /** The window shown in a language, as main sends a change of language (i18nlive's way). */
  const speak = (language) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'language-changed', language })
  const archivedBox = () => page.locator('.sessions-filters label').innerText().catch(() => '')
  const narrowShots = async (name, el) => {
    const width = await list.evaluate((e) => e.style.width)
    await list.evaluate((e) => (e.style.width = '200px'))
    await lib.until(async () => Math.round((await list.boundingBox()).width) === 200, HUNG_MS)
    for (const [lang, language, label] of [['en', base, 'Archived'], ['de', { ...base, code: 'de', locale: 'de', messages: german }, german['sessions.filter.archived']]]) {
      await speak(language)
      await lib.until(async () => (await archivedBox()).trim() === label, HUNG_MS)
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        const fits = await el.evaluate((e) => {
          const edge = e.closest('.sessions-list').getBoundingClientRect().right
          const filters = e.parentElement
          return e.getBoundingClientRect().right <= edge + 0.5 && filters.scrollWidth <= filters.clientWidth
        })
        check(`${name} at 200 px (${lang}, ${theme}): within the list, under the Archived box when it doesn't fit`, fits, await el.innerText().catch(() => ''))
        await list.screenshot({ path: path.join(lib.WORK, `sessiontree-narrow-${name}-${lang}-${theme}.png`) })
      }
    }
    await speak(base)
    await lib.until(async () => (await archivedBox()).trim() === 'Archived', HUNG_MS)
    await inv('settings:update', { appearance: { theme: 'dark' } })
    await list.evaluate((e, w) => (e.style.width = w), width)
  }
  // The whole list's first read held (its session:list, asked before Combwork's own), so the note stays while it is shot.
  await app.evaluate(() => {
    process.env.CW_TEST_SLOW_IPC = 'session:list=20000*1'
  })
  await page.locator('.tab', { hasText: 'Sessions' }).click()
  const note = page.locator('.sessions-scope[data-loading="others"]')
  check('the note shows while the sessions started outside Combwork are read', !!(await lib.until(async () => (await note.count()) === 1, HUNG_MS)))
  await narrowShots('loading', note)
  check('…and goes once they are read', !!(await lib.until(async () => (await note.count()) === 0, HELD_LIST_HUNG_MS)))
  await app.evaluate(() => {
    delete process.env.CW_TEST_SLOW_IPC
  })
  const tree = page.locator('.sessions-tree')
  const row = (name) => page.locator('.sessions-tree .session-row', { hasText: name })
  const branch = (label) => page.locator('.sessions-tree .session-branch', { has: page.locator('.label', { hasText: new RegExp(`^${label.replace(/[()]/g, '\\$&')}$`) }) })
  const names = async () => (await page.locator('.sessions-tree .session-row strong').allInnerTexts()).map((t) => t.trim())
  await lib.until(async () => (await page.locator('.sessions-tree .session-branch').count()) > 0, 15000)

  // --- Shape and counts.
  const providers = (await page.locator('.session-branch-provider .label').allInnerTexts()).map((t) => t.trim())
  check('providers are the top level', JSON.stringify(providers) === JSON.stringify(['Claude Code', 'Codex']), JSON.stringify(providers))
  check('branches start folded except the focused agent’s', (await names()).length < 14, JSON.stringify(await names()))
  await page.getByRole('button', { name: 'Expand All' }).click()
  // Every session with its title: those the usage history reads on first sight show theirs once it has (#1106).
  await lib.until(async () => {
    const n = await names()
    return n.length === 14 && !n.some((x) => /^Session [0-9a-f]{8}$/.test(x))
  }, HUNG_MS)
  const all = await names()
  check('Expand All shows every session', all.length === 14, JSON.stringify(all))
  const agentLabels = (await page.locator('.session-branch-agent .label').allInnerTexts()).map((t) => t.trim())
  check('agents under each provider, a removed one marked, then "Not from an agent"', JSON.stringify(agentLabels) === JSON.stringify(['Claude', 'Coder (removed)', 'Not from an agent', 'Codexette', 'Not from an agent']), JSON.stringify(agentLabels))
  const codexAt = all.indexOf('Codex work')
  check('guardian reviews nest under the session that started them, newest first (one adopted long ago too)', JSON.stringify(all.slice(codexAt, codexAt + 5)) === JSON.stringify(['Codex work', 'Review rm', 'Review push', 'Review install', 'Adopted review']), JSON.stringify(all))
  check('a sub-session shows how many it started', /4 guardian reviews/.test(await row('Codex work').locator('.sub-count').innerText().catch(() => '')))
  check('the adopted review is marked as one', (await row('Adopted review').locator('.sub-kind').count()) === 1)
  const wtAt = all.indexOf('Worktree work')
  check("a worktree session's guardian review, from that folder, nests under it", wtAt >= 0 && all[wtAt + 1] === 'Worktree review', JSON.stringify(all))
  const pad = async (name) => parseFloat(await row(name).evaluate((el) => getComputedStyle(el).paddingLeft))
  check('sub-sessions are indented under it', (await pad('Review rm')) > (await pad('Codex work')), `${await pad('Review rm')} vs ${await pad('Codex work')}`)
  check('a guardian review whose session isn’t listed stays, marked', (await row('Lost review').locator('.sub-kind').count()) === 1 && all.indexOf('Lost review') > all.indexOf('Review install'))
  const count = async (label) => (await branch(label).first().locator('.tree-count').innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
  check('each branch has its count (sessions + sub-sessions)', (await count('Codex')) === '2 + 6' && (await count('Claude Code')) === '6' && (await count('Claude')) === '4', `${await count('Codex')} | ${await count('Claude Code')} | ${await count('Claude')}`)
  await page.screenshot({ path: path.join(lib.WORK, 'sessiontree-1-tree.png') })

  // --- Folding is remembered for the project.
  await branch('Codex').first().click()
  await lib.until(async () => !(await names()).includes('Codex work'), HUNG_MS)
  check('a provider folds', !(await names()).includes('Codex work'))
  await page.locator('.tab', { hasText: 'Files' }).click()
  await page.locator('.tab', { hasText: 'Sessions' }).click()
  await lib.until(async () => (await page.locator('.sessions-tree .session-branch').count()) > 0, 10000)
  check('folded stays folded when the tab opens again', !(await names()).includes('Codex work') && (await names()).includes('Old notes'))
  // Settings are saved a moment after they change.
  const savedPrefs = () => {
    try {
      return JSON.parse(fs.readFileSync(cfgFile, 'utf8')).ui?.sessionsTree?.[alpha.toLowerCase()] ?? {}
    } catch {
      return {}
    }
  }
  await lib.until(async () => savedPrefs()['p:codex'] === false, 5000)
  const saved = savedPrefs()
  check('the folding is saved for the project', saved['p:codex'] === false, JSON.stringify(saved))
  // A branch folded with its session shown stays folded when the list refreshes.
  await row('Old notes').click()
  await branch('Claude').first().click()
  await lib.until(async () => !(await names()).includes('Old notes'), HUNG_MS)
  await page.locator('.sessions-list .pane-header [aria-label="Refresh"]').click()
  await lib.sleep(700)
  check('a folded branch stays folded when the list refreshes, though its session is shown', !(await names()).includes('Old notes') && /Old notes/.test(await page.locator('.transcript-toolbar strong').first().innerText().catch(() => '')))
  await branch('Claude').first().click()
  await lib.until(async () => (await names()).includes('Old notes'), HUNG_MS)

  // --- Search filters the tree and opens what matches.
  const search = page.locator('.sessions-list .files-filter input')
  await search.fill('Review push')
  await lib.until(async () => JSON.stringify(await names()) === JSON.stringify(['Codex work', 'Review push']), 8000)
  check('search by name opens the folded branch to the match (and its session)', JSON.stringify(await names()) === JSON.stringify(['Codex work', 'Review push']), JSON.stringify(await names()))
  await search.fill('zebra')
  await lib.until(async () => (await page.locator('.sessions-tree .search-hit').count()) > 0, 10000)
  check('search finds transcript text, with the match under its session', JSON.stringify(await names()) === JSON.stringify(['Old notes']) && /zebra/i.test(await page.locator('.sessions-tree .search-hit').first().innerText()), JSON.stringify(await names()))
  check('the count says how many sessions and matches', /1 session · \d+ match/.test(await page.locator('.sessions-scope').innerText()), await page.locator('.sessions-scope').innerText())
  await narrowShots('count', page.locator('.sessions-scope'))
  // Longer counts, as the catalogues word them (HR1's HI-1941 round 1: Japanese and Spanish at 200 px ran past the edge),
  // put into the count itself: each stays within the list, wrapping when it must.
  {
    const { IntlMessageFormat } = require('intl-messageformat')
    const said = (code, values) => new IntlMessageFormat(JSON.parse(fs.readFileSync(path.join(lib.ROOT, 'locales', code, 'sessions.json'), 'utf8'))['sessions.search.count'], code).format(values)
    const countEl = page.locator('.sessions-scope')
    const width = await list.evaluate((e) => e.style.width)
    await list.evaluate((e) => (e.style.width = '200px'))
    await lib.until(async () => Math.round((await list.boundingBox()).width) === 200, HUNG_MS)
    for (const [code, values] of [
      ['ja', { kind: 'session', sessions: 200, hits: 8000, more: '+' }],
      ['es', { kind: 'conversation', sessions: 12, hits: 40, more: '+' }],
      ['de', { kind: 'session', sessions: 1200, hits: 8000, more: '+' }]
    ]) {
      const text = said(code, values)
      const was = await countEl.evaluate((e) => e.textContent)
      const fits = await countEl.evaluate((e, t) => {
        e.textContent = t
        const edge = e.closest('.sessions-list').getBoundingClientRect().right
        const filters = e.parentElement
        return e.getBoundingClientRect().right <= edge + 0.5 && filters.scrollWidth <= filters.clientWidth
      }, text)
      check(`a longer count at 200 px (${code}: ${text}) stays within the list`, fits, text)
      await list.screenshot({ path: path.join(lib.WORK, `sessiontree-narrow-longcount-${code}-dark.png`) })
      await countEl.evaluate((e, t) => (e.textContent = t), was)
    }
    await list.evaluate((e, w) => (e.style.width = w), width)
  }
  await search.fill('')
  await lib.until(async () => (await names()).length > 1, 5000)

  // --- Keyboard like Files.
  await tree.focus()
  const cursor = () => page.locator('.sessions-tree .cursor').first()
  const at_ = async () => (await cursor().locator('.label, strong').first().innerText().catch(() => '')).trim()
  await page.keyboard.press('Home')
  check('Home goes to the first row', (await at_()) === 'Claude Code', await at_())
  await page.keyboard.press('ArrowDown')
  check('↓ moves down (to the Claude agent)', (await at_()) === 'Claude', await at_())
  await page.keyboard.press('ArrowDown')
  const firstSession = await at_()
  check('moving onto a session shows its transcript', firstSession === 'Running now' && !!(await lib.until(async () => (await page.locator('.transcript-toolbar strong').first().innerText().catch(() => '')).trim() === firstSession, 5000)), firstSession)
  await page.keyboard.press('ArrowLeft')
  check('← goes to the branch above', (await at_()) === 'Claude', await at_())
  await page.keyboard.press('ArrowLeft')
  await lib.until(async () => !(await names()).includes(firstSession), HUNG_MS)
  check('← again folds it', !(await names()).includes(firstSession))
  await page.keyboard.press('ArrowRight')
  await lib.until(async () => (await names()).includes(firstSession), HUNG_MS)
  check('→ opens it', (await names()).includes(firstSession))
  await page.keyboard.press('Enter')
  await lib.until(async () => !(await names()).includes(firstSession), HUNG_MS)
  check('Enter on a branch folds it', !(await names()).includes(firstSession))
  await page.keyboard.press('Enter')
  await lib.until(async () => (await names()).includes(firstSession), HUNG_MS)

  // --- Sessions that can't be resumed: a marker, and Resume disabled with the reason.
  await row('Gone session').click()
  check("the row says it can't be resumed", (await row('Gone session').locator('.cant-resume').count()) === 1)
  const blocked = page.locator('.transcript-toolbar .resume-blocked')
  check('its Resume is disabled', (await blocked.locator('button[disabled]').count()) === 1)
  // Disabled, Resume stays readable (#344): unfaded, its label at least 4.5:1 on what's behind it, here and in the row's
  // menu, in both themes.
  const legible = (loc) =>
    loc.evaluate((el) => {
      const rgb = (s) => (s.match(/[\d.]+/g) || []).map(Number)
      const lum = (c) => c.slice(0, 3).map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0)
      let bg = null
      for (let n = el; n && !bg; n = n.parentElement) {
        const c = rgb(getComputedStyle(n).backgroundColor)
        if (c.length === 3 || c[3] === 1) bg = c
      }
      const [x, y] = [lum(rgb(getComputedStyle(el).color)), lum(bg ?? [0, 0, 0])].sort((a, b) => b - a)
      let opacity = 1
      for (let n = el; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity)
      return { ratio: Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100, opacity }
    })
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.sleep(300)
    const button = await legible(blocked.locator('button.act-resume[disabled]'))
    check(`${theme}: the blocked Resume is unfaded and readable`, button.opacity === 1 && button.ratio >= 4.5, JSON.stringify(button))
    await row('Gone session').click({ button: 'right' })
    const entry = page.locator('.menu .menu-item.act-resume.disabled', { hasText: 'Resume' })
    await entry.waitFor({ timeout: 3000 }).catch(() => undefined)
    const item = (await entry.count()) ? await legible(entry.locator('.menu-label')) : null
    check(`${theme}: its menu's disabled Resume is unfaded and readable`, !!item && item.opacity === 1 && item.ratio >= 4.5, JSON.stringify(item))
    await page.keyboard.press('Escape')
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  const tipFor = async (el) => {
    let tip = ''
    await lib.until(async () => {
      await el.hover().catch(() => undefined)
      tip = await page.locator('.tip').last().innerText().catch(() => '')
      return tip.length > 0
    }, 8000)
    return tip
  }
  const why = await tipFor(blocked)
  check('…with the reason as its tooltip', /Neither Claude Code nor Combwork has its transcript/.test(why), why)
  await branch('Codex').first().click()
  await lib.until(async () => (await names()).includes('Review rm'), 5000)
  await row('Review rm').click()
  check('a guardian review is marked, and its Resume is disabled', (await page.locator('.transcript-toolbar .sub-kind').count()) === 1 && (await blocked.locator('button[disabled]').count()) === 1)
  const subWhy = await tipFor(blocked)
  check('…because it is a sub-session', /guardian review Codex ran for another session/.test(subWhy), subWhy)
  await page.screenshot({ path: path.join(lib.WORK, 'sessiontree-2-cant-resume.png') })
  const refused = await page.evaluate(([folder, sid, agentId]) => window.combwork.invoke('session:start', folder, { resumeId: sid, agentId }).then(() => 'started', (e) => String(e.message ?? e)), [alpha, C.g1, codexette.id])
  check('main refuses to resume a sub-session too', /not a conversation: it can't be resumed/.test(refused), refused)
  const refusedOld = await page.evaluate(([folder, sid, agentId]) => window.combwork.invoke('session:start', folder, { resumeId: sid, agentId }).then(() => 'started', (e) => String(e.message ?? e)), [alpha, C.adopted, codexette.id])
  check('…and one adopted before sub-sessions were told apart', /not a conversation: it can't be resumed/.test(refusedOld), refusedOld)

  // --- Delete all on the Claude agent: the running session and a backup another program holds are skipped.
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$f = [IO.File]::Open('${backup(C.notes).replace(/'/g, "''")}', 'Open', 'Read', 'None'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep -Seconds 120`], { env: lib.baseEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  let held = false
  holder.stdout.on('data', (d) => (held ||= String(d).includes('held')))
  await lib.until(async () => held, 20000)
  check('a backup is held open by another program', held)
  await branch('Claude').first().click({ button: 'right' })
  const menu = page.locator('.menu').last()
  await lib.until(async () => (await menu.count()) > 0, HUNG_MS)
  const delAll = menu.locator('.menu-item', { hasText: /^Delete All… \(4\)/ })
  check('the branch menu offers Delete All with its count', (await delAll.count()) === 1, await menu.innerText().catch(() => ''))
  await delAll.click()
  const dialog = page.locator('.dialog')
  await lib.until(async () => (await dialog.count()) > 0, HUNG_MS)
  check('one confirmation names the count and branch', /Delete 4 sessions under Claude \(Claude Code\)/.test(await dialog.innerText().catch(() => '')), await dialog.innerText().catch(() => ''))
  await page.screenshot({ path: path.join(lib.WORK, 'sessiontree-3-confirm.png') })
  await page.locator('.dialog-footer button', { hasText: /^Delete All$/ }).click()
  const toast = page.locator('.toast', { hasText: 'skipped' })
  await lib.until(async () => (await toast.count()) > 0, 10000)
  const said = await toast.first().innerText().catch(() => '')
  check('the result says what was skipped and why', /Deleted 2 sessions; 2 skipped: 1 running, 1 in use/.test(said), said)
  await lib.until(async () => !(await names()).includes('Tray fixes'), 8000)
  const after = await names()
  check('the rest are gone; the running and held ones stay', !after.includes('Tray fixes') && !after.includes('Gone session') && after.includes('Old notes') && after.includes('Running now'), JSON.stringify(after))
  check("Combwork's copy of a deleted one is in the Recycle Bin, the held one's is kept", !fs.existsSync(backup(C.tray)) && fs.existsSync(backup(C.notes)))
  check("…the suite's trash folder in a test copy (#414)", lib.trashed(backup(C.tray)).length === 1)
  check("the CLI's own transcripts are untouched", fs.existsSync(terminalFile) && fs.existsSync(rolloutFile(C.codex, 9)))
  holder.kill()
  await page.screenshot({ path: path.join(lib.WORK, 'sessiontree-4-deleted.png') })

  // --- Archive all on Codex, with its session's transcript open here: the view closes first (an open one is in use),
  // nothing is skipped for it, and the result says so. Its guardian reviews go with it; the orphan stays.
  await row('Codex work').click()
  await lib.until(async () => /Codex work/.test(await page.locator('.transcript-toolbar strong').first().innerText().catch(() => '')), 5000)
  await branch('Codex').first().click({ button: 'right' })
  await lib.until(async () => (await menu.count()) > 0, HUNG_MS)
  await menu.locator('.menu-item', { hasText: /^Archive All… \(3\)/ }).click()
  await page.locator('.dialog-footer button', { hasText: /^Archive All$/ }).click()
  await lib.until(async () => !(await names()).includes('Codex work'), 8000)
  const archivedToast = page.locator('.toast', { hasText: 'Archived 3 sessions' })
  await lib.until(async () => (await archivedToast.count()) > 0, 8000)
  const archivedSaid = await archivedToast.first().innerText().catch(() => '')
  check('the open transcript closed first, nothing was skipped for it, and the result says so', /Archived 3 sessions\./.test(archivedSaid) && !/skipped/.test(archivedSaid) && /closed first/.test(archivedSaid), archivedSaid)
  check('its view stays closed', !/Codex work/.test(await page.locator('.transcript-toolbar strong').first().innerText().catch(() => '')))
  const archived = await names()
  check('the archived session and its sub-sessions leave the tree', !archived.includes('Codex work') && !archived.includes('Review rm'), JSON.stringify(archived))
  check('the guardian review whose session isn’t listed stays', archived.includes('Lost review'))
  check('it is archived in Combwork', sessionsOf(alpha).sessions.find((s) => s.id === C.codex)?.archived === true)
  await page.getByText('Archived', { exact: true }).click()
  await lib.until(async () => (await names()).includes('Codex work'), 5000)
  check('Archived shows it again, with its sub-sessions', (await names()).includes('Codex work') && (await names()).includes('Review rm'))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
