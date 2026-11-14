// A colocation change under a jj project while Combwork's slot work waits for the store's lock (HI-2896, design s13 §3,
// HR1's): `jj git colocation enable` (or `disable`) moves the Git store between `.jj/repo/store/git` and `.git`. A
// slot's making that read its context before the change and takes the lock after it refuses there (JjStoreChanged),
// nothing written: no workspace added, no folder made; the folder is detected afresh next time. Real jj, both ways.
// Skipped without the fetched jj (npm run jj:fetch).
import { existsSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { TESTED_JJ } from '../src/shared/jjTool'
import { JjStoreChanged } from '../src/main/platform/jjWorkspacePort'
import { harness, jjExe } from './jjWorkspaceHarness'

describe.skipIf(!jjExe)(`a colocation change while a slot's making waits for the store's lock (jj ${TESTED_JJ.version}), HI-2896`, () => {
  it.each([
    ['enable', false],
    ['disable', true]
  ] as const)('colocation %s: refused inside the lock, nothing written; the next making reads the repository afresh', async (how, colocated) => {
    const h = harness()
    const { repo, root, base } = h.repo(`coc${colocated ? 'c' : 'n'}`, colocated)
    // A first slot, so the control is made and the context cached in the port.
    let gate: Promise<void> | null = null
    let taken: () => void = () => undefined
    const port = h.portWith({
      lock: async (_s, fn) => {
        if (gate) {
          taken()
          await gate
        }
        return fn()
      }
    })
    expect(await port.create(repo, join(root, 'slot-a'), base)).toMatchObject({ ok: true })
    const workspaces = (): string => h.jj(repo, '--ignore-working-copy', 'workspace', 'list')
    const before = workspaces()
    // The next making waits for the lock; meanwhile the user changes the repository's colocation.
    let open!: () => void
    gate = new Promise<void>((r) => (open = r))
    const waiting = new Promise<void>((r) => (taken = r))
    const making = port.create(repo, join(root, 'slot-b'), base)
    await waiting
    h.jj(repo, 'git', 'colocation', how)
    expect(existsSync(join(repo, '.git'))).toBe(how === 'enable')
    open()
    await expect(making).rejects.toBeInstanceOf(JjStoreChanged)
    expect(existsSync(join(root, 'slot-b'))).toBe(false)
    expect(workspaces()).toBe(before)
    // Afresh: the folder's context is read again (the old one dropped), never the store it named before.
    gate = null
    const again = await port.create(repo, join(root, 'slot-c'), base)
    // A slot made from the old control under the new colocation either works or is refused, never written to the old store.
    if ('ok' in again && again.ok) expect(existsSync(join(root, 'slot-c', '.jj'))).toBe(true)
  })
})
