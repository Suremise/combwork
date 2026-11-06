import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { changeOutcome, covered, defenderMovePlan, devDriveOf, emptyStatus, folderPlan, goneExclusions, normPath, parseProbe, pathList, productOn, readableList, statusOf, testsEligible, unsafeFolder, type AvPathKind } from '../src/shared/antivirus'
import { tempDir } from './tempDir'

// Fixtures in the shape main/antivirus.ts's probe prints (Get-MpComputerStatus, Get-MpPreference, Security Center, Get-Volume).
const DEFENDER_ON = 397568 // 0x061100: Windows Defender, on
const NORTON_ON = 266240 // 0x041000: on
const DEFENDER_OFF = 393472 // 0x060100: off
const probe = (over: Record<string, unknown> = {}) => ({
  defender: { antivirus: true, realTime: true, mode: 'Normal' },
  exclusions: ['N/A: Must be an administrator to view exclusions'],
  perfMode: 1,
  products: [{ name: 'Windows Defender', state: DEFENDER_ON }],
  volumes: [{ drive: 'D', fs: 'NTFS' }, { drive: 'C', fs: 'NTFS' }],
  ...over
})
const folders: { path: string; kind: AvPathKind; unsafe?: string }[] = [
  { path: 'D:\\Projects\\ACME', kind: 'workspace' },
  { path: 'D:\\Projects\\ACME.worktrees', kind: 'worktrees' },
  { path: 'C:\\Users\\Dev\\AppData\\Local\\combwork-test', kind: 'tests' }
]
const now = new Date('2026-10-06T18:00:00Z')
type Admin = { at: string; exclusions: string[]; devDrives?: Record<string, 'trusted' | 'untrusted' | 'no'> }
const status = (raw: unknown, opts: { added?: string[]; adminCheck?: Admin; folders?: typeof folders } = {}) => statusOf('D:\\Projects\\ACME', parseProbe(raw), opts.folders ?? folders, { added: opts.added ?? [], adminCheck: opts.adminCheck ?? null, now })
const GUARDED = ['C:\\Users\\Dev', 'C:\\Users\\Dev\\AppData\\Roaming', 'C:\\Users\\Dev\\AppData\\Local', 'C:\\Windows', 'C:\\Program Files', 'C:\\ProgramData', 'C:\\Users\\Public']

