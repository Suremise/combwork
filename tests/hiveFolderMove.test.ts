// HI-2462: the paths stored before the .hive → .combwork move, translated through the map of folders that really moved
// and nothing else (shared/hiveFolderMove.ts): whole paths only, any case, either separator, in a file link as
// encodeURI writes it; the Assistant's inner folder before the workspace's; another folder's .hive never anyone's.
import { describe, expect, it } from 'vitest'
import { movedContextRef, movedExcludeText, movedPathOf, rewriteMovedPaths, type FolderMove } from '../src/shared/hiveFolderMove'

const WS = 'D:\\Work\\my ws'
const MOVES: FolderMove[] = [
  { from: `${WS}\\.hive`, to: `${WS}\\.combwork` },
  { from: `${WS}\\.hive\\assistant\\.hive`, to: `${WS}\\.combwork\\assistant\\.combwork` },
  { from: `${WS}\\alpha\\.hive`, to: `${WS}\\alpha\\.combwork` }
]

describe('rewriteMovedPaths', () => {
  it("rewrites an old attachment link in a card, keeping the text's own separators", () => {
    const text = `See ![shot](${WS}\\alpha\\.hive\\attachments\\cards\\12\\shot.png) and ${WS.replace(/\\/g, '/')}/.hive/shared/handovers/h.md.`
    expect(rewriteMovedPaths(text, MOVES)).toBe(`See ![shot](${WS}\\alpha\\.combwork\\attachments\\cards\\12\\shot.png) and ${WS.replace(/\\/g, '/')}/.combwork/shared/handovers/h.md.`)
  })

  it('matches any case, and a link into another host (cross-host) by its own move', () => {
    expect(rewriteMovedPaths(`d:\\work\\MY WS\\ALPHA\\.Hive\\x.md`, MOVES)).toBe(`D:\\Work\\my ws\\alpha\\.combwork\\x.md`)
  })

  it("translates the Assistant's inner folder before the workspace's that holds it", () => {
    expect(rewriteMovedPaths(`${WS}\\.hive\\assistant\\.hive\\attachments\\a.png`, MOVES)).toBe(`${WS}\\.combwork\\assistant\\.combwork\\attachments\\a.png`)
  })

  it('rewrites a file link in its encoded form', () => {
    const link = 'file:///D:/Work/my%20ws/alpha/.hive/attachments/cards/1/a%20b.png'
    expect(rewriteMovedPaths(`[a](${link})`, MOVES)).toBe('[a](file:///D:/Work/my%20ws/alpha/.combwork/attachments/cards/1/a%20b.png)')
  })

  it('leaves lookalikes, other folders, and prose alone', () => {
    for (const t of [
      `${WS}\\alpha2\\.hive\\x.md`,
      `${WS}\\alpha\\.hive.bak\\x.md`,
      `${WS}\\alpha\\.hivex\\x.md`,
      `E:\\old${WS.slice(2)}\\alpha\\.hive\\x.md`,
      `${WS}\\beta\\.hive\\x.md`,
      'colonyops writes a .hive folder; .hive/shared is relative',
      `C:\\elsewhere\\.hive\\x`
    ])
      expect(rewriteMovedPaths(t, MOVES)).toBe(t)
  })

  it('changes nothing with no moves', () => {
    expect(rewriteMovedPaths(`${WS}\\.hive\\x`, [])).toBe(`${WS}\\.hive\\x`)
  })
})

describe('movedPathOf', () => {
  it('maps a whole path inside a moved folder, and nothing else', () => {
    expect(movedPathOf(`${WS}\\alpha\\.hive\\slots\\HI-1`, MOVES)).toBe(`${WS}\\alpha\\.combwork\\slots\\HI-1`)
    expect(movedPathOf(`${WS}\\.hive\\assistant\\.hive`, MOVES)).toBe(`${WS}\\.combwork\\assistant\\.combwork`)
    expect(movedPathOf(`${WS}/.hive/assistant`, MOVES)).toBe(`${WS}\\.combwork\\assistant`)
    expect(movedPathOf(`${WS}\\alpha`, MOVES)).toBeNull()
    expect(movedPathOf(`${WS}\\alpha\\.hivex`, MOVES)).toBeNull()
    expect(movedPathOf(`${WS}\\beta\\.hive\\x`, MOVES)).toBeNull()
  })
})

describe('movedContextRef', () => {
  it("reads a context reference into the old shared folder as shared:", () => {
    expect(movedContextRef('.hive/shared/plans/a.md#open-questions')).toBe('shared:plans/a.md#open-questions')
    expect(movedContextRef('.hive\\shared\\b.md')).toBe('shared:b.md')
    expect(movedContextRef('docs/SPEC.md#x')).toBe('docs/SPEC.md#x')
    expect(movedContextRef('shared:c.md')).toBe('shared:c.md')
  })
})

describe('movedExcludeText', () => {
  const ours = '# Hive project metadata (added by Hive)\n/.hive/\n'

  it("replaces Hive's own line, under its comment, keeping every other line", () => {
    expect(movedExcludeText(`build/\n${ours}*.log\n`, '/.hive/', '/.combwork/', true)).toBe('build/\n# Hive project metadata (added by Hive)\n/.combwork/\n*.log\n')
  })

  it("keeps a user's own .hive line, and Hive's while a .hive is still there", () => {
    expect(movedExcludeText('/.hive/\n', '/.hive/', '/.combwork/', true)).toBe('/.hive/\n')
    expect(movedExcludeText(ours, '/.hive/', '/.combwork/', false)).toBe(ours)
  })

  it('never adds the new line twice, and keeps CRLF', () => {
    expect(movedExcludeText('# Hive project metadata (added by Hive)\r\n/.combwork/\r\n# Hive project metadata (added by Hive)\r\n/.hive/\r\n', '/.hive/', '/.combwork/', true)).toBe('# Hive project metadata (added by Hive)\r\n/.combwork/\r\n# Hive project metadata (added by Hive)\r\n')
  })
})
