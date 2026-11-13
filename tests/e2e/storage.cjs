// Project Settings → Storage and Clean Up…, on fixtures: a project with archived sessions old and recent (some the
// "CLI" still has, one it lost), a session that isn't archived, attachments of each, of a deleted session and of launches
// (one running), and a worktree. Storage shows their sizes, Settings → Workspace links to it, the preview lists exactly
// what goes, Clean Up moves exactly that to the Recycle Bin, and the Overview's totals don't change (also after the
// CLI's copy goes). Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR (the fake Claude Code's transcripts).
// Dev build only (#1580): it starts this checkout's Electron itself, and Tree is a 0.9 worktree agent
// (agents:testLegacy, refused by a packaged build), whose folder Storage counts.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { sessionsOf } = require('./storeDocs.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'storage-profile')
const ws = path.join(lib.WORK, 'storage-ws')
const claudeHome = path.join(lib.WORK, 'storage-claude-home')
const alpha = path.join(ws, 'alpha')
const dataDir = path.join(alpha, '.combwork')
const cliDir = path.join(claudeHome, 'projects', alpha.replace(/[^a-zA-Z0-9]/g, '-'))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = async (fn, ms = 10000) => {
  const t = Date.now()
  let v
  while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
  return v
}
/** A folder's size the way Storage counts it: files only, links not followed. */
const sizeOf = (p) => {
  const st = fs.lstatSync(p, { throwIfNoEntry: false })
  if (!st) return 0
  if (st.isFile()) return st.size
  if (!st.isDirectory()) return 0
  return fs.readdirSync(p).reduce((n, f) => n + sizeOf(path.join(p, f)), 0)
}