describe('antivirus (#316)', () => {
  it('reads the probe: Defender’s hidden list, or one that isn’t a list of paths, is unknown, never empty', () => {
    expect(parseProbe(probe()).exclusions).toBeNull()
    expect(parseProbe(probe({ exclusions: null })).exclusions).toBeNull()
    expect(parseProbe(probe({ exclusions: 'D:\\Projects' })).exclusions).toEqual(['D:\\Projects'])
    expect(parseProbe(probe({ exclusions: [] })).exclusions).toEqual([])
    expect(parseProbe(probe({ exclusions: 42 })).exclusions).toBeNull()
    expect(parseProbe(probe({ exclusions: ['D:\\A', 7] })).exclusions).toBeNull()
    expect(parseProbe(probe({ exclusions: { a: 1 } })).exclusions).toBeNull()
    expect(pathList(undefined)).toBeNull()
    expect(parseProbe(probe({ defender: { antivirus: 'yes' } })).defender).toBeNull()
    expect(parseProbe(null)).toEqual({ defender: null, exclusions: null, performanceMode: null, products: null, volumes: {} })
    expect(parseProbe(probe()).volumes).toEqual({ D: 'NTFS', C: 'NTFS' })
    expect([parseProbe(probe({ perfMode: 0 })).performanceMode, parseProbe(probe()).performanceMode, parseProbe(probe({ perfMode: 'x' })).performanceMode]).toEqual([true, false, null])
  })

  it('a Security Center product is on by its state’s second byte', () => {
    expect([productOn(DEFENDER_ON), productOn(NORTON_ON), productOn(DEFENDER_OFF)]).toEqual([true, true, false])
  })

  it('an exclusion covers its folder and what is inside it, in any case, but not a sibling with a longer name or a variable', () => {
    expect(covered('D:\\Projects\\ACME', ['d:\\projects\\acme\\'])).toBe(true)
    expect(covered('D:\\Projects\\ACME.worktrees', ['D:\\Projects'])).toBe(true)
    expect(covered('D:\\Projects\\ACME.worktrees', ['D:\\Projects\\ACME'])).toBe(false)
    expect(covered('D:/Projects/ACME', ['D:\\Projects\\ACME'])).toBe(true)
    // The 6 Oct manual entry kept "$env:LOCALAPPDATA" literally: it matches nothing.
    expect(covered('C:\\Users\\Dev\\AppData\\Local\\combwork-test', ['$env:LOCALAPPDATA\\combwork-test', '%LOCALAPPDATA%\\combwork-test'])).toBe(false)
    expect(normPath('D:\\A\\B\\')).toBe('d:\\a\\b')
  })

  it('never offers a drive, a share, or a folder that is or holds the home folder, the profile or a system folder', () => {
    expect(unsafeFolder('D:\\', GUARDED)).toMatch(/whole drive/)
    expect(unsafeFolder('D:', GUARDED)).toMatch(/whole drive/)
    expect(unsafeFolder('\\\\server\\share', GUARDED)).toMatch(/network share/)
    expect(unsafeFolder('\\\\server\\share\\work', GUARDED)).toBeNull()
    expect(unsafeFolder('C:\\Users\\Dev', GUARDED)).toMatch(/home folder/)
    expect(unsafeFolder('C:\\Users', GUARDED)).toMatch(/home folder/)
    expect(unsafeFolder('c:\\users\\dev\\appdata\\local\\', GUARDED)).toMatch(/home folder/)
    expect(unsafeFolder('C:\\Windows', GUARDED)).toMatch(/system/)
    expect(unsafeFolder('relative\\path', GUARDED)).toMatch(/absolute/)
    // Inside the home folder is fine: a workspace, or the test area under %LOCALAPPDATA%.
    expect(unsafeFolder('C:\\Users\\Dev\\work', GUARDED)).toBeNull()
    expect(unsafeFolder('C:\\Users\\Dev\\AppData\\Local\\combwork-test', GUARDED)).toBeNull()
  })

  it('the folder set: resolved paths, duplicates dropped, unsafe ones marked, an unresolved root failing closed', () => {
    // A workspace that is a junction to a drive root resolves to it: never offered.
    expect(folderPlan({ root: 'E:\\', trees: null, tests: null }, GUARDED)).toEqual([{ path: 'E:\\', kind: 'workspace', unsafe: 'a whole drive' }])
    expect(folderPlan({ root: 'C:\\Users\\Dev', trees: 'C:\\Users\\Dev.worktrees', tests: null }, GUARDED).map((f) => [f.kind, !!f.unsafe])).toEqual([['workspace', true], ['worktrees', false]])
    expect(folderPlan({ root: null, rootUnresolved: 'D:\\gone', trees: null, tests: null }, GUARDED)).toEqual([{ path: 'D:\\gone', kind: 'workspace', unsafe: 'its real location couldn’t be established' }])
    // The test area resolving to the workspace itself is listed once.
    expect(folderPlan({ root: 'D:\\W', trees: null, tests: 'd:\\w\\' }, GUARDED)).toEqual([{ path: 'D:\\W', kind: 'workspace' }])
  })

  it('Combwork’s test area is for people developing Combwork only: a dev build, or a workspace holding Combwork’s repository', () => {
    expect([testsEligible({ packaged: false, holdsCombwork: false }), testsEligible({ packaged: true, holdsCombwork: true }), testsEligible({ packaged: true, holdsCombwork: false })]).toEqual([true, true, false])
  })

  it('Defender with real-time protection and a hidden list: every folder unknown, and the workspace likely slowed', () => {
    const s = status(probe())
    expect([s.scan, s.realTime, s.exclusionsFrom, s.slowed]).toEqual(['defender', true, null, true])
    expect(s.paths.map((p) => [p.kind, p.state, p.devDrive])).toEqual([['workspace', 'unknown', 'no'], ['worktrees', 'unknown', 'no'], ['tests', 'unknown', 'no']])
    expect(s.offerKey).toBe('c:\\users\\dev\\appdata\\local\\combwork-test|d:\\projects\\acme|d:\\projects\\acme.worktrees')
  })

  it('an unsafe folder is listed but never offered or counted', () => {
    const s = status(probe(), { folders: [{ path: 'D:\\', kind: 'workspace', unsafe: 'a whole drive' }] })
    expect([s.paths[0].unsafe, s.slowed, s.offerKey]).toEqual(['a whole drive', false, ''])
  })

  it('a visible list says which folders are excluded; all of them excluded is not slowed', () => {
    const some = status(probe({ exclusions: ['D:\\Projects\\ACME'] }))
    expect([some.exclusionsFrom, some.paths.map((p) => p.state), some.slowed]).toEqual(['live', ['excluded', 'not-excluded', 'not-excluded'], true])
    const all = status(probe({ exclusions: ['D:\\Projects', 'C:\\Users\\Dev\\AppData\\Local\\combwork-test'] }))
    expect([all.paths.every((p) => p.state === 'excluded'), all.slowed, all.offerKey]).toEqual([true, false, ''])
  })

  it('with the list hidden: what Combwork added counts as excluded (unconfirmed), and an administrator check is used', () => {
    const added = status(probe(), { added: folders.map((f) => f.path.toUpperCase()) })
    expect([added.paths.map((p) => [p.state, p.addedByCombwork]), added.slowed]).toEqual([[['added', true], ['added', true], ['added', true]], false])
    const checked = status(probe(), { adminCheck: { at: '2026-10-06T17:00:00Z', exclusions: ['D:\\Projects\\ACME'] } })
    expect([checked.exclusionsFrom, checked.adminCheckedAt, checked.paths.map((p) => p.state)]).toEqual(['admin-check', '2026-10-06T17:00:00Z', ['excluded', 'not-excluded', 'not-excluded']])
    expect(status(probe({ exclusions: [] }), { adminCheck: { at: 'x', exclusions: ['D:\\Projects'] } }).paths[0].state).toBe('not-excluded')
  })

  it('Dev Drive: ReFS is only a maybe; only a trusted Dev Drive (checked with administrator rights) in performance mode isn’t slowed', () => {
    const refs = status(probe({ volumes: [{ drive: 'D', fs: 'ReFS' }, { drive: 'C', fs: 'ReFS' }] }))
    expect([refs.paths.map((p) => p.devDrive), refs.slowed]).toEqual([['refs', 'refs', 'refs'], true])
    const trusted = { at: 'x', exclusions: [], devDrives: { D: 'trusted' as const, C: 'trusted' as const } }
    expect(status(probe({ perfMode: 0 }), { adminCheck: trusted }).slowed).toBe(false)
    // Performance mode off, or an untrusted Dev Drive: scanned like any other.
    expect(status(probe({ perfMode: 1 }), { adminCheck: trusted }).slowed).toBe(true)
    expect(status(probe({ perfMode: 0 }), { adminCheck: { ...trusted, devDrives: { D: 'untrusted', C: 'untrusted' } } }).paths.map((p) => p.devDrive)).toEqual(['untrusted', 'untrusted', 'untrusted'])
    expect(status(probe({ perfMode: 0 }), { adminCheck: { ...trusted, devDrives: { D: 'untrusted', C: 'untrusted' } } }).slowed).toBe(true)
    expect(status(probe({ volumes: [] })).paths[0].devDrive).toBe('unknown')
    // fsutil devdrv query's answers.
    expect([devDriveOf('This is a trusted developer volume.\r\n'), devDriveOf('This is a developer volume, but it is not trusted.'), devDriveOf('This is not a developer volume.'), devDriveOf('Error 5: Access is denied.'), devDriveOf(null)]).toEqual(['trusted', 'untrusted', 'no', null, null])
  })

  it('another antivirus active, Defender passive or off, real-time off, or nothing readable: Combwork offers nothing', () => {
    const other = status(probe({ defender: { antivirus: true, realTime: true, mode: 'Passive Mode' }, products: [{ name: 'Windows Defender', state: DEFENDER_OFF }, { name: 'Norton Security', state: NORTON_ON }] }))
    expect([other.scan, other.others, other.slowed, other.realTime]).toEqual(['other', ['Norton Security'], false, null])
    expect(status(probe({ defender: { antivirus: false, realTime: false, mode: 'Normal' }, products: [{ name: 'Windows Defender', state: DEFENDER_OFF }] })).scan).toBe('none')
    const off = status(probe({ defender: { antivirus: true, realTime: false, mode: 'Normal' } }))
    expect([off.scan, off.realTime, off.slowed]).toEqual(['defender', false, false])
    expect(status({ defender: null, products: null }).scan).toBe('unavailable')
    expect(emptyStatus('D:\\W', 'test-copy', folders, now)).toMatchObject({ scan: 'test-copy', slowed: false, paths: [{ state: 'unknown' }, { state: 'unknown' }, { state: 'unknown' }] })
  })

  it('an elevated change: declined, failing to start, refused by Defender or by policy, or done', () => {
    const ws = 'D:\\Projects\\ACME'
    const trees = 'D:\\Projects\\ACME.worktrees'
    expect(changeOutcome('add', { started: false, cancelled: true }, null).outcome).toBe('refused')
    expect(changeOutcome('add', { started: false, error: 'boom' }, null)).toMatchObject({ outcome: 'error', message: expect.stringContaining('boom') })
    expect(changeOutcome('add', { started: true }, null).outcome).toBe('error')
    expect(changeOutcome('add', { started: true }, { ok: false, error: 'Operation failed with the following error: 0x800106ba', requested: [ws], listed: true, exclusions: [] }).outcome).toBe('policy')
    expect(changeOutcome('add', { started: true }, { ok: false, error: 'Something else', requested: [ws], listed: true, exclusions: [] }).outcome).toBe('error')
    const done = changeOutcome('add', { started: true }, { ok: true, requested: [ws, trees], listed: true, exclusions: ['d:\\projects\\acme', trees, 'E:\\Other'] })
    expect(done).toMatchObject({ outcome: 'done', added: [ws, trees], exclusions: ['d:\\projects\\acme', trees, 'E:\\Other'] })
    // Accepted but not listed afterwards: a policy keeps local exclusions from applying; only what is listed counts as added.
    expect(changeOutcome('add', { started: true }, { ok: true, requested: [ws, trees], listed: true, exclusions: [ws] })).toMatchObject({ outcome: 'policy', added: [ws] })
    expect(changeOutcome('remove', { started: true }, { ok: true, requested: [ws], listed: true, exclusions: ['E:\\Other'] })).toMatchObject({ outcome: 'done', removed: [ws] })
    expect(changeOutcome('remove', { started: true }, { ok: true, requested: [ws], listed: true, exclusions: [ws] }).outcome).toBe('policy')
    expect(changeOutcome('check', { started: true }, { ok: true, listed: true, exclusions: 'D:\\Projects', devDrives: { D: 'This is a trusted developer volume.', z: 'x', E: 'Access is denied' } })).toMatchObject({ outcome: 'done', exclusions: ['D:\\Projects'], devDrives: { D: 'trusted' } })
  })

  it('pre-existing exclusions are the user’s: Add asks only for what isn’t covered, and only what Defender lists afterwards counts as Combwork’s', () => {
    // The elevated script found the workspace's parent already excluded: it asked for nothing.
    expect(changeOutcome('add', { started: true }, { ok: true, requested: [], listed: true, exclusions: ['D:\\Projects'] })).toMatchObject({ outcome: 'done', message: expect.stringContaining('already'), exclusions: ['D:\\Projects'] })
    expect(changeOutcome('add', { started: true }, { ok: true, requested: [], listed: true, exclusions: ['D:\\Projects'] }).added).toBeUndefined()
    // A partial failure: Defender listed one of the two before failing.
    const partial = changeOutcome('add', { started: true }, { ok: false, error: 'Something else', requested: ['D:\\A', 'D:\\B'], listed: true, exclusions: ['D:\\A'] })
    expect([partial.outcome, partial.added]).toEqual(['error', ['D:\\A']])
  })

  it('a list that wasn’t read afterwards stays unknown: no administrator list, nothing counted as added', () => {
    const failed = changeOutcome('add', { started: true }, { ok: false, error: 'Something else', requested: ['D:\\A'] })
    expect([failed.exclusions, failed.added]).toEqual([undefined, undefined])
    const unread = changeOutcome('add', { started: true }, { ok: true, requested: ['D:\\A'], listed: false, exclusions: [] })
    expect([unread.outcome, unread.exclusions, unread.added]).toEqual(['error', undefined, undefined])
    expect(changeOutcome('check', { started: true }, { ok: true, listed: true, exclusions: [1, 2] }).exclusions).toBeUndefined()
  })
})

