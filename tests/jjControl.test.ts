// jj's control workspace: each making its own attempt, recovered without deleting anything unproved (HI-2887; design
// HI-2887/s7–s20, HR1's), on the real jj in both Git-backed modes. The record is decided again inside the store's lock:
// - interrupted after jj's add (no recorded baseline for its `ws`): never adopted; kept as a residue (its folder and its
//   registration), a fresh attempt under a new name made, and slots made from it;
// - a ready control's `ws` replaced byte for byte (its token folder unchanged), or its folder removed: not used; a
//   residue; the next slot creation succeeds;
// - a user's file in an attempt's folder: kept; an empty attempt folder of its own: removed; a folder at the attempt's
//   path made by someone else (no recorded generation): kept;
// - two simultaneous makings: one control; a replacement while the recovery waits for the lock: kept, a fresh one made.
// - the window's leftovers (HI-2869): a residue pruned only on a proved absence and no registration, in rotating batches;
//   one changed meanwhile, present, registered or unreadable, kept.
// Skipped without the fetched jj (npm run jj:fetch).
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { holdLaunches, setLiveFolders } from '../src/main/launchHolds'
import { join, resolve } from 'path'
import { statSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { TESTED_JJ } from '../src/shared/jjTool'
import { harness, jjExe } from './jjWorkspaceHarness'

type Rec = { phase?: string; token?: string; name?: string; store?: string; tokenFolder?: string; tokenGeneration?: string; ws?: string; wsGeneration?: string; residues?: { path: string; name?: string; why: string }[] }

describe.skipIf(!jjExe)(`jj's control workspace, its attempts and their recovery (jj ${TESTED_JJ.version}), HI-2887`, () => {
  describe.each([true, false] as const)('colocated: %s', (colocated) => {
    const setup = (name: string, lockHook?: () => Promise<void> | void, remake = true) => {
      const h = harness()
      const { repo, root, base } = h.repo(`${name}${colocated ? 'c' : 'n'}`, colocated)
      const key = `jj_control:${repo.toLowerCase()}`
      // The store's lock as the app's serializes (one holder at a time), with a test's hook on taking it.
      let chain: Promise<unknown> = Promise.resolve()
      const port = h.portWith({
        remakeAllowed: () => remake,
        lock: (_s, fn) => {
          const run = chain.then(async () => {
            await lockHook?.()
            return fn()
          })
          chain = run.catch(() => undefined)
          return run
        }
      })
      const attempts = join(resolve(repo, '..'), 'slots', '.cw-jj-controls')
      return {
        h,
        repo,
        root,
        base,
        port,
        attempts,
        record: () => h.journals.rows.get(key) as Rec | undefined,
        set: (r: Rec) => void h.journals.rows.set(key, r),
        tokens: () => (existsSync(attempts) ? readdirSync(attempts) : [])
      }
    }
    const folderGen = (p: string): string => {
      const s = statSync(p, { bigint: true })
      return `${s.ino}:${s.birthtimeNs}`
    }

    it("made while the project folder is held open (an editor's handle), its uncommitted edit recorded into the user's @; refused with an agent there", async () => {
      const h = harness()
      const { repo, root, base } = h.repo(`ctlo${colocated ? 'c' : 'n'}`, colocated)
      const port = h.portWith({ projectHold: (r) => holdLaunches(r) })
      // An agent in the project folder: refused, nothing made.
      setLiveFolders(() => [repo])
      expect((await port.create(repo, join(root, 'slot-a'), base)).ok).toBe(false)
      setLiveFolders(() => [])
      // The folder held open (a file open in it, as an editor keeps one) and an uncommitted edit: made, the edit in @.
      writeFileSync(join(repo, 'draft.txt'), 'work in progress\n')
      const fd = openSync(join(repo, 'draft.txt'), 'r')
      try {
        expect((await port.create(repo, join(root, 'slot-a'), base)).ok).toBe(true)
      } finally {
        closeSync(fd)
      }
      expect(readFileSync(join(repo, 'draft.txt'), 'utf8')).toBe('work in progress\n')
      expect(h.jj(repo, '--ignore-working-copy', 'diff', '--summary', '-r', '@')).toMatch(/draft\.txt/)
    })

    it('interrupted after the add (no baseline for its ws): kept as a residue, a fresh attempt made, slots made', async () => {
      const w = setup('ctla')
      expect((await w.port.create(w.repo, join(w.root, 'slot-a'), w.base)).ok).toBe(true)
      const first = w.record()!
      expect(first.phase).toBe('ready')
      // The first set-up, interrupted after jj's add (never ready): made again, automatically.
      const { ws: _ws, wsGeneration: _g, everReady: _e, ...partial } = first as Rec & { everReady?: boolean }
      w.set({ ...partial, phase: 'folder' })
      expect((await w.port.create(w.repo, join(w.root, 'slot-b'), w.base)).ok).toBe(true)
      const now = w.record()!
      expect(now.phase).toBe('ready')
      expect(now.token).not.toBe(first.token)
      expect(now.residues).toEqual(expect.arrayContaining([expect.objectContaining({ name: first.name, why: 'unrecorded' })]))
      expect(existsSync(first.ws!)).toBe(true)
    })

    it("a ready control lost: not made again until the user's decision covers it; refused, reported", async () => {
      const w = setup('ctlh', undefined, false)
      expect((await w.port.create(w.repo, join(w.root, 'slot-a'), w.base)).ok).toBe(true)
      const first = w.record()!
      rmSync(first.tokenFolder!, { recursive: true, force: true })
      expect((await w.port.create(w.repo, join(w.root, 'slot-b'), w.base)).ok).toBe(false)
      expect(w.record()).toMatchObject({ phase: 'idle', everReady: true })
      expect(w.record()!.residues).toEqual(expect.arrayContaining([expect.objectContaining({ name: first.name, why: 'lost' })]))
      expect(w.tokens()).toEqual([])
    })

    it("a ready control's ws replaced byte for byte, or its folder removed (re-set-up allowed): not used, kept or reported; the next slot made", async () => {
      const w = setup('ctlb')
      expect((await w.port.create(w.repo, join(w.root, 'slot-a'), w.base)).ok).toBe(true)
      const first = w.record()!
      renameSync(first.ws!, `${first.ws}-old`)
      cpSync(`${first.ws}-old`, first.ws!, { recursive: true })
      rmSync(`${first.ws}-old`, { recursive: true, force: true })
      expect((await w.port.create(w.repo, join(w.root, 'slot-b'), w.base)).ok).toBe(true)
      const second = w.record()!
      expect(second.token).not.toBe(first.token)
      expect(existsSync(first.ws!)).toBe(true)
      expect(second.residues).toEqual(expect.arrayContaining([expect.objectContaining({ name: first.name, why: 'lost' })]))
      // Its folder removed: reported, and the next slot is made from a fresh attempt.
      rmSync(second.tokenFolder!, { recursive: true, force: true })
      expect((await w.port.create(w.repo, join(w.root, 'slot-c'), w.base)).ok).toBe(true)
      expect(w.record()!.token).not.toBe(second.token)
      expect(w.record()!.residues).toEqual(expect.arrayContaining([expect.objectContaining({ name: second.name, why: 'lost' })]))
    })

    it("an attempt's folder: a user's file kept; empty and its own, removed; someone else's (no recorded generation), kept", async () => {
      const w = setup('ctlc')
      // A user's file in an attempt folder whose add never registered.
      mkdirSync(join(w.attempts, 'aaaaaaaaaaaa'), { recursive: true })
      writeFileSync(join(w.attempts, 'aaaaaaaaaaaa', 'notes.txt'), 'mine\n')
      const store = (await w.h.port.identity!(w.repo))?.store
      w.set({ phase: 'folder', store, token: 'aaaaaaaaaaaa', name: 'cw-x-control-aaaaaaaaaaaa', tokenFolder: join(w.attempts, 'aaaaaaaaaaaa'), tokenGeneration: folderGen(join(w.attempts, 'aaaaaaaaaaaa')) })
      expect((await w.port.create(w.repo, join(w.root, 'slot-a'), w.base)).ok).toBe(true)
      expect(readFileSync(join(w.attempts, 'aaaaaaaaaaaa', 'notes.txt'), 'utf8')).toBe('mine\n')
      expect(w.record()!.residues).toEqual(expect.arrayContaining([expect.objectContaining({ path: join(w.attempts, 'aaaaaaaaaaaa'), why: 'notEmpty' })]))
      // An empty attempt folder of its own: removed.
      const w2 = setup('ctld')
      mkdirSync(join(w2.attempts, 'bbbbbbbbbbbb'), { recursive: true })
      const store2 = (await w2.h.port.identity!(w2.repo))?.store
      w2.set({ phase: 'folder', store: store2, token: 'bbbbbbbbbbbb', name: 'cw-x-control-bbbbbbbbbbbb', tokenFolder: join(w2.attempts, 'bbbbbbbbbbbb'), tokenGeneration: folderGen(join(w2.attempts, 'bbbbbbbbbbbb')) })
      expect((await w2.port.create(w2.repo, join(w2.root, 'slot-a'), w2.base)).ok).toBe(true)
      expect(existsSync(join(w2.attempts, 'bbbbbbbbbbbb'))).toBe(false)
      // A folder at an intent's path, its generation never recorded: kept.
      const w3 = setup('ctle')
      mkdirSync(join(w3.attempts, 'cccccccccccc'), { recursive: true })
      const store3 = (await w3.h.port.identity!(w3.repo))?.store
      w3.set({ phase: 'intent', store: store3, token: 'cccccccccccc', name: 'cw-x-control-cccccccccccc', tokenFolder: join(w3.attempts, 'cccccccccccc') })
      expect((await w3.port.create(w3.repo, join(w3.root, 'slot-a'), w3.base)).ok).toBe(true)
      expect(existsSync(join(w3.attempts, 'cccccccccccc'))).toBe(true)
      expect(w3.record()!.residues).toEqual(expect.arrayContaining([expect.objectContaining({ why: 'unproved' })]))
    })

    it("a ready control replaced, or given a file, while a slot's add waits for the store's lock: refused, the control untouched (HR1's round 1)", async () => {
      let onLock: (() => void) | null = null
      const w = setup('ctli', () => {
        const f = onLock
        onLock = null
        f?.()
      })
      expect((await w.port.create(w.repo, join(w.root, 'slot-a'), w.base)).ok).toBe(true)
      const ready = w.record()!
      const ops = (): string => w.h.jj(w.repo, '--ignore-working-copy', 'op', 'log', '--no-graph', '--limit', '1', '-T', 'id').trim()
      // Replaced byte for byte while the add waits for the lock (its control was proved before): no add from it.
      onLock = () => {
        renameSync(ready.ws!, `${ready.ws}-old`)
        cpSync(`${ready.ws}-old`, ready.ws!, { recursive: true })
        rmSync(`${ready.ws}-old`, { recursive: true, force: true })
      }
      const before = ops()
      expect((await w.port.create(w.repo, join(w.root, 'slot-b'), w.base)).ok).toBe(false)
      expect(ops()).toBe(before)
      expect(existsSync(join(w.root, 'slot-b'))).toBe(false)
      // The next creation recovers (a residue, a fresh control) and makes the slot; the replacement stays where it is.
      expect((await w.port.create(w.repo, join(w.root, 'slot-b'), w.base)).ok).toBe(true)
      expect(existsSync(ready.ws!)).toBe(true)
      // A file added to the (new) control while an add waits: refused, the file kept.
      const now = w.record()!
      onLock = () => writeFileSync(join(now.ws!, 'stray.txt'), 'x\n')
      expect((await w.port.create(w.repo, join(w.root, 'slot-c'), w.base)).ok).toBe(false)
      expect(readFileSync(join(now.ws!, 'stray.txt'), 'utf8')).toBe('x\n')
    })

    it("replaced or given a file during the control's proof (after its generations were read), or during removal's journal write: no add or forget, the replacement kept (HR1's round 2)", async () => {
      const h = harness()
      const { repo, root, base } = h.repo(`ctlj${colocated ? 'c' : 'n'}`, colocated)
      let onProved: (() => void) | null = null
      const port = h.portWith({
        remakeAllowed: () => true,
        controlProved: () => {
          const f = onProved
          onProved = null
          f?.()
        }
      })
      expect((await port.create(repo, join(root, 'slot-a'), base)).ok).toBe(true)
      const key = `jj_control:${repo.toLowerCase()}`
      const rec = (): Rec => h.journals.rows.get(key) as Rec
      const ops = (): string => h.jj(repo, '--ignore-working-copy', 'op', 'log', '--no-graph', '--limit', '1', '-T', 'id').trim()
      const replace = (ws: string): void => {
        renameSync(ws, `${ws}-old`)
        cpSync(`${ws}-old`, ws, { recursive: true })
        rmSync(`${ws}-old`, { recursive: true, force: true })
      }
      // Byte for byte, between the proof's reads and its check: refused, nothing run, the replacement kept.
      const ws1 = rec().ws!
      onProved = () => replace(ws1)
      let before = ops()
      expect((await port.create(repo, join(root, 'slot-b'), base)).ok).toBe(false)
      expect(ops()).toBe(before)
      expect(existsSync(join(ws1, '.jj'))).toBe(true)
      // A file added there instead (on the control the next creation makes): refused, the file kept.
      expect((await port.create(repo, join(root, 'slot-b'), base)).ok).toBe(true)
      const ws2 = rec().ws!
      onProved = () => writeFileSync(join(ws2, 'stray.txt'), 'x\n')
      before = ops()
      expect((await port.create(repo, join(root, 'slot-c'), base)).ok).toBe(false)
      expect(ops()).toBe(before)
      expect(readFileSync(join(ws2, 'stray.txt'), 'utf8')).toBe('x\n')
      rmSync(join(ws2, 'stray.txt'))
      // During removal's journal write (after its proof): no forget, the slot still registered, the replacement kept.
      const identity = (await port.identity!(join(root, 'slot-b')))!
      const journal = h.journals.of('remove-b')
      const wrapped = { ...journal, write: async (v: unknown) => (await journal.write(v), replace(ws2)) }
      before = ops()
      expect((await port.remove(repo, join(root, 'slot-b'), { identity, journal: wrapped } as never)).ok).toBe(false)
      expect(ops()).toBe(before)
      expect(h.jj(repo, '--ignore-working-copy', 'workspace', 'list', '-T', 'name ++ "\\n"')).toContain(identity.workspace)
      expect(existsSync(join(ws2, '.jj'))).toBe(true)
    })

    it("the window's leftovers (HI-2869): only proved absences pruned, in rotating batches; present, registered, unreadable or changed meanwhile, kept", async () => {
      const w = setup('ctlp')
      expect((await w.port.create(w.repo, join(w.root, 'slot-a'), w.base)).ok).toBe(true)
      const rec = w.record()!
      const dir = join(resolve(w.repo, '..'), 'leftovers')
      mkdirSync(dir, { recursive: true })
      // 20 residues (more than a batch): even ones still there, odd ones gone; one gone but still registered with jj
      // (the control's own name); one under a file (ENOTDIR: gone); one whose lstat fails otherwise (kept).
      const residues = Array.from({ length: 20 }, (_, i) => ({ path: join(dir, `r${i}`), why: 'unrecorded' }))
      for (let i = 0; i < 20; i += 2) mkdirSync(residues[i].path)
      writeFileSync(join(dir, 'afile'), 'x')
      residues.push({ path: join(dir, 'gone-registered'), name: rec.name!, why: 'lost' } as never, { path: join(dir, 'afile', 'under'), why: 'unrecorded' }, { path: join(dir, 'bad\u0000name'), why: 'unrecorded' })
      w.set({ ...rec, residues })
      expect(w.port.residues(w.repo, 5)).toMatchObject({ total: 23, rows: residues.slice(0, 5) })
      // Changed while the prune read (between its snapshot and its write): nothing pruned.
      const rows = w.h.journals.rows as Map<string, unknown>
      const key = `jj_control:${w.repo.toLowerCase()}`
      const get = rows.get.bind(rows)
      let reads = 0
      rows.get = (k: string) => {
        const v = get(k)
        if (k === key && ++reads === 1) rows.set(k, { ...(v as object), touched: true })
        return v
      }
      expect(await w.port.pruneResidues(w.repo)).toBe(0)
      rows.get = get
      expect(w.record()!.residues).toHaveLength(23)
      // Batches of 16, the cursor rotating: two passes reach every residue.
      const first = await w.port.pruneResidues(w.repo)
      expect(first).toBeGreaterThan(0)
      await w.port.pruneResidues(w.repo)
      await w.port.pruneResidues(w.repo)
      const left = w.record()!.residues!.map((r) => r.path)
      expect(left.sort()).toEqual([...residues.filter((_, i) => i < 20 && i % 2 === 0).map((r) => r.path), join(dir, 'gone-registered'), join(dir, 'bad\u0000name')].sort())
    })

    it("the prune's write waiting for the board's lock (HR2's round 1): a leftover recreated meanwhile kept; a residue added meanwhile, nothing written", async () => {
      const w = setup('ctlq')
      expect((await w.port.create(w.repo, join(w.root, 'slot-a'), w.base)).ok).toBe(true)
      const rec = w.record()!
      const dir = join(resolve(w.repo, '..'), 'leftovers-q')
      mkdirSync(dir, { recursive: true })
      const gone = { path: join(dir, 'gone'), why: 'unrecorded' }
      const other = { path: join(dir, 'other'), why: 'unrecorded' }
      const late = { path: join(dir, 'late'), why: 'lost' }
      const journals = w.h.journals
      const hold = (during: () => void) => {
        journals.gate = () => {
          journals.gate = null
          during()
        }
      }
      // Recreated while the write waits (the record unchanged): kept; the other, still gone, pruned.
      w.set({ ...rec, residues: [gone, other] })
      hold(() => mkdirSync(gone.path))
      expect(await w.port.pruneResidues(w.repo)).toBe(1)
      expect(w.record()!.residues).toEqual([gone])
      // Recreated, and another residue recorded, while it waits: the record changed, so nothing is written.
      rmSync(gone.path, { recursive: true })
      w.set({ ...rec, residues: [gone] })
      hold(() => {
        mkdirSync(gone.path)
        const now = w.record()!
        w.set({ ...now, residues: [...now.residues!, late] })
      })
      expect(await w.port.pruneResidues(w.repo)).toBe(0)
      expect(w.record()!.residues).toEqual([gone, late])
    })

    it('two simultaneous makings: one control; replaced while the recovery waits for the lock: kept, a fresh one made', async () => {
      const w = setup('ctlf')
      const [a, b] = await Promise.all([w.port.create(w.repo, join(w.root, 'slot-a'), w.base), w.port.create(w.repo, join(w.root, 'slot-b'), w.base)])
      expect(a.ok && b.ok).toBe(true)
      expect(w.tokens()).toHaveLength(1)
      // The control's token folder replaced (byte for byte) while a recovery waits for the lock.
      let replace: (() => void) | null = null
      const w2 = setup('ctlg', () => {
        const f = replace
        replace = null
        f?.()
      })
      expect((await w2.port.create(w2.repo, join(w2.root, 'slot-a'), w2.base)).ok).toBe(true)
      const first = w2.record()!
      w2.set({ ...first, wsGeneration: 'stale' })
      replace = () => {
        renameSync(first.tokenFolder!, `${first.tokenFolder}-old`)
        cpSync(`${first.tokenFolder}-old`, first.tokenFolder!, { recursive: true })
        rmSync(`${first.tokenFolder}-old`, { recursive: true, force: true })
      }
      expect((await w2.port.create(w2.repo, join(w2.root, 'slot-b'), w2.base)).ok).toBe(true)
      expect(existsSync(join(first.tokenFolder!, 'ws'))).toBe(true)
      expect(w2.record()!.token).not.toBe(first.token)
    })
  })
})
