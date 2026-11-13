// HI-3136: a refusal's Agent API reply has `error` filled as its `message` is, word for word, for every rule: never a
// placeholder left as it is ("{card} at {revision} … {why}") or a blank where a value is a message of its own (the
// `platform.unknown` start's `what`). And the error's own text (the log, the window) is filled the same way.
import { join } from 'path'
import { mkdirSync } from 'fs'
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
