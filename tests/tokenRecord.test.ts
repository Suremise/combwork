// The token record (HIVE_TEST_TOKEN_LOG, HI-2262, HR1's rounds 1 and 2): a test copy of Hive appends each hook, agent
// and Assistant token where it makes it, before it keeps, writes or returns it, so the scenario harness's leak check
// knows every token a session could have printed, however soon its launch ended. A record asked for that can't be
// written issues nothing; without the variable, or in a copy that takes no test seams, nothing is recorded. The harness
// scores from that record, and a missing or malformed one fails the run instead of scoring with tokens left out.
import { createRequire } from 'module'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-token-record-')
const profile = join(base, 'profile')
;(electron.app as unknown as { getPath: () => string }).getPath = () => profile

const { endHookToken, hookAuthFile, hookTokenMatches, newHookToken } = await import('../src/main/hookTokens')
const { agentForToken, agentToken, agentTokenFile, newAgentToken } = await import('../src/main/agentTokens')
const { assistantTokenFile, isCurrentToken, newAssistantToken } = await import('../src/main/assistantControl')
const { recordTestToken } = await import('../src/main/testQuiet')

const require = createRequire(import.meta.url)
const { knownTokens, retainedObserved, tokenSightings } = require('./scenarios/harness.cjs') as {
  knownTokens: (file: string, apiToken: string) => { kind: string; token: string }[]
  retainedObserved: (observed: { tools: { name: string; input: string; result: string }[]; finalReply?: string }, tokens: string[]) => { tools: { result: string }[]; finalReply?: string }
  tokenSightings: (known: { kind: string; token: string }[], seen: { tools?: { name: string; result: string }[] }) => { kind: string; in: string; at: number; name?: string; excerpt: string }[]
}

