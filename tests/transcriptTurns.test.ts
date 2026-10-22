// Hooks health, part 2 (#1371): each CLI's transcript names its turns by an id its hooks carry (Claude Code's promptId
// and prompt_id, Codex's turn_id), or by one of its own (Copilot's interactionId, its hooks carrying none). Which turns
// count, read from recorded transcripts: a person's prompt the model took up, never a local command, a task
// notification's wake, a compaction or a side conversation; and a turn whose prompt wasn't read is unknown.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { claudeTranscriptTurns } from '../src/main/providers/claude/turns'
import { codexTranscriptTurns } from '../src/main/providers/codex/turns'
import { copilotTranscriptTurns } from '../src/main/providers/copilot/turns'

const fixture = (...p: string[]): string => readFileSync(join(__dirname, 'fixtures', ...p), 'utf8')
const worked = (turns: { id: string; worked: boolean }[]): string[] => turns.filter((t) => t.worked).map((t) => t.id)

describe('Claude Code (2.1.306, an anonymised recorded transcript)', () => {
  const text = fixture('turns', 'claude-2.1.306.jsonl')

  it("its people's prompts are turns by promptId, worked once an assistant entry chains to them; a task notification's wake isn't one", () => {
    const turns = claudeTranscriptTurns(text, {})
    expect(turns.map((t) => t.id.slice(0, 8)).sort()).toEqual(['1a74d0b9', 'dc920c82'])
    expect(turns.every((t) => t.worked)).toBe(true)
    expect(turns.find((t) => t.id.startsWith('1a74d0b9'))?.at).toBe(Date.parse('2026-10-21T17:25:49.842Z'))
  })

  it('read in pieces, line by line, the chains are followed across reads (the memo)', () => {
    const memo = {}
    const seen = new Map<string, boolean>()
    for (const line of text.split('\n')) for (const t of claudeTranscriptTurns(line + '\n', memo)) seen.set(t.id.slice(0, 8), t.worked)
    expect(Object.fromEntries(seen)).toEqual({ '1a74d0b9': true, dc920c82: true })
  })

  it("a turn whose prompt wasn't read (the reading began after it, or forgot it in a gap) is unknown, never a turn", () => {
    const lines = text.split('\n')
    const prompt = lines.findIndex((l) => l.includes('"promptId": "dc920c82') && l.includes('"prompt text"'))
    const after = lines.slice(prompt + 1).join('\n')
    expect(claudeTranscriptTurns(after, {}).map((t) => t.id.slice(0, 8))).not.toContain('dc920c82')
  })

  it('a local command (a promptId, no assistant entry) is read but never worked; meta, sidechain and compaction entries are no prompt', () => {
    const at = '2026-10-21T18:00:00.000Z'
    const lines = [
      { type: 'user', uuid: 'c1', parentUuid: null, promptId: 'p-cmd', origin: { kind: 'human' }, timestamp: at, message: { role: 'user', content: '<command-name>/effort</command-name>' } },
      { type: 'user', uuid: 'c2', parentUuid: 'c1', promptId: 'p-cmd', timestamp: at, message: { role: 'user', content: '<local-command-stdout>…</local-command-stdout>' } },
      { type: 'user', uuid: 'm1', parentUuid: 'c2', promptId: 'p-meta', isMeta: true, timestamp: at, message: { role: 'user', content: 'caveat' } },
      { type: 'assistant', uuid: 'a0', parentUuid: 'm1', timestamp: at, message: { role: 'assistant', content: [] } },
      { type: 'user', uuid: 's1', parentUuid: null, promptId: 'p-side', isSidechain: true, timestamp: at, message: { role: 'user', content: 'sub-agent task' } },
      { type: 'assistant', uuid: 's2', parentUuid: 's1', isSidechain: true, timestamp: at, message: { role: 'assistant', content: [] } },
      { type: 'user', uuid: 'k1', parentUuid: null, promptId: 'p-compact', isCompactSummary: true, timestamp: at, message: { role: 'user', content: 'summary' } },
      { type: 'assistant', uuid: 'k2', parentUuid: 'k1', timestamp: at, message: { role: 'assistant', content: [] } },
      // An assistant entry chained to an entry never read: no turn.
      { type: 'assistant', uuid: 'x1', parentUuid: 'unknown', timestamp: at, message: { role: 'assistant', content: [] } }
    ]
    const turns = claudeTranscriptTurns(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', {})
    expect(turns).toEqual([{ id: 'p-cmd', at: Date.parse(at), worked: false }])
  })

  it('a partial or damaged line is skipped, not a turn', () => {
    expect(claudeTranscriptTurns('{"type":"user","promptId":"p1","uuid":"u1","message":{"role":"user","con\n', {})).toEqual([])
  })
})

describe('Codex (0.159, a recorded rollout)', () => {
  const text = fixture('codex-0.159.jsonl')

  it("its people's turns by turn_id, worked; the compaction (a turn of its own, no prompt) isn't one", () => {
    const turns = codexTranscriptTurns(text, {})
    expect(turns.map((t) => t.id)).toEqual(['01a0f107-215d-7071-861f-4d709d7d3b98', '01a0f107-57c1-7b11-ad82-0918d4da4761', '01a0f107-766e-7492-8a0c-31b0f0d66dc0'])
    expect(worked(turns)).toHaveLength(3)
    expect(turns[0].at).toBe(Date.parse('2026-09-30T06:36:12.189Z'))
  })

  it('a sub-turn (its root another turn) is no turn of its own', () => {
    const line = (o: object): string => JSON.stringify({ timestamp: '2026-09-30T06:40:00.000Z', ...o })
    const rollout = [
      line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'sub', root_turn_id: 'root' } }),
      line({ type: 'event_msg', payload: { type: 'item_completed', turn_id: 'sub', root_turn_id: 'root', item: { type: 'UserMessage' } } }),
      line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } })
    ].join('\n')
    expect(codexTranscriptTurns(rollout + '\n', {})).toEqual([])
  })

  it("before 0.159: a user_message event inside its task is its prompt; a turn context with no turn_id doesn't end the turn", () => {
    const line = (o: object): string => JSON.stringify({ timestamp: '2026-09-30T06:40:00.000Z', ...o })
    const rollout = [
      line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }),
      line({ type: 'turn_context', payload: { cwd: 'C:\\proj' } }),
      line({ type: 'event_msg', payload: { type: 'user_message', message: 'go' } }),
      line({ type: 'response_item', payload: { type: 'reasoning' } })
    ].join('\n')
    expect(codexTranscriptTurns(rollout + '\n', {})).toEqual([{ id: 't1', at: Date.parse('2026-09-30T06:40:00.000Z'), worked: true }])
  })
})

