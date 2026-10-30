// Tests' temp folders, by their long, real paths (#448). GitHub's runner has its temp folder at C:\Users\RUNNER~1\…, the
// 8.3 short form, while Hive and git resolve real paths (#389): a test comparing a folder it made under os.tmpdir() with
// one Hive or git gave back passed on every machine but CI's. Tests make their folders here instead, and one that needs
// another name for a folder (an 8.3 name, a junction) makes it on purpose with pathAliases.ts. tests/tempDir.test.ts
// fails on any other use of os.tmpdir() in the tests.
//
// The folder is the run's own (tests/runTemp.mts: #992, #995, HI-2102), in the test area, %LOCALAPPDATA%\hive-test\tmp,
// not %TEMP%. Every folder tempDir() makes is also removed as its test file ends (tests/tempCleanup.ts), so a run doesn't
// grow as it goes.
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tempRoot } from './runTemp.mts'

export { endRunTemp, pruneRunTemps, startRunTemp, tempArea, tempRoot } from './runTemp.mts'
const made = new Set<string>()

/** A new, empty folder in the temp folder, named `prefix` and six random characters, by its real, long path. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tempRoot(), prefix))
  made.add(dir)
  return dir
}

/**
 * Removes every folder tempDir() has made (in this test file: each file has its own copy of this module) and not yet
 * removed here. Replies with those it couldn't remove (a file still open), with why, and keeps them for the next call.
 */
export function removeTempDirs(): string[] {
  const failed: string[] = []
  for (const dir of made) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
      made.delete(dir)
    } catch (e) {
      failed.push(`${dir}: ${(e as Error).message}`)
    }
  }
  return failed
}
