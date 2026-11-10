// What the fake opencode loads for a launch, as the real 2.2.6 did (tests/fixtures/opencode/real-2.2.6/switches, HI-2763's
// R0 on a hostile project with each discovery switch alone, both and neither):
// - always: <OPENCODE_CONFIG_DIR>\opencode.json and its AGENTS.md, and the config's `instructions` entries;
// - without OPENCODE_DISABLE_PROJECT_CONFIG: every opencode.json from the project up to the drive's root (the walk goes
//   above the git root), the project's .opencode\opencode.json, plugins (the config's `plugins`, .opencode\plugins),
//   .opencode\agents, .agents\skills and the project's AGENTS.md; a project server of the same name REPLACES ours,
//   endpoint and token both;
// - .claude\skills: the project's only with neither switch, <HOME>\.claude\skills without OPENCODE_DISABLE_CLAUDE_CODE.
// Policies: the global config's outrank the project's (last match wins within each; global first), so a global deny
// holds whatever the project allows. Nothing a project holds is ever run: "loading" a plugin or file only records it.
const fs = require('fs')
const path = require('path')

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}
const exists = (f) => {
  try {
    fs.statSync(f)
    return true
  } catch {
    return false
  }
}
const list = (d) => {
  try {
    return fs.readdirSync(d)
  } catch {
    return []
  }
}
const on = (name, env) => env[name] === '1' || env[name] === 'true'

/** The launch's config: { global, merged, loaded: [{kind, path}], servers, policies, providers, model, instructions }. */
function load(projectDir, env = process.env) {
  const cfgDir = env.OPENCODE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(env.USERPROFILE || env.HOME || '', '.config'), 'opencode')
  const loaded = []
  const globalFile = path.join(cfgDir, 'opencode.json')
  const global = readJson(globalFile) || {}
  if (exists(globalFile)) loaded.push({ kind: 'config', path: globalFile })
  const instructions = []
  if (exists(path.join(cfgDir, 'AGENTS.md'))) instructions.push(path.join(cfgDir, 'AGENTS.md'))
  const project = []
  const noProject = on('OPENCODE_DISABLE_PROJECT_CONFIG', env)
  const noClaude = on('OPENCODE_DISABLE_CLAUDE_CODE', env)
  const dir = projectDir ? path.resolve(projectDir) : null
  if (!noProject && dir) {
    // From the drive's root down to the project, so the nearest (the project's own) is applied last and wins.
    const walk = []
    for (let d = dir; ; d = path.dirname(d)) {
      walk.unshift(path.join(d, 'opencode.json'))
      if (path.dirname(d) === d) break
    }
    for (const f of [...walk, path.join(dir, '.opencode', 'opencode.json')]) {
      const c = readJson(f)
      if (!c) continue
      loaded.push({ kind: 'config', path: f })
      project.push({ file: f, config: c })
      for (const p of c.plugins || []) loaded.push({ kind: 'plugin', path: path.resolve(path.dirname(f), p) })
      for (const i of c.instructions || []) instructions.push(path.resolve(path.dirname(f), i))
    }
    for (const p of list(path.join(dir, '.opencode', 'plugins'))) loaded.push({ kind: 'plugin', path: path.join(dir, '.opencode', 'plugins', p) })
    for (const a of list(path.join(dir, '.opencode', 'agents'))) loaded.push({ kind: 'agent', path: path.join(dir, '.opencode', 'agents', a) })
    for (const s of list(path.join(dir, '.agents', 'skills'))) loaded.push({ kind: 'skill', path: path.join(dir, '.agents', 'skills', s) })
    if (exists(path.join(dir, 'AGENTS.md'))) instructions.push(path.join(dir, 'AGENTS.md'))
    if (!noClaude) for (const s of list(path.join(dir, '.claude', 'skills'))) loaded.push({ kind: 'skill', path: path.join(dir, '.claude', 'skills', s) })
  }
  const home = env.USERPROFILE || env.HOME
  if (!noClaude && home) for (const s of list(path.join(home, '.claude', 'skills'))) loaded.push({ kind: 'skill', path: path.join(home, '.claude', 'skills', s) })
  for (const s of list(path.join(cfgDir, 'skills'))) loaded.push({ kind: 'skill', path: path.join(cfgDir, 'skills', s) })
  for (const i of global.instructions || []) instructions.push(path.resolve(cfgDir, i))
  for (const i of [...new Set(instructions)]) loaded.push({ kind: 'instructions', path: i })

  // Servers: ours, then each project config's in turn (a same-name one replaces ours whole).
  const servers = { ...global.mcp?.servers }
  const providers = { ...global.providers }
  let model = global.model
  for (const { config } of project) {
    Object.assign(servers, config.mcp?.servers)
    Object.assign(providers, config.providers)
    if (config.model) model = config.model
  }
  const globalPolicies = global.policies || []
  const projectPolicies = project.flatMap((p) => p.config.policies || [])
  // Permission rules: each document's in turn, the config folder's first, so a project's let in comes last and wins
  // (2.2.6 pushes them onto each agent's own rules: probes/external-directory-ask.json, HI-2775).
  const permissions = [...(global.permissions || []), ...project.flatMap((p) => p.config.permissions || [])]
  return { cfgDir, global, loaded, servers, providers, model, instructions: [...new Set(instructions)], globalPolicies, projectPolicies, permissions, serviceDisabled: readJson(path.join(cfgDir, 'service.json'))?.disabled === true }
}

const glob = (pattern, value) => new RegExp('^' + String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(value)
/** Whether a policy list lets action on resource: the last that matches wins; undefined when none does. */
function decide(policies, action, resource) {
  let effect
  for (const p of policies) if (p.action === action && glob(p.resource ?? '*', resource)) effect = p.effect
  return effect
}
/** Allowed by the global policies first (they outrank the project's), then the project's; allowed when neither says. */
function allowed(cfg, action, resource) {
  const g = decide(cfg.globalPolicies, action, resource)
  if (g) return g === 'allow'
  const p = decide(cfg.projectPolicies, action, resource)
  return p ? p === 'allow' : true
}
/** The MCP servers it starts: the merged ones mcp.use allows. */
const startedServers = (cfg) => Object.fromEntries(Object.entries(cfg.servers).filter(([name]) => allowed(cfg, 'mcp.use', name)))

module.exports = { load, allowed, startedServers, readJson }
