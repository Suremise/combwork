// The Antigravity CLI's transcripts (HI-2546, recorded with agy 1.5.0 in HI-2543's runs): the conversation view (prompts,
// the model's text, tool calls with their results and errors, both transcript files), usage (requests, tokens without
// counting the cache twice, the model, prompts), a file agy writes again, the conversation's title, and where Combwork
// looks for a conversation (only Combwork's profiles, the path agy reports only when it is that conversation's there).
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-agy-transcript-')
process.env.CW_USER_DATA = join(base, 'userdata')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { AntigravityConversationParser, AntigravityUsageParser, annotationTitle, parseAgyTranscript, stepOutput, userRequestText } = await import('../src/main/providers/antigravity/transcript')
const { TRANSCRIPT_FILE, knownTitle, learnTitle, listConversations, mediaData, profileOf, profileTranscript, transcriptIn, trustedTranscript } = await import('../src/main/providers/antigravity/conversations')
const { formatToolInput } = await import('../src/main/providers/claude/conversation')
const { antigravity, profileFolder } = await import('../src/main/providers/antigravity/adapter')
const { profilesRoot } = await import('../src/main/providers/antigravity/home')
const { advanced } = await import('../src/main/advanced')
const { newUsageParser } = await import('../src/main/usageParsers')

