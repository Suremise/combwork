// The fakes' refusal of an old release's names (HI-2614, HI-2742): a launch whose environment, MCP server or scripted tool
// is named as a release before 1.1 named them (HI-2463) stops, naming what, so no test passes on them. No test reads them:
// the old-release mode that did, for the 0.9 upgrade suite, was retired with that suite (HI-2741, HI-2742).
'use strict'

/** The environment's prefix, the launch's MCP server and the tools' prefix, as a release before 1.1 names them. */
// old-name: begin oldDialect-inputs
const OLD_ENV = 'HIVE_'
const OLD_SERVER = 'hive'
const OLD_TOOL = /^hive_[a-z_]+$/
// old-name: end oldDialect-inputs

/** What a launch has of the old names: its variables under the old prefix (`OLD_ENV`), or the old server without a current one. Empty: none. */
function oldDialectIn(env, servers) {
  const found = Object.keys(env ?? {}).filter((k) => k.startsWith(OLD_ENV))
  if (servers && servers[OLD_SERVER] && !servers.combwork) found.push(`its MCP server "${OLD_SERVER}"`)
  return found
}

/** A scripted step's tool name: a current one (`cw_*`), else null for one that isn't a tool name; throws for an old one (`OLD_TOOL`). */
function toolName(name) {
  if (/^cw_[a-z_]+$/i.test(name)) return name
  if (OLD_TOOL.test(name.toLowerCase())) throw new Error(`fake: the old tool name ${name}: no test uses an old release's names (HI-2614)`)
  return null
}

module.exports = { oldDialectIn, toolName }
