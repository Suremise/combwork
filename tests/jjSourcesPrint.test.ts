// The verified capture's print (jjSourcesPrint.ts: J5's, HI-2798, shared with J7's Operations preview, HI-2800): raw
// bytes only, so any change to a printed file or anywhere in a printed tree changes it; absent is a value, unreadable or
// past the bound is no print.
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { PRINT_TREE_MAX, rawSourcesPrint, sourcesPrintWithin } from '../src/main/platform/jjSourcesPrint'
import { OPERATIONS_PRINT_BOUNDS, previewTask, printTask } from '../src/main/platform/jjPreviewTask'
import { tempDir } from './tempDir'

function fixture() {
  const root = tempDir('jjprint-')
  const jjRepo = join(root, 'repo')
  mkdirSync(join(jjRepo, 'op_heads', 'heads'), { recursive: true })
  writeFileSync(join(jjRepo, 'op_heads', 'heads', 'a'.repeat(128)), '')
  const store = join(root, 'git')
  mkdirSync(join(store, 'refs', 'heads'), { recursive: true })
  writeFileSync(join(store, 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(store, 'refs', 'heads', 'main'), '1'.repeat(40) + '\n')
  const sources = { jjRepo, files: [{ label: 'HEAD', path: join(store, 'HEAD') }, { label: 'packed', path: join(store, 'packed-refs') }], trees: [{ label: 'refs/heads', path: join(store, 'refs', 'heads') }, { label: 'refs/tags', path: join(store, 'refs', 'tags') }] }
  return { store, jjRepo, sources }
}

describe('rawSourcesPrint', () => {
  it('is stable, and changes with a file, a tree’s file (nested, added, removed), an absent one appearing, or the heads', () => {
    const { store, jjRepo, sources } = fixture()
    const p0 = rawSourcesPrint(sources)
    expect(p0).toMatch(/^[0-9a-f]{64}$/)
    expect(rawSourcesPrint(sources)).toBe(p0)
    writeFileSync(join(store, 'refs', 'heads', 'main'), '2'.repeat(40) + '\n')
    const p1 = rawSourcesPrint(sources)
    expect(p1).not.toBe(p0)
    mkdirSync(join(store, 'refs', 'heads', 'cw'), { recursive: true })
    writeFileSync(join(store, 'refs', 'heads', 'cw', 'x'), '3'.repeat(40) + '\n')
    const p2 = rawSourcesPrint(sources)
    expect(p2).not.toBe(p1)
    mkdirSync(join(store, 'refs', 'tags'))
    const p3 = rawSourcesPrint(sources)
    expect(p3).not.toBe(p2)
    writeFileSync(join(store, 'refs', 'tags', 'v1'), '4'.repeat(40) + '\n')
    expect(rawSourcesPrint(sources)).not.toBe(p3)
    rmSync(join(store, 'refs', 'tags', 'v1'))
    expect(rawSourcesPrint(sources)).toBe(p3)
    writeFileSync(join(store, 'packed-refs'), '# pack-refs\n')
    const p4 = rawSourcesPrint(sources)
    expect(p4).not.toBe(p3)
    writeFileSync(join(jjRepo, 'op_heads', 'heads', 'b'.repeat(128)), '')
    expect(rawSourcesPrint(sources)).not.toBe(p4)
  })

  it('no print without readable operation heads, or past the tree bound', () => {
    const { store, jjRepo, sources } = fixture()
    rmSync(join(jjRepo, 'op_heads'), { recursive: true })
    expect(rawSourcesPrint(sources)).toBeUndefined()
    const f = fixture()
    const many = join(f.store, 'refs', 'tags')
    mkdirSync(many)
    for (let i = 0; i <= PRINT_TREE_MAX; i++) writeFileSync(join(many, `t${i}`), '')
    expect(rawSourcesPrint(f.sources)).toBeUndefined()
    expect(store).toBeTruthy()
  })
})

describe("the Operations print's bounds (HR2's HI-2800 round 3)", () => {
  it('over past the files, the folders or the bytes, read no further; within them, the same print as unbounded', () => {
    const f = fixture()
    const bounds = { files: 3, dirs: 3, bytes: 1000 }
    expect(sourcesPrintWithin(f.sources, bounds)).toBe(rawSourcesPrint(f.sources))
    for (let i = 0; i < 3; i++) writeFileSync(join(f.store, 'refs', 'heads', `b${i}`), '5'.repeat(40) + '\n')
    expect(sourcesPrintWithin(f.sources, bounds)).toBe('over')
    const g = fixture()
    for (let i = 0; i < 3; i++) mkdirSync(join(g.store, 'refs', 'heads', `d${i}`))
    expect(sourcesPrintWithin(g.sources, bounds)).toBe('over')
    const h = fixture()
    writeFileSync(join(h.store, 'packed-refs'), 'x'.repeat(2000))
    expect(sourcesPrintWithin(h.sources, bounds)).toBe('over')
  })

  it('the Operations bounds, and the final task: held, moved, over', () => {
    expect(OPERATIONS_PRINT_BOUNDS).toEqual({ files: 20_000, dirs: 2_000, bytes: 16 * 1024 * 1024 })
    const f = fixture()
    const print = printTask(f.sources)
    expect(typeof print).toBe('string')
    const input = { op: 'b'.repeat(128), facts: { view: 'e'.repeat(128), parents: ['a'.repeat(128)], snapshot: false, workspace: 'default', description: 'x' }, parent: 'a'.repeat(128), views: { parent: 'View {', op: 'View {', head: 'View {' }, commits: { added: [], hidden: [], descendants: [], gone: [], back: [] }, stale: false, git: null }
    expect(previewTask(input, { sources: f.sources, print: print as string }).fence).toBe('held')
    writeFileSync(join(f.store, 'refs', 'heads', 'late'), '6'.repeat(40) + '\n')
    expect(previewTask(input, { sources: f.sources, print: print as string }).fence).toBe('moved')
    mkdirSync(join(f.store, 'refs', 'tags'))
    for (let i = 0; i <= 20_000; i++) writeFileSync(join(f.store, 'refs', 'tags', `t${i}`), '')
    expect(previewTask(input, { sources: f.sources, print: print as string }).fence).toBe('over')
  })
})
