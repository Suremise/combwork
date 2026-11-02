import { createRequire } from 'module'
import { readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'

const { shellStderrFile } = createRequire(import.meta.url)('./e2e/fake-claude/shellStderr.cjs') as { shellStderrFile: (home: string, agent?: string) => string }

// The fake's shell writes a command's standard error so far to its agent's file, and suites wait on it (HI-1816): an
// agent's display name may hold characters a file name can't, and must never stop the fake's shell commands.
describe("the fake's shell standard error file", () => {
  it('is in the home for an ordinary name and for display names with separators or reserved characters', () => {
    const home = tempDir('fakeshell-')
    for (const [name, file] of [
      ['B2', 'fake-shell-stderr-B2.txt'],
      ['Builder/QA', 'fake-shell-stderr-Builder_QA.txt'],
      ['a\\b:c*d?"e<f>g|h', 'fake-shell-stderr-a_b_c_d__e_f_g_h.txt'],
      [undefined, 'fake-shell-stderr-agent.txt']
    ] as const) {
      const at = shellStderrFile(home, name)
      expect(dirname(at)).toBe(home)
      expect(at.endsWith(file)).toBe(true)
      // Written as the fake writes it, and read back as a suite reads it.
      writeFileSync(at, '')
      writeFileSync(at, 'hive-progress: waiting for a check copy\n', { flag: 'a' })
      expect(readFileSync(shellStderrFile(home, name), 'utf8')).toContain('waiting for a check copy')
    }
  })
})
