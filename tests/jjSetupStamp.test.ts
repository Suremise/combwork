// HI-3122: a jj candidate's merge checks are ended as invalid when what they depend on in project.json changes (HI-2938's
// HR1 round 1 finding 3), and only then: the stamp is the setup command's (jjSetupStamp.ts), not the file's identity,
// which every save of project.json changes (an agent's new conversation records its lastSessionId). Proved first as the
// card asks: a project.json save between two of the runner's polls, with the stamp the checks are given.
import { renameSync, statSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { setupStampOf } from '../src/main/jjSetupStamp'
import { runCandidateChecks, type CandidateChecksDeps, type CandidateChecksInput } from '../src/main/workflow/jjCandidateChecks'
import type { JjCandidateFingerprint } from '../src/main/platform/jjCandidateStep'

/** A project folder with its project.json. */
function project(cfg: Record<string, unknown>): string {
  const p = join(tempDir('cw-setupstamp-'), 'p')
  mkdirSync(join(p, '.combwork'), { recursive: true })
  save(p, cfg)
  return p
}
/** A save as writeKeptJson makes one: a new file renamed over the old (a new file id, so the old stamp's identity moves). */
function save(p: string, cfg: Record<string, unknown>): void {
  const file = join(p, '.combwork', 'project.json')
  writeFileSync(`${file}.tmp`, JSON.stringify(cfg, null, 2))
  renameSync(`${file}.tmp`, file)
}
/** The stamp before HI-3122: project.json's identity (its id, size and time). */
const fileIdentity = (p: string): string => {
  const st = statSync(join(p, '.combwork', 'project.json'))
  return `${st.ino}:${st.size}:${st.mtimeMs}`
}

const C = (c: string): string => c.repeat(40)
const fp: JjCandidateFingerprint = { cycle: 1, submission: 3, revision: C('a'), base: C('b'), key: null, commit: C('a'), target: 'main', ruleset: 'r1', style: 'merge', strict: false, generation: 0, approval: 7 }
const input: CandidateChecksInput = { card: { key: 'AM-1', number: 1 }, fp, attempt: 'att0001', result: C('c'), expected: C('d'), checksKey: 'k1', names: ['typecheck'], commands: { typecheck: 'tsc' }, installAlways: false }

/**
 * The runner with one check held until `go` resolves, its validity as JjPlatform reads it: the stamp read before the run
 * the same now (`stamp`). Its lease given back with its job ended releases the check, as a real tree in a job would.
 */
function held(stamp: () => string) {
  const before = stamp()
  let release!: () => void
  const running = new Promise<void>((r) => (release = r))
  let started!: () => void
  const inCheck = new Promise<void>((r) => (started = r))
  const log: string[] = []
  let polls = 0
  let journal: unknown = null
  const deps: CandidateChecksDeps = {
    journal: { read: () => journal as never, write: async (j) => void (journal = structuredClone(j)) },
    leaseFreed: async () => true,
    lease: async () => ({ id: 'L1', folder: 'C:\\copy', spawn: (() => null) as never, give: async (why, end) => void (log.push(`give ${why}`), end && release()) }),
    runCheck: async (name) => {
      started()
      await running
      return { ok: true, output: '', command: name, run: `run-${name}` }
    },
    install: async () => ({ ok: true, output: '' }),
    bracket: async (_f, revision) => ({ end: async () => ({ counted: true, tested: revision }) }),
    valid: async () => (polls++, stamp() === before),
    checkRan: async () => undefined,
    stopped: () => false,
    watchMs: 10
  }
  return { out: runCandidateChecks(deps, input), inCheck, release, log, polls: () => polls }
}

describe('HI-3122: the setup stamp a jj candidate’s checks depend on', () => {
  it('a save of project.json that changes only other settings (an agent’s lastSessionId) keeps the stamp; the old file stamp moved', () => {
    const p = project({ worktreeSetup: 'npm ci', agents: [{ id: 'b1', name: 'B1' }] })
    const [stamp, file] = [setupStampOf(p), fileIdentity(p)]
    save(p, { worktreeSetup: 'npm ci', agents: [{ id: 'b1', name: 'B1', lastSessionId: 'f3b2c1d0-0000-4000-8000-000000000000' }] })
    expect(fileIdentity(p)).not.toBe(file)
    expect(setupStampOf(p)).toBe(stamp)
  })

  it('a changed setup command changes it; set, unset and missing are each their own', () => {
    const p = project({ worktreeSetup: 'npm ci' })
    const ci = setupStampOf(p)
    save(p, { worktreeSetup: 'npm install' })
    expect(setupStampOf(p)).not.toBe(ci)
    save(p, {})
    const none = setupStampOf(p)
    save(p, { worktreeSetup: '' })
    expect(setupStampOf(p)).toBe(none)
    save(p, { worktreeSetup: 'npm ci' })
    expect(setupStampOf(p)).toBe(ci)
  })

  it('the runner: a project.json save between two polls, the setup the same, leaves the check running to its green', async () => {
    const p = project({ worktreeSetup: 'npm ci', agents: [{ id: 'b1' }] })
    const r = held(() => setupStampOf(p))
    await r.inCheck
    save(p, { worktreeSetup: 'npm ci', agents: [{ id: 'b1', lastSessionId: 'new-conversation' }] })
    // Several of the runner's polls go by after the save (every 10 ms here): none ends it.
    const at = r.polls()
    await expect.poll(() => r.polls(), { timeout: 10_000 }).toBeGreaterThan(at + 3)
    expect(r.log).toEqual([])
    r.release()
    expect(await r.out).toEqual({ green: true, checks: ['typecheck'] })
    expect(r.log).toEqual(['give checksEnded'])
  })

  it('the runner, as it was: the file’s identity as the stamp, the same save ends the check as invalid (the card’s repro)', async () => {
    const p = project({ worktreeSetup: 'npm ci', agents: [{ id: 'b1' }] })
    const r = held(() => fileIdentity(p))
    await r.inCheck
    save(p, { worktreeSetup: 'npm ci', agents: [{ id: 'b1', lastSessionId: 'new-conversation' }] })
    expect(await r.out).toEqual({ invalid: true })
    expect(r.log).toEqual(['give invalid'])
  })

  it("HR3's round 1: a project.json caught mid-save never makes main wait: a stamp of its own, not kept, never a command's", () => {
    const p = project({ worktreeSetup: 'npm ci' })
    const good = setupStampOf(p)
    writeFileSync(join(p, '.combwork', 'project.json'), '{')
    // The kept-file reader's settling waits on Atomics.wait (up to about a second, on main's thread): never here.
    const wait = vi.spyOn(Atomics, 'wait')
    try {
      const partial = setupStampOf(p)
      expect(wait).not.toHaveBeenCalled()
      expect(partial).toMatch(/^unread:/)
      expect(partial).not.toBe(good)
      // Not kept: read again, and again its own until the file parses.
      expect(setupStampOf(p)).toMatch(/^unread:/)
    } finally {
      wait.mockRestore()
    }
    save(p, { worktreeSetup: 'npm ci' })
    expect(setupStampOf(p)).toBe(good)
  })

  it('the runner: project.json unreadable mid-check (a partial save): it fails closed, invalid', async () => {
    const p = project({ worktreeSetup: 'npm ci' })
    const r = held(() => setupStampOf(p))
    await r.inCheck
    writeFileSync(join(p, '.combwork', 'project.json'), '{"worktreeSetup": "npm')
    expect(await r.out).toEqual({ invalid: true })
  })

  it('the runner: the setup command changed mid-check: invalid, its job ended', async () => {
    const p = project({ worktreeSetup: 'npm ci' })
    const r = held(() => setupStampOf(p))
    await r.inCheck
    save(p, { worktreeSetup: 'npm ci --ignore-scripts' })
    expect(await r.out).toEqual({ invalid: true })
    expect(r.log).toEqual(['give invalid'])
  })
})