const saved = { log: process.env.HIVE_TEST_TOKEN_LOG, quiet: process.env.HIVE_TEST_QUIET }
afterEach(() => {
  for (const [k, v] of [['HIVE_TEST_TOKEN_LOG', saved.log], ['HIVE_TEST_QUIET', saved.quiet]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  ;(electron.app as { isPackaged: boolean }).isPackaged = false
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

let n = 0
/** A new, empty record file of its own. */
function newRecord(): string {
  const file = join(base, `tokens-${++n}.jsonl`)
  writeFileSync(file, '')
  return file
}
const lines = (file: string): { kind: string; token: string }[] => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const ws = join(base, 'ws')
const id = (agentId: string) => ({ workspace: ws, projectPath: join(ws, 'alpha'), agentId })

describe('a test copy records each token it issues (HIVE_TEST_TOKEN_LOG)', () => {
  it('a hook, an agent and an Assistant token are each in the record, as issued', async () => {
    const file = newRecord()
    process.env.HIVE_TEST_TOKEN_LOG = file
    const hook = await newHookToken('rec-hook')
    const agent = await newAgentToken(id('a-rec'), 'run-rec')
    await newAssistantToken(ws)
    const assistant = JSON.parse(readFileSync(assistantTokenFile(ws), 'utf8')).token
    expect(lines(file)).toEqual([{ kind: 'hook', token: hook.token }, { kind: 'agent', token: agent }, { kind: 'assistant', token: assistant }])
    endHookToken('rec-hook')
  })

  it('a record that cannot be written issues nothing: no token kept, no file written, nothing returned', async () => {
    // A folder where the record's file should be: appending to it fails.
    const blocked = join(base, 'blocked.jsonl')
    mkdirSync(blocked, { recursive: true })
    process.env.HIVE_TEST_TOKEN_LOG = blocked
    await expect(newHookToken('rec-fails')).rejects.toThrow(/HIVE_TEST_TOKEN_LOG couldn't be written .*no hook token issued/)
    expect(existsSync(hookAuthFile('rec-fails'))).toBe(false)
    expect(hookTokenMatches('rec-fails', 'Bearer x')).toBe(false)

    const before = agentToken(join(ws, 'alpha'), 'a-fails')
    await expect(newAgentToken(id('a-fails'), 'run-fails')).rejects.toThrow(/no agent token issued/)
    expect(agentToken(join(ws, 'alpha'), 'a-fails')).toBe(before)
    expect(existsSync(agentTokenFile(join(ws, 'alpha'), 'a-fails'))).toBe(false)

    const ws2 = join(base, 'ws-fails')
    await expect(newAssistantToken(ws2)).rejects.toThrow(/no assistant token issued/)
    expect(existsSync(assistantTokenFile(ws2))).toBe(false)
    // The error names no token.
    await newHookToken('rec-fails').catch((e: Error) => expect(e.message).not.toMatch(/[0-9a-f]{32}/))
  })

  it('an earlier Assistant token stays the current one when a new one fails to be recorded', async () => {
    const ws3 = join(base, 'ws-keep')
    process.env.HIVE_TEST_TOKEN_LOG = newRecord()
    await newAssistantToken(ws3)
    const first = JSON.parse(readFileSync(assistantTokenFile(ws3), 'utf8')).token
    const blocked = join(base, 'blocked-2.jsonl')
    mkdirSync(blocked, { recursive: true })
    process.env.HIVE_TEST_TOKEN_LOG = blocked
    await expect(newAssistantToken(ws3)).rejects.toThrow(/no assistant token issued/)
    expect(isCurrentToken(ws3, first)).toBe(true)
  })

  it('records nothing without the variable, or in a packaged copy that takes no test seams', async () => {
    delete process.env.HIVE_TEST_TOKEN_LOG
    const agent = await newAgentToken(id('a-off'), 'run-off')
    expect(agentForToken(agent)?.agentId).toBe('a-off')
    // Packaged and not quiet (the installed app): the variable is ignored, the token issued as normal.
    const file = newRecord()
    process.env.HIVE_TEST_TOKEN_LOG = file
    delete process.env.HIVE_TEST_QUIET
    ;(electron.app as { isPackaged: boolean }).isPackaged = true
    const hook = await newHookToken('rec-packaged')
    expect(hookTokenMatches('rec-packaged', `Bearer ${hook.token}`)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('')
    // A blocked path is never touched there either.
    const blocked = join(base, 'blocked-3.jsonl')
    mkdirSync(blocked, { recursive: true })
    process.env.HIVE_TEST_TOKEN_LOG = blocked
    expect(() => recordTestToken('hook', 'f'.repeat(48))).not.toThrow()
    endHookToken('rec-packaged')
  })
})

describe('the harness scores from the record', () => {
  const apiToken = 'e'.repeat(64)

  it('a hook token issued, printed and its launch gone before anything looked is found and masked', async () => {
    const file = newRecord()
    process.env.HIVE_TEST_TOKEN_LOG = file
    // Issued by the real issuer, its launch then ended at once: its private folder is gone, nothing ever watched it.
    const { token, dir } = await newHookToken('rec-short')
    endHookToken('rec-short')
    rmSync(dir, { recursive: true, force: true })
    expect(existsSync(dir)).toBe(false)
    const known = knownTokens(file, apiToken)
    expect(known).toEqual([{ kind: 'workspace', token: apiToken }, { kind: 'hook', token }])
    const printed = `CW_HOOK_TOKEN=${token}\nCW_PROJECT=alpha`
    expect(tokenSightings(known, { tools: [{ name: 'Bash', result: printed }] })).toEqual([{ kind: 'hook', in: 'tool', at: 0, name: 'Bash', excerpt: 'CW_HOOK_TOKEN=<hook token> CW_PROJECT=alpha' }])
    const kept = JSON.stringify(retainedObserved({ tools: [{ name: 'Bash', input: 'env', result: printed }], finalReply: `It was ${token}.` }, known.map((t) => t.token)))
    expect(kept).not.toContain(token)
    expect(kept).toContain('CW_HOOK_TOKEN=<token>')
  })

  it('a missing, unreadable or malformed record fails the scoring rather than leaving tokens out', () => {
    expect(() => knownTokens(join(base, 'never-written.jsonl'), apiToken)).toThrow(/token record .* can't be read .*can't be scored/)
    const folder = join(base, 'a-folder.jsonl')
    mkdirSync(folder, { recursive: true })
    expect(() => knownTokens(folder, apiToken)).toThrow(/can't be read/)
    const bad = (text: string) => {
      const f = newRecord()
      writeFileSync(f, text)
      return () => knownTokens(f, apiToken)
    }
    const hook = '1a'.repeat(24)
    expect(bad(`{"kind":"hook","token":"${hook}"}\nnot json\n`)).toThrow(/malformed line 2/)
    expect(bad(`{"kind":"other","token":"${hook}"}\n`)).toThrow(/malformed line 1/)
    expect(bad(`{"kind":"hook","token":"short"}\n`)).toThrow(/malformed line 1/)
    expect(bad(`{"kind":"hook"}\n`)).toThrow(/malformed line 1/)
    // An empty record is a run that issued none: just the workspace's.
    expect(knownTokens(newRecord(), apiToken)).toEqual([{ kind: 'workspace', token: apiToken }])
    // Each once, in the order issued.
    expect(bad(`{"kind":"hook","token":"${hook}"}\n{"kind":"hook","token":"${hook}"}\n`)()).toEqual([{ kind: 'workspace', token: apiToken }, { kind: 'hook', token: hook }])
  })
})
