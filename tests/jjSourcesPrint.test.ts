// The verified capture's print (jjSourcesPrint.ts: J5's, HI-2798, shared with J7's Operations preview, HI-2800): raw
// bytes only, so any change to a printed file or anywhere in a printed tree changes it; absent is a value, unreadable or
// past the bound is no print.
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { PRINT_TREE_MAX, rawSourcesPrint } from '../src/main/platform/jjSourcesPrint'
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
