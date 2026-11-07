// HI-2682 (SPEC §11): a local model's context and output budget on a Claude Code server connection. The launch side
// (localLimitsFor): which IDs get them, resolved in the session's own settings scopes (aliases, spellings, mappings,
// unreadable files), the values Claude Code ends up with after each scope's env, and the refusals and the one fallback
// that keep an output below its context. The window side: the default output, the fit advice, and the meter's window and
// lines from a launch's record, never the connection now.
import { describe, expect, it } from 'vitest'
import { lastModelArg, localLimitsFor, mapsModel } from '../src/main/providers/claude/localLimits'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { tempDir } from './tempDir'
import { declaredFor, defaultOutput, launchedWindow, localLimitsLines, outputFits, staticSupport, tightFit } from '../src/shared/localModelLimits'
import { autoCompactLine, contextLines } from '../src/shared/providers'
import { providerDescriptor } from '../src/shared/providers'
import { ADVANCED_DEFS, LOCAL_MODEL_ALIASES_ID, LOCAL_MODEL_SPELLINGS_ID } from '../src/shared/advanced'
import { cleanModels, mergeListed } from '../src/shared/serverConnection'
import { tr } from '../src/shared/i18n'
import type { SettingsScope } from '../src/main/providers/claude/autoCompact'
import type { ServerModel } from '../src/shared/types'

const caps = providerDescriptor('claude-code').capabilities.connections!.server!
const pattern = (id: string): RegExp => {
  const d = ADVANCED_DEFS.find((x) => x.id === id)!
  return new RegExp(d.default as string, d.flags ?? '')
}
const test = (id: string) => staticSupport(id, pattern(LOCAL_MODEL_ALIASES_ID), pattern(LOCAL_MODEL_SPELLINGS_ID))
const scope = (label: string, json: unknown, more: Partial<SettingsScope> = {}): SettingsScope => ({ label, json, ...more })
const run = (models: ServerModel[], o: { model?: string | null; env?: Record<string, string>; scopes?: SettingsScope[] } = {}) =>
  localLimitsFor({ caps, models, connection: 'Local', agent: 'B1', model: o.model === undefined ? 'qwen3.6:35b-a3b' : o.model, env: o.env ?? {}, scopes: o.scopes ?? [], test })

