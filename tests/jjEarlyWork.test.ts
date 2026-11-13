// HI-3115 (Darren's decision B, design HI-3115/s42): a jj lane's next card whose builder worked in the slot before it was
// prepared. The protection of that work stays: the preparation waits (a retry with the evidence, never an error or
// SlotPrepareFailed), nothing there is changed, and the advice's commands, built from full ids frozen at the inspected
// operation, are run exactly as printed (through PowerShell): `jj new <base>` sets the work aside, the next pass prepares
// the same cycle, and the printed bring-back puts exactly the early work under the card. Real jj, the real SlotPool.
import { writeFileSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { fileSlotConn, SlotPool, SlotStore, type OpHolder } from '../src/main/slots'
import { gitHistory } from '../src/main/platform/gitHistory'
import { boardPrepStore, jjLineKey } from '../src/main/platform/jjSlotPrep'
import { JJ_REFUSED } from '../src/main/platform/jjWorkspacePort'
import type { HeldWork } from '../src/main/platform/workspacePort'
import { heldTold } from '../src/main/slotCards'
import { admitted } from './admitted'
import { harness, jjExe } from './jjWorkspaceHarness'
import { tempDir } from './tempDir'

const closers: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c()
})

function world(colocated: boolean) {
  const h = harness()
  const { repo, root } = h.repo('early', colocated)
  const ws = join(tempDir('jjearly-'), 'ws')
  const dismiss = admitted(ws)
  workspaceDb(ws)
  const conn = fileSlotConn(boardFile(ws))
  closers.push(() => {
    conn.close()
    closeBoard(ws)
    dismiss()
  })
  const prep = boardPrepStore(conn)
  const port = h.portWith({ prep: () => prep, contains: (s, t, c, at) => gitHistory.contains(s, t, c, at) })
  const holder: OpHolder = { self: async () => ({ pid: 1, started: 1001 }), alive: async () => true, live: new Set() }
  const runner = async (): Promise<{ ok: boolean; exitCode: number; logPath: null; settled: boolean }> => ({ ok: true, exitCode: 0, logPath: null, settled: true })
  const store = new SlotStore(conn, 'p-jj')
  const pool = new SlotPool({ store, workspaces: port, project: repo, root, options: async () => ({ setup: '', archive: '', copy: '' }), builders: () => 2, cap: () => 4, runner, settle: async () => true, holder, sessionIn: () => null })
  closers.push(() => pool.close())
  return { h, repo, port, pool, store }
}

/**
 * A lane's slot through card 1: `n` commits submitted, then integrated into main by moving the bookmark (`move`), as a
 * squash of them all (`squash`), or replayed one by one onto main (`replay`); `none`: not integrated.
 */
async function card1(w: ReturnType<typeof world>, integrate: 'move' | 'squash' | 'replay' | 'none', n = 1) {
  const lent = await w.pool.lend({ lane: 'lane-1', agent: 'a-1' }, { target: 'main' })
  if (!lent.ok) throw new Error('not lent')
  const row = w.store.slot(lent.slot.name)!
  const ws = row.identity!.workspace
  const base1 = w.h.id(w.repo, 'main')
  expect(await w.pool.prepare(lent.lease.id, { line: jjLineKey(ws, 1, 1), base: base1, install: false, target: 'main', ready: async () => null })).toMatchObject({ ok: true })
  const subs: string[] = []
  for (let i = 1; i <= n; i++) {
    writeFileSync(join(row.folder, `one-${i}.txt`), `one ${i}\n`)
    w.h.jj(row.folder, 'commit', '-m', `card 1, part ${i}`)
    subs.push(w.h.id(row.folder, `${ws}@-`))
  }
  await w.port.submitted(row.folder, jjLineKey(ws, 1, 1), subs, row.identity, 1)
  if (integrate === 'move') w.h.jj(w.repo, '--ignore-working-copy', 'bookmark', 'set', 'main', '-r', subs.at(-1)!)
  else if (integrate === 'squash' || integrate === 'replay') {
    // Copies of card 1's commits onto main (its originals left where they are, in no target's ancestry).
    w.h.jj(w.repo, '--ignore-working-copy', 'duplicate', '-r', subs.join('|'), '--onto', base1)
    const copy = (i: number): string => w.h.id(w.repo, `description(exact:"card 1, part ${i}\n") ~ ${subs[i - 1]}`)
    if (integrate === 'squash' && n > 1) {
      // Squashed: its later copies folded into the first, one commit on main with all of card 1's content.
      const first = copy(1)
      w.h.jj(w.repo, '--ignore-working-copy', 'squash', '--from', Array.from({ length: n - 1 }, (_, i) => copy(i + 2)).join('|'), '--into', first, '-m', 'card 1, squashed')
      w.h.jj(w.repo, '--ignore-working-copy', 'bookmark', 'set', 'main', '-r', 'description(exact:"card 1, squashed\n")')
    } else w.h.jj(w.repo, '--ignore-working-copy', 'bookmark', 'set', 'main', '-r', copy(n))
  }
  const line2 = jjLineKey(ws, 2, 1)
  const prepare2 = () => w.pool.prepare(lent.lease.id, { line: line2, base: w.h.id(w.repo, 'main'), install: false, target: 'main', ready: async () => null })
  return { lent, row, ws, subs, line2, prepare2 }
}

