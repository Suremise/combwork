// The offline Copilot test tier's helpers (tests/e2e/fake-copilot-api.cjs, #453): gh kept off a test Copilot's PATH
// whatever its folder is called, and the scripted stand-in model's steps.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'

const require = createRequire(import.meta.url)
const { pathWithoutGh, actionsOf, decide } = require('./e2e/fake-copilot-api.cjs')

const base = tempDir('hive-fake-copilot-')
afterAll(() => rmSync(base, { recursive: true, force: true }))
const PATHEXT = '.COM;.EXE;.BAT;.CMD'
/** A folder with these files in it (empty files: only their names count). */
function folder(name: string, files: string[]): string {
  const d = join(base, name)
  mkdirSync(d, { recursive: true })
  for (const f of files) writeFileSync(join(d, f), '')
  return d
}

describe("gh off a test Copilot's PATH, whatever its folder is called", () => {
  const sys = folder('System32', ['where.exe'])
  const git = folder('Git-cmd', ['git.exe'])
  const node = folder('nodejs', ['node.exe'])

  it('leaves out its own install folder, a portable folder and a bare script, and keeps the rest in order', () => {
    const own = folder('GitHub CLI', ['gh.exe'])
    const portable = folder('portable-tools', ['gh.cmd', 'jq.exe'])
    const script = folder('scripts', ['gh'])
    const ps = folder('ps-tools', ['gh.ps1'])
    const out = pathWithoutGh([sys, own, git, portable, node, script, ps].join(';'), { pathext: PATHEXT })
    expect(out.split(';')).toEqual([sys, git, node])
  })

  it('a shared folder (WinGet Links): gh goes, and a tool it links to is reached in its own folder', () => {
    const pkg = folder('Packages/GitHub.Copilot', ['copilot.exe'])
    const links = folder('Links', ['gh.exe', 'copilot.exe'])
    const realpath = (f: string) => (f.toLowerCase() === join(links, 'copilot.exe').toLowerCase() ? join(pkg, 'copilot.exe') : f)
    expect(pathWithoutGh([sys, links, git].join(';'), { pathext: PATHEXT, realpath }).split(';')).toEqual([sys, pkg, git])
  })

  it("refuses to lose a tool that shares gh's folder and is nowhere else, naming it; fine when it is elsewhere too", () => {
    const shared = folder('bin', ['gh.exe', 'git.exe'])
    expect(() => pathWithoutGh([sys, shared, node].join(';'), { pathext: PATHEXT })).toThrow(/without losing git \(it shares .*bin with gh\)/)
    expect(pathWithoutGh([sys, shared, git].join(';'), { pathext: PATHEXT }).split(';')).toEqual([sys, git])
    // Its link target's folder has gh too: no way round it.
    const both = folder('both', ['gh.exe', 'node.exe'])
    const linked = folder('linked', ['gh.exe', 'node.exe'])
    expect(() => pathWithoutGh([sys, linked].join(';'), { pathext: PATHEXT, realpath: () => join(both, 'node.exe') })).toThrow(/losing node/)
  })

  it("a test Combwork's environment: no gh where Windows looks, the login and token variables hidden, the profile faked", () => {
    const { copilotTestEnv } = require('./e2e/fake-copilot-api.cjs')
    const portable = folder('portable-tools-2', ['gh.cmd'])
    const was = process.env.PATH
    process.env.PATH = `${portable};${was}`
    try {
      const env = copilotTestEnv({ url: 'http://127.0.0.1:1/v1' }, join(base, 'env-run'), { above: base })
      expect(env.PATH.split(';')).not.toContain(portable)
      const where = require('child_process').spawnSync('where.exe', ['gh'], { env: { PATH: env.PATH, PATHEXT: process.env.PATHEXT, SystemRoot: process.env.SystemRoot } })
      expect(where.status).not.toBe(0)
      expect(env).toMatchObject({ COPILOT_HOME: join(base, 'env-run', 'copilot-home'), GH_CONFIG_DIR: join(base, 'env-run', 'copilot-gh'), USERPROFILE: base, HOME: base, COPILOT_OFFLINE: 'true' })
      for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN']) expect(env[k]).toBeUndefined()
      // #1308: its profile is a folder above where it works, so Copilot's walk for skills stops there; never left out.
      expect(() => copilotTestEnv({ url: 'http://127.0.0.1:1/v1' }, join(base, 'env-run'))).toThrow(/above/)
    } finally {
      process.env.PATH = was
    }
  })

  it('every caller gives it `above` (#1308: one left out throws in its setup)', () => {
    const tests = join(__dirname)
    const files = (readdirSync(tests, { recursive: true }) as string[]).filter((f) => /\.(c|m)?js$/.test(f) && !f.includes('node_modules'))
    const calls = files.flatMap((f) => [...readFileSync(join(tests, f), 'utf8').matchAll(/copilotTestEnv\(([^)]*)\)/g)].filter((m) => !/^\s*api\s*,\s*dir/.test(m[1])).map((m) => `${f}: ${m[0]}`))
    expect(calls.length).toBeGreaterThan(5)
    expect(calls.filter((c) => !/\{ above: /.test(c))).toEqual([])
  })

  it("keeps a folder named like gh's that holds no gh", () => {
    const empty = folder('GitHub CLI old', ['readme.txt'])
    expect(pathWithoutGh([sys, empty].join(';'), { pathext: PATHEXT }).split(';')).toEqual([sys, empty])
  })
})

