// HI-2978 (SPEC's jj attributes gate): Git's legacy `crlf` attribute is a use in every spelling, as `text` and `eol`
// are, and the folders looked in for a `.gitattributes` Git applies though untracked or ignored are those holding a
// tracked file. The real-Git cases (Git converting by it, untracked and ignored files) are tests/jjViewsReal.test.ts.
import { describe, expect, it } from 'vitest'
import { attributeUses, trackedDirs } from '../src/main/platform/jjCompat'

describe('the attributes gate (HI-2978)', () => {
  it('crlf, -crlf, !crlf and crlf=input are uses, as text and eol; a pattern merely named crlf is not', () => {
    for (const line of ['*.txt crlf', '*.txt -crlf', '*.txt !crlf', '*.txt crlf=input', 'docs/** -text crlf']) {
      expect(attributeUses(`${line}\n`, '.gitattributes').uses, line).toEqual([`.gitattributes: ${line}`])
    }
    expect(attributeUses('crlf binary-ish\n# *.txt crlf\n', '.gitattributes').uses).toEqual([])
  })

  it('the folders holding tracked files, each once, ancestors included, the root left out', () => {
    expect(trackedDirs(['a.txt', 'sub/deep/b.txt', 'sub/c.txt', 'sub/deep/more/d.txt', 'other/e'])).toEqual(['sub/deep', 'sub', 'sub/deep/more', 'other'])
    expect(trackedDirs([])).toEqual([])
    expect(trackedDirs(['', 'x'])).toEqual([])
  })
})