const FIX = join(__dirname, 'fixtures', 'antigravity')
/** The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take. */
const HUNG_MS = 20000
/** Waits for a condition, at most `ms`. */
async function until(ok: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setImmediate(r))
  }
}
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

  it("takes each argument exactly as transcript_full.jsonl has it, never guessing an encoding (HR1's round 1)", () => {
    const args = { Path: '[1,2]', Quoted: '"kept"', Count: 12, Enabled: true, Nothing: null, List: [1, 'a'], Obj: { a: 1 }, Json: '{"a":1}' }
    const line = JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-07T02:00:00Z', tool_calls: [{ name: 'some_tool', args }] })
    const tool = items(line + '\n').items.flatMap((i) => (i.kind === 'tool' ? [i.tool] : []))[0]
    expect(tool.input).toBe(formatToolInput('some_tool', args))
    expect(tool.input).toContain('Path: [1,2]\nQuoted: "kept"\nCount: 12\nEnabled: true\nNothing: null')
    // transcript.jsonl (each argument encoded again) isn't what Combwork reads: TRANSCRIPT_FILE is the full one.
    expect(TRANSCRIPT_FILE).toBe('transcript_full.jsonl')
  })

  it("leaves an unknown or malformed step out: it never takes a waiting call's result, nor stops what follows", () => {
    const step = (o: Record<string, unknown>) => JSON.stringify({ source: 'MODEL', status: 'DONE', created_at: '2026-11-07T02:00:00Z', ...o })
    const text = [
      step({ step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'read_file', args: { Path: 'a' } }, { name: 'read_file', args: { Path: 'b' } }] }),
      step({ step_index: 2, source: 'SYSTEM', type: 'FUTURE_METADATA', content: 'not a tool result' }),
      'not json',
      step({ step_index: 1e300, type: 'GENERIC', content: 'a huge index' }),
      step({ step_index: -1, type: 'GENERIC', content: 'a negative index' }),
      step({ step_index: 2.5, type: 'GENERIC', content: 'not whole' }),
      step({ type: 'GENERIC', content: 'no index' }),
      step({ step_index: Number.MAX_SAFE_INTEGER, source: 'SYSTEM', type: 'OTHER', content: 'a far index, unknown' }),
      step({ step_index: 3, type: 'GENERIC', content: 'result for a' }),
      step({ step_index: 4, type: 'GENERIC', content: 'result for b' }),
      step({ step_index: 5, type: 'PLANNER_RESPONSE', content: 'done' })
    ].join('\n') + '\n'
    const p = items(text)
    expect(p.items.flatMap((i) => (i.kind === 'tool' ? [[i.tool.toolUseId, i.tool.result]] : []))).toEqual([
      ['3', 'result for a'],
      ['4', 'result for b']
    ])
    expect(p.items.at(-1)).toMatchObject({ kind: 'assistant', text: 'done' })
    expect(p.items.filter((i) => i.kind === 'notice')).toEqual([])
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

  it("counts the cache once: a request's input is without its cache read (1.5.0's subagent request), unless its setting says it includes it", async () => {
    const child = parseAgyTranscript(fixture('subagent-child-1.5.0.jsonl'), 'ded852d1-0c96-4f30-bf60-bc1a470ed6c8')
    expect(child).toMatchObject({ requests: 2, inputTokens: 2198 + 7413, cacheReadTokens: 5058, outputTokens: 55 + 9, userMessages: 0 })
    const line = JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-07T02:00:00Z', input_tokens: 5000, cache_read_tokens: 1000, output_tokens: 10 })
    expect(parseAgyTranscript(line, PLAIN)).toMatchObject({ inputTokens: 5000, cacheReadTokens: 1000, contextTokens: 6010, contextInputTokens: 6000 })
    await advanced.set('antigravity.usage.inputIncludesCache', true)
    try {
      expect(parseAgyTranscript(line, PLAIN)).toMatchObject({ inputTokens: 4000, cacheReadTokens: 1000, contextTokens: 5010 })
    } finally {
      await advanced.set('antigravity.usage.inputIncludesCache', null)
    }
  })

  it('counts a compaction (its CHECKPOINT): its own request, what it left, asked for by /compact, which is no prompt', () => {
    const u = parseAgyTranscript(fixture('tools-resume-compact-1.5.0.jsonl'), TOOLS)
    // Three prompts (the first, AGAIN, and the path Git Bash made of a /compact), /compact itself, then the checkpoint.
    expect(u.userMessages).toBe(3)
    expect(u.requests).toBe(6)
    expect(u.compactions).toEqual([{ timestamp: '2026-11-07T11:47:44Z', trigger: 'manual', preTokens: 8163 + 36, postTokens: 820, lastInputTokens: 8163, lastOutputTokens: 36 }])
    expect(u.contextTokens).toBe(820)
    expect(u.lastPrompt).toBe('C:/Program Files/Git/compact')
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

  it('finds a conversation in the profile that has it, its full transcript', async () => {
    expect(await profileOf(root, TOOLS)).toEqual({ profile, transcript: join(logs, 'transcript_full.jsonl') })
    expect(await transcriptIn(root, profile, TOOLS)).toBe(join(logs, 'transcript_full.jsonl'))
    expect(await transcriptIn(root, profile, '../x')).toBeNull()
    expect(await antigravity.transcriptPath('C:\\work\\proj', 'not-an-id')).toBeNull()
  })

  it("its title is agy's, read without waiting only once learnt: never a file read on the caller's thread", async () => {
    // Not learnt yet: none now, looked up meanwhile, there next time.
    expect(knownTitle(TOOLS)).toBeUndefined()
    expect(antigravity.usageTitle(TOOLS)).toBeNull()
    await until(() => knownTitle(TOOLS) !== undefined, HUNG_MS)
    expect(antigravity.usageTitle(TOOLS)).toBe('Tool Listing and Execution Task')
    expect(antigravity.parseUsage(fixture('mcp-tools-1.5.0.jsonl'), TOOLS).title).toBe('Tool Listing and Execution Task')
    // Finding its transcript learns it too.
    expect(await antigravity.transcriptPath('C:\\work\\proj', TOOLS)).toBe(join(logs, 'transcript_full.jsonl'))
    expect(await learnTitle(root, profile, PLAIN)).toBeNull()
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

  it("can't put a transcript back for a resume: agy resumes from its own store, and without it the resume is refused, saying so", async () => {
    expect(antigravity.restorePath()).toBeNull()
    // The agent's own conversation: its brain folder and transcript kept, its store (conversations\<id>.db) gone.
    const agent = 'a-store001'
    const own = profileFolder(agent, 'C:\\ws')
    const kept = join(own, '.gemini', 'antigravity-cli', 'brain', TOOLS, '.system_generated', 'logs')
    mkdirSync(kept, { recursive: true })
    writeFileSync(join(kept, 'transcript_full.jsonl'), fixture('mcp-tools-1.5.0.jsonl'))
    expect(await antigravity.ownsConversation(agent, 'C:\\ws', TOOLS)).toBe(true)
    expect(await antigravity.hasConversationStore(agent, 'C:\\ws', TOOLS)).toBe(false)
    const ctx = { resume: true, sessionId: TOOLS, agentId: agent, workspacePath: 'C:\\ws', cwd: join(base, 'resume-cwd'), extraDirs: [], mcpServers: {}, privateDir: join(base, 'resume-private'), overrides: {} }
    mkdirSync(ctx.cwd, { recursive: true })
    await expect(antigravity.prepareLaunch(ctx as never)).rejects.toThrow(/no longer has that conversation/)
    // With its store, it isn't refused for that.
    mkdirSync(join(own, '.gemini', 'antigravity-cli', 'conversations'), { recursive: true })
    writeFileSync(join(own, '.gemini', 'antigravity-cli', 'conversations', `${TOOLS}.db`), '')
    expect(await antigravity.hasConversationStore(agent, 'C:\\ws', TOOLS)).toBe(true)
  })
})

describe("agy's status line", () => {
  it('gives the model by its name, its effort and the context window (1.5.0, recorded)', () => {
    const lines = readFileSync(join(__dirname, 'fixtures', 'advanced', 'statusline-antigravity-1.5.0.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l))
    expect(antigravity.statusLine(lines[0])).toEqual({})
    expect(antigravity.statusLine(lines[1])).toEqual({ modelName: 'Gemini 3.8 Flash (Low)', effort: 'low', contextWindow: 1048576 })
  })
})

describe("agy 1.5.0's tools, resume, compaction, image and subagent (HI-2546's runs)", () => {
  const kinds = (p: { items: { kind: string }[] }) => p.items.map((i) => i.kind)

  it("shows file tools by their path, a command by agy's own summary, refused; a resume's notice; /compact as a command, then its compaction", () => {
    const p = items(fixture('tools-resume-compact-1.5.0.jsonl'), 'C:\\work')
    expect(kinds(p)).toEqual(['user', 'tool', 'tool', 'tool', 'user', 'notice', 'assistant', 'user', 'notice', 'assistant', 'command', 'notice', 'compaction'])
    const tools = p.items.flatMap((i) => (i.kind === 'tool' ? [i.tool] : []))
    expect(tools.map((t) => [t.toolUseId, t.name, t.summary, t.isError])).toEqual([
      ['2', 'read_file', 'notes.txt', false],
      ['4', 'edit_file', 'notes.txt', false],
      ['6', 'run_command', 'Echo probe-done', true]
    ])
    expect(tools[0].result).toBe('Showing lines 1-1 of 1\n1: apple banana')
    expect(tools[2].result).toMatch(/^permission check failed for unsandboxed "echo probe-done"/)
    expect(tools[2].input).toBe('CommandLine: echo probe-done\nWaitMsBeforeAsync: 5000')
    expect(p.items[5]).toMatchObject({ kind: 'notice', level: 'info', text: expect.stringMatching(/^\[Notice\] All your subagents/) })
    expect(p.items[10]).toMatchObject({ kind: 'command', name: '/compact', args: '' })
    expect(p.items[12]).toMatchObject({ kind: 'compaction', trigger: 'manual', preTokens: 8163 + 36, postTokens: 820, summary: expect.stringMatching(/^# Resuming from a compaction/) })
  })

  it("shows the image a tool read, from that conversation's own media file in a Combwork profile, never another file", async () => {
    const text = fixture('image-1.5.0.jsonl')
    const p = items(text)
    const tool = p.items.flatMap((i) => (i.kind === 'tool' ? [i.tool] : []))[0]
    expect(tool.images).toEqual([{ id: 0, path: null }])
    expect(p.images).toHaveLength(1)
    // The line the location names, its media entry put in a profile of this test's.
    const conv = 'b6078cac-11ea-44a7-a86d-584af6b5b6ce'
    const logs = join(profilesRoot(), 'agent-img', '.gemini', 'antigravity-cli', 'brain', conv, '.system_generated', 'logs')
    const media = join(logs, 'media')
    mkdirSync(media, { recursive: true })
    const transcript = join(logs, 'transcript_full.jsonl')
    writeFileSync(transcript, text)
    const png = readFileSync(join(FIX, 'image-1.5.0-media.png'))
    writeFileSync(join(media, 'step_2_media_0.png'), png)
    const loc = p.images[0]
    const line = JSON.parse(Buffer.from(text).subarray(loc.offset, loc.offset + loc.length).toString('utf8'))
    expect(line.step_index).toBe(2)
    const here = (uri: string) => ({ ...line, media: [{ ...line.media[0], uri }] })
    const own = pathToFileURL(join(media, 'step_2_media_0.png')).href
    expect(await antigravity.imageData(here(own), loc, transcript)).toBe(`data:image/png;base64,${png.toString('base64')}`)
    // Outside the profiles, outside logs\media, or not an image: none.
    writeFileSync(join(base, 'elsewhere.png'), 'x')
    expect(await antigravity.imageData(here(pathToFileURL(join(base, 'elsewhere.png')).href), loc, transcript)).toBeNull()
    expect(await antigravity.imageData(here(own.replace('/media/', '/')), loc, transcript)).toBeNull()
    expect(await antigravity.imageData({ media: [{ mime_type: 'text/plain', uri: own }] }, loc, transcript)).toBeNull()
    // Another conversation's media (even in the same profile), or a transcript that isn't one of Combwork's: none.
    const otherLogs = join(profilesRoot(), 'agent-img', '.gemini', 'antigravity-cli', 'brain', PLAIN, '.system_generated', 'logs')
    mkdirSync(join(otherLogs, 'media'), { recursive: true })
    writeFileSync(join(otherLogs, 'media', 'x.png'), png)
    writeFileSync(join(otherLogs, 'transcript_full.jsonl'), fixture('plain-1.5.0.jsonl'))
    expect(await antigravity.imageData(here(pathToFileURL(join(otherLogs, 'media', 'x.png')).href), loc, transcript)).toBeNull()
    expect(await antigravity.imageData(here(own), loc, join(base, 'elsewhere.png'))).toBeNull()
    // Larger than the bound: never read past it.
    expect(await mediaData(here(own).media[0], transcript, profilesRoot(), png.length - 1)).toBeNull()
    expect(await mediaData(here(own).media[0], transcript, profilesRoot(), png.length)).toMatch(/^data:image\/png;base64,/)
  })

  it('follows no link or junction out of the profiles: a logs, media or profile folder that points elsewhere is refused', async () => {
    // A folder outside the profiles with a transcript and an image in it, reached through junctions inside a profile.
    const outside = join(base, 'outside-target')
    mkdirSync(join(outside, 'media'), { recursive: true })
    writeFileSync(join(outside, 'transcript_full.jsonl'), fixture('plain-1.5.0.jsonl'))
    writeFileSync(join(outside, 'media', 'x.png'), readFileSync(join(FIX, 'image-1.5.0-media.png')))
    const sys = join(profilesRoot(), 'agent-link', '.gemini', 'antigravity-cli', 'brain', PLAIN, '.system_generated')
    mkdirSync(sys, { recursive: true })
    symlinkSync(outside, join(sys, 'logs'), 'junction')
    const viaLink = join(sys, 'logs', 'transcript_full.jsonl')
    expect(profileTranscript(viaLink, profilesRoot(), PLAIN)).toBe(true)
    expect(await trustedTranscript(viaLink, profilesRoot(), PLAIN)).toBeNull()
    expect(await antigravity.transcriptPath('C:\\work', PLAIN, viaLink)).not.toBe(viaLink)
    // Its media folder a junction, in a conversation whose transcript is real.
    const logs2 = join(profilesRoot(), 'agent-link', '.gemini', 'antigravity-cli', 'brain', TOOLS, '.system_generated', 'logs')
    mkdirSync(logs2, { recursive: true })
    writeFileSync(join(logs2, 'transcript_full.jsonl'), fixture('mcp-tools-1.5.0.jsonl'))
    symlinkSync(join(outside, 'media'), join(logs2, 'media'), 'junction')
    expect(await mediaData({ mime_type: 'image/png', uri: pathToFileURL(join(logs2, 'media', 'x.png')).href }, join(logs2, 'transcript_full.jsonl'), profilesRoot())).toBeNull()
    // A whole profile that is a junction to elsewhere.
    const elsewhere = join(base, 'elsewhere-profile')
    mkdirSync(join(elsewhere, '.gemini', 'antigravity-cli', 'brain', PLAIN, '.system_generated', 'logs'), { recursive: true })
    writeFileSync(join(elsewhere, '.gemini', 'antigravity-cli', 'brain', PLAIN, '.system_generated', 'logs', 'transcript_full.jsonl'), fixture('plain-1.5.0.jsonl'))
    symlinkSync(elsewhere, join(profilesRoot(), 'agent-junction'), 'junction')
    expect(await trustedTranscript(join(profilesRoot(), 'agent-junction', '.gemini', 'antigravity-cli', 'brain', PLAIN, '.system_generated', 'logs', 'transcript_full.jsonl'), profilesRoot(), PLAIN)).toBeNull()
  })

  it("a subagent is a conversation of its own: its parent's task is its prompt, its answer a note in the parent's", async () => {
    const child = items(fixture('subagent-child-1.5.0.jsonl'))
    expect(child.items[0]).toMatchObject({ kind: 'user', text: 'What is 2+2? Reply with just the answer.' })
    expect(child.items.flatMap((i) => (i.kind === 'tool' ? [[i.tool.name, i.tool.summary]] : []))).toEqual([['send_message', '4']])
    const parent = items(fixture('subagent-parent-1.5.0.jsonl'))
    const tools = parent.items.flatMap((i) => (i.kind === 'tool' ? [i.tool] : []))
    expect(tools.map((t) => [t.name, t.summary])).toEqual([
      ['invoke_subagent', 'What is 2+2? Reply with just the answer.'],
      ['read_file', expect.stringMatching(/transcript\.jsonl$/)],
      ['manage_subagents', 'list']
    ])
    expect(parent.items.at(-2)).toMatchObject({ kind: 'notice', level: 'info', from: 'task', text: '4' })
    expect(parent.items.at(-1)).toMatchObject({ kind: 'assistant', text: '4' })
    // Its parent, from its first step; the parent's own first step names none.
    const dir = join(base, 'subs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'child.jsonl'), fixture('subagent-child-1.5.0.jsonl'))
    writeFileSync(join(dir, 'parent.jsonl'), fixture('subagent-parent-1.5.0.jsonl'))
    expect(await antigravity.subSessionOf(join(dir, 'child.jsonl'), 'ded852d1-0c96-4f30-bf60-bc1a470ed6c8')).toEqual({ parentId: 'f57ee6fa-3d66-4a22-b458-764656e4d25d', kind: 'subagent' })
    expect(await antigravity.subSessionOf(join(dir, 'parent.jsonl'), 'f57ee6fa-3d66-4a22-b458-764656e4d25d')).toBeNull()
    // Its usage is its own, never its parent's.
    expect(parseAgyTranscript(fixture('subagent-parent-1.5.0.jsonl'), 'f57ee6fa-3d66-4a22-b458-764656e4d25d')).toMatchObject({ requests: 4, cacheReadTokens: 0, userMessages: 1 })
  })
})
