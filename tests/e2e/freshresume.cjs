// Resume on a conversation that can't continue (HI-2540): one Combwork launched before the tools agents use were
// renamed (HI-2463: its record has an agent and a folder, no `names`). The window knows before Resume is pressed: the
// agent's resume target and the session list carry its reason, the Sessions tab's Resume says it starts a new
// conversation, and pressing it asks "Start a new conversation?", never the re-cache question. Cancel starts nothing;
// Start New Conversation starts a new conversation for the agent, and the old one stays in Sessions. A current
// conversation whose prompt cache expired still gets the re-cache question. Throwaway profile and workspace, the fake
// Claude Code (fake-claude/); no prompt is typed. The fixture's records are put into the workspace's database once
// Combwork has read the project, with Combwork's backups of their transcripts.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { putSessions } = require('./storeDocs.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const scratch = lib.WORK
const userData = path.join(scratch, 'freshresume-profile')
const ws = path.join(scratch, 'freshresume-ws')
const proj = path.join(ws, 'demo')
for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
lib.gitProject(proj)

const OLD = '25400000-0000-4000-8000-000000000001' // before the rename: an agent and a folder, no names
const CUR = '25400000-0000-4000-8000-000000000002' // since: names 2, its cache long expired
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const shot = (page, n) => page.screenshot({ path: path.join(scratch, `freshresume-${n}.png`) })

/** Combwork's backup of a transcript: one exchange whose context is 60K tokens, at `at` (long ago: its cache expired). */
function backup(id, at) {
  const file = path.join(proj, '.combwork', 'sessions', `${id}.jsonl`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lines = [
    { type: 'user', sessionId: id, timestamp: at, message: { role: 'user', content: 'Earlier work' } },
    { type: 'assistant', sessionId: id, requestId: `${id}-1`, timestamp: at, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 5, cache_read_input_tokens: 60000, cache_creation_input_tokens: 100, output_tokens: 50 } } }
  ]
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

