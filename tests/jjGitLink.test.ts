// HI-3046: a colocated jj slot whose folder was deleted made again under its name. jj 0.47.1 leaves the slot's Git
// worktree entry when it forgets a workspace whose folder is gone, and Git then refuses an add at that path; the port
// clears the entry only when its receipt proves it Combwork's (design HI-3046/s7–s14). On the real jj; the plain Git
// worktrees here are the user's own, made by the test. Skipped without the fetched jj (npm run jj:fetch).
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { TESTED_JJ } from '../src/shared/jjTool'
import { JJ_REFUSED } from '../src/main/platform/jjWorkspacePort'
import { asideOf, asReceipt, residuesOf } from '../src/main/platform/jjGitLink'
import type { JjPortDeps } from '../src/main/platform/jjWorkspacePort'
import { harness, jjExe } from './jjWorkspaceHarness'

const REAL_JJ_MS = 180_000

const idOf = (p: string): string => {
  const s = statSync(p, { bigint: true })
  return `${s.ino}:${s.birthtimeNs}`
}

/** A colocated project with slot-a made, its folder deleted and its workspace pruned: its Git entry left behind. */
async function goneSlot(more: Partial<JjPortDeps> = {}) {
  const h = harness()
  const { repo, root, base } = h.repo('gitlink', true)
  const port = h.portWith(more)
  const folder = join(root, 'slot-a')
  const entry = join(repo, '.git', 'worktrees', 'slot-a')
  const journal = h.journals.of(`jj_gitlink:${folder.toLowerCase()}`)
  expect(await port.create(repo, folder, base)).toEqual({ ok: true, err: '' })
  expect(existsSync(entry)).toBe(true)
  rmSync(folder, { recursive: true, force: true })
  await port.prune(repo)
  // jj forgot it and left its Git worktree entry (what this card is about).
  expect(h.jj(repo, '--ignore-working-copy', 'workspace', 'list').includes(port.nameFor(repo, folder))).toBe(false)
  expect(existsSync(entry)).toBe(true)
  return { h, repo, root, base, port, folder, entry, journal, store: join(repo, '.git') }
}

const asides = (store: string): string[] => readdirSync(store).filter((n) => n.startsWith('.cw-gitlink-'))