const id = (n) => `5707a9e0-0000-4000-8000-00000000000${n}`
const OLD_CLI = id(1) // archived 200 days ago; the CLI has it
const OLD_GONE = id(2) // archived 200 days ago; the CLI lost it
const RECENT = id(3) // archived 10 days ago
const OPEN = id(4) // not archived, 200 days ago
const DELETED = id(5) // deleted: only its attachments are left
const DAY = 24 * 60 * 60 * 1000
const ago = (days) => new Date(Date.now() - days * DAY).toISOString()
const transcript = (sid, n) =>
  [
    { type: 'user', sessionId: sid, timestamp: ago(200), message: { role: 'user', content: `Task ${n}` } },
    { type: 'assistant', sessionId: sid, requestId: `r${n}`, timestamp: ago(200), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: `Done ${n}.` }], usage: { input_tokens: 10 * n, cache_read_input_tokens: 1000 * n, cache_creation_input_tokens: 100, output_tokens: 50 * n } } }
  ]
    .map((l) => JSON.stringify(l))
    .join('\n') + '\n'
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  for (let i = 1; i <= 11; i++) fs.mkdirSync(path.join(ws, `p${String(i).padStart(2, '0')}`), { recursive: true })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))

  // The fixtures: Combwork's backups (archive, sessions), the CLI's copies, and attachments.
  const sessions = [
    { id: OLD_CLI, name: 'Old with CLI copy', archived: true, days: 200, cli: true, n: 1 },
    { id: OLD_GONE, name: 'Old, CLI lost it', archived: true, days: 200, cli: false, n: 2 },
    { id: RECENT, name: 'Recent archived', archived: true, days: 10, cli: true, n: 3 },
    { id: OPEN, name: 'Not archived', archived: false, days: 200, cli: true, n: 4 }
  ]
  for (const s of sessions) {
    // Combwork's backups of ended sessions are kept compressed (#1110).
    write(path.join(dataDir, s.archived ? 'archive' : 'sessions', `${s.id}.jsonl.gz`), zlib.gzipSync(transcript(s.id, s.n)))
    if (s.cli) write(path.join(cliDir, `${s.id}.jsonl`), transcript(s.id, s.n))
    write(path.join(dataDir, 'attachments', s.id, 'shot.png'), lib.samplePng(40 + s.n * 10, 30))
  }
  write(path.join(dataDir, 'attachments', DELETED, 'shot.png'), lib.samplePng(90, 60))
  write(path.join(dataDir, 'attachments', 'run-deadbeef', 'early.png'), lib.samplePng(70, 50))
  // HI-3144: a removed agent's launch folder left from before (the open's sweep removes it), the project's agents read.
  write(path.join(dataDir, 'project.json'), JSON.stringify({ version: 2, agents: [] }))
  write(path.join(dataDir, 'launch-a-e2egone', 'plugin', 'skills', 'x', 'SKILL.md'), 'x'.repeat(4096))
  write(
    path.join(dataDir, 'sessions.json'),
    JSON.stringify({
      version: 1,
      sessions: sessions.map((s) => ({ id: s.id, agent: 'claude-code', name: s.name, createdAt: ago(s.days + 1), lastActiveAt: ago(s.days), archived: s.archived })),
      deleted: [DELETED]
    })
  )

  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47908), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 950 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  // The open's background work ended first (its "after opening" line): its pass adopting agents' 0.9 worktrees as slots
  // (#1441) among it. Tree's worktree, made while that pass ran, was adopted as slot "tree" instead of staying Tree's
  // worktree as this suite counts it (HI-2209). Bounded as a hung run, never how long it takes: it includes the bundled skills.
  const logFile = path.join(userData, 'logs', 'combwork.log')
  const opened = await until(() => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '').match(/after opening ⁨?storage-ws⁩?: .*adoption, slots/)?.[0], 30000)
  check("the open's background work has ended, its worktree adoption with it", !!opened)
  check("HI-3144: the open's sweep removed a removed agent's launch folder", !!(await until(() => !fs.existsSync(path.join(dataDir, 'launch-a-e2egone')), HUNG_MS)))

  // A running launch (its early attachments folder must stay) and a worktree agent (its folder is counted).
  const live = await lib.addAgent(inv, alpha, { name: 'Live' })
  await lib.addAgent(inv, alpha, { name: 'Tree', location: 'new-worktree' })
  await inv('session:start', alpha, { agentId: live.id })
  const state = await until(async () => (await inv('session:live')).find((s) => s.agentId === live.id && s.status === 'ready'), 20000)
  check('the live agent is running', !!state)
  const runDir = path.join(dataDir, 'attachments', `run-${state?.runId}`)
  write(path.join(runDir, 'pending.png'), lib.samplePng(30, 30))
  const liveImages = state?.sessionId ? path.join(dataDir, 'attachments', state.sessionId) : null
  if (liveImages) write(path.join(liveImages, 'now.png'), lib.samplePng(20, 20))

  const totals = async () => {
    const u = await inv('workspace:usage')
    const items = u.projects.find((p) => p.path.toLowerCase() === alpha.toLowerCase())?.items ?? []
    // The fixtures' sessions only (the live one grows as it runs).
    const ours = items.filter((i) => sessions.some((s) => s.id === i.id))
    return JSON.stringify(['outputTokens', 'inputTokens', 'cacheReadTokens', 'requests'].map((k) => ours.reduce((n, i) => n + (i.usage?.[k] ?? 0), 0)))
  }
  const before = await totals()
  check('the fixtures count in the totals', before === JSON.stringify([500, 100, 10000, 4]), before)

  // Storage: the sizes.
  const st = await inv('storage:project', alpha, true)
  check('Storage: transcript backups', st.sessions === sizeOf(path.join(dataDir, 'sessions')), `${st.sessions} vs ${sizeOf(path.join(dataDir, 'sessions'))}`)
  check('Storage: archive', st.archive === sizeOf(path.join(dataDir, 'archive')) && st.archive > 0, `${st.archive}`)
  check('Storage: attachments', st.attachments === sizeOf(path.join(dataDir, 'attachments')), `${st.attachments} vs ${sizeOf(path.join(dataDir, 'attachments'))}`)
  check('Storage: the worktree', st.worktrees.length === 1 && st.worktrees[0].agent === 'Tree' && st.worktrees[0].bytes === sizeOf(st.worktrees[0].path) && st.worktrees[0].bytes > 0, JSON.stringify(st.worktrees))
  check('Storage: the total', st.total === st.sessions + st.archive + st.attachments + st.worktrees[0]?.bytes)
  // What the compressed backups hold (#1110).
  const raw = (list) => list.reduce((n, s) => n + Buffer.byteLength(transcript(s.id, s.n)), 0)
  check('Storage: the backups before compression', st.sessionsRaw === raw(sessions.filter((s) => !s.archived)) && st.archiveRaw === raw(sessions.filter((s) => s.archived)), `${st.sessionsRaw}, ${st.archiveRaw}`)

  // Settings → Workspace lists the project and the Assistant, and its Storage link opens the project's page.
  await page.locator('.activity-btn[aria-label="Settings"]').click()
  await page.locator('.settings-nav .row', { hasText: 'Workspace' }).click()
  const wsTable = page.locator('.storage-table').first()
  check('Settings → Workspace lists alpha', !!(await until(async () => (await wsTable.locator('tr', { hasText: 'alpha' }).count()) > 0, HUNG_MS)))
  // Every project, biggest first, ten a page (#250); a filter finds the rest.
  const wsPaging = async () => ((await wsTable.locator('.table-paging').innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ')
  check('… every project (twelve and the Assistant), ten a page', /1–10 of 13/.test(await wsPaging()), await wsPaging())
  check('… alpha, the biggest, first', ((await wsTable.locator('tbody tr').first().innerText()) ?? '').startsWith('alpha'), await wsTable.locator('tbody tr').first().innerText())
  check('… with the workspace total under them', (await wsTable.locator('tfoot tr', { hasText: 'Workspace' }).count()) === 1)
  await wsTable.locator('input[aria-label="Filter Project"]').fill('Assistant')
  check('… and the Assistant', !!(await until(async () => (await wsTable.locator('tbody tr', { hasText: 'Assistant' }).count()) === 1 && (await wsTable.locator('tbody tr').count()) === 1, HUNG_MS)))
  await wsTable.locator('input[aria-label="Filter Project"]').fill('nothing like a project')
  check('… a filter with no match says so', (await wsTable.locator('.table-no-match').count()) === 1)
  await wsTable.locator('.table-no-match button', { hasText: 'Clear filters' }).click()
  check('… and Clear filters brings them back', !!(await until(async () => /of 13/.test(await wsPaging()), HUNG_MS)), await wsPaging())
  await page.screenshot({ path: path.join(lib.WORK, 'storage-workspace.png') })
  await wsTable.locator('th button', { hasText: 'Project' }).click()
  check('… sorted by name on request', ((await wsTable.locator('tbody tr').first().innerText()) ?? '').startsWith('alpha') && ((await wsTable.locator('tbody tr').nth(1).innerText()) ?? '').startsWith('Assistant'), await wsTable.locator('tbody tr').nth(1).innerText())
  await wsTable.locator('th button', { hasText: 'Project' }).click()
  await wsTable.locator('th button', { hasText: 'Project' }).click()
  await wsTable.locator('tr', { hasText: 'alpha' }).getByRole('button', { name: 'Storage' }).click()
  const group = page.locator('.settings-group', { has: page.locator('h2', { hasText: /^Storage$/ }) })
  check('the link opens Project Settings → Storage', !!(await until(async () => (await group.locator('.storage-table').count()) > 0, HUNG_MS)))
  check('the page shows the backups row', (await group.locator('tr', { hasText: 'Transcript backups' }).count()) === 1)
  check('… with what they hold before compression', /before compression/.test(await group.locator('tr', { hasText: 'Transcript backups' }).innerText()), await group.locator('tr', { hasText: 'Transcript backups' }).innerText())
  check("… and the worktree's", (await group.locator('tr', { hasText: "Tree's worktree" }).count()) === 1, (await group.locator('.storage-table tbody tr').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ')).join(' | '))
  // A DataTable (#250): sorted by Size, the biggest first, the total still under it.
  const sizes = { 'Transcript backups': st.sessions, Archive: st.archive, Attachments: st.attachments, "Tree's worktree": st.worktrees[0]?.bytes ?? 0 }
  const biggest = Object.entries(sizes).sort((a, b) => b[1] - a[1])[0][0]
  await group.locator('.storage-table th button', { hasText: 'Size' }).click()
  check(`sorted by Size: ${biggest} first`, ((await group.locator('.storage-table tbody tr').first().innerText()) ?? '').startsWith(biggest) && (await group.locator('.storage-table tfoot tr', { hasText: 'Total' }).count()) === 1, await group.locator('.storage-table tbody tr').first().innerText())
  await group.locator('.storage-table th button', { hasText: 'Size' }).click()
  await group.locator('.storage-table th button', { hasText: 'Size' }).click()
  await page.screenshot({ path: path.join(lib.WORK, 'storage-page.png') })

  // A removed agent's launch folder made since the open (HI-3144): Clean Up lists it, its option on at first.
  write(path.join(dataDir, 'launch-a-e2elate', 'plugin', 'skills', 'x', 'SKILL.md'), 'x'.repeat(4096))
  // Clean Up…: the default (old archived sessions' attachments, removed agents' launch folders), then every option.
  await group.getByRole('button', { name: 'Clean Up…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Clean Up alpha' })
  const rows = () => dialog.locator('.cleanup-preview tbody [title]').evaluateAll((els) => els.map((e) => e.getAttribute('title')))
  const norm = (list) => list.map((p) => path.relative(dataDir, p).replace(/\\/g, '/')).sort()
  const want = (list) => JSON.stringify([...list].sort())
  const previewIs = async (list) => (await until(async () => want(norm(await rows())) === want(list), 5000)) || norm(await rows())
  let got = await previewIs([`attachments/${OLD_CLI}`, `attachments/${OLD_GONE}`, 'launch-a-e2elate'])
  check("by default: old archived sessions' attachments and a removed agent's launch folder", got === true, JSON.stringify(got))
  await dialog.locator('label.choice', { hasText: 'Attachments of deleted sessions' }).locator('input').check()
  await dialog.locator('label.choice', { hasText: "Combwork's backups of archived sessions" }).locator('input[type=checkbox]').check()
  got = await previewIs([`attachments/${OLD_CLI}`, `attachments/${OLD_GONE}`, 'launch-a-e2elate', `attachments/${DELETED}`, 'attachments/run-deadbeef', `archive/${OLD_CLI}.jsonl.gz`])
  check('orphan attachments (not the running launch’s) and the backup the CLI still has', got === true, JSON.stringify(got))
  check('no warning before the last-copies option', (await dialog.locator('.banner.danger').count()) === 0)
  await dialog.locator('label.choice', { hasText: 'the CLI no longer has' }).locator('input').check()
  got = await previewIs([`attachments/${OLD_CLI}`, `attachments/${OLD_GONE}`, 'launch-a-e2elate', `attachments/${DELETED}`, 'attachments/run-deadbeef', `archive/${OLD_CLI}.jsonl.gz`, `archive/${OLD_GONE}.jsonl.gz`])
  check('the last copy of the session the CLI lost', got === true, JSON.stringify(got))
  check('… with a warning that it cannot be resumed or read', ((await dialog.locator('.banner.danger').textContent()) ?? '').includes("can't be resumed or read"))
  // A shorter age takes the recent session's attachments and backup too; back to 90 leaves them out again.
  await dialog.getByLabel('Attachment age in days').fill('5')
  got = await previewIs([`attachments/${OLD_CLI}`, `attachments/${OLD_GONE}`, 'launch-a-e2elate', `attachments/${RECENT}`, `attachments/${DELETED}`, 'attachments/run-deadbeef', `archive/${OLD_CLI}.jsonl.gz`, `archive/${OLD_GONE}.jsonl.gz`])
  check('the days field changes what is listed', got === true, JSON.stringify(got))
  await dialog.getByLabel('Attachment age in days').fill('90')
  const listed = [`attachments/${OLD_CLI}`, `attachments/${OLD_GONE}`, 'launch-a-e2elate', `attachments/${DELETED}`, 'attachments/run-deadbeef', `archive/${OLD_CLI}.jsonl.gz`, `archive/${OLD_GONE}.jsonl.gz`]
  got = await previewIs(listed)
  check('back to 90 days', got === true, JSON.stringify(got))
  const button = dialog.getByRole('button', { name: /to the Recycle Bin/ })
  check('… the launch folder under its own heading, as a removed agent', (await dialog.locator('.cleanup-preview > div', { hasText: 'Launch folders of removed agents' }).locator('tbody tr', { hasText: 'Removed agent a-e2elate' }).count()) === 1)
  check('the button says how much goes', /Move 7 items \(.+\) to the Recycle Bin/.test((await button.textContent()) ?? ''), await button.textContent())
  await page.screenshot({ path: path.join(lib.WORK, 'storage-cleanup.png') })
  const everything = (dir) => fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, String(f)))
  const keptBefore = everything(dataDir).filter((p) => !listed.some((l) => p.toLowerCase().startsWith(path.join(dataDir, l).toLowerCase())))
  await button.click()
  check('the dialog closes', !!(await until(async () => (await dialog.count()) === 0, 15000)))

  // Exactly what was listed went; everything else stayed.
  check('the listed files are gone', listed.every((l) => !fs.existsSync(path.join(dataDir, l))), listed.filter((l) => fs.existsSync(path.join(dataDir, l))).join(', '))
  // …to the Recycle Bin, which for a test copy is the suite's own trash folder (#414): each one arrived there.
  const binned = lib.trashed(dataDir)
  const arrived = (l) => binned.some((e) => e.from.toLowerCase() === path.join(dataDir, l).toLowerCase() || path.join(dataDir, l).toLowerCase().startsWith(`${e.from.toLowerCase()}${path.sep}`))
  check("…into the suite's trash folder, not the user's Recycle Bin", listed.every(arrived), JSON.stringify({ missing: listed.filter((l) => !arrived(l)), binned }))
  const missing = keptBefore.filter((p) => !p.endsWith('.bak') && !fs.existsSync(p))
  check('nothing else went', missing.length === 0, missing.join(', '))
  check("the running launch's attachments stayed", fs.existsSync(path.join(runDir, 'pending.png')))
  check('the recent and not-archived sessions kept their backups', fs.existsSync(path.join(dataDir, 'archive', `${RECENT}.jsonl.gz`)) && fs.existsSync(path.join(dataDir, 'sessions', `${OPEN}.jsonl.gz`)))
  check("the CLI's transcripts are untouched", [OLD_CLI, RECENT, OPEN].every((s) => fs.existsSync(path.join(cliDir, `${s}.jsonl`))))
  check('the worktree is untouched', fs.existsSync(st.worktrees[0].path) && sizeOf(st.worktrees[0].path) === st.worktrees[0].bytes)

  // The lost session is deleted like Delete Session; the other keeps its record (in the workspace's database, #1061).
  const file = sessionsOf(alpha)
  // What each used is in the usage history (#1106), recorded before its copies went.
  check('the session the CLI lost is deleted', !file.sessions.some((s) => s.id === OLD_GONE) && file.deleted.includes(OLD_GONE) && (await inv('session:keptUsage', alpha)).some((k) => k.id === OLD_GONE))
  check('the session the CLI still has stays, with its usage kept', file.sessions.some((s) => s.id === OLD_CLI) && (await inv('session:usage', alpha, OLD_CLI))?.outputTokens === 50)
  const list = await inv('session:list', alpha)
  check('the Sessions tab no longer lists the lost one', !list.some((s) => s.id === OLD_GONE) && list.some((s) => s.id === OLD_CLI))
  check('the totals are unchanged', (await totals()) === before, `${await totals()} vs ${before}`)

  // The CLI drops its copy later: the totals still count it.
  fs.rmSync(path.join(cliDir, `${OLD_CLI}.jsonl`))
  check("… also after the CLI's copy goes", (await totals()) === before, `${await totals()} vs ${before}`)

  // Storage shows the smaller sizes.
  const after = await inv('storage:project', alpha, true)
  check('Storage measures again after Clean Up', after.archive === sizeOf(path.join(dataDir, 'archive')) && after.attachments === sizeOf(path.join(dataDir, 'attachments')) && after.total < st.total)

  // A dozen leftover attachments (no session has them): Clean Up…'s preview pages, filters and sorts them (#250).
  for (let i = 1; i <= 12; i++) write(path.join(dataDir, 'attachments', `0rphan${String(i).padStart(2, '0')}-0000-4000-8000-000000000000`, 'x.png'), lib.samplePng(20 + i * 10, 20 + i * 10))
  await page.locator('.activity-btn[aria-label="Settings"]').click()
  await page.locator('.settings-nav .row', { hasText: 'Workspace' }).click()
  // The project's page stays mounted (hidden) once shown: the visible table is Settings → Workspace's.
  const wsShown = page.locator('.storage-table:visible').first()
  await until(async () => (await wsShown.locator('tbody tr', { hasText: 'alpha' }).count()) > 0, HUNG_MS)
  await wsShown.locator('tbody tr', { hasText: 'alpha' }).getByRole('button', { name: 'Storage' }).click()
  await until(async () => (await group.getByRole('button', { name: 'Clean Up…' }).count()) === 1, HUNG_MS)
  await group.getByRole('button', { name: 'Clean Up…' }).click()
  await dialog.locator('label.choice', { hasText: 'Attachments of deleted sessions' }).locator('input').check()
  const orphans = dialog.locator('.cleanup-preview > div', { hasText: 'Attachments of deleted sessions' }).locator('.data-table')
  const orphanPaging = async () => ((await orphans.locator('.table-paging').innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ')
  check('Clean Up… lists the dozen leftover attachments, ten a page', !!(await until(async () => /1–10 of 12/.test(await orphanPaging()), HUNG_MS)), await orphanPaging())
  await orphans.locator('th button', { hasText: 'Size' }).click()
  check('… sorted by Size, the biggest first', /0rphan12/.test((await orphans.locator('tbody tr').first().locator('[title]').getAttribute('title')) ?? ''), await orphans.locator('tbody tr').first().locator('[title]').getAttribute('title'))
  await orphans.locator('input[aria-label="Filter What"]').fill('0rphan07')
  check('… filtered to one', !!(await until(async () => (await orphans.locator('tbody tr').count()) === 1 && /0rphan07/.test((await orphans.locator('tbody [title]').getAttribute('title')) ?? ''), HUNG_MS)))
  await orphans.locator('input[aria-label="Filter What"]').fill('nothing like an image')
  check('… no matches: says so', (await orphans.locator('.table-no-match').count()) === 1)
  await orphans.locator('.table-no-match button', { hasText: 'Clear filters' }).click()
  check('… and Clear filters brings them back', !!(await until(async () => /of 12/.test(await orphanPaging()), HUNG_MS)), await orphanPaging())
  await orphans.locator('th button', { hasText: 'Size' }).click()
  await orphans.locator('th button', { hasText: 'Size' }).click()
  await page.keyboard.press('Escape')
  await inv('session:stop', alpha, live.id).catch(() => undefined)
  await app.close().catch(() => undefined)
  console.log(failed ? `${failed} check(s) failed` : 'All storage checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
