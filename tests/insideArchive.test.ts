// A path is inside an .asar archive only when a folder of it named *.asar is a file on disk (#246, #261): Combwork's file
// routes and image previews refuse those, and leave alone a real folder that happens to end in .asar.
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { insideArchive } from '../src/main/fsutil'
import { tempDir } from './tempDir'

const base = tempDir('cw-inside-archive-')
afterAll(() => rmSync(base, { recursive: true, force: true }))
const archive = join(base, 'dist', 'app.asar')
const folder = join(base, 'art.asar')
mkdirSync(join(base, 'dist'), { recursive: true })
writeFileSync(archive, 'not really an archive, but a file')
mkdirSync(join(folder, 'icons'), { recursive: true })
writeFileSync(join(folder, 'icon.png'), 'png')

describe('insideArchive', () => {
  it('refuses a path inside an .asar file, however deep', () => {
    expect(insideArchive(join(archive, 'icon.png'))).toBe(true)
    expect(insideArchive(join(archive, 'deep', 'er', 'icon.png'))).toBe(true)
    expect(insideArchive(`${archive}/icon.png`)).toBe(true)
  })

  it('allows the .asar file itself', () => {
    expect(insideArchive(archive)).toBe(false)
  })

  it('allows a real folder whose name ends in .asar', () => {
    expect(insideArchive(join(folder, 'icon.png'))).toBe(false)
    expect(insideArchive(join(folder, 'icons', 'missing.png'))).toBe(false)
    expect(insideArchive(join(base, 'ART.ASAR', 'icon.png'))).toBe(false)
  })

  it('refuses an archive below a real .asar folder', () => {
    const inner = join(folder, 'inner.asar')
    writeFileSync(inner, 'x')
    expect(insideArchive(join(inner, 'icon.png'))).toBe(true)
  })

  it('allows a path under an .asar that is not there (there is nothing to open)', () => {
    expect(insideArchive(join(base, 'gone.asar', 'icon.png'))).toBe(false)
  })

  it('leaves paths without .asar alone', () => {
    expect(insideArchive(join(base, 'dist', 'icon.png'))).toBe(false)
    expect(insideArchive(join(base, 'notes.asarx', 'a.md'))).toBe(false)
  })
})
