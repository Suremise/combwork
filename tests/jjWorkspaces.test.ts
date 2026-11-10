// jj's workspace port against the real jj Combwork is tested with (HI-2795's J2, its design HI-2795/s21): slots and
// copies as jj workspaces, colocated and not. Every repository is a throwaway one from tempDir(), jj's and git's config
// isolated. Skipped without the fetched jj (npm run jj:fetch); with CW_JJ_REAL=1 (the card's and a release's runs) its
// absence fails, so an acceptance run can't pass by skipping.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { TESTED_JJ } from '../src/shared/jjTool'
import { generationOf, JJ_REFUSED } from '../src/main/platform/jjWorkspacePort'
import { isUnknown } from '../src/main/platform/types'
import type { WorkspaceIdentity } from '../src/main/platform/workspacePort'
import { harness, jjExe, real } from './jjWorkspaceHarness'

const yes = { still: () => true }
const no = { still: () => false }

/** The op log's ids, newest first: what a read must leave as it was. */
const ops = (h: ReturnType<typeof harness>, cwd: string): string[] => h.jj(cwd, '--ignore-working-copy', 'op', 'log', '--no-graph', '--limit', '200', '-T', 'id ++ "\\n"').trim().split(/\r?\n/)

describe.skipIf(!jjExe)(`jj workspaces as slots and copies (jj ${TESTED_JJ.version})`, () => {
  for (const colocated of [true, false]) {
    describe(colocated ? 'colocated' : 'non-colocated', () => {
      it('makes a slot with jj workspace add from the control workspace: one store, full files, never a second .jj/repo, the project folder not snapshotted', async () => {
        const h = harness()
        const { repo, root, base } = h.repo('make', colocated)
        // An edit in the project folder jj hasn't recorded: no add or forget may record it (only the control's making, once, explicitly).
        const folder = join(root, 'slot-a')
        const made = await h.port.create(repo, folder, base)
        expect(made).toEqual({ ok: true, err: '' })
        writeFileSync(join(repo, 'unrecorded.txt'), 'the user\'s\n')
        const before = ops(h, repo)
        const folderB = join(root, 'slot-b')
        expect((await h.port.create(repo, folderB, base)).ok).toBe(true)
        // Every op since is the control's or slot-b's own, none a snapshot of the project folder.
        const since = h.jj(repo, '--ignore-working-copy', 'op', 'log', '--no-graph', '--limit', String(ops(h, repo).length - before.length), '-T', 'workspace_name ++ " " ++ snapshot ++ "\\n"').trim().split(/\r?\n/)
        expect(since.every((l) => !l.startsWith('default@'))).toBe(true)
        expect(h.jj(repo, '--ignore-working-copy', 'diff', '--summary', '-r', 'default@').trim()).toBe('')
        // Full files (not the control's empty sparse set), the store's only repository, colocated as the project.
        expect(readFileSync(join(folder, 'base.txt'), 'utf8')).toBe('base\n')
        expect(readFileSync(join(folder, '.jj', 'repo'), 'utf8').trim()).not.toBe('')
        expect(existsSync(join(folder, '.jj', 'repo', 'store'))).toBe(false)
        expect(existsSync(join(folder, '.git'))).toBe(colocated)
        const listed = await h.port.list(repo)
        expect(listed?.map((l) => l.path.toLowerCase())).toEqual(expect.arrayContaining([real(folder).toLowerCase(), real(folderB).toLowerCase()]))
        expect(listed?.every((l) => l.line === null)).toBe(true)
        // Its head: the commit it was made at (its working copy an empty child), no line.
        expect(await h.port.head(folder)).toBe(base)
        expect(await h.port.line(folder)).toBeNull()
        expect(h.port.checkout(folder)).toBeNull()
        expect(isUnknown(await h.port.dirty(folder))).toBe(true)
        const id = await h.port.identity!(folder)
        expect(id).toMatchObject({ workspace: h.port.nameFor(repo, folder) })
        // A folder that exists, or inside another repository, is refused.
        expect((await h.port.create(repo, folder, base)).err).toBe(JJ_REFUSED.exists)
      })

      it('two agents in two workspaces: both kept, each recorded only by its holder; the line operations refused', async () => {
        const h = harness()
        const { repo, root, base } = h.repo('two', colocated)
        const a = join(root, 'slot-a')
        const b = join(root, 'slot-b')
        await h.port.create(repo, a, base)
        await h.port.create(repo, b, base)
        writeFileSync(join(a, 'a.txt'), 'A\n')
        writeFileSync(join(b, 'b.txt'), 'B\n')
        // Each agent's own jj commands, at once.
        await Promise.all([Promise.resolve().then(() => h.jj(a, 'describe', '-m', 'agent A')), Promise.resolve().then(() => h.jj(b, 'describe', '-m', 'agent B'))])
        const idA = await h.port.identity!(a)
        const idB = await h.port.identity!(b)
        expect(await h.port.record!(a, yes, idA)).toEqual(['a.txt'])
        expect(await h.port.record!(b, yes, idB)).toEqual(['b.txt'])
        // A lost fence, or another workspace's identity, records nothing.
        expect(isUnknown(await h.port.record!(a, no, idA))).toBe(true)
        expect(isUnknown(await h.port.record!(a, yes, idB))).toBe(true)
        // jj has no checked-out line: every line operation refused, never mapped to a near equivalent (R5.2).
        expect((await h.port.prepare(a, 'card', base)).err).toBe(JJ_REFUSED.line)
        // A detach settles one card's binding (HI-2866): without one named (and bound), refused.
        expect((await h.port.detach(a, base)).err).toBe(JJ_REFUSED.notBound)
        expect((await h.port.dropLine(repo, 'main', base)).err).toBe(JJ_REFUSED.line)
      })

      it('a stale workspace with a local edit: unknown to every read and to record, never cleaned, the edit left where it is', async () => {
        const h = harness()
        const { repo, root, base } = h.repo('stale', colocated)
        const a = join(root, 'slot-a')
        await h.port.create(repo, a, base)
        // Another workspace rewrites slot-a's working copy (a rebase onto a new change), then the agent edits.
        h.jj(repo, 'new', base, '-m', 'dest')
        writeFileSync(join(repo, 'dest.txt'), 'd\n')
        h.jj(repo, 'rebase', '-r', `${h.port.nameFor(repo, a)}@`, '-d', '@')
        writeFileSync(join(a, 'local.txt'), 'mine\n')
        const before = ops(h, repo)
        expect(await h.port.stale(a)).toBe(true)
        const head = await h.port.head(a)
        expect(isUnknown(head) && head.detail).toBe(JJ_REFUSED.stale)
        const rec = await h.port.record!(a, yes, await h.port.identity!(a))
        expect(isUnknown(rec) && rec.detail).toBe(JJ_REFUSED.stale)
        // Nothing written: no snapshot, no update-stale, no reconcile.
        expect(ops(h, repo)).toEqual(before)
        expect(readFileSync(join(a, 'local.txt'), 'utf8')).toBe('mine\n')
        // Removal refuses a stale slot.
        const id = (await h.port.identity!(a))!
        expect((await h.port.remove(repo, a, { identity: id, journal: h.journals.of('r') })).err).toBe(JJ_REFUSED.stale)
        expect(existsSync(join(a, 'local.txt'))).toBe(true)
      })

      it('a divergent workspace (its change rewritten from two operations): head unknown, never reusable', async () => {
        const h = harness()
        const { repo, root, base } = h.repo('div', colocated)
        const a = join(root, 'slot-a')
        await h.port.create(repo, a, base)
        const name = h.port.nameFor(repo, a)
        const op = ops(h, repo)[0]
        h.jj(repo, '--at-op', op, 'describe', '-r', `${name}@`, '-m', 'one')
        h.jj(repo, '--at-op', op, 'describe', '-r', `${name}@`, '-m', 'two')
        // Two op heads: every pinned read refuses until something merges them.
        const head1 = await h.port.head(a)
        expect(isUnknown(head1)).toBe(true)
        h.jj(repo, 'log', '-r', '@', '--no-graph', '-T', '""') // an agent's command reconciles them
        const head2 = await h.port.head(a)
        expect(isUnknown(head2)).toBe(true)
      })

      it('removal with ignored files: forget read back, the generation checked, then the folder to the Recycle Bin, node_modules with it', async () => {
        const h = harness()
        const { repo, root, base } = h.repo('remove', colocated)
        const a = join(root, 'slot-a')
        await h.port.create(repo, a, base)
        mkdirSync(join(a, 'node_modules', 'x'), { recursive: true })
        writeFileSync(join(a, 'node_modules', 'x', 'index.js'), '//\n')
        const id = (await h.port.identity!(a))!
        expect(await h.port.record!(a, yes, id)).toEqual([])
        expect(await h.port.remove(repo, a, { identity: id, journal: h.journals.of('r') })).toEqual({ ok: true, err: '' })
        expect(existsSync(a)).toBe(false)
        expect(h.trashed.map((p) => p.toLowerCase())).toEqual([a.toLowerCase()])
        expect((await h.port.list(repo))?.some((l) => l.path.toLowerCase() === real(root).toLowerCase() + '\\slot-a')).toBe(false)
        expect(h.journals.rows.size).toBe(1) // only the control's record left
      })

      it('a crash between forget and the trash resumes at the trash; a folder replaced at the same path with the same name in the same store is never trashed', async () => {
        const h = harness()
        const { repo, root, base } = h.repo('crash', colocated)
        const a = join(root, 'slot-a')
        await h.port.create(repo, a, base)
        const id = (await h.port.identity!(a))!
        const crashing = h.portWith({ hooks: { afterForget: () => { throw new Error('crash') } } })
        await expect(crashing.remove(repo, a, { identity: id, journal: h.journals.of('r') })).rejects.toThrow('crash')
        expect(h.journals.of('r').read()).toMatchObject({ phase: 'forgotten' })
        expect(existsSync(a)).toBe(true)
        // Resumed by a new process: trashed.
        expect((await h.portWith().remove(repo, a, { identity: id, journal: h.journals.of('r') })).ok).toBe(true)
        expect(existsSync(a)).toBe(false)

        // Same store, same name, same root, made again outside Combwork after a forget: another generation.
        const b = join(root, 'slot-b')
        await h.port.create(repo, b, base)
        const idB = (await h.port.identity!(b))!
        const replacing = h.portWith({
          hooks: {
            afterForget: async (folder) => {
              h.trashed.length = 0
              const { rmSync } = await import('fs')
              rmSync(folder, { recursive: true, force: true })
              h.jj(repo, 'workspace', 'add', folder, '--name', idB.workspace, '-r', base, colocated ? '--colocate' : '--no-colocate')
            }
          }
        })
        const r = await replacing.remove(repo, b, { identity: idB, journal: h.journals.of('rb') })
        expect(r).toEqual({ ok: false, err: JJ_REFUSED.identity })
        expect(existsSync(join(b, 'base.txt'))).toBe(true)
        expect(h.trashed).toEqual([])
        expect(h.journals.of('rb').read()).toMatchObject({ phase: 'forgotten' })
        expect(await generationOf(b)).not.toBe(idB.generation)
      })

      it('an immutable check copy: exactly the revision; reset drops stray files, keeps ignored ones; a source rewrite during a run moves nothing on disk and fails the verification', async () => {
        const h = harness()
        const { repo, root, base } = h.repo('copy', colocated)
        // The builder's change R, in its own slot.
        const slot = join(root, 'slot-a')
        await h.port.create(repo, slot, base)
        writeFileSync(join(slot, 'work.txt'), 'v1\n')
        h.jj(slot, 'commit', '-m', 'R')
        const R = h.id(slot, '@-')
        const copy = join(root, 'copies', 'copy-1')
        mkdirSync(join(root, 'copies'))
        expect((await h.port.create(repo, copy, R)).ok).toBe(true)
        const id: WorkspaceIdentity = (await h.port.identity!(copy))!
        expect(await h.port.copyIntact!(copy, R, yes, id)).toBe(true)
        // Stray and ignored files, then a reset (under the copy's warm op): the stray goes, the ignored stays.
        writeFileSync(join(copy, 'stray.txt'), 'x\n')
        mkdirSync(join(copy, 'node_modules'))
        writeFileSync(join(copy, 'node_modules', 'dep.js'), '//\n')
        expect(await h.port.resetTo(copy, R, { identity: id, fence: yes })).toEqual({ ok: true })
        expect(existsSync(join(copy, 'stray.txt'))).toBe(false)
        expect(existsSync(join(copy, 'node_modules', 'dep.js'))).toBe(true)
        expect(await h.port.copyIntact!(copy, R, yes, id)).toBe(true)
        // A live run: the builder rewrites R. Nothing resets the copy; its files stay R's; the verification after the run fails.
        writeFileSync(join(slot, 'work.txt'), 'v2\n')
        h.jj(slot, 'squash', '--into', '@-')
        expect(h.id(slot, '@-')).not.toBe(R)
        expect(readFileSync(join(copy, 'work.txt'), 'utf8')).toBe('v1\n')
        expect(await h.port.copyIntact!(copy, R, yes, id)).toBe(false)
        expect(readFileSync(join(copy, 'work.txt'), 'utf8')).toBe('v1\n')
        // A stale copy is never reset: disposed of (forget + trash), no snapshot.
        expect((await h.port.resetTo(copy, R, { identity: id, fence: yes })).ok).toBe(false)
        expect((await h.port.remove(repo, copy, { force: true, identity: id, journal: h.journals.of('c') })).ok).toBe(true)
        expect(existsSync(copy)).toBe(false)
      })

      it('an unsnapshotted edit in a copy, @ and its parent otherwise unchanged: the read says nothing, the verification records it and fails', async () => {
        const h = harness()
        const { repo, root, base } = h.repo('unsnap', colocated)
        const copy = join(root, 'copy-1')
        await h.port.create(repo, copy, base)
        const id = (await h.port.identity!(copy))!
        writeFileSync(join(copy, 'base.txt'), 'changed\n')
        expect(await h.port.head(copy)).toBe(base)
        expect(await h.port.copyIntact!(copy, base, yes, id)).toBe(false)
      })
    })
  }

  it('a reset is an owned change: a replacement at the same root (same name, same store) or a lost fence is refused with nothing written', async () => {
    const h = harness()
    const { repo, root, base } = h.repo('ownreset', true)
    const copy = join(root, 'copy-1')
    await h.port.create(repo, copy, base)
    const id = (await h.port.identity!(copy))!
    // A lost fence: refused before any write.
    const before = ops(h, repo)
    expect(await h.port.resetTo(copy, base, { identity: id, fence: no })).toMatchObject({ ok: false, err: JJ_REFUSED.fence })
    expect(ops(h, repo)).toEqual(before)
    // Replaced outside Combwork (forgotten, a new workspace of the same name at the same root) with work in it.
    const { rmSync } = await import('fs')
    h.jj(repo, 'workspace', 'forget', id.workspace)
    rmSync(copy, { recursive: true, force: true })
    h.jj(repo, 'workspace', 'add', copy, '--name', id.workspace, '-r', base, '--colocate')
    writeFileSync(join(copy, 'theirs.txt'), 'theirs\n')
    const mid = ops(h, repo)
    expect(await h.port.resetTo(copy, base, { identity: id, fence: yes })).toMatchObject({ ok: false, err: JJ_REFUSED.identity })
    expect(isUnknown(await h.port.record!(copy, yes, id))).toBe(true)
    expect(ops(h, repo)).toEqual(mid)
    expect(readFileSync(join(copy, 'theirs.txt'), 'utf8')).toBe('theirs\n')
  })

  it('removal: the store lock taken over before its callback leaves the registration, the files and the journal untouched', async () => {
    const h = harness()
    const { repo, root, base } = h.repo('lockremove', false)
    const a = join(root, 'slot-a')
    await h.port.create(repo, a, base)
    const id = (await h.port.identity!(a))!
    let held = true
    const taking = h.portWith({ lock: async (_s, fn) => ((held = false), fn()) })
    const r = await taking.remove(repo, a, { identity: id, journal: h.journals.of('lr'), fence: { still: () => held } })
    expect(r).toEqual({ ok: false, err: JJ_REFUSED.fence })
    expect(h.jj(repo, '--ignore-working-copy', 'workspace', 'list', '-T', 'name ++ "\\n"')).toContain(id.workspace)
    expect(existsSync(join(a, 'base.txt'))).toBe(true)
    expect(h.journals.of('lr').read()).toBeNull()
  })

  it('the control workspace is made only when no agent works in the project folder (its hold), and is never a slot', async () => {
    const h = harness({ busy: 'p|a1' })
    const { repo, root, base } = h.repo('control', false)
    expect((await h.port.create(repo, join(root, 'slot-a'), base)).err).toBe(JJ_REFUSED.control)
    expect(readdirSync(root)).toEqual([])
  })
})
