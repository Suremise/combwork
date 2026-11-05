// Measures what sessions are actually given about Combwork, from real launches (with the fake CLIs, so it costs nothing):
// for each provider and role (project agent, the Assistant at each control level), a short catalog (Combwork's own skills)
// and a long one (40 more skills of the user's), a new session and a resumed one. Counted from the launch itself:
// - instructions: the hive MCP server's (initialize, with the launch's own environment), and for Codex the developer
//   instructions on its command line; for the Assistant on Claude Code, its appended system prompt file;
// - tools: the hive MCP server's tools/list (names, descriptions and schemas), as that launch's server answers it;
// - skills: each delivered skill's name and description (what the CLI lists; bodies load only when used).
// Characters and UTF-8 bytes; tokens are estimated at 4 bytes each (no tokenizer is run).
//
//   npx electron-vite build && node tests/scenarios/measure.cjs        (writes measure.json and measure.md beside results)
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const lib = require('../e2e/lib.cjs')

const OUT = path.join(lib.WORK, '..', 'scenarios', 'measure')
const bytes = (s) => Buffer.byteLength(s ?? '', 'utf8')
// The longest a measurement waits for what it is waiting on (the workspace, a turn, a stop): a bound for a hung run.
const HUNG_MS = 30000

/** The hive MCP server's instructions and tools, started as the launch starts it. */
function hiveServer(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'cw-mcp.js')], { env: lib.childEnv({ ...env, ELECTRON_RUN_AS_NODE: '1' }) })
    let buf = ''
    const got = {}
    const timer = setTimeout(() => (p.kill(), reject(new Error('hive-mcp did not answer'))), 15000)
    p.stdout.on('data', (d) => {
      buf += d
      for (let i; (i = buf.indexOf('\n')) >= 0; ) {
        const m = JSON.parse(buf.slice(0, i))
        buf = buf.slice(i + 1)
        got[m.id] = m.result
        if (got[1] && got[2]) {
          clearTimeout(timer)
          p.kill()
          resolve({ instructions: got[1].instructions ?? '', tools: JSON.stringify(got[2].tools) })
        }
      }
    })
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n')
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
  })
}

/** The name and description lines of every SKILL.md under `dir` (one folder per skill). */
function skillMetadata(dir) {
  if (!fs.existsSync(dir)) return { count: 0, text: '' }
  let text = ''
  let count = 0
  for (const d of fs.readdirSync(dir)) {
    const f = path.join(dir, d, 'SKILL.md')
    if (!fs.existsSync(f)) continue
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(f, 'utf8'))?.[1] ?? ''
    text += fm.split(/\r?\n/).filter((l) => /^(name|description):/.test(l)).join('\n') + '\n'
    count++
  }
  return { count, text }
}

const tomlString = (v) => (v.startsWith('"') ? JSON.parse(v) : v)

