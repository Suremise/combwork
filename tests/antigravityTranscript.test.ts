// The Antigravity CLI's transcripts (HI-2546, recorded with agy 1.5.0 in HI-2543's runs): the conversation view (prompts,
// the model's text, tool calls with their results and errors, both transcript files), usage (requests, tokens without
// counting the cache twice, the model, prompts), a file agy writes again, the conversation's title, and where Combwork
// looks for a conversation (only Combwork's profiles, the path agy reports only when it is that conversation's there).
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-agy-transcript-')
process.env.CW_USER_DATA = join(base, 'userdata')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { AntigravityConversationParser, AntigravityUsageParser, annotationTitle, parseAgyTranscript, plainArgs, stepOutput, userRequestText } = await import('../src/main/providers/antigravity/transcript')
const { conversationTitle, listConversations, profileOf, profileTranscript, transcriptIn } = await import('../src/main/providers/antigravity/conversations')
const { antigravity } = await import('../src/main/providers/antigravity/adapter')
const { profilesRoot } = await import('../src/main/providers/antigravity/home')
const { advanced } = await import('../src/main/advanced')
const { newUsageParser } = await import('../src/main/usageParsers')

const FIX = join(__dirname, 'fixtures', 'antigravity')
const fixture = (name: string): string => readFileSync(join(FIX, name), 'utf8')
const PLAIN = '88931470-dbf8-455e-8c2f-76840a752604'
const TOOLS = '68222232-2149-4ed1-9493-8134499d0454'

const items = (text: string, root: string | null = null) => {
  const p = new AntigravityConversationParser(root)
  p.feed(Buffer.from(text))
  return p
}

