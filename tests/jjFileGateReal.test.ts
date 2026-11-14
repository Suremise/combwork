// Combwork's readers of the files a jj write replaces, against Combwork's own jj writes, on the real jj (HI-2918,
// design HI-2918/s14): for each reader class, two loops of it run while 27 gated writes go on in a slot and the project
// (`commit` and `new main` in the slot rewrite its working copy's files; `bookmark set main` from the project exports to
// the Git store). None may fail, none may warn that its export failed, Git's main must equal jj's after each move (colocated), and
// the slot is never left stale; in both Git-backed modes. HI2918_GATE_OFF=1 runs the same with the gate passed through
// (the before-numbers: the card's evidence), never in a normal run. Skipped without the fetched jj (npm run jj:fetch).
import { execFile } from 'child_process'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { TESTED_JJ } from '../src/shared/jjTool'
import { jjFileGate, type Grant } from '../src/main/platform/jjFileGate'
import { storeGitGated } from '../src/main/platform/jjRunner'
import { checkoutOf } from '../src/main/platform/jjWorkspacePort'
import { gitState, readCheckout } from '../src/main/platform/jjView'
import { gitBranches } from '../src/main/platform/jjViews'
import { refFromFiles } from '../src/main/platform/jjPublishTail'
import { boundaryOf } from '../src/main/platform/repoBoundary'
import type { RunResult } from '../src/main/platform/repoContext'
import { harness, jjExe } from './jjWorkspaceHarness'

const OFF = process.env.HI2918_GATE_OFF === '1'
if (OFF) {
  // The gate passed through: what the readers did before it (the card's before-numbers only).
  vi.spyOn(jjFileGate, 'read').mockImplementation(async (_k, fn) => fn())
  vi.spyOn(jjFileGate, 'readSync').mockImplementation((_k, fn) => fn())
  vi.spyOn(jjFileGate, 'acquire').mockImplementation(async (keys, mode) => ({ keys, mode, release: () => undefined }) as Grant)
  vi.spyOn(jjFileGate, 'recheck').mockImplementation(async (_g, fn) => fn())
}

const WRITES = 9 // rounds of three writes: 27

/** A world: a project, its store, and a slot made from it. */
async function world(colocated: boolean) {
  const h = harness()
  const { repo, root, base } = h.repo('gate', colocated)
  const slot = join(root, 'slot-a')
  expect((await h.port.create(repo, slot, base)).ok).toBe(true)
  const b = await boundaryOf(repo)
  const store = 'colocated' in b ? b.colocated.store : 'jj' in b ? b.jj.store : ''
  const jjRepo = 'jj' in b ? b.jj.jjRepo : join(repo, '.jj', 'repo')
  expect(store).not.toBe('')
  const gitAsync = (args: string[]): Promise<RunResult> =>
    new Promise((res) => execFile('git', args, { cwd: repo, env: h.env, windowsHide: true, encoding: 'utf8' }, (e, out, err) => res({ ok: !e, out: out ?? '', err: err ?? '', buf: Buffer.from(out ?? ''), code: e ? 1 : 0 })))
  return { h, repo, slot, store, jjRepo, gitAsync }
}

type World = Awaited<ReturnType<typeof world>>

/** The reader classes (s14 §2): each one call of the reader. */
const READERS: { name: string; colocatedOnly?: true; read: (w: World) => Promise<unknown> }[] = [
  { name: 'checkoutOf (async, the working copy)', read: (w) => checkoutOf(w.slot) },
  { name: 'readCheckout (sync, the working copy)', read: async (w) => readCheckout(join(w.slot, '.jj')) },
  { name: 'gitBranches (async, the store)', read: (w) => gitBranches(w.store) },
  { name: 'gitState (sync, the store)', colocatedOnly: true, read: async (w) => gitState(w.store, w.store) },
  { name: 'refFromFiles (sync, the store)', read: async (w) => refFromFiles(w.store, 'refs/heads/main') },
  { name: 'print (a worker request, the store)', read: (w) => w.h.runner.print!({ jjRepo: w.jjRepo, store: w.store, files: [{ label: 'HEAD', path: join(w.store, 'HEAD') }, { label: 'packed', path: join(w.store, 'packed-refs') }], trees: [{ label: 'heads', path: join(w.store, 'refs', 'heads') }] }) },
  { name: 'git on the store (a process)', read: (w) => storeGitGated(w.repo, ['--git-dir', w.store, 'for-each-ref', '--format=%(objectname) %(refname)'], () => w.gitAsync(['--git-dir', w.store, 'for-each-ref', '--format=%(objectname) %(refname)'])) }
]

describe.skipIf(!jjExe)(`Combwork's readers against its jj writes (HI-2918, jj ${TESTED_JJ.version})${OFF ? ' — the gate OFF' : ''}`, () => {
  for (const colocated of [true, false]) {
    describe(colocated ? 'colocated' : 'non-colocated', () => {
      for (const reader of READERS) {
        it.skipIf(reader.colocatedOnly && !colocated)(`${reader.name}: 27 writes meanwhile, none failed or stale, every export done`, async () => {
          const w = await world(colocated)
          const run = { on: true, reads: 0 }
          const loop = async (): Promise<void> => {
            while (run.on) {
              await reader.read(w).catch(() => null)
              run.reads++
              await new Promise((res) => setImmediate(res))
            }
          }
          const loops = [loop(), loop()]
          const failures: string[] = []
          let gitBehind = 0
          for (let i = 0; i < WRITES; i++) {
            writeFileSync(join(w.slot, `f${i}.txt`), `${i}\n`)
            const c = await w.h.runner.run(w.slot, ['commit', '-m', `c${i}`], { write: true })
            const at = w.h.id(w.slot, '@-')
            const m = await w.h.runner.run(w.repo, ['bookmark', 'set', 'main', '-r', at, '--allow-backwards'], { write: true })
            const n = await w.h.runner.run(w.slot, ['new', 'main'], { write: true })
            for (const [what, r] of [['commit', c], ['bookmark set', m], ['new', n]] as const) {
              if (!r.ok) failures.push(`${what}: ${r.err.trim().split(/\r?\n/).slice(-1)[0]}`)
              else if (/Failed to export/.test(r.err)) failures.push(`${what}: export failed`)
            }
            // Colocated: Git's main where jj put it (the export done, not left for a later command). Not colocated, jj
            // exports nothing by itself (HI-2896), so there is no Git main to compare.
            if (colocated && w.h.git(w.repo, '--git-dir', w.store, 'rev-parse', 'refs/heads/main').trim() !== at) gitBehind++
          }
          run.on = false
          await Promise.all(loops)
          const stale = await w.h.port.stale(w.slot)
          const said = `${failures.length} of ${WRITES * 3} writes failed or warned (${failures.slice(0, 3).join('; ')}), Git behind ${gitBehind} of ${WRITES}, stale ${String(stale)}, ${run.reads} reads`
          if (OFF) console.log(`BEFORE ${colocated ? 'colocated' : 'non-colocated'} ${reader.name}: ${said}`)
          expect(run.reads, said).toBeGreaterThan(WRITES)
          expect({ failures: failures.length, gitBehind, stale }, said).toEqual({ failures: 0, gitBehind: 0, stale: false })
          expect(jjFileGate.size).toBe(0)
        }, 240_000)
      }
    })
  }
})
