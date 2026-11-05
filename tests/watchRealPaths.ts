// Unit tests run in Node, whose libuv asserts (and kills the worker: "Assertion failed: !_wcsnicmp(filename, dir, dirlen),
// file src\win\fs-event.c") when fs.watch watches a folder by its 8.3 short name and a file in it is reported by its short
// name too. GitHub's runner has its temp folder at C:\Users\RUNNER~1\…, so any test watching a workspace in tmpdir() can
// hit it. Electron's libuv doesn't assert (checked, #389), so Combwork itself is unaffected. Here every watch watches the
// folder's real path instead: the same folder, and the same file names relative to it. Tests make their folders by their
// real paths (tests/tempDir.ts, #448); this keeps a test that watches a short name on purpose (tests/pathAliases.ts) safe.
import fs from 'fs'
import { syncBuiltinESMExports } from 'module'

const marked = fs as typeof fs & { hiveRealWatch?: true }
if (!marked.hiveRealWatch) {
  const watch = fs.watch
  const real = (p: unknown): unknown => {
    if (typeof p !== 'string') return p
    try {
      return fs.realpathSync.native(p)
    } catch {
      return p
    }
  }
  fs.watch = ((p: fs.PathLike, ...rest: unknown[]) => (watch as (...a: unknown[]) => fs.FSWatcher)(real(p), ...rest)) as typeof fs.watch
  marked.hiveRealWatch = true
  // chokidar imports watch from node:fs as an ES module: this updates that binding too.
  syncBuiltinESMExports()
}