describe("agy's transcript as a conversation", () => {
  it('shows the prompt without what agy adds, and the reply', () => {
    const p = items(fixture('plain-1.5.0.jsonl'))
    expect(p.items.map((i) => [i.kind, 'text' in i ? i.text : ''])).toEqual([
      ['user', 'Reply with exactly the word BRAVO and nothing else. Do not use tools.'],
      ['assistant', 'BRAVO']
    ])
    expect(p.items[0].timestamp).toBe('2026-11-07T02:08:16Z')
  })

  it("shows each MCP call as its server's tool, with its result (without agy's times), keyed by its result's step", () => {
    const p = items(fixture('mcp-tools-1.5.0.jsonl'))
    const tools = p.items.flatMap((i) => (i.kind === 'tool' ? [i.tool] : []))
    expect(tools.map((t) => [t.toolUseId, t.name, t.result, t.isError])).toEqual([
      ['2', 'probe-A · probe_whoami', 'probe A, token token-A', false],
      ['3', 'probe-B · probe_whoami', 'probe B, token token-B', false]
    ])
    expect(p.items.map((i) => i.kind)).toEqual(['user', 'tool', 'tool', 'assistant'])
    expect(p.items[3].kind === 'assistant' && p.items[3].text).toMatch(/DONE$/)
  })

  it('reads transcript.jsonl (each argument encoded again) as transcript_full.jsonl', () => {
    const strip = (p: { items: unknown[] }) => JSON.stringify(p.items)
    expect(strip(items(fixture('mcp-tools-short-1.5.0.jsonl')))).toBe(strip(items(fixture('mcp-tools-1.5.0.jsonl'))))
    expect(plainArgs({ ServerName: '"probe-A"', Arguments: '{}', Plain: 'x', Broken: '"open' })).toEqual({ ServerName: 'probe-A', Arguments: {}, Plain: 'x', Broken: '"open' })
  })

  it("marks a call that failed with agy's error", () => {
    const p = items(fixture('tool-errors-1.5.0.jsonl'))
    const tools = p.items.flatMap((i) => (i.kind === 'tool' ? [i.tool] : []))
    expect(tools).toHaveLength(3)
    for (const t of tools) {
      expect(t.isError).toBe(true)
      expect(t.result).toMatch(/^JSON hook "jsonhook__probe-unwanted_PreToolUse_0_0" failed/)
    }
    expect(p.items.filter((i) => i.kind === 'notice')).toEqual([])
  })

  it("shows an error step no call waits for as agy's note", () => {
    const line = JSON.stringify({ step_index: 4, source: 'MODEL', type: 'GENERIC', status: 'ERROR', error: 'quota exhausted', created_at: '2026-11-07T02:00:00Z', content: 'x' })
    const p = items(fixture('plain-1.5.0.jsonl') + line + '\n')
    expect(p.items.at(-1)).toMatchObject({ kind: 'notice', level: 'error', text: 'quota exhausted' })
  })

  it('reads whole lines only, and a line for a step already read (agy writing the file again) is left out', () => {
    const text = fixture('mcp-tools-1.5.0.jsonl')
    const buf = Buffer.from(text)
    const p = new AntigravityConversationParser(null)
    const cut = buf.indexOf(10, 100) + 20
    const first = p.feed(buf.subarray(0, cut))
    expect(first).toBe(buf.indexOf(10, 100) + 1)
    p.feed(buf.subarray(first))
    const n = p.items.length
    p.feed(Buffer.from(text))
    expect(p.items).toHaveLength(n)
  })

  it('a summary from the argument that says what a call is about, a path short under the project', () => {
    const line = (step: number, calls: unknown[]) => JSON.stringify({ step_index: step, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-07T02:00:00Z', tool_calls: calls })
    const p = items(line(1, [{ name: 'view_file', args: { AbsolutePath: 'C:\\repo\\src\\a.ts' } }, { name: 'run_command', args: { CommandLine: 'npm test\nmore', Cwd: 'C:\\repo' } }]) + '\n', 'C:\\repo')
    const tools = p.items.flatMap((i) => (i.kind === 'tool' ? [i.tool] : []))
    expect(tools.map((t) => [t.name, t.summary])).toEqual([
      ['view_file', 'src/a.ts'],
      ['run_command', 'npm test']
    ])
  })

  it("the prompt and output patterns are the advanced settings'", () => {
    expect(userRequestText('<USER_REQUEST>\nhi\n</USER_REQUEST>\n<ADDITIONAL_METADATA>t</ADDITIONAL_METADATA>')).toBe('hi')
    expect(userRequestText('no wrapper')).toBe('no wrapper')
    expect(stepOutput('Created At: a\nCompleted At: b\nout')).toBe('out')
    expect(stepOutput('plain')).toBe('plain')
  })
})

describe("agy's transcript as usage", () => {
  it('counts each model request, its tokens, the prompt and the model', () => {
    const u = parseAgyTranscript(fixture('mcp-tools-1.5.0.jsonl'), TOOLS)
    expect(u).toMatchObject({ provider: 'antigravity', requests: 2, inputTokens: 7917 + 8131, outputTokens: 70 + 108, cacheReadTokens: 0, userMessages: 1, model: 'Gemini 3.8 Flash (Low)', contextTokens: 8131 + 108, costUsd: null, costEstimated: false })
    expect(u.lastPrompt).toMatch(/^Do not use any shell/)
    expect(u.firstActivity).toBe('2026-11-07T02:07:29Z')
    expect(u.lastActivity).toBe('2026-11-07T02:07:35Z')
    expect(Object.values(u.days!).reduce((n, d) => n + d.requests, 0)).toBe(2)
  })

  it("doesn't count cached tokens twice (input includes them), unless its setting says input doesn't", async () => {
    const line = JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-07T02:00:00Z', input_tokens: 5000, cache_read_tokens: 1000, output_tokens: 10 })
    const inclusive = parseAgyTranscript(line, PLAIN)
    expect(inclusive).toMatchObject({ inputTokens: 4000, cacheReadTokens: 1000, contextTokens: 5010, contextInputTokens: 5000 })
    await advanced.set('antigravity.usage.inputIncludesCache', false)
    try {
      expect(parseAgyTranscript(line, PLAIN)).toMatchObject({ inputTokens: 5000, cacheReadTokens: 1000, contextTokens: 6010 })
    } finally {
      await advanced.set('antigravity.usage.inputIncludesCache', null)
    }
  })

  it('reads a file agy wrote again without counting its steps twice; the usage worker has its parser', () => {
    const text = fixture('plain-1.5.0.jsonl')
    const p = new AntigravityUsageParser(PLAIN)
    p.feed(text)
    p.feed(text)
    expect(p.result()).toMatchObject({ requests: 1, userMessages: 1, inputTokens: 7754, outputTokens: 2 })
    expect(newUsageParser('antigravity', PLAIN)).not.toBeNull()
  })

  it("the conversation's title is agy's (its annotations)", () => {
    expect(annotationTitle('title:"Tool Listing and Execution Task"\n')).toBe('Tool Listing and Execution Task')
    expect(annotationTitle('title: "Say \\"hi\\" \\\\ there"')).toBe('Say "hi" \\ there')
    expect(annotationTitle('other: 1')).toBeNull()
  })
})

describe("agy's conversations in Combwork's profiles", () => {
  const root = profilesRoot()
  const profile = join(root, 'agent-1')
  const cli = join(profile, '.gemini', 'antigravity-cli')
  const logs = join(cli, 'brain', TOOLS, '.system_generated', 'logs')
  mkdirSync(logs, { recursive: true })
  writeFileSync(join(logs, 'transcript_full.jsonl'), fixture('mcp-tools-1.5.0.jsonl'))
  writeFileSync(join(logs, 'transcript.jsonl'), fixture('mcp-tools-short-1.5.0.jsonl'))
  mkdirSync(join(cli, 'annotations'), { recursive: true })
  writeFileSync(join(cli, 'annotations', `${TOOLS}.pbtxt`), 'title:"Tool Listing and Execution Task"\n')
  mkdirSync(join(cli, 'cache'), { recursive: true })
  writeFileSync(join(cli, 'cache', 'last_conversations.json'), JSON.stringify({ 'C:\\work\\proj': TOOLS }))
  // Another agent's, in another folder.
  const other = join(root, 'agent-2', '.gemini', 'antigravity-cli')
  mkdirSync(join(other, 'brain', PLAIN, '.system_generated', 'logs'), { recursive: true })
  writeFileSync(join(other, 'brain', PLAIN, '.system_generated', 'logs', 'transcript_full.jsonl'), fixture('plain-1.5.0.jsonl'))
  mkdirSync(join(other, 'cache'), { recursive: true })
  writeFileSync(join(other, 'cache', 'last_conversations.json'), JSON.stringify({ 'C:\\work\\other': PLAIN }))

  it('finds a conversation in the profile that has it, transcript_full.jsonl first', async () => {
    expect(await profileOf(root, TOOLS)).toBe(profile)
    expect(transcriptIn(profile, TOOLS)).toBe(join(logs, 'transcript_full.jsonl'))
    expect(transcriptIn(profile, '../x')).toBeNull()
    expect(await antigravity.transcriptPath('C:\\work\\proj', TOOLS)).toBe(join(logs, 'transcript_full.jsonl'))
    expect(await antigravity.transcriptPath('C:\\work\\proj', 'not-an-id')).toBeNull()
    expect(conversationTitle(profile, TOOLS)).toBe('Tool Listing and Execution Task')
    expect(antigravity.usageTitle(TOOLS)).toBe('Tool Listing and Execution Task')
    expect(antigravity.parseUsage(fixture('mcp-tools-1.5.0.jsonl'), TOOLS).title).toBe('Tool Listing and Execution Task')
  })

  it("takes the path agy reports only when it is that conversation's transcript in a profile of Combwork's", async () => {
    const reported = join(logs, 'transcript_full.jsonl')
    expect(profileTranscript(reported, root, TOOLS)).toBe(true)
    expect(profileTranscript(reported.replace(/\\/g, '/'), root, TOOLS)).toBe(true)
    expect(profileTranscript(reported, root, PLAIN)).toBe(false)
    expect(profileTranscript(join(logs, '..', '..', '..', PLAIN, '.system_generated', 'logs', 'transcript_full.jsonl'), root, TOOLS)).toBe(false)
    expect(profileTranscript(join(logs, 'other.jsonl'), root, TOOLS)).toBe(false)
    expect(profileTranscript(join(base, 'elsewhere', 'transcript_full.jsonl'), root)).toBe(false)
    // A path outside the profiles is never read: the conversation is looked up instead.
    const outside = join(base, 'outside.jsonl')
    writeFileSync(outside, '{}\n')
    expect(await antigravity.transcriptPath('C:\\work\\proj', TOOLS, outside)).toBe(join(logs, 'transcript_full.jsonl'))
  })

  it("lists the conversations of the profiles that ran in the folder, leaving out Combwork's own", async () => {
    expect((await listConversations(root, 'C:\\work\\proj')).map((s) => s.id)).toEqual([TOOLS])
    expect((await listConversations(root, 'c:\\work\\proj\\')).map((s) => s.id)).toEqual([TOOLS])
    expect(await listConversations(root, 'C:\\work\\proj', (id) => id === TOOLS)).toEqual([])
    expect((await antigravity.listSessions('C:\\work\\other')).map((s) => [s.id, s.bytes! > 0])).toEqual([[PLAIN, true]])
    expect(await listConversations(root, 'C:\\work\\none')).toEqual([])
  })

  it("can't put a transcript back for a resume: agy resumes from its own store", () => {
    expect(antigravity.restorePath()).toBeNull()
  })
})

describe("agy's status line", () => {
  it('gives the model by its name, its effort and the context window (1.5.0, recorded)', () => {
    const lines = readFileSync(join(__dirname, 'fixtures', 'advanced', 'statusline-antigravity-1.5.0.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l))
    expect(antigravity.statusLine(lines[0])).toEqual({})
    expect(antigravity.statusLine(lines[1])).toEqual({ modelName: 'Gemini 3.8 Flash (Low)', effort: 'low', contextWindow: 1048576 })
  })
})
