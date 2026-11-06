// HI-2462: the paths stored before 1.0's folder moved to .combwork, translated through the map of folders that really moved
// and nothing else (shared/combworkFolderMove.ts): whole paths only, any case, either separator, in a file link as
// encodeURI writes it; the Assistant's inner folder before the workspace's; another folder's of that name never anyone's.
import { describe, expect, it } from 'vitest'
import { movedContextRef, movedExcludeText, movedPathOf, rewriteMovedPaths, type FolderMove } from '../src/shared/combworkFolderMove'

const WS = 'D:\\Work\\my ws'
// old-name: begin combworkFolderMove-inputs
/** 1.0's folder (and in another case), its app's name, and the exclude line's header 1.0 wrote: the move's input. */
const OLD_DIR = '.hive'
const OLD_DIR_CASED = '.Hive'
const OLD_APP = 'Hive'
const OLD_HEADER = '# Hive project metadata (added by Hive)'
// old-name: end combworkFolderMove-inputs
const MOVES: FolderMove[] = [
  { from: `${WS}\\${OLD_DIR}`, to: `${WS}\\.combwork` },
  { from: `${WS}\\${OLD_DIR}\\assistant\\${OLD_DIR}`, to: `${WS}\\.combwork\\assistant\\.combwork` },
  { from: `${WS}\\alpha\\${OLD_DIR}`, to: `${WS}\\alpha\\.combwork` }
]

describe('rewriteMovedPaths', () => {
  it("rewrites an old attachment link in a card, keeping the text's own separators", () => {
    const text = `See ![shot](${WS}\\alpha\\${OLD_DIR}\\attachments\\cards\\12\\shot.png) and ${WS.replace(/\\/g, '/')}/${OLD_DIR}/shared/handovers/h.md.`
    expect(rewriteMovedPaths(text, MOVES)).toBe(`See ![shot](${WS}\\alpha\\.combwork\\attachments\\cards\\12\\shot.png) and ${WS.replace(/\\/g, '/')}/.combwork/shared/handovers/h.md.`)
  })

  it('matches any case, and a link into another host (cross-host) by its own move', () => {
    expect(rewriteMovedPaths(`d:\\work\\MY WS\\ALPHA\\${OLD_DIR_CASED}\\x.md`, MOVES)).toBe(`D:\\Work\\my ws\\alpha\\.combwork\\x.md`)
  })

  it("translates the Assistant's inner folder before the workspace's that holds it", () => {
    expect(rewriteMovedPaths(`${WS}\\${OLD_DIR}\\assistant\\${OLD_DIR}\\attachments\\a.png`, MOVES)).toBe(`${WS}\\.combwork\\assistant\\.combwork\\attachments\\a.png`)
  })

  it('rewrites a file link in its encoded form', () => {
    const link = `file:///D:/Work/my%20ws/alpha/${OLD_DIR}/attachments/cards/1/a%20b.png`
    expect(rewriteMovedPaths(`[a](${link})`, MOVES)).toBe('[a](file:///D:/Work/my%20ws/alpha/.combwork/attachments/cards/1/a%20b.png)')
  })

  it('leaves lookalikes, other folders, and prose alone', () => {
    for (const t of [
      `${WS}\\alpha2\\${OLD_DIR}\\x.md`,
      `${WS}\\alpha\\${OLD_DIR}.bak\\x.md`,
      `${WS}\\alpha\\${OLD_DIR}x\\x.md`,
      `E:\\old${WS.slice(2)}\\alpha\\${OLD_DIR}\\x.md`,
      `${WS}\\beta\\${OLD_DIR}\\x.md`,
      `colonyops writes a ${OLD_DIR} folder; ${OLD_DIR}/shared is relative`,
      `C:\\elsewhere\\${OLD_DIR}\\x`
    ])
      expect(rewriteMovedPaths(t, MOVES)).toBe(t)
  })

  it('changes nothing with no moves', () => {
    expect(rewriteMovedPaths(`${WS}\\${OLD_DIR}\\x`, [])).toBe(`${WS}\\${OLD_DIR}\\x`)
  })
})

describe('movedPathOf', () => {
  it('maps a whole path inside a moved folder, and nothing else', () => {
    expect(movedPathOf(`${WS}\\alpha\\${OLD_DIR}\\slots\\HI-1`, MOVES)).toBe(`${WS}\\alpha\\.combwork\\slots\\HI-1`)
    expect(movedPathOf(`${WS}\\${OLD_DIR}\\assistant\\${OLD_DIR}`, MOVES)).toBe(`${WS}\\.combwork\\assistant\\.combwork`)
    expect(movedPathOf(`${WS}/${OLD_DIR}/assistant`, MOVES)).toBe(`${WS}\\.combwork\\assistant`)
    expect(movedPathOf(`${WS}\\alpha`, MOVES)).toBeNull()
    expect(movedPathOf(`${WS}\\alpha\\${OLD_DIR}x`, MOVES)).toBeNull()
    expect(movedPathOf(`${WS}\\beta\\${OLD_DIR}\\x`, MOVES)).toBeNull()
  })
})

describe('movedContextRef', () => {
  it("reads a context reference into the old shared folder as shared:", () => {
    expect(movedContextRef(`${OLD_DIR}/shared/plans/a.md#open-questions`)).toBe('shared:plans/a.md#open-questions')
    expect(movedContextRef(`${OLD_DIR}\\shared\\b.md`)).toBe('shared:b.md')
    expect(movedContextRef('docs/SPEC.md#x')).toBe('docs/SPEC.md#x')
    expect(movedContextRef('shared:c.md')).toBe('shared:c.md')
  })
})

describe('movedExcludeText', () => {
  const ours = `${OLD_HEADER}\n/${OLD_DIR}/\n`

  it("replaces Combwork's own line, under its comment, keeping every other line", () => {
    expect(movedExcludeText(`build/\n${ours}*.log\n`, `/${OLD_DIR}/`, '/.combwork/', true)).toBe('build/\n# Combwork project metadata (added by Combwork)\n/.combwork/\n*.log\n')
  })

  it("takes a line under Combwork's comment as its own too, and leaves another comment's wording (HI-2575)", () => {
    expect(movedExcludeText(`# Combwork project metadata (added by Combwork)\n${OLD_DIR}/\n`, `/${OLD_DIR}/`, '/.combwork/', true)).toBe('# Combwork project metadata (added by Combwork)\n/.combwork/\n')
    expect(movedExcludeText(`# old project folder (added by ${OLD_APP}, by hand)\n/${OLD_DIR}/\n`, `/${OLD_DIR}/`, '/.combwork/', true)).toBe(`# old project folder (added by ${OLD_APP}, by hand)\n/.combwork/\n`)
  })

  it("keeps a user's own line for the old folder, and the old app's while that folder is still there", () => {
    expect(movedExcludeText(`/${OLD_DIR}/\n`, `/${OLD_DIR}/`, '/.combwork/', true)).toBe(`/${OLD_DIR}/\n`)
    expect(movedExcludeText(ours, `/${OLD_DIR}/`, '/.combwork/', false)).toBe(ours)
  })

  it('never adds the new line twice, and keeps CRLF', () => {
    expect(movedExcludeText(`${OLD_HEADER}\r\n/.combwork/\r\n${OLD_HEADER}\r\n/${OLD_DIR}/\r\n`, `/${OLD_DIR}/`, '/.combwork/', true)).toBe(`${OLD_HEADER}\r\n/.combwork/\r\n${OLD_HEADER}\r\n`)
  })
})
