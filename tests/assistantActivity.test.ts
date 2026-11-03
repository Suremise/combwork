// The Hive Assistant's actions say what they were with fields (#763): a kind from a fixed set and its targets, so a
// viewer such as Apiary follows the Assistant without reading its English line. Every change the Assistant makes names
// a kind where it is recorded, every kind is made somewhere and documented with an example in AGENT_API.md, and the
// fields that leave Hive are an allow-list: never a prompt, a message or a setting's value.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { ACTIVITY_KINDS, activityFields } from '../src/shared/assistantActivity'

const root = join(__dirname, '..')
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')
/** The main process's code that records the Assistant's actions. */
const SOURCES = ['src/main/servers.ts', 'src/main/taskBatch.ts', 'src/main/deliveries.ts', 'src/main/settingsTools.ts', 'src/main/assistantControl.ts']

describe("the Assistant's activity fields", () => {
  it('keeps only the documented fields, each only when well formed', () => {
    const a = { kind: 'start-task', card: 741, project: 'ambrosia', agent: { id: 'a-1', name: 'AMB1', prompt: 'secret' }, column: 'doing', text: 'secret', brief: 'secret' } as never
    expect(activityFields(a)).toEqual({ kind: 'start-task', card: 741, project: 'ambrosia', agent: { id: 'a-1', name: 'AMB1' }, column: 'doing' })
    expect(activityFields({ kind: 'reorder-tasks', cards: [3, 'x' as never] })).toEqual({ kind: 'reorder-tasks' })
    expect(activityFields({ kind: 'update-task', card: -1 })).toEqual({ kind: 'update-task' })
    // An unknown kind sends nothing at all.
    expect(activityFields({ kind: 'wander' as never, project: 'x' })).toEqual({})
    // Names and ids that came from a request are sent only when they are one: never free text.
    expect(activityFields({ kind: 'lane-end', lane: 'lane-0f89a0' })).toEqual({ kind: 'lane-end', lane: 'lane-0f89a0' })
    expect(activityFields({ kind: 'lane-end', lane: 'a secret sentence' })).toEqual({ kind: 'lane-end' })
    expect(activityFields({ kind: 'update-task', column: 'review' })).toEqual({ kind: 'update-task', column: 'review' })
    expect(activityFields({ kind: 'update-task', column: 'somewhere secret' })).toEqual({ kind: 'update-task' })
    expect(activityFields({ kind: 'create-project', project: 'apiary' })).toEqual({ kind: 'create-project', project: 'apiary' })
    expect(activityFields({ kind: 'create-project', project: 'a/b\nsecret' })).toEqual({ kind: 'create-project' })
    expect(activityFields({ kind: 'setting', settingId: 'sessions.confirmStop' })).toEqual({ kind: 'setting', settingId: 'sessions.confirmStop' })
    expect(activityFields({ kind: 'setting', settingId: 'value: secret' })).toEqual({ kind: 'setting' })
  })

  // Every change names its kind: record, admit, refuseUnlessAllowed and assistantChange require an act with one (the
  // type checker refuses a call without). Here: no kind is listed that nothing makes.
  it('makes every kind somewhere', () => {
    const code = SOURCES.map(read).join('\n')
    const used = new Set([...code.matchAll(/kind: '([a-z-]+)'/g)].map((m) => m[1]))
    for (const k of ACTIVITY_KINDS) expect(used, k).toContain(k)
  })

  it('documents every kind with an example in AGENT_API.md', () => {
    const doc = read('docs/AGENT_API.md')
    for (const k of ACTIVITY_KINDS) expect(doc, k).toMatch(new RegExp(`\\| \`${k}\` \\|[^\\n]*"kind": "${k}"`))
  })
})
