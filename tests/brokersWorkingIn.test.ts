// Windows' broker seen working in a held slot (HI-2467, systemBrokers.ts): an idle Windows Sandbox broker keeps the
// folder it was started in as its current folder, so Windows refuses to rename the slot and Combwork can't lend it. Combwork
// names it only on evidence read in one answer: a trusted broker path and a current folder in the slot. Anything else
// (a folder elsewhere, a path not a broker's, an unread folder, a process gone, a malformed answer) names nothing, and
// the caller says only that a process holds it. Idleness is asked afresh each time, unknown when it can't be told.
import { mkdirSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { brokersWorkingIn, folderInside, parseWorkingIn, type WorkingIn } from '../src/main/systemBrokers'

const ROOT = join(process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files', 'WindowsApps')
const BROKER = join(ROOT, 'MicrosoftWindows.WindowsSandbox_0.5.3.0_x64__cw5n1h2txyewy', 'WindowsSandboxServer.exe')
const dir = tempDir('cw-brokers-working-in-')
const SLOT = join(dir, 'slot-a')
const SIBLING = join(dir, 'slot-ab')
for (const d of [SLOT, join(SLOT, 'src'), SIBLING]) mkdirSync(d, { recursive: true })

const answer = (...processes: { pid?: number; path?: string; cwd: string }[]): WorkingIn => ({ complete: true, processes: processes.map((p, i) => ({ pid: p.pid ?? 100 + i, created: '133000000000000000', path: p.path ?? BROKER, cwd: p.cwd })) })
const none = async (): Promise<string[]> => []
const look = (a: WorkingIn | null, running: (names: readonly string[]) => Promise<readonly string[] | null> = none, extra: { stands?: Set<number>; standPath?: string } = {}) => brokersWorkingIn(a, SLOT, { inside: folderInside, running, ...extra })

describe('a broker working in a held slot (HI-2467)', () => {
  it('a trusted broker whose current folder is the slot, or inside it, is named, idle when nothing it serves runs', async () => {
    expect(await look(answer({ cwd: `${SLOT}\\` }))).toEqual({ name: 'WindowsSandboxServer', idle: true })
    expect(await look(answer({ cwd: join(SLOT, 'src') }))).toEqual({ name: 'WindowsSandboxServer', idle: true })
    expect(await look(answer({ cwd: SLOT.toUpperCase() }))).toEqual({ name: 'WindowsSandboxServer', idle: true })
  })

  it('a broker working elsewhere, another process in the slot holding it: nothing named', async () => {
    expect(await look(answer({ cwd: `${dir}\\` }), none)).toBeNull()
    expect(await look(answer({ cwd: SIBLING }), none)).toBeNull()
    expect(await look(answer({ path: 'C:\\Windows\\System32\\notepad.exe', cwd: SLOT }, { path: BROKER, cwd: 'C:\\' }))).toBeNull()
  })

  it('only a trusted path counts: a look-alike outside WindowsApps, an unread path or an unread folder name nothing', async () => {
    expect(await look(answer({ path: join(dir, 'MicrosoftWindows.WindowsSandbox_1_x64__x', 'WindowsSandboxServer.exe'), cwd: SLOT }))).toBeNull()
    expect(await look(answer({ path: '', cwd: SLOT }))).toBeNull()
    expect(await look(answer({ cwd: '' }))).toBeNull()
  })

  it("a test copy's stand-in counts only once the helper read its path, and is given the broker's", async () => {
    const extra = { stands: new Set([7]), standPath: BROKER }
    expect(await look(answer({ pid: 7, path: process.execPath, cwd: SLOT }), none, extra)).toEqual({ name: 'WindowsSandboxServer', idle: true })
    expect(await look(answer({ pid: 7, path: '', cwd: SLOT }), none, extra)).toBeNull()
    expect(await look(answer({ pid: 8, path: process.execPath, cwd: SLOT }), none, extra)).toBeNull()
  })

  it('idleness is asked each time: idle, then a Sandbox running, then not known', async () => {
    const a = answer({ cwd: SLOT })
    let now: string[] | null = []
    const running = async (names: readonly string[]): Promise<string[] | null> => (now ? names.filter((n) => now!.includes(n)) : null)
    expect(await look(a, running)).toEqual({ name: 'WindowsSandboxServer', idle: true })
    now = ['windowssandbox.exe']
    expect(await look(a, running)).toEqual({ name: 'WindowsSandboxServer', idle: false })
    now = null
    expect(await look(a, running)).toEqual({ name: 'WindowsSandboxServer', idle: null })
    expect(await look(a, () => Promise.reject(new Error('no helper')))).toEqual({ name: 'WindowsSandboxServer', idle: null })
  })

  it('an answer that leaves some out (over the bound, or one unread): the broker it saw is named, its idleness unknown; none seen, nothing named', async () => {
    let asked = 0
    const running = async (): Promise<string[]> => (asked++, [])
    const cut = { ...answer({ cwd: SLOT }), complete: false }
    expect(await look(cut, running)).toEqual({ name: 'WindowsSandboxServer', idle: null })
    expect(await look({ ...answer({ cwd: `${dir}\\` }), complete: false }, running)).toBeNull()
    expect(await look({ complete: false, processes: [] }, running)).toBeNull()
    // Through the parser as the helper's answer comes, too (HR1's probe).
    expect(await look(parseWorkingIn({ complete: false, processes: [{ id: '123:133000000000000000', path: BROKER, cwd: SLOT }] }, 32), running)).toEqual({ name: 'WindowsSandboxServer', idle: null })
    expect(asked).toBe(0)
  })

  it('a process gone or its id reused since (no longer in the answer), or no answer at all: nothing named', async () => {
    expect(await look(answer())).toBeNull()
    expect(await look(null)).toBeNull()
    expect(await look(parseWorkingIn('error: no snapshot', 32))).toBeNull()
  })

  it('a folder comparison that throws names nothing rather than failing the lend', async () => {
    expect(await brokersWorkingIn(answer({ cwd: SLOT }), SLOT, { inside: () => Promise.reject(new Error('x')), running: none })).toBeNull()
  })
})

describe("the helper's workingin answer is read strictly (HI-2467)", () => {
  const ok = { complete: false, processes: [{ id: '12:133', path: 'p', cwd: 'c' }] }
  it('a whole answer is kept, its completeness with it', () => {
    expect(parseWorkingIn(ok, 32)).toEqual({ complete: false, processes: [{ pid: 12, created: '133', path: 'p', cwd: 'c' }] })
    expect(parseWorkingIn({ complete: true, processes: [] }, 32)).toEqual({ complete: true, processes: [] })
  })
  it('anything malformed, cut short or past the bound is no answer', () => {
    const bad: unknown[] = [null, 'error: snapshot cut short', [], { processes: [] }, { complete: 'yes', processes: [] }, { complete: true }, { complete: true, processes: [{ id: '12', path: 'p', cwd: 'c' }] }, { complete: true, processes: [{ id: '0:1', path: 'p', cwd: 'c' }] }, { complete: true, processes: [{ id: '1:1', path: 3, cwd: 'c' }] }, { complete: true, processes: [{ id: '1:1', path: 'p' }] }, { complete: true, processes: [null] }, { complete: true, processes: Array.from({ length: 33 }, (_, i) => ({ id: `${i + 1}:1`, path: 'p', cwd: 'c' })) }]
    for (const b of bad) expect(parseWorkingIn(b, 32)).toBeNull()
  })
})