describe('antivirus: Defender’s hidden-list answer (#316 round 3)', () => {
  const HIDDEN = 'N/A: Must be an administrator to view exclusions'
  it('is unknown whichever read produced it; a genuinely empty list is a list', () => {
    expect([readableList([HIDDEN]), readableList(HIDDEN), readableList([' n/a: hidden ']), readableList([]), readableList(['D:\\A'])]).toEqual([null, null, null, [], ['D:\\A']])
    // An administrator check that came back redacted: no list, nothing to keep.
    const check = changeOutcome('check', { started: true }, { ok: true, listed: true, exclusions: [HIDDEN] })
    expect([check.outcome, check.exclusions]).toEqual(['error', undefined])
    // A change refused because the starting list was redacted: nothing claimed, nothing kept.
    const add = changeOutcome('add', { started: true }, { ok: false, error: "Defender's exclusions couldn't be read even with administrator rights, so nothing was changed.", requested: [], listed: true, exclusions: [HIDDEN] })
    expect([add.outcome, add.exclusions, add.added]).toEqual(['error', undefined, undefined])
  })

  it('a kept administrator read holding it doesn’t turn unknown folders into scanned ones', () => {
    const s = status(probe(), { adminCheck: { at: 'x', exclusions: [HIDDEN] } })
    expect([s.exclusionsFrom, s.paths.map((p) => p.state)]).toEqual([null, ['unknown', 'unknown', 'unknown']])
    expect(status(probe(), { adminCheck: { at: 'x', exclusions: [] } }).paths.map((p) => p.state)).toEqual(['not-excluded', 'not-excluded', 'not-excluded'])
  })
})

