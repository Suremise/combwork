// GitHub host settings and Copilot's sign-in per host (HI-2779), on a fake Copilot (a one-line .cmd running a Node script
// that answers --version and the ACP model listing, and logs the host variables it was started with). No real Copilot,
// no token, no sign-in. A workspace set to tenant.ghe.com, with:
// - alpha: inheriting it (Copilot's stored login for tenant.ghe.com in the suite's COPILOT_HOME);
// - enterprise: repositories on a GitHub Enterprise Server (git.acme.example), no Copilot host chosen yet.
// Checks: the Version Control tab's GitHub group says where each value comes from and that a GHES host needs a choice;
// a host with a token in it is refused, nothing saved; choosing github.com for Copilot saves it; Provider Setup lists one
// row per host with its state and who uses it; the fake listing ran with GH_HOST and COPILOT_GH_HOST for tenant.ghe.com;
// Settings → Version Control → Workspace defaults shows the workspace's own. Screenshots light and dark.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

const HUNG_MS = 60000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

const work = path.join(lib.WORK, 'githubhosts')
const userData = path.join(work, 'profile')
const ws = path.join(work, 'githubhosts-ws')
// Screenshots at the suite folder's top, so --keep-files keeps them.
const shots = lib.WORK
const fakeDir = path.join(work, 'fake')
const copilotHome = path.join(work, 'copilot-home')
const fakeLog = path.join(work, 'fake-copilot.jsonl')

/** The fake Copilot: --version, and `--acp`'s initialize and session/new with two models (both enabled). */
function writeFakeCopilot() {
  fs.mkdirSync(fakeDir, { recursive: true })
  fs.writeFileSync(
    path.join(fakeDir, 'copilot.cjs'),
    `const fs = require('fs')
const env = Object.fromEntries(['GH_HOST', 'COPILOT_GH_HOST', 'COPILOT_HOME'].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]))
fs.appendFileSync(${JSON.stringify(fakeLog)}, JSON.stringify({ argv: process.argv.slice(2), env }) + '\\n')
if (process.argv.includes('--version')) { process.stdout.write('GitHub Copilot CLI 1.0.106.\\n'); process.exit(0) }
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i))
    buf = buf.slice(i + 1)
    const say = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...o }) + '\\n')
    if (m.method === 'initialize') say({ result: { protocolVersion: 1 } })
    else if (m.method === 'session/new') say({ result: { sessionId: 'not-a-uuid', models: { availableModels: [{ modelId: 'gpt-5', name: 'GPT-5', _meta: { copilotEnablement: 'enabled' } }, { modelId: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5', _meta: { copilotEnablement: 'disabled' } }], currentModelId: 'gpt-5' } } })
  }
})
`
  )
  fs.writeFileSync(path.join(fakeDir, 'copilot.cmd'), '@node "%~dp0copilot.cjs" %*\r\n')
  return path.join(fakeDir, 'copilot.cmd')
}

const logged = () => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

