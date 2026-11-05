// The developer console's flight recorder (#698): when something rare happens to an agent, its newest console events are
// saved as a capture (console-recordings/console-<stamp>-capture.jsonl), redacted, with a notice "Captured <trigger> on
// <agent>" and Show in Folder. Acted out with the fake Claude Code and the fake Codex:
// - every trigger off (the default): a safeguard stop saves nothing and says nothing;
// - safeguard on: a safeguard stop saves a capture of the turn's hooks before it and the trigger, with no prompt text,
//   and the notice; the same stop again at once saves no second one (one per trigger and agent every few minutes);
// - unknown on: an ordinary turn (every field of the fake's known) saves nothing; a hook with a field Combwork doesn't know
//   (the fake's "newfield") saves a capture naming it;
// - version on: the agent started again on another version of its CLI saves a capture saying old → new;
// - stalled on: the fake Codex silent in a turn past its limit (CW_TEST_SILENT_MS) saves a capture;
// - console:captures lists them newest first, and the developer console's Captures list shows them.
// The capture is written CW_TEST_FLIGHT_AFTER_MS after its trigger (ten seconds in the app). A capture saved after
// another trigger's is written after it: a later capture on disk shows an earlier one would be there too.
// Dev build, throwaway profile, workspace and CLI homes.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000
// How long a running turn may be silent before Combwork says its state is unknown (the stalled trigger).
const SILENT_MS = 2000

const userData = path.join(lib.WORK, 'flightrecorder-profile')
const ws = path.join(lib.WORK, 'flightrecorder-ws')
const claudeHome = path.join(lib.WORK, 'flightrecorder-claude-home')
const codexHome = path.join(lib.WORK, 'flightrecorder-codex-home')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
const recordings = path.join(userData, 'console-recordings')
// Words of a prompt, which a capture must never hold (redacted).
const PRIVATE = 'otter-saffron-quill'
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** The captures on disk, oldest first: each one's name, header, events and end line. */
function captures() {
  const names = fs.existsSync(recordings) ? fs.readdirSync(recordings).filter((n) => n.endsWith('-capture.jsonl')).sort() : []
  return names.map((name) => {
    const text = fs.readFileSync(path.join(recordings, name), 'utf8')
    const lines = text.split('\n').filter(Boolean).map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    return { name, text, header: lines[0], events: lines.filter((l) => l?.type === 'event'), end: lines[lines.length - 1] }
  })
}
const capturesOf = (trigger) => captures().filter((c) => c.header?.capture?.trigger === trigger)
/** The capture of a trigger once its end line is written. */
const captured = (trigger) => lib.until(() => capturesOf(trigger).find((c) => c.end?.type === 'end') ?? null, HUNG_MS)