describe('antivirus: Combwork’s exclusions of folders that are gone (#1389)', () => {
  const OLD = 'E:\\Old\\ACME'
  const gone = (raw: unknown, opts: { added?: string[]; adminCheck?: Admin; missing: string[] }) =>
    statusOf('D:\\Projects\\ACME', parseProbe(raw), folders, { added: opts.added ?? [], adminCheck: opts.adminCheck ?? null, now, missing: opts.missing }).gone

  it('with Defender’s list known, only those it lists itself; with it hidden, every one Combwork recorded, unconfirmed', () => {
    const added = [OLD, 'E:\\Old\\ACME.worktrees', 'F:\\Gone']
    // Listed now: Combwork's entries for OLD and F:\Gone; the worktrees' was taken away (in Windows Security, say).
    expect(gone(probe({ exclusions: [OLD, 'f:\\gone\\', 'E:\\Old'] }), { added, missing: added })).toEqual([{ path: OLD, state: 'excluded' }, { path: 'F:\\Gone', state: 'excluded' }])
    // A parent the user excluded isn't Combwork's entry: not listed itself, not shown.
    expect(gone(probe({ exclusions: ['E:\\Old'] }), { added, missing: added })).toBeUndefined()
    // Hidden, with Combwork's administrator read: as that read lists them.
    expect(gone(probe(), { added, missing: added, adminCheck: { at: 'x', exclusions: [OLD] } })).toEqual([{ path: OLD, state: 'excluded' }])
    // Hidden, no read: every one, unconfirmed.
    expect(gone(probe(), { added, missing: added })?.map((g) => g.state)).toEqual(['added', 'added', 'added'])
  })

  it('never the workspace’s own folders, a folder twice, one that exists, nor without Defender', () => {
    expect(goneExclusions(['D:\\Projects\\ACME', OLD, 'e:\\old\\acme\\'], folders, null)).toEqual([{ path: OLD, state: 'added' }])
    // Only what the caller found missing: an existing folder Combwork excluded is the workspace's business, not here.
    expect(gone(probe(), { added: [OLD, 'E:\\There'], missing: [OLD] })?.map((g) => g.path)).toEqual([OLD])
    expect(gone(probe({ defender: { antivirus: true, realTime: true, mode: 'Passive' } }), { added: [OLD], missing: [OLD] })).toBeUndefined()
  })
})

