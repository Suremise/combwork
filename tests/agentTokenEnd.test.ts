// An agent launch's token ending (HI-2416): when its agent's launch ends, or a new launch replaces it, the token stops
// working and Hive's listeners are told which launch it was, once, so what it opened (the Agent API's event streams,
// servers.ts endLaunchStreams) ends with it. An end for an older launch, after a restart, changes and tells nothing.
import { mkdirSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-agent-token-end-')
const profile = join(base, 'profile')
mkdirSync(profile, { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => profile

const { agentForToken, endAgentToken, newAgentToken, onAgentTokenEnded } = await import('../src/main/agentTokens')
type Ended = Parameters<Parameters<typeof onAgentTokenEnded>[0]>[0]

const listeners: (() => void)[] = []
afterAll(() => listeners.forEach((off) => off()))

const id = (agentId: string) => ({ workspace: join(base, 'ws'), projectPath: join(base, 'ws', 'alpha'), agentId })
function told(): Ended[] {
  const got: Ended[] = []
  listeners.push(onAgentTokenEnded((e) => got.push(e)))
  return got
}

describe("an agent launch's token ending (HI-2416)", () => {
  it('the launch ending: its token stops working and the listeners are told that launch, once', async () => {
    const got = told()
    const token = await newAgentToken(id('a1'), 'run-1')
    expect(got).toEqual([])
    endAgentToken(id('a1').projectPath, 'a1', 'run-1')
    expect(agentForToken(token)).toBeNull()
    expect(got).toEqual([{ ...id('a1'), runId: 'run-1' }])
    // Ended again (both end paths can run): nothing more.
    endAgentToken(id('a1').projectPath, 'a1', 'run-1')
    expect(got).toHaveLength(1)
  })

  it("a new launch replacing it: the old launch is told ended; the old launch's end, coming late, leaves the new one's token", async () => {
    const got = told()
    const first = await newAgentToken(id('a2'), 'run-a')
    const second = await newAgentToken(id('a2'), 'run-b')
    expect(agentForToken(first)).toBeNull()
    expect(got).toEqual([{ ...id('a2'), runId: 'run-a' }])
    endAgentToken(id('a2').projectPath.toUpperCase(), 'a2', 'run-a')
    expect(agentForToken(second)).toMatchObject({ agentId: 'a2', runId: 'run-b' })
    expect(got).toHaveLength(1)
  })

  it("a listener that throws doesn't stop the token ending, nor the others being told", async () => {
    listeners.push(
      onAgentTokenEnded(() => {
        throw new Error('a listener failed')
      })
    )
    const got = told()
    const token = await newAgentToken(id('a3'), 'run-x')
    expect(() => endAgentToken(id('a3').projectPath, 'a3', 'run-x')).not.toThrow()
    expect(agentForToken(token)).toBeNull()
    expect(got.filter((e) => e.agentId === 'a3')).toEqual([{ ...id('a3'), runId: 'run-x' }])
  })

  it('unsubscribed: not told', async () => {
    const got: Ended[] = []
    const off = onAgentTokenEnded((e) => got.push(e))
    off()
    await newAgentToken(id('a4'), 'run-y')
    endAgentToken(id('a4').projectPath, 'a4', 'run-y')
    expect(got).toEqual([])
  })
})
