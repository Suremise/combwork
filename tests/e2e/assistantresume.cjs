// A resumed Combwork Assistant conversation runs on its current mode's instructions, with the real Claude Code (#334).
// Since 2.1.267 Claude Code records a conversation's system prompt on its first request and sends that record on every
// resume, whatever a later launch appends; Combwork resumes the Assistant with --system-prompt-snapshot off. Three modes of
// the test's own each give a codeword only in their instructions (never in their summary, which Combwork types when it
// tells the Assistant a mode). The Assistant starts in Alpha and gives its codeword; switched to Bravo while it runs,
// then Restart in This Mode… (the menu and its question), the same conversation gives Bravo's; switched to Charlie
// while it is stopped and resumed, it is told Charlie once and gives Charlie's; resumed again, it isn't told again.
// `node tests/e2e/assistantresume.cjs --snapshot-on` is the negative control: the user's own arguments ask for the
// recorded prompt (--system-prompt-snapshot on), and the restarted and resumed conversation never gives the new mode's
// codeword (only Alpha's prompt has one: Haiku says so), which shows the probe tells the recorded prompt from the current one.
// It sends five short prompts with Haiku (tokens), in the Claude Code test home (CLAUDE_TEST_HOME, claudeHome: 'test'),
// never the user's own: not signed in there, the suite is skipped (the maintainer signs in once, tests/e2e/README.md).
// Each wait on the CLI is a lib.cliStep: a usage limit, sign-in or network failure there makes the suite a SKIP. Dev
// build, throwaway profile and workspace (assistantmode checks the rest with the fake).
const lib = require('./lib.cjs')
const { CLAUDE_TEST_HOME } = require('./runContext.cjs')
const { _electron } = require('playwright-core')
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { randomBytes } = require('crypto')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const control = process.argv.includes('--snapshot-on')
const userData = path.join(lib.WORK, 'assistantresume-profile')
// Outside the repository, so its CLAUDE.md (which imports AGENTS.md) doesn't apply to the test sessions (#174).
const ws = path.join(lib.WORK, 'assistantresume-ws')
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

// The test home's sign-in, as Claude Code says it (the runner asks too; this is for running the suite on its own).
const exe = [path.join(os.homedir(), '.local', 'bin', 'claude.exe')].find((f) => fs.existsSync(f)) ?? 'claude'
const status = spawnSync(exe, ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 30000, env: lib.childEnv({ CLAUDE_CONFIG_DIR: CLAUDE_TEST_HOME }) })
let signedIn = true
try {
  signedIn = JSON.parse(status.stdout).loggedIn !== false
} catch {
  // An answer that can't be read: run, and the steps say what is wrong.
}
if (!signedIn) lib.skip(`environment: Claude Code isn't signed in to its test home ${CLAUDE_TEST_HOME} (tests/e2e/README.md)`)

