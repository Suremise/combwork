// Purge… (#1138) from its three places, on fixtures: a project with a session the "CLI" still has, an archived one it
// lost, a third for the session's own purge, a running session, a deleted session's attachments and a leftover spare of a
// backup; and a second project. The Sessions tab's Purge Combwork's Files… lists and removes one session's files to the
// Recycle Bin, the record staying; Project Settings → Storage's Purge… lists every file of Combwork's with its size, the
// last copy tagged and the running session left alone, and with Delete permanently removes them for good (nothing in the
// Recycle Bin), deleting the lost session as Delete does; Settings → Workspace's Purge… covers the other project too. The
// CLI's transcripts, the running session's files and the totals never change. Dev build, throwaway profile, workspace
// and CLAUDE_CONFIG_DIR (the fake Claude Code's transcripts).
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { sessionsOf } = require('./storeDocs.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'purge-profile')
const ws = path.join(lib.WORK, 'purge-ws')
const claudeHome = path.join(lib.WORK, 'purge-claude-home')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
const hiveOf = (p) => path.join(p, '.combwork')
const cliDirOf = (p) => path.join(claudeHome, 'projects', p.replace(/[^a-zA-Z0-9]/g, '-'))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

const id = (n) => `9b26e000-0000-4000-8000-00000000000${n}`
const WITH_CLI = id(1) // the CLI still has it
const LOST = id(2) // archived; the CLI lost it: Combwork's backup is its last copy
const ONE = id(3) // purged on its own, from the Sessions tab
const DELETED = id(4) // deleted: only its attachments are left
const BETA = id(5) // the other project's
const DAY = 24 * 60 * 60 * 1000
const ago = (days) => new Date(Date.now() - days * DAY).toISOString()
const transcript = (sid, n) =>
  [
    { type: 'user', sessionId: sid, timestamp: ago(20), message: { role: 'user', content: `Task ${n}` } },
    { type: 'assistant', sessionId: sid, requestId: `r${n}`, timestamp: ago(20), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: `Done ${n}.` }], usage: { input_tokens: 10 * n, cache_read_input_tokens: 1000 * n, cache_creation_input_tokens: 100, output_tokens: 50 * n } } }
  ]
    .map((l) => JSON.stringify(l))
    .join('\n') + '\n'
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  lib.gitProject(beta)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))

  const fixtures = [
    { host: alpha, id: WITH_CLI, name: 'Kept by the CLI', archived: false, cli: true, n: 1 },
    { host: alpha, id: LOST, name: 'Lost by the CLI', archived: true, cli: false, n: 2 },
    { host: alpha, id: ONE, name: 'Purged alone', archived: false, cli: true, n: 3 },
    { host: beta, id: BETA, name: 'In beta', archived: false, cli: true, n: 4 }
  ]
  const backup = (s) => path.join(hiveOf(s.host), s.archived ? 'archive' : 'sessions', `${s.id}.jsonl.gz`)
  const shot = (s) => path.join(hiveOf(s.host), 'attachments', s.id)
  const cliCopy = (s) => path.join(cliDirOf(s.host), `${s.id}.jsonl`)
  for (const s of fixtures) {
    write(backup(s), zlib.gzipSync(transcript(s.id, s.n)))
    if (s.cli) write(cliCopy(s), transcript(s.id, s.n))
    write(path.join(shot(s), 'shot.png'), lib.samplePng(40 + s.n * 10, 30))
  }
  write(path.join(hiveOf(alpha), 'attachments', DELETED, 'shot.png'), lib.samplePng(90, 60))
  const spare = path.join(hiveOf(alpha), 'sessions', `${WITH_CLI}.jsonl.gz.spare`)
  write(spare, 'left by a crash')
  for (const host of [alpha, beta]) {
    const mine = fixtures.filter((s) => s.host === host)
    write(path.join(hiveOf(host), 'sessions.json'), JSON.stringify({ version: 1, sessions: mine.map((s) => ({ id: s.id, agent: 'claude-code', name: s.name, createdAt: ago(21), lastActiveAt: ago(20), archived: s.archived })), deleted: host === alpha ? [DELETED] : [] }))
  }

  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47828), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1500, height: 950 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)

    // A running session: nothing of it is listed or touched.
    const live = await lib.addAgent(inv, alpha, { name: 'Live' })
    await inv('session:start', alpha, { agentId: live.id })
    const state = await lib.until(async () => (await inv('session:live')).find((s) => s.agentId === live.id && s.status === 'ready' && s.sessionId), 20000)
    check('the live agent is running', !!state)
    const liveShot = path.join(hiveOf(alpha), 'attachments', state?.sessionId ?? 'none', 'now.png')
    write(liveShot, lib.samplePng(20, 20))

    const totals = async () => {
      const u = await inv('workspace:usage')
      const ours = u.projects.flatMap((p) => p.items ?? []).filter((i) => fixtures.some((s) => s.id === i.id))
      return JSON.stringify(['outputTokens', 'inputTokens', 'cacheReadTokens', 'requests'].map((k) => ours.reduce((n, i) => n + (i.usage?.[k] ?? 0), 0)))
    }
    const before = await lib.until(async () => {
      const t = await totals()
      return t === JSON.stringify([500, 100, 10000, 4]) && t
    }, HUNG_MS)
    check('the fixtures count in the totals', !!before, await totals())
    const dialog = page.locator('.dialog')
    const dialogText = () => dialog.innerText().catch(() => '')
    const rows = () => dialog.locator('.purge-preview tbody [title]').evaluateAll((els) => els.map((e) => e.getAttribute('title')))
    const rel = (list, host) => list.map((p) => path.relative(hiveOf(host), p).replace(/\\/g, '/')).sort()
    const binnedFrom = (p) => lib.trashed(hiveOf(alpha)).some((e) => e.from.toLowerCase() === p.toLowerCase())

    // --- The Sessions tab: one session's files.
    await page.locator('.project-row', { hasText: 'alpha' }).click()
    await page.locator('.tab', { hasText: 'Sessions' }).click()
    const row = (name) => page.locator('.sessions-tree .session-row', { hasText: name })
    // The fixtures are from no agent: their branch starts folded.
    await lib.until(async () => (await page.getByRole('button', { name: 'Expand All' }).count()) > 0, HUNG_MS)
    await page.getByRole('button', { name: 'Expand All' }).click()
    check('the sessions are listed', await lib.until(async () => (await row('Purged alone').count()) > 0, HUNG_MS))
    await row('Purged alone').first().click({ button: 'right' })
    await lib.menuEntry(page, "Purge Combwork's Files…").click()
    check('the dialog names the session', await lib.until(async () => /Purge Combwork's Files of "Purged alone"/.test(await dialogText()), HUNG_MS), await dialogText())
    let listed = await lib.until(async () => {
      const r = rel(await rows(), alpha)
      return JSON.stringify(r) === JSON.stringify([`attachments/${ONE}/shot.png`, `sessions/${ONE}.jsonl.gz`]) && r
    }, HUNG_MS)
    check("…and lists that session's backup and attachments only", !!listed, JSON.stringify(rel(await rows(), alpha)))
    check('…with their size on the button', /Move 2 items \(.+\) to the Recycle Bin/.test(await dialog.locator('.btn.primary').innerText()), await dialog.locator('.btn.primary').innerText())
    await page.screenshot({ path: path.join(lib.WORK, 'purge-1-session.png') })
    await dialog.locator('.btn.primary').click()
    check('the dialog closes', await lib.until(async () => (await dialog.count()) === 0, HUNG_MS))
    const one = fixtures.find((s) => s.id === ONE)
    check("the session's files went to the Recycle Bin", await lib.until(() => !fs.existsSync(backup(one)) && !fs.existsSync(shot(one)), HUNG_MS) && binnedFrom(backup(one)) && binnedFrom(shot(one)))
    check('…its record stays (the CLI still has it), and its CLI transcript too', sessionsOf(alpha).sessions.some((s) => s.id === ONE) && fs.existsSync(cliCopy(one)))
    check("…and the other sessions' files are untouched", fixtures.filter((s) => s.id !== ONE).every((s) => fs.existsSync(backup(s)) && fs.existsSync(shot(s))))
    // The running session's menu has it greyed out.
    const liveRow = page.locator(`.sessions-tree [data-key="s:${state?.sessionId}"]`)
    check('the running session is listed', await lib.until(async () => (await liveRow.count()) === 1, HUNG_MS))
    await liveRow.click({ button: 'right' })
    const entry = lib.menuEntry(page, "Purge Combwork's Files…")
    check("a running session's Purge Combwork's Files… is off", await lib.until(async () => /\bdisabled\b/.test((await entry.getAttribute('class').catch(() => '')) ?? ''), HUNG_MS), await entry.getAttribute('class').catch(() => 'none'))
    await page.keyboard.press('Escape')

    // --- Project Settings → Storage: everything of the project's, permanently.
    await lib.openProjectSettings(page)
    await page.locator('.settings-nav .row', { hasText: 'Storage' }).click()
    const group = page.locator('.settings-group', { has: page.locator('h2', { hasText: /^Storage$/ }) })
    await lib.until(async () => (await group.getByRole('button', { name: 'Purge…' }).isEnabled().catch(() => false)), HUNG_MS)
    await group.getByRole('button', { name: 'Purge…' }).click()
    const want = [`archive/${LOST}.jsonl.gz`, `attachments/${DELETED}/shot.png`, `attachments/${LOST}/shot.png`, `attachments/${WITH_CLI}/shot.png`, `sessions/${WITH_CLI}.jsonl.gz`, `sessions/${WITH_CLI}.jsonl.gz.spare`].sort()
    listed = await lib.until(async () => {
      const r = rel(await rows(), alpha)
      return JSON.stringify(r) === JSON.stringify(want) && r
    }, HUNG_MS)
    check("the project's preview lists every file of Combwork's, not the running session's", !!listed, JSON.stringify(rel(await rows(), alpha)))
    check('…says the running session is left alone', /1 running session is left alone/.test(await dialogText()), await dialogText())
    check('…tags the last copy and warns that its session is deleted', (await dialog.locator('.purge-last-copy').count()) === 1 && /1 session has no other copy/.test(await dialog.locator('.banner.danger').innerText().catch(() => '')))
    const kinds = await dialog.locator('.cleanup-kind').allInnerTexts()
    check('…groups them by kind', ['Transcript backups', 'Leftover backup files', 'Attachments ·', 'Attachments of deleted sessions'].every((k) => kinds.some((t) => t.startsWith(k))), JSON.stringify(kinds))
    await page.screenshot({ path: path.join(lib.WORK, 'purge-2-project.png') })
    await dialog.locator('label.choice', { hasText: 'Delete permanently' }).locator('input').check()
    const go = dialog.locator('.dialog-footer .btn').last()
    check('Delete permanently changes the button', await lib.until(async () => /Delete 6 items \(.+\) permanently/.test(await go.innerText()), HUNG_MS), await go.innerText())
    await page.screenshot({ path: path.join(lib.WORK, 'purge-3-permanent.png') })
    const binBefore = lib.trashed(hiveOf(alpha)).length
    await go.click()
    check('the dialog closes', await lib.until(async () => (await dialog.count()) === 0, HUNG_MS))
    check('the listed files are gone', await lib.until(() => want.every((w) => !fs.existsSync(path.join(hiveOf(alpha), w))), HUNG_MS), want.filter((w) => fs.existsSync(path.join(hiveOf(alpha), w))).join(', '))
    check('…for good: none went to the Recycle Bin', lib.trashed(hiveOf(alpha)).length === binBefore)
    check('the lost session is deleted, as Delete does', !sessionsOf(alpha).sessions.some((s) => s.id === LOST) && sessionsOf(alpha).deleted.includes(LOST))
    check('the session the CLI has stays', sessionsOf(alpha).sessions.some((s) => s.id === WITH_CLI))
    check("the running session's attachment stays", fs.existsSync(liveShot))
    check("the CLI's transcripts are untouched", fixtures.filter((s) => s.cli).every((s) => fs.existsSync(cliCopy(s))))
    check('the totals are unchanged', (await totals()) === before, `${await totals()} vs ${before}`)

    // --- Settings → Workspace: the other project's too.
    await page.locator('.activity-btn[aria-label="Settings"]').click()
    await page.locator('.settings-nav .row', { hasText: 'Workspace' }).click()
    const wsPurge = page.locator('.storage-actions:visible').getByRole('button', { name: 'Purge…' })
    await lib.until(async () => wsPurge.isEnabled().catch(() => false), HUNG_MS)
    await wsPurge.click()
    const b = fixtures.find((s) => s.id === BETA)
    check("the workspace's preview lists beta's files, with its project", await lib.until(async () => rel(await rows(), beta).includes(`sessions/${BETA}.jsonl.gz`) && (await dialog.locator('tbody tr', { hasText: 'beta' }).count()) >= 2, HUNG_MS), JSON.stringify(await rows()))
    check('…and its title names the workspace', /Purge What Combwork Keeps in purge-ws/.test(await dialogText()))
    await page.screenshot({ path: path.join(lib.WORK, 'purge-4-workspace.png') })
    await dialog.locator('.btn.primary').click()
    check("beta's files went to the Recycle Bin", await lib.until(() => !fs.existsSync(backup(b)) && !fs.existsSync(shot(b)), HUNG_MS) && lib.trashed(hiveOf(beta)).some((e) => e.from.toLowerCase() === backup(b).toLowerCase()))
    check('the totals are still unchanged', (await totals()) === before, `${await totals()} vs ${before}`)

    await inv('session:stop', alpha, live.id).catch(() => undefined)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'All purge checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
