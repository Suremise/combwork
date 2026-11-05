// A project folder renamed (#508): cards name their project by its stable id, so they follow it. Before: alpha with an
// agent (Builder) and three of its cards (Doing, Todo, archived), and two archived cards saved before projects had ids
// under "old-site", a project renamed to site since (its agent Claude was removed, but its sessions are site's: as the
// nine hive-website cards were after website's rename on 10 Oct). Combwork is closed, alpha renamed to gamma, Combwork opened
// again: the cards are gamma's at once, with Builder (not "(removed)"), archived ones too; the banner offers Repair…,
// whose plan gives old-site's cards to site; Repair does it, once, and the banner goes. Then a project renamed while
// Combwork runs: its card follows it. Screenshots of the board, the Repair dialog and the archive in both themes. Dev build,
// throwaway profile and workspace; no agent runs.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'projectrename-profile')
const ws = path.join(lib.WORK, 'projectrename-ws')
const alpha = path.join(ws, 'alpha')
const gamma = path.join(ws, 'gamma')
const beta = path.join(ws, 'beta')
const delta = path.join(ws, 'delta')
const site = path.join(ws, 'site')
const tasksDir = path.join(ws, '.combwork', 'tasks')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
const shot = (page, name) => page.screenshot({ path: path.join(lib.WORK, `projectrename-${name}.png`) })
/** Both themes, dark first (the suite's own), as boardarchive does. */
const shots = async (page, name) => {
  await shot(page, `${name}-dark`)
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  await lib.sleep(200)
  await shot(page, `${name}-light`)
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
}
/** A folder renamed, tried again while something (an indexer, a watcher) still has it open for a moment. */
const rename = async (from, to) => {
  for (let i = 0; ; i++) {
    try {
      return fs.renameSync(from, to)
    } catch (e) {
      if (i >= 40 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e
      await lib.sleep(250)
    }
  }
}
const project = (p, cfg = {}, sessions = []) => {
  fs.mkdirSync(path.join(p, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [], ...cfg }))
  fs.writeFileSync(path.join(p, '.combwork', 'sessions.json'), JSON.stringify({ version: 1, sessions }))
}
/** A card as Combwork saved them before projects had ids (no projectId). */
const oldCard = (n, proj, agent) =>
  fs.writeFileSync(
    path.join(tasksDir, `${n}.json`),
    JSON.stringify({ number: n, title: `Website card ${n}`, description: '', project: proj, agent, ...(agent ? { agentName: 'Claude' } : {}), column: 'done', order: n, labels: [], blocked: null, blockedBy: [], links: [], comments: [], history: [{ at: '2026-10-01T00:00:00.000Z', by: 'You', what: 'Created in Todo' }], archived: true, archivedFor: 'user', createdAt: '2026-10-01T00:00:00.000Z', createdBy: 'You', updatedAt: '2026-10-01T00:00:00.000Z' })
  )

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  project(alpha, { agents: [{ id: 'a-builder', name: 'Builder', provider: 'claude-code' }] })
  project(beta)
  project(site, { agents: [{ id: 'a-wb', name: 'WB', provider: 'claude-code' }] }, [{ id: 's1', provider: 'claude-code', agentId: 'a-claude', createdAt: '2026-10-01T00:00:00.000Z' }])
  fs.mkdirSync(tasksDir, { recursive: true })
  oldCard(1, 'old-site', 'a-claude')
  oldCard(2, 'old-site', null)
  fs.writeFileSync(path.join(tasksDir, 'board.json'), JSON.stringify({ version: 1, next: 3 }))
  // #514: a handover of alpha's, as Combwork writes them (its name's project slug and its header).
  fs.mkdirSync(path.join(ws, '.combwork', 'shared', 'handovers'), { recursive: true })
  fs.writeFileSync(path.join(ws, '.combwork', 'shared', 'handovers', '2026-10-01-alpha-plan.md'), '# Plan\n\n- **Project:** alpha\n- **Date:** 2026-10-01 10:00 (2026-10-01T10:00:00Z)\n\nWhere it stands.\n')
  lib.enableProviders(userData)
  const env = { CW_API_PORT: lib.port(47866) }

  // --- First run: alpha's cards, each saved with alpha's id.
  let r = await lib.launch({ userData, env, viewport: { width: 1400, height: 850 } })
  r.page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(r.inv, r.page, ws)
  const doing = await r.inv('tasks:create', { title: 'Builder is on this', project: 'alpha', agent: 'Builder', column: 'doing' })
  const todo = await r.inv('tasks:create', { title: 'Next for Builder', project: 'alpha', agent: 'Builder' })
  const old = await r.inv('tasks:create', { title: 'An archived one', project: 'alpha', agent: 'Builder' })
  await r.inv('tasks:archive', old.number, true)
  const id = readJson(path.join(alpha, '.combwork', 'project.json')).id
  check('the project has an id, in its own project.json', /^p-[0-9a-f]+$/.test(id ?? ''), String(id))
  check('its cards are saved with it', [doing, todo, old].every((c) => lib.readCard(ws, c.number).projectId === id))
  check('…and the board shows no id', !('projectId' in doing))
  check('cards saved before ids, by a project no longer there by that name, are left as they were', lib.readCard(ws, 1).projectId === undefined)
  // #1017: the cards' files moved into the board's database as it opened, the folder kept as a backup.
  check("the cards' files are in the board now, their folder kept as a backup", fs.readdirSync(path.join(ws, '.combwork')).some((f) => f.startsWith('tasks.imported-')) && !fs.existsSync(path.join(tasksDir, '1.json')))
  await r.app.close()

  // --- Renamed while Combwork was closed.
  await rename(alpha, gamma)
  r = await lib.launch({ userData, env, viewport: { width: 1400, height: 850 } })
  const { page, inv } = r
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  // Archived cards in full (#1017: the window has them in short until its Archived view opens).
  const cards = async () => await inv('tasks:list', true)
  const mine = (list) => list.filter((c) => [doing.number, todo.number, old.number].includes(c.number))
  check("the renamed project's cards are its at once, archived ones too", mine(await cards()).every((c) => c.project === 'gamma') && mine(await cards()).length === 3, JSON.stringify(mine(await cards()).map((c) => c.project)))
  check('none is left under the old name', !(await cards()).some((c) => c.project === 'alpha'))
  // #514: its handover from before the rename is still its latest (what cw_read_latest_handover reads).
  const apiToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
  const handovers = async (name) => (await (await fetch(`http://127.0.0.1:${env.CW_API_PORT}/v1/shared/handovers?project=${name}`, { headers: { Authorization: `Bearer ${apiToken}` } })).json())
  check("the renamed project's latest handover is the one from before its rename", !!(await lib.until(async () => (await handovers('gamma'))[0]?.path === 'handovers/2026-10-01-alpha-plan.md', 10000)), JSON.stringify(await handovers('gamma')))
  check("…and the workspace's record of names has its rename, by its id", !!(await lib.until(() => {
    const j = fs.existsSync(path.join(ws, '.combwork', 'project-names.json')) ? readJson(path.join(ws, '.combwork', 'project-names.json')) : null
    return j?.projects?.[id]?.name === 'gamma' && JSON.stringify(j.projects[id].former) === '["alpha"]'
  }, 10000)))
  check('the saved cards catch up when the workspace opens', !!(await lib.until(() => lib.readCard(ws, doing.number).project === 'gamma', 10000)))
  await page.getByRole('button', { name: 'Task Board' }).click()
  const tile = page.locator(`.task-card[data-task="${doing.number}"]`)
  await tile.waitFor({ timeout: 10000 })
  const tileText = await tile.innerText()
  check('on the board, with its agent (not "(removed)")', /Builder/.test(tileText) && !/removed/.test(tileText), tileText)
  const banner = page.locator('.moved-banner')
  check('the banner offers Repair…', !!(await lib.until(async () => (await banner.count()) === 1, 15000)))
  const bannerText = await banner.innerText().catch(() => '')
  check("…naming old-site's cards", /2 cards of old-site belong to site/.test(bannerText), bannerText)
  await shots(page, 'board')

  // --- Repair gives old-site's cards to site.
  await page.locator('.moved-banner button', { hasText: 'Repair…' }).click()
  const dialog = page.locator('.dialog', { has: page.locator('.move-repair') })
  await dialog.waitFor({ timeout: 10000 })
  check('the plan gives the cards saved under old-site to site', !!(await lib.until(async () => /Board: old-site; will give 2 cards \(#1, #2\) to site/.test(await dialog.innerText()), 10000)), await dialog.innerText())
  await shots(page, 'repair-plan')
  await dialog.getByRole('button', { name: 'Repair', exact: true }).click()
  check('Repair says what it did', !!(await lib.until(async () => /2 cards of old-site now belong to site/.test(await dialog.innerText()), 15000)), await dialog.innerText())
  await shots(page, 'repair-report')
  await dialog.locator('.btn.primary', { hasText: 'Close' }).click()
  check('…and the banner is gone', !!(await lib.until(async () => (await banner.count()) === 0, 10000)))
  const websiteCards = (await cards()).filter((c) => c.number === 1 || c.number === 2)
  check("old-site's cards are site's, still archived, with their agent", websiteCards.every((c) => c.project === 'site' && c.archived) && websiteCards.find((c) => c.number === 1)?.agent === 'a-claude', JSON.stringify(websiteCards.map((c) => [c.project, c.archived, c.agent])))
  check('each says so in its history', websiteCards.every((c) => c.history.at(-1)?.what === 'Project: old-site → site (renamed or moved)'))
  check('…and is saved with site’s id', lib.readCard(ws, 1).projectId === readJson(path.join(site, '.combwork', 'project.json')).id)
  const again = await inv('workspace:moveRepair')
  check('Repair again changes nothing', again.done.length === 0 && again.failed.length === 0, JSON.stringify(again))

  // --- The archive lists them under their projects now.
  await page.locator('.board-toolbar label', { hasText: 'Archived (' }).click()
  const table = page.locator('.archived-cards')
  await table.waitFor({ timeout: 10000 })
  // A row by its card's number (its cell shows the card's key, #1221).
  const rowOf = (n) => table.locator('tbody tr', { has: page.locator(`.task-number[data-task="${n}"]`) })
  check('Archived shows the renamed project’s card under its new name, with its agent', !!(await lib.until(async () => {
    const t = await rowOf(old.number).innerText().catch(() => '')
    return /gamma/.test(t) && /Builder/.test(t) && !/removed/.test(t)
  }, 10000)), await rowOf(old.number).innerText().catch((e) => e.message))
  check('…and the repaired ones under site', /site/.test(await rowOf(1).innerText().catch(() => '')))
  await shots(page, 'archive')
  await page.locator('.board-toolbar label', { hasText: 'Archived (' }).click()

  // --- Renamed while Combwork runs: the card follows it.
  const live = await inv('tasks:create', { title: 'Beta card', project: 'beta' })
  // Shown on the board, then a pause on purpose: the card's own write has been told and read before the rename, so only
  // the rename can bring the new name to the board (#508 round 1: a late write's notice had hidden that it didn't).
  check('the board shows the card under beta', !!(await lib.until(async () => /beta/.test(await page.locator(`.task-card[data-task="${live.number}"]`).innerText().catch(() => '')), 10000)))
  await lib.sleep(2000) // on purpose: the card write above is told and read first
  await rename(beta, delta)
  check('a project renamed while Combwork runs keeps its cards', !!(await lib.until(async () => (await cards()).find((c) => c.number === live.number)?.project === 'delta', 15000)), JSON.stringify((await cards()).find((c) => c.number === live.number)?.project))
  check('…and the board lists it under the new name', !!(await lib.until(async () => /delta/.test(await page.locator(`.task-card[data-task="${live.number}"]`).innerText().catch(() => '')), 10000)))
  const sidebar = async () => (await inv('workspace:get'))?.projects?.map((p) => p.name) ?? []
  check('…and the project list says delta, not beta', !!(await lib.until(async () => {
    const names = await sidebar()
    return names.includes('delta') && !names.includes('beta')
  }, 10000)), JSON.stringify(await sidebar()))
  await page.locator('.sidebar', { hasText: 'delta' }).first().waitFor({ timeout: 5000 }).catch(() => undefined)
  await shots(page, 'live-rename')

  await r.app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
