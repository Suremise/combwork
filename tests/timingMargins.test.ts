// HI-3375 (timing-margins audit, 18 Nov: finding tools and starting agents): the bounds that decide "not installed" or
// "start without it". A CLI's, git's or jj's first start under antivirus on a slow disk takes tens of seconds, which a
// user can't diagnose, so each bound is a bound for a hung step, never a performance budget. Their defaults, ranges and
// constants as the card sets them; a user's own override of a setting stays (Settings → Advanced keeps it).
import { describe, expect, it } from 'vitest'
import { advancedDef, CLI_PROBE_SECONDS, RESTART_READY_SECONDS, SERVER_CHECK_INFER_SECONDS } from '../src/shared/advanced'
import { REQUEST_MAX_AGE_MS } from '../src/shared/restartResume'
import { JJ_DEFAULTS } from '../src/main/platform/jjRunner'
import { WHERE_MS } from '../src/main/providers/common'
import { LAUNCHER_SOURCE } from '../src/main/providers/opencode/launcher'

describe('the timing margins of finding tools and starting agents (HI-3375)', () => {
  it('two new settings: the CLIs’ version probe (row 1) and Check Server’s test request (row 17)', () => {
    expect(advancedDef(CLI_PROBE_SECONDS)).toMatchObject({ id: 'cw.cli.probeSeconds', group: 'cw', kind: 'number', default: 60, min: 10, max: 300, unit: 's' })
    expect(advancedDef(SERVER_CHECK_INFER_SECONDS)).toMatchObject({ id: 'cw.server.checkInferSeconds', group: 'cw', kind: 'number', default: 600, min: 30, max: 3600, unit: 's' })
  })

  it('the existing settings’ new defaults and ranges (rows 5, 6, 7, 10, 14, 15)', () => {
    expect(advancedDef('opencode.server.readySeconds')).toMatchObject({ default: 120, min: 5, max: 300 })
    expect(advancedDef('codex.promptInput.timeoutSeconds')).toMatchObject({ default: 60, min: 2, max: 300 })
    expect(advancedDef('codex.mcp.startupTimeoutSeconds')).toMatchObject({ default: 30, min: 5, max: 300 })
    expect(advancedDef(RESTART_READY_SECONDS)).toMatchObject({ default: 300, min: 10, max: 1800 })
    expect(advancedDef('claude-code.accounts.statusSeconds')).toMatchObject({ default: 30, min: 3, max: 120 })
    expect(advancedDef('codex.accounts.statusSeconds')).toMatchObject({ default: 30, min: 5, max: 120 })
    expect(advancedDef('cw.mcpCatalog.probeSeconds')).toMatchObject({ default: 15, min: 1, max: 60 })
  })

  // HR1's round 1: the launcher's own fallback (CW_OC_READY_MS missing or bad) follows the setting's default, never drifts
  // from it; its post to Combwork waits past the start step's 20 s (row 8).
  it("OpenCode's launcher: its ready fallback is the setting's default (row 5), its post 30 s (row 8)", () => {
    const fallback = /readyMs < 1000\) readyMs = (\d+);/.exec(LAUNCHER_SOURCE)?.[1]
    expect(Number(fallback)).toBe(Number(advancedDef('opencode.server.readySeconds')!.default) * 1000)
    expect(LAUNCHER_SOURCE).toContain('r.Timeout = 30000; r.ReadWriteTimeout = 30000;')
  })

  it('the constants: where.exe 20 s (row 2), jj --version 30 s (row 4), an installer’s restart request 10 min (row 11)', () => {
    expect(WHERE_MS).toBe(20_000)
    expect(JJ_DEFAULTS.versionTimeout).toBe(30_000)
    expect(REQUEST_MAX_AGE_MS).toBe(10 * 60_000)
  })
})
