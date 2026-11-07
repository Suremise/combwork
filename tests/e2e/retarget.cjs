// HI-2680 (SPEC §16.5.4): retargeting when Work merges into moves on, in the app, on fake Claude Code agents acting by
// their own tokens. A project "Combwork merges" into `integration` (queueFixture.cjs), a card merged so its slot is free.
// - The window: Work merges into changed to 1.2.0 in the Workflow tab; Save…'s Retarget lists two Todo cards on
//   integration and the free slot; one card changed meanwhile; saved with Also retarget what can move ticked: the other
//   card and the slot move (the slot's folder at 1.2.0's head), the changed one stays, and the notification says both.
// - The Agent API: a project agent's and a script's retarget refused (403); the Assistant's at Look and advise refused, its
//   preview offered at Control agents; its apply bound to that preview: a card changed since and a slot whose folder moved
//   off the head seen stay (the slot set aside, never lent), an item the preview didn't list is said so, an unknown
//   preview is refused (409).
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47714))
const fx = q.queueProject('retarget')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const waitHung = (fn) => lib.until(fn, HUNG_MS, 200)
const git = (cwd, ...args) => lib.git(cwd, args).trim()

;(async () => {
  q.prepare(fx)
  // 1.2.0: the next release's branch, a commit ahead of integration.
  git(fx.alpha, 'branch', '1.2.0', 'integration')
  q.commitOn(fx, '1.2.0', { 'release.txt': '1.2.0\n' }, '1.2.0 starts')
  const h = await q.startCombwork(fx, { port: PORT, keepOptions: true })
  const { page, inv, app } = h
  await inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, { otherTargets: ['1.2.0'] }) })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1500, height: 950 })
    const text = async (loc) => ((await loc.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
    const slots = () => inv('slots:list', fx.alpha)
    /** A card's own Merges into, as its badge has it (none: the project's). */
    const ownTarget = async (n) => (await inv('tasks:workBadges')).find((b) => b.card === n)?.target ?? null
    const api = async (token, method, p, body) => {
      const res = await fetch(`http://127.0.0.1:${h.port}${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    /** Work merges into set to `target`, the other listed branch `other` (as the tab saves it). */
    const targets = (target, other) => inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, { target, otherTargets: [other] }) })
    /** Todo cards whose own Merges into is `branch` (set while it was the other listed branch). */
    const todoOn = async (branch, titles) => {
      const ns = []
      for (const title of titles) ns.push((await inv('tasks:create', { title, project: 'alpha' })).number)
      await targets(branch === 'integration' ? '1.2.0' : 'integration', branch)
      for (const n of ns) await inv('tasks:setTarget', n, branch)
      return ns
    }

    // --- A card merged into integration, its slot free afterwards (clean, at integration's head).
    const reviewer = await q.agent(fx, h, 'R1')
    const one = await q.approve(fx, h, reviewer, 'One', { 'one.txt': 'one\n' })
    check('One merged into integration', !!(await waitHung(async () => (await card(one.n))?.column === 'done')), JSON.stringify(await h.kinds(one.n)))
    const slot = await waitHung(async () => (await slots()).find((s) => s.state === 'ready' && !s.lease && !s.writer) ?? null)
    check('…its slot is free and ready', !!slot, JSON.stringify(await slots()))
    if (!slot) throw new Error('no free slot')

    // --- The window: two Todo cards on integration; Work merges into → 1.2.0 in the tab, Save….
    const [stays, moves] = await todoOn('integration', ['Changes meanwhile', 'Moves'])
    await targets('integration', '1.2.0')
    const keyOf = async (n) => (await card(n)).key
    const [stayKey, moveKey] = [await keyOf(stays), await keyOf(moves)]
    await page.locator('.sidebar').getByText('alpha', { exact: true }).first().click().catch(() => undefined)
    await waitHung(async () => {
      if ((await page.locator('.tabs .tab', { hasText: 'Version Control' }).count()) > 0) return true
      await page.getByRole('button', { name: 'Projects' }).click()
      await page.locator('.sidebar').getByText('alpha', { exact: true }).first().click().catch(() => undefined)
      return false
    })
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).first().click()
    await page.locator('.git-sections [data-section="workflow"]').click()
    const form = page.locator('.workflow-form')
    const targetInput = form.locator('.workflow-option[data-option="target"] input')
    await targetInput.waitFor({ timeout: HUNG_MS })
    await targetInput.fill('1.2.0')
    await targetInput.press('Enter')
    await form.locator('[data-action="save"]').click()
    const save = page.locator('.dialog', { has: page.locator('.workflow-save') })
    await save.waitFor({ timeout: HUNG_MS })
    const list = save.locator('[data-retarget]')
    const offered = await waitHung(async () => {
      const moving = await list.locator('[data-retarget-move]').evaluateAll((els) => els.map((e) => e.getAttribute('data-retarget-move')))
      return [stayKey, moveKey, slot.name].every((x) => moving.includes(x)) ? moving : null
    })
    check("Save…'s Retarget lists both Todo cards and the free slot as able to follow 1.2.0", !!offered, await text(list))
    const tick = list.locator('input[data-retarget-on]')
    check('…Also retarget what can move, ticked', (await tick.count()) === 1 && (await tick.isChecked()), await text(list))
    await save.screenshot({ path: path.join(fx.shots, 'retarget-save-preview.png') }).catch(() => undefined)
    // One card changed between the preview and the save: never overwritten.
    await inv('tasks:setTarget', stays, '1.2.0')
    check('…the changed card merges into 1.2.0 of its own, the other into integration still', (await ownTarget(stays)) === '1.2.0' && (await ownTarget(moves)) === 'integration', JSON.stringify(await inv('tasks:workBadges')))
    await save.getByRole('button', { name: 'Save', exact: true }).click()
    await save.waitFor({ state: 'detached', timeout: HUNG_MS })
    const toast = page.locator('.toast', { hasText: 'Moved to 1.2.0' })
    const said = await waitHung(async () => ((await toast.count()) ? text(toast.first()) : null))
    check('the notification says what moved (1 card, 1 slot) and what stayed, with why', !!said && /1 card and 1 slot/.test(said) && /1 left where they were/.test(said) && said.includes(`${stayKey}: it changed meanwhile`), said ?? '')
    await page.screenshot({ path: path.join(fx.shots, 'retarget-done-toast.png') }).catch(() => undefined)
    check('…the card that could move now follows 1.2.0 (no target of its own)', (await ownTarget(moves)) === null, JSON.stringify(await card(moves)))
    check('…the changed one is as it was changed', (await ownTarget(stays)) === '1.2.0', JSON.stringify(await inv('tasks:workBadges')))
    const head12 = git(fx.alpha, 'rev-parse', '1.2.0')
    check("…the slot's folder is at 1.2.0's head, clean, and ready", git(slot.folder, 'rev-parse', 'HEAD') === head12 && git(slot.folder, 'status', '--porcelain') === '' && (await slots()).find((s) => s.name === slot.name)?.state === 'ready', JSON.stringify(await slots()))

    // --- The Agent API: who may retarget.
    const apiToken = JSON.parse(fs.readFileSync(path.join(fx.userData, 'agent-api.json'), 'utf8')).token
    const byAgent = await api(reviewer.token, 'POST', '/v1/workflow/retarget', { project: 'alpha', from: 'integration', to: '1.2.0' })
    check("a project agent's retarget is refused (403)", byAgent.status === 403, JSON.stringify(byAgent.body))
    const byScript = await api(apiToken, 'POST', '/v1/workflow/retarget', { project: 'alpha', from: 'integration', to: '1.2.0' })
    check("a script's retarget is refused (403)", byScript.status === 403, JSON.stringify(byScript.body))

    // --- The Assistant: the slot (on 1.2.0 now) and two cards follow integration back, as offered.
    const [c3, c4] = await todoOn('1.2.0', ['Assistant: changes meanwhile', 'Assistant: moves'])
    await targets('integration', '1.2.0')
    const home = (await inv('workspace:refresh')).assistant.path
    await inv('session:start', home, { agentId: 'assistant' })
    await waitHung(async () => {
      const s = (await inv('session:live')).find((x) => x.projectPath.toLowerCase() === home.toLowerCase() && x.agentId === 'assistant')
      if (s?.status === 'waiting') await inv('pty:write', lib.ptyKey(home, 'assistant'), '\r')
      return s?.status === 'ready'
    })
    const tokenFile = path.join(fx.userData, 'assistant-api', `${createHash('sha256').update(fx.ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
    const assistant = (await waitHung(() => fs.existsSync(tokenFile))) ? JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token : null
    check('the Assistant has its token', !!assistant)
    const [k3, k4] = [await keyOf(c3), await keyOf(c4)]
    const preview = await api(assistant, 'POST', '/v1/workflow/retarget', { project: 'alpha', from: '1.2.0', to: 'integration' })
    check("the Assistant's preview: an id, both cards and the slot able to move, nothing moved", preview.status === 200 && (preview.body?.preview ?? '').startsWith('rt-') && [k3, k4, slot.name].every((x) => preview.body.move.includes(x)) && (await ownTarget(c3)) === '1.2.0', JSON.stringify(preview.body))
    await inv('settings:update', { assistant: { control: 'look' } })
    const looked = await api(assistant, 'POST', '/v1/workflow/retarget', { project: 'alpha', preview: preview.body?.preview, items: [k4] })
    check('at Look and advise its apply is refused (403), nothing moved', looked.status === 403 && (await ownTarget(c4)) === '1.2.0', JSON.stringify(looked.body))
    await inv('settings:update', { assistant: { control: 'agents' } })
    // Since the preview: c3 moved by hand, and the slot's folder moved to another commit (clean, one 1.2.0 has: a fresh
    // preview would list it again, at its new head).
    await inv('tasks:setTarget', c3, null)
    git(slot.folder, 'switch', '-q', '--detach', 'main')
    const gone = await api(assistant, 'POST', '/v1/workflow/retarget', { project: 'alpha', preview: 'rt-00000000', items: [k4] })
    check('an unknown preview is refused (409), saying to ask for a new one', gone.status === 409 && /new one/.test(gone.body?.error ?? ''), JSON.stringify(gone.body))
    const applied = await api(assistant, 'POST', '/v1/workflow/retarget', { project: 'alpha', preview: preview.body?.preview, items: [k3, k4, slot.name, 'AL-999'] })
    const skip = (x) => applied.body?.skipped?.find((s) => s.key === x || s.slot === x)?.why
    check('its apply moves only what is as offered: the other card', applied.status === 200 && applied.body?.moved?.cards?.map((c) => c.key).join() === k4 && (await ownTarget(c4)) === null, JSON.stringify(applied.body))
    check('…the changed card stays (changed), the moved slot is set aside, the unlisted item is said so', skip(k3) === 'changed' && skip(slot.name) === 'setAside' && skip('AL-999') === 'notOffered', JSON.stringify(applied.body?.skipped))
    check('…the slot is out of the pool (dirty), its folder untouched', (await slots()).find((s) => s.name === slot.name)?.state === 'dirty' && git(slot.folder, 'rev-parse', 'HEAD') === git(fx.alpha, 'rev-parse', 'main'), JSON.stringify(await slots()))
    const actions = await inv('assistant:actions')
    check('…listed in its actions', actions.some((x) => x.ok && x.kind === 'retarget' && x.project === 'alpha'), JSON.stringify(actions.map((x) => [x.kind, x.text])))
    await inv('session:stop', home, 'assistant')
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
