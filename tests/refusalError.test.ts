// HI-3136: a refusal's Agent API reply has `error` filled as its `message` is, word for word, for every rule: never a
// placeholder left as it is ("{card} at {revision} … {why}") or a blank where a value is a message of its own (the
// `platform.unknown` start's `what`). And the error's own text (the log, the window) is filled the same way.
import { join } from 'path'
import { mkdirSync, readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { REFUSALS, refusal, type RuleId } from '../src/shared/workflow/refusals'
import { UNREADABLE, workflowText } from '../src/shared/workflow/texts'

const base = tempDir('cw-refusal-error-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { apiErrorReply } = await import('../src/main/servers')
const { WorkflowRefusedError } = await import('../src/main/tasks')
const { shownError } = await import('../src/main/combworkError')
const { setLanguage } = await import('../src/shared/i18n')

const reply = (rule: RuleId, values: Parameters<typeof refusal>[1]) => {
  const e = new WorkflowRefusedError(refusal(rule, values))
  return { body: apiErrorReply(e).body as { error: string; message: string }, text: e.message }
}

describe("a refusal's error (HI-3136)", () => {
  it('requeue.allowed, whose {why} is its cause’s sentence: filled, as its message is', () => {
    const r = reply('requeue.allowed', { card: 'AL-3', revision: 'e852a58', cause: 'requeueNotTransient' })
    expect(r.body.error).toBe(r.body.message)
    expect(r.body.error).toMatch(/^AL-3 at e852a58 can't go back into the merge queue unchanged: its last merge failed for a reason in the work/)
    expect(r.text).toBe(r.body.message)
  })

  it('platform.unknown, whose {what} is a message of its own: filled, never a blank', () => {
    const what = workflowText(UNREADABLE.remoteSetup, { target: '1.5.0' })
    const r = reply('platform.unknown', { card: 'AL-2', what, rule: 'start' })
    expect(r.body.error).toBe(r.body.message)
    expect(r.body.error).toContain('the remote branch 1.5.0 follows')
    expect(r.text).toBe(r.body.message)
  })

  it("in the window's language (German), the nested what and the cause's why are German too: kept as messages (HR1's round 1)", () => {
    const de = JSON.parse(readFileSync(join(__dirname, '..', 'locales', 'de', 'workflow.json'), 'utf8')) as Record<string, string>
    setLanguage('de', de)
    try {
      const what = workflowText(UNREADABLE.remoteSetup, { target: '1.5.0' })
      const unknownShown = shownError(new WorkflowRefusedError(refusal('platform.unknown', { card: 'AL-2', what, rule: 'start' })))
      expect(unknownShown).toBe(`AL-2: Combwork konnte den Remote-Branch, dem 1.5.0 folgt (er muss einem folgen, auf einem Remote mit genau einer Push-Adresse) nicht lesen, daher kann die Regel start nicht geprüft werden.`)
      const why = de['workflow.refused.why.requeueNotTransient']
      const requeueShown = shownError(new WorkflowRefusedError(refusal('requeue.allowed', { card: 'AL-3', revision: 'e852a58', cause: 'requeueNotTransient' })))
      expect(requeueShown).toBe(`AL-3 (Revision e852a58) kann nicht unverändert zurück in die Merge-Warteschlange: ${why}`)
      expect(requeueShown).not.toMatch(/[{}]/)
      // The English field (agents, the log) stays English whatever the window shows.
      expect(new WorkflowRefusedError(refusal('requeue.allowed', { card: 'AL-3', revision: 'e852a58', cause: 'requeueNotTransient' })).message).toMatch(/^AL-3 at e852a58 can't go back into the merge queue unchanged/)
    } finally {
      setLanguage('en', {})
    }
  })

  it('every rule: error is its message, with no placeholder left', () => {
    for (const rule of Object.keys(REFUSALS) as RuleId[]) {
      // Each of its message's placeholders given a plain value (selects take their "other").
      const placeholders = [...new Set([...(REFUSALS[rule].message.defaultMessage ?? '').matchAll(/\{(\w+)/g)].map((m) => m[1]))]
      const values = Object.fromEntries(placeholders.map((k) => [k, 'X']))
      const r = reply(rule, values)
      expect(r.body.error, rule).toBe(r.body.message)
      expect(r.body.error, rule).not.toMatch(/\{\w+\}/)
    }
  })
})
