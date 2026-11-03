import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { setLanguage, tr } from '../../src/shared/i18n'
import { PSEUDO_LANGUAGE } from '../../src/shared/i18n/languages'
import { PROVIDERS, modeCaveat, modeDescription, permissionLabel, shownText } from '../../src/shared/providers'
import { FILE_LOCK_MODES, SESSION_LAYOUTS, agentLimitText, keybindingProblem, mergeBlocked, sessionLabel, unmergedWork } from '../../src/shared/defaults'
import { agentNameProblem, nameTakenMessage } from '../../src/shared/agentNames'
import { batchOutcome, busyNote, removeWorktreeText } from '../../src/shared/startAll'
import { removedAgentNote, resumeBlock } from '../../src/shared/sessionResume'
import { testedComparison, testedNote, testedSummary } from '../../src/shared/testedClis'
import type { Msg } from '../../src/shared/i18n/msg'
import type { SessionStatus } from '../../src/shared/types'

// #800: the `agents` area (the agent dialogs, models, permission modes, providers). The window shows provider data and
// agents' notes in the user's language; agents, the Agent API, card comments and the CLIs keep the English: each
// descriptor's English is its English field's, and the functions both use read the same in English with or without tr.

const ROOT = resolve(__dirname, '../..')

afterEach(() => setLanguage('en', {}))

/** Text the pseudo-locale made: in brackets, with no plain English word left in it. */
const pseudo = (s: string): boolean => s.includes('[') && !/\b(?:the|and|of|in|for|is|to|its|it|agent|agents|name|merge|session|version|tested|installed)\b/.test(s)

/** Every English field of the providers' data beside its window message. */
function providerPairs(): [string, string, Msg | null | undefined][] {
  const out: [string, string, Msg | null | undefined][] = []
  for (const d of PROVIDERS) {
    for (const m of d.permissionModes) {
      out.push([`${d.id} mode ${m.value} label`, m.label, m.text?.label], [`${d.id} mode ${m.value} description`, m.description, m.text?.description])
      if (m.cliNote) out.push([`${d.id} mode ${m.value} cliNote`, m.cliNote, m.text?.cliNote])
    }
    for (const e of d.effortLevels) out.push([`${d.id} effort ${e.value}`, e.label, e.text])
    for (const g of d.modelGroups) {
      // A group named for a model family ("GPT-6", "Claude") is a name, with nothing to translate.
      if (g.text) out.push([`${d.id} group ${g.label}`, g.label, g.text])
      for (const o of g.models) if (o.text) out.push([`${d.id} model ${o.value}`, o.label, o.text])
    }
    out.push([`${d.id} installNote`, d.installNote, d.text?.installNote], [`${d.id} extensionNote`, d.extensionNote, d.text?.extensionNote], [`${d.id} signInHelp`, d.signInHelp, d.text?.signInHelp])
    if (d.safeguardHelp) out.push([`${d.id} safeguardHelp`, d.safeguardHelp, d.text?.safeguardHelp])
  }
  for (const f of FILE_LOCK_MODES) out.push([`file lock ${f.value}`, f.label, f.text.label], [`file lock ${f.value} description`, f.description, f.text.description])
  for (const l of SESSION_LAYOUTS) out.push([`layout ${l.value}`, l.label, l.text])
  return out
}

const STATUSES: SessionStatus[] = ['starting', 'working', 'waiting', 'background', 'watching', 'signin', 'ready', 'finished', 'stopped']

