// The status bar's plan usage items (HI-2119; HI-2107, decision A): accounts in the one order of accounts across every
// CLI, each once and by its name now, then the CLI-wide items of CLIs whose accounts don't apply here.
import { describe, expect, it } from 'vitest'
import { planUsageItems } from '../src/shared/accounts'
import type { ProviderId } from '../src/shared/types'

const clis: ProviderId[] = ['claude-code', 'codex', 'copilot']
const both = new Set<ProviderId>(['claude-code', 'codex'])
const use = (id: string, provider: ProviderId, name = id) => ({ id, name, provider })
const names = (items: ReturnType<typeof planUsageItems>): string[] => items.map((i) => (i.kind === 'account' ? i.name : `cli:${i.provider}`))

describe('the status bar’s plan usage items (HI-2119)', () => {
  it('interleaved CLIs follow the one order of accounts, not the CLIs’ order', () => {
    // Codex's Work before Claude Code's Personal, and Claude Code's Max after it.
    const items = planUsageItems(clis, both, [use('a-p', 'claude-code', 'Personal'), use('a-m', 'claude-code', 'Max'), use('a-w', 'codex', 'Work')], ['a-w', 'a-p', 'cli-x', 'a-m'], () => undefined)
    expect(names(items)).toEqual(['Work', 'Personal', 'Max', 'cli:copilot'])
  })

  it('one item per account, by its name now (renamed since its session launched)', () => {
    const items = planUsageItems(clis, both, [use('a-p', 'claude-code', 'Old name'), use('a-p', 'claude-code', 'Old name'), use('a-w', 'codex', 'Work')], ['a-p', 'a-w'], (id) => (id === 'a-p' ? 'Renamed' : undefined))
    expect(names(items)).toEqual(['Renamed', 'Work', 'cli:copilot'])
  })

  it('a CLI whose accounts don’t apply here, or that is off, has its CLI-wide item, or none; an account not in the order goes last', () => {
    const items = planUsageItems(['claude-code', 'copilot'], new Set<ProviderId>(['claude-code']), [use('a-new', 'claude-code', 'New'), use('a-p', 'claude-code', 'Personal'), use('a-w', 'codex', 'Work')], ['a-p'], () => undefined)
    expect(names(items)).toEqual(['Personal', 'New', 'cli:copilot'])
  })
})
