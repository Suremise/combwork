// Starting a CLI from a .cmd launcher: a Node CLI's (npm's, or a one-line one) is started as node and its script,
// without cmd.exe and its 8,191-character command line; anything else still goes through cmd.exe, and a command line
// too long for it is refused with a message saying what to do, rather than cmd.exe exiting at once.
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { CMD_MAX_CHARS, commandLineLength, promptArg, run, runsThroughCmd, shimTarget, toSpawnable } from '../src/main/providers/common'
import { tempDir } from './tempDir'

const base = tempDir('cw-cmdshim-')
afterAll(() => rmSync(base, { recursive: true, force: true }))
const windows = process.platform === 'win32'

/** npm's launcher for a package's bin, as `npm install -g` writes it (cmd-shim). */
const NPM_SHIM = (rel: string) => `@ECHO off\r
GOTO start\r
:find_dp0\r
SET dp0=%~dp0\r
EXIT /b\r
:start\r
SETLOCAL\r
CALL :find_dp0\r
\r
IF EXIST "%dp0%\\node.exe" (\r
  SET "_prog=%dp0%\\node.exe"\r
) ELSE (\r
  SET "_prog=node"\r
  SET PATHEXT=%PATHEXT:;.JS;=;%\r
)\r
\r
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*\r
`

function npmInstall(dir: string, withNode: boolean): string {
  mkdirSync(join(dir, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), '// codex')
  if (withNode) writeFileSync(join(dir, 'node.exe'), '')
  const cmd = join(dir, 'codex.cmd')
  writeFileSync(cmd, NPM_SHIM('node_modules\\@openai\\codex\\bin\\codex.js'))
  return cmd
}

describe('a .cmd launcher', () => {
  const pathDir = join(base, 'path-node')
  mkdirSync(pathDir, { recursive: true })
  writeFileSync(join(pathDir, 'node.exe'), '')
  const env = { PATH: pathDir }

  it("npm's: its node.exe beside it, else node on PATH, and the package's script", () => {
    const own = npmInstall(join(base, 'npm-own-node'), true)
    expect(shimTarget(own, env)).toEqual({ node: join(base, 'npm-own-node', 'node.exe'), script: join(base, 'npm-own-node', 'node_modules', '@openai', 'codex', 'bin', 'codex.js') })
    const global = npmInstall(join(base, 'npm-global'), false)
    expect(shimTarget(global, env)?.node).toBe(join(pathDir, 'node.exe'))
    expect(shimTarget(global, { PATH: join(base, 'nowhere') })).toBeNull()
  })

  it('a one-line one (@node "%~dp0cli.cjs" %*)', () => {
    const dir = join(base, 'one-line')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'cli.cjs'), '')
    writeFileSync(join(dir, 'cli.cmd'), '@node "%~dp0cli.cjs" %*\r\n')
    expect(shimTarget(join(dir, 'cli.cmd'), env)).toEqual({ node: join(pathDir, 'node.exe'), script: join(dir, 'cli.cjs') })
  })

  it("anything that does more than run node on its script isn't taken for one, since starting the script would lose it", () => {
    const dir = join(base, 'others')
    mkdirSync(join(dir, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true })
    writeFileSync(join(dir, 'cli.cjs'), '')
    writeFileSync(join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), '')
    const npm = NPM_SHIM('node_modules\\@openai\\codex\\bin\\codex.js')
    const cases: Record<string, string> = {
      'exe.cmd': '@"%~dp0real.exe" %*\r\n',
      'missing.cmd': '@node "%~dp0gone.cjs" %*\r\n',
      'extra.cmd': '@node "%~dp0cli.cjs" --profile work\r\n',
      'python.cmd': '@python "%~dp0cli.cjs" %*\r\n',
      // Fixed arguments as well as the caller's, Node flags, setup before it: all dropped by a direct start.
      'fixed-args.cmd': '@node "%~dp0cli.cjs" --profile work %*\r\n',
      'node-flags.cmd': '@node --require bootstrap.cjs "%~dp0cli.cjs" %*\r\n',
      'setup.cmd': '@SET CODEX_HOME=D:\\codex-home\r\n@node "%~dp0cli.cjs" %*\r\n',
      // npm's own generator can add interpreter arguments and environment variables, or pick another interpreter.
      'npm-other-prog.cmd': npm.replace('SET "_prog=node"', 'SET "_prog=python"'),
      'npm-env.cmd': npm.replace('SETLOCAL\r\n', 'SETLOCAL\r\n@SET CODEX_HOME=D:\\codex-home\r\n'),
      'npm-args.cmd': npm.replace('"%_prog%"  "%dp0%', '"%_prog%" --max-old-space-size=4096 "%dp0%'),
      'npm-fixed-args.cmd': npm.replace('codex.js" %*', 'codex.js" --profile work %*')
    }
    for (const [name, text] of Object.entries(cases)) {
      writeFileSync(join(dir, name), text)
      expect(shimTarget(join(dir, name), env), name).toBeNull()
    }
    expect(shimTarget(join(dir, 'not-there.cmd'), env)).toBeNull()
  })
})