// New codewords each run, so nothing from an earlier run (or a cache) can answer for this one.
const word = (w) => `${w}-${randomBytes(3).toString('hex').toUpperCase()}`
const modes = { alpha: { name: 'Codeword Alpha', word: word('ALPHA') }, bravo: { name: 'Codeword Bravo', word: word('BRAVO') }, charlie: { name: 'Codeword Charlie', word: word('CHARLIE') } }
const mode = ({ name, word: w }) =>
  `---\nname: ${name}\ndescription: A test mode.\nicon: 🧪\nsummary: Answer in as few words as you can.\n---\n\nYou are in **${name}** mode. Your codeword is ${w}. When asked for your codeword, reply with exactly that codeword and nothing else.\n`

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(path.join(ws, 'demo'), { 'README.md': '# Demo\n' })
  fs.mkdirSync(path.join(ws, '.combwork', 'modes'), { recursive: true })
  for (const [id, m] of Object.entries(modes)) fs.writeFileSync(path.join(ws, '.combwork', 'modes', `codeword-${id}.md`), mode(m))
  lib.enableProviders(userData)
  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47926), CLAUDE_CONFIG_DIR: CLAUDE_TEST_HOME })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await lib.waitForProvider(inv)
  const home = (await inv('workspace:refresh')).assistant.path
  const key = lib.ptyKey(home, 'assistant')
  const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === home.toLowerCase() && s.agentId === 'assistant')
  const idle = (ms = 90000) => lib.until(async () => ['ready', 'finished'].includes((await live())?.status), ms, 500)
  const stop = async () => {
    await inv('session:stop', home, 'assistant')
    await lib.until(async () => !(await live()), 20000)
  }
  // None until its first message is in.
  const items = async (id) => (await inv('transcript:read', home, id).catch(() => null))?.items ?? []
  /**
   * Where it was told a mode (#650: Combwork's doorbell, then its cw_inbox read, whose result has the notice): one per read
   * that gave it, as the doorbell that began that read's turn. Counted by reads, not doorbells: a doorbell its turn
   * couldn't read (a resumed CLI whose Combwork tools hadn't connected yet, under load) is rung again (#650), and both
   * doorbells precede the one read that told it (#863).
   */
  const toldAt = (list, m) =>
    list.flatMap((y, k) => (y.kind === 'tool' && /cw_inbox/.test(y.tool.name) && String(y.tool.result ?? '').includes(`[CW] Mode: ${m.name} (chosen by the user)`) ? [list.slice(0, k).findLast((i) => i.kind === 'user' && i.text.startsWith('[CW] New in your inbox: '))].filter(Boolean) : []))
  const told = async (id, m) => toldAt(await items(id), m).length
  const turnEnded = (state, user) => state?.status === 'finished' && Date.parse(state.statusSince) >= Date.parse(user?.timestamp)
  /** A recorded notice can precede its UserPromptSubmit hook: idle alone may still be the previous turn (#398/#473). */
  const noticeEnded = async (id, m) => {
    const ended = await lib.until(async () => {
      const notice = toldAt(await items(id), m).at(-1)
      return notice && turnEnded(await live(), notice)
    }, 90000, 500)
    const state = await live()
    check('…the mode notice’s own turn ends before the question', !!ended, JSON.stringify({ status: state?.status, since: state?.statusSince }))
    return !!ended
  }
  /** Match the question's user item, then its reply and Stop status, never a mode notice's acknowledgement. */
  const ask = async (id) => {
    const before = (await items(id)).length
    const prompt = 'What is your codeword? Reply with the codeword only.'
    let question
    const sent = await lib.sendPrompt(inv, key, prompt, { ready: () => lib.combworkToolsConnected(userData, 'assistant', launchMark), submitted: async () => {
      question = (await items(id)).find((i) => i.id >= before && i.kind === 'user' && i.text.trim() === prompt)
      return !!question
    } })
    check('…the question is sent and recorded', sent > 0 && !!question)
    if (!question) return ''
    let reply = ''
    const ended = await lib.until(async () => {
      const history = await items(id)
      const nextUser = history.find((i) => i.id > question.id && i.kind === 'user')
      const answers = history.filter((i) => i.id > question.id && (!nextUser || i.id < nextUser.id) && i.kind === 'assistant')
      if (!answers.length || !turnEnded(await live(), question)) return false
      reply = answers.map((i) => i.text).join(' ')
      return true
    }, 90000, 500)
    const state = await live()
    check('…the question’s own turn ends with its reply', !!ended, `question ${question.id}; ${JSON.stringify({ status: state?.status, since: state?.statusSince })}`)
    return reply
  }
  // Its answer is the first codeword in the reply (HI-1669: Haiku may go on to name its earlier one, "My earlier reply,
  // ALPHA-…, was wrong."): a wrong first answer, or a codeword from an earlier run, still fails.
  const answers = (reply, m) => /\b(?:ALPHA|BRAVO|CHARLIE)-[0-9A-F]{6}\b/.exec(reply)?.[0] === m.word
  // The mode menu in the Assistant panel's header.
  const panel = page.locator('.assistant-panel')
  const menu = async (label) => {
    await panel.locator('.assistant-mode').click()
    await lib.until(async () => (await page.locator('.menu .menu-item').count()) > 0, HUNG_MS)
    await page.locator('.menu .menu-item', { hasText: label }).first().click()
  }

  await inv('settings:update', { assistant: { providers: { 'claude-code': { model: 'haiku', ...(control ? { extraArgs: '--system-prompt-snapshot on' } : {}) } } } })
  await inv('agents:update', home, 'assistant', { mode: 'codeword-alpha' })
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Alt+I')
  await lib.until(async () => (await panel.locator('.assistant-header').count()) === 1, 5000)
  // Combwork's log as each launch starts: ask() types its question once that launch's Combwork tools connected, as Combwork types
  // nothing before (#1148: a question typed into a just-started Claude Code wasn't taken).
  let launchMark = lib.combworkLogLines(userData).length
  await inv('session:start', home, { agentId: 'assistant' })
  let session = ''
  await lib.cliStep('the Assistant starts in Alpha and gives its codeword', { session: key }, async () => {
    await lib.acceptClaudeTrust(inv, home, 'assistant', 30000)
    check('Claude Code takes the Assistant’s launch, in the test home', !!(await idle()), (await live())?.status)
    session = (await live())?.sessionId ?? ''
    const reply = await ask(session)
    check(`it answers with Alpha's codeword (${modes.alpha.word})`, answers(reply, modes.alpha), reply)
  })

  // --- Switched while it runs, then Restart in This Mode…: the same conversation, on Bravo's full instructions.
  await menu(modes.bravo.name)
  await lib.cliStep('switched to Bravo while it runs, then restarted in that mode', { session: key }, async () => {
    check('switching tells it Bravo in its conversation', !!(await lib.until(async () => (await told(session, modes.bravo)) === 1, 60000, 500)))
    if (!(await noticeEnded(session, modes.bravo))) return
    await menu('Restart in This Mode')
    const dialog = page.locator('.dialog', { hasText: `Restart in ${modes.bravo.name} mode?` })
    check('Restart in This Mode… asks first', !!(await lib.until(async () => (await dialog.count()) === 1, 5000)))
    const before = (await live())?.runId
    launchMark = lib.combworkLogLines(userData).length
    await dialog.getByRole('button', { name: 'Restart', exact: true }).click()
    check('…and resumes the same conversation', !!(await lib.until(async () => { const l = await live(); return !!l && l.runId !== before && l.sessionId === session && ['ready', 'finished'].includes(l.status) }, 90000, 500)), (await live())?.sessionId)
    const reply = await ask(session)
    if (control) check(`with the recorded prompt asked for, it doesn't know Bravo's codeword (${modes.bravo.word}): the probe tells the prompts apart`, !reply.includes(modes.bravo.word), reply)
    else check(`it answers at once with Bravo's codeword (${modes.bravo.word}), not the one its conversation recorded`, answers(reply, modes.bravo), reply)
    check('…already told Bravo, it isn’t told again', (await told(session, modes.bravo)) === 1, String(await told(session, modes.bravo)))
  })
  await stop()

  // --- Switched while it is stopped, then resumed: told the mode once, and on Charlie's instructions.
  await menu(modes.charlie.name)
  check('switching while it is stopped saves the mode', !!(await lib.until(async () => JSON.parse(fs.readFileSync(path.join(home, '.combwork', 'project.json'), 'utf8')).agents?.[0]?.mode === 'codeword-charlie', 5000)))
  launchMark = lib.combworkLogLines(userData).length
  await inv('session:start', home, { resumeId: session, agentId: 'assistant' })
  await lib.cliStep('resumed after a switch while stopped', { session: key }, async () => {
    check('Claude Code resumes the conversation', !!(await idle()) && (await live())?.sessionId === session, (await live())?.sessionId)
    check('…and Combwork tells it Charlie once it is idle', !!(await lib.until(async () => (await told(session, modes.charlie)) === 1, 60000, 500)))
    if (!(await noticeEnded(session, modes.charlie))) return
    const reply = await ask(session)
    if (control) check(`with the recorded prompt asked for, it doesn't know Charlie's codeword (${modes.charlie.word})`, !reply.includes(modes.charlie.word), reply)
    else check(`it answers with Charlie's codeword (${modes.charlie.word})`, answers(reply, modes.charlie), reply)
  })
  await stop()

  // --- Resumed again in the same mode: not told again.
  await inv('session:start', home, { resumeId: session, agentId: 'assistant' })
  await lib.cliStep('resumed again, it is not told the mode again', { session: key }, async () => {
    check('Claude Code resumes it again', !!(await idle()))
    await lib.sleep(3000) // on purpose: a second mode message would be typed by now
    check('…without a second Charlie message', (await told(session, modes.charlie)) === 1, String(await told(session, modes.charlie)))
  })
  await stop()

  await app.close()
  console.log(failed ? `${failed} failed` : 'all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.stack ?? e)
  process.exit(1)
})