describe('antivirus: moving Combwork’s exclusions with a moved workspace (#1302)', () => {
  // The workspace moved from D:\Projects\ACME to E:\Work\ACME: the new folders and the old, as moveDefenderPlan probes them.
  const OLD = ['D:\\Projects\\ACME', 'D:\\Projects\\ACME.worktrees']
  const moved: typeof folders = [
    { path: 'E:\\Work\\ACME', kind: 'workspace' },
    { path: 'E:\\Work\\ACME.worktrees', kind: 'worktrees' },
    { path: OLD[0], kind: 'workspace' },
    { path: OLD[1], kind: 'worktrees' }
  ]
  const plan = (raw: unknown, opts: { added?: string[]; adminCheck?: Admin; folders?: typeof folders } = {}) => defenderMovePlan(status(raw, { folders: moved, ...opts }), OLD)

  it('moves Combwork’s exclusions: its old entries removed, the same kinds of new folder added', () => {
    const p = plan(probe({ exclusions: OLD }), { added: OLD })
    expect([p.remove, p.add, p.theirs]).toEqual([OLD, ['E:\\Work\\ACME', 'E:\\Work\\ACME.worktrees'], []])
    expect([p.old.map((x) => x.path), p.now.map((x) => x.path), p.exclusionsFrom]).toEqual([OLD, ['E:\\Work\\ACME', 'E:\\Work\\ACME.worktrees'], 'live'])
    // Only the kinds Combwork had: the workspace's exclusion moves, the worktrees (never Combwork's) get nothing.
    const one = plan(probe({ exclusions: [OLD[0]] }), { added: [OLD[0]] })
    expect([one.remove, one.add]).toEqual([[OLD[0]], ['E:\\Work\\ACME']])
    // A new folder that shows excluded now is still a candidate: the elevated run adds only what its live list, once
    // Combwork's old entries are gone, doesn't cover (an administrator read may be stale, or the cover may be Combwork's own).
    expect(plan(probe({ exclusions: [...OLD, 'E:\\Work'] }), { added: OLD }).add).toEqual(['E:\\Work\\ACME', 'E:\\Work\\ACME.worktrees'])
  })

  it('a workspace moved inside its old folder: the new folders Combwork’s old entry covers are candidates, whatever their kind', () => {
    // Combwork excluded D:\Scratch; the workspace moved into D:\Scratch\Tools; the user excluded the old worktrees folder.
    const old = ['D:\\Scratch', 'D:\\Scratch.worktrees']
    const inside: typeof folders = [
      { path: 'D:\\Scratch\\Tools', kind: 'workspace' },
      { path: 'D:\\Scratch\\Tools.worktrees', kind: 'worktrees' },
      { path: old[0], kind: 'workspace' },
      { path: old[1], kind: 'worktrees' }
    ]
    const p = defenderMovePlan(status(probe({ exclusions: old }), { folders: inside, added: [old[0]] }), old)
    // Excluded now only through the entry being removed: both new folders would be left scanned without them.
    expect([p.now.map((x) => x.state), p.remove, p.add, p.theirs]).toEqual([['excluded', 'excluded'], [old[0]], ['D:\\Scratch\\Tools', 'D:\\Scratch\\Tools.worktrees'], [old[1]]])
    // The run removes D:\Scratch and, with nothing left covering them, adds both.
    const done = changeOutcome('move', { started: true }, { ok: true, requested: p.add, removing: p.remove, listed: true, exclusions: [old[1], ...p.add] })
    expect(done).toMatchObject({ outcome: 'done', added: p.add, removed: p.remove, message: expect.stringContaining('1 removed, 2 added') })
  })

  it('leaves the user’s own exclusions alone: named when they are of an old folder itself, never removed', () => {
    const p = plan(probe({ exclusions: OLD }), { added: [OLD[0]] })
    expect([p.remove, p.theirs]).toEqual([[OLD[0]], [OLD[1]]])
    // An entry for a folder holding the old ones may cover the new ones too: not stale, nothing to say or do.
    const parent = plan(probe({ exclusions: ['D:\\Projects'] }))
    expect([parent.remove, parent.add, parent.theirs, parent.old.map((x) => x.state)]).toEqual([[], [], [], ['excluded', 'excluded']])
    // Combwork's record of an entry Defender no longer lists: nothing to remove, so nothing to move.
    expect(plan(probe({ exclusions: [] }), { added: OLD })).toMatchObject({ remove: [], add: [] })
  })

  it('never anything broader: an unsafe new folder isn’t added', () => {
    const p = plan(probe({ exclusions: OLD }), { added: OLD, folders: [{ path: 'E:\\', kind: 'workspace', unsafe: 'a whole drive' }, ...moved.slice(1)] })
    expect([p.remove, p.add]).toEqual([OLD, ['E:\\Work\\ACME.worktrees']])
  })

  it('with the list hidden: Combwork’s record says what is its own; the user’s can’t be known', () => {
    const p = plan(probe(), { added: OLD })
    expect([p.exclusionsFrom, p.remove, p.add, p.theirs]).toEqual([null, OLD, ['E:\\Work\\ACME', 'E:\\Work\\ACME.worktrees'], []])
    // An administrator check read before the move is used as the Antivirus panel uses it.
    const checked = plan(probe(), { added: OLD, adminCheck: { at: '2026-10-06T17:00:00Z', exclusions: [...OLD, 'E:\\Work\\ACME.worktrees'] } })
    expect([checked.exclusionsFrom, checked.adminCheckedAt, checked.add]).toEqual(['admin-check', '2026-10-06T17:00:00Z', ['E:\\Work\\ACME', 'E:\\Work\\ACME.worktrees']])
  })

  it('nothing to move unless Defender is the active antivirus', () => {
    const other = plan(probe({ exclusions: OLD, defender: { antivirus: true, realTime: true, mode: 'Passive Mode' }, products: [{ name: 'Norton Security', state: NORTON_ON }] }), { added: OLD })
    expect([other.scan, other.remove, other.add, other.theirs]).toEqual(['other', [], [], []])
    expect(defenderMovePlan(emptyStatus('E:\\Work\\ACME', 'test-copy', moved, now), OLD)).toMatchObject({ scan: 'test-copy', remove: [], add: [] })
  })

  it('the elevated move: done, already skipped, accepted but not applied, refused by policy, or declined', () => {
    const NEW = ['E:\\Work\\ACME', 'E:\\Work\\ACME.worktrees']
    const done = changeOutcome('move', { started: true }, { ok: true, requested: NEW, removing: OLD, listed: true, exclusions: [...NEW, 'C:\\Other'] })
    expect(done).toMatchObject({ outcome: 'done', added: NEW, removed: OLD, message: expect.stringContaining('2 removed, 2 added') })
    // The new folders were already covered: only the removal.
    expect(changeOutcome('move', { started: true }, { ok: true, requested: [], removing: OLD, listed: true, exclusions: ['E:\\Work'] })).toMatchObject({ outcome: 'done', removed: OLD, message: expect.stringContaining('none added') })
    // Defender accepted it, but an old one is still listed and a new one missing: a policy overrides local exclusions.
    const partial = changeOutcome('move', { started: true }, { ok: true, requested: NEW, removing: OLD, listed: true, exclusions: [OLD[0], NEW[0]] })
    expect(partial).toMatchObject({ outcome: 'policy', added: [NEW[0]], removed: [OLD[1]], message: expect.stringContaining('2 folders') })
    expect(changeOutcome('move', { started: true }, { ok: false, error: 'Operation failed with the following error: 0x800106ba', requested: NEW, removing: OLD, listed: true, exclusions: OLD })).toMatchObject({ outcome: 'policy' })
    expect(changeOutcome('move', { started: false, cancelled: true }, null).outcome).toBe('refused')
    // Not read afterwards: nothing claimed either way.
    const unread = changeOutcome('move', { started: true }, { ok: true, requested: NEW, removing: OLD, listed: false })
    expect([unread.outcome, unread.added, unread.removed]).toEqual(['error', undefined, undefined])
  })
})

