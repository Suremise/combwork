// A stray .codex folder in a project (#509): anything in it but Codex's project config is warned of.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { strayCodexEntries, strayCodexWarning } from '../src/main/providers/codex/strayFolder'
import { tempDir } from './tempDir'

describe('a stray .codex folder (#509)', () => {
  it('is nothing without a .codex folder, or with only Codex’s config in it', () => {
    const p = tempDir('cw-stray-codex-')
    expect(strayCodexEntries(p)).toBeNull()
    mkdirSync(join(p, '.codex'))
    expect(strayCodexEntries(p)).toBeNull()
    writeFileSync(join(p, '.codex', 'config.toml'), '')
    expect(strayCodexWarning(p)).toBeNull()
  })

  it('is nothing for Codex’s own configuration: custom agents, rules, and files its TOML names', () => {
    const p = tempDir('cw-stray-codex-')
    mkdirSync(join(p, '.codex', 'agents'), { recursive: true })
    mkdirSync(join(p, '.codex', 'rules'))
    // OpenAI's subagents docs: .codex/config.toml with .codex/agents/reviewer.toml.
    writeFileSync(join(p, '.codex', 'config.toml'), 'model_instructions_file = "instructions.md"\n[agents]\nmax_concurrent_threads_per_session = 2\n')
    writeFileSync(join(p, '.codex', 'agents', 'reviewer.toml'), 'name = "reviewer"\ndescription = "Reviews"\ndeveloper_instructions = "Review the change."\n[[skills.config]]\npath = "reviewer-skill.md"\n')
    writeFileSync(join(p, '.codex', 'agents', 'reviewer-skill.md'), '')
    writeFileSync(join(p, '.codex', 'instructions.md'), '')
    writeFileSync(join(p, '.codex', 'rules', 'default.rules'), '')
    expect(strayCodexEntries(p)).toBeNull()
    expect(strayCodexWarning(p)).toBeNull()
    // Scratch beside that configuration is still warned of, in agents/ too.
    mkdirSync(join(p, '.codex', 'scratch'))
    writeFileSync(join(p, '.codex', 'agents', 'probe.log'), '')
    expect(strayCodexEntries(p)).toEqual(['scratch', 'agents/probe.log'])
  })

  it('is nothing for files named in nested folders, at any depth', () => {
    const p = tempDir('cw-stray-codex-')
    mkdirSync(join(p, '.codex', 'instructions'), { recursive: true })
    mkdirSync(join(p, '.codex', 'team', 'shared', 'deep'), { recursive: true })
    mkdirSync(join(p, '.codex', 'agents', 'notes'), { recursive: true })
    writeFileSync(join(p, '.codex', 'config.toml'), 'model_instructions_file = "instructions/reviewer.md"\n[profiles.deep]\nexperimental_compact_prompt_file = "team/shared/deep/compact.md"\n')
    writeFileSync(join(p, '.codex', 'agents', 'reviewer.toml'), 'name = "reviewer"\n[[skills.config]]\npath = "notes/review.md"\n')
    writeFileSync(join(p, '.codex', 'instructions', 'reviewer.md'), '')
    writeFileSync(join(p, '.codex', 'team', 'shared', 'deep', 'compact.md'), '')
    writeFileSync(join(p, '.codex', 'agents', 'notes', 'review.md'), '')
    expect(strayCodexEntries(p)).toBeNull()
  })

  it('takes only path fields as references: a profile, model or description named like a stray folder hides nothing', () => {
    const p = tempDir('cw-stray-codex-')
    mkdirSync(join(p, '.codex', 'scratch'), { recursive: true })
    mkdirSync(join(p, '.codex', 'agents'))
    writeFileSync(join(p, '.codex', 'scratch', 'probe.cjs'), '')
    writeFileSync(join(p, '.codex', 'probe.log'), '')
    writeFileSync(join(p, '.codex', 'config.toml'), 'profile = "scratch"\nmodel = "probe.log"\n[profiles.scratch]\nmodel = "gpt-5.4"\n')
    writeFileSync(join(p, '.codex', 'agents', 'scratch.toml'), 'name = "scratch"\ndescription = "probe.log"\ndeveloper_instructions = "scratch"\n')
    expect(strayCodexEntries(p)).toEqual(['probe.log', 'scratch'])
  })

  it('is warned of when it holds anything else, naming the folder and what it holds', () => {
    const p = tempDir('cw-stray-codex-')
    mkdirSync(join(p, '.codex', 'scratch', 'r2-484'), { recursive: true })
    writeFileSync(join(p, '.codex', 'config.toml'), '')
    expect(strayCodexEntries(p)).toEqual(['scratch'])
    const w = strayCodexWarning(p)!
    expect(w.message).toContain(join(p, '.codex'))
    expect(w.message).toContain('holds scratch,')
    for (const f of ['a.log', 'b.log', 'c.log', 'd.log']) writeFileSync(join(p, '.codex', f), '')
    expect(strayCodexWarning(p)!.message).toMatch(/holds .+ and 2 more,/)
  })

  it('is nothing when .codex is a file', () => {
    const p = tempDir('cw-stray-codex-')
    writeFileSync(join(p, '.codex'), '')
    expect(strayCodexEntries(p)).toBeNull()
  })
})