describe("the stand-in model's steps", () => {
  it('reads the steps of a prompt, as the fake CLIs do', () => {
    expect(actionsOf('skill work-on-card boardmove 3 doing then boardcomment 3 then work 2 then say Done here.')).toEqual([
      { tool: 'skill', args: { skill: 'work-on-card' } },
      { tool: 'cw_update_task', args: { number: 3, column: 'doing' } },
      { tool: 'cw_update_task', args: { number: 3, comment: 'Fake: done, see the files.' } },
      { wait: 2000 },
      { say: 'Done here.' }
    ])
    expect(actionsOf('shell: git status && node check.js')).toEqual([{ tool: 'powershell', args: { command: 'git status && node check.js', description: 'Run a command', mode: 'sync', initial_wait: 30 } }])
    expect(actionsOf('cw cw_list_tasks {"column":"todo"}')).toEqual([{ tool: 'cw_list_tasks', args: { column: 'todo' } }])
    // "work N" anywhere in a step, as in a task's own words.
    expect(actionsOf('Run this, then reply "built" (work 10)')).toEqual([{ wait: 10000 }])
  })

  it("takes one step a request, counting the turn's tool calls after the person's dated prompt (a loaded skill isn't one)", () => {
    const tools = [{ function: { name: 'skill' } }, { function: { name: 'combwork-cw_update_task' } }]
    const prompt = { role: 'user', content: '<current_datetime>2026-10-09T00:00:00Z</current_datetime>\n\nskill work-on-card then boardmove 1 doing' }
    expect(decide({ tools, messages: [prompt] })).toMatchObject({ tool: 'skill', args: { skill: 'work-on-card' }, step: 0 })
    const call = { role: 'assistant', tool_calls: [{ id: 'c1' }] }
    // Copilot sends the skill it loaded back as a user message: still the same turn.
    const skillText = { role: 'user', content: '<skill-context>… skill and more …</skill-context>' }
    expect(decide({ tools, messages: [prompt, call, { role: 'tool', content: 'ok' }, skillText] })).toMatchObject({ tool: 'combwork-cw_update_task', args: { number: 1, column: 'doing' }, step: 1 })
    const done = decide({ tools, messages: [prompt, call, { role: 'tool' }, skillText, call, { role: 'tool' }] })
    expect(done).toMatchObject({ text: 'Done.', step: 2 })
    // The last reply takes a moment, so the turn is seen working.
    expect(done.wait).toBeGreaterThanOrEqual(1500)
    expect(decide({ tools: [], messages: [prompt] })).toMatchObject({ text: 'Fake Copilot: Copilot offers no tool skill.' })
  })
})
