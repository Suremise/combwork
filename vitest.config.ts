import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { configDefaults, defineConfig } from 'vitest/config'
import { globsUncached } from './tests/globCacheKey.mts'
import { progressWanted, VitestProgress } from './tests/progressReport.mts'
import { startRunTemp } from './tests/runTemp.mts'

// The run's temp folder is the tests' own, in combwork-test\tmp (tests/runTemp.mts, #992), not %TEMP%: Vitest's copies of the
// modules it serves the workers (about 600 files a run, which it leaves behind), the temp files of Hive's code under test
// and of the programs tests start (git) go there too, where Hive's Antivirus scanning setting covers them. Set before
// Vitest starts its workers, which inherit it (TEMP, TMP and TMPDIR). It is the run's own folder, which tests/tempRun.ts
// removes once the run has ended (#995); the next run's start removes one a stopped run left (HI-2102), as the board's
// evidence rules allow (tests/e2e/evidence.cjs: read only if there is one to remove).
let evidence: { protects: (p: string) => string | null } | undefined
startRunTemp((p) => (evidence ??= createRequire(import.meta.url)('./tests/e2e/evidence.cjs').evidenceFor(fileURLToPath(new URL('.', import.meta.url)))).protects(p))

export default defineConfig({
  // Hive's main-process modules import Electron; unit tests use a stub (no Electron binary needed, e.g. in CI). They
  // also use Electron's original-fs (no .asar handling, #246), which is Node's fs outside Electron: vi.mock('fs') and
  // vi.mock('fs/promises') reach them too. `@shared` is the renderer's name for src/shared, for a test of a renderer module
  // (HI-1863: its store).
  resolve: { alias: { electron: fileURLToPath(new URL('./tests/electron-stub.ts', import.meta.url)), 'original-fs': 'fs', '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) } },
  // Vitest's disk module cache (fsModuleCache, on by default) keys a module on its own source, and skips only an untyped
  // `import.meta.glob(`: a typed glob (schema.ts, installDir.ts, catalogues.ts) kept its folder as a past run saw it, so a
  // new agent-text schema area went unseen (HI-2457). Those modules are transformed each run; all others stay cached.
  plugins: [globsUncached()],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // fs.watch watches real paths, so a short (8.3) temp folder can't trip Node's libuv (tests/watchRealPaths.ts, #389), and
    // git runs with none of the shell's GIT_* variables (tests/cleanGitEnv.ts, #425, first) and no global config, as on
    // GitHub's runner (tests/noGlobalGit.ts, #448), as Git for Windows' own git.exe rather than its launcher where PATH has
    // the launcher first (tests/directGit.ts, HI-2025). Claude Code, Codex and Copilot get empty homes, never the user's
    // (tests/cliHomes.ts, HI-1703). Each file's temp folders go when it ends (tests/tempCleanup.ts, #995).
    setupFiles: ['tests/cleanGitEnv.ts', 'tests/watchRealPaths.ts', 'tests/noGlobalGit.ts', 'tests/directGit.ts', 'tests/cliHomes.ts', 'tests/tempCleanup.ts'],
    // A full run is a heavy run: it waits for a test slot as a full e2e set does (tests/unitSlot.ts, #599).
    globalSetup: ['tests/unitSlot.ts', 'tests/tempRun.ts'],
    // Under load (e2e sets, scenario runs and other agents' tests on the same machine), Vitest's defaults (5 s a test, a
    // worker per core) made tests fail that pass alone (#189, #196, #204): half the cores, so a full run beside an e2e set
    // leaves it room, and longer limits. Not to cover a wait for time: tests wait for conditions (#524's rule,
    // #528); the limit bounds slow work (git, file scans). Measured with four full runs at once (#528): 83 of 2,228 tests
    // took over 5 s and 39 over 10 s, so it can't come back to 5 s. A test that needs more says so itself.
    maxWorkers: '50%',
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Run inside a Hive agent's session: the files' progress in Hive's Progress panel (tests/progressReport.mts), added to
    // Vitest's own reporters (which it picks by where it runs: minimal for a coding agent), so the output is unchanged.
    ...(progressWanted() ? { reporters: [...configDefaults.reporters, new VitestProgress()] } : {})
  }
})
