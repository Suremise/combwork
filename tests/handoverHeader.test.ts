import { describe, expect, it } from 'vitest'
import { handoverHeader, handoverSession } from '../src/shared/combworkGuidance'

const at = new Date('2026-10-01T03:22:42.123Z')
const pad = (n: number): string => String(n).padStart(2, '0')
const local = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`

describe('handover header', () => {
  it('names the project, author, session and date (machine time, UTC in brackets)', () => {
    expect(handoverHeader('Review fixes', 'demo', { author: 'Codex (Codex)', session: '01a0f24c-0627-7111-986a-22f2390ddfdb' }, at)).toBe(
      `# Review fixes\n\n- **Project:** demo\n- **Author:** Codex (Codex)\n- **Session:** 01a0f24c-0627-7111-986a-22f2390ddfdb\n- **Date:** ${local} (2026-10-01T03:22:42Z)\n\n`
    )
  })

  it('leaves out who wrote it when no agent did', () => {
    expect(handoverHeader('Plan', '', null, at)).toBe(`# Plan\n\n- **Project:** (workspace)\n- **Date:** ${local} (2026-10-01T03:22:42Z)\n\n`)
  })

  it('reads the session back from a handover', () => {
    const text = handoverHeader('Plan', 'demo', { author: 'Claude (Claude Code)', session: 'a0292106-ba74-415d-b192-30a8bc30f6c8' }, at) + 'Goal: …\n'
    expect(handoverSession(text)).toBe('a0292106-ba74-415d-b192-30a8bc30f6c8')
    expect(handoverSession(text.replace(/\n/g, '\r\n'))).toBe('a0292106-ba74-415d-b192-30a8bc30f6c8')
    expect(handoverSession('# Old\n\n- **Project:** demo\n- **Date:** 2026-09-29T10:00:00.000Z\n')).toBeNull()
  })
})
