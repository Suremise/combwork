// A typed prompt's line breaks on the real Codex (HI-1327), in the signed-in Codex test home (lib.CODEX_HOME, its own
// non-admin sandbox; never ~/.codex): a card the user starts on a running Codex agent without hive tools is typed into
// it with Send prompts as typed on, and Codex's own record of the prompt (its rollout's user message) is read back:
// - Typed prompts: line breaks at Alt+Enter, then at Ctrl+J: the prompt as written (blank lines, indentation, a CRLF;
//   a tab as a space), in one prompt, nothing sent early;
// - at Spaces (the default): on one line, as before.
// One short turn each, at low effort. Darren's OK for this run: HI-1327/r10 (28 Oct).
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'codex-newline-profile')
const ws = path.join(lib.WORK, 'codex-newline-ws')
const claudeHome = path.join(lib.WORK, 'codex-newline-claude-home')
const proj = path.join(ws, 'alpha')
const PORT = Number(lib.port(47702))
const AS_TYPED = 'cw.prompt.asTyped'
const NEWLINE = 'codex.prompt.newlineKey'
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
  try {
    return [JSON.parse(l)]
  } catch {
    return []
  }
}) : [])

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(proj, { 'README.md': '# alpha\n' })
  lib.trustForCodex(proj, lib.CODEX_HOME)
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  // No hive tools, so a card the user starts on a running agent is typed into its CLI (#650).
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true, port: PORT, provideCombworkMcp: false, allowSessionInput: true }
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  // Send prompts as typed on; a long wait for the line to be drawn (a model's turn may hold Codex busy a moment).
  fs.writeFileSync(path.join(userData, 'advanced.json'), JSON.stringify({ format: 1, values: { [AS_TYPED]: true, 'codex.prompt.drawnSeconds': 30 } }, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CW_TEST_TIPS: 'off', CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: lib.CODEX_HOME, PATH: lib.pathWithoutStoreAliases() })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const def = await lib.addAgent(inv, proj, { name: 'Tester', provider: 'codex', location: 'project', model: 'gpt-6-luna', effort: 'low' })
    const key = lib.ptyKey(proj, def.id)
    const live = async () => (await inv('session:live')).find((s) => s.agentId === def.id)
    const idle = async () => ['ready', 'finished'].includes((await live())?.status)
    await inv('session:start', proj, { agentId: def.id })
    await lib.cliStep('codex starts', { session: key }, async () => {
      check('Codex starts and is ready', !!(await lib.until(idle, HUNG_MS * 4, 300)), JSON.stringify(await live()))
    })

    /** Codex's recorded user prompts of this agent's session (its rollout, found by session id), in order. */
    const prompts = async () => {
      const sid = (await live())?.sessionId
      if (!sid) return []
      const out = []
      const walk = (dir, depth) => {
        for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
          const f = path.join(dir, e.name)
          if (e.isDirectory() && depth < 4) walk(f, depth + 1)
          else if (e.name.includes(sid) && e.name.endsWith('.jsonl')) for (const l of lines(f)) if (l.type === 'response_item' && l.payload?.role === 'user') out.push((l.payload.content ?? []).map((c) => c.text ?? '').join(''))
        }
      }
      walk(path.join(lib.CODEX_HOME, 'sessions'), 0)
      return out
    }
    /** Starts a card on the agent (typed into Codex), then waits for Codex's record of it and for its turn to end. */
    const startCard = async (title, description) => {
      const card = await inv('tasks:create', { title, description, project: 'alpha' })
      let started = null
      await lib.until(async () => {
        started = await inv('tasks:start', card.number, { kind: 'agent', agentId: def.id }).then(() => true, (e) => String(e?.message ?? e))
        return started === true || !/being given another card|is working|has just typed in it/.test(started)
      }, HUNG_MS, 300)
      const got = await lib.until(async () => {
        const g = (await prompts()).filter((t) => t.includes(title))
        return g.length ? g : null
      }, HUNG_MS * 2, 300)
      await lib.until(idle, HUNG_MS * 4, 300)
      return { started, got: got || [], all: await prompts() }
    }
    const written = 'Reply with just: ok\r\n\r\n  indented line\n\tafter a tab\nlast line'
    const asWritten = (title) => `${title}\n\nReply with just: ok\n\n  indented line\n after a tab\nlast line`

    for (const [choice, label] of [['alt-enter', 'Alt+Enter'], ['ctrl-j', 'Ctrl+J']]) {
      await lib.cliStep(`a multi-line prompt with ${label}`, { session: key }, async () => {
        await inv('advanced:set', NEWLINE, choice)
        const title = `Newline check ${choice}`
        const r = await startCard(title, written)
        check(`${label}: the card is typed into Codex`, r.started === true, String(r.started))
        check(`${label}: Codex records the prompt as written (line breaks, blank lines, indentation; the tab a space)`, r.got.length === 1 && r.got[0].trim().endsWith(asWritten(title)), JSON.stringify(r.got))
        // Every recorded prompt of this card's: the whole one, and no line of it sent on its own (a line sent early would be
        // a prompt without the title).
        const ofCard = r.all.filter((t) => t.includes(title) || (!/Newline check/.test(t) && /indented line|after a tab|last line/.test(t)))
        check(`${label}: in one prompt: no line of it was sent on its own`, ofCard.length === 1, JSON.stringify(r.all.slice(-4)))
        await page.screenshot({ path: path.join(lib.WORK, `codex-newline-${choice}.png`) })
      })
    }

    await lib.cliStep('a multi-line prompt at Spaces (the default)', { session: key }, async () => {
      await inv('advanced:set', NEWLINE, 'spaces')
      const title = 'Newline check spaces'
      const r = await startCard(title, written)
      // Each line break and the tab a space, the spacing kept (as typed): "ok", CRLF CRLF and two spaces of indentation.
      check('Spaces: Codex gets it on one line, as before', r.got.length === 1 && !r.got[0].trim().includes('\n') && r.got[0].includes('Reply with just: ok    indented line  after a tab last line'), JSON.stringify(r.got))
    })
  } catch (e) {
    check('the suite ran to its end', false, e.stack)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