describe('the agents area', () => {
  it('locales/en/agents.json has a note for translators on every message', () => {
    const en = JSON.parse(readFileSync(join(ROOT, 'locales/en/agents.json'), 'utf8')) as Record<string, { defaultMessage: string; description: string }>
    expect(Object.keys(en).length).toBeGreaterThan(150)
    for (const [id, m] of Object.entries(en)) {
      expect(id.startsWith('agents.'), id).toBe(true)
      expect(m.description.length, id).toBeGreaterThan(10)
    }
  })

  it("every provider mode, effort, model group, note, file lock mode and layout has the window's words, whose English is its English field's", () => {
    for (const [what, english, text] of providerPairs()) {
      expect(text, what).toBeTruthy()
      expect(text!.defaultMessage, what).toBe(english)
      expect(shownText(english, text, tr), what).toBe(english)
    }
  })

  it('in English, the functions agents and the window share read the same with or without tr', () => {
    expect(agentLimitText(tr)).toBe(agentLimitText())
    for (const s of STATUSES) expect(mergeBlocked('B1', s, tr), s).toBe(mergeBlocked('B1', s))
    const branch = (ahead: number, dirty: number) => ({ ahead, dirty, base: 'main', branch: 'hive/b1' }) as never
    for (const [a, d] of [[0, 0], [1, 0], [3, 1], [0, 2]]) expect(unmergedWork(branch(a, d), tr), `${a}/${d}`).toEqual(unmergedWork(branch(a, d)))
    expect(sessionLabel({ id: '3f9a1c2b-0000', name: null } as never, 'hive', tr)).toBe(sessionLabel({ id: '3f9a1c2b-0000', name: null } as never, 'hive'))
    const owner = { name: 'B1', project: 'ambrosia' } as never
    expect(nameTakenMessage('b1', owner, 'B1 (hive)', tr)).toBe(nameTakenMessage('b1', owner, 'B1 (hive)'))
    for (const n of ['', '   ', 'x'.repeat(200), 'Fine']) expect(agentNameProblem(n, tr), n).toBe(agentNameProblem(n))
    for (const d of PROVIDERS) for (const mode of ['auto', 'acceptEdits']) expect(modeCaveat(d.id, mode as never, 'haiku', { supportsAuto: false }, tr)).toBe(modeCaveat(d.id, mode as never, 'haiku', { supportsAuto: false }))
    // A mode's name and what it does (Project Settings, Settings → Assistant: #861), an unknown mode its id either way.
    for (const d of PROVIDERS) for (const m of [...d.permissionModes.map((x) => x.value), 'no-such-mode']) {
      expect(permissionLabel(d.id, m, tr), m).toBe(permissionLabel(d.id, m))
      expect(modeDescription(d.id, m, tr), m).toBe(modeDescription(d.id, m))
    }
    expect(modeDescription('claude-code', 'no-such-mode')).toBe('no-such-mode')
  })

  it('under the pseudo-locale the window words translate, and what agents and main read stays English', () => {
    setLanguage(PSEUDO_LANGUAGE, {})
    const window = [
      ...providerPairs().map(([, english, text]) => shownText(english, text, tr)),
      ...PROVIDERS.flatMap((d) => d.permissionModes.flatMap((m) => [permissionLabel(d.id, m.value, tr), modeDescription(d.id, m.value, tr)])),
      agentLimitText(tr),
      ...STATUSES.flatMap((s) => mergeBlocked('B1', s, tr) ?? []),
      unmergedWork({ ahead: 2, dirty: 1, base: 'main', branch: 'b' } as never, tr)!.text,
      agentNameProblem('', tr)!,
      nameTakenMessage('b1', { name: 'B1', project: 'p' } as never, 'B2', tr),
      ...(['working', 'background', 'waiting', 'watching'] as SessionStatus[]).map((s) => busyNote(s)!),
      batchOutcome('archive', { live: null } as never).text,
      batchOutcome('remove', { live: { status: 'working' } } as never).text,
      removeWorktreeText({ branch: 'b', check: { removable: true } } as never),
      resumeBlock({ provider: 'claude-code', hasTranscript: false, hasBackup: false } as never, { live: false, providerEnabled: true, runners: [], canAddAgent: true } as never)!,
      removedAgentNote({ provider: 'claude-code', agentId: 'gone', agentName: 'Coder' } as never, [], null)!,
      testedSummary({ version: '2.1.287', installed: 'unknown' } as never, null),
      testedNote({ version: '2.1.287', installed: 'newer' } as never)!,
      keybindingProblem('K')!
    ]
    for (const t of window) expect(pseudo(t), t).toBe(true)
    expect(agentLimitText()).toBe('A project can have up to 24 agents.')
    expect(mergeBlocked('B1', 'working')).toBe('B1 is working. Merge once it has finished.')
    expect(PROVIDERS[0].permissionModes[0].label).toBe('Manual')
    expect([permissionLabel('claude-code', 'auto'), modeDescription('claude-code', 'auto')]).toEqual(['Auto', 'A safety classifier approves low-risk actions itself and only asks about risky ones.'])
    expect(testedComparison({ version: '1', installed: 'older' } as never)).toBe('older than tested')
  })
})