describe("a local model's limits at launch (HI-2682)", () => {
  it("the descriptor names the advanced settings advanced.ts defines, and its variables are Claude Code's", () => {
    expect(caps.localLimits).toMatchObject({ contextEnv: 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', outputEnv: 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', aliasSetting: LOCAL_MODEL_ALIASES_ID, spellingSetting: LOCAL_MODEL_SPELLINGS_ID })
    expect(caps.localLimits!.fixedEnv).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: 'auto', MAX_THINKING_TOKENS: '0' })
  })

  it('judges an ID alone: aliases and special choices, then claude, [1m] or a date suffix; a custom spelling is fine', () => {
    for (const id of ['opus', 'Sonnet', 'haiku', 'fable', 'opusplan', 'default', 'best', 'opus[1m]']) expect(test(id), id).toBe('alias')
    for (const id of ['claude-sonnet-4-5', 'anthropic/claude-opus-4-8', 'my-gateway-opus[1m]', 'qwen@20250929', 'CLAUDE-x']) expect(test(id), id).toBe('spelling')
    for (const id of ['qwen3.6:35b-a3b', 'qwen3-coder-next', 'devstral-small-2:24b', 'opus-local', 'Qwen3.5-9B']) expect(test(id), id).toBeNull()
  })

  it("passes the connection's context, output, effort auto and no thinking for a custom spelling, recorded as Combwork's", () => {
    const r = run([{ id: 'qwen3.6:35b-a3b', context: 32768, output: 6000 }])
    expect(r.env).toEqual({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: '32768', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '6000', CLAUDE_CODE_EFFORT_LEVEL: 'auto', MAX_THINKING_TOKENS: '0' })
    expect(r.record).toEqual({ model: 'qwen3.6:35b-a3b', connection: 'Local', applied: true, eligible: ['qwen3.6:35b-a3b'], context: { value: 32768, from: null }, output: { value: 6000, from: null } })
  })

  it('with no context set: none passed (Claude Code assumes 200K), and the default output budget', () => {
    const r = run([{ id: 'qwen3.6:35b-a3b' }])
    expect(r.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined()
    expect(r.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('8192')
    expect(r.record).toMatchObject({ applied: true, output: { value: 8192, from: null } })
    expect(r.record?.context).toBeUndefined()
  })

  it('the model is --model, else the effective model variable (a settings env naming another model included)', () => {
    const models = [{ id: 'qwen3.6:35b-a3b', context: 32768 }, { id: 'qwen3.8:27b', context: 65536 }]
    expect(run(models, { model: null, env: { ANTHROPIC_MODEL: 'qwen3.8:27b' } }).record).toMatchObject({ model: 'qwen3.8:27b', context: { value: 65536 } })
    expect(run(models, { model: null, env: { ANTHROPIC_MODEL: 'qwen3.6:35b-a3b' }, scopes: [scope('the project’s .claude/settings.json', { env: { ANTHROPIC_MODEL: 'qwen3.8:27b' } })] }).record).toMatchObject({ model: 'qwen3.8:27b' })
    expect(run(models, { model: null, env: {} })).toEqual({ env: {}, record: null })
  })

  it('passes none, saying why: an alias, a claude/[1m]/date spelling, a model not on the connection, a mapping, an unreadable scope', () => {
    expect(run([{ id: 'opus', context: 32768 }], { model: 'opus' })).toEqual({ env: {}, record: { model: 'opus', connection: 'Local', applied: false, why: 'alias' } })
    expect(run([{ id: 'claude-opus-4-8', context: 32768 }], { model: 'claude-opus-4-8' }).record).toMatchObject({ applied: false, why: 'spelling' })
    expect(run([{ id: 'other' }]).record).toMatchObject({ applied: false, why: 'notListed' })
    const models = [{ id: 'qwen3.6:35b-a3b', context: 32768 }]
    const overrides = run(models, { scopes: [scope('your .claude/settings.json', { modelOverrides: { 'claude-opus-4-8': 'qwen3.6:35b-a3b' } })] })
    expect(overrides).toEqual({ env: {}, record: { model: 'qwen3.6:35b-a3b', connection: 'Local', applied: false, why: 'mapped', whyFile: 'your .claude/settings.json' } })
    expect(run(models, { scopes: [scope('--settings', { modelPicker: { options: [{ model: 'qwen3.6:35b-a3b', behavesAs: 'claude-opus-4-8' }] } })] }).record).toMatchObject({ why: 'mapped', whyFile: '--settings' })
    // A picker row with no behavesAs maps nothing.
    expect(run(models, { scopes: [scope('--settings', { modelPicker: { options: [{ model: 'qwen3.6:35b-a3b', label: 'Qwen' }] } })] }).record).toMatchObject({ applied: true })
    expect(run(models, { scopes: [scope('managed settings', null, { unsure: "couldn't be read (EACCES)" })] }).record).toMatchObject({ applied: false, why: 'unreadable', whyFile: 'managed settings' })
    expect(run(models, { scopes: [scope('the project’s .claude/settings.json', null, { notJson: true })] }).record).toMatchObject({ why: 'unreadable' })
  })

  it("records what Claude Code ends up with: a settings env's context or output wins, with its file", () => {
    const models = [{ id: 'qwen3.6:35b-a3b', context: 65536, output: 8000 }]
    const ctxOnly = run(models, { scopes: [scope('your .claude/settings.json', { env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '40000' } })] })
    expect(ctxOnly.record).toMatchObject({ applied: true, context: { value: 40000, from: 'your .claude/settings.json' }, output: { value: 8000, from: null } })
    const outOnly = run(models, { scopes: [scope('your .claude/settings.json', { env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '12000' } })] })
    expect(outOnly.record).toMatchObject({ context: { value: 65536, from: null }, output: { value: 12000, from: 'your .claude/settings.json' } })
    const both = run(models, { scopes: [scope('your .claude/settings.json', { env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '50000', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '9000' } })] })
    expect(both.record).toMatchObject({ context: { value: 50000, from: 'your .claude/settings.json' }, output: { value: 9000, from: 'your .claude/settings.json' } })
  })

  it("refuses a launch whose settings-file output isn't below the context, naming both and where each was set", () => {
    const models = [{ id: 'qwen3.6:35b-a3b', context: 16384 }]
    expect(() => run(models, { scopes: [scope('your .claude/settings.json', { env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '16384' } })] })).toThrow(/B1 wasn’t started: its output budget \(16,384 tokens, env in your \.claude\/settings\.json\) isn’t below its context size \(16,384 tokens, Context size on Local\)/)
    // Both from settings files: refused too.
    expect(() => run(models, { scopes: [scope('your .claude/settings.json', { env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '9000', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '8000' } })] })).toThrow(/9,000 tokens, env in .*8,000 tokens, env in/)
  })

  it("Combwork's own output under a context a settings file lowered: the default for that context, recorded as the fallback", () => {
    const models = [{ id: 'qwen3.6:35b-a3b', context: 65536, output: 16000 }]
    const r = run(models, { scopes: [scope('the project’s .claude/settings.json', { env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '12000' } })] })
    expect(r.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('3000')
    expect(r.record).toMatchObject({ context: { value: 12000, from: 'the project’s .claude/settings.json' }, output: { value: 3000, from: null, fallback: 16000 } })
    // No scope sets the output afterwards: what is recorded is what Claude Code gets.
    expect(r.record?.output?.from).toBeNull()
  })

  it('never sends a zero output: a context too small for any is refused, from the connection or a settings file', () => {
    expect(() => run([{ id: 'qwen3.6:35b-a3b', context: 3 }])).toThrow(/B1 wasn’t started: its context size \(3 tokens, Context size on Local\) is too small for any output budget/)
    expect(() => run([{ id: 'qwen3.6:35b-a3b', context: 65536, output: 2000 }], { scopes: [scope('your .claude/settings.json', { env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '2' } })] })).toThrow(/2 tokens, env in your \.claude\/settings\.json\) is too small/)
  })

  it("the model is the command line's last --model, either form, the user's extra arguments winning (HR1, round 1)", () => {
    expect(lastModelArg(['--verbose', '--model', 'a', '--model=b'])).toBe('b')
    expect(lastModelArg(['--model=b', '--model', 'c'])).toBe('c')
    expect(lastModelArg(['--verbose'])).toBeNull()
    expect(lastModelArg(['--model'])).toBeNull()
  })

  it('through the real adapter: an extra --model runs another model, and its limits are that model’s, as buildCommand runs it', async () => {
    const { claudeCode, launchModel } = await import('../src/main/providers/claude/adapter')
    const base = tempDir('cw-locallimits-')
    const home = join(base, 'home')
    mkdirSync(home, { recursive: true })
    const models = [{ id: 'local-a', context: 131072 }, { id: 'local-b', context: 32768 }]
    for (const extraArgs of [['--model=local-b'], ['--model', 'local-a', '--model', 'local-b']]) {
      const ctx = {
        projectPath: join(base, 'project'), agentId: 'a1', executable: 'C:\\bin\\claude.exe', cwd: base, workspacePath: base, runId: 'r', sessionId: '00000000-0000-4000-8000-000000000000', resume: false, name: 'B1', skills: [], mcpServers: {},
        model: 'local-a', effort: null, permissionMode: null, extraArgs, hookUrl: 'http://127.0.0.1:9/hook?run=r', hookAuthFile: join(base, 'auth.txt'), privateDir: join(base, `private-${extraArgs.length}`), guidance: '', allowBackgroundSessions: true, use200kContext: false,
        env: { CLAUDE_CONFIG_DIR: home, ANTHROPIC_MODEL: 'local-a' } as Record<string, string>,
        server: { models, connection: 'Local' }
      } as Record<string, unknown>
      await claudeCode.prepareLaunch(ctx as never)
      const cmd = claudeCode.buildCommand(ctx.executable as string, ctx as never)
      const ran = lastModelArg(cmd.args)
      expect(ran).toBe('local-b')
      expect(launchModel(ctx as never)).toBe(ran)
      expect(cmd.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('32768')
      expect(cmd.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('8192')
      expect(ctx.localLimits).toMatchObject({ model: 'local-b', applied: true, context: { value: 32768 } })
    }
  })

  it('reads a mapping only of the ID, case aside', () => {
    expect(mapsModel({ modelOverrides: { 'claude-opus-4-8': 'Qwen3.6:35B-A3B' } }, 'qwen3.6:35b-a3b')).toBe(true)
    expect(mapsModel({ modelOverrides: { 'claude-opus-4-8': 'other' } }, 'qwen3.6:35b-a3b')).toBe(false)
    expect(mapsModel({ modelPicker: [{ model: 'qwen3.6:35b-a3b', behavesAs: 'claude-opus-4-8' }] }, 'qwen3.6:35b-a3b')).toBe(true)
    expect(mapsModel(null, 'x')).toBe(false)
  })
})