;(async () => {
  fs.rmSync(OUT, { recursive: true, force: true })
  const rows = []
  for (const catalog of ['short', 'long']) {
    for (const assistantProvider of ['claude-code', 'codex']) {
      const root = path.join(OUT, `${catalog}-${assistantProvider}`)
      const userData = path.join(root, 'profile')
      const ws = path.join(root, 'ws')
      const alpha = path.join(ws, 'alpha')
      const claudeHome = path.join(root, 'claude-home')
      const codexHome = path.join(root, 'codex-home')
      fs.mkdirSync(claudeHome, { recursive: true })
      fs.mkdirSync(codexHome, { recursive: true })
      fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
      lib.gitProject(alpha)
      fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase(), ws.toLowerCase()]))
      lib.enableProviders(userData, ['claude-code', 'codex'])
      const cfgFile = path.join(userData, 'config.json')
      const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
      cfg.settings.providers['claude-code'].executablePath = path.join(lib.ROOT, 'tests', 'e2e', 'fake-claude', 'fake-claude.cmd')
      cfg.settings.providers.codex.executablePath = path.join(lib.ROOT, 'tests', 'e2e', 'fake-codex', 'fake-codex.cmd')
      cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
      cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
      cfg.settings.assistant = { ...cfg.settings.assistant, provider: assistantProvider }
      fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
      const { app, inv } = await lib.launch({ userData, env: { CW_API_PORT: '47931', CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, CW_TEST_TIPS: 'off' } })
      try {
        await lib.waitForProvider(inv, 'codex', 60000)
        await inv('workspace:open', ws)
        await lib.until(async () => (await inv('workspace:refresh'))?.projects?.some((p) => p.name === 'alpha'), HUNG_MS)
        if (catalog === 'long') {
          for (let i = 1; i <= 40; i++) {
            const d = path.join(ws, '.combwork', 'skills', `team-skill-${i}`)
            fs.mkdirSync(d, { recursive: true })
            fs.writeFileSync(path.join(d, 'SKILL.md'), `---\nname: team-skill-${i}\ndescription: The team's procedure number ${i} for one of its recurring jobs. Use when the user asks for job ${i}.\n---\n\nSteps.\n`)
          }
        }
        const live = async (host, id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === host.toLowerCase() && s.agentId === id)
        /** Each Claude Code launch's MCP config as it was while it ran, by its path. */
        const mcpConfigs = new Map()
        const runOnce = async (host, id, resumeId) => {
          await inv('session:start', host, { agentId: id, ...(resumeId ? { resumeId } : {}) })
          const t = Date.now()
          while (Date.now() - t < 30000 && !['ready', 'finished'].includes((await live(host, id))?.status)) await lib.sleep(300)
          // One exchange, so there is a conversation to resume: sent, then over (the session back at its prompt).
          let worked = false
          await lib.sendPrompt(inv, lib.ptyKey(host, id), 'hello', { submitted: async () => (worked ||= ['working', 'finished'].includes((await live(host, id))?.status)) })
          await lib.until(async () => worked && ['finished', 'ready'].includes((await live(host, id))?.status) && !!(await live(host, id))?.sessionId, HUNG_MS)
          const sid = (await live(host, id))?.sessionId
          // Claude Code's MCP config is in the launch's private folder, which goes when it stops (#345): read it first.
          const launched = fs.existsSync(path.join(claudeHome, 'fake-launches.jsonl')) ? fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1) : null
          if (launched?.opts?.['--mcp-config'] && fs.existsSync(launched.opts['--mcp-config'])) mcpConfigs.set(launched.opts['--mcp-config'], fs.readFileSync(launched.opts['--mcp-config'], 'utf8'))
          await inv('session:stop', host, id)
          await lib.until(async () => ['stopped', 'error', undefined].includes((await live(host, id))?.status), HUNG_MS)
          return sid
        }
        // A row says "resumed" only when the CLI was actually started on that conversation (its own arguments).
        const measureClaude = async (role, resumed) => {
          const launch = fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1)
          const session = !resumed ? 'new' : launch.opts['--resume'] === resumed ? 'resumed' : 'resume NOT confirmed'
          const server = await hiveServer(JSON.parse(mcpConfigs.get(launch.opts['--mcp-config']) ?? fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork.env)
          const appended = launch.opts['--append-system-prompt-file'] ? fs.readFileSync(launch.opts['--append-system-prompt-file'], 'utf8') : ''
          const skills = skillMetadata(path.join(launch.opts['--plugin-dir'], 'skills'))
          rows.push({ provider: 'claude-code', role, catalog, session, instructions: bytes(server.instructions) + bytes(appended), tools: bytes(server.tools), skills: bytes(skills.text), skillCount: skills.count })
        }
        const measureCodex = async (role, cwd, resumed) => {
          const launch = fs.readFileSync(path.join(codexHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.cwd.toLowerCase() === cwd.toLowerCase() && !['--version', 'login', 'app-server'].includes(l.args[0])).at(-1)
          const session = !resumed ? 'new' : launch.args[0] === 'resume' && launch.args[1] === resumed ? 'resumed' : 'resume NOT confirmed'
          const arg = (prefix) => launch.args.find((a) => a.startsWith(prefix))?.slice(prefix.length) ?? ''
          const developer = tomlString(arg('developer_instructions='))
          // The hive server's environment from its -c mcp_servers.combwork table.
          const table = arg('mcp_servers.combwork=')
          const env = Object.fromEntries([...table.matchAll(/(CW_\w+|ELECTRON_RUN_AS_NODE)="((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1], JSON.parse(`"${m[2]}"`)]))
          const server = await hiveServer(env)
          const skills = skillMetadata(path.join(cwd, '.agents', 'skills'))
          // Codex doesn't show MCP instructions to the model: the developer instructions carry the same text.
          rows.push({ provider: 'codex', role, catalog, session, instructions: bytes(developer), tools: bytes(server.tools), skills: bytes(skills.text), skillCount: skills.count })
        }
        if (assistantProvider === 'claude-code') {
          // Project agents of both providers, new and resumed (measured once per catalog, in the first window).
          const claude = await lib.addAgent(inv, alpha, { name: 'Clara', provider: 'claude-code' })
          const sid = await runOnce(alpha, claude.id)
          await measureClaude('agent', null)
          await runOnce(alpha, claude.id, sid)
          await measureClaude('agent', sid)
          const codex = await lib.addAgent(inv, alpha, { name: 'Cody', provider: 'codex' })
          const csid = await runOnce(alpha, codex.id)
          await measureCodex('agent', alpha, null)
          await runOnce(alpha, codex.id, csid)
          await measureCodex('agent', alpha, csid)
        }
        // The Assistant, at each control level, new and resumed.
        const home = (await inv('workspace:refresh')).assistant.path
        for (const control of ['look', 'agents', 'projects']) {
          await inv('settings:update', { assistant: { control } })
          const asid = await runOnce(home, 'assistant')
          if (assistantProvider === 'claude-code') await measureClaude(`assistant (${control})`, null)
          else await measureCodex(`assistant (${control})`, ws, null)
          await runOnce(home, 'assistant', asid)
          if (assistantProvider === 'claude-code') await measureClaude(`assistant (${control})`, asid)
          else await measureCodex(`assistant (${control})`, ws, asid)
        }
      } finally {
        await app.close().catch(() => undefined)
      }
    }
  }
  fs.mkdirSync(OUT, { recursive: true })
  const { sourceFingerprint } = require('./harness.cjs')
  const source = sourceFingerprint()
  fs.writeFileSync(path.join(OUT, 'measure.json'), JSON.stringify({ source, when: new Date().toISOString(), rows }, null, 2))
  const k = (n) => n.toLocaleString('en')
  const md = [
    `Source ${source.head}${source.dirty ? ` + changes ${source.dirty}` : ''}, ${rows.length} measurements.`,
    '',
    '| Provider | Role | Catalog | Session | Instructions | Tools | Skill metadata (skills) | Total | ≈ tokens |',
    '|---|---|---|---|---:|---:|---:|---:|---:|',
    ...rows.map((r) => {
      const total = r.instructions + r.tools + r.skills
      return `| ${r.provider} | ${r.role} | ${r.catalog} | ${r.session} | ${k(r.instructions)} | ${k(r.tools)} | ${k(r.skills)} (${r.skillCount}) | ${k(total)} | ${k(Math.round(total / 4))} |`
    })
  ].join('\n')
  fs.writeFileSync(path.join(OUT, 'measure.md'), md + '\n')
  console.log(md)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
