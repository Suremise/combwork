// jj slots after the user discards old operations (`jj op abandon`, HI-3099, from HI-3058's hunt): a slot's checkout
// operation, and the control workspace's, are no longer in the head's history, so jj refuses to read or record them ("a
// sibling of the working copy's operation"). On the real jj, through the workspace port:
// - the slot reads stale, and Recover… mends it, its unrecorded edit kept (its record waits out the second a commit
//   identical to its preserved one would collide in: `collision` at the cap, `fence` on a lost fence, both resumable);
// - Combwork's control workspace is mended (update-stale in it alone), on a fresh proof, refused and retryable when the
//   head moves or the control isn't empty;
// - an edit Combwork had recorded in an operation the abandon discards is kept in the folder too;
// - the user's own project folder is left exactly as it was.
// Skipped without the fetched jj (npm run jj:fetch).

import { execFileSync } from 'child_process'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join, relative } from 'path'
import { describe, expect, it } from 'vitest'
import { recoverStale, type GitRun, type RecoveryDeps } from '../src/main/platform/jjRecovery'
import type { JjPortDeps } from '../src/main/platform/jjWorkspacePort'
import { isUnknown } from '../src/main/platform/types'
import { harness, jjExe } from './jjWorkspaceHarness'
import { tempDir } from './tempDir'

const yes = { still: () => true }
const quiet = async (): Promise<boolean> => true

/** Every file of a folder but jj's and Git's own, with its bytes: the user's folder compared byte for byte. */
function filesOf(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n)
      if (dir === root && (n === '.jj' || n === '.git')) continue
      if (statSync(p).isDirectory()) walk(p)
      else out[relative(root, p).split('\\').join('/')] = readFileSync(p).toString('base64')
    }
  }
  walk(root)
  return out
}

