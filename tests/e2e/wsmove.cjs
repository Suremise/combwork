// A workspace moved to another folder (#146). Before: a git project with three worktree agents (Builder has run a
// session in its worktree, so its session record and the fake Claude home have its folder; Third has a commit on its branch)
// and a plain agent, plus Claude Code's memory for the project's folder. The workspace and its worktrees folder are
// moved together, Second's worktree then on to somewhere else and Third's deleted, and a file blocks the copy of
// Builder's Claude folder. Combwork reopens it: the banner offers Repair…; Repair refuses while an agent runs; the dialog's
// plan; Recreate worktree for Third (made again on its branch, with its commit); the report with the failed copy and
// Second still to locate, the copy kept to do in project.json. After a restart: still pending, nothing repeated; with
// the blocker gone and Second located, Repair finishes: git lists the worktrees at their new folders and they work, the
// sessions point there, Claude Code's folders are copied with the old ones kept, Open Recent lists the new folder, and
// the banner is gone. Repair again changes nothing. The same move found again with only a conflicting file: shown,
// listed, never overwritten. Then the common case: a workspace moved without its worktrees
// folder, whose worktree stays put and is linked to the moved project. Dev build, throwaway profile, folders and fake
// Claude home; quiet.
// Dev build only (#1580): it starts this checkout's Electron itself, and its agents are 0.9 worktree agents
// (agents:testLegacy, refused by a packaged build): moving their worktrees with the workspace is what it tests.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
const { deliveriesPlace, sessionsOf } = require('./storeDocs.cjs')

const userData = path.join(lib.WORK, 'wsmove-profile')
const root = path.join(lib.WORK, 'wsmove')
const before = path.join(root, 'before')
const after = path.join(root, 'after')
const ws1 = path.join(before, 'ws')
const ws2 = path.join(after, 'ws')
const alpha1 = path.join(ws1, 'alpha')
const alpha2 = path.join(ws2, 'alpha')
const wt1 = path.join(`${ws1}.worktrees`, 'alpha', 'builder')
const wt2 = path.join(`${ws2}.worktrees`, 'alpha', 'builder')
const second2 = path.join(`${ws2}.worktrees`, 'alpha', 'second')
const third2 = path.join(`${ws2}.worktrees`, 'alpha', 'third')
const second1 = path.join(`${ws1}.worktrees`, 'alpha', 'second')
const third1 = path.join(`${ws1}.worktrees`, 'alpha', 'third')
const elsewhere = path.join(root, 'elsewhere', 'second')
const home = path.join(lib.WORK, 'wsmove-claude-home')
const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, '-')
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const gitOut = (cwd, args) => execFileSync('git', args, { cwd, env: lib.gitEnv(), encoding: 'utf8' })
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
/**
 * Makes a host's session records unwritable, or writable again (#1061: rows of its workspace's database, where a
 * read-only sessions.json stood in before): triggers that refuse every change to its rows, as SQLite refuses a write.
 */
const sessionsWritable = (host, writable) => {
  const { ws, scope } = deliveriesPlace(host)
  const db = new DatabaseSync(path.join(ws, '.combwork', 'hive.db'), { timeout: 5000 })
  try {
    for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
      const name = `test_sessions_readonly_${op.toLowerCase()}`
      const row = op === 'INSERT' ? 'NEW' : 'OLD'
      // The sessions table since 1.0 (#1211).
      db.exec(writable ? `DROP TRIGGER IF EXISTS ${name}` : `CREATE TRIGGER ${name} BEFORE ${op} ON sessions WHEN ${row}.host = '${scope.replace(/'/g, "''")}' BEGIN SELECT RAISE(ABORT, 'attempt to write a readonly database (test)'); END`)
    }
  } finally {
    db.close()
  }
}
/** Every file under a folder with its size and time: what a repair that changes nothing leaves as it was. */
const snapshot = (dir) => {
  const out = []
  const walk = (d) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) {
        const s = fs.statSync(p)
        out.push(`${path.relative(dir, p)}:${s.size}:${Math.round(s.mtimeMs)}`)
      }
    }
  }
  walk(dir)
  return out.sort().join('\n')
}

async function launch() {
  const claude = { CLAUDE_CONFIG_DIR: home }
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47937), ...claude })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  return { app, page, inv }
}