/** Runs a printed command in `cwd` through PowerShell, exactly as printed (the jj on its PATH being the tested one). */
function ps(cwd: string, line: string): string {
  const cmd = line.replace(/^jj /, `& '${jjExe!.replace(/'/g, "''")}' --config user.name=t --config user.email=t@t.invalid `)
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { cwd, encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error(`${line}: ${r.stderr}`)
  return r.stdout
}
/** The commands a hold's advice prints, as printed (its English, the builder's). */
function printed(held: HeldWork, reason = JJ_REFUSED.unintegrated): { aside: string; bring: string; squash: string | null; inspect: string | null } {
  const text = heldTold(held, reason, 'slot-a', 'AM-2', 'B1', false).english
  const arg = "('(?:[^']|'')*'|[^\\s']+)"
  const aside = new RegExp(`jj new ${arg}`).exec(text)![0]
  const bring = new RegExp(`jj rebase -r ${arg} -B '@'`).exec(text)![0]
  const squash = new RegExp(`jj squash --from ${arg} --into '@'`).exec(text)?.[0] ?? null
  const inspect = new RegExp(`jj log -r ${arg}`).exec(text)?.[0] ?? null
  return { aside, bring, squash, inspect }
}

describe.skipIf(!jjExe)("a jj lane's next card, its builder at work before its slot is prepared (HI-3115, decision B)", { timeout: 300_000 }, () => {
  it.each([true, false])('colocated %s: nothing early → prepared (the control)', async (colocated) => {
    const w = world(colocated)
    const c = await card1(w, 'move')
    expect(await c.prepare2()).toMatchObject({ ok: true })
  })

  it.each([
    [true, 'squash'],
    [true, 'replay'],
    [false, 'squash']
  ] as const)("colocated %s, a 3-commit last card integrated by %s, two early commits: held with exactly them; the printed commands set them aside, the same cycle is prepared, and bring exactly them under the card", async (colocated, how) => {
    const w = world(colocated)
    const c = await card1(w, how, 3)
    for (const f of ['two', 'three']) {
      writeFileSync(join(c.row.folder, `${f}.txt`), `${f}\n`)
      w.h.jj(c.row.folder, 'commit', '-m', `card 2, early ${f}`)
    }
    const early = [w.h.id(c.row.folder, `${c.ws}@--`), w.h.id(c.row.folder, `${c.ws}@-`)]
    const r = await c.prepare2()
    expect(r).toHaveProperty('retry')
    expect(r).not.toHaveProperty('error')
    const held = (r as { heldWork: HeldWork }).heldWork
    expect(held).toMatchObject({ why: 'extra', commits: early, edits: null })
    for (const s of c.subs) expect(held.commits).not.toContain(s)
    // Nothing changed by the wait: the early commits at the same ids, with their content.
    expect(w.h.id(c.row.folder, `${c.ws}@-`)).toBe(early[1])
    const cmd = printed(held)
    ps(c.row.folder, cmd.aside)
    expect(await c.prepare2()).toMatchObject({ ok: true })
    // Combwork's preparation rewrote nothing of the saved work: the same ids, the same content.
    for (const id of early) expect(w.h.id(c.row.folder, id)).toBe(id)
    expect(w.h.jj(c.row.folder, 'file', 'show', '-r', early[1], 'three.txt').trim()).toBe('three')
    // The printed bring-back, as is: exactly the early work under the card's working copy (ids may change: content and ancestry).
    ps(c.row.folder, cmd.bring)
    const under = w.h.jj(c.row.folder, 'log', '--no-graph', '-r', `::${c.ws}@- ~ ::main`, '-T', 'description').trim()
    expect(under).toBe('card 2, early three\ncard 2, early two')
    expect(w.h.jj(c.row.folder, 'file', 'show', '-r', `${c.ws}@`, 'two.txt').trim()).toBe('two')
  })

  it('only an edit: held after its record (the edits as their recorded commit); the printed squash brings them into the prepared card', async () => {
    const w = world(true)
    const c = await card1(w, 'move')
    writeFileSync(join(c.row.folder, 'two.txt'), 'two, not committed\n')
    const r = await c.prepare2()
    expect(r).toMatchObject({ held: JJ_REFUSED.unintegrated })
    const held = (r as { heldWork: HeldWork }).heldWork
    expect(held).toMatchObject({ why: 'extra', commits: [] })
    expect(held.edits).toMatch(/^[0-9a-f]{40}$/)
    const cmd = printed(held)
    ps(c.row.folder, cmd.aside)
    expect(await c.prepare2()).toMatchObject({ ok: true })
    expect(w.h.jj(c.row.folder, 'file', 'show', '-r', held.edits!, 'two.txt').trim()).toBe('two, not committed')
    ps(c.row.folder, cmd.squash!)
    expect(w.h.jj(c.row.folder, 'file', 'show', '-r', `${c.ws}@`, 'two.txt').trim()).toBe('two, not committed')
  })

  it("the last card's work not integrated: held, notIntegrated, nothing changed; integrated, the same cycle is prepared", async () => {
    const w = world(true)
    const c = await card1(w, 'none')
    const r = await c.prepare2()
    expect(r).toMatchObject({ held: JJ_REFUSED.notIntegrated, heldWork: { why: 'notIntegrated' } })
    w.h.jj(w.repo, '--ignore-working-copy', 'bookmark', 'set', 'main', '-r', c.subs.at(-1)!)
    expect(await c.prepare2()).toMatchObject({ ok: true })
  })

  it('the pre-check, its builder still in the slot: committed early work found without recording the folder; edits never claimed', async () => {
    const w = world(true)
    const c = await card1(w, 'move')
    writeFileSync(join(c.row.folder, 'two.txt'), 'two\n')
    w.h.jj(c.row.folder, 'commit', '-m', 'card 2, early')
    const early = w.h.id(c.row.folder, `${c.ws}@-`)
    writeFileSync(join(c.row.folder, 'draft.txt'), 'not recorded\n')
    const ops = w.h.jj(c.row.folder, '--ignore-working-copy', 'op', 'log', '--no-graph', '-T', 'id ++ "\\n"')
    const held = await w.pool.heldEarly(c.lent.lease.id, c.line2, w.h.id(w.repo, 'main'))
    expect(held).toMatchObject({ why: 'extra', commits: [early], edits: null })
    expect(w.h.jj(c.row.folder, '--ignore-working-copy', 'op', 'log', '--no-graph', '-T', 'id ++ "\\n"')).toBe(ops)
  })

  it('more than 20 early commits: the frozen revset the advice prints selects exactly the listed ones', async () => {
    const w = world(true)
    const c = await card1(w, 'move')
    for (let i = 0; i < 21; i++) {
      writeFileSync(join(c.row.folder, `e${i}.txt`), `${i}\n`)
      w.h.jj(c.row.folder, 'commit', '-m', `early ${i}`)
    }
    const r = await c.prepare2()
    const held = (r as { heldWork: HeldWork }).heldWork
    expect(held.commits).toHaveLength(21)
    const cmd = printed(held)
    expect(cmd.inspect).toMatch(/^jj log -r /)
    // Windows PowerShell drops a native argument's inner double quotes, so no template string: each full id is 40 hex.
    const listed = ps(c.row.folder, `${cmd.inspect} --no-graph --reversed -T commit_id`).trim().match(/[0-9a-f]{40}/g)
    expect(listed).toEqual(held.commits)
    expect(cmd.bring).toContain(held.select!.replace(/'/g, "''"))
  })
})