;(async () => {
  for (const d of [userData, ws, shots, copilotHome]) fs.mkdirSync(d, { recursive: true })
  const copilot = writeFakeCopilot()
  // Copilot's stored login for tenant.ghe.com only (config.json as 1.0.93 writes it): never a token.
  fs.writeFileSync(path.join(copilotHome, 'config.json'), `// User settings belong in settings.json.\n${JSON.stringify({ loggedInUsers: [{ host: 'https://tenant.ghe.com', login: 'mona' }], lastLoggedInUser: { host: 'https://tenant.ghe.com', login: 'mona' } })}\n`)
  const alpha = path.join(ws, 'alpha')
  const enterprise = path.join(ws, 'enterprise')
  lib.gitProject(alpha)
  lib.gitProject(enterprise)
  const { app, page, inv } = await lib.launch({ userData, env: { CW_API_PORT: lib.port(47867), COPILOT_HOME: copilotHome }, viewport: { width: 1400, height: 950 } })
  const shot = async (name, target) => {
    while ((await page.locator('.toast').count()) > 0) await page.locator('.toast').first().locator('button').last().click().catch(() => undefined)
    await page.mouse.move(5, 5)
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      if (target) await target.scrollIntoViewIfNeeded().catch(() => undefined)
      await page.screenshot({ path: path.join(shots, `githubhosts-${name}-${theme}.png`) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  }
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await inv('settings:update', { providers: { copilot: { enabled: true, executablePath: copilot } } })
    await lib.openWorkspace(inv, page, ws)
    // The workspace on tenant.ghe.com, and the enterprise project's repositories on a GHES host (no Copilot host yet).
    await inv('github:set', null, { host: 'https://Tenant.ghe.com/' })
    await inv('github:set', enterprise, { host: 'git.acme.example' })
    const saved = JSON.parse(fs.readFileSync(path.join(ws, '.combwork', 'workspace.json'), 'utf8')).github
    check('the workspace host is stored normalised, with its kind', JSON.stringify(saved) === JSON.stringify({ host: 'tenant.ghe.com', kind: 'ghe-cloud' }), JSON.stringify(saved))
    await inv('workspace:refresh').catch(() => undefined)

    // --- The enterprise project's Version Control tab → GitHub.
    await page.getByText('enterprise', { exact: true }).first().click()
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    await page.locator('.git-sections [data-section="workflow"]').click()
    const group = page.locator('.workflow-github[data-level="project"]')
    await group.waitFor({ timeout: HUNG_MS })
    const host = group.locator('[data-github-option="host"] .workflow-origin')
    const cop = group.locator('[data-github-option="copilot"] .workflow-origin')
    check('GitHub host: set for this project, a GitHub Enterprise Server', !!(await lib.until(async () => (await host.getAttribute('data-host')) === 'git.acme.example' && (await host.getAttribute('data-kind')) === 'ghes' && /Set for this project/.test(await host.innerText()), HUNG_MS)), await host.innerText().catch(() => ''))
    check('Copilot: a choice to make, saying Copilot agents don’t start', (await cop.getAttribute('data-problem')) === 'chooseCopilotHost' && /choose where Copilot signs in/.test(await cop.innerText()), await cop.innerText())
    const inheritOption = group.locator('[data-github-option="copilot"] select option[value="inherit"]')
    check('…and Inherit says what it gives here: none chosen (not the workspace’s cloud host)', /^Inherit \(none chosen\)$/.test((await inheritOption.innerText()).trim()), await inheritOption.innerText())
    await shot('project-choose', group)

    // A host with credentials typed in: refused (an error), nothing saved.
    const hostField = group.locator('[data-github-option="host"] input')
    await hostField.fill('https://me:ghp_example@git.acme.example')
    await hostField.press('Enter')
    const toast = page.locator('.toast', { hasText: 'Couldn’t save the GitHub host' })
    check('a host with a user name or token is refused', !!(await lib.until(async () => (await toast.count()) > 0, HUNG_MS)))
    const pj = () => JSON.parse(fs.readFileSync(path.join(enterprise, '.combwork', 'project.json'), 'utf8')).github
    check('…and nothing saved', pj()?.host === 'git.acme.example', JSON.stringify(pj()))

    // Copilot on github.com, chosen in the window.
    await group.locator('[data-github-option="copilot"] select').selectOption('github.com')
    check('choosing github.com for Copilot saves it in project.json', !!(await lib.until(async () => pj()?.copilotHost === 'github.com', HUNG_MS)), JSON.stringify(pj()))
    check('…and the group says Copilot signs in on github.com, set here', !!(await lib.until(async () => (await cop.getAttribute('data-host')) === 'github.com' && !(await cop.getAttribute('data-problem')), HUNG_MS)), await cop.innerText())
    await shot('project-chosen', group)

    // --- alpha inherits the workspace's.
    await page.getByText('alpha', { exact: true }).first().click()
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    await page.locator('.git-sections [data-section="workflow"]').click()
    const alphaHost = page.locator('.workflow-github[data-level="project"] [data-github-option="host"] .workflow-origin')
    check('alpha inherits tenant.ghe.com from the workspace', !!(await lib.until(async () => (await alphaHost.getAttribute('data-host')) === 'tenant.ghe.com' && (await alphaHost.getAttribute('data-origin')) === 'workspace', HUNG_MS)), await alphaHost.innerText().catch(() => ''))

    // --- Provider Setup → GitHub Copilot: a row per host.
    await inv('provider:refresh', 'copilot')
    await page.keyboard.press('Control+Shift+P')
    await page.keyboard.type('Provider Setup')
    await page.keyboard.press('Enter')
    const setup = page.locator('.dialog', { hasText: 'Provider Setup' })
    await setup.waitFor({ timeout: HUNG_MS })
    await setup.locator('.setup-tab', { hasText: 'GitHub Copilot' }).click()
    const rows = setup.locator('.setup-host')
    const row = (h) => setup.locator(`.setup-host[data-host="${h}"]`)
    check('Provider Setup lists a row per host in use', !!(await lib.until(async () => (await rows.count()) === 2, HUNG_MS)), String(await rows.count()))
    check('tenant.ghe.com: credentials set (the stored login), models available, not called verified', (await row('tenant.ghe.com').getAttribute('data-state')) === 'configured' && /models available; identity not checked/.test(await row('tenant.ghe.com').innerText()) && /mona/.test(await row('tenant.ghe.com').innerText()), await row('tenant.ghe.com').innerText().catch(() => ''))
    check('…with its models: one offered, one unavailable', /1 model offered, 1 unavailable/.test(await row('tenant.ghe.com').innerText()), await row('tenant.ghe.com').innerText().catch(() => ''))
    check('github.com (the enterprise project’s): not signed in, a login on another host not counted', (await row('github.com').getAttribute('data-state')) === 'installed' && /enterprise/.test(await row('github.com').innerText()), await row('github.com').innerText().catch(() => ''))
    check('…with the repositories’ host named', /Repositories on git\.acme\.example/.test(await row('github.com').innerText()))
    const signIn = setup.locator('button[data-host="github.com"]')
    check('Sign in is offered for github.com, never started by the check', (await signIn.count()) === 1)
    check('the token switch is named, by its title', /Keep GH_TOKEN and GITHUB_TOKEN from Copilot/.test(await setup.locator('.setup-hosts').innerText()))
    await shot('provider-setup', setup.locator('.setup-hosts'))
    const acp = logged().filter((l) => l.argv.includes('--acp'))
    const tenantRun = acp.find((l) => l.env.COPILOT_GH_HOST === 'tenant.ghe.com')
    check('the tenant listing ran with GH_HOST and COPILOT_GH_HOST = tenant.ghe.com', !!tenantRun && tenantRun.env.GH_HOST === 'tenant.ghe.com' && tenantRun.env.COPILOT_HOME === copilotHome, JSON.stringify(acp))
    check('no listing for the github.com host without a sign-in there', !acp.some((l) => l.env.COPILOT_GH_HOST === 'github.com'), JSON.stringify(acp))
    // Each folder's own host's catalogue, as the window gets it (HR2's round 1): the workspace's (tenant) has the fake's
    // models; the enterprise project's host (github.com, no sign-in there) has none, never the tenant's.
    const info = (await inv('provider:info')).copilot
    const routeOf = (p) => info.hostRouteOf?.[p.toLowerCase()]
    const tenantCatalog = info.hostCatalogs?.[routeOf(ws)]
    check('the workspace’s host has its own catalogue, with its context', !!tenantCatalog && tenantCatalog.models.map((m) => m.value).join() === 'gpt-5,claude-sonnet-5.5' && (tenantCatalog.context ?? '').startsWith('tenant.ghe.com|'), JSON.stringify({ route: routeOf(ws), tenantCatalog }))
    check('the enterprise project’s host (no sign-in there) has no catalogue, not the tenant’s', !!routeOf(enterprise) && routeOf(enterprise) !== routeOf(ws) && !info.hostCatalogs?.[routeOf(enterprise)], JSON.stringify(info.hostRouteOf))
    await setup.locator('button', { hasText: 'Close' }).last().click()

    // --- The rendered picker, opened for a project (HR2's round 2): Add Agent → New Connection… on Copilot's account, in
    // alpha (tenant.ghe.com: its listing, gpt-5 offered, claude-sonnet-5.5 listed apart as unavailable) and in enterprise
    // (Copilot on github.com, no sign-in there: no listing, so the fallback list, with no tenant model marked unavailable).
    const view = await inv('connections:list')
    const copilotAccount = [...view.connections, ...view.homes].find((a) => a.provider === 'copilot')
    // Combwork's own accounts are turned on per workspace; Copilot's is the PC's own home (decision C), on as it is.
    if (copilotAccount && view.connections.some((a) => a.id === copilotAccount.id)) await inv('connections:setOn', copilotAccount.id, true)
    const copilotRow = (await inv('connections:list')).connectionRows.find((r) => r.account === copilotAccount?.id)
    check('Copilot has an account and a connection to choose', !!copilotAccount && !!copilotRow, JSON.stringify({ account: copilotAccount?.id, row: copilotRow?.id }))
    const pickerFor = async (project) => {
      await page.getByText(project, { exact: true }).first().click()
      // The Add menu is the Session tab's.
      await page.locator('.tabs .tab', { hasText: 'Session' }).first().click()
      await lib.addMenuRun(page, 'Configure Agent and Add…')
      const add = page.locator('.dialog', { hasText: 'Add an agent' })
      const select = add.locator('#add-agent-connection')
      await lib.until(async () => (await select.count()) === 1, HUNG_MS)
      await select.selectOption(copilotRow.id)
      await add.locator('[data-new-connection]').click()
      const form = page.locator('[data-connection-form]')
      await form.waitFor({ timeout: HUNG_MS })
      const groups = await form.locator('.model-picker select').first().locator('optgroup').evaluateAll((gs) => gs.map((g) => ({ label: g.label, models: [...g.querySelectorAll('option')].map((o) => ({ value: o.value, disabled: o.disabled })) })))
      await shot(`picker-${project}`, form)
      await page.locator('.dialog').last().getByRole('button', { name: 'Cancel' }).click()
      await form.waitFor({ state: 'detached', timeout: HUNG_MS })
      await add.getByRole('button', { name: 'Cancel', exact: true }).click()
      await lib.until(async () => (await add.count()) === 0, HUNG_MS)
      return groups
    }
    if (copilotRow) {
      const tenantGroups = await pickerFor('alpha')
      const offered = tenantGroups.filter((g) => !/Not available/.test(g.label)).flatMap((g) => g.models.map((m) => m.value))
      const unavailable = tenantGroups.filter((g) => /Not available/.test(g.label)).flatMap((g) => g.models.map((m) => m.value))
      check('alpha’s New Connection… picker: tenant.ghe.com’s listing (gpt-5 offered, claude-sonnet-5.5 unavailable to the account)', JSON.stringify(offered) === JSON.stringify(['gpt-5']) && JSON.stringify(unavailable) === JSON.stringify(['claude-sonnet-5.5']), JSON.stringify(tenantGroups))
      const enterpriseGroups = await pickerFor('enterprise')
      check('enterprise’s picker: its own host has no listing, so the fallback list, never the tenant’s (nothing marked unavailable)', enterpriseGroups.length > 0 && !enterpriseGroups.some((g) => /Not available/.test(g.label)) && JSON.stringify(enterpriseGroups) !== JSON.stringify(tenantGroups), JSON.stringify(enterpriseGroups))
    }

    // --- Settings → Version Control → Workspace defaults → GitHub.
    await page.keyboard.press('Control+,')
    const nav = page.locator('.settings-nav .row', { hasText: 'Version Control' }).first()
    await nav.waitFor({ timeout: HUNG_MS })
    await nav.click()
    const settingsGroup = page.locator('.settings-group[data-section="workflow"]')
    await settingsGroup.locator('[role="tab"][data-setting-tab="workflow.workspaceDefaults"]').click()
    const wsGroup = page.locator('.workflow-github[data-level="workspace"]')
    const wsHost = wsGroup.locator('[data-github-option="host"] .workflow-origin')
    check('Workspace defaults shows the workspace’s own host, set here', !!(await lib.until(async () => (await wsHost.getAttribute('data-host')) === 'tenant.ghe.com' && /Set here/.test(await wsHost.innerText()), HUNG_MS)), await wsHost.innerText().catch(() => ''))
    await shot('workspace-defaults', wsGroup)
  } catch (e) {
    check('the suite ran to its end', false, e?.stack ?? String(e))
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(`Screenshots: ${shots}`)
  console.log(failed ? `${failed} FAILED` : 'ALL PASS')
  process.exit(failed ? 1 : 0)
})()
