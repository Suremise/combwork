// HI-2556 (HR2's round 1): a card's own work, as a change of its Merges into reads it, in a real slot: its line's commits,
// and what its slot holds uncommitted (tracked or not), as its put back left it. A card with none has its old line
// dropped (never while a folder has it checked out), so its next start makes a fresh line from the new target, never
// carrying the old target's history.
import { afterEach, describe, expect, it } from 'vitest'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { B1, commit, moved, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { dropEmptyLines, hasOwnWork } from '../../src/main/workflow/targets'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

/** A Pair project with 1.2.0 a commit ahead of main (its own history), and a card started in its slot, then put back. */
async function putBack() {
  const e = (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [] }))
  sh(e.project, 'checkout', '-q', '-b', '1.2.0')
  commit(e.project, { 'release.txt': '1.2.0 only\n' }, '1.2.0 only')
  sh(e.project, 'checkout', '-q', 'main')
  commit(e.project, { 'main.txt': 'main only\n' }, 'main only')
  const card = e.wf.createCard({ title: 'Retargeted' })
  moved(await e.wf.start(card.key, B1))
  const s = e.wf.state(card)
  const folder = e.wf.folderOf(s)
  expect(s.started).toMatchObject({ target: 'main' })
  expect(folder).not.toBe(e.project)
  moved(await e.wf.putBack(card.key, B1))
  return { e, card, folder, line: s.started!.line! }
}

describe("a card's own work, for a change of its Merges into (HI-2556)", () => {
  it('counts what its slot holds uncommitted, tracked or not, while the slot is still on its line', async () => {
    const { e, card, folder } = await putBack()
    const s = () => e.wf.state(card)
    expect(await hasOwnWork(e.project, s(), folder)).toBe(false)
    writeFileSync(join(folder, 'untracked.txt'), 'new\n')
    expect(await hasOwnWork(e.project, s(), folder)).toBe(true)
    sh(folder, 'add', 'untracked.txt')
    expect(await hasOwnWork(e.project, s(), folder)).toBe(true)
    sh(folder, 'reset', '-q', '--hard')
    expect(await hasOwnWork(e.project, s(), folder)).toBe(false)
    // A commit of its own on its line.
    commit(folder, { 'work.txt': 'work\n' }, 'work')
    expect(await hasOwnWork(e.project, s(), folder)).toBe(true)
  })

  it('drops an empty old line (never while checked out), so the next start on 1.2.0 makes a fresh line without main’s history', async () => {
    const { e, card, folder, line } = await putBack()
    const s = () => e.wf.state(card)
    // Its slot still has the line checked out: refused, nothing deleted.
    expect(sh(folder, 'branch', '--show-current')).toBe(line)
    expect(await dropEmptyLines(e.project, s(), ['main', '1.2.0'])).toEqual({ checkedOut: expect.any(String) })
    expect(sh(e.project, 'branch', '--list', line)).not.toBe('')
    sh(folder, 'switch', '-q', '--detach', 'main')
    expect(await dropEmptyLines(e.project, s(), ['main', '1.2.0'])).toBeNull()
    expect(sh(e.project, 'branch', '--list', line)).toBe('')
    // Retargeted (the board's column, as tasks.setTarget writes it) and started again: from 1.2.0's head, main's own
    // commit nowhere in its line.
    e.wf.store.updateCard(card.id, { target: '1.2.0' })
    moved(await e.wf.start(card.key, B1))
    const again = e.wf.state(card)
    expect(again.started).toMatchObject({ target: '1.2.0', base: sh(e.project, 'rev-parse', '1.2.0') })
    const mainOnly = sh(e.project, 'log', '-1', '--format=%H', 'main')
    expect(sh(e.project, 'branch', '--contains', mainOnly, '--list', again.started!.line!)).toBe('')
  })
})
