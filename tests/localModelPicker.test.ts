// HI-2684 (SPEC §11): a server connection's models in Claude Code's /model picker. The lineup (pickerFor): exact IDs in
// the connection's order, the user's labels, the connection as each row's second line, aliases left out, the built-in
// rows replaced only where the connection serves no Claude model; a lineup of the user's own in a scope Claude Code
// reads it from (managed, --settings, the user's settings) wins, as does one Combwork can't read. Never behavesAs, never
// modelOverrides. Through the real adapter: the written settings file, merged with the user's --settings. The Label
// field kept and cleaned; dialects resolve the exact ID the picker runs.
import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tempDir } from './tempDir'
import { pickerFor } from '../src/main/providers/claude/modelPicker'
import type { SettingsScope } from '../src/main/providers/claude/autoCompact'
import { staticSupport } from '../src/shared/localModelLimits'
import { ADVANCED_DEFS, LOCAL_MODEL_ALIASES_ID, LOCAL_MODEL_SPELLINGS_ID } from '../src/shared/advanced'
import { cleanModels, labelOf, MODEL_LABEL_MAX, mergeListed } from '../src/shared/serverConnection'
import { dialectModelId } from '../src/shared/models'
import { autoModelFile, modelSlot } from '../src/main/dialects/match'
import type { LoadedDialect } from '../src/main/dialects/chain'
import type { ServerModel } from '../src/shared/types'

const pattern = (id: string): RegExp => {
  const d = ADVANCED_DEFS.find((x) => x.id === id)!
  return new RegExp(d.default as string, d.flags ?? '')
}
const test = (id: string) => staticSupport(id, pattern(LOCAL_MODEL_ALIASES_ID), pattern(LOCAL_MODEL_SPELLINGS_ID))
const owns = (id: string): boolean => /^claude-/i.test(id)
const scope = (label: string, json: unknown, more: Partial<SettingsScope> = {}): SettingsScope => ({ label, json, ...more })
const run = (models: ServerModel[], scopes: SettingsScope[] = []) => pickerFor({ models, connection: 'Local', scopes, test, owns })
const QWEN: ServerModel[] = [{ id: 'qwen3-coder-next:q4_K_M', label: 'Qwen3 Coder Next' }, { id: 'qwen3.6:35b-a3b' }, { id: 'Qwen3.5-9B', label: 'Qwen 3.5 9B (PS5)' }]

describe("a server connection's /model lineup (HI-2684)", () => {
  it('rows in the connection’s order, exact IDs verbatim (case and tags kept), the label where set, the connection as description', () => {
    const r = run(QWEN)
    expect(r.picker).toEqual({
      options: [
        { model: 'qwen3-coder-next:q4_K_M', label: 'Qwen3 Coder Next', description: 'Local' },
        { model: 'qwen3.6:35b-a3b', description: 'Local' },
        { model: 'Qwen3.5-9B', label: 'Qwen 3.5 9B (PS5)', description: 'Local' }
      ],
      replaceBuiltInOptions: true
    })
    expect(r.record).toEqual({ connection: 'Local', rows: ['qwen3-coder-next:q4_K_M', 'qwen3.6:35b-a3b', 'Qwen3.5-9B'], replace: true })
  })

  it('never behavesAs nor modelOverrides, whatever the models', () => {
    for (const models of [QWEN, [{ id: 'claude-opus-4-8' }, { id: 'qwen3.8:27b', as: ['opus' as const] }]]) {
      const text = JSON.stringify(run(models).picker)
      expect(text).not.toContain('behavesAs')
      expect(text).not.toContain('modelOverrides')
    }
  })

  it('replaces the built-in lineup only where the connection serves no Claude model', () => {
    expect(run([{ id: 'qwen3.8:27b', as: ['opus', 'sonnet'] }]).picker?.replaceBuiltInOptions).toBe(true)
    const gateway = run([{ id: 'claude-sonnet-4-6' }, { id: 'qwen3.8:27b' }])
    expect(gateway.picker).toEqual({ options: [{ model: 'claude-sonnet-4-6', description: 'Local' }, { model: 'qwen3.8:27b', description: 'Local' }] })
    expect(gateway.record.replace).toBe(false)
  })

  it('leaves out an ID Claude Code reads as its alias, saying so; none at all is no lineup, recorded as such', () => {
    const r = run([{ id: 'opus' }, { id: 'qwen3.8:27b' }])
    expect(r.picker?.options.map((o) => o.model)).toEqual(['qwen3.8:27b'])
    expect(r.record.omitted).toEqual([{ id: 'opus', why: 'alias' }])
    expect(run([{ id: 'opus' }, { id: 'sonnet' }])).toEqual({ picker: null, record: { connection: 'Local', why: 'noRows', omitted: [{ id: 'opus', why: 'alias' }, { id: 'sonnet', why: 'alias' }] } })
    expect(run([])).toEqual({ picker: null, record: { connection: 'Local', why: 'noRows' } })
  })

  it('a lineup of the user’s own in managed settings, --settings or their settings.json wins: none passed, which said', () => {
    const own = { modelPicker: { options: [{ model: 'mine' }] } }
    for (const kind of ['managed', 'cli', 'user'] as const) {
      const r = run(QWEN, [scope(`the ${kind} file`, own, { kind })])
      expect(r.picker, kind).toBeNull()
      expect(r.record).toEqual({ connection: 'Local', why: kind, whyFile: `the ${kind} file` })
    }
  })

  it('project and local settings don’t count (Claude Code ignores modelPicker there)', () => {
    const own = { modelPicker: { options: [{ model: 'mine' }] } }
    expect(run(QWEN, [scope('project', own, { kind: 'project' }), scope('local', own, { kind: 'local' })]).picker?.options).toHaveLength(3)
  })

  it('a scope it reads from that Combwork can’t read (or a mode that may skip some) stops it; an unreadable project file doesn’t', () => {
    expect(run(QWEN, [scope('Claude Code’s settings.json', null, { kind: 'user', notJson: true })]).record).toEqual({ connection: 'Local', why: 'unreadable', whyFile: 'Claude Code’s settings.json' })
    expect(run(QWEN, [scope('managed settings', null, { kind: 'managed', unsure: 'EACCES' })]).record.why).toBe('unreadable')
    expect(run(QWEN, [scope('--bare', null, { unsure: 'may stop Claude Code reading some settings files' })]).record.why).toBe('unreadable')
    expect(run(QWEN, [scope('project', null, { kind: 'project', notJson: true })]).picker).not.toBeNull()
  })

  it('an availableModels allowlist is named in the record: the rows are asked for, not promised', () => {
    const r = run(QWEN, [scope('managed settings', { availableModels: ['qwen3.6:35b-a3b'] }, { kind: 'managed' })])
    expect(r.picker?.options).toHaveLength(3)
    expect(r.record).toMatchObject({ rows: ['qwen3-coder-next:q4_K_M', 'qwen3.6:35b-a3b', 'Qwen3.5-9B'], allowlist: 'managed settings' })
  })
})

