// Meta's Muse Code 1.4.20 through Combwork (HI-3202; HR2's s9: the real binary on the host, offline, in test homes, its
// identity pinned). Its echo provider answers each prompt with "echo: <prompt>" and calls no model, so nothing is signed in
// or billed: Muse runs on a CLI test home (the test seam: XDG_DATA_HOME, no account), its proxy variables pointed at a
// port nothing listens on and its telemetry off for the run, and Combwork never answers its elevation, account or sign-in
// screens (the sandbox is turned off for the run with --disable-sandbox, which the echo tier needs on a PC without it).
// What it proves, on the real binary: the launch Combwork builds is taken (every -c, the hooks, the trust, the required
// server); its hooks reach Combwork through cmd with no quote (the session's id from SessionStart, a turn from
// UserPromptSubmit and Stop); Combwork's guidance arrives as the session's start context and again at a resume;
// Combwork's tools connect; a skill Combwork delivers is offered to Muse as a project skill; a resume by id with a first
// prompt, typed once it is up; and nothing is written to the user's own Muse folders. Not proved here: a file lock's
// denial, the model's choice of tools, and token accounting (the echo provider makes no tool calls and reports no usage
// a model would): the fake suite (muse) covers Combwork's side of those.
const lib = require('./lib.cjs')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { processes } = require('./folderProcesses.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000

const MUSE = path.join(process.env.LOCALAPPDATA || '', 'combwork-test', 'muse-1.4.20', 'muse.exe')
// Muse Code 1.4.20 (1.4.20-R8619.1), Authenticode-signed by Meta: the build HI-2895's spike and HI-3202's probes recorded.
const PINNED = '2d223f7f992f02c313225ed47adf3dda24e7361b6b8389f2c19f7c12f026618a'
const userData = path.join(lib.WORK, 'musereal-profile')
const ws = path.join(lib.WORK, 'musereal-ws')
const alpha = path.join(ws, 'alpha')
const home = path.join(lib.WORK, 'musereal-home')
const dump = path.join(lib.WORK, 'musereal-skill')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** Names, sizes and times under a folder (never its contents). */
function listing(dir) {
  const out = []
  const walk = (d) => {
    let names = []
    try {
      names = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of names) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        try {
          const s = fs.statSync(p)
          out.push(`${path.relative(dir, p)}|${s.size}|${s.mtimeMs}`)
        } catch {}
      }
    }
  }
  walk(dir)
  return out.sort()
}
// The user's own Muse folders (its config, its data), which Combwork never touches.
const OWN = [path.join(os.homedir(), '.config', 'muse'), path.join(os.homedir(), '.local', 'share', 'muse'), path.join(os.homedir(), '.muse')]
const snapshot = () => Object.fromEntries(OWN.map((d) => [d, listing(d)]))

/** A session log's records, a wrapper's children unwrapped. */
function records(file) {
  const out = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const j = JSON.parse(line)
      if (Array.isArray(j.children)) for (const c of j.children) out.push(JSON.parse(c.record_json))
      else out.push(j)
    } catch {}
  }
  return out
}
const sessionFile = (id) => {
  const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : [])
  return walk(path.join(home, 'muse', 'sessions')).find((f) => f.endsWith(path.join(id, 'session.jsonl'))) ?? null
}
const blocks = (file, source) => records(file).map((r) => r.payload?.event).filter((e) => e?.kind === 'context_block_updated' && e.source === source)