describe.skipIf(!jjExe)(`a colocated jj slot made again after its folder was deleted (HI-3046, jj ${TESTED_JJ.version})`, { timeout: REAL_JJ_MS }, () => {
  it('a plain remake: its own entry proved and cleared, the slot made again, an unrelated stale entry untouched', async () => {
    const w = await goneSlot()
    // The user's own Git worktree, deleted: stale too, and never Combwork's to clear.
    const other = join(w.root, 'mine')
    w.h.git(w.repo, 'worktree', 'add', '--detach', other)
    rmSync(other, { recursive: true, force: true })
    const otherEntry = join(w.store, 'worktrees', 'mine')
    const otherId = idOf(otherEntry)
    const was = idOf(w.entry)
    expect(await w.port.create(w.repo, w.folder, w.base)).toEqual({ ok: true, err: '' })
    expect(existsSync(join(w.folder, 'base.txt'))).toBe(true)
    // A new entry for the new slot, its receipt, nothing left aside; the user's entry as it was.
    expect(idOf(w.entry)).not.toBe(was)
    expect(asReceipt(w.journal.read())).toMatchObject({ entry: w.entry, entryId: idOf(w.entry) })
    expect(asReceipt(w.journal.read())?.clearing).toBeUndefined()
    expect(asides(w.store)).toEqual([])
    expect(idOf(otherEntry)).toBe(otherId)
  })

  it("a user's Git worktree at the slot's exact path, deleted: refused before any add, its entry untouched, no folder made", async () => {
    const h = harness()
    const { repo, root, base } = h.repo('gitlink-user', true)
    const folder = join(root, 'slot-a')
    h.git(repo, 'worktree', 'add', '--detach', folder)
    rmSync(folder, { recursive: true, force: true })
    const entry = join(repo, '.git', 'worktrees', 'slot-a')
    const id = idOf(entry)
    const r = await h.port.create(repo, folder, base)
    expect(r.ok).toBe(false)
    expect(r.err).toContain(JJ_REFUSED.gitLink)
    expect(r.err).toContain(folder)
    expect(idOf(entry)).toBe(id)
    expect(existsSync(folder)).toBe(false)
  })

  it('an entry replaced after the slot was forgotten (same path, same name, a new entry): refused, untouched', async () => {
    const w = await goneSlot()
    // The old entry gone by other means, and a user's worktree made at the slot's path, deleted in turn.
    rmSync(w.entry, { recursive: true, force: true })
    w.h.git(w.repo, 'worktree', 'add', '--detach', w.folder)
    rmSync(w.folder, { recursive: true, force: true })
    const id = idOf(w.entry)
    const r = await w.port.create(w.repo, w.folder, w.base)
    expect(r.err).toContain(JJ_REFUSED.gitLink)
    expect(idOf(w.entry)).toBe(id)
    expect(existsSync(w.folder)).toBe(false)
  })

  it('a locked entry, and one with no receipt (made before HI-3046): refused, untouched', async () => {
    const locked = await goneSlot()
    writeFileSync(join(locked.entry, 'locked'), 'kept\n')
    const id = idOf(locked.entry)
    expect((await locked.port.create(locked.repo, locked.folder, locked.base)).err).toContain(JJ_REFUSED.gitLink)
    expect(idOf(locked.entry)).toBe(id)
    expect(existsSync(join(locked.entry, 'locked'))).toBe(true)
    expect(asides(locked.store)).toEqual([])

    const legacy = await goneSlot({ gitLink: undefined })
    const lid = idOf(legacy.entry)
    expect(legacy.journal.read()).toBeNull()
    expect((await legacy.h.port.create(legacy.repo, legacy.folder, legacy.base)).err).toContain(JJ_REFUSED.gitLink)
    expect(idOf(legacy.entry)).toBe(lid)
    expect(existsSync(legacy.folder)).toBe(false)
  })

  it('replaced between its last check and the move: what was moved fails the proof, is put back, nothing removed', async () => {
    let w: Awaited<ReturnType<typeof goneSlot>> | null = null
    let swapped = ''
    w = await goneSlot({
      hooks: {
        beforeGitLinkAside: (entry) => {
          // Another entry put at its name: the original moved off (kept by the test), a copy (new file ids) in its place.
          renameSync(entry, `${entry}-orig`)
          cpSync(`${entry}-orig`, entry, { recursive: true })
          swapped = idOf(entry)
        }
      }
    })
    const r = await w.port.create(w.repo, w.folder, w.base)
    expect(r.err).toContain(JJ_REFUSED.gitLink)
    expect(idOf(w.entry)).toBe(swapped)
    expect(existsSync(`${w.entry}-orig`)).toBe(true)
    expect(asides(w.store)).toEqual([])
    expect(existsSync(w.folder)).toBe(false)
  })

  it('locked right after the move: the moved entry fails the proof, is put back locked, nothing removed', async () => {
    const w = await goneSlot({ hooks: { afterGitLinkAside: (aside) => writeFileSync(join(aside, 'locked'), 'mine\n') } })
    const id = idOf(w.entry)
    expect((await w.port.create(w.repo, w.folder, w.base)).err).toContain(JJ_REFUSED.gitLink)
    expect(idOf(w.entry)).toBe(id)
    expect(existsSync(join(w.entry, 'locked'))).toBe(true)
    expect(asides(w.store)).toEqual([])
  })

  describe('a clearing cut short after the move (a restart): finished only on the full proof again', () => {
    /** The move done, then Combwork gone: the receipt's clearing and the moved entry left. */
    async function cutShort() {
      const w = await goneSlot({
        hooks: {
          afterGitLinkAside: () => {
            throw new Error('Combwork gone')
          }
        }
      })
      await expect(w.port.create(w.repo, w.folder, w.base)).rejects.toThrow('Combwork gone')
      const rec = asReceipt(w.journal.read())!
      expect(rec.clearing).toBeTruthy()
      const aside = asideOf(rec.store, rec.clearing!)
      expect(existsSync(aside)).toBe(true)
      expect(existsSync(w.entry)).toBe(false)
      return { ...w, aside, again: w.h.portWith() }
    }

    it('nothing changed since: removed, and the slot made', async () => {
      const w = await cutShort()
      expect(await w.again.create(w.repo, w.folder, w.base)).toEqual({ ok: true, err: '' })
      expect(existsSync(w.aside)).toBe(false)
      expect(asReceipt(w.journal.read())?.clearing).toBeUndefined()
    })

    const changes: [string, (w: Awaited<ReturnType<typeof cutShort>>) => void][] = [
      ['locked', (w) => writeFileSync(join(w.aside, 'locked'), 'mine\n')],
      ['gitdir', (w) => writeFileSync(join(w.aside, 'gitdir'), 'C:/elsewhere/.git\n')],
      ['commondir', (w) => writeFileSync(join(w.aside, 'commondir'), '../../other\n')],
      ['folder', (w) => mkdirSync(w.folder)],
      ['registered', (w) => void w.h.jj(w.repo, 'workspace', 'add', join(w.root, 'elsewhere'), '--name', w.port.nameFor(w.repo, w.folder), '--no-colocate')]
    ]
    it.each(changes)('%s changed since: a residue, never removed; the make refused', async (why, change) => {
      const w = await cutShort()
      change(w)
      const r = await w.again.create(w.repo, w.folder, w.base)
      expect(r.ok).toBe(false)
      expect(r.err).toContain(why === 'folder' ? JJ_REFUSED.exists : JJ_REFUSED.gitLink)
      expect(existsSync(w.aside)).toBe(true)
      if (why !== 'folder') expect(residuesOf(w.journal.read())).toEqual([{ path: w.aside, why }])
    })
  })
})