describe("a model's limits in the window (HI-2682)", () => {
  it('the default output: 8,192, at most a quarter of the context, none for a context under 4', () => {
    expect(defaultOutput(undefined)).toBe(8192)
    expect(defaultOutput(65536)).toBe(8192)
    expect(defaultOutput(16384)).toBe(4096)
    expect(defaultOutput(4)).toBe(1)
    expect(defaultOutput(3)).toBeNull()
  })

  it('an output must be below its context; little room is advice', () => {
    expect(outputFits({ context: 16384, output: 16384 })).toBe(false)
    expect(outputFits({ context: 16384, output: 4096 })).toBe(true)
    expect(outputFits({ output: 4096 })).toBe(true)
    expect(tightFit({ context: 32768 })).toBe(true)
    expect(tightFit({ context: 65536 })).toBe(false)
    expect(tightFit({ context: 65536, output: 40000 })).toBe(true)
    expect(tightFit({})).toBe(false)
  })

  it("keeps a model's output as a whole number of tokens, as its context, and drops what isn't one", () => {
    expect(cleanModels([{ id: 'a', context: 32768, output: 4096 }, { id: 'b', output: 0 }, { id: 'c', output: 1.5 }, { id: 'd', unsupported: 'alias' }])).toEqual([{ id: 'a', context: 32768, output: 4096 }, { id: 'b' }, { id: 'c' }, { id: 'd' }])
  })

  it("a model listing keeps a model's context and output budget, as the user's", () => {
    expect(mergeListed([{ id: 'qwen3:8b', context: 32768, output: 6000 }, { id: 'gone', output: 100 }], ['qwen3:8b', 'new'])).toEqual({ models: [{ id: 'qwen3:8b', context: 32768, output: 6000 }, { id: 'new' }], dropped: ['gone'] })
  })

  it("the meter's window is the launch's context until Claude Code reports, while it runs the model it started on", () => {
    const limits = { model: 'qwen3.6:35b-a3b', connection: 'Local', applied: true, context: { value: 32768, from: null }, output: { value: 8192, from: null } }
    expect(launchedWindow(limits, null, null)).toBe(32768)
    expect(launchedWindow(limits, null, 'Qwen3.6:35b-a3b')).toBe(32768)
    expect(launchedWindow(limits, 32768, 'qwen3.6:35b-a3b')).toBeNull()
    expect(launchedWindow(limits, null, 'qwen3.8:27b')).toBeNull()
    expect(launchedWindow({ ...limits, applied: false }, null, null)).toBeNull()
    expect(launchedWindow(undefined, null, null)).toBeNull()
  })

  it('a switch to another of its connection’s eligible models keeps the declared context, an estimate; any other model is unknown (HR1, round 1)', () => {
    const r = run([{ id: 'qwen3.6:35b-a3b', context: 32768 }, { id: 'qwen3.8:27b' }, { id: 'opus' }], { scopes: [scope('--settings', { modelOverrides: { 'claude-opus-4-8': 'mapped-one' } })] })
    expect(r.record?.eligible).toEqual(['qwen3.6:35b-a3b', 'qwen3.8:27b'])
    const limits = r.record!
    expect(declaredFor(limits, 'qwen3.8:27b')).toBe(true)
    expect(launchedWindow(limits, null, 'qwen3.8:27b')).toBe(32768)
    expect(localLimitsLines(limits, null, 'qwen3.8:27b', tr)[0]).toMatch(/an estimate until Claude Code reports its window/)
    expect(declaredFor(limits, 'opus')).toBe(false)
    expect(launchedWindow(limits, null, 'opus')).toBeNull()
    expect(localLimitsLines(limits, null, 'opus', tr)[0]).toBe('Context size 32,768 tokens (set on Local)')
    expect(launchedWindow(limits, null, 'somebody-else')).toBeNull()
  })

  it("where a local model compacts: its declared context less its output budget (at most 20K) and a 13K buffer, an estimate, as Claude Code 2.1.319 did in the probe; capped and percentage said; off kept; Claude unchanged", () => {
    // The probe: 32,768 declared, 4,096 output: compacted at 19,447, not at 12,401 (HI-2682).
    const line = autoCompactLine('claude-code', 32768, { window: null, source: null }, tr, { declared: { output: 4096 } })
    expect(line).toBe('Claude Code compacts by itself at about 15,672: an estimate, the local model’s declared context 32,768 less its output budget 4,096 and a 13,000-token buffer')
    expect(15672).toBeGreaterThan(12401)
    expect(15672).toBeLessThan(19447)
    // An output budget over Claude Code's usual reserve: only 20,000 of it kept free.
    expect(autoCompactLine('claude-code', 200000, { window: null, source: null }, tr, { declared: { output: 64000 } })).toMatch(/at about 167,000: an estimate, the local model’s declared context 200,000 less its output budget 20,000/)
    expect(autoCompactLine('claude-code', 32768, { window: 200000, source: 'autoCompactWindow in your settings' }, tr, { declared: { output: 4096 } })).toMatch(/at about 15,672.*\(autoCompactWindow in your settings\) \(an estimate: an auto-compact window set too is taken as capped by the declared context\)$/)
    expect(autoCompactLine('claude-code', 32768, { window: null, percent: 40, source: 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE' }, tr, { declared: { output: 4096 } })).toMatch(/at about 13,107: an estimate.*\(CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, at 40% of it\)/)
    expect(autoCompactLine('claude-code', 32768, { window: 'off', source: 'DISABLE_AUTO_COMPACT' }, tr, { declared: { output: 4096 } })).toMatch(/doesn't compact by itself: auto-compaction is off \(DISABLE_AUTO_COMPACT\)/)
    // A context smaller than the room kept: no figure.
    expect(autoCompactLine('claude-code', 16000, { window: null, source: null }, tr, { declared: { output: 4000 } })).toBeNull()
    // A Claude model's (not declared): its reserve, as before, nothing at 32K.
    expect(autoCompactLine('claude-code', 32768, { window: null, source: null }, tr)).toBeNull()
    expect(autoCompactLine('claude-code', 200000, { window: null, source: null }, tr)).toMatch(/at about 167,000, its default for this window/)
    // Through contextLines, as the footer calls it.
    expect(contextLines({ provider: 'claude-code', contextTokens: 1000, contextWindow: 32768 }, { window: null, source: null }, tr, { declared: { output: 8192 } }).at(-1)).toMatch(/^Claude Code compacts by itself at about 11,576: an estimate/)
  })

  it("the meter's lines say each value's source, an estimate until reported, a switch, a fallback, or why none was used", () => {
    const limits = { model: 'qwen3.6:35b-a3b', connection: 'Local', applied: true, context: { value: 32768, from: null }, output: { value: 3000, from: 'your .claude/settings.json', fallback: 16000 } }
    expect(localLimitsLines(limits, null, null, tr)).toEqual(['Context size 32,768 tokens (set on Local): an estimate until Claude Code reports its window', 'Output budget 3,000 tokens (env in your .claude/settings.json): 16,000 wasn’t below the context, so the default was used'])
    expect(localLimitsLines(limits, 32768, 'qwen3.6:35b-a3b', tr)[0]).toBe('Context size 32,768 tokens (set on Local)')
    expect(localLimitsLines(limits, null, 'qwen3.8:27b', tr).at(-1)).toMatch(/^Started on qwen3\.6:35b-a3b with these/)
    expect(localLimitsLines({ model: 'qwen3.6:35b-a3b', connection: 'Local', applied: false, why: 'mapped', whyFile: 'your .claude/settings.json' }, null, null, tr)).toEqual(['Context size not used: your .claude/settings.json maps qwen3.6:35b-a3b to a Claude model'])
    expect(localLimitsLines(undefined, null, null, tr)).toEqual([])
  })
})
