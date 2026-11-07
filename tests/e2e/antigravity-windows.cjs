// The Antigravity CLI's Windows edge cases (HI-2548), with the fake agy (fake-agy/: no sign-in, no model): agy itself in
// a folder whose path has spaces and non-ASCII letters (its .cmd shim quoted), a workspace and project there too, and two
// agents on the PC's one sign-in at once, each on a connection of its own with another model. Each launch runs in that
// folder in a private profile of its own; its trusted folder, rules file, hooks and transcript all name the path as it
// is; an edit there is seen by Combwork's file lock; the two never share a profile, a conversation or a model, and each
// one's status line, transcript and usage are its own. Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const base = path.join(lib.WORK, 'antigravity windows é 漢字')
const userData = path.join(lib.WORK, 'antigravity-windows-profile')
const ws = path.join(base, 'work space ü')
const proj = path.join(ws, 'proj ä ö')
const bin = path.join(base, 'agy bin ß')
const agyLog = path.join(lib.WORK, 'antigravity-windows-fake-agy.jsonl')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const entries = (kind) => (fs.existsSync(agyLog) ? fs.readFileSync(agyLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === kind) : [])
const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase()

;(async () => {
  for (const d of [userData, base]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(agyLog, { force: true })
  lib.gitProject(proj, { 'notes.txt': 'notes\n' })
  // agy where its path has spaces and non-ASCII letters: a .cmd shim there, as an install could be, calling the fake.
  fs.mkdirSync(bin, { recursive: true })
  // A one-line Node launcher (as an install's is), which Combwork starts as node and its script, both at that path.
  fs.writeFileSync(path.join(bin, 'agy.cmd'), '@node "%~dp0agy.cjs" %*\r\n')
  fs.writeFileSync(path.join(bin, 'agy.cjs'), `require(${JSON.stringify(path.join(__dirname, 'fake-agy', 'fake-agy.cjs'))})\n`)
  lib.enableProviders(userData, ['claude-code', 'antigravity'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers.antigravity = { ...cfg.settings.providers.antigravity, executablePath: path.join(bin, 'agy.cmd') }
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  // agy's first-run screens done in Combwork's check profile, as Provider Setup's Set up leaves it (HI-2547).
  const cache = path.join(userData, 'antigravity', 'check', '.gemini', 'antigravity-cli', 'cache')
  fs.mkdirSync(cache, { recursive: true })
  fs.writeFileSync(path.join(cache, 'onboarding.json'), JSON.stringify({ onboardingComplete: true }))

  const { app, inv, page } = await lib.launch({ userData, env: { CW_API_PORT: lib.port(47903), FAKE_AGY_LOG: agyLog } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  const live = async (id) => (await inv('session:live')).find((s) => same(s.projectPath, proj) && s.agentId === id)
  const { until } = lib

  // --- Found where its path has spaces and non-ASCII letters, and signed in (the fake's `agy models` there).
  const found = await until(async () => {
    const info = (await inv('provider:refresh', 'antigravity'))?.antigravity
    return info?.found && info.loggedIn ? info : null
  }, HUNG_MS)
  check('agy is found and checked where its path has spaces and non-ASCII letters', !!found && same(found.path, path.join(bin, 'agy.cmd')) && found.version === '1.5.0', JSON.stringify(found && { path: found.path, version: found.version, loggedIn: found.loggedIn }))
  // Never on any other agy (HI-2548: a fake Combwork couldn't run fell back to the user's real one): stopped here.
  if (!found || !same(found.path, path.join(bin, 'agy.cmd'))) {
    console.log(`FAIL stopped before any session: Combwork selected ${found?.path ?? 'no agy'}, not the fake`)
    await app.close()
    process.exit(1)
  }

  // --- Two agents on the PC's one sign-in, each on a connection of its own with another model.
  const one = await lib.addAgent(inv, proj, { name: 'Gem One', provider: 'antigravity', model: 'gemini-3.8-flash-high' })
  const two = await lib.addAgent(inv, proj, { name: 'Gem Two', provider: 'antigravity', model: 'gemini-3.8-flash-low' })
  const rows = (await inv('connections:list')).connectionRows ?? []
  const conn = (a) => rows.find((c) => c.id === a.connection)
  check('two connections on the one PC-wide sign-in, each with its own model', !!conn(one) && !!conn(two) && conn(one).id !== conn(two).id && conn(one).account === 'antigravity' && conn(two).account === 'antigravity' && conn(one).model !== conn(two).model, JSON.stringify(rows.filter((c) => c.provider === 'antigravity')))

  // Both at once.
  await Promise.all([one, two].map((a) => inv('session:start', proj, { agentId: a.id })))
  const convs = await until(async () => {
    const got = await Promise.all([one, two].map(async (a) => (await live(a.id))?.sessionId || null))
    return got.every(Boolean) ? got : null
  }, HUNG_MS)
  check('both start at once, each with a conversation of its own', !!convs && convs[0] !== convs[1], JSON.stringify(convs))
  const launches = entries('session')
  const of = (conv) => launches.find((l) => l.conversation === conv)
  const [l1, l2] = (convs ?? []).map(of)
  check('…each in a private profile of its own (never shared)', !!l1 && !!l2 && !!l1.env.USERPROFILE && !same(l1.env.USERPROFILE, l2.env.USERPROFILE), JSON.stringify([l1?.env, l2?.env]))
  check('…each on its connection’s model', l1?.args[l1.args.indexOf('--model') + 1] === 'gemini-3.8-flash-high' && l2?.args[l2.args.indexOf('--model') + 1] === 'gemini-3.8-flash-low', JSON.stringify([l1?.args, l2?.args]))
  check('…each in the project folder as it is (spaces and non-ASCII kept)', same(l1?.cwd, proj) && same(l2?.cwd, proj), JSON.stringify([l1?.cwd, l2?.cwd]))
  const settings = (l) => JSON.parse(fs.readFileSync(l.args[l.args.indexOf('--settings') + 1], 'utf8'))
  check('…its folder trusted by its path as it is', !!l1 && (settings(l1).trustedWorkspaces ?? []).some((d) => same(d, proj)), JSON.stringify(l1 && settings(l1).trustedWorkspaces))
  const rules = l1 ? path.join(l1.env.USERPROFILE, '.gemini', 'GEMINI.md') : ''
  check("…Combwork's guidance in its own profile's rules file", !!rules && fs.existsSync(rules) && /cw_inbox/.test(fs.readFileSync(rules, 'utf8')))

  // A turn in each at once: each one's transcript, usage and status line its own.
  const transcriptOf = (l, conv) => path.join(l.env.USERPROFILE, '.gemini', 'antigravity-cli', 'brain', conv, '.system_generated', 'logs', 'transcript_full.jsonl')
  const say = async (agentId, text) => {
    await inv('pty:write', lib.ptyKey(proj, agentId), text)
    await inv('pty:write', lib.ptyKey(proj, agentId), '\r')
  }
  await Promise.all([say(one.id, 'hello from one ü'), say(two.id, 'hello from two 漢')])
  const both = await until(async () => {
    const shown = await Promise.all((convs ?? []).map(async (c) => (await inv('transcript:read', proj, c).catch(() => null))?.items ?? []))
    return shown.every((items) => items.some((i) => i.kind === 'assistant')) ? shown : null
  }, HUNG_MS)
  const texts = (items) => (items ?? []).map((i) => `${i.kind} ${i.text ?? ''}`)
  check('each conversation shows its own turn (non-ASCII kept), none of the other’s', !!both && JSON.stringify(texts(both[0])) === JSON.stringify(['user hello from one ü', 'assistant Done: hello from one ü']) && JSON.stringify(texts(both[1])) === JSON.stringify(['user hello from two 漢', 'assistant Done: hello from two 漢']), JSON.stringify(both?.map(texts)))
  check('…each transcript in its own profile', !!l1 && !!l2 && fs.existsSync(transcriptOf(l1, convs[0])) && fs.existsSync(transcriptOf(l2, convs[1])) && !fs.existsSync(transcriptOf(l1, convs[1])))
  const usage = await until(async () => {
    const u = await Promise.all((convs ?? []).map((c) => inv('session:usage', proj, c).catch(() => null)))
    return u.every((x) => x?.requests >= 1) ? u : null
  }, HUNG_MS)
  check('…its usage its own, on its own model', !!usage && usage[0].model === 'gemini-3.8-flash-high' && usage[1].model === 'gemini-3.8-flash-low' && usage[0].userMessages === 1 && usage[1].userMessages === 1, JSON.stringify(usage?.map((u) => u && { model: u.model, requests: u.requests, userMessages: u.userMessages })))
  const details = await until(async () => {
    const d = await Promise.all([one, two].map((a) => live(a.id)))
    return d.every((x) => x?.modelName) ? d : null
  }, HUNG_MS)
  check('…and its status line its own model', !!details && details[0].modelName === 'gemini-3.8-flash-high' && details[1].modelName === 'gemini-3.8-flash-low', JSON.stringify(details?.map((d) => d?.modelName)))

  // --- Hooks name the folder as it is, and an edit there is the agent's: another agent's lock on the file refuses it.
  const hooks = entries('hook').filter((h) => h.payload.conversationId === convs?.[0])
  check("agy's hooks name the project's path as it is", hooks.length > 0 && hooks.every((h) => (h.payload.workspacePaths ?? []).some((p) => same(p.replace(/\//g, '\\'), proj))), JSON.stringify(hooks[0]?.payload?.workspacePaths))
  // Gem Two edits notes.txt and waits on a permission prompt, its claim held; Gem One's edit of it is then refused.
  await say(two.id, 'edit notes.txt then needs approval')
  check("Gem Two's edit there runs and its turn waits on its prompt", !!(await until(async () => (await live(two.id))?.status === 'waiting', HUNG_MS)), (await live(two.id))?.status)
  await say(one.id, 'edit notes.txt')
  const denied = await until(async () => entries('hook').find((h) => h.event === 'PreToolUse' && h.payload.conversationId === convs?.[0] && h.reply?.decision === 'deny') ?? null, HUNG_MS)
  check("…Gem One's edit of the file it holds is refused (Combwork's lock, by the path as it is)", !!denied && /notes\.txt/.test(String(denied.reply.reason ?? '')), JSON.stringify(denied?.reply))
  await say(two.id, 'n')

  for (const a of [one, two]) await inv('session:stop', proj, a.id)
  await until(async () => !(await live(one.id)) && !(await live(two.id)), HUNG_MS)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
