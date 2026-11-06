// The fakes' old-release mode (HI-2614): what a released 0.9 or 1.0 build hands the fake Claude Code under its names from
// before 1.1 (HI-2463), for upgradelane alone, which drives a released 0.9 build with this fake (HI-2506). These names are
// that upgrade test's input, and nothing else reads them.
//
// The mode is on only when CW_FAKE_OLD_RELEASE is 1, which only fake-claude-old-release.cmd sets: lib.fakeClaude's
// { oldRelease: true } points a profile at that wrapper, and only upgradelane's 0.9 profile is given it. The run context
// never passes the variable on (runContext.cjs's allowlists). Off, every launch is current, and each check below refuses
// the old dialect instead of reading it.
'use strict'

const FLAG = 'CW_FAKE_OLD_RELEASE'
/** The environment's prefix, the launch's MCP server and the tools' prefix, as a release before 1.1 names them. */
const OLD_ENV = 'HIVE_'
const OLD_SERVER = 'hive'
const OLD_TOOL = /^hive_[a-z_]+$/

/** Whether this launch is the old release's (its wrapper set the flag). */
const on = (env = process.env) => env[FLAG] === '1'

/** What a current launch has of the old dialect: its `HIVE_*` variables, or its old server without a current one. Empty: none. */
function oldDialectIn(env, servers) {
  const found = Object.keys(env ?? {}).filter((k) => k.startsWith(OLD_ENV))
  if (servers && servers[OLD_SERVER] && !servers.combwork) found.push(`its MCP server "${OLD_SERVER}"`)
  return found
}

/**
 * An environment with each variable of the old release's (`HIVE_X`) under its current name (`CW_X`) too, where that is
 * unset. Old mode only: in current mode the environment is returned as it is.
 */
function envOf(env, mode = on()) {
  if (!mode) return { ...env }
  const out = { ...env }
  for (const [k, v] of Object.entries(env ?? {})) if (k.startsWith(OLD_ENV) && out[`CW_${k.slice(OLD_ENV.length)}`] === undefined) out[`CW_${k.slice(OLD_ENV.length)}`] = v
  return out
}

/** The launch's own MCP server: `combwork`, or in old mode the old release's `hive`. Null with neither. */
const serverOf = (servers, mode = on()) => servers?.combwork ?? (mode ? servers?.[OLD_SERVER] : null) ?? null

/**
 * A scripted step's tool name: a current one (`cw_*`) always; an old release's (`hive_*`) in old mode only. Null for
 * one that isn't a tool name; throws for an old one in current mode, so a current test never passes on it.
 */
function toolName(name, mode = on()) {
  if (/^cw_[a-z_]+$/i.test(name)) return name
  if (OLD_TOOL.test(name.toLowerCase())) {
    if (mode) return name
    throw new Error(`fake: the old tool name ${name} in a current launch (only upgradelane's old release uses it, HI-2614)`)
  }
  return null
}

module.exports = { FLAG, on, oldDialectIn, envOf, serverOf, toolName }