describe('antivirus scripts (#316)', () => {
  // Parsed by PowerShell's own parser, never run: a syntax error would only show on a user's machine otherwise.
  it.skipIf(process.platform !== 'win32')('the probe, the elevated change and its launcher are valid PowerShell, with awkward paths quoted', async () => {
    const { probeScript, elevatedScript, launcherScript } = await import('../src/main/antivirus')
    const { spawnSync } = await import('child_process')
    const odd = ["D:\\It's here\\$env:X", 'C:\\Users\\Dév\\`tick`; Remove-Item x']
    for (const script of [probeScript(['C', 'D']), elevatedScript('add', odd, ['C', 'D'], 'C:\\Temp\\o.json'), elevatedScript('move', odd, ['C', 'D'], 'C:\\Temp\\o.json', odd), elevatedScript('move', [], [], 'o'), launcherScript(elevatedScript('remove', odd, ['D'], 'C:\\Temp\\o.json'))]) {
      const b64 = Buffer.from(script, 'utf16le').toString('base64')
      const parse = `$s = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${b64}')); $e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($s, [ref]$null, [ref]$e); $e.Count`
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', parse], { encoding: 'utf8', windowsHide: true })
      expect(r.stdout.trim()).toBe('0')
    }
    // The paths are single-quoted literals: nothing in them is expanded or run.
    expect(elevatedScript('add', odd, [], 'o')).toContain("'D:\\It''s here\\$env:X'")
  })
})

