// HI-3516: a branch's head that git couldn't read (lineHead's `rev-parse` failing past "no such branch") keeps git's own
// stderr, as the folder's branch and head reads do: a slot's detach notice says it after "Git said", never Combwork's own
// words for what it couldn't read. Real git answers 1 for every unreadable ref tried, so git's answer here is the test's.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/git', async (original) => {
  const real = await original<typeof import('../src/main/git')>()
  return {
    ...real,
    git: async (cwd: string, args: string[], ...rest: unknown[]) =>
      args.includes('rev-parse') ? { ok: false, code: 128, out: '', err: 'fatal: unable to read refs/heads/a@b: Permission denied\n', buf: Buffer.alloc(0) } : (real.git as (...a: unknown[]) => unknown)(cwd, args, ...rest)
  }
})

const { lineHead } = await import('../src/main/gitCommands')
const { isUnknown } = await import('../src/main/platform/types')

describe('lineHead (HI-3516)', () => {
  it("a read git fails keeps git's own words as its detail", async () => {
    // A name the ref files aren't read by (not plain), so git is asked.
    const r = await lineHead(process.cwd(), 'a@b')
    expect(isUnknown(r)).toBe(true)
    expect(isUnknown(r) && r.detail).toBe('fatal: unable to read refs/heads/a@b: Permission denied')
    expect(isUnknown(r) && r.what).toBe('the branch a@b')
  })
})
