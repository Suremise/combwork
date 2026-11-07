// A process that fails to start is reported with its code (#599): what a Windows exit code means (windowsExits.cjs),
// the e2e runner's record of it, and the rule that test tooling starts nothing through the shell, so every child keeps
// Node's error mode (which keeps away the dialogs it governs; not every dialog under real load: windowsExits.cjs).
import { execFileSync, spawnSync } from 'child_process'
import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: plain .mjs modules without types
import { recordJson, recordMarkdown } from './e2e/record.mjs'
// @ts-expect-error: plain .mjs modules without types
import { resultLines } from './e2e/runner.mjs'

const { ntstatus, describeExit, exitText, windowsCodesIn } = createRequire(import.meta.url)('./e2e/windowsExits.cjs')
const { baseEnv } = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: () => NodeJS.ProcessEnv }
const childEnv = baseEnv
const root = join(__dirname, '..')

describe('what a Windows exit code means', () => {
  it('reads a status code however Node reports it, and leaves ordinary exit codes alone', () => {
    expect([ntstatus(3221225794), ntstatus(-1073741502), ntstatus(0xc0000135)]).toEqual([0xc0000142, 0xc0000142, 0xc0000135])
    expect([ntstatus(0), ntstatus(1), ntstatus(130), ntstatus(null), ntstatus(2 ** 33), ntstatus(1.5)]).toEqual([null, null, null, null, null, null])
  })

  it('says the code and what to do: a startup failure under load means fewer runs at once', () => {
    expect(describeExit(3221225794)).toBe("0xc0000142: a DLL failed to initialise as it started, usually Windows' desktop heap running short with many processes at once: rerun with fewer runs at once")
    expect(exitText(-1073741515)).toBe("0xc0000135: a DLL it needs wasn't found")
    expect(exitText(0xc0001234)).toBe('0xc0001234: the process ended abnormally (a Windows status code)')
    expect([exitText(1), exitText(null), describeExit(1)]).toEqual(['1', 'null', null])
  })

  it('finds the known codes in output, each once, and nothing in numbers that only look like one', () => {
    const out = ['<process did exit: exitCode=3221225794, signal=null>', 'git exited with 0xC0000142', 'Error: exit code -1073741819', 'took 3221291234 ms', 'id 0xc0001234', 'v1.3221225794.0']
    expect(windowsCodesIn(out.join('\n'))).toEqual([describeExit(0xc0000142), describeExit(0xc0000005)])
    expect(windowsCodesIn('')).toEqual([])
    expect(windowsCodesIn(undefined)).toEqual([])
  })

  // A real child, not a number (the failfast suite's check until HI-2663): a child that has started ends with the
  // status a process that can't initialise ends with, so nothing unsigned runs and no dialog can show; its parent sees
  // that code as it ends, and it reads as the startup failure.
  it.runIf(process.platform === 'win32')("a child ending with STATUS_DLL_INIT_FAILED: its parent sees the code, and it reads as a startup failure", () => {
    const r = spawnSync(process.execPath, ['-e', 'process.exit(-1073741502)'], { stdio: 'ignore', windowsHide: true, timeout: 30000, env: childEnv() })
    expect(r.error).toBeUndefined()
    expect(r.status).toBe(0xc0000142)
    expect(describeExit(r.status)).toMatch(/^0xc0000142: a DLL failed to initialise/)
  })
})

describe("the runner's line for a suite that ended with a Windows code (#599)", () => {
  it('says the code and its meaning in the line, and the codes its output named under it', () => {
    expect(resultLines('board', { ok: false, code: 3221225794, seconds: 4, failed: [], windows: [describeExit(0xc0000135)] })).toEqual([
      `board                 FAIL  4s  (exit ${describeExit(0xc0000142)})`,
      `    Windows: ${describeExit(0xc0000135)}`
    ])
    expect(resultLines('files', { ok: false, code: 1, seconds: 2, failed: ['FAIL x '], windows: [] })).toEqual(['files                 FAIL  2s  (exit 1; 1 failed check)', '    FAIL x'])
    // A passed suite says nothing of what its output named; a skipped one, its reason.
    expect(resultLines('about', { ok: true, code: 0, seconds: 3, failed: [], windows: [describeExit(0xc0000005)] })).toEqual(['about                 pass  3s'])
    expect(resultLines('codex', { skipped: 'environment: no Codex', seconds: 0 })).toEqual(['codex                 SKIP  0s  (environment: no Codex)'])
  })
})

