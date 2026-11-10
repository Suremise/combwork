// A platform whose history port has no own-work proof doesn't offer a card's move to another target (HI-2821; SPEC
// §16.3.6's rule 6): the check refuses it as one Combwork can't check, naming why, before reading any line.
import { describe, expect, it, vi } from 'vitest'

const reads = vi.hoisted(() => ({ lineHead: 0 }))
vi.mock('../src/main/platform/historyPorts', async (original) => {
  const m = await original<typeof import('../src/main/platform/historyPorts')>()
  return {
    ...m,
    historyOf: (platform: Parameters<typeof m.historyOf>[0]) => {
      const h = m.historyOf(platform)
      if (!h) return h
      const { ownWork: _none, ...rest } = h
      return {
        ...rest,
        lineHead: async (repo: string, line: string) => {
          reads.lineHead++
          return h.lineHead(repo, line)
        }
      }
    }
  }
})

const { checkCardMove } = await import('../src/main/workflow/retargetCard')

describe('a platform without an own-work proof (HI-2821)', () => {
  it("refuses the move as one it can't check, reading nothing", async () => {
    const s = { started: { target: '1.2.0', line: 'cw/AM/AM-1-x' }, stage: 'active', entries: [], lines: [], latest: null, lastSeq: 1 }
    const wf = { state: () => s, ownLine: () => true, rulesetOf: () => ({ options: { platform: 'git' } }) }
    const card = { id: 1, key: 'AM-1', lane: null }
    const r = await checkCardMove(wf as never, 'Z:\\nowhere', card as never, 'main')
    expect(r).toEqual({ ok: false, why: 'cantCheck', detail: "git has no proof that a line's work is its own" })
    expect(reads.lineHead).toBe(0)
  })
})
