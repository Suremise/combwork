// Who gets each Hive skill, as the Skills UI says it: a skill's audience (metadata.audience in its SKILL.md: project
// agents by default, the Assistant, or both) on its page and, when it isn't the default, its row, including a
// deleted bundled skill; the delete and Copy to workspace wording for each audience; the project's Skills tab
// leaving out (and counting) the Assistant's skills. Checked against what launches select (skills:workspace, the
// API's status), and looked at in a narrow window. Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'skillaudience-profile')
const ws = path.join(lib.WORK, 'skillaudience-ws')
const proj = path.join(ws, 'demo')
const sleep = lib.sleep
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

const skill = (dir, name, audience) => {
  fs.mkdirSync(path.join(dir, name), { recursive: true })
  const meta = audience ? `metadata:\n  audience: ${audience}\n` : ''
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: The ${name} skill.\n${meta}---\n\nSteps.\n`)
}
// The Hive skills left out of the project tab: the bundled ones for the Assistant, and this suite's weekly-report.
const bundledDir = path.join(lib.ROOT, 'resources', 'skills')
const bundledForAssistant = fs.readdirSync(bundledDir).filter((n) => /^\s*audience:\s*assistant\s*$/m.test(fs.readFileSync(path.join(bundledDir, n, 'SKILL.md'), 'utf8')))
const assistantOnly = bundledForAssistant.length + 1

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(path.join(proj, '.claude', 'skills'), { recursive: true })
  // Local skills to copy to the workspace: one for the Assistant, one saying nothing.
  skill(path.join(proj, '.claude', 'skills'), 'local-assistant', 'assistant')
  skill(path.join(proj, '.claude', 'skills'), 'local-plain')
  // Local skills whose audience nobody can be given: misspelt, and written but empty.
  skill(path.join(proj, '.claude', 'skills'), 'local-misspelt', 'assitant')
  skill(path.join(proj, '.claude', 'skills'), 'local-empty', '~')

  lib.enableProviders(userData, ['claude-code'])
  const { app, page, inv } = await lib.launch({ userData, viewport: { width: 1300, height: 850 } })
  page.on('pageerror', (e) => console.log('FAIL page error', e.message))
  await lib.openWorkspace(inv, page, ws)
  const skillsDir = path.join(ws, '.hive', 'skills')
  skill(skillsDir, 'weekly-report', 'assistant')
  skill(skillsDir, 'both-ways', 'all')
  skill(skillsDir, 'plain')
  // A misspelt audience: nobody gets it, and the row says so.
  skill(skillsDir, 'misspelt', 'assitant')
  // A bundled skill for the Assistant, deleted: it's listed (for Restore) with its audience. Bundled skills are added
  // just after the workspace opens, so it's deleted once it's there.
  if (!(await lib.until(() => fs.existsSync(path.join(skillsDir, 'coordinate-agents', 'SKILL.md')), 20000))) throw new Error('The bundled coordinate-agents skill was never added')
  await inv('skills:delete', path.join(skillsDir, 'coordinate-agents'))
  await sleep(800)

  // What launches select, from the same metadata.
  const list = await inv('skills:workspace')
  const aud = Object.fromEntries(list.map((s) => [s.name, s.audience]))
  check('audiences as launches read them', aud['weekly-report'] === 'assistant' && aud['both-ways'] === 'all' && aud.plain === 'agents' && aud['coordinate-agents'] === 'assistant' && aud['work-on-card'] === 'agents', JSON.stringify(aud))

  await page.keyboard.press('Control+Shift+K')
  await lib.until(async () => (await page.locator('.skill-row').count()) > 0, 10000)
  const rowBadge = async (name) => {
    const b = page.locator('.skill-row', { hasText: name }).first().locator('.badge[data-audience]')
    return (await b.count()) ? (await b.innerText()).trim() : null
  }
  check('row: Assistant', (await rowBadge('weekly-report')) === 'Assistant', String(await rowBadge('weekly-report')))
  check('row: Agents + Assistant', (await rowBadge('both-ways')) === 'Agents + Assistant', String(await rowBadge('both-ways')))
  check('row: no badge for the default', (await rowBadge('plain')) === null && (await rowBadge('work-on-card')) === null)
  check("row: a misspelt audience is 'Not given'", (await rowBadge('misspelt')) === 'Not given', String(await rowBadge('misspelt')))
  const misspelt = (await inv('skills:workspace')).find((s) => s.name === 'misspelt')
  check('…and nobody gets it, with the reason', !misspelt.audience && /its audience is "assitant", not agents, assistant or all/.test(misspelt.problem ?? ''), JSON.stringify(misspelt))
  check('row: a deleted bundled skill still shows whose it is', (await rowBadge('coordinate-agents')) === 'Assistant' && (await page.locator('.skill-row.missing', { hasText: 'coordinate-agents' }).count()) === 1)
  const footer = await page.locator('.sidebar .hint', { hasText: 'Assistant' }).innerText().catch(() => '')
  check('footer: not "every agent", names the Assistant', /project agents/.test(footer) && /Assistant/.test(footer) && !/Every agent/.test(footer), footer)
  const empty = await page.locator('.empty-state').innerText().catch(() => '')
  check('empty page: says the Assistant skills are the exception', /except those marked for the Hive Assistant/.test(empty), empty)

  // A skill's page: its audience as a badge, with what it means.
  const pageBadge = async (name) => {
    await page.locator('.skill-row', { hasText: name }).first().click()
    await sleep(700)
    const b = page.locator('.editor-toolbar .badge[data-audience]')
    const text = (await b.innerText()).trim()
    await b.hover()
    await sleep(500)
    const tip = await page.locator('.tip').innerText().catch(() => '')
    await page.mouse.move(5, 5)
    await sleep(200)
    return { text, tip }
  }
  const plain = await pageBadge('plain')
  check('page: the default is Project agents, and says how to change it', plain.text === 'Project agents' && /default/.test(plain.tip) && /audience/.test(plain.tip), JSON.stringify(plain))
  const weekly = await pageBadge('weekly-report')
  check("page: Assistant, project agents don't get it", weekly.text === 'Assistant' && /Project agents don't get it/.test(weekly.tip), JSON.stringify(weekly))
  const both = await pageBadge('both-ways')
  check('page: Agents + Assistant', both.text === 'Agents + Assistant' && /both/.test(both.tip), JSON.stringify(both))
  const deleted = await pageBadge('coordinate-agents')
  check('page: a deleted bundled skill shows who Restore gives it back to', deleted.text === 'Assistant', JSON.stringify(deleted))
  await page.screenshot({ path: path.join(lib.WORK, 'skillaudience-view.png') })

  // Deleting says who stops getting it, and how running sessions of each provider are affected.
  const deleteDetail = async (name) => {
    const row = page.locator('.skill-row', { hasText: name }).first()
    await row.hover()
    await row.locator('button[aria-label="Delete skill"]').click()
    await sleep(500)
    const text = await page.locator('.dialog').innerText()
    await page.locator('.dialog .btn', { hasText: 'Cancel' }).click()
    await sleep(300)
    return text
  }
  const delWeekly = await deleteDetail('weekly-report')
  check('delete: an Assistant skill names the Assistant, not every agent', /new sessions of the Hive Assistant no longer get it/.test(delWeekly) && !/every agent/i.test(delWeekly), delWeekly)
  check("delete: running Claude Code keeps its copy; Codex's shared copy goes", /Claude Code session keeps its own copy until it restarts/.test(delWeekly) && /another Codex session in that folder starts/.test(delWeekly), delWeekly)
  const delPlain = await deleteDetail('plain')
  check('delete: a default skill names the project agents', /new sessions of the project agents no longer get it/.test(delPlain), delPlain)
  const delBoth = await deleteDetail('both-ways')
  check('delete: a skill for both names both', /the project agents and the Hive Assistant no longer get it/.test(delBoth), delBoth)
  const delMisspelt = await deleteDetail('misspelt')
  check('delete: a Not given skill says nobody gets it, not that agents lose it', /Nobody gets it now \(its audience is "assitant", not agents, assistant or all\), so no session loses it/.test(delMisspelt) && !/project agents no longer get it/.test(delMisspelt), delMisspelt)

  // The project's Skills tab: what its agents get. The Assistant's skills are left out, and counted.
  await inv('skills:restoreBundled', 'coordinate-agents')
  await sleep(800)
  await page.keyboard.press('Control+Shift+E')
  await sleep(500)
  await page.getByText('demo', { exact: true }).first().click()
  await sleep(600)
  await lib.openMoreTab(page, 'Skills')
  await lib.until(async () => (await page.locator('.split-list .skill-row').count()) > 0, 10000)
  const tabRows = await page.locator('.split-list .skill-row').allInnerTexts()
  const has = (n) => tabRows.some((t) => t.includes(n))
  check("project tab: the Assistant's skills aren't listed", !has('weekly-report') && !has('coordinate-agents'), tabRows.join(' | '))
  check('project tab: the default and both are', has('plain') && has('both-ways') && has('work-on-card'))
  const note = await page.locator('.assistant-only-note').innerText().catch(() => '')
  check('project tab: says how many are left out, and why', note.startsWith(`${assistantOnly} Hive skills are for the Hive Assistant only`) && /don't get them/.test(note), note)
  const agentsGet = (await inv('skills:list', proj)).filter((s) => s.level === 'hive' && s.audience !== 'assistant').length
  check('project tab: its Hive rows are what project agents are given', tabRows.filter((t) => !/Local|User|Plugin/.test(t)).length >= agentsGet)

  // Copy to workspace: says who gets it now, from its own metadata. The provider's local skills start folded (#118).
  const providerToggle = page.locator('.skill-provider-toggle')
  if ((await providerToggle.getAttribute('aria-expanded').catch(() => 'true')) === 'false') await providerToggle.click()
  const copyAndRead = async (name) => {
    await page.locator('.skill-row', { hasText: name }).first().click()
    await sleep(700)
    await page.locator('.editor-toolbar .btn', { hasText: 'Copy to workspace' }).hover()
    await sleep(500)
    const tip = await page.locator('.tip').innerText().catch(() => '')
    await page.locator('.editor-toolbar .btn', { hasText: 'Copy to workspace' }).click()
    await lib.until(async () => (await page.locator('.toast', { hasText: `Copied "${name}"` }).count()) > 0, 10000)
    const toast = await page.locator('.toast', { hasText: `Copied "${name}"` }).innerText().catch(() => '')
    return { tip, toast }
  }
  const ca = await copyAndRead('local-assistant')
  check('Copy to workspace tooltip: not "every agent"', /unless its SKILL.md's header sets another audience/.test(ca.tip) && !/every agent in every project gets it/.test(ca.tip), ca.tip)
  check('copied: an Assistant skill says the Assistant gets it', /The Hive Assistant now gets it as a Combwork skill/.test(ca.toast), ca.toast)
  const cp = await copyAndRead('local-plain')
  check('copied: a plain skill says the project agents get it', /The project agents now get it as a Combwork skill/.test(cp.toast), cp.toast)
  for (const [name, why] of [['local-misspelt', 'its audience is "assitant", not agents, assistant or all'], ['local-empty', 'its audience is empty, not agents, assistant or all']]) {
    const c = await copyAndRead(name)
    check(`copied: ${name} says nobody gets it yet, and why`, c.toast.includes('but nobody gets it yet') && c.toast.includes(why) && !/now gets? it as a Combwork skill/.test(c.toast) && /Claude Code agents here also still load the local copy/.test(c.toast), c.toast)
  }
  await page.screenshot({ path: path.join(lib.WORK, 'skillaudience-project.png') })

  // A narrow window: the badges stay inside their rows and the toolbar.
  await lib.fitWindow(app, page, { width: 760, height: 640 })
  await sleep(600)
  await page.keyboard.press('Control+Shift+K')
  await sleep(800)
  await page.locator('.skill-row', { hasText: 'both-ways' }).first().click()
  await sleep(800)
  const inside = await page.evaluate(() => {
    const out = []
    // Visible ones: a project's Skills tab stays mounted, hidden, behind the Skills view.
    for (const b of document.querySelectorAll('.skill-row .badge[data-audience]')) {
      const row = b.closest('.skill-row').getBoundingClientRect()
      const r = b.getBoundingClientRect()
      if (r.width > 0) out.push(r.right <= row.right + 1)
    }
    const tb = [...document.querySelectorAll('.editor-toolbar .badge[data-audience]')].find((b) => b.getBoundingClientRect().width > 0)
    out.push(!!tb && tb.getBoundingClientRect().right <= tb.closest('.editor-toolbar').getBoundingClientRect().right + 1)
    return out
  })
  check('narrow window: badges fit in their rows and toolbar', inside.length >= 3 && inside.every(Boolean), JSON.stringify(inside))
  check('narrow window: no horizontal page scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  await page.screenshot({ path: path.join(lib.WORK, 'skillaudience-narrow.png') })
  await page.keyboard.press('Control+Shift+E')
  await sleep(500)
  await lib.openMoreTab(page, 'Skills')
  await lib.until(async () => (await page.locator('.split-list .skill-row').count()) > 0, 10000)
  await page.screenshot({ path: path.join(lib.WORK, 'skillaudience-narrow-project.png') })

  await app.close()
  console.log(failed ? `${failed} failed` : 'all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
