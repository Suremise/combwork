// Electron's own Node has CVE-2026-111497's fix (Node2Shell, an out-of-bounds write in Node's Brotli decoder, fixed in
// Node 24.22.1): Electron 44.10.0 is the first 44.x to bundle it (HI-1503). Checked here from package.json and the
// lockfile, which CI has; the e2e suite `about` checks the running app's process.versions.node too.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
/** The first Electron 44.x bundling Node 24.22.1. */
const FLOOR = '44.10.0'

const parts = (v: string): number[] => v.split('.').map(Number)
/** Whether version a is b or later. */
function atLeast(a: string, b: string): boolean {
  const [x, y] = [parts(a), parts(b)]
  const i = x.findIndex((n, k) => n !== y[k])
  return i < 0 || x[i] > y[i]
}

describe("Electron's Node has CVE-2026-111497's fix (HI-1503)", () => {
  it(`package.json asks for Electron ${FLOOR} or later`, () => {
    const range = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> }).devDependencies.electron
    const min = /^[\^~]?(\d+\.\d+\.\d+)$/.exec(range)?.[1]
    expect(min, `a plain range such as ^${FLOOR}, not ${range}`).toBeTruthy()
    expect(atLeast(min!, FLOOR), `electron ${range}`).toBe(true)
  })

  it(`the lockfile installs Electron ${FLOOR} or later`, () => {
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> }
    const version = lock.packages['node_modules/electron']?.version ?? ''
    expect(atLeast(version, FLOOR), `electron ${version}`).toBe(true)
  })
})
