// The world J9b's jj card tests share (HI-2868, HI-2882): a jj project on the real jj (both Git-backed modes), its
// workspace database, two slots made by J9a's port on its bindings, and a Workflow composed with jj's deps (J9b1's, and
// J9b2's records on the database's own tables and the publish worker's code run here). Behind the guard: compile.ts'
// seam on for each test, off after.
import { execFileSync } from 'child_process'
import { cpSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, expect } from 'vitest'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { FactStore } from '../src/main/workflow/factStore'
import { Workflow } from '../src/main/workflow/runtime'
import { fileSlotConn } from '../src/main/slots'
import { gitHistory } from '../src/main/platform/gitHistory'
import { jjContextOf } from '../src/main/platform/jjDetect'
import type { JjCardDeps, JjPinRecord } from '../src/main/platform/jjPlatform'
import type { JjBundle, JjIntegrationPoint } from '../src/main/platform/jjIntegration'
import type { SqlDb } from '../src/main/platform/jjObligations'
import { boardPrepStore } from '../src/main/platform/jjSlotPrep'
import type { WorkspaceIdentity } from '../src/main/platform/workspacePort'
import { commitPublishOff } from '../src/main/jjPublish'
import { setJjCardsReadyForTests } from '../src/shared/workflow/compile'
import { preset } from '../src/shared/workflow/options'
import { agentOf } from '../src/shared/workflow/facts'
import { admitted } from './admitted'
import { harness } from './jjWorkspaceHarness'
import { tempDir } from './tempDir'
import { B1, moved } from './workflow/harness'

export const closers: (() => void)[] = []
beforeEach(() => setJjCardsReadyForTests(true))
afterEach(() => {
  setJjCardsReadyForTests(false)
  for (const c of closers.splice(0)) c()
})

export const opts = { ...preset('jj', 'pair', { quick: [], tests: [], target: 'main' }), preChecks: [], mergeChecks: [] }
export const OPEN = (slot: string) => ({ held: true, print: `lease:open:${slot}:-:-:-` })
export const ENDED = (slot: string) => ({ held: false, print: `lease:ended:${slot}:-:-:-` })
export const BUSY = (slot: string) => ({ held: false, print: `lease:open:${slot}:op-1:-:-` })

