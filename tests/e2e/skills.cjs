// Skills: the bundled skills in a new workspace, and in an existing one only those it was never given (the ones it
// had before are its own to keep or delete), restore, revert and "update available", adding from
// a .md or a .zip, local skills per provider (and for both at once), the project's Skills tab, "Edit in
// workspace", the notice for a skill that no longer exists, and the warning over the Skills view and over a Hive skill
// being edited (not in preview, not in the project tab). Deleting moves folders to the Recycle Bin.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { zipSync, strToU8 } = require('fflate')

const userData = path.join(lib.WORK, 'skills-profile')
const ws = path.join(lib.WORK, 'skills-ws')
const oldWs = path.join(lib.WORK, 'skills-old-ws')
const proj = path.join(ws, 'demo')
const dump = path.join(lib.WORK, 'skills-dump')
const sleep = lib.sleep
// The longest a check waits for its condition: a bound for a hung run, never how long the step should take.
const HUNG_MS = 10000
/** Whether fn() comes true (checked until it does, up to HUNG_MS). */
const becomes = async (fn) => !!(await lib.until(fn, HUNG_MS))
/** The bundled skills from before Combwork kept track of them (an existing workspace without them deleted them), and the newer ones. */
const EARLIER = ['handover', 'merge-ready', 'pick-up', 'review-agent-work', 'split-work', 'workspace-note']
const NEWER = ['board-hygiene', 'card-loop', 'coordinate-agents', 'generalist', 'journal', 'licence-audit', 'run-lanes', 'triage-report', 'tune-settings', 'use-cw-api', 'work-on-card']
const BUNDLED = [...EARLIER, ...NEWER]
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  // The lists above are every skill Hive ships: a new one in resources/skills goes in NEWER.
  const shipped = fs.readdirSync(path.join(lib.ROOT, 'resources', 'skills')).filter((n) => fs.existsSync(path.join(lib.ROOT, 'resources', 'skills', n, 'SKILL.md'))).sort()
  check('the bundled skills are EARLIER and NEWER', JSON.stringify(shipped) === JSON.stringify([...BUNDLED].sort()), `resources/skills: ${shipped.join(',')}`)
  for (const d of [userData, ws, oldWs, dump]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(proj, { recursive: true })
  fs.mkdirSync(path.join(oldWs, '.hive'), { recursive: true })
  fs.mkdirSync(path.join(oldWs, 'p'), { recursive: true })
  // A folder of unrelated files with one skill .md among them, and a skill .zip with a script.
  fs.mkdirSync(dump, { recursive: true })
  fs.writeFileSync(path.join(dump, 'release-notes.md'), '# Write release notes\n\nCollect the changes since the last tag.\n')
  fs.writeFileSync(path.join(dump, 'unrelated.txt'), 'not part of any skill')
  fs.writeFileSync(path.join(dump, 'photo.png'), lib.samplePng())
  fs.writeFileSync(path.join(dump, 'deploy.zip'), zipSync({ 'deploy/SKILL.md': strToU8('---\nname: deploy\ndescription: Deploy the app.\n---\n\nRun scripts/deploy.ps1.\n'), 'deploy/scripts/deploy.ps1': strToU8('Write-Host deploy') }))
  // A Hive copy for Codex in the project's .agents/skills: never a local skill.
  const copy = path.join(proj, '.agents', 'skills', 'cw-handover')
  fs.mkdirSync(copy, { recursive: true })
  fs.writeFileSync(path.join(copy, 'SKILL.md'), '---\nname: handover\ndescription: copy\n---\n')
  fs.writeFileSync(path.join(copy, '.hive-copy'), '{"hash":"x"}')

  lib.enableProviders(userData, ['claude-code', 'codex'])
  const { app, page, inv } = await lib.launch({ userData, env: { CODEX_HOME: lib.CODEX_HOME }, viewport: { width: 1500, height: 950 } })
  page.on('pageerror', (e) => console.log('FAIL page error', e.message))

  // An existing workspace (it already has .hive) without the earlier bundled skills: the user deleted them, so they stay
  // deleted (listed for Restore); the newer ones are added.
  await lib.openWorkspace(inv, page, oldWs)
  // Brought up to date just after the open (HI-1705): the newer ones added, then what it did is checked.
  await becomes(async () => (await inv('skills:workspace')).filter((s) => NEWER.includes(s.name) && s.bundled === 'same').length === NEWER.length)
  let list = await inv('skills:workspace')
  check('existing workspace: skills it had are not brought back', !fs.existsSync(path.join(oldWs, '.hive', 'skills', 'handover')))
  check('existing workspace: they are listed as deleted', EARLIER.every((n) => list.find((s) => s.name === n)?.bundled === 'missing'), JSON.stringify(list.map((s) => [s.name, s.bundled])))
  check('existing workspace: the newer bundled skills are added', NEWER.every((n) => list.find((s) => s.name === n)?.bundled === 'same'), JSON.stringify(list.map((s) => [s.name, s.bundled])))

  // A new workspace starts with them.
  await lib.openWorkspace(inv, page, ws)
  const skillsDir = path.join(ws, '.hive', 'skills')
  // Copied in just after the open (HI-1705).
  await becomes(() => BUNDLED.every((n) => fs.existsSync(path.join(skillsDir, n, 'SKILL.md'))))
  check('new workspace: every bundled skill is copied', BUNDLED.every((n) => fs.existsSync(path.join(skillsDir, n, 'SKILL.md'))), fs.readdirSync(skillsDir).join(','))
  list = await inv('skills:workspace')
  check('new workspace: all match this version', BUNDLED.every((n) => list.find((s) => s.name === n)?.bundled === 'same'))

  // Skills view: Hive skills only.
  await page.keyboard.press('Control+Shift+K')
  check('Skills view lists them', await becomes(async () => (await page.locator('.skill-row').count()) === BUNDLED.length), String(await page.locator('.skill-row').count()))
  const viewWarning = await page.locator('.sidebar .skills-warning').allInnerTexts()
  check('Skills view: the warning over the list (#120)', viewWarning.length === 1 && viewWarning[0].trim() === 'Warning: Editing these skills may change agent behaviour in Combwork', JSON.stringify(viewWarning))
  await page.screenshot({ path: path.join(lib.WORK, 'skills-view.png') })

  // Edited → changed → Revert to default → same.
  const pickUp = path.join(skillsDir, 'pick-up', 'SKILL.md')
  fs.appendFileSync(pickUp, '\nMy own step.\n')
  check('an edited bundled skill is "changed"', await becomes(async () => (await inv('skills:workspace')).find((s) => s.name === 'pick-up')?.bundled === 'changed'))
  await page.locator('.skill-row', { hasText: 'pick-up' }).click()
  check('its page offers Revert to default', await becomes(async () => (await page.getByText('Revert to default').count()) === 1))
  check('a Combwork skill in preview: no warning over it', (await page.locator('.split .skills-warning').count()) === 0)
  await page.getByText('Revert to default').click()
  await sleep(400)
  await page.locator('.dialog .btn.primary', { hasText: 'Revert' }).click()
  await lib.until(async () => (await inv('skills:workspace')).find((s) => s.name === 'pick-up')?.bundled === 'same', 10000)
  list = await inv('skills:workspace')
  check('reverted: "same" again, edit gone', list.find((s) => s.name === 'pick-up')?.bundled === 'same' && !fs.readFileSync(pickUp, 'utf8').includes('My own step'))

  // An edited copy made from an older version: Hive leaves it, and says an update is there to take.
  fs.appendFileSync(pickUp, '\nMy own step.\n')
  const manifestFile = path.join(ws, '.hive', 'bundled.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  // A version Hive shipped before this one (a made-up one wouldn't count: it could be a newer Hive's).
  manifest.skills['pick-up'].from = require('../../src/main/bundledHistory.json').skills['pick-up'][0]
  fs.writeFileSync(manifestFile, JSON.stringify(manifest))
  list = await inv('skills:workspace')
  check('an edited copy of an older version: "update available"', list.find((s) => s.name === 'pick-up')?.updateAvailable === true)
  // Away and back, so pick-up's page is shown afresh.
  await page.locator('.skill-row', { hasText: 'split-work' }).click()
  await lib.until(async () => (await page.locator('.skill-row.selected', { hasText: 'split-work' }).count()) === 1, HUNG_MS)
  await page.locator('.skill-row', { hasText: 'pick-up' }).click()
  check('its page says so, beside Revert to default', await becomes(async () => (await page.locator('.editor-toolbar .badge', { hasText: 'Update available' }).count()) === 1))
  await page.screenshot({ path: path.join(lib.WORK, 'skills-update.png') })
  await page.getByText('Revert to default').click()
  await sleep(400)
  await page.locator('.dialog .btn.primary', { hasText: 'Revert' }).click()
  await lib.until(async () => (await inv('skills:workspace')).find((s) => s.name === 'pick-up')?.bundled === 'same', 10000)
  list = await inv('skills:workspace')
  check('reverting takes the update', list.find((s) => s.name === 'pick-up')?.bundled === 'same' && !list.find((s) => s.name === 'pick-up')?.updateAvailable)

  // Deleted → greyed, "deleted" → Restore.
  await inv('skills:delete', path.join(skillsDir, 'split-work'))
  check('deleted bundled skill: folder gone', await becomes(() => !fs.existsSync(path.join(skillsDir, 'split-work'))))
  check('deleted bundled skill: listed greyed as deleted', await becomes(async () => (await page.locator('.skill-row.missing', { hasText: 'split-work' }).count()) === 1))
  await page.locator('.skill-row.missing', { hasText: 'split-work' }).click()
  await sleep(800)
  await page.screenshot({ path: path.join(lib.WORK, 'skills-missing.png') })
  await page.locator('.editor-toolbar .btn', { hasText: 'Restore' }).click()
  await lib.until(async () => fs.existsSync(path.join(skillsDir, 'split-work', 'SKILL.md')) && (await page.locator('.skill-row.missing').count()) === 0, 10000)
  check('restored', fs.existsSync(path.join(skillsDir, 'split-work', 'SKILL.md')) && (await page.locator('.skill-row.missing').count()) === 0)

  // HI-2011: a skill as a contents page. card-loop's page shows its files as tabs, a link in SKILL.md opens its file's
  // tab, a reference file is edited and saved like SKILL.md (asking before it overwrites a change on disk), and
  // Revert to default puts back the whole folder.
  await page.locator('.skill-row', { has: page.locator('.row-name', { hasText: /^card-loop\s*$/ }) }).click()
  const tabs = page.locator('.skill-files [role="tab"]')
  const tabNames = () => tabs.allInnerTexts().catch(() => [])
  const refFiles = fs.readdirSync(path.join(skillsDir, 'card-loop')).filter((f) => f !== 'SKILL.md').sort()
  check("card-loop's page: its files as tabs, SKILL.md first", await becomes(async () => JSON.stringify(await tabNames()) === JSON.stringify(['SKILL.md', ...refFiles])), JSON.stringify(await tabNames()))
  check('…SKILL.md shown', (await page.locator('.skill-files [role="tab"][aria-selected="true"]').innerText()) === 'SKILL.md')
  await page.locator('.skill-detail .markdown a[href="builder.md"]').first().click()
  check("a link to builder.md in SKILL.md's preview opens its tab", await becomes(async () => (await page.locator('.skill-files [role="tab"][aria-selected="true"]').innerText().catch(() => '')) === 'builder.md' && /Card loop: the builder/.test(await page.locator('.skill-detail .markdown').innerText().catch(() => ''))), await page.locator('.skill-detail .editor-toolbar').innerText().catch(() => ''))
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    await page.locator('.skill-detail').screenshot({ path: path.join(lib.WORK, `skills-files-${theme}.png`) })
  }
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  // Edited in the same editor, saved.
  const builderFile = path.join(skillsDir, 'card-loop', 'builder.md')
  await page.locator('.skill-detail .editor-toolbar button[aria-label="Edit"]').click()
  await lib.until(async () => (await page.locator('.skill-detail .monaco .view-lines').count()) === 1, HUNG_MS)
  await page.locator('.skill-detail .monaco').first().click({ position: { x: 300, y: 40 } })
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\nMy builder note.\n')
  await page.locator('.skill-detail .editor-toolbar .btn.primary', { hasText: 'Save' }).click()
  check('builder.md edited and saved from its tab', await becomes(() => fs.readFileSync(builderFile, 'utf8').includes('My builder note.')))
  check('…the skill is "changed"', await becomes(async () => (await inv('skills:workspace')).find((s) => s.name === 'card-loop')?.bundled === 'changed'))
  // Changed on disk meanwhile: saving asks before it overwrites, and No keeps the change on disk.
  // The page shows the skill afresh now it is "changed" (its editor too): back to builder.md's editor, typed into.
  await lib.until(async () => (await page.locator('.skill-detail .editor-toolbar button[aria-label="Edit"]').count()) === 1 || (await page.locator('.skill-detail .monaco .view-lines').count()) === 1, HUNG_MS)
  if ((await page.locator('.skill-detail .monaco .view-lines').count()) === 0) await page.locator('.skill-detail .editor-toolbar button[aria-label="Edit"]').click()
  await lib.until(async () => (await page.locator('.skill-detail .monaco .view-lines').count()) === 1, HUNG_MS)
  check('…still on its builder.md tab', (await page.locator('.skill-files [role="tab"][aria-selected="true"]').innerText()) === 'builder.md')
  await page.locator('.skill-detail .monaco').first().click({ position: { x: 300, y: 40 } })
  await page.keyboard.press('Control+End')
  await page.keyboard.type('Mine again.\n')
  await lib.until(async () => await page.locator('.skill-detail .editor-toolbar .btn.primary', { hasText: 'Save' }).isEnabled(), HUNG_MS)
  fs.appendFileSync(builderFile, '\nChanged on disk.\n')
  await page.locator('.skill-detail .editor-toolbar .btn.primary', { hasText: 'Save' }).click()
  check('saving over a change on disk asks first', await becomes(async () => (await page.locator('.dialog', { hasText: 'Overwrite the changes on disk?' }).count()) === 1))
  await page.locator('.dialog .btn', { hasText: 'Cancel' }).click()
  check('…cancelled, the change on disk stays', await becomes(async () => (await page.locator('.dialog').count()) === 0) && fs.readFileSync(builderFile, 'utf8').includes('Changed on disk.') && !fs.readFileSync(builderFile, 'utf8').includes('Mine again.'))
  // Revert to default: the whole folder as shipped, the note gone.
  await page.getByText('Revert to default').click()
  await lib.until(async () => (await page.locator('.dialog .btn.primary', { hasText: 'Revert' }).count()) === 1, HUNG_MS)
  await page.locator('.dialog .btn.primary', { hasText: 'Revert' }).click()
  check('Revert to default puts back the whole folder: builder.md as shipped', await becomes(async () => (await inv('skills:workspace')).find((s) => s.name === 'card-loop')?.bundled === 'same' && !fs.readFileSync(builderFile, 'utf8').includes('My builder note.')))

  // Adding from a .md (only that file) and a .zip (its folder, with the script).
  const fromMd = await inv('skills:addFromFile', path.join(dump, 'release-notes.md'), 'release-notes', [{ kind: 'hive' }])
  const mdDir = path.join(skillsDir, 'release-notes')
  check('from .md: only SKILL.md, nothing else from its folder', JSON.stringify(fs.readdirSync(mdDir)) === '["SKILL.md"]', fs.readdirSync(mdDir).join(','))
  check('from .md: frontmatter added, described by its heading', fromMd.description === 'Write release notes', fromMd.description)
  await inv('skills:addFromFile', path.join(dump, 'deploy.zip'), 'deploy', [{ kind: 'hive' }])
  check('from .zip: unpacked with its script', fs.existsSync(path.join(skillsDir, 'deploy', 'SKILL.md')) && fs.existsSync(path.join(skillsDir, 'deploy', 'scripts', 'deploy.ps1')))
  let err = ''
  await inv('skills:addFromFile', path.join(dump, 'deploy.zip'), 'deploy', [{ kind: 'hive' }]).catch((e) => (err = String(e)))
  check('adding a name twice is refused', /already exists/.test(err), err)

  // The notice for a skill that no longer exists (deleted outside Hive while shown).
  await page.locator('.skill-row', { hasText: 'deploy' }).first().click()
  // Shown first, then deleted: the notice is for a skill that goes while it's on screen.
  await lib.until(async () => (await page.locator('.skill-row.selected', { hasText: 'deploy' }).count()) === 1, HUNG_MS)
  fs.rmSync(path.join(skillsDir, 'deploy'), { recursive: true, force: true })
  await lib.until(async () => (await page.getByText('no longer exists in this workspace').count()) === 1, 10000)
  check('a skill deleted meanwhile: "no longer exists"', (await page.getByText('no longer exists in this workspace').count()) === 1)

  // Project Skills tab (#118): Hive's skills open at the top, then one provider's skills, folded, picked from a dropdown
  // that starts on the project's default provider; the choice and what is open are remembered for the project; local
  // skills added for both at once.
  await page.keyboard.press('Control+Shift+E')
  await sleep(500)
  await page.getByText('demo', { exact: true }).first().click()
  await sleep(600)
  await lib.openMoreTab(page, 'Skills')
  const pick = page.locator('.skill-provider-pick select')
  await lib.until(async () => (await pick.count()) === 1, 10000)
  const pickOptions = await pick.locator('option').allInnerTexts()
  check('project tab: a dropdown of the providers, starting on the default one', pickOptions.length === 2 && pickOptions[0].startsWith('Claude Code') && pickOptions[1].startsWith('Codex') && (await pick.inputValue()) === 'claude-code', JSON.stringify({ pickOptions, value: await pick.inputValue() }))
  const hiveToggle = page.locator('.skill-group-toggle', { hasText: 'Combwork' }).first()
  const providerToggle = page.locator('.skill-provider-toggle')
  check('project tab: Combwork skills at the top, open', (await hiveToggle.getAttribute('aria-expanded')) === 'true' && (await page.locator('.split-list .skill-row', { hasText: 'workspace-note' }).count()) === 1)
  check('…then that provider’s skills only, folded', (await page.locator('.skill-provider').count()) === 1 && /claude code skills/i.test(await providerToggle.innerText()) && (await providerToggle.getAttribute('aria-expanded')) === 'false' && (await page.locator('.skill-provider .skill-group', { hasText: 'Local' }).count()) === 0)
  await page.screenshot({ path: path.join(lib.WORK, 'skills-project-folded.png') })
  await providerToggle.click()
  check('the provider’s skills open: Local, User', (await providerToggle.getAttribute('aria-expanded')) === 'true' && (await page.locator('.skill-provider .skill-group', { hasText: 'Local (User Managed)' }).count()) === 1 && (await page.locator('.skill-provider .skill-group', { hasText: /^\s*User\s*$/i }).count()) === 1, JSON.stringify(await page.locator('.skill-provider .skill-group').allInnerTexts()))
  await pick.selectOption('codex')
  await lib.until(async () => (await pick.inputValue()) === 'codex', HUNG_MS)
  check("project tab: Codex's skills, where Combwork's Codex copy isn't a local skill", (await page.locator('.skill-provider').count()) === 1 && (await page.locator('.skill-provider .skill-row', { hasText: 'handover' }).count()) === 0)
  await pick.selectOption('claude-code')
  await page.locator('.skill-provider').first().locator('.skill-group', { hasText: 'Local' }).locator('button[aria-label^="New local skill"]').click()
  await lib.until(async () => (await page.locator('.dialog input.input').count()) === 1, HUNG_MS)
  await page.locator('.dialog input.input').fill('lint-rules')
  await page.locator('.dialog input[type=checkbox]').check()
  await page.locator('.dialog .btn.primary', { hasText: 'Create' }).click()
  await lib.until(async () => fs.existsSync(path.join(proj, '.claude', 'skills', 'lint-rules', 'SKILL.md')) && fs.existsSync(path.join(proj, '.agents', 'skills', 'lint-rules', 'SKILL.md')), 10000)
  check('local skill added for Claude Code', fs.existsSync(path.join(proj, '.claude', 'skills', 'lint-rules', 'SKILL.md')))
  check('…and for Codex (tick box)', fs.existsSync(path.join(proj, '.agents', 'skills', 'lint-rules', 'SKILL.md')))
  const all = await inv('skills:list', proj)
  const locals = all.filter((s) => s.level === 'local').map((s) => `${s.provider}:${s.name}`).sort()
  check('both listed as local skills of their provider', JSON.stringify(locals) === '["claude-code:lint-rules","codex:lint-rules"]', JSON.stringify(locals))
  await page.screenshot({ path: path.join(lib.WORK, 'skills-project.png') })

  // The dropdown's choice and what is open are kept for the project: away from the tab and back, and in the saved
  // preferences (here: Codex, its skills open, Hive's folded).
  await pick.selectOption('codex')
  await hiveToggle.click()
  await page.keyboard.press('Alt+1')
  await sleep(300)
  await lib.openMoreTab(page, 'Skills')
  await lib.until(async () => (await pick.count()) === 1, 5000)
  const saved = await inv('ui:get')
  const savedPick = saved.skillsProvider ?? {}
  check('the provider shown is remembered for the project', (await pick.inputValue()) === 'codex' && savedPick[proj.toLowerCase()] === 'codex', JSON.stringify({ value: await pick.inputValue(), savedPick }))
  check('…and which groups are open', (await hiveToggle.getAttribute('aria-expanded')) === 'false' && (await providerToggle.getAttribute('aria-expanded')) === 'true' && JSON.stringify(saved.skillsFold?.[proj.toLowerCase()]) === JSON.stringify({ hive: false, provider: true }), JSON.stringify(saved.skillsFold))

  // A local skill is edited in place (not preview) and can be deleted there.
  const localRow = page.locator('.skill-provider').first().locator('.skill-row', { hasText: 'lint-rules' })
  await localRow.hover()
  await localRow.locator('button[aria-label="Delete skill"]').click()
  await page.locator('.dialog .btn.danger', { hasText: 'Delete' }).click()
  await lib.until(async () => !fs.existsSync(path.join(proj, '.agents', 'skills', 'lint-rules')), 10000)
  check('local skill deleted in the project tab', !fs.existsSync(path.join(proj, '.agents', 'skills', 'lint-rules')) && fs.existsSync(path.join(proj, '.claude', 'skills', 'lint-rules')))

  // "Edit in workspace" on a Hive skill opens it in the Skills view, in the editor. Hive's group unfolded first.
  await hiveToggle.click()
  check('the Combwork group unfolds', (await hiveToggle.getAttribute('aria-expanded')) === 'true' && !!(await lib.until(async () => (await page.locator('.split-list .skill-row', { hasText: 'workspace-note' }).count()) === 1, HUNG_MS)))
  const hiveRow = page.locator('.skill-row', { hasText: 'workspace-note' }).first()
  await hiveRow.click()
  await lib.until(async () => (await page.locator('.split .editor-toolbar', { hasText: 'workspace-note' }).count()) === 1, 5000)
  check('project tab: a Combwork skill (view only) has no warning', (await page.locator('.skills-warning').count()) === 0)
  await hiveRow.hover()
  await hiveRow.locator('button[aria-label^="Edit in the workspace"]').click()
  // The project tab's row for the same skill stays in the DOM, hidden and selected, and the Skills view draws its own row
  // once its list is read (#717). Counting both, the old check passed at once on the hidden row and then read once: 1
  // while the Skills view's list wasn't drawn yet, 2 (a failure) once it was, which under load it was by the read. Only a
  // visible row counts, waited for; what showed is logged when it took a while.
  const editAt = Date.now()
  const selectedRows = async () => [await page.locator('.skill-row.selected', { hasText: 'workspace-note' }).count(), await page.locator('.skill-row.selected:visible', { hasText: 'workspace-note' }).count()]
  const firstLook = await selectedRows()
  const inSkillsView = !!(await lib.until(async () => (await selectedRows())[1] === 1, HUNG_MS))
  if (Date.now() - editAt > 2000 || !inSkillsView) console.log(`  (Edit in workspace: the Skills view drew the skill selected ${Date.now() - editAt} ms after the click; selected rows at first [all, visible]: ${JSON.stringify(firstLook)}, now ${JSON.stringify(await selectedRows())})`)
  // The Skills view's page loads its list, then Monaco (lazily) and the file: wait for its editor, or a preview (which
  // would mean it failed). The project tab's page for the same skill stays in the DOM, hidden: only visible ones count.
  await lib.until(async () => (await page.locator('.split .monaco-editor:visible, .split .scroll-page:visible').count()) >= 1, 10000)
  check('Edit in workspace: Skills view with the skill selected', inSkillsView)
  check('Edit in workspace: opens in the editor, not the preview', (await page.locator('.split .monaco-editor').count()) >= 1)
  const editWarning = await page.evaluate(() => {
    const split = [...document.querySelectorAll('.split')].find((x) => x.offsetParent !== null)
    const w = split?.querySelector('.skills-warning')
    const host = split?.querySelector('.editor-host')
    const bar = split?.querySelector('.editor-toolbar')
    return w && host && bar ? { text: w.textContent.trim(), between: bar.getBoundingClientRect().bottom <= w.getBoundingClientRect().top + 0.5 && w.getBoundingClientRect().bottom <= host.getBoundingClientRect().top + 0.5 } : null
  })
  check('editing a Combwork skill: the same warning, above the editor (#120)', editWarning?.text === 'Warning: Editing these skills may change agent behaviour in Combwork' && editWarning.between, JSON.stringify(editWarning))
  await page.screenshot({ path: path.join(lib.WORK, 'skills-edit.png') })
  await inv('settings:update', { appearance: { theme: 'light' } })
  await sleep(300)
  await page.screenshot({ path: path.join(lib.WORK, 'skills-edit-light.png') })
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await page.locator('.split button[aria-label="Preview"]').click()
  await lib.until(async () => (await page.locator('.split .skills-warning').count()) === 0, HUNG_MS)
  check('…and gone in preview', (await page.locator('.split .skills-warning').count()) === 0)

  await app.close()
  console.log(failed ? `${failed} failed` : 'all passed')
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
