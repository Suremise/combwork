// Agents' temp folder (HI-2496): Settings → Advanced's "Agents' temp folder", empty by default, gives each launch TEMP,
// TMP and TMPDIR in a folder of its own, <folder>\<project>-<hash>\<agent id> (the Assistant's apart), made at launch;
// Claude Code also CLAUDE_CODE_TMPDIR, over one it inherited. Empty, a launch's variables are as before (an inherited
// CLAUDE_CODE_TMPDIR kept). A folder inside a project stops the launch, and a launch held at its folder while its
// workspace closes never starts its CLI (CW_TEST_HOLD_AGENT_TEMP: NOT RUN on a packaged build). Runs the fake Claude
// Code and the fake Codex, which record their temp variables; the Assistant on the fake Claude Code. Dev build,
// throwaway profile and folders.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'agenttemp-profile')
const ws = path.join(lib.WORK, 'agenttemp-ws')
const claudeHome = path.join(lib.WORK, 'agenttemp-claude-home')
const codexHome = path.join(lib.WORK, 'agenttemp-codex-home')
const tempRoot = path.join(lib.WORK, 'agenttemp-root')
const inherited = path.join(lib.WORK, 'agenttemp-inherited')
const wsOther = path.join(lib.WORK, 'agenttemp-ws-other')
// Each launch holds once its temp folder is made, while this file is missing (CW_TEST_HOLD_AGENT_TEMP): there from the start.
const holdGo = path.join(lib.WORK, 'agenttemp-hold-go')
const proj = path.join(ws, 'alpha')
const PORT = lib.port(47800)
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const hash = (p) => crypto.createHash('sha256').update(path.resolve(p).toLowerCase()).digest('hex').slice(0, 8)
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
// Each of the three variables, by any case, is dir (and only one of each name).
const allAt = (temp, dir) => ['TEMP', 'TMP', 'TMPDIR'].every((n) => Object.keys(temp ?? {}).filter((k) => k.toUpperCase() === n).length === 1 && same(Object.entries(temp).find(([k]) => k.toUpperCase() === n)[1], dir))

