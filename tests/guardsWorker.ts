// The merge guards' worker for a test file (HI-3284, HR2's round 1, finding 1): built here with esbuild, as the app's
// build makes merge-guards-worker.js, and given to mergeGuardsRun for the file's tests. A user's pattern never runs on
// main's thread, so a test that matches guards needs the real worker, never an in-process stand-in.
import { join } from 'path'
import { build } from 'esbuild'
import { afterAll, beforeAll } from 'vitest'
import { useGuardsWorker } from '../src/main/workflow/mergeGuardsRun'
import { tempDir } from './tempDir'

/** Builds the worker before the file's tests and gives it back after; its bundle's path. */
export function withGuardsWorker(): { bundle: string } {
  const out = { bundle: join(tempDir('cw-merge-guards-worker-'), 'merge-guards-worker.cjs') }
  beforeAll(async () => {
    await build({ entryPoints: [join(__dirname, '..', 'src', 'main', 'workflow', 'mergeGuardsWorker.ts')], outfile: out.bundle, bundle: true, platform: 'node', format: 'cjs', alias: { 'original-fs': 'fs' }, logLevel: 'silent' })
    useGuardsWorker(out.bundle)
  }, 60_000)
  afterAll(() => useGuardsWorker(null))
  return out
}
