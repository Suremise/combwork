// Reading agy's transcripts as Combwork's viewer and usage worker do (HI-2546, HR1's round 1): agy may write a
// transcript again in place, so a change whose bytes read before aren't the same (an equal-length overwrite, a rewritten
// start that then grew) is read again from the start, with no item, image offset or token counted twice; appending stays
// incremental; the image a tool read comes from that conversation's own media file only. Append-only providers are left
// as they were (rereadsWhole is agy's alone).
import { mkdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-agy-reads-')
process.env.CW_USER_DATA = join(base, 'userdata')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

// The session's transcript is this test's file, on Antigravity: only what the viewer asks of sessions and the workspace.
let file = ''
vi.mock('../src/main/sessions', () => ({ sessions: { reserved: () => false, anyTranscript: async () => file, sessionProvider: async () => 'antigravity' } }))
vi.mock('../src/main/workspace', () => ({ workspace: { assertSessionHost: (p: string) => p }, workspaceOf: () => ({}), setWorkspaceFallback: () => {} }))
const { transcripts } = await import('../src/main/transcripts')
const { profilesRoot } = await import('../src/main/providers/antigravity/home')
const { handleRequest } = await import('../src/main/usageWorker')
const { rereadsWhole } = await import('../src/main/usageParsers')

const FIX = join(__dirname, 'fixtures', 'antigravity')
const fixture = (name: string): string => readFileSync(join(FIX, name), 'utf8').replace(/\r\n/g, '\n')
const CONV = 'b6078cac-11ea-44a7-a86d-584af6b5b6ce'
const PROJECT = join(base, 'proj')
const logs = join(profilesRoot(), 'agent-r', '.gemini', 'antigravity-cli', 'brain', CONV, '.system_generated', 'logs')
file = join(logs, 'transcript_full.jsonl')
mkdirSync(join(logs, 'media'), { recursive: true })
writeFileSync(join(logs, 'media', 'step_2_media_0.png'), readFileSync(join(FIX, 'image-1.5.0-media.png')))


/** The image fixture, its media uri this test's own file. */
const imageText = (): string => fixture('image-1.5.0.jsonl').replace('file:///C:/profile/.gemini/antigravity-cli/brain', 'file:///' + join(profilesRoot(), 'agent-r', '.gemini', 'antigravity-cli', 'brain').replace(/\\/g, '/'))
/** Writes the transcript, its time `t` seconds on, so a same-size rewrite has another time (as a real write does). */
let t = 1_800_000_000
const put = (text: string): void => {
  writeFileSync(file, text)
  utimesSync(file, ++t, t)
}
const shown = async () => (await transcripts.read(PROJECT, CONV))!.items.map((i) => (i.kind === 'tool' ? `tool ${i.tool.name}: ${i.tool.result}` : 'text' in i ? `${i.kind} ${i.text}` : i.kind))

describe("agy's transcript, written again in place", () => {
  it('appended to: read on from where it was', async () => {
    const lines = imageText().split('\n').filter(Boolean)
    put(lines.slice(0, 2).join('\n') + '\n')
    expect(await shown()).toEqual(['user Look at the image file red.png in this folder and reply with its main colour in one word.', 'tool read_file: null'])
    put(lines.join('\n') + '\n')
    expect(await shown()).toEqual(['user Look at the image file red.png in this folder and reply with its main colour in one word.', 'tool read_file: Showing binary file of type image/png', 'assistant Red'])
  })

  it('overwritten with the same length: read again from the start, nothing twice', async () => {
    const text = imageText()
    put(text)
    await shown()
    const same = text.replace('reply with its main colour', 'answer with its main colour'.slice(0, 'reply with its main colour'.length))
    expect(same.length).toBe(text.length)
    put(same)
    const after = await shown()
    expect(after[0]).toMatch(/^user Look at the image file red\.png in this folder and answer with its main colo/)
    expect(after).toHaveLength(3)
  })

  it('its start rewritten, then grown: read again from the start, its image offsets those of the new file', async () => {
    put(imageText())
    await shown()
    const lines = imageText().split('\n').filter(Boolean)
    // A rewind's shape: the first prompt rewritten longer, the rest after it.
    const first = JSON.parse(lines[0])
    first.content = first.content.replace('one word.', 'one word, please.')
    put([JSON.stringify(first), ...lines.slice(1)].join('\n') + '\n')
    const after = await shown()
    expect(after).toHaveLength(3)
    expect(after[0]).toMatch(/one word, please\.$/)
    // The image is found where the new file has it.
    expect(await transcripts.image(PROJECT, CONV, 0)).toBe(`data:image/png;base64,${readFileSync(join(FIX, 'image-1.5.0-media.png')).toString('base64')}`)
  })

  it("the usage worker reads it whole again: its tokens counted once, after a same-size overwrite too", async () => {
    expect(rereadsWhole('antigravity')).toBe(true)
    expect(rereadsWhole('codex')).toBe(false)
    expect(rereadsWhole('claude-code')).toBe(false)
    let id = 0
    const read = async () => ((await handleRequest({ id: ++id, type: 'read', path: file, session: CONV, provider: 'antigravity', seed: null } as never)) as { usage: { requests: number; inputTokens: number; outputTokens: number } }).usage
    const text = imageText()
    put(text)
    expect(await read()).toMatchObject({ requests: 2, inputTokens: 7088 + 8352, outputTokens: 104 + 1 })
    // The same length, other tokens (8352 → 8353, 104 → 103).
    const same = text.replace('"input_tokens":8352', '"input_tokens":8353').replace('"output_tokens":104', '"output_tokens":103')
    expect(same.length).toBe(text.length)
    put(same)
    expect(await read()).toMatchObject({ requests: 2, inputTokens: 7088 + 8353, outputTokens: 103 + 1 })
    // Grown after a rewrite of its start: counted from the start again, not added.
    put(same.replace('"input_tokens":7088', '"input_tokens":70880') + JSON.stringify({ step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-07T11:46:33Z', input_tokens: 10, cache_read_tokens: 0, output_tokens: 1 }) + '\n')
    expect(await read()).toMatchObject({ requests: 3, inputTokens: 70880 + 8353 + 10, outputTokens: 103 + 1 + 1 })
  })

  it("another file put in its place, keeping its size and time (a rename over it), is read from the start by both readers (HR2's round 2)", async () => {
    let id = 100
    const usage = async () => ((await handleRequest({ id: ++id, type: 'read', path: file, session: CONV, provider: 'antigravity', seed: null } as never)) as { usage: { inputTokens: number } }).usage
    const text = imageText()
    const other = text.replace('in this folder and reply', 'in this folder and REPLY').replace('"input_tokens":8352', '"input_tokens":8353')
    expect(other.length).toBe(text.length)
    const at = 1_900_000_000
    writeFileSync(file, text)
    utimesSync(file, at, at)
    expect((await shown())[0]).toMatch(/and reply/)
    expect((await usage()).inputTokens).toBe(7088 + 8352)
    const next = join(logs, 'replacement.jsonl')
    writeFileSync(next, other)
    utimesSync(next, at, at)
    const before = statSync(file)
    renameSync(next, file)
    const after = statSync(file)
    expect([after.size === before.size, after.mtimeMs === before.mtimeMs, after.ino !== before.ino]).toEqual([true, true, true])
    expect((await shown())[0]).toMatch(/and REPLY/)
    expect((await usage()).inputTokens).toBe(7088 + 8353)
  })
})