;(async () => {
  const claude = lib.fakeClaude(userData, path.join(scratch, 'freshresume-claude-home'), [proj])
  const { app, page, inv } = await lib.launch({ userData, env: claude, viewport: { width: 1400, height: 850 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('demo', { exact: true }).first().click()
  const worker = await lib.addAgent(inv, proj, { name: 'Worker' })
  const rec = (id, name, at, extra) => ({ id, agent: 'claude-code', agentId: worker.id, cwd: proj, name, createdAt: at, lastActiveAt: at, archived: false, ...extra })
  // The agent's latest is the one from before the rename: its own Resume resumes that.
  putSessions(proj, { version: 1, sessions: [rec(CUR, 'Current work', '2026-09-20T10:00:00.000Z', { names: 2 }), rec(OLD, 'Before the rename', '2026-09-25T10:00:00.000Z', {})] })
  backup(CUR, '2026-09-20T10:00:00.000Z')
  backup(OLD, '2026-09-25T10:00:00.000Z')

  const agentInfo = async () => (await inv('workspace:refresh')).projects.find((p) => p.name === 'demo')?.agents.find((a) => a.id === worker.id)
  const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === proj.toLowerCase() && s.agentId === worker.id)

  // 1. The window knows beforehand, by the rule the start reads.
  const resume = await lib.until(async () => ((await agentInfo())?.resume?.id === OLD ? (await agentInfo()).resume : null), HUNG_MS)
  check("the agent's resume target is the old conversation, marked to start fresh (renamed)", resume?.fresh === 'renamed', JSON.stringify(resume))
  const list = await inv('session:list', proj)
  check('the session list marks it too, and not the current one', list.find((s) => s.id === OLD)?.fresh === 'renamed' && !list.find((s) => s.id === CUR)?.fresh, JSON.stringify(list.map((s) => [s.id.slice(-1), s.fresh ?? null])))
  // Its usage once the usage history has read its transcript (#1106: listed without figures until then).
  const recache = await lib.until(async () => (await inv('session:list', proj)).find((s) => s.id === CUR)?.recache ?? null, HUNG_MS)
  check('the current one would re-cache (its cache expired)', !!recache && !recache.warm && recache.tokens > 20000, JSON.stringify(recache))

  // 2. The Sessions tab: its Resume says so before it is pressed.
  await page.locator('.tabs .tab', { hasText: 'Sessions' }).first().click()
  const row = (name) => page.locator('.session-row', { hasText: name })
  check('the Sessions tab lists both', !!(await lib.until(async () => (await row('Before the rename').count()) === 1 && (await row('Current work').count()) === 1, HUNG_MS)))
  await row('Before the rename').click()
  const resumeBtn = page.locator('.transcript-toolbar button.act-resume').first()
  check('its Resume shows', !!(await lib.until(async () => (await resumeBtn.count()) === 1 && (await row('Before the rename').evaluate((el) => el.classList.contains('selected'))), HUNG_MS)))
  await resumeBtn.hover()
  const tip = page.locator('body > .tip')
  const tipText = await lib.until(async () => {
    const t = await tip.innerText().catch(() => '')
    return /Starts a new conversation/.test(t) ? t : null
  }, HUNG_MS)
  check('its tooltip says it starts a new conversation, and why', /Starts a new conversation: "Before the rename" is from before Combwork renamed the tools agents use/.test(tipText ?? ''), tipText ?? (await tip.innerText().catch(() => '')))
  await shot(page, '1-tooltip')
  await page.mouse.move(0, 0)

  // 3. Resume asks the fresh-start question, never the re-cache one; Cancel starts nothing.
  const dialog = page.locator('.dialog')
  await resumeBtn.click()
  check('Resume asks "Start a new conversation?"', !!(await lib.until(async () => /Start a new conversation\?/.test(await dialog.innerText().catch(() => '')), HUNG_MS)), await dialog.innerText().catch(() => ''))
  const asked = await dialog.innerText()
  check('…saying why, and what it carries on', /renamed the tools agents use/.test(asked) && /Worker starts a new conversation instead/.test(asked) && /stays in Sessions/.test(asked), asked)
  check('…not the re-cache question', !/re-cache|prompt cache/i.test(asked), asked)
  await shot(page, '2-question')
  await dialog.locator('.dialog-footer button', { hasText: /^Cancel$/ }).click()
  check('Cancel closes it', !!(await lib.until(async () => (await dialog.count()) === 0, HUNG_MS)))
  // Its Resume stops showing busy once the start it began is over: the store clears that with the agents' states, at the
  // end of their batch if some came lately (setWithLive, HI-1862), so waited for, never read at the dialog's close (HI-2819).
  const busy = () => page.evaluate(() => document.querySelector('.transcript-toolbar button.act-resume')?.getAttribute('aria-busy') ?? null)
  const settled = await lib.until(async () => !(await busy()), HUNG_MS)
  check('…and starts nothing', !!settled && !(await live()), JSON.stringify({ busy: await busy(), live: (await live())?.status ?? null }))

  // 4. Start New Conversation: a new conversation for the agent; the old one stays.
  await resumeBtn.click()
  await lib.until(async () => (await dialog.count()) === 1, HUNG_MS)
  await dialog.locator('.dialog-footer button', { hasText: /^Start New Conversation$/ }).click()
  const started = await lib.until(async () => {
    const l = await live()
    return l?.sessionId ? l : null
  }, HUNG_MS)
  check('Start New Conversation starts the agent', !!started, JSON.stringify(started))
  check('…in a new conversation, not the old one', !!started && started.sessionId !== OLD, started?.sessionId)
  const after = await inv('session:list', proj)
  check('the old conversation stays in Sessions', after.some((s) => s.id === OLD && !s.archived))
  await inv('session:stop', proj, worker.id)
  check('stopped again', !!(await lib.until(async () => !(await live()), HUNG_MS)))

  // 5. A current conversation whose cache expired still gets the re-cache question.
  await page.locator('.tabs .tab', { hasText: 'Sessions' }).first().click()
  await row('Current work').click()
  await lib.until(async () => await row('Current work').evaluate((el) => el.classList.contains('selected')).catch(() => false), HUNG_MS)
  await resumeBtn.click()
  check('a current, expired conversation asks about re-caching', !!(await lib.until(async () => /re-cache about/.test(await dialog.innerText().catch(() => '')), HUNG_MS)), await dialog.innerText().catch(() => ''))
  check('…not the fresh-start question', !/Start a new conversation\?/.test(await dialog.innerText().catch(() => '')))
  await shot(page, '3-recache')
  await page.keyboard.press('Escape')
  check('closed, nothing started', !!(await lib.until(async () => (await dialog.count()) === 0, HUNG_MS)) && !(await live()))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
