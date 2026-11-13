// HI-2942 (SPEC's jj signing gate): a Git boolean read as Git reads it, checked value by value against git itself
// (`git -c k=v config --type=bool --get k`: true, false, or refused), never a list of the spellings we thought of.
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { describe, expect, it } from 'vitest'
import { gitBool } from '../src/main/platform/jjCompat'
import { tempDir } from './tempDir'

const require = createRequire(import.meta.url)
const { gitEnv } = require('./e2e/runContext.cjs') as { gitEnv: (vars?: Record<string, string>) => NodeJS.ProcessEnv }

describe('a Git boolean as Git reads it (HI-2942)', () => {
  const cwd = tempDir('gitbool-')
  const env = gitEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' })
  /** git's own reading: true, false, or null when it refuses the value. */
  function git(v: string | null): boolean | null {
    try {
      const out = execFileSync('git', ['-c', v === null ? 'x.y' : `x.y=${v}`, 'config', '--type=bool', '--get', 'x.y'], { cwd, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
      return out === 'true' ? true : out === 'false' ? false : null
    } catch {
      return null
    }
  }

  it('agrees with git on every spelling, numbers included', () => {
    const values: (string | null)[] = [
      null, '', 'true', 'TRUE', 'Yes', 'on', 'false', 'No', 'OFF',
      '1', '2', '-1', '+3', '0', '00', '-0', '0x0', '0x10', '0X1f', '010', '07', '08', '0x',
      '1k', '0k', '3M', '2g', '2G', '1x', '1kb', '1e3', '1.5',
      '2147483647', '2147483648', '-2147483647', '-2147483648', '-2147483649', '-2097152k', '-2097153k', '2097151k', '2097152k', '1g', '2g',
      ' 1', '1 ', ' true', 'true ', 'maybe', 'yes!'
    ]
    const ours = values.map((v) => [v, gitBool(v)])
    const gits = values.map((v) => [v, git(v)])
    expect(ours).toEqual(gits)
    // The case the card found: a nonzero number is true, and git says so.
    expect(gitBool('2')).toBe(true)
  })
})