describe('Copilot (1.0.98, recorded session state)', () => {
  it('its interactions are turns, worked once the model took them up', () => {
    const text = fixture('copilot', 'session-state', '0cb916db-26aa-40f2-86b5-1ba81b225fd2', 'events.jsonl')
    const turns = copilotTranscriptTurns(text, {})
    // Two before its session.resume, two after.
    expect(turns.map((t) => t.id)).toEqual(['6cbd942e-03b7-48da-b157-5e3d700b6d3e', '54f4ba9d-9a31-43fb-b3ff-bd90e67f5e00', 'f186e199-a8c8-4c1b-b925-51201112f7a6', '21ec95ff-c38e-4339-a55e-5e7472d9e356'])
    expect(worked(turns)).toHaveLength(4)
    expect(turns[0].at).toBe(Date.parse('2026-10-08T21:12:46.710Z'))
  })

  it('a prompt the model never took up is read but not worked', () => {
    const text = JSON.stringify({ type: 'user.message', timestamp: '2026-10-08T21:20:00.000Z', data: { interactionId: 'i1', content: 'x' } })
    expect(copilotTranscriptTurns(text + '\n', {})).toEqual([{ id: 'i1', at: Date.parse('2026-10-08T21:20:00.000Z'), worked: false, prompt: 'x' }])
  })
})