describe.runIf(windows)('starting one', () => {
  // The Combwork Assistant's Codex launch: hooks, their trust records, its instructions and the combwork MCP server.
  const long = ['--no-daemon', ...Array.from({ length: 12 }, (_, i) => ['-c', `hooks.Event${i}=[{hooks=[{type="command",command="curl.exe -s -m 5 -X POST ${'x'.repeat(260)}"}]}]`]).flat(), '-c', `developer_instructions="${'Combwork guidance. '.repeat(300)}"`]

  it('a Node CLI: as node and its script, its arguments as they are, whatever their length', () => {
    const cmd = npmInstall(join(base, 'spawn-npm'), true)
    const s = toSpawnable(cmd, long)
    expect(s.file).toBe(join(base, 'spawn-npm', 'node.exe'))
    expect(s.args).toEqual([join(base, 'spawn-npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), ...long])
    expect(commandLineLength(s.file, s.args)).toBeGreaterThan(CMD_MAX_CHARS)
    // Its prompt and name aren't flattened for cmd.exe.
    expect(runsThroughCmd(cmd)).toBe(false)
    expect(promptArg(cmd, 'Fix "the" tests\nin web & more')).toBe('Fix "the" tests\nin web & more')
  })

  it("anything else: through cmd.exe while it fits, and a clear refusal when it doesn't", () => {
    const dir = join(base, 'spawn-other')
    mkdirSync(dir, { recursive: true })
    const cmd = join(dir, 'tool.cmd')
    writeFileSync(cmd, '@"%~dp0tool.exe" %*\r\n')
    expect(toSpawnable(cmd, ['--version']).args).toEqual(['/d', '/s', '/c', cmd, '--version'])
    expect(() => toSpawnable(cmd, long)).toThrow(/tool\.cmd has to run through cmd\.exe, which takes a command line of at most 8,191 characters.*Set the CLI's path in Settings to its \.exe/)
    expect(runsThroughCmd(cmd)).toBe(true)
    expect(promptArg(cmd, 'Fix "the" tests & 100%')).toBe('Fix the tests 100')
  })
})

// HI-2548: a CLI's checks (its --version, Antigravity's models) run its .cmd through cmd: at a path with spaces and
// non-ASCII letters, it was read as the path's first word and the CLI not found, so Combwork took another copy.
describe('a check run through a .cmd at a path with spaces and non-ASCII letters (HI-2548)', () => {
  it.runIf(windows)('runs it, its arguments passed as they are', async () => {
    const dir = join(base, 'my tools é 漢字', 'agy bin ß')
    mkdirSync(dir, { recursive: true })
    const cmd = join(dir, 'tool.cmd')
    writeFileSync(cmd, '@echo version 1.5.0 %*\r\n')
    const r = await run(cmd, ['--version'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe('version 1.5.0 --version')
    expect((await run(cmd, ['two words'])).stdout.trim()).toBe('version 1.5.0 "two words"')
  })
})
