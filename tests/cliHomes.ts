// Unit tests never read the user's own CLI homes (HI-1703): each file gets empty ones for Claude Code, Codex and
// Copilot, as the e2e runs get their test homes. Unset, Combwork's code reads ~/.claude, ~/.codex and ~/.copilot: Codex's
// session list alone read the session_meta of every rollout there (over a thousand on the maintainer's machine, 14-17 s
// under a full run's load: HI-1666's timeouts), and what a test saw hung on what the machine held. Set whatever the
// shell has: a variable there names the user's own home (Combwork keeps CODEX_HOME… as the user's configuration), not a
// test's. A test that sets its own still does; one that checks the default path clears the variable itself.
import { mkdirSync } from 'fs'
import { join } from 'path'
import { tempDir } from './tempDir'

const homes = tempDir('hive-cli-homes-')
for (const [name, dir] of [['CLAUDE_CONFIG_DIR', 'claude'], ['CODEX_HOME', 'codex'], ['COPILOT_HOME', 'copilot']] as const) {
  process.env[name] = join(homes, dir)
  mkdirSync(process.env[name], { recursive: true })
}