/** A project with a slot holding an unrecorded edit; the user then commits twice and abandons old operations. */
async function abandoned(colocated: boolean, more: Partial<JjPortDeps> = {}, recorded = false) {
  const h0 = harness()
  const h = { ...h0, port: more && Object.keys(more).length ? h0.portWith(more) : h0.port }
  const { repo, root, base } = h.repo('opab', colocated)
  const slot = join(root, 'slot-a')
  expect((await h.port.create(repo, slot, base)).ok).toBe(true)
  const id = (await h.port.identity!(slot))!
  writeFileSync(join(slot, 'wip.txt'), 'an edit jj has not recorded\n')
  // Recorded by Combwork (a settle's owned record), in an operation the user's abandon below then discards.
  if (recorded) expect(isUnknown(await h.port.record!(slot, yes, id))).toBe(false)
  writeFileSync(join(repo, 'u1.txt'), 'u1\n')
  h.jj(repo, 'commit', '-m', 'user 1')
  writeFileSync(join(repo, 'u2.txt'), 'u2\n')
  h.jj(repo, 'commit', '-m', 'user 2')
  writeFileSync(join(repo, 'mine.txt'), 'the user’s own edit\n')
  h.jj(repo, 'status')
  h.jj(repo, 'op', 'abandon', '..@-')
  // The user's folder as they left it: compared at the end.
  const user = () => ({ files: filesOf(repo), bookmarks: h.jj(repo, '--ignore-working-copy', 'bookmark', 'list'), wc: h.jj(repo, '--ignore-working-copy', 'log', '--no-graph', '-r', '@', '-T', 'commit_id') })
  const before = user()
  const git: GitRun = async (cwd, args) => {
    try {
      const buf = execFileSync('git', args, { cwd, env: h.env, windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
      return { ok: true, out: buf.toString('utf8'), buf, err: '' }
    } catch (e) {
      const err = e as { stderr?: Buffer; stdout?: Buffer }
      return { ok: false, out: err.stdout?.toString('utf8') ?? '', buf: err.stdout ?? Buffer.alloc(0), err: err.stderr?.toString('utf8') ?? String(e) }
    }
  }
  const preserveRoot = join(tempDir('jj-preserve-'), '.cw-recovery')
  const recover = (extra: Partial<RecoveryDeps> = {}, fence = yes) => recoverStale({ port: h.port, git, preserveRoot, trash: async () => undefined, ...extra }, { repo, folder: slot, identity: id, journal: h.journals.of('rec'), fence, quiet })
  const status = (folder: string): string => {
    try {
      return 'ok: ' + h.jj(folder, 'status').trim()
    } catch (e) {
      return 'failed: ' + String((e as { stderr?: Buffer }).stderr ?? e).trim()
    }
  }
  return { h, repo, root, slot, id, before, user, recover, status, preserveRoot }
}

describe.skipIf(!jjExe)('jj slots after the user abandons old operations (HI-3099)', { timeout: 180_000 }, () => {
  it.each([true, false])('a slot reads stale; Recover… mends it, its edit kept; the control mended; the user’s folder untouched (colocated: %s)', async (colocated) => {
    const w = await abandoned(colocated)
    expect(await w.h.port.stale(w.slot)).toBe(true)
    // HI-3135: said as what happened, for the window's badge.
    expect(await w.h.port.staleWhy(w.slot)).toBe('abandoned')
    const rec = await w.recover()
    expect(rec).toMatchObject({ ok: true, restored: ['wip.txt'] })
    expect(readFileSync(join(w.slot, 'wip.txt'), 'utf8')).toBe('an edit jj has not recorded\n')
    expect(await w.h.port.stale(w.slot)).toBe(false)
    expect(await w.h.port.staleWhy(w.slot)).toBe(false)
    expect(w.status(w.slot)).toMatch(/^ok: /)
    expect(w.h.jj(w.slot, '--ignore-working-copy', 'log', '--no-graph', '-r', '@', '-T', 'divergent')).toBe('false')
    // The control mended: another slot made, and the first one removed (its edit committed first: a removal keeps work).
    expect((await w.h.port.create(w.repo, join(w.root, 'slot-b'), w.h.id(w.repo, 'main'))).ok).toBe(true)
    w.h.jj(w.slot, 'commit', '-m', 'the edit')
    // The user's folder exactly as they left it, and theirs to use.
    expect(w.user()).toEqual(w.before)
    expect(w.status(w.repo)).toMatch(/^ok: /)
  })

  it.each([true, false])('the control’s mending refused when the head moves or the control isn’t empty, then retried (colocated: %s)', async (colocated) => {
    const at: { mend: ((control: string) => void) | null } = { mend: null }
    const w = await abandoned(colocated, { hooks: { beforeControlMend: (c) => at.mend?.(c) } })
    // Another jj operation between the mending's proof and its update-stale: refused, nothing made.
    at.mend = () => void w.h.jj(w.repo, '--ignore-working-copy', 'bookmark', 'create', 'moved-meanwhile', '-r', 'main')
    expect((await w.h.port.create(w.repo, join(w.root, 'slot-b'), w.h.id(w.repo, 'main'))).ok).toBe(false)
    expect(existsSync(join(w.root, 'slot-b'))).toBe(false)
    // Something written into the control then: refused, the file kept, never mended.
    let control = ''
    at.mend = (c) => {
      control = c
      writeFileSync(join(c, 'not-ours.txt'), 'x\n')
    }
    expect((await w.h.port.create(w.repo, join(w.root, 'slot-b'), w.h.id(w.repo, 'main'))).ok).toBe(false)
    expect(readFileSync(join(control, 'not-ours.txt'), 'utf8')).toBe('x\n')
    // Retried with nothing in the way (the file gone): mended, the slot made.
    rmSync(join(control, 'not-ours.txt'))
    at.mend = null
    expect((await w.h.port.create(w.repo, join(w.root, 'slot-b'), w.h.id(w.repo, 'main'))).ok).toBe(true)
    expect(w.status(w.repo)).toMatch(/^ok: /)
    expect(filesOf(w.repo)).toEqual(w.before.files)
  })

  it.each([true, false])('Recover…’s record waits out the colliding second: `collision` at its cap, `fence` on a lost fence, each resumed (colocated: %s)', async (colocated) => {
    const w = await abandoned(colocated)
    // A clock frozen before X's second: the condition never clears, the cap ends it; no record, nothing abandoned.
    let waits = 0
    const frozen = { now: () => 0, wait: async () => void waits++ }
    const first = await w.recover({ clock: frozen })
    expect(first).toEqual({ ok: false, why: 'collision' })
    expect(waits).toBeGreaterThan(0)
    const j = w.h.journals.of('rec').read() as { phase: string; X?: string; dir?: string }
    expect(j.phase).toBe('restored')
    expect(j.X).toMatch(/^[0-9a-f]{40}$/)
    expect(w.h.jj(w.repo, '--ignore-working-copy', 'log', '--no-graph', '-r', j.X!, '-T', 'commit_id')).toBe(j.X)
    expect(existsSync(j.dir!)).toBe(true)
    expect(readFileSync(join(w.slot, 'wip.txt'), 'utf8')).toBe('an edit jj has not recorded\n')
    // The fence lost during the wait: `fence`, the same state kept.
    let live = true
    const losing = { now: () => 0, wait: async () => void (live = false) }
    expect(await w.recover({ clock: losing }, { still: () => live })).toMatchObject({ ok: false, why: 'fence' })
    expect((w.h.journals.of('rec').read() as { phase: string }).phase).toBe('restored')
    // Resumed with the real clock: recorded once the second has passed, X tidied, done.
    expect(await w.recover()).toMatchObject({ ok: true, xKept: false })
    expect(w.h.journals.of('rec').read()).toBeNull()
    expect(readFileSync(join(w.slot, 'wip.txt'), 'utf8')).toBe('an edit jj has not recorded\n')
    expect(await w.h.port.stale(w.slot)).toBe(false)
  })

  it.each([true, false])('an edit Combwork recorded in an operation the user then abandoned: Recover… keeps it in the folder (colocated: %s)', async (colocated) => {
    const w = await abandoned(colocated, {}, true)
    expect(await w.h.port.stale(w.slot)).toBe(true)
    const rec = await w.recover()
    expect(rec).toMatchObject({ ok: true })
    expect(readFileSync(join(w.slot, 'wip.txt'), 'utf8')).toBe('an edit jj has not recorded\n')
    expect(await w.h.port.stale(w.slot)).toBe(false)
    expect(w.status(w.slot)).toMatch(/^ok: /)
    expect(w.h.jj(w.slot, '--ignore-working-copy', 'log', '--no-graph', '-r', '@', '-T', 'divergent')).toBe('false')
    expect(w.user()).toEqual(w.before)
  })
  // HR3's round 1: Combwork stopping right after Recover…'s own record succeeded, before its journal ends.
  it.each([true, false])('stopped right after its own record: Recover… again finishes and tidies; a working copy moved by anyone else is still refused (colocated: %s)', async (colocated) => {
    const w = await abandoned(colocated)
    const stopping = { ...w.h.port, recordLeftOut: async (...a: Parameters<typeof w.h.port.recordLeftOut>) => {
      await w.h.port.recordLeftOut(...a)
      throw new Error('Combwork stopped')
    } }
    await expect(w.recover({ port: stopping })).rejects.toThrow('Combwork stopped')
    const j = w.h.journals.of('rec').read() as { phase: string; recordFrom?: string; recorded?: string }
    expect(j).toMatchObject({ phase: 'restored', recordFrom: expect.stringMatching(/^[0-9a-f]+$/) })
    expect(j.recorded).toBeUndefined()
    expect(await w.recover()).toMatchObject({ ok: true, xKept: false })
    expect(w.h.journals.of('rec').read()).toBeNull()
    expect(readFileSync(join(w.slot, 'wip.txt'), 'utf8')).toBe('an edit jj has not recorded\n')
    expect(w.status(w.slot)).toMatch(/^ok: /)
    expect(w.h.jj(w.slot, '--ignore-working-copy', 'log', '--no-graph', '-r', '@', '-T', 'divergent')).toBe('false')

    // Again stopped after the record, then something else moves the slot's working copy (a new change there): refused.
    const v = await abandoned(colocated)
    const stopping2 = { ...v.h.port, recordLeftOut: async (...a: Parameters<typeof v.h.port.recordLeftOut>) => {
      await v.h.port.recordLeftOut(...a)
      throw new Error('Combwork stopped')
    } }
    await expect(v.recover({ port: stopping2 })).rejects.toThrow('Combwork stopped')
    v.h.jj(v.slot, 'new')
    expect(await v.recover()).toMatchObject({ ok: false, why: 'provenance' })
    expect((v.h.journals.of('rec').read() as { phase: string }).phase).toBe('restored')
  })
  // HR1's round 2: stopped after its record, an edit made meanwhile, stopped again after the retry's record: the next
  // Recover… still finishes, the late edit kept and recorded.
  it.each([true, false])('stopped after its record twice, an edit made between: Recover… still finishes, that edit kept (colocated: %s)', async (colocated) => {
    const w = await abandoned(colocated)
    const stopping = { ...w.h.port, recordLeftOut: async (...a: Parameters<typeof w.h.port.recordLeftOut>) => {
      await w.h.port.recordLeftOut(...a)
      throw new Error('Combwork stopped')
    } }
    await expect(w.recover({ port: stopping })).rejects.toThrow('Combwork stopped')
    const first = w.h.journals.of('rec').read() as { recordFrom?: string; recorded?: string }
    writeFileSync(join(w.slot, 'late.txt'), 'written between the stops\n')
    await expect(w.recover({ port: stopping })).rejects.toThrow('Combwork stopped')
    const second = w.h.journals.of('rec').read() as { phase: string; recordFrom?: string; recorded?: string }
    expect(second.phase).toBe('restored')
    expect(second.recordFrom).not.toBe(first.recordFrom)
    expect(second.recorded).toMatch(/^[0-9a-f]{40}$/)
    const done = await w.recover()
    expect(done).toMatchObject({ ok: true })
    expect(w.h.journals.of('rec').read()).toBeNull()
    expect(readFileSync(join(w.slot, 'wip.txt'), 'utf8')).toBe('an edit jj has not recorded\n')
    expect(readFileSync(join(w.slot, 'late.txt'), 'utf8')).toBe('written between the stops\n')
    expect(w.h.jj(w.slot, '--ignore-working-copy', 'file', 'list', '-r', '@')).toMatch(/late\.txt/)
    expect(w.status(w.slot)).toMatch(/^ok: /)
    expect(w.h.jj(w.slot, '--ignore-working-copy', 'log', '--no-graph', '-r', '@', '-T', 'divergent')).toBe('false')
  })
})
