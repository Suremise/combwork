// Choose Connections… (HI-2109, HI-2105's design): Project Settings → Agents opens the template picker over the project's
// existing agents, each choice starting at "keep each one's"; a role's choice changes only its agents' connections (no
// agent replaced, the ids kept), the table saying Now and After; a running agent keeps its old connection until it
// restarts, offered once it's applied (Later leaves it). Screenshots of the dialog in both themes. The fake Claude Code on
// its CLI test home (the seam's account); a second connection made on it through Agent Settings' save (the adapter).
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'chooseconnections-profile')
const home = path.join(lib.WORK, 'chooseconnections-claude-home')
const ws = path.join(lib.WORK, 'chooseconnections-ws')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const project = () => JSON.parse(fs.readFileSync(path.join(alpha, '.hive', 'project.json'), 'utf8'))
const connectionOf = (id) => project().agents.find((a) => a.id === id)?.connection

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
  const env = lib.fakeClaude(userData, home, [alpha])
  lib.gitProject(alpha)
  fs.mkdirSync(path.join(alpha, '.hive'), { recursive: true })
  fs.writeFileSync(path.join(alpha, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a-b1', name: 'CC-B1', provider: 'claude-code', workflowRole: 'builder' }, { id: 'a-b2', name: 'CC-B2', provider: 'claude-code', workflowRole: 'builder' }, { id: 'a-r1', name: 'CC-R1', provider: 'claude-code', workflowRole: 'reviewer' }] }))

  const { app, page } = await lib.launch({ userData, env, viewport: { width: 1400, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const themed = async (theme) => {
      await inv('settings:update', { appearance: { theme } })
      if (!(await lib.until(() => page.evaluate((t) => document.documentElement.dataset.theme === t, theme), HUNG_MS))) throw new Error(`the window didn't show the ${theme} theme`)
    }

    // Every agent on the seam account's base connection; a High one made by Agent Settings' save for the reviewer, so two
    // connections are offered.
    const first = await lib.until(async () => {
      const p = await inv('templates:connectionsPlan', alpha)
      return p.agents.every((a) => a.connection) && p.options.length ? p : null
    }, HUNG_MS)
    check('the agents and the connections usable here are planned', !!first && first.agents.map((a) => a.role).join() === 'builder,builder,reviewer', JSON.stringify(first))
    const base = first.options[0].id
    await lib.setLaunch(inv, alpha, 'a-r1', { effort: 'high' })
    const plan = await inv('templates:connectionsPlan', alpha)
    const high = plan.options.find((o) => o.id !== base)?.id
    check('…a second connection, on the same account, now the reviewer’s', !!high && connectionOf('a-r1') === high && connectionOf('a-b1') === base, JSON.stringify(plan.options))

    await page.locator('.project-row', { hasText: 'alpha' }).first().click()
    await lib.openProjectSettings(page)
    await page.locator('.tab-body .settings-nav .row').filter({ has: page.locator('.label', { hasText: /^Agents$/ }) }).click()
    await page.locator('[data-action="choose-connections"]').click()
    const dialog = page.locator('.dialog', { hasText: 'Choose connections for alpha' })
    check('Choose Connections… opens its dialog from Project Settings → Agents', !!(await lib.until(async () => (await dialog.count()) === 1, HUNG_MS)))
    const rows = () => dialog.locator('[data-choose-connections] tbody tr').evaluateAll((l) => l.map((r) => [r.dataset.agent, r.hasAttribute('data-changes')]))
    check('…each agent with its connection now, nothing changing yet (every choice starts at keep)', JSON.stringify(await rows()) === JSON.stringify([['CC-B1', false], ['CC-B2', false], ['CC-R1', false]]), JSON.stringify(await rows()))
    // "High effort for every builder here".
    await dialog.locator('[data-connection-for="builder"] select').selectOption(high)
    check('…a role chosen: its agents change, the table says After', !!(await lib.until(async () => JSON.stringify(await rows()) === JSON.stringify([['CC-B1', true], ['CC-B2', true], ['CC-R1', false]]), HUNG_MS)), JSON.stringify(await rows()))
    // One builder's own over its role's: it keeps its own.
    await dialog.locator('[data-per-agent]').click()
    await dialog.locator('.template-connections-agents [data-connection-for="CC-B2"] select').selectOption(base)
    check('…an agent’s own choice over its role’s', !!(await lib.until(async () => JSON.stringify(await rows()) === JSON.stringify([['CC-B1', true], ['CC-B2', false], ['CC-R1', false]]), HUNG_MS)), JSON.stringify(await rows()))
    for (const theme of ['dark', 'light']) {
      await themed(theme)
      await page.screenshot({ path: path.join(lib.WORK, `chooseconnections-dialog-${theme}.png`) })
    }
    await themed('dark')
    await dialog.getByRole('button', { name: 'Apply' }).click()
    check('Apply changes only the builders chosen; the ids stay', !!(await lib.until(() => connectionOf('a-b1') === high, HUNG_MS)) && connectionOf('a-b2') === base && connectionOf('a-r1') === high && project().agents.map((a) => a.id).join() === 'a-b1,a-b2,a-r1', JSON.stringify(project().agents))

    // A running agent: changed, and offered a switch once its turn is over; Later leaves it.
    await inv('session:start', alpha, { agentId: 'a-b1' })
    check('CC-B1 runs', !!(await lib.until(async () => (await inv('session:live')).some((s) => s.agentId === 'a-b1' && s.status !== 'stopped'), HUNG_MS)))
    await page.locator('[data-action="choose-connections"]').click()
    await lib.until(async () => (await dialog.count()) === 1, HUNG_MS)
    await dialog.locator('[data-connection-for="builder"] select').selectOption(base)
    await dialog.getByRole('button', { name: 'Apply' }).click()
    const ask = page.locator('.dialog', { hasText: 'Switch the running agents?' })
    check('…a running agent changed is offered the switch, naming it', !!(await lib.until(async () => (await ask.count()) === 1, HUNG_MS)) && /CC-B1 runs on its old connection until it restarts/.test(await ask.innerText()), await ask.innerText().catch(() => ''))
    await ask.getByRole('button', { name: 'Later' }).click()
    check('…its connection is the one chosen, its run left as it is', connectionOf('a-b1') === base && (await inv('session:live')).some((s) => s.agentId === 'a-b1' && s.status !== 'stopped'))
    await inv('session:stop', alpha, 'a-b1')
  } catch (e) {
    check('no exception', false, e?.stack ?? String(e))
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
})()