describe('through the real adapter (HI-2684)', () => {
  const launch = async (o: { extraArgs?: string[]; models: ServerModel[]; home?: Record<string, unknown> }) => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const base = tempDir('cw-localpicker-')
    const home = join(base, 'home')
    mkdirSync(home, { recursive: true })
    if (o.home) writeFileSync(join(home, 'settings.json'), JSON.stringify(o.home))
    const ctx = {
      projectPath: join(base, 'project'), agentId: 'a1', executable: 'C:\\bin\\claude.exe', cwd: base, workspacePath: base, runId: 'r', sessionId: '00000000-0000-4000-8000-000000000000', resume: false, name: 'B1', skills: [], mcpServers: {},
      model: o.models[0]?.id ?? null, effort: null, permissionMode: null, extraArgs: o.extraArgs ?? [], hookUrl: 'http://127.0.0.1:9/hook?run=r', hookAuthFile: join(base, 'auth.txt'), privateDir: join(base, 'private'), guidance: '', allowBackgroundSessions: true, use200kContext: false,
      env: { CLAUDE_CONFIG_DIR: home } as Record<string, string>,
      server: { models: o.models, connection: 'Local' }
    } as Record<string, unknown>
    await claudeCode.prepareLaunch(ctx as never)
    const settings = JSON.parse(readFileSync(join(base, 'private', 'settings.json'), 'utf8')) as Record<string, unknown>
    return { ctx, settings, base }
  }

  it('writes the lineup into Combwork’s own --settings file beside its hooks, and records it on the launch', async () => {
    const { ctx, settings } = await launch({ models: QWEN })
    expect(settings.modelPicker).toEqual({ options: [{ model: 'qwen3-coder-next:q4_K_M', label: 'Qwen3 Coder Next', description: 'Local' }, { model: 'qwen3.6:35b-a3b', description: 'Local' }, { model: 'Qwen3.5-9B', label: 'Qwen 3.5 9B (PS5)', description: 'Local' }], replaceBuiltInOptions: true })
    expect(settings.hooks).toBeTruthy()
    expect(settings.modelOverrides).toBeUndefined()
    expect(ctx.picker).toMatchObject({ rows: ['qwen3-coder-next:q4_K_M', 'qwen3.6:35b-a3b', 'Qwen3.5-9B'], replace: true })
  })

  it('a --settings of the user’s with its own lineup is kept as it is; one without gets Combwork’s merged in', async () => {
    const dir = tempDir('cw-localpicker-theirs-')
    const theirs = join(dir, 'mine.json')
    writeFileSync(theirs, JSON.stringify({ modelPicker: { options: [{ model: 'qwen3.8:27b', label: 'Mine' }] } }))
    const kept = await launch({ models: QWEN, extraArgs: ['--settings', theirs] })
    expect(kept.settings.modelPicker).toEqual({ options: [{ model: 'qwen3.8:27b', label: 'Mine' }] })
    expect(kept.ctx.picker).toMatchObject({ why: 'cli' })
    const plain = join(dir, 'plain.json')
    writeFileSync(plain, JSON.stringify({ env: { FOO: '1' } }))
    const merged = await launch({ models: QWEN, extraArgs: ['--settings', plain] })
    expect(merged.settings.env).toEqual({ FOO: '1' })
    expect((merged.settings.modelPicker as { options: unknown[] }).options).toHaveLength(3)
  })

  it('a lineup in the connection home’s settings.json is theirs: Combwork’s --settings would hide it, so none', async () => {
    const { ctx, settings } = await launch({ models: QWEN, home: { modelPicker: { options: [{ model: 'x' }] } } })
    expect(settings.modelPicker).toBeUndefined()
    expect(ctx.picker).toMatchObject({ why: 'user' })
  })

  it('off a server connection: no lineup and no record', async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const base = tempDir('cw-localpicker-off-')
    const ctx = {
      projectPath: join(base, 'project'), agentId: 'a1', executable: 'C:\\bin\\claude.exe', cwd: base, workspacePath: base, runId: 'r', sessionId: '00000000-0000-4000-8000-000000000000', resume: false, name: 'B1', skills: [], mcpServers: {},
      model: null, effort: null, permissionMode: null, extraArgs: [], hookUrl: 'http://127.0.0.1:9/hook?run=r', hookAuthFile: join(base, 'auth.txt'), privateDir: join(base, 'private'), guidance: '', allowBackgroundSessions: true, use200kContext: false,
      env: { CLAUDE_CONFIG_DIR: join(base, 'home') } as Record<string, string>
    } as Record<string, unknown>
    await claudeCode.prepareLaunch(ctx as never)
    expect(JSON.parse(readFileSync(join(base, 'private', 'settings.json'), 'utf8')).modelPicker).toBeUndefined()
    expect(ctx.picker).toBeUndefined()
  })
})