/** A jj project with a workspace database, two slots, J9a's port on its bindings, and a Workflow composed with jj's deps. */
export async function world(colocated: boolean, o: { hook?: (point: JjIntegrationPoint) => Promise<void> | void } = {}) {
  const h = harness()
  const { repo, root } = h.repo(`cards${colocated ? 'c' : 'n'}`, colocated)
  const home = tempDir('jjcards-')
  const dismiss = admitted(home)
  workspaceDb(home)
  const store = FactStore.open(boardFile(home), { project: 'project', key: 'AM', projectId: () => 'p-jj' })
  const conn = fileSlotConn(boardFile(home))
  closers.push(() => {
    store.close()
    conn.close()
    closeBoard(home)
    dismiss()
  })
  // The bindings' store, with a seam: `onPointer` runs once at the next pointer read (the late pin's, between its checks).
  const bindings = boardPrepStore(conn)
  let onPointer: (() => void) | null = null
  const prepWithSeam = { ...bindings, pointer: (s: string, ws: string) => { const f = onPointer; onPointer = null; f?.(); return bindings.pointer(s, ws) } }
  const port = h.portWith({ prep: () => prepWithSeam, contains: (s, t, c, at) => gitHistory.contains(s, t, c, at) })
  const main = (): string => h.id(repo, 'main')
  const slots: Record<string, { folder: string; identity: WorkspaceIdentity; lease: string }> = {}
  for (const [name, lease] of [['slot-a', 'L1'], ['slot-b', 'L2']] as const) {
    const folder = join(root, name)
    expect((await port.create(repo, folder, main())).ok).toBe(true)
    slots[name] = { folder, identity: (await port.identity!(folder))!, lease }
  }
  /** The slot each builder is lent (B1: slot-a, B2: slot-b). */
  const slotOf = (builder: string) => slots[builder === 'B2' ? 'slot-b' : 'slot-a']
  /** Each lease's hold as the app's slotHold answers it: open and held, or ended or busy (not held), with what was read. */
  const holds = new Map<string, { held: boolean; print: string }>([['L1', OPEN('slot-a')], ['L2', OPEN('slot-b')]])
  const pins = new Map<string, JjPinRecord>()
  /** J5's bundle journal, by card and cycle. */
  const bundles = new Map<string, JjBundle[]>()
  const gitOn = (gitDir: string, args: readonly string[]) => {
    try {
      const buf = execFileSync('git', ['--git-dir', gitDir, ...args], { env: h.env, windowsHide: true, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
      return Promise.resolve({ ok: true, out: buf.toString('utf8'), err: '', buf, code: 0 })
    } catch (e) {
      const x = e as { stdout?: Buffer; stderr?: Buffer; status?: number }
      return Promise.resolve({ ok: false, out: x.stdout?.toString('utf8') ?? '', err: x.stderr?.toString('utf8') ?? String(e), buf: x.stdout ?? Buffer.alloc(0), code: x.status ?? 1 })
    }
  }
  const ctx = await jjContextOf(repo, h.runner)
  if (!('jj' in ctx)) throw new Error('no jj context')
  const deps: JjCardDeps = {
    runner: h.runner,
    port: () => port,
    lock: () => (fn) => fn(),
    git: gitOn,
    history: gitHistory,
    integration: async () => ({ runner: h.runner, view: { jjRepo: ctx.jj.jjRepo, store: ctx.jj.store, colocated: ctx.jj.colocated }, folder: repo, git: (args) => gitOn(ctx.jj.store, args), gitContains: (s, t, c, at) => gitHistory.contains(s, t, c, at), lock: (fn) => fn(), journal: (card, cycle, b) => void bundles.set(`${card}:${cycle}`, structuredClone(b)), ...(o.hook ? { hook: o.hook } : {}) }),
    records: {
      projectId: () => 'p-jj',
      dbFile: () => boardFile(home),
      read: (fn) => conn.read((db) => fn(db as unknown as SqlDb)),
      write: async (fn) => void (await conn.write((db) => fn(db as unknown as SqlDb))),
      bundles: (card, cycle) => structuredClone(bundles.get(`${card}:${cycle}`) ?? []),
      publish: (req) => commitPublishOff(req)
    },
    slotHold: (lease) => holds.get(lease) ?? null,
    pins: { read: (ref) => pins.get(ref) ?? null, write: async (ref, rec) => void pins.set(ref, rec) }
  }
  const make = (s: FactStore): Workflow =>
    new Workflow({
      store: s,
      project: repo,
      projectKey: 'AM',
      options: () => opts,
      slotFor: async (_card, builder) => ({ slot: builder === 'B2' ? 'slot-b' : 'slot-a', folder: slotOf(builder).folder, lease: slotOf(builder).lease, fresh: true }),
      slotUnused: async () => undefined,
      autoRun: false,
      reconcileActs: true,
      jj: deps,
      effects: { wake: () => undefined, notify: () => undefined }
    })
  const wf = make(store)
  /** The card's slot prepared as the pool would (J9a's owned write), for its Started line and base. */
  const prepare = async (card: number, builder = 'B1') => {
    const s = wf.state(card)
    const sl = slotOf(builder)
    return port.prepare(sl.folder, s.started!.line!, s.started!.base!, { identity: sl.identity, fence: { still: () => true }, lease: sl.lease, target: 'main' })
  }
  /** An agent's commit in a slot: a file written, `jj commit`; the new commit's id. */
  const commitIn = (folder: string, file: string, ws: string): string => {
    writeFileSync(join(folder, file), `${file}\n`)
    h.jj(folder, 'commit', '-m', file)
    return h.id(folder, `${ws}@-`)
  }
  /** The card's pending pin actions run, as the actions worker would. */
  const runPins = async (card: number) => {
    for (const a of store.pendingActions().filter((x) => x.kind === 'pin' && x.card === card)) {
      await wf.platformOf(wf.store.card(card)).perform('pin', a.payload)
    }
  }
  const refAt = (ref: string): string | null => {
    try {
      return execFileSync('git', ['--git-dir', ctx.jj.store, 'rev-parse', '--verify', '--quiet', ref], { env: h.env, encoding: 'utf8' }).trim()
    } catch {
      return null
    }
  }
  /** A slot's `.jj` replaced by a byte-for-byte copy at the same path: the same names and store, another generation. */
  const replaceJj = (folder: string): void => {
    renameSync(join(folder, '.jj'), join(folder, '.jj-old'))
    cpSync(join(folder, '.jj-old'), join(folder, '.jj'), { recursive: true })
    rmSync(join(folder, '.jj-old'), { recursive: true, force: true })
  }
  return { h, repo, root, home, store, conn, port, wf, bundles, replaceJj, atPointer: (f: () => void) => void (onPointer = f), slots, slotOf, holds, pins, deps, main, prepare, commitIn, runPins, refAt, ctx: ctx.jj, another: () => make(FactStore.open(boardFile(home), { project: 'project', key: 'AM', projectId: () => 'p-jj' })) }
}
export type World = Awaited<ReturnType<typeof world>>

/** A card started by `builder`, its slot prepared. */
export async function started(w: World, title: string, builder = B1): Promise<ReturnType<Workflow['createCard']>> {
  const card = w.wf.createCard({ title })
  moved(await w.wf.start(card.key, builder))
  expect(await w.prepare(card.id, agentOf(builder) ?? 'B1')).toEqual({ ok: true, err: '' })
  return card
}

