// Transcript sizes in the Sessions tab (#671): every session shows its transcript file's size beside its context, for
// all three CLIs (Claude Code's projects folder, Codex's rollout, Copilot's events.jsonl); amber past Warn when a
// transcript is over, with a tooltip suggesting a handover; "—" when the CLI has no file (only Combwork's backup); a size
// that grew shows when the list opens again. The Assistant's conversations show theirs too, with its own advice. Both
// themes, and a narrow window. Fixtures only (nothing runs). Dev build, throwaway profile, workspace and CLI homes; quiet.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { sessionsOf, putSessions } = require('./storeDocs.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const userData = path.join(lib.WORK, 'sessionsize-profile')
const ws = path.join(lib.WORK, 'sessionsize-ws')
const claudeHome = path.join(lib.WORK, 'sessionsize-claude-home')
const codexHome = path.join(lib.WORK, 'sessionsize-codex-home')
const copilotHome = path.join(lib.WORK, 'sessionsize-copilot-home')
const alpha = path.join(ws, 'alpha')
const assistantHome = path.join(ws, '.combwork', 'assistant')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

const id = (n) => `0f5c2a8e-6710-4333-8444-5555666${String(n).padStart(5, '0')}`
const at = (h) => new Date(Date.UTC(2026, 9, 12, h, 0, 0)).toISOString()
const old = new Date(Date.UTC(2026, 9, 12, 0, 0, 0))
const MB = 1024 * 1024
/** A Claude Code transcript; `pad` makes it about that many bytes longer. */
const claudeLines = (sid, h, text, pad = 0) =>
  [
    { type: 'user', sessionId: sid, timestamp: at(h), message: { role: 'user', content: text + (pad ? ` ${'x'.repeat(pad)}` : '') } },
    { type: 'assistant', sessionId: sid, requestId: `r${h}`, timestamp: at(h), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 50 } } }
  ]
    .map((l) => JSON.stringify(l))
    .join('\n') + '\n'
const rollout = (sid, h, text) =>
  [
    { timestamp: at(h), type: 'session_meta', payload: { id: sid, session_id: sid, timestamp: at(h), cwd: alpha, originator: 'codex-tui', cli_version: '0.135.0', source: 'cli', thread_source: 'user' } },
    { timestamp: at(h), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
    { timestamp: at(h), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 40 }, last_token_usage: { input_tokens: 500, output_tokens: 40 }, model_context_window: 258400 } } }
  ]
    .map((l) => JSON.stringify(l))
    .join('\n') + '\n'
const copilotEvents = (sid, h, text) =>
  [
    { type: 'session.start', id: 'e1', timestamp: at(h), data: { sessionId: sid, context: { cwd: alpha } } },
    { type: 'user.message', id: 'e2', timestamp: at(h), data: { content: text } }
  ]
    .map((l) => JSON.stringify(l))
    .join('\n') + '\n'
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  // Written long ago: a transcript changed in the last few seconds counts as still being written.
  fs.utimesSync(file, old, old)
}
const claudeFile = (folder, sid) => path.join(claudeHome, 'projects', folder.replace(/[^a-zA-Z0-9]/g, '-'), `${sid}.jsonl`)
/** As the footer shows it (formatBytes in shared/defaults.ts). */
const sizeText = (n) => (n < MB ? `${Math.max(1, Math.round(n / 1024))} KB` : `${n / MB < 10 ? (n / MB).toFixed(1) : Math.round(n / MB)} MB`)