describe('antivirus status cache (#322)', () => {
  // On a fixture only (CW_TEST_ANTIVIRUS): every probe is logged, so a request that probes again shows the status wasn't kept.
  const base = tempDir('cw-av-cache-')
  const fixture = join(base, 'fixture.json')
  const callLog = join(base, 'calls.log')
  const env = { fixture: process.env.CW_TEST_ANTIVIRUS, log: process.env.CW_TEST_ANTIVIRUS_LOG }
  beforeAll(() => {
    writeFileSync(fixture, JSON.stringify({ probe: probe() }))
    process.env.CW_TEST_ANTIVIRUS = fixture
    process.env.CW_TEST_ANTIVIRUS_LOG = callLog
  })
  afterAll(() => {
    for (const [k, v] of [['CW_TEST_ANTIVIRUS', env.fixture], ['CW_TEST_ANTIVIRUS_LOG', env.log]] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(base, { recursive: true, force: true })
  })
  const probes = (): number => readFileSync(callLog, 'utf8').split('\n').filter((l) => l.includes('"probe"')).length
  let n = 0
  /** A workspace as the status needs it: a folder, its lifetime and no projects. */
  const open = () => {
    const path = join(base, `ws${++n}`)
    mkdirSync(path)
    const life = new AbortController()
    return { w: { path, lifetime: life.signal, listProjectPaths: async () => [] } as never, close: () => life.abort() }
  }

  it('keeps one probe per workspace, at most 16 workspaces, and retires a workspace’s status when it closes', async () => {
    const { statusFor } = await import('../src/main/antivirus')
    writeFileSync(callLog, '')
    const first = open()
    await Promise.all([statusFor(first.w), statusFor(first.w)])
    await statusFor(first.w)
    expect(probes()).toBe(1) // Two at once share a probe, and the answer is kept.

    // Sixteen more workspaces: the first one's status, the oldest, is no longer kept; the latest still is.
    const more = Array.from({ length: 16 }, open)
    for (const m of more) await statusFor(m.w)
    expect(probes()).toBe(17)
    await statusFor(more[15].w)
    expect(probes()).toBe(17)
    await statusFor(first.w)
    expect(probes()).toBe(18)

    // Closing a workspace retires its status: opened again (a new lifetime), it is probed again.
    await statusFor(more[14].w)
    expect(probes()).toBe(18)
    more[14].close()
    const again = { ...(more[14].w as object), lifetime: new AbortController().signal } as never
    await statusFor(again)
    expect(probes()).toBe(19)
  })
})