;(async () => {
  for (const d of [userData, ws, wsOther, claudeHome, codexHome, tempRoot, inherited, holdGo]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, codexHome, inherited, ws, wsOther]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(holdGo, '')
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  lib.gitProject(proj)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([proj.toLowerCase(), ws.toLowerCase()]))
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  // Combwork started with a CLAUDE_CODE_TMPDIR of the user's own: kept while the setting is empty, overridden when it is set.
  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: PORT, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, CLAUDE_CODE_TMPDIR: inherited, CW_TEST_HOLD_AGENT_TEMP: holdGo })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.waitForProvider(inv, 'codex')
    await lib.openWorkspace(inv, page, ws)
    const live = async (host, id) => (await inv('session:live')).find((s) => same(s.projectPath, host) && s.agentId === id)
    const ready = (host, id) =>
      lib.until(async () => {
        const s = await live(host, id)
        if (s?.status === 'waiting') await inv('pty:write', lib.ptyKey(host, id), '\r')
        return ['ready', 'finished'].includes(s?.status)
      }, HUNG_MS)
    const stop = async (host, id) => {
      await inv('session:stop', host, id)
      await lib.until(async () => !(await live(host, id)), HUNG_MS)
    }
    const claudeLaunches = (cwd) => lines(path.join(claudeHome, 'fake-launches.jsonl')).filter((l) => same(l.cwd, cwd))
    const codexLaunches = () => lines(path.join(codexHome, 'fake-launches.jsonl')).filter((l) => l.agent === 'Cody')
    const assistantHome = (await inv('workspace:refresh')).assistant.path

    const clara = await lib.addAgent(inv, proj, { name: 'Clara' })
    const cody = await lib.addAgent(inv, proj, { name: 'Cody', provider: 'codex' })

    // --- Empty (the default): the variables as Combwork was given them.
    await inv('session:start', proj, { agentId: clara.id })
    await inv('session:start', proj, { agentId: cody.id })
    check('both agents start with the setting empty', !!(await ready(proj, clara.id)) && !!(await ready(proj, cody.id)))
    const c0 = claudeLaunches(proj).at(-1)
    const x0 = codexLaunches().at(-1)
    check("empty: Clara's TEMP and TMP are Combwork's own, and its inherited CLAUDE_CODE_TMPDIR stays", same(c0?.temp?.TEMP, env.TEMP) && same(c0?.temp?.TMP, env.TMP) && same(c0?.env?.CLAUDE_CODE_TMPDIR, inherited), JSON.stringify({ temp: c0?.temp, tmpdir: c0?.env?.CLAUDE_CODE_TMPDIR, hive: [env.TEMP, env.TMP] }))
    check("empty: Cody's TEMP and TMP are Combwork's own", same(x0?.temp?.TEMP, env.TEMP) && same(x0?.temp?.TMP, env.TMP), JSON.stringify(x0?.temp))
    check('empty: no folder is made', !fs.existsSync(tempRoot))

    // --- Set: each launch in its own folder, made.
    await inv('advanced:set', 'cw.agents.tempFolder', tempRoot)
    const saved = JSON.parse(fs.readFileSync(path.join(userData, 'advanced.json'), 'utf8'))
    check('the setting takes a folder, kept in advanced.json', JSON.stringify(saved).includes(JSON.stringify(tempRoot).slice(1, -1)), JSON.stringify(saved).slice(0, 300))
    const host = path.join(tempRoot, `alpha-${hash(proj)}`)
    for (const id of [clara.id, cody.id]) await stop(proj, id)
    await inv('session:start', proj, { agentId: clara.id })
    await inv('session:start', proj, { agentId: cody.id })
    check('both agents start with the setting set', !!(await ready(proj, clara.id)) && !!(await ready(proj, cody.id)))
    const c1 = claudeLaunches(proj).at(-1)
    const x1 = codexLaunches().at(-1)
    const claraDir = path.join(host, clara.id)
    const codyDir = path.join(host, cody.id)
    check("set: Clara's TEMP, TMP and TMPDIR are its own folder, made", allAt(c1?.temp, claraDir) && fs.statSync(claraDir).isDirectory(), JSON.stringify({ temp: c1?.temp, claraDir }))
    check("…and its CLAUDE_CODE_TMPDIR too, over the inherited one", same(c1?.env?.CLAUDE_CODE_TMPDIR, claraDir), c1?.env?.CLAUDE_CODE_TMPDIR)
    check("set: Cody's TEMP, TMP and TMPDIR are its own folder, made, apart from Clara's", allAt(x1?.temp, codyDir) && fs.statSync(codyDir).isDirectory() && !same(claraDir, codyDir), JSON.stringify({ temp: x1?.temp, codyDir }))

    // --- The Assistant: its own folder, apart from any project's.
    await inv('session:start', assistantHome, { agentId: 'assistant' })
    check('the Assistant starts', !!(await ready(assistantHome, 'assistant')))
    // The Assistant runs in the workspace's folder, its home apart: found by its name.
    const a1 = lines(path.join(claudeHome, 'fake-launches.jsonl')).filter((l) => l.env?.CW_AGENT === 'Assistant').at(-1)
    const assistantDir = path.join(tempRoot, `_assistant-${hash(assistantHome)}`, 'assistant')
    check("the Assistant's TEMP, TMP, TMPDIR and CLAUDE_CODE_TMPDIR are its own folder", allAt(a1?.temp, assistantDir) && same(a1?.env?.CLAUDE_CODE_TMPDIR, assistantDir) && fs.existsSync(assistantDir), JSON.stringify({ temp: a1?.temp, assistantDir }))
    await stop(assistantHome, 'assistant')

    // --- The workspace closes while a launch waits on its folder (HR1, round 1): held once Dora's folder is made, the
    // window opens another workspace, then the hold ends. Dora's CLI never starts, and nothing of the launch is left:
    // back in the workspace, Dora starts as usual.
    const dora = await lib.addAgent(inv, proj, { name: 'Dora' })
    const doraDir = path.join(host, dora.id)
    fs.rmSync(holdGo)
    const doraStart = inv('session:start', proj, { agentId: dora.id }).then(() => null, (e) => String(e?.message ?? e))
    check("Dora's launch is held with its folder made", !!(await lib.until(async () => fs.existsSync(doraDir), HUNG_MS)))
    await lib.openWorkspace(inv, page, wsOther)
    fs.writeFileSync(holdGo, '')
    const doraSaid = await doraStart
    const doraLaunched = () => claudeLaunches(proj).filter((l) => l.env?.CW_AGENT === 'Dora').length
    check("…the workspace closed meanwhile: its launch ends, and Dora's CLI never starts", doraLaunched() === 0 && !(await inv('session:live')).some((s) => same(s.projectPath, proj) && s.agentId === dora.id), String(doraSaid))
    await lib.openWorkspace(inv, page, ws)
    await inv('session:start', proj, { agentId: dora.id })
    check('…back in the workspace, Dora starts as usual (nothing of the ended launch is left)', !!(await ready(proj, dora.id)) && doraLaunched() === 1 && allAt(claudeLaunches(proj).filter((l) => l.env?.CW_AGENT === 'Dora').at(-1)?.temp, doraDir))
    await stop(proj, dora.id)

    // --- A folder inside a project: the launch stops, saying why, and no folder is made there.
    const insideProj = path.join(proj, 'tmp-here')
    await inv('advanced:set', 'cw.agents.tempFolder', insideProj)
    await stop(proj, clara.id)
    const before = claudeLaunches(proj).length
    const err = await inv('session:start', proj, { agentId: clara.id }).then(() => null, (e) => String(e?.message ?? e))
    const said = err ?? (await lib.until(async () => (await live(proj, clara.id))?.error ?? null, HUNG_MS).catch(() => null))
    check('a folder inside a project stops the launch, saying so', /temp folder/i.test(String(said ?? '')) && /inside/i.test(String(said ?? '')), String(said))
    check('…Clara never launched, and nothing was made in the project', claudeLaunches(proj).length === before && !fs.existsSync(insideProj), String(claudeLaunches(proj).length - before))

    // --- Emptied again: as before.
    await inv('advanced:set', 'cw.agents.tempFolder', [])
    await inv('session:start', proj, { agentId: clara.id })
    check('emptied: Clara starts again', !!(await ready(proj, clara.id)))
    const c2 = claudeLaunches(proj).at(-1)
    check('emptied: its variables are as before, the inherited CLAUDE_CODE_TMPDIR kept', same(c2?.temp?.TEMP, env.TEMP) && same(c2?.env?.CLAUDE_CODE_TMPDIR, inherited), JSON.stringify({ temp: c2?.temp, tmpdir: c2?.env?.CLAUDE_CODE_TMPDIR }))
    for (const id of [clara.id, cody.id]) await stop(proj, id)
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