;(async () => {
  for (const d of [userData, root]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha1)
  // The fake asks to trust a folder it hasn't seen: these are the ones it runs in.
  lib.fakeClaude(userData, home, [wt1, third1, alpha2])

  // --- Before the move.
  {
    const { app, page, inv } = await launch()
    await lib.openWorkspace(inv, page, ws1)
    const builder = await inv('agents:testLegacy', alpha1, { location: 'new-worktree', name: 'Builder' })
    await inv('agents:testLegacy', alpha1, { location: 'new-worktree', name: 'Second' })
    // Third has work on its branch: the worktree recreated after the move must have it.
    const third = await inv('agents:testLegacy', alpha1, { location: 'new-worktree', name: 'Third' })
    fs.writeFileSync(path.join(third.worktree.path, 'third.txt'), 'third\n')
    gitOut(third.worktree.path, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'third.txt'])
    gitOut(third.worktree.path, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'third work'])
    await lib.addAgent(inv, alpha1, { name: 'Coder' })
    await inv('project:setActive', alpha1, true)
    check('the worktree agent works in the workspace’s worktrees folder', same(builder.worktree?.path, wt1), builder.worktree?.path)
    // Builder and Third each run a session in their worktree: their records and the Claude home have their folders.
    for (const agent of [builder, third]) {
      await inv('session:start', alpha1, { agentId: agent.id })
      const live = async () => (await inv('session:live')).find((s) => s.agentId === agent.id)
      await lib.until(async () => (await live())?.status === 'ready', 15000)
      await lib.sendPrompt(inv, lib.ptyKey(alpha1, agent.id), 'hello', { submitted: async () => ['working', 'finished'].includes((await live())?.status) })
      await lib.until(async () => (await live())?.status === 'finished', 15000)
      await inv('session:stop', alpha1, agent.id)
      await lib.until(async () => !(await live()), 10000)
    }
    // Claude Code's auto memory for the project's folder.
    fs.mkdirSync(path.join(home, 'projects', enc(alpha1), 'memory'), { recursive: true })
    fs.writeFileSync(path.join(home, 'projects', enc(alpha1), 'memory', 'MEMORY.md'), '- [A fact](fact.md) — remembered before the move\n')
    const recorded = await lib.until(() => readJson(path.join(ws1, '.combwork', 'workspace.json')).lastPath && readJson(path.join(alpha1, '.combwork', 'project.json')).lastPath, 10000)
    check('Combwork records where the workspace and its projects are', !!recorded && same(readJson(path.join(ws1, '.combwork', 'workspace.json')).lastPath, ws1) && same(readJson(path.join(alpha1, '.combwork', 'project.json')).lastPath, alpha1))
    const sessions = sessionsOf(alpha1).sessions
    check('the sessions ran in the worktrees (their cwd)', sessions.some((s) => same(s.cwd, wt1)) && sessions.some((s) => same(s.cwd, third1)), JSON.stringify(sessions.map((s) => s.cwd)))
    check('…and the fake Claude home has its transcript under the worktree’s folder name', fs.existsSync(path.join(home, 'projects', enc(wt1))))
    await app.close()
  }

  // --- The move: the workspace and its worktrees folder together; the second worktree then somewhere else, the third
  // deleted (its branch kept). A file where the moved Builder worktree's Claude folder goes makes that copy fail.
  fs.renameSync(before, after)
  fs.mkdirSync(path.dirname(elsewhere), { recursive: true })
  fs.renameSync(second2, elsewhere)
  fs.rmSync(third2, { recursive: true, force: true })
  const blocker = path.join(home, 'projects', enc(wt2))
  fs.writeFileSync(blocker, 'not a folder')
  const keyOf = async (inv, name) => `${alpha2}#${(await inv('workspace:refresh')).projects.find((p) => p.name === 'alpha').agents.find((a) => a.name === name).id}`

  {
    const { app, page, inv } = await launch()
    await lib.openWorkspace(inv, page, ws2)
    const banner = page.locator('.moved-banner')
    check('reopened at its new folder: the banner says where it was moved from', !!(await lib.until(async () => (await banner.count()) === 1 && (await banner.innerText()).includes(ws1), 15000)), await banner.innerText().catch(() => ''))
    await page.screenshot({ path: path.join(lib.WORK, 'wsmove-1-banner.png') })
    const recent0 = await inv('workspace:recent')
    check('Open Recent still has the old folder, not found', recent0.some((r) => same(r.path, ws1) && !r.exists), JSON.stringify(recent0))

    const plan = await inv('workspace:movePlan')
    const host = plan?.hosts.find((h) => h.name === 'alpha')
    const w = (name) => host?.worktrees.find((x) => x.agentName === name)
    check('the plan: the workspace’s old and new folders', same(plan?.from, ws1) && same(plan?.to, ws2), JSON.stringify(plan && { from: plan.from, to: plan.to }))
    check('…Builder’s worktree moved along with it', w('Builder')?.how === 'moved' && same(w('Builder')?.to, wt2), JSON.stringify(w('Builder')))
    check('…Second’s worktree not found', w('Second')?.how === 'missing', JSON.stringify(w('Second')))
    check('…Third’s worktree not found, its branch still there (Recreate offered)', w('Third')?.how === 'missing' && w('Third')?.branchExists === true && w('Third')?.branch === 'cw/ws/alpha/third', JSON.stringify(w('Third')))
    check('…the session’s folder to rewrite', host?.sessions === 1, String(host?.sessions))
    const copies = host?.folders ?? []
    check('…Claude Code’s folders to copy: the project’s (its memory) and the worktree’s (the transcript)', copies.length === 2 && copies.every((f) => f.copy >= 1 && f.kept.length === 0), JSON.stringify(copies))
    check('…and Open Recent', plan?.recent === true)
    check('…and the projects marked Working on', JSON.stringify(plan?.working) === '["alpha"]', JSON.stringify(plan?.working))

    // Repair refuses while an agent of the workspace runs.
    const coder = (await inv('workspace:refresh')).projects.find((p) => p.name === 'alpha').agents.find((a) => a.name === 'Coder')
    await inv('session:start', alpha2, { agentId: coder.id })
    await lib.until(async () => (await inv('session:live')).some((s) => s.agentId === coder.id && s.status === 'ready'), 15000)
    const refused = await inv('workspace:moveRepair').then(() => '', (e) => String(e.message ?? e))
    check('Repair refuses while an agent runs, naming it', /Stop the running agents first: alpha · Coder/.test(refused), refused)
    await page.locator('.moved-banner button', { hasText: 'Repair…' }).click()
    const dialog = page.locator('.dialog', { has: page.locator('.move-repair') })
    check('the dialog says to stop the agent, Repair disabled', !!(await lib.until(async () => /Stop the running agents first/.test(await dialog.innerText().catch(() => '')), 10000)) && (await dialog.locator('button', { hasText: /^Repair$/ }).isDisabled()))
    await inv('session:stop', alpha2, coder.id)
    await lib.until(async () => !(await inv('session:live')).some((s) => s.agentId === coder.id), 10000)
    await page.keyboard.press('Escape')
    await lib.until(async () => (await dialog.count()) === 0, 5000)

    // Repair from the dialog, Third recreated: everything but the worktree it couldn't find, and the copy that fails.
    await page.locator('.moved-banner button', { hasText: 'Repair…' }).click()
    const text = async () => (await dialog.innerText().catch(() => '')).replace(/\s+/g, ' ')
    // A table (#1305): each row read as one sentence (its first cell's, for screen readers): What · Was · Now · Will do.
    check('the dialog shows what Repair will do', !!(await lib.until(async () => /Builder.s worktree: was [^;]*, now [^;]*; will git worktree repair/.test(await text()) && /Second.s worktree: was [^;]*; will recreate, locate or remove its link/.test(await text()) && /Sessions: was [^;]*, now [^;]*; will point 1 session/.test(await text()) && /Claude Code.s conversations and memory: was 2 folders; will copy \d+ files?; the old ones stay/.test(await text()), 10000)), await text())
    check('…as a table, What · Was · Now · Will do', (await dialog.locator('.repair-plan thead th').allInnerTexts()).slice(0, 4).join('|') === 'WHAT|WAS|NOW|WILL DO', JSON.stringify(await dialog.locator('.repair-plan thead th').allInnerTexts()))
    check('…the paths as their part that differs, the full path on hover', (await dialog.locator('.repair-plan tr', { hasText: 'Builder’s worktree' }).or(dialog.locator('.repair-plan tr', { hasText: "Builder's worktree" })).locator('.short-path[data-path]').first().getAttribute('data-path')).toLowerCase() === wt1.toLowerCase())
    const thirdLine = dialog.locator('.repair-plan tr', { hasText: "Third's worktree" })
    await thirdLine.getByRole('button', { name: 'Recreate worktree' }).click()
    check('…Recreate worktree: the plan says it is made again on its branch', !!(await lib.until(async () => /Third.s worktree: was [^;]*; will recreate on cw\/ws\/alpha\/third/.test(await text()), 10000)), await text())
    await page.screenshot({ path: path.join(lib.WORK, 'wsmove-2-plan.png') })
    await dialog.locator('button', { hasText: /^Repair$/ }).click()
    check('…then what it did, with problems: the copy that failed, and the worktree still to locate', !!(await lib.until(async () => /with problems/.test(await text()) && /for Builder.s worktree couldn.t be copied/.test(await text()) && /Second.s worktree wasn.t found/.test(await text()), 20000)), await text())
    // Recreating prunes git's stale entries, which would drop the link Second still needs to be repaired: refused.
    check('…Recreate refused while Second (missing too) still needs its git link', /Third.s worktree couldn.t be recreated: Recreating runs git worktree prune, which would also drop git.s link to .*second/.test(await text()), await text())
    check('…and Second’s link is still there', gitOut(alpha2, ['worktree', 'list', '--porcelain']).toLowerCase().includes(second1.toLowerCase().replace(/\\/g, '/')) || gitOut(alpha2, ['worktree', 'list', '--porcelain']).toLowerCase().includes(second1.toLowerCase()))
    await page.screenshot({ path: path.join(lib.WORK, 'wsmove-3-report.png') })
    // The report as a table (#1313): What · Was · Now · Result, problems first, each row's full line on hover.
    check('…the report as a table, What · Was · Now · Result', (await dialog.locator('.repair-report thead th').allInnerTexts()).slice(0, 4).join('|') === 'WHAT|WAS|NOW|RESULT', JSON.stringify(await dialog.locator('.repair-report thead th').allInnerTexts()))
    const outcomes = await dialog.locator('.repair-report tbody tr:not(.item-table-group)').evaluateAll((rows) => rows.map((r) => ['failed', 'skipped', 'done'].find((o) => r.classList.contains(`repair-${o}`))))
    check('…problems first, then what is left to choose, then what was done', outcomes.length > 3 && outcomes.join(',') === [...outcomes].sort((a, b) => ['failed', 'skipped', 'done'].indexOf(a) - ['failed', 'skipped', 'done'].indexOf(b)).join(','), JSON.stringify(outcomes))
    // Third's result names the worktree in the way by its agent, no path (the row's tooltip has git's full sentence).
    const thirdResult = (await dialog.locator('.repair-report tr', { hasText: "Third's worktree" }).first().locator('td').nth(3).innerText()).replace(/\s+/g, ' ').trim()
    check('…Third’s result: Second’s worktree in the way, by name, no path', /another worktree is missing too \(Second's worktree\)/.test(thirdResult) && !/[A-Z]:\\/.test(thirdResult), thirdResult)
    await inv('settings:update', { appearance: { theme: 'light' } })
    await lib.until(() => page.evaluate(() => document.documentElement.dataset.theme === 'light'), 10000)
    await page.screenshot({ path: path.join(lib.WORK, 'wsmove-3-report-light.png') })
    await inv('settings:update', { appearance: { theme: 'dark' } })
    await lib.until(() => page.evaluate(() => document.documentElement.dataset.theme === 'dark'), 10000)
    await dialog.locator('button', { hasText: 'Close' }).click()
    check('the banner stays while something is left', (await banner.count()) === 1)
    const pending = readJson(path.join(alpha2, '.combwork', 'project.json')).pendingCopies ?? []
    check('the failed copy is kept to do (project.json)', pending.some((m) => same(m.from, wt1) && same(m.to, wt2)), JSON.stringify(pending))
    await app.close()
  }

  // Combwork restarts before the retry: the failed copy is still to do; nothing done before is done again.
  {
    const { app, page, inv } = await launch()
    await lib.openWorkspace(inv, page, ws2)
    const banner = page.locator('.moved-banner')
    check('after a restart, the banner is still there', !!(await lib.until(async () => (await banner.count()) === 1, 15000)))
    const plan = await inv('workspace:movePlan')
    const host = plan?.hosts.find((h) => h.name === 'alpha')
    check('…its plan: Builder’s data still to copy, Builder’s worktree not repaired again, no session to rewrite', !host?.worktrees.some((x) => x.agentName === 'Builder') && host?.folders.some((f) => f.of === "Builder's worktree" && f.copy >= 1) && host?.sessions === 0, JSON.stringify(host))
    check('…Second and Third still missing', ['Second', 'Third'].every((n) => host?.worktrees.some((x) => x.agentName === n && x.how === 'missing')), JSON.stringify(host?.worktrees))
    fs.rmSync(blocker, { force: true })

    // Locate… Second (the folder the dialog's picker returns) and Recreate Third, then repair the rest: git relinks
    // Second first, so the prune before Third is made again drops only Third's stale entry.
    const key = await keyOf(inv, 'Second')
    const choices = { locate: { [key]: elsewhere }, recreate: [await keyOf(inv, 'Third')] }
    const located = await inv('workspace:movePlan', choices)
    const second = located.hosts.find((h) => h.name === 'alpha').worktrees.find((x) => x.agentName === 'Second')
    const third = located.hosts.find((h) => h.name === 'alpha').worktrees.find((x) => x.agentName === 'Third')
    check('Locate…: the plan uses the folder picked', second?.how === 'located' && same(second.to, elsewhere), JSON.stringify(second))
    check('Recreate: at its moved-along place', third?.how === 'recreate' && same(third.to, third2), JSON.stringify(third))
    // The session records can't be written while it runs: the worktrees are repaired and Third made again, but the
    // sessions can't follow them yet.
    sessionsWritable(alpha2, false)
    const report = await inv('workspace:moveRepair', choices).finally(() => sessionsWritable(alpha2, true))
    check('with the session records unwritable, Repair says so and isn’t complete', !report.complete && report.failed.some((l) => /sessions' folders couldn't be updated/.test(l)), JSON.stringify(report))
    check('Third is back at its moved-along place, on its branch, with its commit', report.done.some((l) => /Third's worktree was recreated on its branch cw\/ws\/alpha\/third/.test(l)) && same(gitOut(third2, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'cw/ws/alpha/third') && gitOut(third2, ['log', '--oneline']).includes('third work'))
    check('…copying Builder’s data this time, without repeating what was done', report.done.some((l) => /copied \d+ files? .* for Builder's worktree/.test(l)) && !report.done.some((l) => /Builder's worktree (is now at|was)/.test(l)), JSON.stringify(report.done))
    const kept = readJson(path.join(alpha2, '.combwork', 'project.json'))
    check('Third’s new path and the move its sessions and data follow were saved together', same(kept.agents.find((a) => a.name === 'Third').worktree?.path, third2) && (kept.pendingCopies ?? []).some((m) => same(m.from, third1) && same(m.to, third2)), JSON.stringify(kept.pendingCopies))
    check('…its sessions still point to the old folder', sessionsOf(alpha2).sessions.some((s) => same(s.cwd, third1)))
    check('…its Claude data copied all the same (the move stays pending for the sessions)', report.done.some((l) => /copied \d+ files? .* for Third's worktree/.test(l)))
    await app.close()
  }

  // Combwork restarts, the records writable again: Repair finishes Third's sessions and data without repeating git.
  {
    const { app, page, inv } = await launch()
    await lib.openWorkspace(inv, page, ws2)
    const banner = page.locator('.moved-banner')
    check('after the failed write and a restart, the banner is still there', !!(await lib.until(async () => (await banner.count()) === 1, 15000)))
    const plan = await inv('workspace:movePlan')
    const host = plan?.hosts.find((h) => h.name === 'alpha')
    check('…its plan: no worktree to repair or make again, Third’s session to follow it, its data already there', host?.worktrees.length === 0 && host?.sessions === 1 && host?.folders.some((f) => f.of === "Third's worktree" && f.copy === 0 && f.kept.length === 0), JSON.stringify(host))
    const report = await inv('workspace:moveRepair')
    check('…and Repair finishes', report.complete && report.failed.length === 0, JSON.stringify(report))
    check('…rewriting the session, nothing repeated (no git step, no copy)', report.done.length === 1 && /1 session now points/.test(report.done[0]), JSON.stringify(report.done))
    check('Third’s session points to its new folder', sessionsOf(alpha2).sessions.some((s) => same(s.cwd, third2)) && !sessionsOf(alpha2).sessions.some((s) => same(s.cwd, third1)))
    check('…its Claude data copied, the old folder kept', fs.readdirSync(path.join(home, 'projects', enc(third2))).some((f) => f.endsWith('.jsonl')) && fs.readdirSync(path.join(home, 'projects', enc(third1))).some((f) => f.endsWith('.jsonl')))
    check('the banner is gone', !!(await lib.until(async () => (await banner.count()) === 0, 10000)))
    check('nothing is left to do in project.json', !readJson(path.join(alpha2, '.combwork', 'project.json')).pendingCopies)

    // What it did.
    const listed = gitOut(alpha2, ['worktree', 'list', '--porcelain'])
      .split(/\r?\n/)
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice(9))
    check('git lists the worktrees at their new folders', listed.some((p) => same(p, wt2)) && listed.some((p) => same(p, elsewhere)) && listed.some((p) => same(p, third2)), JSON.stringify(listed))
    check('…and they work: git in the worktree finds itself', same(gitOut(wt2, ['rev-parse', '--show-toplevel']).trim(), wt2) && same(gitOut(elsewhere, ['rev-parse', '--show-toplevel']).trim(), elsewhere))
    const agents = (await inv('workspace:refresh')).projects.find((p) => p.name === 'alpha').agents
    check('the agents’ worktree records point there', same(agents.find((a) => a.name === 'Builder').worktree?.path, wt2) && same(agents.find((a) => a.name === 'Second').worktree?.path, elsewhere) && same(agents.find((a) => a.name === 'Third').worktree?.path, third2), JSON.stringify(agents.map((a) => a.worktree?.path)))
    const sessions = sessionsOf(alpha2).sessions
    check('the session’s folder is the new one', sessions.some((s) => same(s.cwd, wt2)) && !sessions.some((s) => same(s.cwd, wt1)), JSON.stringify(sessions.map((s) => s.cwd)))
    check('Claude Code’s memory copied to the folder for the new path', fs.existsSync(path.join(home, 'projects', enc(alpha2), 'memory', 'MEMORY.md')))
    check('…the transcript too', fs.readdirSync(path.join(home, 'projects', enc(wt2))).some((f) => f.endsWith('.jsonl')))
    check('…with the old folders still there', fs.existsSync(path.join(home, 'projects', enc(alpha1), 'memory', 'MEMORY.md')) && fs.readdirSync(path.join(home, 'projects', enc(wt1))).some((f) => f.endsWith('.jsonl')))
    const recent = await inv('workspace:recent')
    check('Open Recent lists the new folder instead of the old', recent.some((r) => same(r.path, ws2)) && !recent.some((r) => same(r.path, ws1)), JSON.stringify(recent))
    check('alpha is marked Working on again', (await inv('workspace:refresh')).projects.find((p) => p.name === 'alpha').active === true)
    check('the new folders are recorded', same(readJson(path.join(ws2, '.combwork', 'workspace.json')).lastPath, ws2) && same(readJson(path.join(alpha2, '.combwork', 'project.json')).lastPath, alpha2))

    // Repair again: nothing to do, nothing changed.
    const files = () => [snapshot(path.join(alpha2, '.combwork')), JSON.stringify(sessionsOf(alpha2)), snapshot(path.join(home, 'projects')), gitOut(alpha2, ['worktree', 'list', '--porcelain'])].join('\n--\n')
    const before2 = files()
    const again = await inv('workspace:moveRepair')
    check('Repair again: nothing to repair', again.complete && again.done.length === 0 && again.failed.length === 0, JSON.stringify(again))
    check('…and nothing changed', files() === before2)
    await app.close()

    // The same move found again (its records put back as they were) when the only difference is a file of Claude Code's
    // changed at the new place since: the banner shows it, Repair lists it, and never overwrites it.
    for (const [f, p] of [
      [path.join(ws2, '.combwork', 'workspace.json'), ws1],
      [path.join(alpha2, '.combwork', 'project.json'), alpha1]
    ]) {
      const j = readJson(f)
      j.lastPath = p
      fs.writeFileSync(f, JSON.stringify(j, null, 2))
    }
    const memory2 = path.join(home, 'projects', enc(alpha2), 'memory', 'MEMORY.md')
    fs.appendFileSync(memory2, '- [Learnt since](since.md) — remembered after the move\n')
    const mine = fs.readFileSync(memory2, 'utf8')
    const r2 = await launch()
    await lib.openWorkspace(r2.inv, r2.page, ws2)
    check('found again with only a conflicting file: the banner shows', !!(await lib.until(async () => (await r2.page.locator('.moved-banner').count()) === 1, 15000)))
    const conflictPlan = await r2.inv('workspace:movePlan')
    const ch = conflictPlan?.hosts.find((h) => h.name === 'alpha')
    check('…the plan has nothing to copy, only the file kept', ch?.folders.some((f) => f.copy === 0 && f.kept.some((k) => k.endsWith('MEMORY.md'))) && ch.worktrees.length === 0 && ch.sessions === 0, JSON.stringify(ch))
    const conflict = await r2.inv('workspace:moveRepair')
    check('…Repair lists it as not overwritten, and finishes', conflict.complete && conflict.skipped.some((l) => /not overwritten: memory.MEMORY\.md/.test(l)) && conflict.failed.length === 0, JSON.stringify(conflict))
    check('…the file is as it was', fs.readFileSync(memory2, 'utf8') === mine)
    check('…and the banner is gone', !!(await lib.until(async () => (await r2.page.locator('.moved-banner').count()) === 0, 10000)))
    await r2.app.close()
  }

  // --- The common case: the workspace moved, its worktrees folder left where it was. The worktree stays put, linked to
  // the moved project again.
  {
    const wsB1 = path.join(root, 'b1', 'wsb')
    const wsB2 = path.join(root, 'b2', 'wsb')
    const betaB1 = path.join(wsB1, 'beta')
    const betaB2 = path.join(wsB2, 'beta')
    const wtB = path.join(`${wsB1}.worktrees`, 'beta', 'stay')
    lib.gitProject(betaB1)
    let r = await launch()
    await lib.openWorkspace(r.inv, r.page, wsB1)
    await r.inv('agents:testLegacy', betaB1, { location: 'new-worktree', name: 'Stay' })
    await lib.until(() => readJson(path.join(betaB1, '.combwork', 'project.json')).lastPath, 10000)
    await r.app.close()
    fs.mkdirSync(path.dirname(wsB2), { recursive: true })
    fs.renameSync(wsB1, wsB2)
    r = await launch()
    await lib.openWorkspace(r.inv, r.page, wsB2)
    check('worktrees left behind: the banner shows', !!(await lib.until(async () => (await r.page.locator('.moved-banner').count()) === 1, 15000)))
    const plan = await r.inv('workspace:movePlan')
    // Stay's worktree is still git's at its place, so the slots' migration adopted it at this opening (#1441): Repair plans
    // it as its carried slot (#1447), linked where it is, as it planned the agent's worktree before.
    const stay = plan?.hosts.find((h) => h.name === 'beta')?.worktrees.find((w) => w.agentName === 'Stay' || (w.of?.kind === 'slot' && w.of.agent === 'Stay'))
    check('…the worktree stayed where it was, to be linked to the moved project', stay?.how === 'stayed' && same(stay.to, wtB), JSON.stringify(stay))
    const report = await r.inv('workspace:moveRepair')
    check('…Repair finishes', report.complete && report.failed.length === 0, JSON.stringify(report))
    const listed = gitOut(betaB2, ['worktree', 'list', '--porcelain'])
    check('…git lists it from the moved project', listed.split(/\r?\n/).some((l) => l.startsWith('worktree ') && same(l.slice(9), wtB)), listed)
    check('…and the worktree finds the moved repository', same(path.resolve(wtB, gitOut(wtB, ['rev-parse', '--git-common-dir']).trim()), path.join(betaB2, '.git')))
    const agent = (await r.inv('workspace:refresh')).projects.find((p) => p.name === 'beta').agents.find((a) => a.name === 'Stay')
    check('…its record unchanged', same(agent.worktree?.path, wtB), agent.worktree?.path)
    await r.app.close()
  }

  if (failed) console.log(`${failed} failed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
