// The on/off switch's tooltip in the Dialects view (HI-2524): each kind of file names the layer its texts fall back to.
import { describe, expect, it } from 'vitest'
import { tr } from '../src/shared/i18n'
import { dialectOnTip } from '../src/renderer/src/components/dialectOnTip'

const names: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', api: 'API (scripts)' }
const folderName = (f: string): string => names[f] ?? f
const tip = (kind: 'workspace' | 'cli' | 'api' | 'model' | 'copy', folder: string | null): string => dialectOnTip({ kind, folder }, folderName, tr)
const LAUNCH = " Changes apply at each agent's next launch."

describe("a dialect file's on/off tip (HI-2524)", () => {
  it('a model file or test copy falls back to its CLI file, by its shown name', () => {
    expect(tip('model', 'claude-code')).toBe(`On: its texts apply. Off: it falls back to the Claude Code file.${LAUNCH}`)
    expect(tip('copy', 'codex')).toBe(`On: its texts apply. Off: it falls back to the Codex file.${LAUNCH}`)
  })
  it("a CLI's or the API's file falls back to the Workspace file", () => {
    expect(tip('cli', 'codex')).toBe(`On: its texts apply. Off: it falls back to the Workspace file.${LAUNCH}`)
    expect(tip('api', 'api')).toBe(`On: its texts apply. Off: it falls back to the Workspace file.${LAUNCH}`)
  })
  it("the Workspace file falls back to Combwork's Default", () => {
    expect(tip('workspace', null)).toBe(`On: its texts apply. Off: it falls back to Combwork's Default.${LAUNCH}`)
  })
})
