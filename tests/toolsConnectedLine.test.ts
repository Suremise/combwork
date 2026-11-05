// The log line an agent's Combwork tools connected (sessions.ts, #865) and its one reader, lib.hiveToolsConnected:
// e2e suites and the scenario harness wait on it before typing into a real CLI. HI-2584 renamed it from "hive tools
// connected" and a suite with its own copy of the text (wakepaste-cli) missed the change (HR2's round 1), so the line
// is read only through the helper, which still accepts the old form.
import { createRequire } from 'module'
import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'

const { hiveToolsConnected } = createRequire(import.meta.url)('./e2e/lib.cjs') as { hiveToolsConnected: (userData: string, agentId: string, since?: number) => boolean }
const ROOT = join(__dirname, '..')

/** A test profile whose hive.log holds these lines. */
function profile(lines: string[]): string {
  const userData = tempDir('toolsconnected-')
  mkdirSync(join(userData, 'logs'), { recursive: true })
  writeFileSync(join(userData, 'logs', 'hive.log'), lines.join('\n') + '\n')
  return userData
}
const T = '2026-11-05T12:00:00.000Z [INFO] [sessions]'

describe("the tools-connected log line and its reader (lib.hiveToolsConnected, HI-2584)", () => {
  it('sessions.ts writes the line the helper reads', () => {
    const source = readFileSync(join(ROOT, 'src', 'main', 'sessions.ts'), 'utf8')
    expect(source).toContain("${userText(agentId)}'s Combwork tools connected")
  })

  it('reads the line as Combwork writes it, and as a build from before HI-2584 did, for that agent only', () => {
    expect(hiveToolsConnected(profile([`${T} ⁨a-1⁩'s Combwork tools connected 1200 ms after it became ready`]), 'a-1')).toBe(true)
    expect(hiveToolsConnected(profile([`${T} ⁨a-1⁩'s hive tools connected`]), 'a-1')).toBe(true)
    expect(hiveToolsConnected(profile([`${T} ⁨a-2⁩'s Combwork tools connected`]), 'a-1')).toBe(false)
    expect(hiveToolsConnected(profile([`${T} ⁨a-1⁩'s Combwork tools connected`, `${T} other`]), 'a-1', 1)).toBe(false)
  })

  it('no suite or harness reads the line with its own copy of the text', () => {
    const files = execFileSync('git', ['grep', '-l', '-i', 'tools connected', '--', 'tests/e2e', 'tests/scenarios', 'scripts'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
    const readers = files.filter((f) => !f.endsWith('.md') && f !== 'tests/e2e/lib.cjs' && /\.includes\([^)]*tools connected|\/[^/\n]*tools connected[^/\n]*\/[a-z]*\.test\(/i.test(readFileSync(join(ROOT, f), 'utf8')))
    expect(readers).toEqual([])
  })
})