describe('a model’s Label (HI-2684)', () => {
  it('kept trimmed, without control characters, at most MODEL_LABEL_MAX; nothing left is none', () => {
    expect(labelOf('  Qwen Coder \u0007 (local) ')).toBe('Qwen Coder  (local)')
    expect(labelOf('x'.repeat(MODEL_LABEL_MAX + 5))).toHaveLength(MODEL_LABEL_MAX)
    expect(labelOf('   ')).toBeUndefined()
    expect(labelOf(3)).toBeUndefined()
    expect(cleanModels([{ id: 'qwen3.8:27b', label: ' Big ' }, { id: 'b', label: '' }])).toEqual([{ id: 'qwen3.8:27b', label: 'Big' }, { id: 'b' }])
  })

  it('a model listing keeps it, as the user’s', () => {
    expect(mergeListed([{ id: 'qwen3.8:27b', label: 'Big', context: 65536 }], ['qwen3.8:27b', 'new']).models).toEqual([{ id: 'qwen3.8:27b', context: 65536, label: 'Big' }, { id: 'new' }])
  })
})

describe('dialects resolve the exact ID the picker runs (HI-2684, HI-2523)', () => {
  const file = (path: string, model: string): LoadedDialect => ({ path, model, on: true, broken: false } as unknown as LoadedDialect)
  it('the launch’s model ID is the server’s, verbatim: tags, dots, colons and case kept, never an alias', () => {
    for (const id of ['qwen3-coder-next:q4_K_M', 'qwen3.6:35b-a3b', 'qwen3.8:27b', 'Qwen3.5-9B']) expect(dialectModelId('claude-code', null, id)).toBe(id)
  })

  it('a model file for that exact ID fills the slot; one for another tag of it doesn’t', () => {
    const files = [file('claude-code/Qwen 35b.json', 'qwen3.6:35b'), file('claude-code/Qwen 35b a3b.json', 'qwen3.6:35b-a3b'), file('claude-code/Coder.json', 'qwen3-coder-next:q4_K_M')]
    expect(autoModelFile(files, 'qwen3.6:35b-a3b')?.path).toBe('claude-code/Qwen 35b a3b.json')
    expect(autoModelFile(files, 'qwen3-coder-next:q4_K_M')?.path).toBe('claude-code/Coder.json')
    expect(autoModelFile(files, 'qwen3.6:35b-a3b-q8')).toBeNull()
    expect(modelSlot({ files } as never, 'qwen3-coder-next:q4_K_M').chosen).toBe('claude-code/Coder.json')
  })
})