describe("the run record names a failed suite's Windows codes (#599)", () => {
  const results = [
    { name: 'about', ok: true, seconds: 3, code: 0, windows: [] },
    { name: 'board', ok: false, seconds: 9, code: 3221225794, failed: [], windows: [describeExit(0xc0000135)] },
    { name: 'files', ok: false, seconds: 5, code: 1, failed: ['FAIL x'], windows: [] }
  ]

  it('in the Markdown, after the table', () => {
    const md = recordMarkdown({ code: 'abc1234', when: '2026-10-11 15:00', jobs: 4, results, logDir: 'C:\\logs', summary: '1 passed, 2 failed' })
    expect(md).toContain(`Windows codes (#599): board: exit ${describeExit(0xc0000142)}; ${describeExit(0xc0000135)}.`)
    expect(md).not.toMatch(/files: |about: /)
  })

  it('in the JSON, for scripts', () => {
    const json = recordJson({ code: 'abc1234', when: 'now', results })
    expect(json.results.map((r: { windows?: string[] }) => r.windows ?? null)).toEqual([null, [`exit ${describeExit(0xc0000142)}`, describeExit(0xc0000135)], null])
  })
})

describe('test tooling starts nothing through the shell (#599)', () => {
  it('so every process it starts directly keeps Node’s error mode', () => {
    // ShellExecute starts a program with the default error mode, under which a startup failure shows Windows' dialog and
    // waits for someone to click OK. child_process (and node-pty) start it directly, with the parent's mode.
    const shellLaunch = [/Start-Process/i, /Invoke-Item/i, /\bshell\.open(Path|External)\s*\(/, /['"]\/c['"],\s*['"]start['"]/i, /cmd(\.exe)?\s+\/c\s+start\b/i, /\bstart\s+""/i]
    // Lines that name the rule without starting anything: the focused tests' picker lists what this test scans (HI-1367);
    // the Sandbox checks run a command inside Windows Sandbox (its guest, not this machine), and their tests quote the
    // errors PowerShell wrote there (HI-2298).
    const allowed: Record<string, string[]> = {
      'tests/sandbox/checks.cjs': ["await s.run(1, '1. open Installed apps', 'start \"\" ms-settings:appsfeatures', { timeoutSec: 30 })"],
      'tests/sandboxChecks.test.ts': [
        "const BLOCKED_ERR = 'Start-Process : This command cannot be run due to the error: An Applic \\r\\nation Control policy has blocked this file.\\r\\nAt C:\\\\tools\\\\combwork-tests\\\\sandbox\\\\inside\\\\install.ps1:17 char:6'",
        "const { r, json } = runChecks('install-fails', [{ match: 'install\\\\.ps1', exit: 1, stderr: 'Start-Process : The system cannot find the file specified.' }], ['--only', 'fresh'])"
      ],
      'tests/e2e/affected.mjs': ["{ test: 'tests/windowsExits.test.ts', paths: ['tests/', 'scripts/'], lines: ['start-process', 'invoke-item', 'shell\\\\.open(path|external)', '\\\\bstart\\\\b'] },"]
    }
    const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', 'tests', 'scripts'], { cwd: root, encoding: 'utf8' })
      .split(/\r?\n/)
      .filter((f) => /\.(c|m)?[jt]s$/.test(f) && !f.startsWith('tests/fixtures/') && f !== 'tests/windowsExits.test.ts')
    expect(files.length).toBeGreaterThan(100)
    const found = files.flatMap((f) =>
      readFileSync(join(root, f), 'utf8')
        .split(/\r?\n/)
        // Code, not the comments that explain the rule.
        .flatMap((l, i) => (!/^\s*(\/\/|\*|\/\*)/.test(l) && shellLaunch.some((re) => re.test(l)) && !allowed[f]?.includes(l.trim()) ? [`${f}:${i + 1}`] : []))
    )
    expect(found).toEqual([])
    // Each allowance is still there: one that isn't goes from the list.
    for (const [f, lines] of Object.entries(allowed)) expect(readFileSync(join(root, f), 'utf8').split(/\r?\n/).map((l) => l.trim()), f).toEqual(expect.arrayContaining(lines))
  })
})
