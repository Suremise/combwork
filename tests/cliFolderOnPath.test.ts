// #1103, the case seen on Darren's PC in the 0.9.2 release: Claude Code installed by its native installer in
// ~\.local\bin, a folder on no PATH (Combwork's, the registry's). Provider Setup found it where it installs it, but a shell Combwork
// started couldn't run `claude`. Once Combwork's refresh finds it, its folder is on the PATH of what Combwork starts (its child
// environment), so a shell finds the same CLI by name; Combwork's own PATH, which it finds the CLIs on, is unchanged. The registry is a stand-in (CW_TEST_REGISTRY_PATH: none), the
// home a temp folder, and the CLI's answers stubbed: nothing of the machine's own is read or changed.
import { spawnSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { delimiter, join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

const home = tempDir('cw-cli-folder-')
const bin = join(home, '.local', 'bin')
const exe = join(bin, process.platform === 'win32' ? 'claude.exe' : 'claude')
mkdirSync(bin, { recursive: true })
writeFileSync(exe, '')

vi.mock('os', async (actual) => ({ ...(await actual<typeof import('os')>()), homedir: () => home }))
vi.mock('../src/main/providers/common', async (actual) => ({
  ...(await actual<typeof import('../src/main/providers/common')>()),
  // The stand-in CLI: a version, signed out; nothing else on the machine answers (where.exe finds no claude).
  run: async (file: string, args: string[]) => (file === exe && args[0] === '--version' ? { stdout: '2.1.303 (Claude Code)', stderr: '', code: 0 } : file === exe ? { stdout: '{"loggedIn":false}', stderr: '', code: 0 } : { stdout: '', stderr: '', code: 1 })
}))

const saved = { PATH: process.env.PATH, Path: process.env.Path, CW_TEST_REGISTRY_PATH: process.env.CW_TEST_REGISTRY_PATH }
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe("a standalone CLI found off PATH, on Combwork's PATH for what it starts (#1103)", () => {
  it.runIf(process.platform === 'win32')('a shell Combwork starts finds `claude` where Provider Setup found it', async () => {
    // Combwork's PATH: Windows' own folders only (no ~\.local\bin), and no registry folders to add.
    const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
    const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
    process.env[key] = system32
    process.env.CW_TEST_REGISTRY_PATH = ''
    const { childEnv } = await import('../src/main/ptyHost')
    const whereClaude = () => spawnSync(join(system32, 'where.exe'), ['claude'], { env: childEnv(), encoding: 'utf8', windowsHide: true })
    expect(whereClaude().status).not.toBe(0)

    const { providerService } = await import('../src/main/providerService')
    const [info] = await providerService.refresh('claude-code', false)
    expect(info).toMatchObject({ found: true, path: exe, source: 'native install' })
    // Combwork's own PATH, which it finds the CLIs on, stays as it was; what it starts gets the folder, at the end.
    expect(process.env[key]).toBe(system32)
    const child = childEnv()
    expect(child[Object.keys(child).find((k) => k.toUpperCase() === 'PATH')!].split(delimiter)).toEqual([system32, bin])
    // What a session or a terminal Combwork starts gets: the same CLI, by name.
    const found = whereClaude()
    expect(found.status).toBe(0)
    expect(found.stdout.trim().split(/\r?\n/)[0].toLowerCase()).toBe(exe.toLowerCase())
  })
})
