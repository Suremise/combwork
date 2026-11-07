// A worktree's setup command runs in the agent's terminal as typed (#1454): on Windows cmd is given one command line,
// `/d /s /c "<command>"`, passed by node-pty as written. As arguments, node-pty quoted the command CRT-style and turned
// each `"` in it into `\"`, which cmd doesn't read: `node "C:\a b\setup.js"` reached node with its quotes in it, and
// the setup failed (the agent never started). Run here for real, directly and through the launch gate (#507).
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

const req = createRequire(import.meta.url)
const { stopProcessesIn } = req('./e2e/folderProcesses.cjs') as { stopProcessesIn: (folder: string, since?: number) => number }
// The run context's allowlisted environment, never the shell's (tests/README.md).
const { baseEnv } = req('./e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }

vi.mock('../src/main/events', () => ({ emit: () => undefined, sendPty: () => undefined, onCombworkEvent: () => () => undefined }))
vi.mock('../src/main/providers', () => ({ allProviders: () => [] }))

const { shellCommand } = await import('../src/main/sessions')

describe("a worktree setup command's command line", () => {
  it('is cmd /d /s /c with the command quoted as a whole on Windows, sh -c elsewhere', () => {
    expect(shellCommand('node "C:\\a b\\setup.js"', 'win32').args).toBe('/d /s /c "node "C:\\a b\\setup.js""')
    expect(shellCommand('npm ci', 'linux')).toEqual({ file: '/bin/sh', args: ['-c', 'npm ci'] })
  })
})

describe.runIf(process.platform === 'win32')('a worktree setup command with a quoted path run in a terminal', () => {
  const dir = tempDir('cw-shell-command-')
  // A folder with a space (and an & cmd would read as a command separator unquoted), as the path the user quotes.
  const spaced = join(dir, 'with space & ampersand')
  mkdirSync(spaced, { recursive: true })
  const script = join(spaced, 'setup.js')
  writeFileSync(script, "console.log('SETUP-ARGS ' + JSON.stringify(process.argv.slice(2)))\n")
  const env = baseEnv()
  const plain = (s: string): string => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\s+/g, ' ')

  async function run(name: string, gated: boolean): Promise<{ code: number; output: string }> {
    const { spawnPty } = await import('../src/main/ptyHost')
    const sh = shellCommand(`"${process.execPath}" "${script}" "two words" && echo AFTER-SETUP`)
    let output = ''
    const since = Date.now()
    try {
      const code = await new Promise<number>((resolve) => {
        spawnPty(`setup-${name}`, { file: sh.file, args: sh.args, cwd: dir, env, ...(gated ? { track: async () => ({ go: true as const }) } : {}), onData: (d) => (output += d), onExit: (c) => resolve(c) })
      })
      return { code, output: plain(output) }
    } finally {
      stopProcessesIn(dir, since)
    }
  }

  for (const gated of [false, true]) {
    it(`runs as typed${gated ? ', through the launch gate' : ''}: the program gets its arguments without quotes, and what follows runs`, async () => {
      const { code, output } = await run(gated ? 'gated' : 'plain', gated)
      expect(output).toContain('SETUP-ARGS ["two words"]')
      expect(output).toContain('AFTER-SETUP')
      expect(code).toBe(0)
    })
  }
})
