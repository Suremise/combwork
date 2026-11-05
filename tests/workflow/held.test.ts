// Round 3's review of the spike (#1118, HR2 and HB3): a card's own folder is part of what an intent decides on (an
// uncommitted edit or a checkout during submit, a commit during a requeue), and a trip to On Hold keeps a card able to
// go on: its gate asked again on return, a move out of it counted from where it was.
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'crypto'
import { readFileSync, statSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { B1, B2, commit, locked, moved, R1, refusedBy, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { gitTestHooks } from '../../src/main/git'
import { isRefusal } from '../../src/main/workflow/runtime'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

const pairOpts = { ...preset('git', 'pair'), preChecks: [], mergeChecks: [] }

async function startedIn(e: Env, title: string, labels: string[] = []) {
  const card = e.wf.createCard({ title, labels })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  const folder = s.data!.folder as string
  commit(folder, { [`${title}.txt`]: `${title}\n` }, title)
  return { card, folder }
}

const during = (e: Env, move: string, act: () => void | Promise<void>) => {
  e.wf.cfg.hooks = {
    beforeWrite: async (m) => {
      if (m !== move) return
      e.wf.cfg.hooks = {}
      await act()
    }
  }
}

describe("the card's folder is part of the evidence", () => {
  it('an uncommitted edit while the submit is on its way → refused; the folder is dirty', async () => {
    const e = (env = setup(pairOpts))
    const { card, folder } = await startedIn(e, 'a')
    during(e, 'submit', () => writeFileSync(join(folder, 'a.txt'), 'edited, not committed\n'))
    refusedBy(await e.wf.submit(card.key, B1, { summary: 'x' }), 'evidence.changed')
    expect(e.wf.state(card).stage).toBe('active')
    refusedBy(await e.wf.submit(card.key, B1, { summary: 'x' }), 'submit.clean')
  })

  it('a checkout of another revision while the submit is on its way → refused (the line ref unmoved)', async () => {
    const e = (env = setup(pairOpts))
    const { card, folder } = await startedIn(e, 'a')
    commit(folder, { 'second.txt': '2\n' }, 'second')
    during(e, 'submit', () => void sh(folder, 'checkout', '-q', '--detach', 'HEAD~1'))
    refusedBy(await e.wf.submit(card.key, B1, { summary: 'x' }), 'evidence.changed')
    expect(e.wf.state(card).latest).toBeNull()
  })

  it('a commit while a transient requeue is on its way → refused, never queued on the old pass', async () => {
    const e = (env = setup({ ...pairOpts, mergeChecks: ['quick'], commands: { quick: 'npm run quick' } }))
    sh(e.project, 'checkout', '-q', '--detach')
    const { card, folder } = await startedIn(e, 'a')
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
    await e.queue({ runCheck: async () => ({ ok: false, transient: true, output: 'network' }) }).drain('main')
    expect(e.wf.state(card).stage).toBe('active')
    during(e, 'submit', () => void commit(folder, { 'a.txt': 'unreviewed\n' }, 'sneaked in'))
    refusedBy(await e.wf.submit(card.key, B1, { summary: 'again' }), 'evidence.changed')
    expect(e.wf.state(card).stage).toBe('active')
  })
})

// #1206: the evidence is content, not cached stat data. Git and the files can't be one transaction with SQLite, so a
// change after the transaction's own read is reconciliation's (stale marks), never claimed excluded.
describe('an index refreshed or a file touched meanwhile is no change', () => {
  /** A file's time moved, its content as it was. */
  const touch = (file: string): void => {
    const later = new Date(Date.now() + 5000)
    utimesSync(file, later, later)
  }

  it("an outside git status during the submit (the index's stat data refreshed) → submitted", async () => {
    const e = (env = setup(pairOpts))
    const { card, folder } = await startedIn(e, 'a')
    // Touched before: the index's stat data is stale, so the status rewrites the index.
    touch(join(folder, 'a.txt'))
    const index = join(sh(folder, 'rev-parse', '--path-format=absolute', '--git-dir'), 'index')
    const before = statSync(index).mtimeMs
    during(e, 'submit', () => void sh(folder, 'status', '--porcelain'))
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    expect(statSync(index).mtimeMs).not.toBe(before)
    expect(e.wf.state(card).stage).toBe('review')
  })

  it("a verdict during an outside git status (the index's stat data refreshed) → recorded, every intent alike", async () => {
    const e = (env = setup(pairOpts))
    const { card, folder } = await startedIn(e, 'a')
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.startReview(card.key, R1))
    touch(join(folder, 'a.txt'))
    during(e, 'verdict', () => void sh(folder, 'status', '--porcelain'))
    moved(await e.wf.verdict(card.key, R1, { pass: false, comment: 'no' }))
  })

  it('a file only touched during the submit → submitted', async () => {
    const e = (env = setup(pairOpts))
    const { card, folder } = await startedIn(e, 'a')
    during(e, 'submit', () => touch(join(folder, 'a.txt')))
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  })

  it('a file touched, then edited and put back during the submit → submitted (the same content)', async () => {
    const e = (env = setup(pairOpts))
    const { card, folder } = await startedIn(e, 'a')
    during(e, 'submit', () => {
      writeFileSync(join(folder, 'a.txt'), 'other\n')
      writeFileSync(join(folder, 'a.txt'), 'a\n')
      touch(join(folder, 'a.txt'))
    })
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  })

  it("in a shared folder, another agent staging its own file during the submit → submitted; the builder's own → refused", async () => {
    const e = (env = setup({ ...preset('git', 'pair'), finish: 'committed', folder: 'project', slotsUpToDate: false, preChecks: [], mergeChecks: [], target: '' }))
    const card = e.wf.createCard({ title: 'Mine' })
    const theirs = e.wf.createCard({ title: 'Theirs' })
    moved(await e.wf.start(card.key, B1))
    moved(await e.wf.start(theirs.key, B2))
    // B2's file lock, recorded on its card (#1481): its edits in the shared folder aren't B1's.
    expect(await locked(e.wf, B2, ['theirs.txt'])).toBe(true)
    commit(e.project, { 'theirs.txt': 'theirs\n' }, 'theirs', { trailer: theirs.key })
    commit(e.project, { 'mine.txt': 'mine\n' }, 'mine', { trailer: card.key })
    // An edit to a file already there (a new file would change the folder's own time, which the evidence covers).
    during(e, 'submit', () => {
      writeFileSync(join(e.project, 'theirs.txt'), 'theirs, edited\n')
      sh(e.project, 'add', 'theirs.txt')
    })
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    const other = e.wf.createCard({ title: 'Mine too' })
    moved(await e.wf.start(other.key, B1))
    commit(e.project, { 'mine.txt': 'mine again\n' }, 'mine again', { trailer: other.key })
    during(e, 'submit', () => void sh(e.project, 'rm', '-q', '--cached', 'mine.txt'))
    refusedBy(await e.wf.submit(other.key, B1, { summary: 'y' }), 'evidence.changed')
  })

  it("in a shared folder, a file both agents locked in turn is still the builder's own: edited during the submit → refused (HR6's #1481 round 2)", async () => {
    const e = (env = setup({ ...preset('git', 'pair'), finish: 'committed', folder: 'project', slotsUpToDate: false, preChecks: [], mergeChecks: [], target: '' }))
    const card = e.wf.createCard({ title: 'Mine' })
    const theirs = e.wf.createCard({ title: 'Theirs' })
    moved(await e.wf.start(card.key, B1))
    moved(await e.wf.start(theirs.key, B2))
    commit(e.project, { 'both.txt': 'both\n' }, 'both', { trailer: theirs.key })
    expect([await locked(e.wf, B2, ['both.txt']), await locked(e.wf, B1, ['both.txt'])]).toEqual([true, true])
    commit(e.project, { 'mine.txt': 'mine\n' }, 'mine', { trailer: card.key })
    during(e, 'submit', () => {
      writeFileSync(join(e.project, 'both.txt'), 'both, edited\n')
      sh(e.project, 'add', 'both.txt')
    })
    refusedBy(await e.wf.submit(card.key, B1, { summary: 'x' }), 'evidence.changed')
  })

  // Git, not Combwork, says what content is the same: each path's own attributes and filters (HR5, round 1).
  it('core.autocrlf on, a path marked -text: rewritten with CRLF during the submit → refused (a real edit to git)', async () => {
    const e = (env = setup(pairOpts))
    sh(e.project, 'config', 'core.autocrlf', 'true')
    commit(e.project, { '.gitattributes': 'raw.txt -text\n', 'raw.txt': 'one\ntwo\n' }, 'raw')
    const { card, folder } = await startedIn(e, 'a')
    during(e, 'submit', () => writeFileSync(join(folder, 'raw.txt'), 'one\r\ntwo\r\n'))
    refusedBy(await e.wf.submit(card.key, B1, { summary: 'x' }), 'evidence.changed')
    expect(sh(folder, 'status', '--porcelain')).toContain('raw.txt')
  })

  it('core.autocrlf off, a path marked text eol=crlf: its CRLF copy only touched during the submit → submitted', async () => {
    const e = (env = setup(pairOpts))
    commit(e.project, { '.gitattributes': 'crlf.txt text eol=crlf\n', 'crlf.txt': 'one\ntwo\n' }, 'crlf')
    const { card, folder } = await startedIn(e, 'a')
    expect(readFileSync(join(folder, 'crlf.txt'), 'utf8')).toBe('one\r\ntwo\r\n')
    during(e, 'submit', () => touch(join(folder, 'crlf.txt')))
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  })

  it('an index git can no longer read (an unknown required extension, its checksum valid) → refused', async () => {
    const e = (env = setup(pairOpts))
    const { card, folder } = await startedIn(e, 'a')
    const index = join(sh(folder, 'rev-parse', '--path-format=absolute', '--git-dir'), 'index')
    during(e, 'submit', () => {
      const body = readFileSync(index).subarray(0, -20)
      const ext = Buffer.alloc(8)
      ext.write('abcd', 0, 'latin1')
      const next = Buffer.concat([body, ext])
      writeFileSync(index, Buffer.concat([next, createHash('sha1').update(next).digest()]))
    })
    refusedBy(await e.wf.submit(card.key, B1, { summary: 'x' }), 'evidence.changed')
    expect(() => sh(folder, 'status', '--porcelain')).toThrow()
  })

  it('a version 4 index with neighbouring non-ASCII paths, refreshed by an outside git status → submitted', async () => {
    const e = (env = setup(pairOpts))
    const { card, folder } = await startedIn(e, 'a')
    commit(folder, { 'é/a.txt': '1\n', 'ê/a.txt': '2\n', '日本/a.txt': '3\n', '日本語/b.txt': '4\n', 'z/a.txt': '5\n' }, 'unicode')
    sh(folder, 'update-index', '--index-version', '4')
    touch(join(folder, 'ê', 'a.txt'))
    during(e, 'submit', () => void sh(folder, 'status', '--porcelain'))
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  })

  it("dirty, clean when the guards read, dirty again at the write: the same content as at the start, but never the guards' clean answer → refused (HR5, round 2)", async () => {
    const e = (env = setup(pairOpts))
    const { card, folder } = await startedIn(e, 'a')
    const file = join(folder, 'a.txt')
    writeFileSync(file, 'dirty\n')
    // Just before the submission reads the folder's status: the committed content back.
    gitTestHooks.started = (_cwd, args) => {
      if (!args.includes('status')) return
      delete gitTestHooks.started
      writeFileSync(file, 'a\n')
    }
    // Just before the write: the dirty content again, with a new time.
    during(e, 'submit', () => {
      writeFileSync(file, 'dirty\n')
      touch(file)
    })
    try {
      const r = await e.wf.submit(card.key, B1, { summary: 'x' })
      expect(isRefusal(r)).toBe(true)
    } finally {
      delete gitTestHooks.started
    }
    expect(sh(folder, 'status', '--porcelain')).toContain('a.txt')
    expect(e.wf.state(card).stage).toBe('active')
    expect(e.wf.state(card).latest).toBeNull()
  })

  it('a change staged during the submit (the index entries, not the files) → refused', async () => {
    const e = (env = setup(pairOpts))
    const { card, folder } = await startedIn(e, 'a')
    during(e, 'submit', () => void sh(folder, 'rm', '-q', '--cached', 'a.txt'))
    refusedBy(await e.wf.submit(card.key, B1, { summary: 'x' }), 'evidence.changed')
  })

  it('an edit of the same size during the submit, its time put back to the millisecond → refused (content, not stat)', async () => {
    const e = (env = setup(pairOpts))
    const { card, folder } = await startedIn(e, 'a')
    const file = join(folder, 'a.txt')
    // A time with a part below the millisecond, as a write leaves one: a tool keeping it through a Date puts back the
    // millisecond only, which the stat fingerprint sees, so the content is asked. (A time kept exactly, to the 100 ns,
    // is the fingerprint's practical limit: ARCHITECTURE, "The practical guarantee". A time that happened to be a whole
    // millisecond made this test fail now and then.)
    utimesSync(file, 1_760_000_000.0004, 1_760_000_000.0004)
    during(e, 'submit', () => {
      const st = statSync(file)
      writeFileSync(file, 'b\n')
      utimesSync(file, st.atime, st.mtime)
    })
    refusedBy(await e.wf.submit(card.key, B1, { summary: 'x' }), 'evidence.changed')
  })
})

describe('a trip to On Hold', () => {
  it('You-only review: Review → Hold → Review asks the user again; answering finishes it', async () => {
    const e = (env = setup({ ...pairOpts, review: 'you', noSelfReview: false, finish: 'agentMerges' }))
    const { card } = await startedIn(e, 'a')
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.move(card.key, 'hold', 'user'))
    expect(e.wf.state(card).requests).toEqual([])
    moved(await e.wf.move(card.key, 'review', 'user'))
    const req = e.wf.state(card).requests[0]
    expect(req).toMatchObject({ gate: 'review', stage: 'review' })
    moved(await e.wf.answer(card.key, req.request, 'approved'))
    expect(e.wf.state(card).stage).toBe('approved')
  })

  it('a release card waiting for your OK: Approved → Hold → Approved asks again; the OK queues it', async () => {
    const e = (env = setup({ ...pairOpts, okBefore: { mode: 'labels', labels: ['release'] } }))
    const { card } = await startedIn(e, 'r', ['release'])
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
    moved(await e.wf.move(card.key, 'hold', 'user'))
    moved(await e.wf.move(card.key, 'approved', 'user'))
    const req = e.wf.state(card).requests[0]
    expect(req).toMatchObject({ gate: 'okBefore' })
    moved(await e.wf.answer(card.key, req.request, 'approved'))
    expect(e.wf.state(card).stage).toBe('merging')
  })

  it('Merging → Hold → Approved skips nothing (no question, no override); dragging it to Merging queues it again', async () => {
    const e = (env = setup(pairOpts))
    const { card } = await startedIn(e, 'm')
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
    expect(e.wf.state(card).stage).toBe('merging')
    moved(await e.wf.move(card.key, 'hold', 'user'))
    moved(await e.wf.move(card.key, 'approved', 'user'))
    let s = e.wf.state(card)
    expect(s).toMatchObject({ stage: 'approved', overrides: [] })
    moved(await e.wf.move(card.key, 'merging', 'user'))
    s = e.wf.state(card)
    expect(s).toMatchObject({ stage: 'merging', overrides: [] })
    expect(s.entries.at(-1)?.state).toBe('open')
    expect((await e.queue().drain('main'))[0]).toMatchObject({ outcome: 'integrated' })
  })
})

describe('small points', () => {
  it('a decision resets an override past review: the queue no longer takes it as approved', async () => {
    const e = (env = setup(pairOpts))
    const { card } = await startedIn(e, 'o')
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.move(card.key, 'merging', 'user', { confirm: true, reason: 'hotfix' }))
    expect(e.wf.state(card).approvalOverridden).toBe(true)
    moved(await e.wf.recordDecision(card.key, 'Wait'))
    const s = e.wf.state(card)
    expect(s.approvalOverridden).toBe(false)
    expect(s.stage).toBe('review')
  })

  it('Remove from queue on a card that moved on meanwhile is refused, not reported ok', async () => {
    const e = (env = setup(pairOpts))
    const { card } = await startedIn(e, 'q')
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
    // The user puts it on hold (which cancels its entry) while the removal is on its way.
    during(e, 'remove from queue', async () => void moved(await e.wf.move(card.key, 'hold', 'user')))
    refusedBy(await e.wf.removeFromQueue(card.key, 'not now'), 'move.notFromHere')
    expect(e.wf.state(card).stage).toBe('hold')
    expect(e.kinds(card.id)).not.toContain('Override')
  })
})