;(async () => {
  for (const d of [userData, ws, claudeHome, codexHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(codexHome, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  lib.gitProject(alpha)
  lib.gitProject(beta)
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const claudeEnv = lib.fakeClaude(userData, claudeHome, [alpha, beta, ws])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47837), ...claudeEnv, CODEX_HOME: codexHome, CW_TEST_SILENT_MS: String(SILENT_MS), CW_TEST_FLIGHT_AFTER_MS: '500' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.waitForProvider(inv, 'codex')
    await lib.openWorkspace(inv, page, ws)
    // Every notice that reaches the window, kept: a toast goes from the screen after a while.
    await page.evaluate(() => {
      window.__toasts = []
      window.combwork.onEvent((e) => {
        if (e.type === 'toast') window.__toasts.push(e.toast)
      })
    })
    const toasts = () => page.evaluate(() => window.__toasts)
    const capturedToasts = async () => (await toasts()).filter((t) => t.title.startsWith('Captured '))
    const toastFor = (title) => lib.until(async () => (await toasts()).find((t) => t.title === title) ?? null, HUNG_MS)
    const setAdvanced = (id, value) => inv('advanced:set', id, value)
    const hiveLog = () => fs.readFileSync(path.join(userData, 'logs', 'combwork.log'), 'utf8')

    // Two agents in alpha (so Combwork names one "alpha · Claude"), one in beta ("beta").
    const claude = await lib.addAgent(inv, alpha, { name: 'Claude' })
    await lib.addAgent(inv, alpha, { name: 'Spare' })
    const codex = await lib.addAgent(inv, beta, { name: 'Codex', provider: 'codex', permissionMode: 'full-access' })
    const live = async (p, a) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === a.id)
    const startClaude = async () => {
      await inv('session:start', alpha, { agentId: claude.id })
      return lib.until(async () => (await live(alpha, claude))?.status === 'ready', HUNG_MS)
    }
    check('the Claude Code agent starts', !!(await startClaude()))
    const prompts = lib.fakePrompts(inv, lib.ptyKey(alpha, claude.id), () => live(alpha, claude), { home: claudeHome })
    const stops = async (n) => lib.until(async () => ((await live(alpha, claude))?.safeguard?.stops ?? 0) >= n, HUNG_MS)
    const label = 'alpha · Claude'

    // --- 1. Every trigger off: a safeguard stop saves nothing, and says nothing.
    check('off: the turn with a safeguard stop ends', !!(await prompts.say('safeguard first')))
    check('off: Combwork noted the safeguard stop', !!(await stops(1)))
    check('off: no capture is saved', captures().length === 0, JSON.stringify(captures().map((c) => c.name)))
    check('off: no "Captured" notice', (await capturedToasts()).length === 0, JSON.stringify(await capturedToasts()))
    check('off: the recorder noted nothing', !/flight recorder: /.test(hiveLog()))

    // --- 2. Safeguard on: a capture of the turn, redacted, and its notice.
    await setAdvanced('cw.recorder.safeguard', true)
    check('safeguard on: the turn ends', !!(await prompts.say(`safeguard ${PRIVATE}`)))
    const guard = await captured('safeguard')
    check('safeguard on: a capture is saved, its trigger safeguard', !!guard, JSON.stringify(captures().map((c) => c.name)))
    if (guard) {
      const h = guard.header
      check('…a recording of the agent, without text, its trigger and what it saw in its header', h.type === 'recording' && h.text === false && h.source?.label === label && /safeguards stopped a response/.test(h.capture?.what ?? ''), JSON.stringify(h))
      check('…ending as captured', guard.end?.type === 'end' && guard.end.reason === 'captured' && guard.end.events === guard.events.length, JSON.stringify(guard.end))
      const names = guard.events.map((e) => `${e.kind}:${e.name}`)
      const trig = names.indexOf('trigger:safeguard')
      check("…with the turn's hooks before the trigger, and the trigger", trig > 0 && names.slice(0, trig).includes('hook:UserPromptSubmit'), JSON.stringify(names))
      check('…and none of the prompt (redacted)', !guard.text.includes(PRIVATE) && !guard.text.includes('otter'))
      check('…named console-<stamp>-capture.jsonl', /^console-[\d-]+-capture\.jsonl$/.test(guard.name), guard.name)
    }
    const guardToast = await toastFor(`Captured a safeguard stop on ${label}`)
    check('safeguard on: the notice says so, with Show in Folder', !!guardToast && guardToast.actions?.[0]?.label === 'Show in Folder' && guardToast.actions[0].command === 'console.showCapture' && guardToast.actions[0].args?.[0] === guard?.name, JSON.stringify(guardToast))
    check('…shown in the window', !!(await lib.until(async () => (await page.locator('.toast', { hasText: `Captured a safeguard stop on ${label}` }).count()) > 0, HUNG_MS)))
    check('only the stop after it was turned on is captured', capturesOf('safeguard').length === 1, JSON.stringify(captures().map((c) => c.name)))

    // --- 6. The same trigger again at once on the same agent: no second capture.
    check('again: the turn with a safeguard stop ends', !!(await prompts.say('safeguard again')))
    check('again: Combwork noted the stop', !!(await stops(3)))

    // --- 3. Unknown on: an ordinary turn saves nothing; a field Combwork doesn't know saves a capture naming it.
    await setAdvanced('cw.recorder.unknown', true)
    check('unknown on: an ordinary turn ends', !!(await prompts.say('work 1')))
    check('unknown on: a turn whose hook has a new field ends', !!(await prompts.say('newfield')))
    const unknown = await captured('unknown')
    check('unknown on: a capture is saved, naming the field', !!unknown && unknown.header.capture.what === "hook UserPromptSubmit with fields Combwork doesn't know: hive_test_new_field", JSON.stringify(unknown?.header?.capture ?? captures().map((c) => c.header?.capture)))
    // Written after any capture the ordinary turn or the repeated stop would have made.
    check("…and the ordinary turn's hooks made none (every field of the fake's is known)", capturesOf('unknown').length === 1, JSON.stringify(capturesOf('unknown').map((c) => c.header.capture.what)))
    check('the safeguard stop again at once made no second capture', capturesOf('safeguard').length === 1, JSON.stringify(captures().map((c) => c.name)))
    check('unknown on: its notice', !!(await toastFor(`Captured something unknown from its CLI on ${label}`)))
    await setAdvanced('cw.recorder.unknown', false)

    // --- 4. Version on: the agent started again on another version of Claude Code.
    await setAdvanced('cw.recorder.version', true)
    const was = (await inv('provider:info'))['claude-code'].version
    await inv('session:stop', alpha, claude.id)
    check('the agent stops', !!(await lib.until(async () => !(await live(alpha, claude)), HUNG_MS)))
    fs.writeFileSync(path.join(claudeHome, 'fake-version.txt'), '2.2.0')
    await inv('provider:refresh', 'claude-code')
    check('Combwork sees the new version of Claude Code', !!(await lib.until(async () => (await inv('provider:info'))['claude-code'].version === '2.2.0', HUNG_MS)), JSON.stringify((await inv('provider:info'))['claude-code'].version))
    check('the agent starts on it', !!(await startClaude()))
    const version = await captured('version')
    check('version on: a capture is saved, saying old → new', !!version && version.header.capture.what === `claude-code ${was} → 2.2.0`, JSON.stringify(version?.header?.capture))
    check('version on: its notice', !!(await toastFor(`Captured a CLI version change on ${label}`)))
    check('the versions are kept in the profile', JSON.parse(fs.readFileSync(path.join(userData, 'flight-recorder.json'), 'utf8')).versions?.['claude-code'] === '2.2.0')

    // --- 5. Stalled on: the fake Codex silent in a turn past its limit.
    await setAdvanced('cw.recorder.stalled', true)
    await inv('session:start', beta, { agentId: codex.id })
    check('the Codex agent starts', !!(await lib.until(async () => (await live(beta, codex))?.status === 'ready', HUNG_MS)))
    const silent = await lib.sendPrompt(inv, lib.ptyKey(beta, codex.id), 'silent', { submitted: async () => (await live(beta, codex))?.status === 'working' })
    check('a silent turn is under way', silent > 0)
    check("its state turns unknown after the silence", !!(await lib.until(async () => (await live(beta, codex))?.turn?.state === 'unknown', HUNG_MS)))
    const stalled = await captured('stalled')
    check('stalled on: a capture is saved', !!stalled && stalled.header.source?.label === 'beta' && /^silent in a turn for \d+ s/.test(stalled.header.capture.what), JSON.stringify(stalled?.header))
    check('…with the trigger in its events', !!stalled && stalled.events.some((e) => e.kind === 'trigger' && e.name === 'stalled'))
    check('stalled on: its notice', !!(await toastFor('Captured a silence past its limit on beta')))

    // --- console:captures: newest first.
    const listed = await inv('console:captures')
    const triggers = listed.map((c) => c.capture?.trigger)
    check('console:captures lists them newest first', JSON.stringify(triggers) === JSON.stringify(['stalled', 'version', 'unknown', 'safeguard']) && listed.every((c, i) => i === 0 || c.startedAt <= listed[i - 1].startedAt), JSON.stringify(listed.map((c) => [c.capture, c.startedAt])))

    // --- 7. The developer console's Captures list.
    await inv('settings:update', { advanced: { showDeveloperFeatures: true } })
    await lib.until(async () => (await inv('settings:get')).advanced?.showDeveloperFeatures === true, HUNG_MS)
    await inv('console:open')
    const dc = await lib.until(() => app.windows().find((w) => w.url().endsWith('#console')) ?? null, HUNG_MS)
    check('the developer console opens', !!dc)
    if (dc) {
      dc.on('pageerror', (e) => check('no console page errors', false, e.message))
      await dc.locator('.dc-captures').click({ timeout: HUNG_MS })
      const rows = await lib.until(async () => ((await dc.locator('.dc-capture').count()) === 4 ? dc.locator('.dc-capture').allInnerTexts() : null), HUNG_MS)
      check('its Captures list shows each capture', !!rows && /a silence past its limit/.test(rows[0]) && rows.some((r) => r.includes(label)), JSON.stringify(rows))
      await dc.screenshot({ path: path.join(lib.WORK, 'flightrecorder-captures.png') })
    }

    await inv('session:stop', alpha)
    await inv('session:stop', beta)
    await lib.until(async () => (await inv('session:live')).length === 0, HUNG_MS)
  } finally {
    await app.close().catch(() => undefined)
  }
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.stack ?? e.message)
  process.exit(1)
})
