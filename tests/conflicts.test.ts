// Conflict help on a card the merge queue returned (HI-1181, design s10 checked by HR4): the conflicted files' hunks as
// the queue's folder had them. The parser (pure): each region's sides by any marker length of 7 or more, a diff3 base,
// context that is never shared between regions close together, a stray marker taken as text, the caps with what they
// stopped (an exact count of the rest only when the text was whole), and the short form agents read. The reader: a path
// outside the folder (as written, absolute, or climbing out), a link on the way, missing, a folder, binary and invalid
// text are metadata only, never read; a large file is read up to its budget (a character cut there is the cut's), and
// the whole read's budget leaves the rest unopened.
import { mkdirSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { CONFLICT_LIMITS, conflictPlaces, parseConflicts } from '../src/shared/workflow/conflicts'
import { readConflicts } from '../src/main/workflow/conflictRead'
import { junction } from './pathAliases'
import { tempDir } from './tempDir'

const room = () => ({ chars: CONFLICT_LIMITS.chars })
const region = (ours: string[], theirs: string[], n = 7, base?: string[]) => [`${'<'.repeat(n)} HEAD`, ...ours, ...(base ? [`${'|'.repeat(n)} base`, ...base] : []), '='.repeat(n), ...theirs, `${'>'.repeat(n)} abc1234`]

describe('parseConflicts', () => {
  it('a region: its line, its sides apart, context either side', () => {
    const text = ['one', 'two', 'three', ...region(['ours 1', 'ours 2'], ['theirs']), 'four', 'five', 'six'].join('\n')
    const f = parseConflicts('a.txt', text, true, room())
    expect(f).toEqual({ file: 'a.txt', hunks: [{ line: 4, before: ['two', 'three'], ours: ['ours 1', 'ours 2'], theirs: ['theirs'], after: ['four', 'five'] }] })
  })

  it('a diff3 base, and markers longer than 7 (a conflict-marker-size attribute)', () => {
    const text = ['x', ...region(['o'], ['t'], 9, ['b'])].join('\r\n')
    expect(parseConflicts('a', text, true, room()).hunks).toEqual([{ line: 2, before: ['x'], ours: ['o'], base: ['b'], theirs: ['t'], after: [] }])
    // A shorter marker inside a longer region is its text, not the separator.
    const inner = ['<<<<<<<<< HEAD', 'o', '=======', 'still ours', '=========', 't', '>>>>>>>>> x'].join('\n')
    expect(parseConflicts('a', inner, true, room()).hunks[0]).toMatchObject({ ours: ['o', '=======', 'still ours'], theirs: ['t'] })
  })

  it('regions close together share no context: the second starts after the first', () => {
    const text = [...region(['a'], ['b']), 'between 1', 'between 2', 'between 3', ...region(['c'], ['d'])].join('\n')
    const [h1, h2] = parseConflicts('a', text, true, room()).hunks
    expect([h1.after, h2.before]).toEqual([['between 1', 'between 2'], ['between 3']])
    expect([h1.line, h2.line]).toEqual([1, 9])
  })

  it('a stray marker is text: a lone ======= or <<<<<<<, and a real region after it is found', () => {
    const text = ['=======', '<<<<<<< not closed', 'x', ...region(['o'], ['t'])].join('\n')
    const f = parseConflicts('a', text, true, room())
    expect(f.hunks.map((h) => h.line)).toEqual([4])
    expect(f.hunks[0].before).toEqual(['<<<<<<< not closed', 'x'])
  })

  it('the caps: hunks past 8 (an exact count of the rest), a side past 40 lines (counted, not in the text), and the room', () => {
    const many = Array.from({ length: 11 }, () => region(['o'], ['t']).join('\n')).join('\nsep\n')
    expect(parseConflicts('a', many, true, room())).toMatchObject({ partial: 'hunks', more: 3 })
    expect(parseConflicts('a', many, true, room()).hunks).toHaveLength(8)
    const long = region(Array.from({ length: 45 }, (_, i) => `o${i}`), ['t']).join('\n')
    const h = parseConflicts('a', long, true, room()).hunks[0]
    expect([h.ours.length, h.cut]).toEqual([40, { ours: 5 }])
    const tight = { chars: 30 }
    const f = parseConflicts('a', [region(['o'], ['t']).join('\n'), region(['a'.repeat(100)], ['t']).join('\n')].join('\n'), true, tight)
    expect([f.hunks.length, f.partial, f.more]).toEqual([1, 'room', 1])
  })

  it('a text cut at its budget: its last (partial) line not scanned, and how many more not known', () => {
    const text = [...region(['o'], ['t']), 'x', '<<<<<<< HEAD', 'cut he'].join('\n')
    const f = parseConflicts('a', text, false, room())
    expect([f.hunks.length, f.partial, f.more]).toEqual([1, 'size', undefined])
  })

  it('the short form agents read says where, or why not, never a count it does not know', () => {
    const two = parseConflicts('a.ts', [...region(['o'], ['t']), 'x', 'y', 'z', ...region(['o'], ['t'])].join('\n'), true, room())
    expect(conflictPlaces(two)).toBe('2 conflicts, lines 1 and 9')
    expect(conflictPlaces({ file: 'b', notRead: 'link', hunks: [] })).toBe('not read: link')
    expect(conflictPlaces({ file: 'c', hunks: [] })).toBe('no text conflict')
    expect(conflictPlaces({ file: 'd', hunks: [], partial: 'size' })).toBe('conflicts not found in the part read (read in part)')
  })
})

describe('readConflicts', () => {
  const conflicted = region(['o'], ['t']).join('\n')
  const fresh = () => {
    const base = tempDir('hive-conflicts-')
    const folder = join(base, 'queue')
    mkdirSync(folder, { recursive: true })
    return { base, folder }
  }

  it('a file in the folder: read and parsed; the record says which side git wrote first', async () => {
    const { folder } = fresh()
    writeFileSync(join(folder, 'a.txt'), conflicted)
    const r = await readConflicts(folder, ['a.txt'], 'card')
    expect(r).toEqual({ oursIs: 'card', files: [{ file: 'a.txt', hunks: [expect.objectContaining({ line: 1, ours: ['o'], theirs: ['t'] })] }] })
  })

  it('a path outside the folder, as written (absolute, climbing out, a drive), is never looked at', async () => {
    const { base, folder } = fresh()
    writeFileSync(join(base, 'secret.txt'), conflicted)
    const r = await readConflicts(folder, [join(base, 'secret.txt'), '../secret.txt', 'sub/../../secret.txt', 'C:secret.txt'], 'target')
    expect(r.files.map((f) => [f.notRead, f.hunks.length])).toEqual([['outside', 0], ['outside', 0], ['outside', 0], ['outside', 0]])
  })

  it('a link on the way (a junction folder, a file symlink where the OS allows one) is never followed', async () => {
    const { base, folder } = fresh()
    mkdirSync(join(base, 'elsewhere'))
    writeFileSync(join(base, 'elsewhere', 'b.txt'), conflicted)
    junction(join(base, 'elsewhere'), join(folder, 'via'))
    const files = ['via/b.txt']
    try {
      symlinkSync(join(base, 'elsewhere', 'b.txt'), join(folder, 'link.txt'), 'file')
      files.push('link.txt')
    } catch {
      // Windows without Developer Mode: no file symlink to make; the junction is the link checked.
    }
    const r = await readConflicts(folder, files, 'target')
    expect(r.files.every((f) => f.notRead === 'link' && !f.hunks.length)).toBe(true)
  })

  it('missing, a folder, binary and invalid UTF-8: recorded as not read, never as no conflict', async () => {
    const { folder } = fresh()
    mkdirSync(join(folder, 'dir'))
    writeFileSync(join(folder, 'bin.dat'), Buffer.from([0x3c, 0x00, 0x01]))
    writeFileSync(join(folder, 'bad.txt'), Buffer.from([0x61, 0xff, 0xfe, 0x0a]))
    const r = await readConflicts(folder, ['gone.txt', 'dir', 'bin.dat', 'bad.txt'], 'target')
    expect(r.files.map((f) => f.notRead)).toEqual(['missing', 'missing', 'binary', 'notText'])
  })

  it('a large file is read up to its budget, a character cut there being the cut, not invalid text', async () => {
    const { folder } = fresh()
    // A conflict at the start, then multi-byte text so the 256 KB budget falls inside a character (é is 2 bytes).
    writeFileSync(join(folder, 'big.txt'), `${conflicted}\n${'é'.repeat(200_000)}`)
    const f = (await readConflicts(folder, ['big.txt'], 'target')).files[0]
    expect([f.notRead, f.partial, f.hunks.length, f.more]).toEqual([undefined, 'size', 1, undefined])
  })

  it("the whole read's budget leaves the rest unopened, and files past the limit are counted", async () => {
    const { folder } = fresh()
    const names = Array.from({ length: 5 }, (_, i) => `f${i}.txt`)
    for (const n of names) writeFileSync(join(folder, n), `${conflicted}\n${'x'.repeat(150_000)}`)
    const r = await readConflicts(folder, names, 'target', { files: 4, fileBytes: CONFLICT_LIMITS.fileBytes, totalBytes: 300_000 })
    expect(r.files.map((f) => f.notRead ?? f.partial ?? 'whole')).toEqual(['whole', 'size', 'budget', 'budget'])
    expect(r.filesLeft).toBe(1)
    // Its one long line kept to lineChars in the context, counted: the room isn't spent on it.
    expect([r.files[0].hunks[0].after[0].length, r.files[0].hunks[0].clipped]).toEqual([CONFLICT_LIMITS.lineChars, 1])
  })
})