;(async () => {
  for (const d of [userData, ws, claudeHome, codexHome, copilotHome]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, codexHome, copilotHome]) fs.mkdirSync(d, { recursive: true })
  lib.gitProject(alpha)
  lib.enableProviders(userData, ['claude-code', 'codex', 'copilot'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  // Flagged from 1 MB, so a fixture can pass it without being huge.
  cfg.settings.sessions = { ...cfg.settings.sessions, transcriptWarnMB: 1 }
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47830), CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, COPILOT_HOME: copilotHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await page.getByText('alpha', { exact: true }).first().click()

    // --- A session of each CLI, one past the limit, and one whose CLI transcript is gone (only Combwork's backup).
    const S = { small: id(1), long: id(2), gone: id(3), codex: id(4), copilot: id(5), assistant: id(6) }
    const files = {
      small: claudeFile(alpha, S.small),
      long: claudeFile(alpha, S.long),
      codex: path.join(codexHome, 'sessions', '2026', '10', '12', `rollout-2026-10-12T04-00-00-${S.codex}.jsonl`),
      copilot: path.join(copilotHome, 'session-state', S.copilot, 'events.jsonl'),
      assistant: claudeFile(ws, S.assistant)
    }
    write(files.small, claudeLines(S.small, 6, 'A small one', 3000))
    write(files.long, claudeLines(S.long, 5, 'A long one', Math.round(1.4 * MB)))
    write(path.join(alpha, '.combwork', 'sessions', `${S.gone}.jsonl`), claudeLines(S.gone, 3, 'Gone from the CLI'))
    write(files.codex, rollout(S.codex, 4, 'A Codex one'))
    write(files.copilot, copilotEvents(S.copilot, 2, 'A Copilot one'))
    write(files.assistant, claudeLines(S.assistant, 7, 'Plan the week', Math.round(1.2 * MB)))
    const rec = (sid, name, h, more = {}) => ({ id: sid, agent: 'claude-code', name, createdAt: at(h), lastActiveAt: at(h), archived: false, ...more })
    // The records are in the workspace's database (#1061).
    const file = sessionsOf(alpha)
    file.sessions.push(
      rec(S.small, 'Small session', 6),
      rec(S.long, 'Long session', 5),
      rec(S.gone, 'Gone session', 3),
      rec(S.codex, 'Codex session', 4, { agent: 'codex', transcriptPath: files.codex }),
      rec(S.copilot, 'Copilot session', 2, { agent: 'copilot', transcriptPath: files.copilot })
    )
    putSessions(alpha, file)
    const aSessions = sessionsOf(assistantHome)
    aSessions.sessions.push(rec(S.assistant, 'Planning the week', 7, { agentId: 'assistant', agentName: 'Assistant', cwd: ws }))
    putSessions(assistantHome, aSessions)

    // --- The list's item carries the size, from a stat.
    const listed = await inv('session:list', alpha)
    const bytes = (sid) => listed.find((s) => s.id === sid)?.transcriptBytes
    check('session:list gives each transcript its size on disk', ['small', 'long', 'codex', 'copilot'].every((k) => bytes(S[k]) === fs.statSync(files[k]).size), JSON.stringify(listed.map((s) => [s.title ?? s.name, s.transcriptBytes])))
    check('…and null for one the CLI no longer has', bytes(S.gone) === null, String(bytes(S.gone)))

    // --- The rows.
    await page.locator('.tab', { hasText: 'Sessions' }).click()
    const row = (name) => page.locator('.sessions-tree .session-row', { hasText: name })
    const size = (name) => row(name).locator('.session-row-size')
    await lib.until(async () => (await page.locator('.sessions-tree .session-branch').count()) > 0, HUNG_MS)
    await page.getByRole('button', { name: 'Expand All' }).click()
    await lib.until(async () => (await page.locator('.sessions-tree .session-row-size').count()) === 5, HUNG_MS)
    const shown = async (name) => (await size(name).innerText().catch(() => '')).trim()
    for (const [k, name] of [['small', 'Small session'], ['long', 'Long session'], ['codex', 'Codex session'], ['copilot', 'Copilot session']]) {
      const want = sizeText(fs.statSync(files[k]).size)
      check(`${name} shows its size (${want})`, (await shown(name)) === want, await shown(name))
    }
    check('a missing transcript shows "—"', (await shown('Gone session')) === '—', await shown('Gone session'))
    const amber = async (name) => size(name).evaluate((el) => el.classList.contains('warn-text'))
    check('the one past the limit is in the warning colour', await amber('Long session'))
    check('…and the others are not', !(await amber('Small session')) && !(await amber('Codex session')) && !(await amber('Gone session')))
    const longTip = await lib.hoverTip(page, size('Long session'), (t) => /Hand the work over/.test(t))
    check('its tooltip suggests a handover to a new conversation', /Transcript: 1\.4 MB on disk \(flagged over 1 MB: Settings → Sessions\)\..*Hand the work over to a new conversation \(Hand Over to…\)/.test(longTip), longTip)
    const smallTip = await lib.hoverTip(page, size('Small session'), (t) => t.startsWith('Transcript:'))
    check('a small one just says its size', /^Transcript: \d+ KB on disk/.test(smallTip) && !/Hand the work over/.test(smallTip), smallTip)
    const goneTip = await lib.hoverTip(page, size('Gone session'), (t) => /no transcript file/.test(t))
    check('"—" says why', /Claude Code has no transcript file for this session \(Combwork keeps a backup of it\)\./.test(goneTip), goneTip)

    // --- Both themes, and a narrow window: the size stays in its row, readable.
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
      const colours = await page.evaluate(() => {
        const get = (el) => getComputedStyle(el).color
        const long = [...document.querySelectorAll('.session-row-size')].find((e) => e.classList.contains('warn-text'))
        const plain = [...document.querySelectorAll('.session-row-size')].find((e) => !e.classList.contains('warn-text'))
        return { long: long && get(long), plain: plain && get(plain), warning: getComputedStyle(document.documentElement).getPropertyValue('--warning').trim() }
      })
      check(`${theme}: the long one is amber, the others the row's colour`, !!colours.long && colours.long !== colours.plain, JSON.stringify(colours))
      await page.screenshot({ path: path.join(lib.WORK, `sessionsize-1-${theme}.png`) })
    }
    await inv('settings:update', { appearance: { theme: 'dark' } })
    await lib.fitWindow(app, page, { width: 820, height: 700 })
    await lib.until(async () => (await page.evaluate(() => window.innerWidth)) <= 820, HUNG_MS)
    const inside = await page.evaluate(() =>
      [...document.querySelectorAll('.sessions-tree .session-row')].every((r) => {
        const s = r.querySelector('.session-row-size')
        if (!s) return true
        const a = r.getBoundingClientRect()
        const b = s.getBoundingClientRect()
        return b.width > 0 && b.left >= a.left && b.right <= a.right + 0.5
      })
    )
    check('narrow: every size stays inside its row', inside)
    await page.screenshot({ path: path.join(lib.WORK, 'sessionsize-2-narrow.png') })
    await lib.fitWindow(app, page, { width: 1400, height: 850 })

    // --- A transcript that grew shows its new size when the list opens again.
    fs.appendFileSync(files.small, claudeLines(S.small, 8, 'More', 40 * 1024))
    const grown = sizeText(fs.statSync(files.small).size)
    await page.locator('.tab', { hasText: 'Files' }).first().click()
    await page.locator('.tab', { hasText: 'Sessions' }).click()
    check(`a size that grew shows when the list opens again (${grown})`, !!(await lib.until(async () => (await shown('Small session')) === grown, HUNG_MS)), await shown('Small session'))

    // --- The Assistant's conversations.
    await page.locator('.activity-btn[aria-label="Assistant"]').click()
    await lib.until(async () => (await page.locator('.assistant-summary').count()) > 0, HUNG_MS)
    await page.locator('.row', { hasText: 'All Conversations' }).click()
    const conv = page.locator('.sessions-tree .session-row', { hasText: 'Planning the week' })
    await lib.until(async () => (await page.locator('.sessions-tree .session-branch').count()) > 0, HUNG_MS)
    if (!(await conv.count())) await page.getByRole('button', { name: 'Expand All' }).click()
    const want = sizeText(fs.statSync(files.assistant).size)
    const convSize = conv.locator('.session-row-size')
    check(`the Assistant's conversation shows its size (${want}), in amber`, !!(await lib.until(async () => (await convSize.innerText().catch(() => '')).trim() === want, HUNG_MS)) && (await convSize.evaluate((el) => el.classList.contains('warn-text'))), await convSize.innerText().catch(() => ''))
    const aTip = await lib.hoverTip(page, convSize, (t) => /New Conversation/.test(t))
    check("…and its tooltip gives the Assistant's advice: a new conversation", /Start a new conversation \(⋯ → New Conversation\)/.test(aTip) && !/Hand Over to…/.test(aTip), aTip)
    await page.screenshot({ path: path.join(lib.WORK, 'sessionsize-3-assistant.png') })
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
