// Shared notes written by several agents at once (#349): a write naming the revision it read is refused once the note
// has changed, so a rewrite never drops another agent's update; appends keep every entry.
import { writeFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { writeTextUnlessChanged } from '../src/main/fsutil'
import { NoteConflict, noteRevision, readNote, writeNote } from '../src/main/notes'
import { noteText, noteWrittenText } from '../src/shared/toolReplies'
import { tempDir } from './tempDir'

const base = tempDir('cw-notes-')
let n = 0
const note = (text: string | null): string => {
  const p = join(base, `note-${++n}.md`)
  if (text !== null) writeFileSync(p, text)
  return p
}

describe('shared note writes', () => {
  it('refuses the second of two writers that read the same revision, and loses nothing', async () => {
    const p = note('# Status\n\n- alpha: idle\n- beta: idle\n')
    const read = await readNote(p)
    expect(read.revision).toBe(noteRevision(read.content))
    // Both edit their own line of what they read, and write at once.
    const a = writeNote(p, 'status.md', read.content.replace('alpha: idle', 'alpha: building'), { expectedRevision: read.revision })
    const b = writeNote(p, 'status.md', read.content.replace('beta: idle', 'beta: testing'), { expectedRevision: read.revision })
    const [ra, rb] = await Promise.allSettled([a, b])
    expect(ra.status).toBe('fulfilled')
    expect(rb.status).toBe('rejected')
    const conflict = (rb as PromiseRejectedResult).reason as NoteConflict
    expect(conflict).toBeInstanceOf(NoteConflict)
    const now = await readNote(p)
    expect(conflict.current).toBe(now.revision)
    expect(conflict.message).toContain(`expectedRevision ${now.revision}`)
    expect(now.content).toContain('alpha: building')
    // The refused writer re-reads, merges and retries with the revision it was given.
    const merged = await writeNote(p, 'status.md', now.content.replace('beta: idle', 'beta: testing'), { expectedRevision: conflict.current! })
    const end = await readFile(p, 'utf8')
    expect(end).toContain('alpha: building')
    expect(end).toContain('beta: testing')
    expect(merged.revision).toBe(noteRevision(end))
  })

  it('writes without a revision as before, creating or replacing the note', async () => {
    const p = note(null)
    const first = await writeNote(p, 'new.md', 'one')
    expect(await readFile(p, 'utf8')).toBe('one')
    expect(first.revision).toBe(noteRevision('one'))
    await writeNote(p, 'new.md', 'two')
    expect(await readFile(p, 'utf8')).toBe('two')
  })

  it('refuses an empty revision rather than writing unguarded', async () => {
    const p = note('kept\n')
    await expect(writeNote(p, 'kept.md', 'lost?', { expectedRevision: '' })).rejects.toBeInstanceOf(NoteConflict)
    expect(await readFile(p, 'utf8')).toBe('kept\n')
  })

  it('refuses a revision for a note that no longer exists', async () => {
    const p = note(null)
    await expect(writeNote(p, 'gone.md', 'x', { expectedRevision: noteRevision('x') })).rejects.toMatchObject({ current: null, message: expect.stringMatching(/no longer exists/) })
  })

  it('keeps both entries of two appends at once', async () => {
    const p = note('# Log\n')
    await Promise.all([writeNote(p, 'log.md', '- 2026-10-07 alpha: one', { append: true }), writeNote(p, 'log.md', '- 2026-10-07 beta: two', { append: true })])
    const text = await readFile(p, 'utf8')
    expect(text).toContain('alpha: one')
    expect(text).toContain('beta: two')
  })

  it("shares the editor's save lock: a note an agent changed isn't saved over by the editor", async () => {
    const p = note('draft\n')
    const opened = await readFile(p, 'utf8')
    const agent = writeNote(p, 'shared.md', 'agent\n', { expectedRevision: noteRevision(opened) })
    const editor = writeTextUnlessChanged(p, 'user\n', opened)
    const [ra, re] = await Promise.allSettled([agent, editor])
    expect(ra.status).toBe('fulfilled')
    expect(re.status === 'rejected' && /CONFLICT/.test(String(re.reason))).toBe(true)
    expect(await readFile(p, 'utf8')).toBe('agent\n')
  })

  it('gives the revision in lean replies', () => {
    expect(noteText({ path: 'a.md', content: 'x', revision: 'abc123def456' })).toBe('a.md (revision abc123def456)\n\nx')
    expect(noteText({ path: 'a.md', content: 'x' })).toBe('a.md\n\nx')
    expect(noteWrittenText('a.md', 2500, false, 'abc123def456')).toBe('Wrote a.md (2,500 characters, revision abc123def456).')
    expect(noteWrittenText('a.md', 500, true, 'abc123def456')).toBe('Appended 500 characters to a.md (revision abc123def456).')
  })
})