;(async () => {
  if (!fs.existsSync(MUSE)) {
    console.log(`SKIP environment: the pinned Muse Code 1.4.20 isn't at ${MUSE}`)
    process.exit(0)
  }
  const hash = crypto.createHash('sha256').update(fs.readFileSync(MUSE)).digest('hex')
  if (hash !== PINNED) {
    console.log(`FAIL stopped before any run: ${MUSE} isn't the pinned 1.4.20 build (SHA-256 ${hash})`)
    process.exit(1)
  }
  check('the pinned Muse Code 1.4.20 build (its SHA-256)', true)
  for (const d of [userData, ws, home, dump]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(home, { recursive: true })
  lib.gitProject(alpha)
  fs.writeFileSync(path.join(alpha, 'AGENTS.md'), '# The project rules\n')
  // A workspace skill, which Combwork delivers into the working folder's .agents\skills as its own copy.
  fs.mkdirSync(dump, { recursive: true })
  fs.writeFileSync(path.join(dump, 'muse-probe.md'), '---\nname: muse-probe\ndescription: MUSE-REAL-SKILL-MARKER a skill Combwork delivers.\n---\nNothing to do.\n')
  lib.enableProviders(userData, ['claude-code', 'muse'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.muse = { ...cfg.settings.providers.muse, executablePath: MUSE }
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const before = snapshot()

  // Offline: Muse's own requests go to a proxy nothing listens on (127.0.0.1 itself, the hooks' and tools' address, isn't
  // proxied); a CLI test home through the seam, no account and no sign-in.
  const proxy = `http://${lib.DEAD_PROXY}`
  const env = { CW_TEST_CLI_HOME_CONNECTION: '1', XDG_DATA_HOME: home, HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy, NO_PROXY: '127.0.0.1,localhost' }
  const { app, page } = await lib.launch({ userData, env, viewport: { width: 1400, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const live = async (id) => (await inv('session:live')).find((s) => s.agentId === id && s.status !== 'stopped') ?? null
    const idle = async (id) => ['ready', 'finished'].includes((await live(id))?.status)
    const info = await lib.until(async () => {
      const i = (await inv('provider:refresh', 'muse'))?.muse
      return i?.found ? i : null
    }, HUNG_MS)
    check('Combwork finds it and reads its version', !!info && info.path?.toLowerCase() === MUSE.toLowerCase() && info.version === '1.4.20', JSON.stringify(info && { path: info.path, version: info.version }))
    check('…and reads its sandbox check (a PC without its sandbox says so)', Array.isArray(info?.readiness), JSON.stringify(info?.readiness))
    await inv('skills:addFromFile', path.join(dump, 'muse-probe.md'), 'muse-probe', [{ kind: 'combwork' }])

    // The echo provider, its sandbox and telemetry off: for this run only (-c), never Muse's saved settings.
    const agent = await lib.addAgent(inv, alpha, { name: 'Mu', provider: 'muse', extraArgs: ['--provider', 'echo', '--disable-sandbox', '-c', 'telemetry.enabled=false'] })
    const mark = lib.combworkLogLines(userData).length
    const why = await inv('session:start', alpha, { agentId: agent.id }).then(() => null, (e) => String(e?.message ?? e))
    check('it starts', why === null, why ?? '')
    const key = lib.ptyKey(alpha, agent.id)
    // Muse's sandbox screen asks for administrator rights, its default "Yes": never typed into. Seen, the run stops at once
    // (HI-3202: a test that typed into it raised a UAC prompt).
    const screen = async () => lib.plainText((await inv('pty:buffer', key).catch(() => '')) ?? '')
    const SANDBOX_SCREEN = /Set up the Windows sandbox/
    const ready = await lib.until(async () => {
      if (SANDBOX_SCREEN.test(await screen())) return 'sandbox'
      const l = await live(agent.id)
      return l?.sessionId && (await idle(agent.id)) ? l : null
    }, HUNG_MS)
    if (ready === 'sandbox' || !ready) {
      await inv('session:stop', alpha, agent.id).catch(() => undefined)
      console.log(`FAIL stopped before typing anything: ${ready === 'sandbox' ? "Muse showed its sandbox setup screen (--disable-sandbox didn't reach it)" : 'the session never became ready'}`)
      await app.close().catch(() => undefined)
      process.exit(1)
    }
    check("Muse takes the launch (every -c, the trust, the hooks), and its SessionStart hook reaches Combwork through cmd: the session's id, ready", !!ready && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/.test(ready.sessionId), JSON.stringify(ready && { status: ready.status, id: ready.sessionId }) + ' ' + lib.plainText((await inv('pty:buffer', key).catch(() => '')) ?? '').slice(-400))
    check("…Combwork's tools connected", !!(await lib.until(async () => lib.combworkToolsConnected(userData, agent.id, mark), HUNG_MS)))
    const file = ready ? sessionFile(ready.sessionId) : null
    const start = file ? blocks(file, 'runtime_hook') : []
    check("Combwork's guidance is the session's start context (SessionStart's output, through cmd with no quote)", start.some((b) => /cw_inbox/.test(b.text ?? '')), JSON.stringify(start.map((b) => (b.text ?? '').slice(0, 80))))
    const skills = file ? blocks(file, 'skills') : []
    check('…and the skill Combwork delivered is offered as a project skill (.agents\\skills, its own copy)', skills.some((b) => /id="cw-muse-probe" scope="project"/.test(b.text ?? '')), JSON.stringify(skills.map((b) => (b.text ?? '').match(/<skill id="cw-[^"]*"[^>]*>/g))))

    // A turn: typed in its pane; its UserPromptSubmit and Stop hooks make it a turn; the reply in its transcript.
    const taken = await lib.sendPrompt(inv, key, 'hello from combwork', { submitted: async () => (await live(agent.id))?.status === 'working' || !!(await live(agent.id))?.turn?.id, tries: 1, waitMs: HUNG_MS })
    check('a prompt starts a turn (its UserPromptSubmit hook)', taken > 0, (await live(agent.id))?.status)
    const items = await lib.until(async () => {
      const t = (await inv('transcript:read', alpha, ready.sessionId).catch(() => null))?.items ?? []
      return t.some((i) => i.kind === 'assistant' && i.text === 'echo: hello from combwork') && (await idle(agent.id)) ? t : null
    }, HUNG_MS)
    check('…ends (its Stop hook), the prompt and reply in the conversation view from its session log', !!items && items.some((i) => i.kind === 'user' && i.text === 'hello from combwork'), JSON.stringify(items?.map((i) => `${i.kind} ${String(i.text ?? '').slice(0, 60)}`)))

    // Stopped, then resumed by its id with a first prompt: typed once it is up (1.4.20's resume takes none).
    await inv('session:stop', alpha, agent.id)
    check('it stops', !!(await lib.until(async () => !(await live(agent.id)), HUNG_MS)))
    const startsBefore = start.length
    const why2 = await inv('session:start', alpha, { agentId: agent.id, resumeId: ready.sessionId, prompt: 'after resume' }).then(() => null, (e) => String(e?.message ?? e))
    check('it resumes its session by id, with a first prompt', why2 === null, why2 ?? '')
    const again = await lib.until(async () => {
      const t = (await inv('transcript:read', alpha, ready.sessionId).catch(() => null))?.items ?? []
      return t.some((i) => i.kind === 'assistant' && i.text === 'echo: after resume') ? t : null
    }, HUNG_MS)
    check('…the prompt typed once it was up, and answered in the same session', !!again)
    check("…Combwork's guidance given again at the resume's start", blocks(file, 'runtime_hook').filter((b) => /cw_inbox/.test(b.text ?? '')).length > startsBefore, String(blocks(file, 'runtime_hook').length))
    await inv('session:stop', alpha, agent.id)
    await lib.until(async () => !(await live(agent.id)), HUNG_MS)
    // Muse's own processes of this test: those whose command line names this test copy's data (its hooks' auth file).
    const left = () => processes().filter((p) => /\bmuse(\.exe)?\b/i.test(p.commandLine) && p.commandLine.toLowerCase().includes(userData.toLowerCase()))
    check('…and no Muse of this test is left running', !!(await lib.until(async () => (left().length ? null : true), HUNG_MS)), JSON.stringify(left().map((p) => p.pid)))
  } finally {
    await app.close().catch(() => undefined)
  }
  const after = snapshot()
  const changed = OWN.filter((d) => JSON.stringify(before[d]) !== JSON.stringify(after[d]))
  check("the user's own Muse folders are as they were", changed.length === 0, changed.join(', '))
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
