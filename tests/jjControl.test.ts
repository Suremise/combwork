// jj's control workspace, made again after an interrupted making (HI-2887; design HI-2887/s7 §2), on the real jj in both
// Git-backed modes: a `creating` record is decided by jj's own workspace list under the store's lock. Added: ready, and
// slots are made. Not added: a half-made folder holding nothing but jj's own files is trashed and the control made again;
// one holding anything else is left alone, refused; no folder at all, made again. A failed making never disables a
// project's jj slots for good.
// Skipped without the fetched jj (npm run jj:fetch).
import { readFileSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { TESTED_JJ } from '../src/shared/jjTool'
import { harness, jjExe } from './jjWorkspaceHarness'

describe.skipIf(!jjExe)(`jj's control workspace after an interrupted making (jj ${TESTED_JJ.version}), HI-2887`, () => {
  describe.each([true, false] as const)('colocated: %s', (colocated) => {
    const setup = (name: string) => {
      const h = harness()
      const { repo, root, base } = h.repo(`${name}${colocated ? 'c' : 'n'}`, colocated)
      const control = join(resolve(repo, '..'), 'slots', '.cw-jj-control')
      const key = `jj_control:${repo.toLowerCase()}`
      return { h, repo, root, base, control, key, record: () => h.journals.rows.get(key) as { phase?: string } | undefined }
    }

    it('a creating record whose workspace was added: ready, and a slot is made', async () => {
      const w = setup('ctla')
      expect((await w.h.port.create(w.repo, join(w.root, 'slot-a'), w.base)).ok).toBe(true)
      expect(w.record()?.phase).toBe('ready')
      // Interrupted after jj's add, before the record said so.
      w.h.journals.rows.set(w.key, { ...(w.record() as object), phase: 'creating' })
      expect((await w.h.port.create(w.repo, join(w.root, 'slot-b'), w.base)).ok).toBe(true)
      expect(w.record()?.phase).toBe('ready')
    })

    it('not added, its folder holding only jj files: trashed and made again', async () => {
      const w = setup('ctlb')
      expect((await w.h.port.create(w.repo, join(w.root, 'slot-a'), w.base)).ok).toBe(true)
      const made = w.record() as { store: string; workspace: string; folder: string }
      // As a failed add leaves it: the folder (only jj's own files), the workspace not in jj's list, the record creating.
      w.h.jj(w.repo, 'workspace', 'forget', made.workspace)
      w.h.journals.rows.set(w.key, { phase: 'creating', store: made.store, workspace: made.workspace, folder: made.folder })
      const trashed = w.h.trashed.length
      expect((await w.h.port.create(w.repo, join(w.root, 'slot-b'), w.base)).ok).toBe(true)
      expect(w.h.trashed.length).toBe(trashed + 1)
      expect(w.record()?.phase).toBe('ready')
    })

    it('not added, no folder at all: made again', async () => {
      const w = setup('ctlc')
      expect((await w.h.port.create(w.repo, join(w.root, 'slot-a'), w.base)).ok).toBe(true)
      const made = w.record() as { store: string; workspace: string; folder: string }
      w.h.jj(w.repo, 'workspace', 'forget', made.workspace)
      rmSync(made.folder, { recursive: true, force: true })
      w.h.journals.rows.set(w.key, { phase: 'creating', store: made.store, workspace: made.workspace, folder: made.folder })
      expect((await w.h.port.create(w.repo, join(w.root, 'slot-b'), w.base)).ok).toBe(true)
      expect(w.record()?.phase).toBe('ready')
    })

    it("not added, its folder holding a user's file: left alone, refused", async () => {
      const w = setup('ctle')
      expect((await w.h.port.create(w.repo, join(w.root, 'slot-a'), w.base)).ok).toBe(true)
      const made = w.record() as { store: string; workspace: string; folder: string }
      w.h.jj(w.repo, 'workspace', 'forget', made.workspace)
      writeFileSync(join(made.folder, 'notes.txt'), 'mine\n')
      w.h.journals.rows.set(w.key, { phase: 'creating', store: made.store, workspace: made.workspace, folder: made.folder })
      expect((await w.h.port.create(w.repo, join(w.root, 'slot-b'), w.base)).ok).toBe(false)
      expect(readFileSync(join(made.folder, 'notes.txt'), 'utf8')).toBe('mine\n')
      expect(w.record()?.phase).toBe('creating')
    })
  })
})
