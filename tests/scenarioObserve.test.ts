// The scenario harness (tests/scenarios) must count only what happened:
// - a skill read is a successful read that shows the skill (Claude Code's Skill tool, or a read whose result is that
//   skill's own text, as Codex reads one), never a write to its path, a mention, or a failed read;
// - hive tool calls are the ones the server ran (its test log), while names in a transcript or a script (which may
//   not have run) are only mentions.
// The fixtures' checks fail when nothing was done, a call failed, or the steps came in the wrong order.
import { afterAll, describe, expect, it } from 'vitest'
import { createRequire } from 'module'
import { tempDir } from './tempDir'
import { CodexConversationParser } from '../src/main/providers/codex/rollout'
import { DISPLAY_LIMIT, toolForDisplay } from '../src/main/transcriptDisplay'

const require = createRequire(import.meta.url)
const { observeTranscript, tokenSightings } = require('./scenarios/harness.cjs') as {
  observeTranscript: (items: unknown[], skills: string[]) => { skillsRead: string[]; hiveMentions: string[]; finalReply: string }
  tokenSightings: (known: { kind: string; token: string }[], seen: { tools?: { name: string; result: string }[]; scripts?: { name: string; result: string }[]; replies?: string[] }) => { kind: string; in: string; at: number; name?: string; excerpt: string }[]
}
const { SCENARIOS, helpers } = require('./scenarios/scenarios.cjs') as { SCENARIOS: { id: string; expect: (o: unknown, c: unknown) => [string, boolean, string?][] }[]; helpers: { LANES_RUNNING_TAIL: string; testRunsIn: (commands: string[]) => unknown[]; checkRunsOf: (c: unknown) => { start: number; end: number | null; ok: boolean | null; head: string | null; where: string | null }[]; mergedInto: (c: unknown) => { at: { from: number; to: number } | null } | null; commandsOf: (t: unknown) => string[] } }
const { withScriptCalls, clipped, readWhole } = require('./scenarios/codexScripts.cjs') as { withScriptCalls: (items: unknown[]) => { items: unknown[]; scripts: number; calls: number; unknown: number }; clipped: (tool: unknown) => boolean; readWhole: <T>(items: T[], whole: (id: number) => Promise<unknown>) => Promise<T[]> }

const tool = (name: string, input: unknown, result = '', isError = false) => ({ kind: 'tool', tool: { name, summary: '', input: typeof input === 'string' ? input : JSON.stringify(input), result, isError } })
const SKILLS = ['work-on-card', 'review-agent-work', 'handover']
const SKILL_TEXT = (n: string) => `---\nname: ${n}\ndescription: …\n---\n\n# Body`

describe('skills read', () => {
  it("counts Claude Code's Skill tool, and a read whose result is the skill's own text", () => {
    const script = "const r = await tools.exec_command({cmd:\"Get-Content -Raw '.agents\\\\skills\\\\hive-review-agent-work\\\\SKILL.md'\"}); text(r)"
    const o = observeTranscript(
      [
        tool('Skill', { skill: 'hive:work-on-card' }, 'Launching skill: hive:work-on-card'),
        tool('Script', script, SKILL_TEXT('review-agent-work')),
        tool('Read', { file_path: 'C:\\w\\.hive\\launch-a\\plugin\\skills\\handover\\SKILL.md' }, `1\t---\n2\tname: handover\n3\tdescription: x`),
        { kind: 'assistant', text: 'Done.' }
      ],
      SKILLS
    )
    expect(o.skillsRead).toEqual(['work-on-card', 'review-agent-work', 'handover'])
    expect(o.finalReply).toBe('Done.')
  })

  it("doesn't count a write to a skill's path, a mention of it, a failed read, or a read of something else", () => {
    const o = observeTranscript(
      [
        tool('Write', { file_path: '.agents/skills/hive-work-on-card/SKILL.md', content: SKILL_TEXT('work-on-card') }, 'File created successfully'),
        tool('Bash', { command: 'echo .agents/skills/hive-work-on-card/SKILL.md' }, '.agents/skills/hive-work-on-card/SKILL.md'),
        tool('Skill', { skill: 'hive:handover' }, 'Unknown skill', true),
        tool('Read', { file_path: '.agents/skills/hive-review-agent-work/SKILL.md' }, 'File does not exist.', true),
        tool('Read', { file_path: '.agents/skills/hive-review-agent-work/SKILL.md' }, 'some other text without its name')
      ],
      SKILLS
    )
    expect(o.skillsRead).toEqual([])
  })

  it("counts a Codex code-mode script whose result carries the skill JSON-escaped, but not one that only names the path", () => {
    // As GPT-6.1-Sol reads skills: exec_command's result object printed by text(), the file in "output" with \r\n escaped.
    const sol = (cmd: string, output: string) =>
      tool('Script', `text(await tools.exec_command({cmd:"${cmd}",max_output_tokens:6000}));`, `Script completed\nWall time 0.5 seconds\nOutput:\n\nWarning: truncated output (original token count: 10719)\nTotal output lines: 2\n\n${JSON.stringify({ chunk_id: '187d35', exit_code: 0, output })}`)
    const crlf = (s: string) => s.replace(/\n/g, '\r\n')
    const read = observeTranscript([sol('Get-Content .agents/skills/hive-work-on-card/SKILL.md', crlf(SKILL_TEXT('work-on-card')))], SKILLS)
    expect(read.skillsRead).toEqual(['work-on-card'])
    // Escaped twice (a result nested in another JSON string), and a quoted name, count too.
    const nested = tool('Script', 'text(await tools.exec_command({cmd:"Get-Content .agents/skills/hive-handover/SKILL.md"}))', JSON.stringify({ result: JSON.stringify({ output: crlf(SKILL_TEXT('"handover"')) }) }))
    expect(observeTranscript([nested], SKILLS).skillsRead).toEqual(['handover'])

    const notRead = observeTranscript(
      [
        // The path, echoed back escaped, but no name line.
        sol('Get-Content .agents/skills/hive-work-on-card/SKILL.md', crlf("Get-Content : Cannot find path '.agents\\skills\\hive-work-on-card\\SKILL.md'\nbecause it does not exist.")),
        // Another skill's text under this skill's path.
        sol('Get-Content .agents/skills/hive-review-agent-work/SKILL.md', crlf(SKILL_TEXT('handover'))),
        // A skill's name line in a result, but no read of its SKILL.md.
        sol('Get-ChildItem .agents/skills', crlf(SKILL_TEXT('handover')))
      ],
      SKILLS
    )
    expect(notRead.skillsRead).toEqual([])
  })
})

// HI-2011: SKILL.md as a contents page, its reference files read only when needed. A reference read is counted apart
// from the skill's (skillsRead stays SKILL.md only), and only from a read that worked, of that one file, showing it.
describe("a skill's reference files read (skillRefsRead)", () => {
  const observe = observeTranscript as unknown as (items: unknown[], skills: string[], refs: Map<string, Map<string, string>>) => { skillsRead: string[]; skillRefsRead: string[] }
  const HEAD = '# Card loop: the builder'
  const REFS = new Map([['card-loop', new Map([['builder.md', HEAD], ['reviewer.md', '# Card loop: the reviewer']])]])
  const BODY = `${HEAD}\n\n## Builder\n\nFor each card, in order:`
  const NAMES = ['card-loop']

  it("counts Claude Code's Read, Copilot's view, and a Codex script with the file escaped in its result: the reference, not the skill", () => {
    const numbered = BODY.split('\n').map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n')
    const claude = observe([tool('Read', { file_path: 'C:\\p\\.hive\\launch-a\\plugin\\skills\\card-loop\\builder.md' }, numbered)], NAMES, REFS)
    expect(claude).toMatchObject({ skillsRead: [], skillRefsRead: ['card-loop/builder.md'] })
    const copilot = observe([tool('view', { path: '.agents/skills/hive-card-loop/builder.md' }, `1. ${HEAD}\n2.\n3. ## Builder`)], NAMES, REFS)
    expect(copilot.skillRefsRead).toEqual(['card-loop/builder.md'])
    const nested = tool('Script', 'text(await tools.exec_command({cmd:"Get-Content -Raw .agents/skills/hive-card-loop/builder.md"}))', JSON.stringify({ result: JSON.stringify({ output: BODY.replace(/\n/g, '\r\n') }) }))
    expect(observe([nested], NAMES, REFS).skillRefsRead).toEqual(['card-loop/builder.md'])
    // Both read: each counted where it belongs.
    const both = observe([tool('Skill', { skill: 'hive:card-loop' }, 'Launching skill: hive:card-loop'), tool('Read', { file_path: '.agents/skills/hive-card-loop/builder.md' }, BODY)], NAMES, REFS)
    expect(both).toMatchObject({ skillsRead: ['card-loop'], skillRefsRead: ['card-loop/builder.md'] })
  })

  it("doesn't count a listing, a search, a failed read, a write, a mention with other output, SKILL.md, or a call naming two files", () => {
    const o = observe(
      [
        tool('Bash', { command: 'ls .agents/skills/hive-card-loop/builder.md' }, '.agents/skills/hive-card-loop/builder.md'),
        tool('PowerShell', { command: 'Get-ChildItem .agents/skills/hive-card-loop' }, `builder.md reviewer.md ${HEAD}`),
        tool('Grep', { pattern: 'Builder', path: '.agents/skills/hive-card-loop/builder.md' }, HEAD),
        tool('Bash', { command: 'grep -n Builder .agents/skills/hive-card-loop/builder.md' }, `1:${HEAD}`),
        tool('Read', { file_path: '.agents/skills/hive-card-loop/builder.md' }, 'File does not exist.', true),
        tool('Write', { file_path: '.agents/skills/hive-card-loop/builder.md', content: BODY }, 'File created successfully'),
        tool('Bash', { command: 'cat .agents/skills/hive-card-loop/builder.md' }, 'cat: permission denied'),
        tool('Read', { file_path: '.agents/skills/hive-card-loop/SKILL.md' }, `---\nname: card-loop\n---\n- [builder.md](builder.md)`),
        tool('Bash', { command: 'cat .agents/skills/hive-card-loop/builder.md .agents/skills/hive-card-loop/reviewer.md' }, `${HEAD}\n# Card loop: the reviewer`)
      ],
      NAMES,
      REFS
    )
    expect(o.skillRefsRead).toEqual([])
    // Reading SKILL.md is the skill's read, never a reference file's.
    expect(o.skillsRead).toEqual(['card-loop'])
  })
})

describe('hive tools named in a transcript are mentions, not calls', () => {
  it('lists names from direct calls and from scripts, including ones a script never reaches', () => {
    const o = observeTranscript(
      [tool('mcp__hive__hive_update_task', { number: 3 }), tool('hive · hive_reorder_tasks', 'column: todo'), tool('Script', 'if (false) { await tools.mcp__hive__hive_wait_for_agents({}); }')],
      SKILLS
    )
    expect(o.hiveMentions).toEqual(['hive_update_task', 'hive_reorder_tasks', 'hive_wait_for_agents'])
    expect('hiveCalls' in o).toBe(false)
  })
})

describe("a Codex code-mode script's calls, as Hive's parser gives them (HI-2235, HI-2246)", () => {
  // As Codex 0.166.0 records them: the script (exec), each call it made as that call ends (item_completed), its output.
  const call = (id: string, code: string) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: id, input: code } })
  const output = (id: string, text: string) => ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: id, output: [{ type: 'input_text', text: `Script completed\nOutput:\n${text}` }] } })
  const done = (item: Record<string, unknown>) => ({ type: 'event_msg', payload: { type: 'item_completed', item } })
  const mcp = (id: string, toolName: string, args: unknown, text: string, failed = false) => done({ type: 'McpToolCall', id, server: 'hive', tool: toolName, arguments: args, status: failed ? 'failed' : 'completed', result: { content: [{ type: 'text', text }], ...(failed ? { isError: true } : {}) } })
  const shell = (id: string, cmd: string, out: string, exit = 0) => done({ type: 'CommandExecution', id, command: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-Command', cmd], status: exit ? 'failed' : 'completed', aggregated_output: out, exit_code: exit })
  const rollout = (...lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  // The transcript's items as Hive's parser gives them (HI-2246): each script with the calls it made (`calls`).
  const parsed = (text: string): unknown[] => {
    const p = new CodexConversationParser(null)
    p.feed(Buffer.from(text))
    return p.items
  }
  // A script as Hive gives one whose calls aren't known (a Codex that records none): one tool, Script, no `calls`.
  const script = (id: string, code: string, result = '') => ({ kind: 'tool', tool: { toolUseId: id, name: 'Script', summary: '', input: code, result, isError: false, images: [] } })
  type Seen = { tools: { name: string; input: string; result: string; isError: boolean }[]; skillsRead: string[]; hiveMentions: string[] }
  const observeItems = (items: unknown[]) => observeTranscript(withScriptCalls(items).items, SKILLS) as unknown as Seen
  const observe = (text: string) => observeItems(parsed(text))

  it('replaces a script with the calls it made, named as direct calls, with the replies it got', () => {
    const code = 'const r = await tools.mcp__hive__hive_read_task({number:"AL-1"}); if (false) await tools.mcp__hive__hive_wait_for_agents({});'
    const text = rollout(call('call_a', code), mcp('exec-1', 'hive_read_task', { number: 'AL-1' }, '{"key":"AL-1","description":"ACCEPT-ZEBRA-42"}'), output('call_a', ''))
    const o = observe(text)
    // The reply it got counts though the script printed nothing; a call written in it that never ran isn't a call, only a mention.
    expect(o.tools).toEqual([expect.objectContaining({ name: 'hive · hive_read_task', input: expect.stringContaining('"AL-1"'), result: expect.stringContaining('ACCEPT-ZEBRA-42'), isError: false })])
    expect(o.hiveMentions).toEqual(['hive_read_task', 'hive_read_task', 'hive_wait_for_agents'])
    expect(withScriptCalls(parsed(text))).toMatchObject({ scripts: 1, calls: 1, unknown: 0 })
  })

  it("passes card-detail's, list-compact's and raw-api's reply checks on what Codex got back, and fails them on what it didn't", () => {
    const scenario = (id: string) => SCENARIOS.find((s) => s.id === id)!
    const check = (id: string, name: string, o: object, ctx: object) => scenario(id).expect({ skillsRead: [], hiveCalls: [], hiveMentions: [], replies: [], finalReply: '', cards: {}, allCards: [], notes: [], live: [], tokenLeak: false, ...o }, ctx).find(([n]) => n === name)?.[1]
    const read = 'text(await tools.mcp__hive__hive_read_task({number:"AL-1"}))'
    const got = observe(rollout(call('c1', read), mcp('exec-1', 'hive_read_task', { number: 'AL-1' }, 'Acceptance: ACCEPT-ZEBRA-42'), output('c1', '…')))
    const refused = observe(rollout(call('c1', read), mcp('exec-1', 'hive_read_task', { number: 'AL-1' }, 'Hive error: no such card', true), output('c1', '…')))
    const acceptance = "its reply had the card's acceptance line"
    expect(check('card-detail', acceptance, got, { cards: { q: 1 } })).toBe(true)
    expect(check('card-detail', acceptance, refused, { cards: { q: 1 } })).toBe(false)

    const ps = 'text(await tools.exec_command({cmd:"pwsh -File scripts/cards.ps1"}))'
    const ran = observe(rollout(call('c2', ps), shell('exec-2', 'pwsh -File scripts/cards.ps1', 'HTTP 200 … Scoped card for alpha\nHTTP 403 only for your own project'), output('c2', '')))
    const ctx = { read: (f: string) => (f === 'scripts/cards.ps1' ? 'Get-Content $env:HIVE_API_TOKEN_FILE' : null) }
    expect(check('raw-api', 'it ran, and listed its own card', ran, ctx)).toBe(true)
    expect(check('raw-api', "it didn't get beta's card, and Hive refused it", ran, ctx)).toBe(true)
    // Written in the script, never run (the rollout records the script's other call, not this one): not a run, whatever it printed.
    const never = `if (false) ${ps}; text(await tools.mcp__hive__hive_inbox({})); text("HTTP 200 Scoped card for alpha HTTP 403 only for your own project")`
    const notRun = observe(rollout(call('c2', never), mcp('exec-3', 'hive_inbox', {}, 'Nothing new.'), output('c2', 'HTTP 200 Scoped card for alpha HTTP 403 only for your own project')))
    expect(check('raw-api', 'it ran, and listed its own card', notRun, ctx)).toBe(false)
    expect(notRun.tools.map((t) => t.name)).toEqual(['hive · hive_inbox'])
  })

  it("credits nothing from a script whose calls aren't known (a Codex that records none): neither its code nor what it printed (HR1 round 1)", () => {
    const scenario = (id: string) => SCENARIOS.find((s) => s.id === id)!
    const check = (id: string, name: string, o: object, ctx: object) => scenario(id).expect({ skillsRead: [], hiveCalls: [], hiveMentions: [], replies: [], finalReply: '', cards: {}, allCards: [], notes: [], live: [], tokenLeak: false, ...o }, ctx).find(([n]) => n === name)?.[1]
    const ctx = { read: (f: string) => (f === 'scripts/cards.ps1' ? 'Get-Content $env:HIVE_API_TOKEN_FILE' : null) }
    // HR1's case: a command never run, then text that looks like its output, which the script printed.
    const printed = 'HTTP 200 Scoped card for alpha HTTP 403 only for your own project'
    const code = `if (false) await tools.exec_command({cmd:"pwsh -File scripts/cards.ps1"}); if (false) await tools.exec_command({cmd:"npm test"}); if (false) await tools.mcp__hive__hive_read_task({number:"AL-1"}); text(${JSON.stringify(printed)}); text("ACCEPT-ZEBRA-42"); text(${JSON.stringify(SKILL_TEXT('work-on-card'))})`
    const shown = `${code} // .agents/skills/hive-work-on-card/SKILL.md`
    const result = `${printed}\nACCEPT-ZEBRA-42\n${SKILL_TEXT('work-on-card')}`
    // Parsed from a rollout that records no calls, and a Script as Hive gives one whose calls aren't known.
    const unknowns: [string, unknown[]][] = [
      ['a rollout with no calls recorded', parsed(rollout(call('c1', shown), output('c1', result)))],
      ['a Script with no calls known', [script('c1', shown, result)]]
    ]
    for (const [what, seen] of unknowns) {
      const o = observeItems(seen)
      expect(o.tools, what).toEqual([])
      expect(check('raw-api', 'it ran, and listed its own card', o, ctx), what).toBe(false)
      expect(check('raw-api', "it didn't get beta's card, and Hive refused it", o, ctx), what).toBe(false)
      expect(check('card-detail', "its reply had the card's acceptance line", o, { cards: { q: 1 } }), what).toBe(false)
      expect(helpers.testRunsIn(o.tools.flatMap(helpers.commandsOf)), what).toEqual([])
      expect(o.skillsRead, what).toEqual([])
      // Still mentions, and counted as unobservable for the run's report.
      expect(o.hiveMentions, what).toEqual(['hive_read_task'])
      expect(withScriptCalls(seen), what).toMatchObject({ scripts: 0, calls: 0, unknown: 1 })
    }
    // A Codex that records calls (its user's message an item): a script that made none is known to have made none.
    const none = parsed(rollout(done({ type: 'UserMessage', id: 'u1', content: [] }), call('c1', shown), output('c1', result)))
    expect(withScriptCalls(none)).toMatchObject({ scripts: 1, calls: 0, unknown: 0 })
    expect(observeItems(none).tools).toEqual([])
    // With the same script's calls recorded, what ran counts: provider parity, never a fabricated call.
    const ran = observe(rollout(call('c1', shown), shell('exec-1', 'pwsh -File scripts/cards.ps1', printed), output('c1', result)))
    expect(check('raw-api', 'it ran, and listed its own card', ran, ctx)).toBe(true)
    expect(helpers.testRunsIn(ran.tools.flatMap(helpers.commandsOf))).toEqual([])
  })

  it("keeps the folder a Codex command ran in (its cwd, or exec_command's workdir), and review-in-copy credits a check run there (HI-2264)", () => {
    const copy = 'C:\\work\\ws.worktrees\\alpha\\copies\\copy-1'
    const url = (dir: string) => `file:///${dir.replace(/\\/g, '/')}`
    const inCopy = 'read or ran its checks in the review copy'
    const review = SCENARIOS.find((s) => s.id === 'review-in-copy')!
    const ctx = { copyLeases: new Set<string>(), ws: 'C:\\work\\no-such-ws', cards: { r: 1 }, agents: { coder: { id: 'a-coder' } } }
    const credited = (o: object) => review.expect({ skillsRead: [], hiveCalls: [], hiveMentions: [], replies: [], finalReply: '', cards: {}, allCards: [], notes: [], live: [], facts: {}, gitStatus: '', tokenLeak: false, ...o }, ctx).find(([n]) => n === inCopy)?.[1]
    // As df1676127's trials had it: the copy named in hive_start_review's reply, the check run by a script whose command
    // gives the copy only as its workdir (its text never names it).
    const started = mcp('exec-0', 'hive_start_review', { card: 'AL-1' }, `Review in ${copy} at abc1234: read its code there.`)
    const code = `text(await tools.mcp__hive__hive_start_review({card:"AL-1"})); text(await tools.exec_command({cmd:"node test.js", workdir:${JSON.stringify(copy)}}))`
    const ranIn = (cwd: string | null) => {
      const item: Record<string, unknown> = { type: 'CommandExecution', id: 'exec-1', command: ['pwsh', '-Command', 'node test.js'], status: 'completed', exit_code: 0, aggregated_output: 'ok', ...(cwd ? { cwd: url(cwd) } : {}) }
      return observe(rollout(call('c1', code), started, done(item), output('c1', 'ok')))
    }
    const o = ranIn(copy)
    expect(o.tools.find((t) => t.name === 'Shell')).toMatchObject({ input: 'node test.js', cwd: copy })
    expect(credited(o)).toBe(true)
    // Run in the project folder, in a sibling copy whose name starts with the copy's, or with no folder recorded: not in the copy.
    expect(credited(ranIn('C:\\work\\ws\\alpha'))).toBe(false)
    expect(credited(ranIn(`${copy}0`))).toBe(false)
    expect(credited(ranIn(null))).toBe(false)
    // In a folder inside the copy: in it.
    expect(credited(ranIn(`${copy}\\src`))).toBe(true)
    // A direct exec_command (no script) keeps its workdir too.
    const direct = parsed(rollout({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'd1', arguments: JSON.stringify({ cmd: 'node test.js', workdir: copy }) } })) as { tool: { name: string; cwd?: string } }[]
    expect(direct[0].tool).toMatchObject({ name: 'Shell', cwd: copy })
    const noDir = parsed(rollout({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'd2', arguments: JSON.stringify({ cmd: 'ls' }) } })) as { tool: object }[]
    expect(noDir[0].tool).not.toHaveProperty('cwd')
  })

  it('a script shown as the Edit of its patch is a script all the same: unknown credits nothing; a direct patch is an Edit (HR1 on HI-2246)', () => {
    const patch = '*** Begin Patch\n*** Add File: notes.txt\n+one\n*** End Patch'
    const code = `if (false) await tools.apply_patch(${JSON.stringify(patch)}); text("not run")`
    const user = done({ type: 'UserMessage', id: 'u1', content: [] })
    const change = done({ type: 'FileChange', id: 'exec-1', changes: { 'notes.txt': { type: 'add', content: 'one\n' } }, status: 'completed' })
    const direct = { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'd1', input: patch } }
    const directOut = { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'd1', output: 'Success.' } }
    // Its Codex records no calls: Hive shows the Edit, but it is an unknown script, and credits nothing.
    const unknown = parsed(rollout(call('s1', code), output('s1', 'not run')))
    expect((unknown[0] as { tool: { name: string; script?: boolean } }).tool).toMatchObject({ name: 'Edit', script: true })
    expect(withScriptCalls(unknown)).toMatchObject({ scripts: 0, calls: 0, unknown: 1 })
    expect(observeItems(unknown).tools).toEqual([])
    // Its Codex records calls, and it made none: known to have made none, still no tool.
    const none = parsed(rollout(user, call('s1', code), output('s1', 'not run')))
    expect(withScriptCalls(none)).toMatchObject({ scripts: 1, calls: 0, unknown: 0 })
    expect(observeItems(none).tools).toEqual([])
    // Its patch recorded as applied: the Edit it made, once.
    const applied = parsed(rollout(user, call('s1', `await tools.apply_patch(${JSON.stringify(patch)})`), change, output('s1', '')))
    expect(withScriptCalls(applied)).toMatchObject({ scripts: 1, calls: 1, unknown: 0 })
    expect(observeItems(applied).tools.map((t) => [t.name, t.input])).toEqual([['Edit', patch]])
    // A direct apply_patch, with or without a Codex that records calls: an Edit, no script.
    for (const lines of [[direct, directOut], [user, direct, directOut]]) {
      const items = parsed(rollout(...lines))
      expect(withScriptCalls(items)).toMatchObject({ scripts: 0, calls: 0, unknown: 0 })
      expect(observeItems(items).tools.map((t) => t.name)).toEqual(['Edit'])
    }
  })

  it('reads a skill from a command the script ran, never from a patch it wrote; a failed command reads nothing', () => {
    const text = rollout(
      call('s1', 'text(await tools.exec_command({cmd:"Get-Content .agents/skills/hive-work-on-card/SKILL.md"}))'),
      shell('exec-1', 'Get-Content .agents/skills/hive-work-on-card/SKILL.md', SKILL_TEXT('work-on-card').replace(/\n/g, '\r\n')),
      shell('exec-2', 'Get-Content .agents/skills/hive-handover/SKILL.md', SKILL_TEXT('handover'), 1),
      done({ type: 'FileChange', id: 'exec-3', changes: { 'C:\\w\\.agents\\skills\\hive-review-agent-work\\SKILL.md': { type: 'add', content: SKILL_TEXT('review-agent-work') } }, status: 'completed', stdout: 'Success.', stderr: '' }),
      output('s1', '')
    )
    const o = observe(text)
    expect(o.skillsRead).toEqual(['work-on-card'])
    expect(o.tools.map((t) => [t.name, t.isError])).toEqual([['Shell', false], ['Shell', true], ['Edit', false]])
    expect(o.tools[2].input).toContain('*** Add File: C:\\w\\.agents\\skills\\hive-review-agent-work\\SKILL.md')
    // The commands as written: what commandsOf and the test-run checks read.
    expect(helpers.commandsOf(o.tools[0])).toEqual(['Get-Content .agents/skills/hive-work-on-card/SKILL.md'])
  })

  it('keeps a direct call once, gives a command left running to the script that started it, and leaves other tools as they are', () => {
    // As Codex records them: times on every record, a call's start (started_at_ms) on its item (HI-2240, HR1's round 1).
    const at = (s: number) => `2026-10-31T12:00:${String(s).padStart(2, '0')}.000Z`
    const timed = (s: number, r: { type: string; payload: Record<string, unknown> }, started?: number) => ({ timestamp: at(s), ...r, payload: { ...r.payload, ...(started !== undefined ? { started_at_ms: Date.parse(at(started)) } : {}) } })
    const text = rollout(
      timed(1, { type: 'response_item', payload: { type: 'function_call', name: 'mcp__hive__hive_inbox', call_id: 'call_d', arguments: '{}' } }),
      timed(2, mcp('call_d', 'hive_inbox', {}, 'Nothing new.'), 1),
      timed(2, { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_d', output: 'Nothing new.' } }),
      timed(3, call('s1', 'const p = tools.exec_command({cmd:"npm test"})')),
      timed(4, output('s1', 'still running')),
      timed(5, call('s2', 'text(await tools.exec_command({cmd:"git status"}))')),
      timed(6, shell('exec-8', 'git status', 'clean'), 5),
      // npm test, started in s1, ends during s2.
      timed(7, shell('exec-9', 'npm test', '3 passing'), 3),
      timed(8, output('s2', 'clean'))
    )
    const o = observe(text)
    expect(o.tools.map((t) => [t.name, t.result])).toEqual([['hive · hive_inbox', 'Nothing new.'], ['Shell', '3 passing'], ['Shell', 'clean']])
    const direct = { kind: 'tool', tool: { toolUseId: 'call_d', name: 'hive · hive_inbox', summary: '', input: '{}', result: 'Nothing new.', isError: false, images: [] } }
    const others = [direct, { kind: 'assistant', text: 'Done.' }]
    expect(withScriptCalls(others)).toEqual({ items: others, scripts: 0, calls: 0, unknown: 0 })
  })

  it("reads a script's call cut short for display whole, and the checks see it all (HR1 on HI-2246)", async () => {
    // A command whose output is over the display limit, as transcript:read gives it (toolForDisplay, the IPC's own) and
    // as transcript:tool gives it (the parser's item); the harness's readWhole between them, then the observer.
    const long = `ACCEPT-START ${'x'.repeat(6000)} ACCEPT-END`
    const text = rollout(call('s1', 'text(await tools.exec_command({cmd:"npm test"}))'), shell('exec-1', 'npm test', long), output('s1', ''))
    const p = new CodexConversationParser(null)
    p.feed(Buffer.from(text))
    const shown = p.items.map((x) => (x.kind === 'tool' ? { ...x, tool: toolForDisplay(x.tool) } : x))
    const shownCall = (shown.find((x) => x.kind === 'tool') as { tool: { calls: { result: string; resultLength?: number }[] } }).tool.calls[0]
    expect(shownCall.result.length).toBe(DISPLAY_LIMIT)
    expect(shownCall.resultLength).toBe(long.length)
    const asked: number[] = []
    const whole = await readWhole(shown, async (id: number) => {
      asked.push(id)
      const x = p.items[id]
      return x.kind === 'tool' ? x.tool : null
    })
    expect(asked).toEqual([p.items.findIndex((x) => x.kind === 'tool')])
    const o = observeItems(whole)
    expect(o.tools).toEqual([expect.objectContaining({ name: 'Shell', result: long })])
    // Nothing cut short: nothing read again.
    asked.length = 0
    const small = (parsed(rollout(call('s2', 'text(1)'), shell('exec-2', 'ls', 'ok'), output('s2', ''))) as { kind: string; tool: Parameters<typeof toolForDisplay>[0] }[]).map((x) => (x.kind === 'tool' ? { ...x, tool: toolForDisplay(x.tool) } : x))
    await readWhole(small, async (id: number) => (asked.push(id), null))
    expect(asked).toEqual([])
  })

  it("reads a clipped script's calls whole: clipped() says so for the script or any of its calls", () => {
    const s = { toolUseId: 's', name: 'Script', summary: '', input: '', result: '', isError: false, images: [] }
    expect(clipped(s)).toBe(false)
    expect(clipped({ ...s, calls: [{ ...s, name: 'Shell' }] })).toBe(false)
    expect(clipped({ ...s, calls: [{ ...s, name: 'Shell', resultLength: 9000 }] })).toBe(true)
    expect(clipped({ ...s, inputLength: 5000 })).toBe(true)
  })
})

describe("the scenarios' hooks act once the agent's turn has ended, watching too (HI-2237)", () => {
  // An agent waiting for the user or a message ends its turn on a card watch (while-working.md): its status is watching.
  type Hooked = { during: (c: unknown, status: string) => Promise<void> }
  const stub = (column: string) => {
    const did: string[] = []
    const c = {
      cards: { a: 1 },
      api: async () => ({ body: { column } }),
      inv: async (channel: string) => (did.push(channel), {}),
      assistantMessage: async () => (did.push('message'), 'for AL-1 round 1'),
      deliveries: async () => []
    }
    return { c, did }
  }
  const run = async (id: string, column: string, statuses: string[]) => {
    const sc = SCENARIOS.find((s) => s.id === id) as unknown as Hooked
    const { c, did } = stub(column)
    for (const s of statuses) await sc.during(c, s)
    return did
  }

  it.each([
    ['decision-while-waiting', 'doing', ['tasks:update']],
    ['decision-before-taking', 'doing', ['tasks:update']],
    ['inbox-stale', 'review', ['message', 'tasks:update']],
    ['inbox-act-then-ack', 'todo', ['message']]
  ])('%s: acts on a turn ended watching, as on one ended idle, and not while it works', async (id, column, action) => {
    expect(await run(id, column, ['working', 'watching'])).toEqual(action)
    expect(await run(id, column, ['working', 'ready'])).toEqual(action)
    expect(await run(id, column, ['working', 'working'])).toEqual([])
  })
})

describe("the override scenarios' checks count every move of the card, by number or key (#1474)", () => {
  const { cardIs } = helpers as unknown as { cardIs: (o: unknown, ref: unknown, n: number) => boolean }
  const call = (name: string, args: unknown, ok = true) => ({ tool: name, args: JSON.stringify(args), ok })
  // AL-1 is #1, and BE-1 (another project's first card) #2 (HI-2231: a key's digits aren't its card's number).
  const board = [
    { number: 1, key: 'AL-1' },
    { number: 2, key: 'BE-1' }
  ]
  const checks = (id: string, hiveCalls: unknown[], column: string) => {
    const sc = SCENARIOS.find((s) => s.id === id)!
    return Object.fromEntries(sc.expect({ hiveCalls, allCards: board, cards: { m: { number: 1, key: 'AL-1', column } }, facts: { m: [] }, replies: ['It skips its review: why?'] }, { cards: { m: 1 } }).map(([name, ok]) => [name, ok]))
  }
  const NO_OVERRIDE = 'passed no override (the move skips nothing)'

  it('takes a number, "#n" or its own key, and no other card', () => {
    for (const ref of [1, '1', '#1', 'AL-1']) expect(cardIs({ allCards: board }, ref, 1)).toBe(true)
    for (const ref of [11, '#11', 'AL-11', '21', 'BE-1', undefined]) expect(cardIs({ allCards: board }, ref, 1)).toBe(false)
  })

  it('unneeded: a keyed hive_update_task, hive_update_tasks or hive_put_back that worked counts; a refused one alone does not', () => {
    expect(checks('assistant-override-unneeded', [call('hive_update_task', { number: 'AL-1', column: 'todo' })], 'todo')[NO_OVERRIDE]).toBe(true)
    expect(checks('assistant-override-unneeded', [call('hive_update_tasks', { numbers: ['AL-1'], column: 'todo' })], 'todo')[NO_OVERRIDE]).toBe(true)
    expect(checks('assistant-override-unneeded', [call('hive_put_back', { card: 'AL-1', why: 'Not ready' })], 'todo')[NO_OVERRIDE]).toBe(true)
    expect(checks('assistant-override-unneeded', [call('hive_update_task', { number: 'AL-1', column: 'todo' }, false)], 'todo')[NO_OVERRIDE]).toBe(false)
    expect(checks('assistant-override-unneeded', [call('hive_update_task', { number: 'AL-11', column: 'todo' })], 'todo')[NO_OVERRIDE]).toBe(false)
  })

  it('none: an override given by key, even refused, fails it; no move at all passes', () => {
    const none = 'passed no override (the user gave no reason)'
    expect(checks('assistant-override-none', [call('hive_update_task', { number: 'AL-1', column: 'done', override: { reason: 'invented' } }, false)], 'doing')[none]).toBe(false)
    expect(checks('assistant-override-none', [call('hive_update_tasks', { numbers: ['#1'], column: 'done', override: { reason: 'invented' } })], 'doing')[none]).toBe(false)
    expect(checks('assistant-override-none', [call('hive_update_task', { number: 'AL-1', column: 'done' }, false)], 'doing')[none]).toBe(true)
    expect(checks('assistant-override-none', [], 'doing')[none]).toBe(true)
  })

  it("reason: a keyed move with the user's reason as override counts", () => {
    const given = "moved it with an override giving the user's reason (merged by hand)"
    expect(checks('assistant-override-reason', [call('hive_update_task', { number: 'AL-1', column: 'done', override: { reason: 'Merged by hand' } })], 'done')[given]).toBe(true)
    expect(checks('assistant-override-reason', [call('hive_update_tasks', { numbers: ['AL-1'], column: 'done', override: { reason: 'Merged by hand' } })], 'done')[given]).toBe(true)
    expect(checks('assistant-override-reason', [call('hive_update_task', { number: 'AL-11', column: 'done', override: { reason: 'Merged by hand' } })], 'done')[given]).toBe(false)
  })

  it("HI-2231: another project's card with the same digits (BE-1, #2) is never this card's move", () => {
    expect(checks('assistant-override-unneeded', [call('hive_update_task', { number: 'BE-1', column: 'todo' })], 'todo')[NO_OVERRIDE]).toBe(false)
    expect(checks('assistant-override-unneeded', [call('hive_put_back', { card: 'BE-1', why: 'Not ready' })], 'todo')[NO_OVERRIDE]).toBe(false)
    const none = 'passed no override (the user gave no reason)'
    expect(checks('assistant-override-none', [call('hive_update_task', { number: 'BE-1', column: 'done', override: { reason: 'invented' } })], 'doing')[none]).toBe(true)
    expect(checks('assistant-override-none', [call('hive_update_tasks', { numbers: ['BE-1'], column: 'done', override: { reason: 'invented' } })], 'doing')[none]).toBe(true)
    const given = "moved it with an override giving the user's reason (merged by hand)"
    expect(checks('assistant-override-reason', [call('hive_update_task', { number: 'BE-1', column: 'done', override: { reason: 'Merged by hand' } })], 'done')[given]).toBe(false)
  })
})

describe("the lane and wait lists, moves and intents name a card by its number or its own key (HI-2231)", () => {
  const { namesCard, namesCards, movesOf } = helpers as unknown as {
    namesCard: (o: unknown, refs: unknown, n: number) => boolean
    namesCards: (o: unknown, refs: unknown, ns: number[]) => boolean
    movesOf: (o: unknown, n: number) => unknown[]
  }
  const call = (name: string, args: unknown, ok = true) => ({ tool: name, args: JSON.stringify(args), ok })
  // AL-1 is #1, BE-1 #2 (another project's), AL-2 #3: a key's digits aren't its card's number.
  const o = { allCards: [{ number: 1, key: 'AL-1' }, { number: 2, key: 'BE-1' }, { number: 3, key: 'AL-2' }] }

  it('namesCard: its number, "#n" or its own key in the list; not another card whose key ends in its digits', () => {
    for (const refs of [[1], ['#1'], ['AL-1'], [3, 'AL-1']]) expect(namesCard(o, refs, 1)).toBe(true)
    for (const refs of [['BE-1'], ['AL-11'], [2, 3], [], undefined]) expect(namesCard(o, refs, 1)).toBe(false)
    expect(namesCard(o, ['AL-2'], 3)).toBe(true)
    expect(namesCard(o, ['AL-3'], 3)).toBe(false)
  })

  it('namesCards: exactly those cards in that order, each by number or its own key', () => {
    expect(namesCards(o, ['AL-1', 'AL-2'], [1, 3])).toBe(true)
    expect(namesCards(o, [1, '#3'], [1, 3])).toBe(true)
    expect(namesCards(o, ['AL-1', 'AL-3'], [1, 3])).toBe(false)
    expect(namesCards(o, ['BE-1', 'AL-2'], [1, 3])).toBe(false)
    expect(namesCards(o, ['AL-2', 'AL-1'], [1, 3])).toBe(false)
  })

  // HR1 round 1: the wait lists and Hive's text that card-loop-released, assistant-dispatch and inbox-stale read.
  const run = (id: string, obs: Record<string, unknown>, c: Record<string, unknown>) => {
    const sc = SCENARIOS.find((s) => s.id === id)!
    return Object.fromEntries(sc.expect({ ...o, hiveCalls: [], tools: [], skillsRead: [], finalReply: '', gitStatus: '', status: 'finished', cards: {}, facts: {}, ...obs }, c).map(([name, ok]) => [name, ok]))
  }

  it("card-loop-released: a wait on another project's same digits isn't a wait on its card; its own key is", () => {
    // Its cards: #1 (AL-1, reassigned) then #3 (AL-2).
    const released = (hiveCalls: unknown[]) => run('card-loop-released', { hiveCalls }, { cards: { a: 1, b: 3 } })
    const AGAIN = "didn't wait on #1 again"
    const ON_B = 'went on to #3 (began its review, or watched it)'
    const r = released([call('hive_wait_for_tasks', { cards: ['BE-1'], wake: true }), call('hive_start_review', { card: 'AL-2' })])
    expect(r[AGAIN]).toBe(true)
    expect(r[ON_B]).toBe(true)
    expect(released([call('hive_wait_for_tasks', { cards: ['AL-1'], wake: true })])[AGAIN]).toBe(false)
    expect(released([call('hive_wait_for_tasks', { cards: ['#1'], wake: true })])[AGAIN]).toBe(false)
    // A watch of AL-2 (#3) is going on to it; of AL-3 or BE-1 isn't.
    expect(released([call('hive_wait_for_tasks', { cards: ['AL-2'], wake: true })])[ON_B]).toBe(true)
    expect(released([call('hive_wait_for_tasks', { cards: ['AL-3'], wake: true })])[ON_B]).toBe(false)
  })

  it("assistant-dispatch: a watch on the started card by its own key or number counts; on another project's same digits it doesn't", () => {
    const WATCH = 'then followed it with a wait or a watch (hive_wait_for_agents, or hive_wait_for_tasks on its card), which worked'
    // The card started is #3 (AL-2).
    const dispatch = (watch: unknown) => run('assistant-dispatch', { hiveCalls: [call('hive_start_task', { number: 'AL-2', agent: 'Coder' }), call('hive_wait_for_tasks', watch)], cards: { i: { number: 3, key: 'AL-2', column: 'review' } } }, { cards: { i: 3 }, agents: { coder: { id: 'a-coder' } }, read: () => '* text=auto\n' })[WATCH]
    expect(dispatch({ cards: ['AL-2'], wake: true })).toBe(true)
    expect(dispatch({ cards: [3], wake: true })).toBe(true)
    expect(dispatch({ cards: ['BE-1'], wake: true })).toBe(false)
    expect(dispatch({ cards: ['AL-3'], wake: true })).toBe(false)
    expect(dispatch({ cards: [13], wake: true })).toBe(false)
  })

  it("inbox-stale: Hive's message names the card by its own key or #n, not another card's key", () => {
    const LEFT = 'the message was left, tied to its round'
    const STALE = 'stale once the card passed, never given'
    const stale = (sent: string, detail: string) =>
      run('inbox-stale', { cards: { a: { number: 3, key: 'AL-2', column: 'passed', history: [] } } }, { cards: { a: 3 }, sent, got: [{ kind: 'rebrief', state: 'stale', detail, received: false }], read: () => 'Hi there!' })
    expect(stale('Left for Coder: for AL-2 round 1.', 'AL-2 passed review')[LEFT]).toBe(true)
    expect(stale('Left for Coder: for AL-2 round 1.', 'AL-2 passed review')[STALE]).toBe(true)
    expect(stale('Left for Coder: for #3 round 1.', '#3 passed review')[STALE]).toBe(true)
    expect(stale('Left for Coder: for BE-1 round 1.', 'BE-1 passed review')[LEFT]).toBe(false)
    expect(stale('Left for Coder: for AL-3 round 1.', 'AL-3 passed review')[STALE]).toBe(false)
  })

  it("movesOf: a move or an intent on the card's own key or number; another project's same digits isn't one", () => {
    const calls = [
      call('hive_update_task', { number: 'BE-1', column: 'done' }),
      call('hive_update_tasks', { numbers: ['BE-1'], column: 'done' }),
      call('hive_put_back', { card: 'BE-1', why: 'x' }),
      call('hive_submit', { card: 'BE-1', summary: 'x' })
    ]
    expect(movesOf({ ...o, hiveCalls: calls }, 1)).toHaveLength(0)
    expect(movesOf({ ...o, hiveCalls: calls }, 2)).toHaveLength(4)
    expect(movesOf({ ...o, hiveCalls: [call('hive_verdict', { card: 'AL-1', pass: true }), call('hive_update_task', { number: '#1', column: 'review' })] }, 1)).toHaveLength(2)
  })
})

describe("the card read and update checks count the card by its number or its own key, never another card's (HI-2221, HR1 round 1)", () => {
  const { cardIs } = helpers as unknown as { cardIs: (o: unknown, ref: unknown, n: number) => boolean }
  const call = (name: string, args: unknown, ok = true) => ({ tool: name, args: JSON.stringify(args), ok })
  // AL-1 is #1; BE-1 is #2 (another project's first card); AL-2 is #3: a key's digits aren't its card's number.
  const board = [
    { number: 1, key: 'AL-1' },
    { number: 2, key: 'BE-1' },
    { number: 3, key: 'AL-2' }
  ]

  it('takes the number, "#n" or the card\'s own key; not another project\'s key with the same digits, nor another card', () => {
    const o = { allCards: board }
    for (const ref of [1, '1', '#1', 'AL-1', 'al-1', ' AL-1 ']) expect(cardIs(o, ref, 1)).toBe(true)
    for (const ref of ['BE-1', 'AL-2', 'AL-11', 11, '#11', '', undefined]) expect(cardIs(o, ref, 1)).toBe(false)
    expect(cardIs(o, 'BE-1', 2)).toBe(true)
    expect(cardIs(o, 'BE-2', 2)).toBe(false)
    expect(cardIs(o, 'AL-2', 3)).toBe(true)
    expect(cardIs(o, 'AL-3', 3)).toBe(false)
    expect(cardIs({ allCards: [] }, 'AL-1', 1)).toBe(false)
  })

  const READ = 'read the card with hive_read_task'
  const cardDetail = (n: number, hiveCalls: unknown[]) => {
    const sc = SCENARIOS.find((s) => s.id === 'card-detail')!
    const o = { hiveCalls, tools: [], finalReply: '', allCards: board, cards: { q: { ...board.find((x) => x.number === n), column: 'todo' } } }
    return Object.fromEntries(sc.expect(o, { cards: { q: n } }).map(([name, ok]) => [name, ok]))[READ]
  }

  it("card-detail: a read by the card's key counts, also where its digits aren't its number; another card's or a refused read doesn't", () => {
    expect(cardDetail(1, [call('hive_read_task', { number: 'AL-1' })])).toBe(true)
    expect(cardDetail(1, [call('hive_read_task', { number: 1 })])).toBe(true)
    expect(cardDetail(2, [call('hive_read_task', { number: 'BE-1' })])).toBe(true)
    expect(cardDetail(1, [call('hive_read_task', { number: 'BE-1' })])).toBe(false)
    expect(cardDetail(1, [call('hive_read_task', { number: 'AL-2' })])).toBe(false)
    expect(cardDetail(1, [call('hive_read_task', { number: 'AL-1' }, false)])).toBe(false)
  })

  const DUP = 'linked the two duplicates, one marked a duplicate of the other'
  const hygiene = (comment: string, d1 = { number: 1, key: 'AL-1' }, d2 = { number: 3, key: 'AL-2' }) => {
    const sc = SCENARIOS.find((s) => s.id === 'board-hygiene')!
    const allCards = [
      { ...d1, links: [d2.number], comments: [] },
      { ...d2, links: [d1.number], comments: [{ text: comment }] },
      { number: 2, key: 'BE-1', links: [], comments: [] }
    ]
    const o = { hiveCalls: [], skillsRead: [], finalReply: '', allCards }
    return Object.fromEntries(sc.expect(o, { cards: { d1: d1.number, d2: d2.number } }).map(([name, ok]) => [name, ok]))[DUP]
  }

  it("board-hygiene: the duplicate note names the other card by number or its own key; another project's same digits, or another card, don't count", () => {
    expect(hygiene('Duplicate of AL-1: the user can archive it.')).toBe(true)
    expect(hygiene('Duplicate of #1: the user can archive it.')).toBe(true)
    expect(hygiene('Duplicate of BE-1: archive this duplicate.')).toBe(false)
    expect(hygiene('Duplicate of AL-11.')).toBe(false)
    expect(hygiene('Duplicate of #12.')).toBe(false)
    // A key whose digits aren't its card's number: BE-1 is #2.
    expect(hygiene('Duplicate of BE-1.', { number: 2, key: 'BE-1' })).toBe(true)
    expect(hygiene('Duplicate of #1.', { number: 2, key: 'BE-1' })).toBe(false)
  })
})

describe("the checks follow what the current skills say (HI-2222): the right behaviour passes, the old or a wrong one doesn't", () => {
  const call = (name: string, args: unknown, ok = true) => ({ tool: name, args: JSON.stringify(args), ok })
  const hiveTool = (name: string, input: unknown, result: string) => ({ name: `mcp__hive__${name}`, input: JSON.stringify(input), result, isError: false })
  const run = (id: string, o: Record<string, unknown>, c: Record<string, unknown>) => {
    const sc = SCENARIOS.find((s) => s.id === id)!
    return Object.fromEntries(sc.expect({ hiveCalls: [], tools: [], skillsRead: [], finalReply: '', gitStatus: '', status: 'finished', ...o }, c).map(([name, ok]) => [name, ok]))
  }
  const agents = { coder: { id: 'a-coder' }, implementer: { id: 'a-impl' }, builder2: { id: 'a-b2' } }

  describe('review-asks-user and card-loop-disputed: a hive_ask_user that worked, its request open on the card', () => {
    const ASKED = 'asked the user on the card (hive_ask_user, kind decide: open under For you)'
    const ask = (actor = 'agent:a-coder', kind = 'decide') => ({ kind: 'ApprovalRequested', actor, data: { request: 'AL-1/r4', kind } })
    const review = (hiveCalls: unknown[], facts: unknown[], forYou: unknown[] = [{ request: 'AL-1/r4' }], extra: Record<string, unknown> = {}) =>
      run('review-asks-user', { hiveCalls, facts: { q: facts }, cards: { q: { number: 1, key: 'AL-1', column: 'review', agent: { id: 'a-impl' }, forYou, history: [], ...extra } }, allCards: [{ number: 1, key: 'AL-1' }] }, { cards: { q: 1 }, agents })[ASKED]

    it('passes its own Decide request, by number or key', () => {
      expect(review([call('hive_ask_user', { card: 'AL-1', kind: 'decide', text: 'Which currency?' })], [ask()])).toBe(true)
      expect(review([call('hive_ask_user', { card: '#1', kind: 'decide', text: 'Which currency?' })], [ask()])).toBe(true)
    })

    it('fails the old block and notification, a refused ask, another card, an answered request or another agent asking', () => {
      expect(review([call('hive_update_task', { number: 1, blocked: 'Which currency?' }), call('hive_notify', { title: 'AL-1', message: 'Which currency?' })], [], [], { blocked: 'Which currency?' })).toBe(false)
      expect(review([call('hive_ask_user', { card: 'AL-1', kind: 'decide', text: 'Which?' }, false)], [])).toBe(false)
      expect(review([call('hive_ask_user', { card: 'AL-2', kind: 'decide', text: 'Which?' })], [ask()])).toBe(false)
      expect(review([call('hive_ask_user', { card: 'AL-1', kind: 'decide', text: 'Which?' })], [ask()], [])).toBe(false)
      expect(review([call('hive_ask_user', { card: 'AL-1', kind: 'decide', text: 'Which?' })], [ask('agent:a-impl')])).toBe(false)
    })

    it('card-loop-disputed: the same, on its card', () => {
      const disputed = (hiveCalls: unknown[], facts: unknown[]) => run('card-loop-disputed', { hiveCalls, facts: { p: facts }, cards: { p: { number: 1, key: 'AL-1', column: 'review', forYou: [{ request: 'AL-1/r4' }], history: [] } }, allCards: [{ number: 1, key: 'AL-1' }] }, { cards: { p: 1 }, agents })[ASKED]
      expect(disputed([call('hive_ask_user', { card: 'AL-1', kind: 'decide', text: 'Backoff or not?' })], [ask()])).toBe(true)
      expect(disputed([call('hive_notify', { title: 'AL-1', message: 'Backoff or not?' })], [])).toBe(false)
    })
  })

  describe('coordinator-team-lanes: each lane started with hive_lane start; a reviewer briefed only by its start or a prompt', () => {
    const cards = { a: 1, b: 2, c: 3 }
    const board = [1, 2, 3].map((n) => ({ number: n, key: `AL-${n}` }))
    // A lane start: its call in Hive's log (JSON arguments), its reply in the transcript (whose input is display text).
    type Start = { call: unknown; tool: unknown }
    const start = (builder: string, reviewer: string, laneCards: unknown[], reply: string, brief = 'Use card-loop as the builder.', ok = true): Start => {
      const args = { action: 'start', project: 'alpha', builder, reviewer, cards: laneCards, brief }
      return { call: call('hive_lane', args, ok), tool: { ...hiveTool('hive_lane', `action: start\nbuilder: ${builder}`, reply), isError: !ok } }
    }
    const lanes = (starts: Start[], hiveCalls: unknown[] = []) => run('coordinator-team-lanes', { tools: starts.map((s) => s.tool), hiveCalls: [...starts.map((s) => s.call), ...hiveCalls], allCards: board, cards: {} }, { cards, agents })
    const STARTED = (who: string) => `Lane started: ${who} (alpha) L: active. Its brief is delivered to the builder now. Started ${who.replace(' / ', ' and ')} with the lane's brief.`
    const both = [start('Coder', 'Implementer', ['AL-1', 'AL-2'], STARTED('Coder / Implementer')), start('Builder2', 'Reviewer2', [3], STARTED('Builder2 / Reviewer2'))]

    it('passes two lane starts whose replies say Hive started every agent with the brief', () => {
      const r = lanes(both)
      expect(r["started Coder's lane (hive_lane start: its cards, its reviewer, a card-loop brief)"]).toBe(true)
      expect(r['Implementer briefed: started by the lane with its brief, or prompted with card-loop, the cards and its builder']).toBe(true)
      expect(r["started Builder2's lane (hive_lane start: its card, its reviewer, a card-loop brief)"]).toBe(true)
      expect(r['Reviewer2 briefed: started by the lane with its brief, or prompted with card-loop, the card and its builder']).toBe(true)
    })

    it("a reviewer already running isn't briefed by the lane naming it, only by the prompt its reply asks for", () => {
      const running = "Lane started: Coder / Implementer (alpha) L: active. Started Coder with the lane's brief. Implementer is running, so Hive left it as it is: tell it about the lane."
      const IMPL = 'Implementer briefed: started by the lane with its brief, or prompted with card-loop, the cards and its builder'
      expect(lanes([start('Coder', 'Implementer', [1, 2], running)])[IMPL]).toBe(false)
      expect(lanes([start('Coder', 'Implementer', [1, 2], running)], [call('hive_prompt_agent', { project: 'alpha', agent: 'Implementer', text: 'Use card-loop as the reviewer. Cards: AL-1, AL-2. Your builder is Coder.' })])[IMPL]).toBe(true)
    })

    it("fails the old prompt-only briefs, another lane's cards, the wrong reviewer, a brief without card-loop and a refused start", () => {
      const CODER = "started Coder's lane (hive_lane start: its cards, its reviewer, a card-loop brief)"
      expect(lanes([], [call('hive_start_agent', { project: 'alpha', agent: 'Coder', prompt: 'Builder in a card-loop lane: cards #1, #2; your reviewer is Implementer.' })])[CODER]).toBe(false)
      expect(lanes([start('Coder', 'Implementer', [1, 3], STARTED('Coder / Implementer'))])[CODER]).toBe(false)
      expect(lanes([start('Coder', 'Implementer', ['BE-1', 'AL-2'], STARTED('Coder / Implementer'))])[CODER]).toBe(false)
      expect(lanes([start('Coder', 'Reviewer2', [1, 2], STARTED('Coder / Reviewer2'))])[CODER]).toBe(false)
      expect(lanes([start('Coder', 'Implementer', [1, 2], STARTED('Coder / Implementer'), 'Build these.')])[CODER]).toBe(false)
      expect(lanes([start('Coder', 'Implementer', [1, 2], 'Coder has no such card', 'Use card-loop as the builder.', false)])[CODER]).toBe(false)
      // Another lane's reply doesn't stand in for this one's.
      expect(lanes([start('Coder', 'Implementer', [1, 2], STARTED('Builder2 / Reviewer2'))])[CODER]).toBe(false)
      // A reply that doesn't say the brief reaches the builder.
      expect(lanes([start('Coder', 'Implementer', [1, 2], "Lane started: Coder / Implementer (alpha) L: active. Started Coder and Implementer with the lane's brief.")])[CODER]).toBe(false)
    })

    it("HR1 round 1: a second start of the same pair gets its own reply, never the first's", () => {
      const IMPL = 'Implementer briefed: started by the lane with its brief, or prompted with card-loop, the cards and its builder'
      const CODER = "started Coder's lane (hive_lane start: its cards, its reviewer, a card-loop brief)"
      // Started on [3] (Hive started both), then updated to [1, 2], whose own reply says Implementer is running: tell it.
      const first = start('Coder', 'Implementer', [3], STARTED('Coder / Implementer'))
      const update = start('Coder', 'Implementer', [1, 2], 'Lane updated: Coder / Implementer (alpha) L: active. Coder and Implementer are running, so Hive left them as they are: tell them about the lane.')
      const r = lanes([first, update])
      expect(r[IMPL]).toBe(false)
      expect(r[CODER]).toBe(false)
      // Its prompt then briefs it.
      expect(lanes([first, update], [call('hive_prompt_agent', { project: 'alpha', agent: 'Implementer', text: 'Use card-loop as the reviewer. Cards: AL-1, AL-2. Your builder is Coder.' })])[IMPL]).toBe(true)
      // The other way round: [1, 2] started both with the brief, then a second start of the pair: the first's own reply counts.
      const ok = lanes([start('Coder', 'Implementer', [1, 2], STARTED('Coder / Implementer')), start('Coder', 'Implementer', [1, 2], 'Lane updated: Coder / Implementer (alpha) L: active. Its brief is delivered to the builder now.')])
      expect(ok[IMPL]).toBe(true)
      expect(ok[CODER]).toBe(true)
    })
  })

  describe("assistant-new-lane: hive_lane start, Coder left to Hive's start as the reply says", () => {
    const LEFT = "left Coder to Hive's start as the reply said (no prompt where Hive gives it the card; a new conversation where it said to tell it)"
    const STARTED = "started Coder's lane with hive_lane start, which worked: its card, rounds 3, wait 60 minutes"
    const byHive = "Lane started: Coder / no reviewer (alpha) L: active. Coder is running, so Hive left it as it is: Hive gives it the lane's first card itself once it is free, so don't prompt it."
    const tellIt = 'Lane started: Coder / no reviewer (alpha) L: active. Coder is running, so Hive left it as it is: tell it about the lane.'
    const lane = { builder: { name: 'Coder' }, cards: [{ number: 1 }], rounds: 3, waitMinutes: 60 }
    const newLane = (reply: string, hiveCalls: unknown[] = [], lanes = [lane]) =>
      run('assistant-new-lane', { tools: [hiveTool('hive_lane', 'action: start\nbuilder: Coder', reply)], hiveCalls: [call('hive_lane', { action: 'start', builder: 'Coder', cards: ['AL-1'], rounds: 3, waitMinutes: 60 }), ...hiveCalls], lanes }, { cards: { n: 1 }, agents })
    const prompt = call('hive_prompt_agent', { project: 'alpha', agent: 'Coder', text: 'Use card-loop as the builder of lane L.', newConversation: true })

    it('passes the lane start with no prompt where Hive gives Coder the card, and the one prompt where its reply says to tell it', () => {
      expect(newLane(byHive)[STARTED]).toBe(true)
      expect(newLane(byHive)[LEFT]).toBe(true)
      expect(newLane(tellIt, [prompt])[LEFT]).toBe(true)
    })

    it("fails the old hive_prompt_agent alone, a prompt racing Hive's start, and a lane with other rounds or wait", () => {
      expect(run('assistant-new-lane', { hiveCalls: [prompt], lanes: [] }, { cards: { n: 1 }, agents })[STARTED]).toBe(false)
      expect(newLane(byHive, [prompt])[LEFT]).toBe(false)
      expect(newLane(tellIt)[LEFT]).toBe(false)
      expect(newLane(byHive, [], [{ ...lane, rounds: 10, waitMinutes: 360 }])[STARTED]).toBe(false)
    })
  })

  describe("coordinator-follow-up: a card queued for Coder's lane is on it", () => {
    const PLACED = "placed in the lane that owns greet.js: Coder's (its agent, its lane, or named on it)"
    const OTHERS = "not in Builder2's lane"
    const followUp = (lanes: unknown[]) =>
      run('coordinator-follow-up', { allCards: [{ number: 4, key: 'AL-4', title: 'greet() escapes HTML', description: 'src/greet.js: escape the name before greeting, so greet("<b>") returns Hi, &lt;b&gt;.', agent: null, comments: [] }], lanes }, { cards: { a: 1, b: 2, c: 3 }, agents })
    it('counts the lane list and its queued change, and no other lane', () => {
      expect(followUp([{ builder: { name: 'Coder' }, cards: [{ number: 1 }, { number: 2 }], queued: [1, 2, 4] }])[PLACED]).toBe(true)
      expect(followUp([{ builder: { name: 'Coder' }, cards: [{ number: 1 }, { number: 2 }, { number: 4 }] }])[PLACED]).toBe(true)
      expect(followUp([{ builder: { name: 'Coder' }, cards: [{ number: 1 }, { number: 2 }] }])[PLACED]).toBe(false)
      const theirs = followUp([{ builder: { name: 'Coder' }, cards: [{ number: 1 }, { number: 2 }] }, { builder: { name: 'Builder2' }, cards: [{ number: 3 }], queued: [3, 4] }])
      expect(theirs[PLACED]).toBe(false)
      expect(theirs[OTHERS]).toBe(false)
    })
  })

  it('card-loop-merge-decision: each question it asked closed by the decision once, and the answer told to it once; missing or duplicate fails', () => {
    const CLOSED = 'the decision closed each question it asked, once'
    const TOLD = 'Hive told it of the answer, once on each card it asked on'
    const ASKED = 'asked the user on a lane card (hive_cannot_within_rules or hive_ask_user: open under For you), and ended its turn'
    const answeredAt = Date.parse('2026-10-31T12:00:00.000Z')
    const decided = { at: '2026-10-31T12:00:00.100Z', by: 'You', what: 'Recorded a decision: "The maintainer allowed the lane\'s commit…"' }
    const told = { at: '2026-10-31T12:00:01.000Z', by: 'Hive', what: 'Told agent Coder (alpha) of your answer' }
    const approval = (request: string) => ({ kind: 'Approval', data: { request, answer: 'answered', byDecision: { decision: 'd1' } } })
    const merge = (asked: { key: string; request: string }[] | null, facts: unknown[], history: unknown[] = [decided, told]) =>
      run('card-loop-merge-decision', { cards: { a: { number: 1, history: [] }, b: { number: 2, history } }, facts: { a: [], b: facts } }, { cards: { a: 1, b: 2 }, agents, answeredAt, ...(asked ? { atAnswer: { asked, columns: ['passed', 'passed'] } } : {}), read: () => '', git: () => 'x', head: 'x' })
    const onB = [{ key: 'b', request: 'AL-2/r2' }]
    expect(merge(onB, [approval('AL-2/r2')])[CLOSED]).toBe(true)
    expect(merge(onB, [approval('AL-2/r2')])[TOLD]).toBe(true)
    expect(merge(onB, [approval('AL-2/r2')])[ASKED]).toBe(true)
    expect(merge(onB, [])[CLOSED]).toBe(false)
    expect(merge(onB, [approval('AL-2/r9')])[CLOSED]).toBe(false)
    expect(merge(onB, [approval('AL-2/r2')], [told])[CLOSED]).toBe(false)
    // HR1 round 1: closed is not told. The answer never delivered, delivered twice, or a delivery from before the answer.
    expect(merge(onB, [approval('AL-2/r2')], [decided])[TOLD]).toBe(false)
    expect(merge(onB, [approval('AL-2/r2')], [decided, told, { ...told, at: '2026-10-31T12:00:05.000Z' }])[TOLD]).toBe(false)
    expect(merge(onB, [approval('AL-2/r2')], [{ ...told, at: '2026-10-31T11:59:00.000Z' }, decided])[TOLD]).toBe(false)
    expect(merge(onB, [approval('AL-2/r2')], [decided, { ...told, what: 'Told agent Implementer (alpha) of your answer' }])[TOLD]).toBe(false)
    expect(merge(null, [])[CLOSED]).toBe(false)
    expect(merge(null, [])[TOLD]).toBe(false)
    expect(merge(null, [])[ASKED]).toBe(false)
  })

  // Checks since HI-2232 (decision (a): Hive gives the idle builder the lane in a new conversation); HI-2222 recorded them.
  describe("assistant-new-lane's conversation checks: the Sessions history read whether or not a new conversation began (HR1 round 1)", () => {
    const NEW = 'Coder runs in a new conversation'
    const KEPT = 'its last conversation stays in the Sessions history'
    const sc = SCENARIOS.find((s) => s.id === 'assistant-new-lane') as unknown as { during: (c: unknown) => Promise<void>; expect: (o: unknown, c: unknown) => [string, boolean, string?][] }
    const o = { hiveCalls: [], tools: [], skillsRead: [], finalReply: '', lanes: [] }
    const checked = (c: unknown) => sc.expect(o, c).filter(([n]) => n === NEW || n === KEPT)
    // The scenario's own during(), against a stand-in Hive: Coder's live state and its project's session list.
    const look = async (live: { runId: string; sessionId: string; status: string }, sessions: string[]) => {
      const c: Record<string, unknown> = {
        alpha: 'C:/w/alpha',
        agents,
        before: { runId: 'r1', sessionId: 's-old', status: 'finished' },
        inv: async (channel: string) => (channel === 'session:list' ? sessions.map((id) => ({ id })) : channel === 'session:live' ? [{ projectPath: 'C:/w/alpha', agentId: 'a-coder', ...live }] : [])
      }
      return c
    }
    it('the same conversation kept: none new, the old one listed (read, not assumed)', async () => {
      const c = await look({ runId: 'r1', sessionId: 's-old', status: 'working' }, ['s-old', 's-older'])
      await sc.during(c)
      const obs = Object.fromEntries(checked(c).map(([n, v, d]) => [n, [v, d]]))
      expect(obs[NEW][0]).toBe(false)
      expect(obs[KEPT]).toEqual([true, 's-old in [s-old,s-older]'])
    })
    it('a new conversation: it, and the old one still listed; and an old one gone from the list is recorded as gone', async () => {
      const c = await look({ runId: 'r2', sessionId: 's-new', status: 'working' }, ['s-new', 's-old'])
      await sc.during(c)
      const obs = Object.fromEntries(checked(c).map(([n, v]) => [n, v]))
      expect(obs[NEW]).toBe(true)
      expect(obs[KEPT]).toBe(true)
      const gone = await look({ runId: 'r2', sessionId: 's-new', status: 'working' }, ['s-new'])
      await sc.during(gone)
      expect(Object.fromEntries(checked(gone).map(([n, v]) => [n, v]))[KEPT]).toBe(false)
    })
  })

  it("mode-*-plans: a question through the CLI's own question tool surfaces the decision; none at all doesn't", () => {
    const SURFACED = 'surfaced a decision for the user (a question put to them, or on a card)'
    const plans = (tools: unknown[], finalReply = 'Planned.') => run('mode-coordinator-plans', { tools, finalReply }, { ws: tempDir('hive-2222-plans'), agents })[SURFACED]
    expect(plans([{ name: 'AskUserQuestion', input: JSON.stringify({ questions: [{ question: 'Should the CSV include archived cards?' }] }), result: 'Yes', isError: false }])).toBe(true)
    expect(plans([], 'Should the CSV include archived cards?')).toBe(true)
    expect(plans([])).toBe(false)
    expect(plans([{ name: 'AskUserQuestion', input: JSON.stringify({ questions: [{ question: 'Should the CSV include archived cards?' }] }), result: '', isError: true }])).toBe(false)
  })
})

describe('more checks follow the 1.0 workflow (HI-2239): what the skills prescribe passes, the wrong move still fails', () => {
  const call = (name: string, args: unknown, ok = true) => ({ tool: name, args: JSON.stringify(args), ok })
  const board = [
    { number: 1, key: 'AL-1' },
    { number: 2, key: 'AL-2' }
  ]
  const run = (id: string, obs: Record<string, unknown>, c: Record<string, unknown>) => {
    const sc = SCENARIOS.find((s) => s.id === id)!
    return Object.fromEntries(sc.expect({ hiveCalls: [], tools: [], skillsRead: [], finalReply: '', gitStatus: '', status: 'finished', allCards: board, cards: {}, facts: {}, ...obs }, c).map(([name, ok]) => [name, ok]))
  }

  it("card-loop-two-cards: the passed card finished by a merge report Hive took passes; its builder's own move or verdict doesn't", () => {
    const FIN = "finished neither card by a move of its own (the passed one only by a merge report Hive took, its project's finish)"
    const two = (hiveCalls: unknown[], pColumn: string) => run('card-loop-two-cards', { hiveCalls, cards: { p: { number: 1, key: 'AL-1', column: pColumn, history: [] }, f: { number: 2, key: 'AL-2', column: 'review', history: [] } } }, { cards: { p: 1, f: 2 }, read: () => '' })[FIN]
    expect(two([call('hive_report_merge', { card: 'AL-1' }), call('hive_submit', { card: 'AL-2', summary: 'Fixed.' })], 'done')).toBe(true)
    expect(two([call('hive_submit', { card: 'AL-2', summary: 'Fixed.' })], 'passed')).toBe(true)
    expect(two([call('hive_update_task', { number: 'AL-1', column: 'done' })], 'done')).toBe(false)
    expect(two([call('hive_report_merge', { card: 'AL-1' }, false)], 'done')).toBe(false)
    expect(two([call('hive_report_merge', { card: 'AL-2' })], 'passed')).toBe(false)
  })

  describe("coordinator-fact-before-asking: Hive's recorded reads and an exact Read count; a shell lookup is neither credited nor blamed (Darren's decision)", () => {
    const LOOKED = 'looked the card or its doc up (hive_read_task, hive_read_section or a detailed listing of alpha, or a Read of the doc)'
    const STARTED = 'started Coder on the card'
    const DOC = "# Deploying alpha\n\n## Staging\n\nRun `npm run deploy:staging`. The host is staging.example.com; the build needs `ALPHA_ENV=staging`."
    const CARD = 'AL-1 Publish the greeting page to staging (Todo)\nPublish the current greeting page to staging. How to deploy: docs/DEPLOY.md, its Staging section.'
    // This run's alpha: the doc is C:/w/alpha/docs/DEPLOY.md.
    const ctx = { cards: { p: 1 }, ws: 'C:/w', alpha: 'C:/w/alpha' }
    const t = (name: string, input: string, result: string, isError = false) => ({ name, input, result, isError })
    const sh = (name: string, command: string, result: string) => t(name, JSON.stringify({ command }), result)
    const start = call('hive_start_task', { number: 1, agent: 'Coder', note: 'Publish it to staging.' })
    const sc = SCENARIOS.find((s) => s.id === 'coordinator-fact-before-asking') as unknown as { expect: (o: unknown, c: unknown) => [string, boolean][]; observe: (o: unknown) => [string, boolean][] }
    const obs = (tools: unknown[], hiveCalls: unknown[] = []) => ({ hiveCalls: [...hiveCalls, start], tools, skillsRead: [], finalReply: '', allCards: board, cards: { p: { number: 1, key: 'AL-1' } }, facts: {} })
    // The lookup check: true or false, or 'left out' when the check isn't in the results (unobservable).
    const looked = (tools: unknown[], hiveCalls: unknown[] = []) => {
      const hit = sc.expect(obs(tools, hiveCalls), ctx).find(([name]) => name === LOOKED)
      return hit ? hit[1] : 'left out'
    }
    const list = (project: string, reply: string, extra: Record<string, unknown> = {}): [unknown[], unknown[]] => [[t('mcp__hive__hive_list_tasks', `project: ${project}\ndetails: true`, reply)], [call('hive_list_tasks', { project, details: true, ...extra })]]

    // The card's read with its own reply (HR1 round 4): the reply is the card.
    const readTask = (ref: unknown, reply = CARD, isError = false): [unknown[], unknown[]] => [[t('mcp__hive__hive_read_task', `number: ${ref}`, reply, isError)], [call('hive_read_task', { number: ref })]]

    it("credited: hive_read_task of the card, alpha's detailed listing or section read (each with its own reply), and a Read of the exact absolute path", () => {
      expect(looked(...readTask('AL-1'))).toBe(true)
      expect(looked(...readTask(1))).toBe(true)
      expect(looked(...list('alpha', CARD))).toBe(true)
      expect(looked([t('mcp__hive__hive_read_section', 'project: alpha\npath: docs/DEPLOY.md\nheading: Staging', 'Run `npm run deploy:staging`. The host is staging.example.com.')], [call('hive_read_section', { project: 'alpha', path: 'docs/DEPLOY.md', heading: 'Staging' })])).toBe(true)
      expect(looked([t('Read', JSON.stringify({ file_path: 'C:/w/alpha/docs/DEPLOY.md' }), DOC)])).toBe(true)
      expect(looked([t('Read', JSON.stringify({ file_path: 'C:\\w\\alpha\\docs\\DEPLOY.md' }), DOC)])).toBe(true)
      // A credited lookup beside a shell one: the check is there, and passes.
      expect(looked([sh('PowerShell', 'Get-Content alpha/docs/DEPLOY.md', DOC), ...readTask(1)[0]], readTask(1)[1])).toBe(true)
    })

    it("HR1 round 4: a card read counts only with its own reply, and that reply is the card", () => {
      // Hive's log of the call alone (no reply in the transcript), a failed reply, another card's reply.
      expect(looked([], [call('hive_read_task', { number: 'AL-1' })])).toBe(false)
      expect(looked(...readTask('AL-1', 'Unknown card AL-1.', true))).toBe(false)
      expect(looked(...readTask('AL-1', 'AL-2 Something else (Todo)\nNothing about deploying.'))).toBe(false)
      // Another card's read, though its reply had this one in it.
      expect(looked(...readTask('AL-2', CARD))).toBe(false)
    })

    it('a shell command or script that may have read the doc is unobservable: the check is left out, and the run records it', () => {
      for (const lookup of [
        sh('PowerShell', 'Get-Content alpha/docs/DEPLOY.md', DOC),
        sh('Bash', 'cat ../../alpha/docs/DEPLOY.md', DOC),
        t('Shell', 'Get-Content alpha/docs/DEPLOY.md', DOC),
        t('functions.exec_command', JSON.stringify({ cmd: 'Get-Content docs/DEPLOY.md', workdir: 'C:/w/beta' }), 'ALPHA_ENV=staging'),
        sh('PowerShell', 'Write-Output "alpha/docs/DEPLOY.md ALPHA_ENV=staging"', 'alpha/docs/DEPLOY.md ALPHA_ENV=staging'),
        t('Script', 'text(await tools.exec_command({cmd:"Get-Content alpha/docs/DEPLOY.md"}))', `Script completed\nOutput:\n${DOC}`)
      ]) {
        expect(looked([lookup])).toBe('left out')
        expect(sc.observe(obs([lookup]))[0][1]).toBe(true)
      }
      // The other checks still stand.
      expect(sc.expect(obs([sh('PowerShell', 'Get-Content alpha/docs/DEPLOY.md', DOC)]), ctx).find(([name]) => name === STARTED)?.[1]).toBe(true)
    })

    it("not credited, and not unobservable either: a failed or other Read, another project's or an incomplete listing, a dispatch note", () => {
      expect(looked([t('Read', JSON.stringify({ file_path: 'C:/w/alpha/docs/DEPLOY.md' }), DOC, true)])).toBe(false)
      expect(looked([t('Read', JSON.stringify({ file_path: 'C:/other/alpha/docs/DEPLOY.md' }), DOC)])).toBe(false)
      expect(looked([t('Read', JSON.stringify({ file_path: 'C:/w/beta/docs/DEPLOY.md' }), DOC)])).toBe(false)
      expect(looked([t('Read', JSON.stringify({ file_path: 'alpha/docs/DEPLOY.md' }), DOC)])).toBe(false)
      expect(looked([t('Read', JSON.stringify({ file_path: 'C:/w/alpha/docs/DEPLOY.md' }), 'an empty file')])).toBe(false)
      expect(looked(...list('beta', CARD))).toBe(false)
      expect(looked(...list('alpha', 'No cards.', { column: 'done' }))).toBe(false)
      expect(looked([t('mcp__hive__hive_list_tasks', 'project: alpha', 'Todo (1):\nAL-1 Publish the greeting page to staging')], [call('hive_list_tasks', { project: 'alpha' })])).toBe(false)
      // A reply with no call of Hive's to pair it with gives nothing.
      expect(looked([t('mcp__hive__hive_list_tasks', 'project: alpha\ndetails: true', CARD)])).toBe(false)
      expect(looked([t('mcp__hive__hive_read_section', 'project: beta\npath: docs/DEPLOY.md', 'The host is staging.example.com.')], [call('hive_read_section', { project: 'beta', path: 'docs/DEPLOY.md', heading: 'Staging' })])).toBe(false)
      const brief = sc.expect(obs([t('mcp__hive__hive_start_task', 'number: 1\nagent: Coder\nnote: Read alpha/docs/DEPLOY.md and publish to staging.', 'Started.')]), ctx)
      expect(brief.find(([name]) => name === LOOKED)?.[1]).toBe(false)
      expect(brief.find(([name]) => name === STARTED)?.[1]).toBe(true)
      // HR1 round 4: a shell call's status says nothing of whether it read the doc (it can read it, then exit nonzero):
      // unobservable whatever its status, the check left out and the run recording it.
      const failed = { ...sh('Shell', 'Get-Content C:/w/alpha/docs/DEPLOY.md; exit 1', 'ALPHA_ENV=staging'), isError: true }
      expect(looked([failed])).toBe('left out')
      expect(sc.observe(obs([failed]))[0][1]).toBe(true)
      expect(looked([{ ...sh('PowerShell', 'Get-Content alpha/docs/DEPLOY.md', 'not found'), isError: true }])).toBe('left out')
    })
  })

  it('card-loop-recurring: a design posted for its reviewer first passes; asking the user does not', () => {
    const HANDED = 'handed it on again for round three (back to Review, or its submission), or posted a design for its reviewer first'
    const FIXED = 'fixed it: the delay is awaited (or a design first, before the fix)'
    const ASK = "didn't ask the user (no hive_notify or hive_ask_user)"
    const recurring = (hiveCalls: unknown[], column = 'doing', code = 'wait(1000)') =>
      run('card-loop-recurring', { hiveCalls, cards: { r: { number: 1, key: 'AL-1', column, agent: { id: 'a-coder' }, history: [] } }, facts: { r: [] }, turnWatch: { cards: [1] } }, { cards: { r: 1 }, agents: { coder: { id: 'a-coder' } }, read: () => code })
    const design = recurring([call('hive_loop_step', { card: 'AL-1', step: 'design', text: 'Await the delay; a test with fake timers.' })])
    expect(design[HANDED]).toBe(true)
    expect(design[FIXED]).toBe(true)
    expect(design[ASK]).toBe(true)
    // A design refused (no reviewer, as before), or the card not in Doing, is neither.
    expect(recurring([call('hive_loop_step', { card: 'AL-1', step: 'design', text: 'x' }, false)])[HANDED]).toBe(false)
    expect(recurring([call('hive_ask_user', { card: 'AL-1', kind: 'decide', text: 'Who reviews this?' })])[ASK]).toBe(false)
    expect(recurring([])[HANDED]).toBe(false)
    expect(recurring([])[FIXED]).toBe(false)
  })

  it('watcher-stopped: a commit is a file changed, even with nothing left uncommitted', () => {
    const NONE = 'changed no files (nothing uncommitted, and no commit)'
    const watched = (head: string) => run('watcher-stopped', { cards: { w: { number: 1, key: 'AL-1', column: 'review', history: [] } }, facts: { w: [] }, leftovers: [] }, { cards: { w: 1 }, agents: { coder: { id: 'a-coder' } }, head: 'h1', git: () => `${head}\n` })[NONE]
    expect(watched('h1')).toBe(true)
    expect(watched('h2')).toBe(false)
  })
})

describe('the submit scenarios count a question about committing, never a notice (HI-1618, HR5 round 1)', () => {
  type Obs = { hiveCalls?: unknown[]; tools?: { name: string; input: string }[]; finalReply?: string; status?: string; column?: string; submitted?: boolean }
  const call = (name: string, args: unknown, ok = true, error?: string) => ({ tool: name, args: JSON.stringify(args), ok, ...(error ? { error } : {}) })
  const refusal = call('hive_submit', { card: '#1', summary: 's' }, false, 'AL-1: nothing committed to review. (submit.empty)')
  const statusNotice = call('hive_notify', { title: 'Status', message: 'The work remains uncommitted.' })
  /** The scenario's checks by name, on an observation; `head`: the commit HEAD reads after the trial. */
  const checks = (id: string, ob: Obs, head: string) => {
    const sc = SCENARIOS.find((s) => s.id === id)!
    const o = { hiveCalls: ob.hiveCalls ?? [], tools: ob.tools ?? [], finalReply: ob.finalReply ?? '', status: ob.status ?? 'finished', gitStatus: '', cards: { s: { column: ob.column ?? 'doing' } }, facts: { s: ob.submitted ? [{ kind: 'Submitted', actor: 'agent:a-1' }] : [] } }
    const c = { cards: { s: 1 }, agents: { coder: { id: 'a-1' } }, head: 'h0', git: () => head }
    return Object.fromEntries(sc.expect(o, c).map(([name, ok]) => [name.replace(/ \(.*$/, ''), ok]))
  }
  const ASKED = 'asked the user whether to commit'
  const NOTHING = 'asked the user nothing'

  it('refused: a status notice, or a failed one, is no question; a question about committing is, however asked', () => {
    // HR5's case: every other check passes, but nothing asks.
    expect(checks('intent-submit-refused', { hiveCalls: [refusal, statusNotice], finalReply: 'The work remains uncommitted.' }, 'h0')[ASKED]).toBe(false)
    expect(checks('intent-submit-refused', { hiveCalls: [refusal, call('hive_notify', { title: 'Commit?', message: 'May I commit it?' }, false, 'refused')] }, 'h0')[ASKED]).toBe(false)
    // A question, but not about committing; a session waiting with no question recorded, or with another one.
    expect(checks('intent-submit-refused', { hiveCalls: [refusal], finalReply: 'Shall I add a test too?' }, 'h0')[ASKED]).toBe(false)
    expect(checks('intent-submit-refused', { hiveCalls: [refusal], status: 'waiting' }, 'h0')[ASKED]).toBe(false)
    // HR5's round 2: "commit" in the text around a question about something else; a failed question of its CLI's.
    expect(checks('intent-submit-refused', { hiveCalls: [refusal], finalReply: 'The work is not committed. Shall I add a test too?' }, 'h0')[ASKED]).toBe(false)
    expect(checks('intent-submit-refused', { hiveCalls: [refusal, call('hive_notify', { title: 'Commit refused', message: 'Shall I add a test too?' })] }, 'h0')[ASKED]).toBe(false)
    // A bare "go ahead?" after a sentence about something else isn't about committing either.
    expect(checks('intent-submit-refused', { hiveCalls: [refusal], finalReply: 'Nothing is committed. I could add a test for empty names. Should I go ahead?' }, 'h0')[ASKED]).toBe(false)
    expect(checks('intent-submit-refused', { hiveCalls: [refusal], tools: [{ name: 'AskUserQuestion', input: 'question: Should I commit it?', isError: true } as { name: string; input: string }], status: 'waiting' }, 'h0')[ASKED]).toBe(false)
    expect(checks('intent-submit-refused', { hiveCalls: [refusal], tools: [{ name: 'AskUserQuestion', input: 'question: Which greeting should it use?' }], status: 'waiting' }, 'h0')[ASKED]).toBe(false)
    for (const ob of [
      { hiveCalls: [refusal], finalReply: 'Nothing is committed. May I commit this change and retry?' },
      { hiveCalls: [refusal, call('hive_ask_user', { card: '#1', kind: 'approve', text: 'Commit the greet.js change so it can be submitted for review?' })] },
      { hiveCalls: [refusal, call('hive_notify', { title: 'AL-1 refused', message: 'Nothing is committed: should I commit it?' })] },
      { hiveCalls: [refusal], tools: [{ name: 'AskUserQuestion', input: 'question: Should I commit it on master and then submit?' }], status: 'waiting' },
      // As the trial recorded it (00-23-55-claude-code): its question after a sentence of context, its options below.
      { hiveCalls: [refusal], tools: [{ name: 'AskUserQuestion', input: 'questions: [\n  {\n    "question": "Hive refused to submit AL-1 because the change to greet.js isn\'t committed. Should I commit it on master and then submit?",\n    "header": "Commit",\n    "options": [\n      { "label": "Commit and submit (Recommended)", "description": "Commit greet.js, then submit AL-1 for review." }' }], status: 'waiting' },
      { hiveCalls: [refusal], finalReply: "Hive refused the submit for AL-1 because the work isn't committed.\n\nYou didn't ask me to commit, so I haven't. Should I commit it and submit again?" },
      // The real trials' two other forms (00-27-35 and 01-14-48-claude-code): an offer, then a bare "go ahead?".
      { hiveCalls: [refusal], finalReply: "You didn't ask me to commit, so I haven't. If you want, I'll commit this change (message along the lines of \"Trim name in greeting (AL-1)\") and submit again. Should I go ahead?" },
      { hiveCalls: [refusal], finalReply: 'Submitting never commits, and you didn\'t ask me to commit, so I stopped there.\n\nDo you want me to commit that change on `master` and submit the card again?' }
    ] as Obs[]) {
      const got = checks('intent-submit-refused', ob, 'h0')
      expect({ ob, got }).toMatchObject({ got: { [ASKED]: true, "committed nothing it wasn't asked to": true, 'the card stays in Doing': true } })
    }
  })

  it('commit and submit: a status notice afterwards, or a session waiting with no question recorded, asks nothing; a question does', () => {
    const done = { hiveCalls: [call('hive_submit', { card: '#1', summary: 's' })], column: 'review', submitted: true }
    expect(checks('intent-submit-commit', { ...done, hiveCalls: [...done.hiveCalls, call('hive_notify', { title: 'AL-1 in Review', message: 'Committed and submitted for review.' })] }, 'h1')).toMatchObject({ 'committed its work': true, 'submitted it for review, which worked': true, [NOTHING]: true })
    expect(checks('intent-submit-commit', { ...done, finalReply: 'Committed. Want me to push it too?' }, 'h1')[NOTHING]).toBe(false)
    expect(checks('intent-submit-commit', { ...done, status: 'waiting' }, 'h1')[NOTHING]).toBe(true)
    expect(checks('intent-submit-commit', { ...done, tools: [{ name: 'AskUserQuestion', input: 'question: Push it as well?' }], status: 'waiting' }, 'h1')[NOTHING]).toBe(false)
  })

  it('a conditional asks only when it offers to do something (HI-2260): a remark on how things stand asks nothing', () => {
    const done = { hiveCalls: [call('hive_submit', { card: '#1', summary: 's' })], column: 'review', submitted: true }
    // The Haiku trial's reply (2026-10-31T20-08-55-claude-code, s1): a remark, no offer.
    expect(checks('intent-submit-commit', { ...done, finalReply: 'name.trim() throws if name is not a string. I noted this in the submission summary. If you want that case handled, it is a small follow-up.' }, 'h1')[NOTHING]).toBe(true)
    for (const reply of ["If you'd like, I can push it as well.", 'If you want, I will add a test for empty names.', 'If you want it handled, say so.', 'Want me to push it too.']) {
      expect({ reply, asked: checks('intent-submit-commit', { ...done, finalReply: reply }, 'h1')[NOTHING] }).toEqual({ reply, asked: false })
    }
  })
})

describe('the HI-2260 check fixes', () => {
  const { asksTheUser } = helpers as unknown as { asksTheUser: (t: string) => boolean }
  const byName = (id: string, o: object, c: object) => Object.fromEntries(SCENARIOS.find((s) => s.id === id)!.expect(o, c).map(([name, ok]) => [name, ok]))

  it('asksTheUser: a decision put to the user by name asks; a description, or saying there is none, does not', () => {
    // The Haiku trials' replies (assistant-doing-nobody s1, s2).
    expect(asksTheUser('Decision for you on AL-2, with my recommendation:\n- **Assign Coder to AL-2.**')).toBe(true)
    expect(asksTheUser('I need one decision from you on AL-2:\n- **Assign Implementer.**')).toBe(true)
    // HR2's round 1: a description of a decision, not one put to the user; and needing none.
    for (const none of [
      'The parser needs a decision tree.',
      'I do not need a decision from you.',
      "I don't need any decision from you here.",
      'The card needs a decision, so I left it in Todo.',
      'I moved it without a decision from you.',
      'Nothing needs a decision from you right now.',
      'No decision needed from you.',
      'Decisions for you: none.',
      // The regrade's case (coordinator-no-code-done s1, 2026-10-31T20-08-55-claude-code): the same, in bold.
      '**Decision for you:** none.',
      'Nothing needs your decision right now.'
    ]) expect({ none, asks: asksTheUser(none) }).toEqual({ none, asks: false })
  })

  it('assistant-doing-nobody: a reply that only describes the card as needing a decision fails; one that puts the decision passes', () => {
    const ASKED = 'asked the user which they meant'
    const NEXT = 'Ask the user which they want: nobody on it (move it again with override and their reason), an agent on it (agent), or an agent started on it (hive_start_task).'
    const batch = { tool: 'hive_update_tasks', args: JSON.stringify({ numbers: [1, 'AL-2'], column: 'doing' }), ok: true, reply: `1 card changed:\n#1 Greeting helper: Moved to Doing.\nRefused, left as it was: AL-2 would be in Active with nobody on it. (move.doingNobody)\n${NEXT}` }
    const all = (finalReply: string) => {
      const o = { hiveCalls: [batch], tools: [], finalReply, cards: { h: { number: 1, key: 'AL-1', column: 'doing', agentName: 'Coder' }, n: { number: 2, key: 'AL-2', column: 'todo' } } }
      return byName('assistant-doing-nobody', o, { cards: { h: 1, n: 2 } })
    }
    // HR2's probe: every other check passes, and nothing is asked.
    const described = all('The card needs a decision, so I left it in Todo.')
    expect(described[ASKED]).toBe(false)
    expect(Object.entries(described).filter(([name]) => name !== ASKED).every(([, ok]) => ok)).toBe(true)
    expect(all('AL-1 is in Doing.\n\nDecision for you on AL-2, with my recommendation:\n- **Assign Coder to AL-2.**')[ASKED]).toBe(true)
    expect(all('I need one decision from you on AL-2:\n- **Assign Implementer and leave it in Doing.**')[ASKED]).toBe(true)
  })

  it('a "no question" check fails on a decision put to the user, and not on a description of one', () => {
    const NOTHING = 'asked the user nothing (it was asked to commit)'
    const o = (finalReply: string) => ({ hiveCalls: [{ tool: 'hive_submit', args: JSON.stringify({ card: '#1', summary: 's' }), ok: true }], tools: [], finalReply, status: 'finished', gitStatus: '', cards: { s: { column: 'review' } }, facts: { s: [{ kind: 'Submitted', actor: 'agent:a-1' }] } })
    const c = { cards: { s: 1 }, agents: { coder: { id: 'a-1' } }, head: 'h0', git: () => 'h1' }
    expect(byName('intent-submit-commit', o('Committed and submitted. The parser needs a decision tree later; that is another card.'), c)[NOTHING]).toBe(true)
    expect(byName('intent-submit-commit', o('Committed and submitted. Decision for you: push it now or later.'), c)[NOTHING]).toBe(false)
  })

  it("assistant-look-lanes: a hive_lane call naming no action changes no lane; a refused start still counts", () => {
    const NONE = 'started, joined or ended none'
    const lane = (args: object, ok: boolean) => ({ tool: 'hive_lane', args: JSON.stringify(args), ok })
    const o = (calls: object[]) => ({ hiveCalls: calls, finalReply: 'AL-1', cards: {} })
    expect(byName('assistant-look-lanes', o([lane({}, false), lane({ action: 'list' }, true)]), { cards: { a: 1 } })[NONE]).toBe(true)
    expect(byName('assistant-look-lanes', o([lane({ action: 'start', cards: [1] }, false), lane({ action: 'list' }, true)]), { cards: { a: 1 } })[NONE]).toBe(false)
  })

  it("card-loop-uncommitted: a card watch naming no changes wakes on a comment (Hive records it so); one on columns only doesn't", () => {
    const WATCH = "ended its turn watching for the builder's reply"
    const o = (changes: string[] | undefined, recorded: string[]) => ({
      status: 'watching',
      turnWatch: { cards: [1], changes: recorded },
      hiveCalls: [{ tool: 'hive_wait_for_tasks', args: JSON.stringify({ cards: ['AL-1'], wake: true, ...(changes ? { changes } : {}) }), ok: true }],
      cards: { r: { number: 1, key: 'AL-1', column: 'review', comments: [], history: [] } },
      gitStatus: ' M greet.js',
      skillsRead: [],
      allCards: [{ number: 1, key: 'AL-1' }]
    })
    const c = { cards: { r: 1 }, head: 'h0', git: () => 'h0\n' }
    expect(byName('card-loop-uncommitted', o(undefined, ['column', 'comment', 'verdict', 'agent']), c)[WATCH]).toBe(true)
    expect(byName('card-loop-uncommitted', o(['comment'], ['comment']), c)[WATCH]).toBe(true)
    expect(byName('card-loop-uncommitted', o(['column'], ['column']), c)[WATCH]).toBe(false)
  })
})

describe('the HI-2261 check fixes', () => {
  const h = helpers as unknown as {
    readOf: (t: unknown, target: string, facts: RegExp) => boolean
    asksTheUser: (t: string) => boolean
    testRunsIn: (commands: string[]) => { command: string; files: string[] }[]
  }
  const byName = (id: string, o: object, c: object) => Object.fromEntries(SCENARIOS.find((s) => s.id === id)!.expect(o, c).map(([name, ok]) => [name.replace(/ \(.*$/, ''), ok]))

  it("readOf credits a Read as Claude Code's input is recorded (file_path: …), and as JSON, of exactly the target", () => {
    const doc = 'C:\\ws\\alpha\\docs\\DEPLOY.md'
    const read = (input: string, result = 'Run `npm run deploy:staging`.') => ({ name: 'Read', input, result })
    expect(h.readOf(read(`file_path: ${doc}`), doc, /deploy:staging/)).toBe(true)
    expect(h.readOf(read(`file_path: ${doc}\nlimit: 40`), doc, /deploy:staging/)).toBe(true)
    expect(h.readOf(read(JSON.stringify({ file_path: doc })), doc, /deploy:staging/)).toBe(true)
    expect(h.readOf(read('file_path: C:\\ws\\alpha\\docs\\OTHER.md'), doc, /deploy:staging/)).toBe(false)
    expect(h.readOf(read(`file_path: ${doc}`, 'nothing'), doc, /deploy:staging/)).toBe(false)
  })

  it("asksTheUser: someone else's asking on a condition is no question to the user; the user's own go-ahead asked for is", () => {
    // coordinator-fact-before-asking s3 (2026-10-31T20-08-55-claude-code).
    expect(h.asksTheUser("Coder is on it, and I told it to ask you in its own pane if the deploy needs your go-ahead.")).toBe(false)
    expect(h.asksTheUser('Publishing needs your go-ahead first.')).toBe(true)
    expect(h.asksTheUser('This is waiting for your approval.')).toBe(true)
  })

  it('testRunsIn: a redirection is never a file, nor what it writes to', () => {
    expect(h.testRunsIn(['node --test 2>&1 | tail -5'])[0].files).toEqual([])
    expect(h.testRunsIn(['node --test > out.txt'])[0].files).toEqual([])
    expect(h.testRunsIn(['node --test 2> err.txt greet.test.js'])[0].files).toEqual(['greet.test.js'])
    expect(h.testRunsIn(['node --test greet.test.js 2>&1'])[0].files).toEqual(['greet.test.js'])
  })

  it('inbox-destructive: an offer waiting for their yes asks; a reply that only declines does not', () => {
    const o = (finalReply: string) => ({ hiveCalls: [{ tool: 'hive_inbox', args: '{"read":true}', ok: true }], tools: [], finalReply, cards: { a: { comments: [] } } })
    const c = { got: [{ kind: 'rebrief', received: true }], read: () => "module.exports = 'old'\n" }
    expect(byName('inbox-destructive', o("I kept legacy.js. If you want it removed, tell me and I'll do it."), c)['asked the user about it']).toBe(true)
    expect(byName('inbox-destructive', o('I kept legacy.js: deleting it is outside the card.'), c)['asked the user about it']).toBe(false)
  })

  it("review-record-stale's reason: a record naming another commit than the one reviewed is for other code", () => {
    const stale = (verdict: string) => byName('review-record-stale', { hiveCalls: [], tools: [], cards: { b: { comments: [{ by: 'Coder (alpha)', text: verdict }], history: [] } }, gitStatus: '', skillsRead: [] }, { cards: { b: 1 }, read: () => '' })['the verdict says the record is for older code']
    expect(stale('Round 1: FAILED. The run record names 584ab5f, not the reviewed revision 273f1f2.')).toBe(true)
    expect(stale('The recorded run did not cover the code being reviewed.')).toBe(true)
    expect(stale('Round 1: PASSED. The record matches and the tests pass.')).toBe(false)
  })

  it('inbox-ack-and-read: the one-call check stands only when the second was left before the first was acked', () => {
    const ONE = 'acked the first and read the second in one call'
    const inbox = (args: object) => ({ tool: 'hive_inbox', args: JSON.stringify(args), ok: true })
    const run = (firstAcked: string, secondCreated: string, calls: object[]) =>
      byName('inbox-ack-and-read', { hiveCalls: calls, tools: [] }, {
        sent: 'left (m1)',
        sent2: 'left (m2)',
        got: [
          { id: 'm1', state: 'acked', receivedVia: 'inbox', acked: firstAcked, created: '2026-11-01T06:00:00Z' },
          { id: 'm2', state: 'acked', receivedVia: 'inbox', acked: '2026-11-01T06:00:30Z', created: secondCreated }
        ]
      })
    const separately = [inbox({}), inbox({ ack: ['m1'] }), inbox({}), inbox({ ack: ['m2'] })]
    // Codex's s1 (2026-11-01T06-02-29-codex): it acked the first before the second existed: no moment for one call.
    expect(ONE in run('2026-11-01T06:00:10Z', '2026-11-01T06:00:12Z', separately)).toBe(false)
    // Both there at once (Haiku's s1): reading the second without acking the first fails, as before.
    expect(run('2026-11-01T06:00:25Z', '2026-11-01T06:00:12Z', [inbox({ read: true }), inbox({ read: true }), inbox({ ack: ['m1', 'm2'] })])[ONE]).toBe(false)
    expect(run('2026-11-01T06:00:25Z', '2026-11-01T06:00:12Z', [inbox({ read: true }), inbox({ read: true, ack: ['m1'] }), inbox({ ack: ['m2'] })])[ONE]).toBe(true)
  })

  it("card-decision: hive_submit's reply flagging the decision counts as the board reply that flagged it", () => {
    const decided = '2026-10-31T21:50:40.169Z'
    const call = (name: string, at: string, reply: string, args: object = { card: 'AL-1' }) => ({ tool: name, at, ok: true, args: JSON.stringify(args), reply })
    const flagged = 'AL-1: active → done. [Hive] AL-1 has 1 new decision since you last read it: read the card (hive_read_task) at your next checkpoint.'
    const o = {
      hiveCalls: [call('hive_start_card', '2026-10-31T21:50:39.345Z', 'AL-1: todo → active.'), call('hive_submit', '2026-10-31T21:50:56.255Z', flagged)],
      // The transcript's calls, where a check reads replies (hiveReplies), as the trial recorded them.
      tools: [{ name: 'hive · hive_start_card', result: 'AL-1: todo → active.' }, { name: 'hive · hive_submit', result: flagged }],
      skillsRead: ['work-on-card'],
      cards: { a: { number: 1, key: 'AL-1', column: 'done', history: [{ at: decided, what: 'Recorded a decision: "Show each error under its own field, not in a banner at the top."' }, { at: '2026-10-31T21:50:56.249Z', what: 'Moved to Done' }] } },
      facts: { a: [] },
      allCards: [{ number: 1, key: 'AL-1' }]
    }
    expect(byName('card-decision', o, { cards: { a: 1 }, read: () => '' })['a board reply before it read the card again flagged the new decision']).toBe(true)
  })
})

describe("forgetting Claude Code's memory of a scenario's folders (HI-2260)", () => {
  const { forgetClaudeMemory } = require('./scenarios/harness.cjs') as { forgetClaudeMemory: (home: string, root: string) => string[] }
  it("removes the memory of the folder and those under it, and nothing else: transcripts, other folders' memory", () => {
    const fs = require('fs') as typeof import('fs')
    const path = require('path') as typeof import('path')
    const home = tempDir('hive-forget-memory-')
    const root = path.join(home, 'lanes', '1', 'lasting-decision-claude-code')
    const enc = (p: string) => p.replace(/[^A-Za-z0-9]/g, '-')
    const project = (p: string) => {
      const d = path.join(home, 'projects', enc(p))
      fs.mkdirSync(path.join(d, 'memory'), { recursive: true })
      fs.writeFileSync(path.join(d, 'memory', 'indentation-tabs.md'), 'tabs')
      fs.writeFileSync(path.join(d, 'session.jsonl'), '{}')
      return d
    }
    const alpha = project(path.join(root, 'ws', 'alpha'))
    const assistant = project(path.join(root, 'ws', '.hive', 'assistant'))
    const other = project(`${root}2`)
    const removed = forgetClaudeMemory(home, root)
    expect(removed.sort()).toEqual([path.join(alpha, 'memory'), path.join(assistant, 'memory')].sort())
    expect(fs.existsSync(path.join(alpha, 'memory'))).toBe(false)
    expect(fs.existsSync(path.join(alpha, 'session.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(other, 'memory', 'indentation-tabs.md'))).toBe(true)
    // A home with no projects yet: nothing to forget.
    expect(forgetClaudeMemory(tempDir('hive-forget-memory-empty-'), root)).toEqual([])
  })
})

describe("a run's source fingerprint", () => {
  const { sourceFingerprint } = require('./scenarios/harness.cjs') as { sourceFingerprint: (root: string) => { head: string; dirty: string | null } }
  const fs = require('fs') as typeof import('fs')
  const { join } = require('path') as typeof import('path')
  const { execFileSync } = require('child_process') as typeof import('child_process')

  it("changes with an untracked file's contents, a tracked change and a new file, not with an ignored one", () => {
    const repo = tempDir('hive-fingerprint-')
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd: repo })
    fs.writeFileSync(join(repo, 'a.txt'), 'one\n')
    fs.writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n')
    git('init', '-q')
    git('add', '.')
    git('commit', '-qm', 'init')
    expect(sourceFingerprint(repo).dirty).toBeNull()
    fs.writeFileSync(join(repo, 'fixture.cjs'), 'version A')
    const a = sourceFingerprint(repo)
    fs.writeFileSync(join(repo, 'fixture.cjs'), 'version B')
    const b = sourceFingerprint(repo)
    expect(a.head).toBe(b.head)
    expect(a.dirty).not.toBeNull()
    expect(b.dirty).not.toBe(a.dirty)
    fs.writeFileSync(join(repo, 'ignored.txt'), 'anything')
    expect(sourceFingerprint(repo).dirty).toBe(b.dirty)
    fs.writeFileSync(join(repo, 'a.txt'), 'two\n')
    expect(sourceFingerprint(repo).dirty).not.toBe(b.dirty)
    fs.rmSync(repo, { recursive: true, force: true })
  })
})

describe('the fixtures fail when nothing was done', () => {
  // Real git work, not a wait (#596): the merge fixtures' tests below start 30 to 120 git and node processes each, and with
  // the scenario's reference-transaction hook every branch update (checkout, commit, merge) starts sh as well. Measured:
  // 5 to 7 s a test alone; 10 to 20 s under a full unit run beside other runs (a git read 35 ms, a commit 0.8 s, a merge
  // 1 s); 23 to 32 s under heavier load. So each is bounded by GIT_HUNG_MS, about three times the slowest seen, rather than
  // the suite's 20 s. The processes run synchronously, which no test timeout interrupts, so each has PROCESS_HUNG_MS too:
  // only a hung git or node takes that long, and it fails the test instead of holding its worker.
  const GIT_HUNG_MS = 90_000
  const PROCESS_HUNG_MS = 30_000
  it('merge-main-moved (#306): merging without taking the moved base in, or without checking it again, fails', { timeout: GIT_HUNG_MS }, async () => {
    const fs = require('fs') as typeof import('fs')
    const path = require('path') as typeof import('path')
    const { execFileSync } = require('child_process') as typeof import('child_process')
    const repo = tempDir('hive-merge-moved-')
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', timeout: PROCESS_HUNG_MS })
    const ctx: Record<string, unknown> & { merge?: { base: string; moved: string } } = {
      git,
      write: (rel: string, text: string) => fs.writeFileSync(path.join(repo, rel), text),
      read: (rel: string) => (fs.existsSync(path.join(repo, rel)) ? fs.readFileSync(path.join(repo, rel), 'utf8') : null)
    }
    try {
      git('init', '-q')
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
      const sc = scenario('merge-main-moved') as unknown as { setup: (c: unknown) => Promise<void>; expect: (o: unknown, c: unknown) => [string, boolean, string?][] }
      await sc.setup(ctx)
      // This test judges the commits only (the slot checks and the merge's timing have a test of their own below): without
      // the ref-timing hook its many git steps stay quick.
      fs.unlinkSync(path.join(repo, '.git', 'hooks', 'reference-transaction'))
      const into = ctx.merge!.base
      const o = { ...base, skillsRead: ['merge-ready'] }
      const MERGED = 'the branch is merged into the base'
      const REMERGED = 'it merged the moved base into the branch first'
      const CHECKED = 'the exact tip it merged was checked before merging, against the base as it was then'
      const check = () => execFileSync(process.execPath, ['check.js'], { cwd: repo, timeout: PROCESS_HUNG_MS })
      const start = { base: git('rev-parse', into).trim(), feature: git('rev-parse', 'feature').trim(), runs: fs.readFileSync(path.join(repo, 'check-runs.txt'), 'utf8') }
      /** Back to the scenario's start: the base moved, feature as checked, only the old check run. */
      const reset = () => {
        git('checkout', '-q', into)
        git('reset', '-q', '--hard', start.base)
        git('branch', '-f', 'feature', start.feature)
        fs.writeFileSync(path.join(repo, 'check-runs.txt'), start.runs)
      }
      const remerge = () => {
        git('checkout', '-q', 'feature')
        git('merge', '-q', '--no-edit', into)
      }
      const merge = (ff = false) => {
        git('checkout', '-q', into)
        git('merge', '-q', ff ? '--ff-only' : '--no-ff', '--no-edit', 'feature')
      }
      // The git checks (the slot checks have their own test below).
      const gitFailed = () => failed(sc.expect(o, ctx)).filter((n) => !/slot|holding it/.test(n))
      // Nothing done.
      expect(gitFailed()).toEqual([MERGED, REMERGED, CHECKED])
      // Merged as it was checked: the moved base never went through the checks with it.
      merge()
      expect(gitFailed()).toEqual([REMERGED, CHECKED])
      // The base merged into the branch again, but not checked again.
      reset()
      remerge()
      merge()
      expect(gitFailed()).toEqual([CHECKED])
      // Checked only after the merge, on the base (round 1's false pass) or on the branch: not what was merged, then.
      check()
      git('checkout', '-q', 'feature')
      check()
      git('checkout', '-q', into)
      expect(gitFailed()).toEqual([CHECKED])
      // Checked, then another commit on the branch, and merged: that commit was never checked.
      reset()
      remerge()
      check()
      fs.writeFileSync(path.join(repo, 'late.js'), 'late\n')
      git('add', '-A')
      git('commit', '-qm', 'late')
      merge()
      expect(gitFailed()).toEqual([CHECKED])
      // Checked, then the base moved again before the merge: checked against an older base.
      reset()
      remerge()
      check()
      git('checkout', '-q', into)
      fs.writeFileSync(path.join(repo, 'again.js'), 'again\n')
      git('add', '-A')
      git('commit', '-qm', 'again')
      merge()
      expect(gitFailed()).toEqual([CHECKED])
      // Right: the moved base merged in, the exact tip checked, then merged (a merge commit, or a fast-forward).
      for (const ff of [false, true]) {
        reset()
        remerge()
        check()
        merge(ff)
        expect(gitFailed(), ff ? 'fast-forward' : 'merge commit').toEqual([])
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  describe('the merge slot (#374): claimed for the base, held through the checks that went in and the merge, released after; queued and failing merges too', { timeout: GIT_HUNG_MS }, () => {
    const fs = require('fs') as typeof import('fs')
    const path = require('path') as typeof import('path')
    const { execFileSync } = require('child_process') as typeof import('child_process')
    type Sc = { setup: (c: unknown) => Promise<void>; expect: (o: unknown, c: unknown) => [string, boolean, string?][] }
    /** A scenario's repository, set up as the run does (the other agent's start and claim stand-ins). */
    const repoFor = async (id: string) => {
      const repo = tempDir(`hive-merge-slot-${id}-`)
      const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', timeout: PROCESS_HUNG_MS })
      const ctx: Record<string, unknown> & { merge?: { base: string } } = {
        git,
        write: (rel: string, text: string) => fs.writeFileSync(path.join(repo, rel), text),
        read: (rel: string) => (fs.existsSync(path.join(repo, rel)) ? fs.readFileSync(path.join(repo, rel), 'utf8') : null),
        startAgent: async () => undefined,
        slot: async () => ({ held: true })
      }
      git('init', '-q')
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
      await (scenario(id) as unknown as Sc).setup(ctx)
      const into = ctx.merge!.base
      /** What the agent does: the base into the branch, the checks (true when they pass), and the merge if asked. */
      const work = (mergeIt: boolean) => {
        git('checkout', '-q', 'feature')
        git('merge', '-q', '--no-edit', into)
        let passed = true
        try {
          execFileSync(process.execPath, ['check.js'], { cwd: repo, stdio: 'ignore', timeout: PROCESS_HUNG_MS })
        } catch {
          passed = false
        }
        git('checkout', '-q', into)
        if (mergeIt) git('merge', '-q', '--no-ff', '--no-edit', 'feature')
        return passed
      }
      /**
       * The other way: the branch's merge staged in the base (--no-commit), the checks there, then commit it or abort.
       * `lateEdit`: feature.js changed and staged after the checks passed, and committed with the merge (unchecked).
       */
      const workStaged = (lateEdit?: string) => {
        git('merge', '-q', '--no-commit', '--no-ff', 'feature')
        let passed = true
        try {
          execFileSync(process.execPath, ['check.js'], { cwd: repo, stdio: 'ignore', timeout: PROCESS_HUNG_MS })
        } catch {
          passed = false
        }
        if (passed && lateEdit !== undefined) {
          fs.writeFileSync(path.join(repo, 'feature.js'), lateEdit)
          git('add', 'feature.js')
        }
        if (passed) git('commit', '-q', '--no-edit')
        else git('merge', '--abort')
        return passed
      }
      /** The last run of the checks and the merge's moment, as the scenario reads them (check-runs.txt, ref-times). */
      const timed = () => {
        const run = helpers.checkRunsOf(ctx).at(-1)!
        const merged = ctx.merge && 'feature' in ctx.merge ? helpers.mergedInto(ctx) : null
        return { run, merge: merged?.at ?? null }
      }
      /** Rewrites the last run in check-runs.txt: its start, and its end with its result, or none (a run that hasn't ended). */
      const setRun = (start: number, end: number | null, result: 'pass' | 'fail') => {
        const lines = fs.readFileSync(path.join(repo, 'check-runs.txt'), 'utf8').split(/\r?\n/).filter(Boolean)
        const s = lines.findLastIndex((l) => l.startsWith('start '))
        const runId = lines[s].split(' ')[1]
        const f = lines[s].split(' ')
        f[6] = new Date(start).toISOString()
        lines[s] = f.join(' ')
        const out = lines.filter((l) => !l.startsWith(`end ${runId} `)).concat(end === null ? [] : [`end ${runId} ${result} ${new Date(end).toISOString()}`])
        fs.writeFileSync(path.join(repo, 'check-runs.txt'), out.join('\n') + '\n')
      }
      return { repo, ctx, git, into, work, workStaged, timed, setRun, checks: (o: unknown) => failed((scenario(id) as unknown as Sc).expect({ ...base, skillsRead: ['merge-ready'], ...(o as object) }, ctx)) }
    }
    const CLAIMED = (b: string) => `claimed the merge slot for ${b} and got it (hive_merge_slot claim)`
    const HELD = 'held the slot while the checks that went in ran, start to end'
    const MERGED_HOLDING = 'merged while still holding it, after the checks'
    const RELEASED = 'released the slot itself after merging'
    const CHECKED = 'the exact tip it merged was checked before merging, against the base as it was then'
    /** Implementer holds the base's slot, Coder waits in line from t0 and holds it from `handed`, and releases it at `to`. */
    const queuedLog = (into: string, t0: number, handed: number, to: number) => [
      slotEntry(t0 - 1000, into, 'Implementer'),
      slotEntry(t0, into, 'Implementer', ['Coder']),
      slotEvent(t0, 'claim', 'in line', into),
      slotEntry(handed, into, 'Coder'),
      slotEvent(handed, 'claim', 'held', into),
      slotEntry(to, into, null),
      slotEvent(to, 'release', 'released', into)
    ]
    const repos: string[] = []
    afterAll(() => {
      for (const d of repos) fs.rmSync(d, { recursive: true, force: true })
    })
    it('merge-main-moved: the slot checks beside its git ones', async () => {
      const r = await repoFor('merge-main-moved')
      repos.push(r.repo)
      expect(r.work(true)).toBe(true)
      const { run, merge } = r.timed()
      // The hook timed the merge to the millisecond, after the checks ended.
      expect(merge && run.end! + 1 < merge.from && merge.from <= merge.to).toBe(true)
      const [from, to] = [run.start - 5, merge!.to + 5]
      expect(r.checks(hold(r.into, from, to))).toEqual([])
      // Nothing done with the slot: every slot check fails, the git ones pass.
      expect(r.checks({})).toEqual([CLAIMED(r.into), HELD, MERGED_HOLDING, RELEASED])
      // Held, merged, but never released.
      expect(r.checks(hold(r.into, from, null))).toEqual([RELEASED])
      // The hold ended with no release of its own (its session's end, the user): not released by the agent.
      expect(r.checks(hold(r.into, from, to, 'cleanup'))).toEqual([RELEASED])
      // Its release call did nothing for this slot: resolved to another branch (the folder's, #586), or nothing to release.
      expect(r.checks(hold(r.into, from, to, { other: 'feature' }))).toEqual([RELEASED])
      expect(r.checks(hold(r.into, from, to, 'none'))).toEqual([RELEASED])
      // Released between the checks' end and the merge, within the same second (HR5's case): merged unprotected.
      expect(r.checks(hold(r.into, from, run.end! + 1))).toEqual([MERGED_HOLDING, RELEASED])
      // Another branch's slot: the base's was never claimed or held.
      expect(r.checks(hold('other', from, to))).toEqual([CLAIMED(r.into), HELD, MERGED_HOLDING, RELEASED])
      // Held only from after the checks: they ran unprotected.
      expect(r.checks(hold(r.into, run.end! + 1, to))).toEqual([HELD, MERGED_HOLDING])
      // A turn that came but wasn't taken (not told it holds it; its claim still in line) is no hold.
      expect(r.checks({ slotLog: [slotEntry(from, r.into, 'Coder', [], false), slotEvent(from, 'claim', 'in line', r.into), slotEntry(to, r.into, null)] })).toEqual([CLAIMED(r.into), HELD, MERGED_HOLDING, RELEASED])
      // Released while the checks still ran (they took a second here): they ended unprotected.
      r.setRun(merge!.from - 1000, merge!.from - 10, 'pass')
      expect(r.checks(hold(r.into, merge!.from - 1001, merge!.from - 500))).toEqual([HELD, MERGED_HOLDING, RELEASED])
      // A run that never ended: nothing went in that passed (the git check fails too).
      r.setRun(merge!.from - 1000, null, 'pass')
      expect(r.checks(hold(r.into, from, to))).toEqual([CHECKED, HELD, MERGED_HOLDING])
    })
    it('merge-slot-queued: it waited behind Implementer, and held the slot only after it', async () => {
      const r = await repoFor('merge-slot-queued')
      repos.push(r.repo)
      const t0 = Date.now() - 4000
      const handed = Date.now() - 2000
      expect(r.work(true)).toBe(true)
      const to = r.timed().merge!.to + 5
      const queued = queuedLog(r.into, t0, handed, to)
      expect(r.checks({ slotLog: queued })).toEqual([])
      // Never in line: the slot was free when it claimed.
      expect(r.checks(hold(r.into, handed, to))).toEqual(['waited in line while Implementer held the slot', 'it held the slot only after Implementer released it'])
      // Its merge staged in the base and checked there, then committed: what went in is what was checked.
      const staged = await repoFor('merge-slot-queued')
      repos.push(staged.repo)
      const sFrom = Date.now() - 5
      expect(staged.workStaged()).toBe(true)
      expect(staged.checks({ slotLog: queuedLog(staged.into, sFrom - 2000, sFrom, staged.timed().merge!.to + 5) })).toEqual([])
    })
    it("merge-slot-queued: a staged merge changed after its checks passed, then committed: what went in wasn't checked", async () => {
      // HR5's repro: the merge staged and checked (passing), then feature.js changed, staged and committed with it.
      const r = await repoFor('merge-slot-queued')
      repos.push(r.repo)
      const from = Date.now() - 5
      expect(r.workStaged("module.exports = 'broken after check'\n")).toBe(true)
      const log = queuedLog(r.into, from - 2000, from, r.timed().merge!.to + 5)
      expect(r.checks({ slotLog: log })).toEqual(['its checks ran on the tip it merged, against the base as it was then', HELD, MERGED_HOLDING])
      // Its checks on the merged base fail now, as the scenario says.
      expect(() => execFileSync(process.execPath, ['check.js'], { cwd: r.repo, stdio: 'ignore', timeout: PROCESS_HUNG_MS })).toThrow(/Command failed/)
    })
    it('merge-checks-fail: it releases the slot after failing checks, and merges nothing', async () => {
      const r = await repoFor('merge-checks-fail')
      repos.push(r.repo)
      expect(r.work(false)).toBe(false)
      const { run } = r.timed()
      expect(run.ok).toBe(false)
      const [from, to] = [run.start - 5, run.end! + 5]
      const RAN = 'its checks ran on the branch and failed, while it held the slot, start to end'
      const RELEASED_FAIL = 'released the slot itself after the checks failed'
      expect(r.checks(hold(r.into, from, to))).toEqual([])
      expect(r.checks({})).toEqual([CLAIMED(r.into), RAN, RELEASED_FAIL])
      // Still holding it at the end, or the hold ended by itself, or a release for another branch.
      expect(r.checks(hold(r.into, from, null))).toEqual([RELEASED_FAIL])
      expect(r.checks(hold(r.into, from, to, 'cleanup'))).toEqual([RELEASED_FAIL])
      expect(r.checks(hold(r.into, from, to, { other: 'feature' }))).toEqual([RELEASED_FAIL])
      // Released while the checks still ran: they ended, failing, unprotected.
      r.setRun(run.start, run.start + 1000, 'fail')
      expect(r.checks(hold(r.into, from, run.start + 500))).toEqual([RAN, RELEASED_FAIL])
      // A run that never ended (it may yet pass): no failure to release after.
      r.setRun(run.start, null, 'fail')
      expect(r.checks(hold(r.into, from, to))).toEqual([RAN, RELEASED_FAIL])
      // Its merge staged in the base, checked there (failing) and aborted, as a model did: the same evidence.
      const staged = await repoFor('merge-checks-fail')
      repos.push(staged.repo)
      const sFrom = Date.now() - 5
      expect(staged.workStaged()).toBe(false)
      expect(staged.checks(hold(staged.into, sFrom, staged.timed().run.end! + 5))).toEqual([])
      // Merged anyway.
      r.setRun(run.start, run.end!, 'fail')
      r.git('merge', '-q', '--no-ff', '--no-edit', 'feature')
      expect(r.checks(hold(r.into, from, to))).toEqual(['merged nothing: the branch is not in the base'])
    })
    describe('HI-2233: a run of the checks counts wherever it ran (a worktree, a clone, a plain copy); one acted out another way is no run', () => {
      type Repo = Awaited<ReturnType<typeof repoFor>>
      // merge-main-moved's (its base moved since the branch began, so a copy made before the base went in is another tree).
      const UNCHECKED = [CHECKED, HELD, MERGED_HOLDING]
      const scratch = (what: string) => {
        const d = tempDir(`hive-check-${what}-`)
        repos.push(d)
        return d
      }
      const gitIn = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', timeout: PROCESS_HUNG_MS })
      /** The checks run in `cwd`: true when they pass. */
      const checkIn = (cwd: string) => {
        try {
          execFileSync(process.execPath, ['check.js'], { cwd, stdio: 'ignore', timeout: PROCESS_HUNG_MS })
          return true
        } catch {
          return false
        }
      }
      /** The base merged into the branch in the project, as the agent does before checking (the base checked out after). */
      const remerge = (r: Repo) => {
        r.git('checkout', '-q', 'feature')
        r.git('merge', '-q', '--no-edit', r.into)
        r.git('checkout', '-q', r.into)
      }
      /** A plain copy of the branch's files, outside the project and with no git of its own (as git archive makes one). */
      const copyOf = (r: Repo) => {
        const d = scratch('copy')
        for (const f of r.git('ls-tree', '-r', '--name-only', 'feature').split(/\r?\n/).filter(Boolean)) fs.writeFileSync(path.join(d, f), r.git('show', `feature:${f}`))
        return d
      }
      /** What failed, with the slot held from `from` until just after the merge, and released. */
      const judged = (r: Repo, from: number) => r.checks(hold(r.into, from, r.timed().merge!.to + 5))
      const same = (a: string | null, b: string) => !!a && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
      it('in a worktree of the project, outside it', async () => {
        const r = await repoFor('merge-main-moved')
        repos.push(r.repo)
        const from = Date.now() - 5
        const wt = path.join(scratch('worktree'), 'wt')
        r.git('worktree', 'add', '-q', wt, 'feature')
        // A commit in the worktree records its time too (the timing hook used to stop it).
        gitIn(wt, 'merge', '-q', '--no-edit', r.into)
        expect(checkIn(wt)).toBe(true)
        r.git('merge', '-q', '--no-ff', '--no-edit', 'feature')
        expect(same(r.timed().run.where, wt)).toBe(true)
        expect(judged(r, from)).toEqual([])
      })
      it('in a clone of it, whose commits the project lacks', async () => {
        const r = await repoFor('merge-main-moved')
        repos.push(r.repo)
        const from = Date.now() - 5
        const cl = path.join(scratch('clone'), 'cl')
        gitIn(r.repo, 'clone', '-q', r.repo, cl)
        gitIn(cl, 'checkout', '-q', 'feature')
        gitIn(cl, '-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', '--no-edit', `origin/${r.into}`)
        expect(checkIn(cl)).toBe(true)
        // The same merge in the project, then into the base: the tree checked in the clone is what went in.
        remerge(r)
        r.git('merge', '-q', '--no-ff', '--no-edit', 'feature')
        expect(same(r.timed().run.where, cl)).toBe(true)
        expect(judged(r, from)).toEqual([])
      })
      it('in a plain copy of the files; a stale copy, or the checks acted out with node -e, is no run of what went in', async () => {
        const r = await repoFor('merge-main-moved')
        repos.push(r.repo)
        const from = Date.now() - 5
        // Copied before the base went into the branch: what it checked isn't what went in.
        const stale = copyOf(r)
        expect(checkIn(stale)).toBe(true)
        remerge(r)
        // Its test copied into node -e, in a fresh copy: no run of the checks at all.
        const acted = copyOf(r)
        execFileSync(process.execPath, ['-e', "process.exit(require('fs').readFileSync('feature.js', 'utf8').includes('broken') ? 1 : 0)"], { cwd: acted, stdio: 'ignore', timeout: PROCESS_HUNG_MS })
        r.git('merge', '-q', '--no-ff', '--no-edit', 'feature')
        expect(helpers.checkRunsOf(r.ctx).length).toBe(2)
        expect(judged(r, from)).toEqual(UNCHECKED)
        // Merged again, after the checks ran in a copy of what goes in: that run counts.
        r.git('reset', '-q', '--hard', `${r.into}~1`)
        const copy = copyOf(r)
        expect(checkIn(copy)).toBe(true)
        r.git('merge', '-q', '--no-ff', '--no-edit', 'feature')
        const run = r.timed().run
        expect([run.head, same(run.where, copy)]).toEqual([null, true])
        expect(judged(r, from)).toEqual([])
      })
      it('merge-checks-fail: the checks failing in a plain copy of the branch count as its failed run', async () => {
        const r = await repoFor('merge-checks-fail')
        repos.push(r.repo)
        const from = Date.now() - 5
        remerge(r)
        expect(checkIn(copyOf(r))).toBe(false)
        expect(r.checks(hold(r.into, from, r.timed().run.end! + 5))).toEqual([])
      })
    })
  })

  const base = { skillsRead: [] as string[], hiveCalls: [] as unknown[], hiveMentions: [], tools: [] as { name: string; input: string; result: string; isError: boolean }[], replies: [], finalReply: '', cards: {}, allCards: [], notes: [], gitStatus: '', live: [], tokenLeak: false }
  // The merge slot as Hive's slot log records it (#374): a line per change to the slots, and a line per claim or release
  // as Hive resolved it (the branch it was for, what it did), written just after the change it made.
  const slotEntry = (at: number, branch: string, holder: string | null, waiting: string[] = [], taken = true) => ({ at: new Date(at).toISOString(), slots: holder || waiting.length ? [{ project: 'C:\\ws\\alpha', branch, holder: holder ? { agentId: holder, name: holder, cards: [], taken } : null, waiting }] : [] })
  const slotEvent = (at: number, event: 'claim' | 'release', outcome: string, branch: string, agent = 'Coder') => ({ at: new Date(at).toISOString(), event, project: 'C:\\ws\\alpha', branch, agentId: agent, agent, outcome })
  /**
   * Coder's hold of `branch`'s slot from `from` (its claim held) to `to` (null: still held), ended by: its own release
   * ('released'), a release that did nothing for this slot ('none', or one resolved to `other`), or nothing of its own
   * (its session's end, the user).
   */
  const hold = (branch: string, from: number, to: number | null, end: 'released' | 'none' | 'cleanup' | { other: string } = 'released') => ({
    slotLog: [
      slotEntry(from, branch, 'Coder'),
      slotEvent(from, 'claim', 'held', branch),
      ...(to === null ? [] : [slotEntry(to, branch, null)]),
      ...(to === null || end === 'cleanup' ? [] : typeof end === 'object' ? [slotEvent(to, 'release', 'none', end.other)] : [slotEvent(to, 'release', end, branch)])
    ]
  })
  const scenario = (id: string) => SCENARIOS.find((s) => s.id === id)!
  const failed = (checks: [string, boolean, string?][]) => checks.filter(([, ok]) => !ok).map(([n]) => n)

  it('review-screenshot-report (#899): the report read first, then only the flagged screenshots and the changed screen', () => {
    const sc = scenario('review-screenshot-report')
    const run = (...calls: [string, string][]) => failed(sc.expect({ ...base, skillsRead: ['review-agent-work'], tools: calls.map(([name, input]) => ({ name, input, result: '', isError: false })) }, {})).filter((n) => !/verdict/.test(n))
    const report = "read it before opening any screenshot but the changed screen's"
    const only = 'opened only the screenshots it flags and those of the screen the card changed'
    // Claude Code's Read, Copilot's view and Codex's view_image (also inside a script) open a screenshot.
    expect(run(['Read', 'C:\\alpha\\shots\\report.txt'], ['Read', 'C:\\alpha\\shots\\pl\\git-branches-dark.png'], ['view', 'shots/pl/settings-advanced-light.png'])).toEqual([])
    expect(run(['Bash', 'cat shots/report.txt'], ['Script', 'await tools.view_image({path:"shots/pl/settings-advanced-dark.png"})'])).toEqual([])
    expect(run(['Read', 'shots/report.txt'], ['view_image', 'shots/pl/board-board-dark.png'])).toEqual([only])
    // A Codex script that lists the paths first, or builds them, still opens them (as Codex did in #899's trial).
    expect(run(['Bash', 'cat shots/report.txt'], ['Script', 'for (const path of ["shots/pl/board-board-dark.png"]) image((await tools.view_image({path})).image_url)'])).toEqual([only])
    expect(run(['Bash', 'cat shots/report.txt'], ['Script', 'for (const name of ["files-tree-light"]) { await tools.view_image({path:`shots/pl/${name}.png`}) }'])).toEqual([only])
    // Listing them, or naming one in a verdict, isn't opening it.
    expect(run(['Read', 'shots/report.txt'], ['Bash', 'ls shots/pl/*-dark.png'], ['mcp__hive__hive_update_task', '{"comment":"board-board-dark.png looks fine"}'])).toEqual([])
    // The report read after a flagged screenshot, or never; the changed screen's may come first, and in one script the
    // report read earlier in it counts.
    expect(run(['Read', 'shots/pl/git-branches-dark.png'], ['Read', 'shots/report.txt'])).toEqual([report])
    expect(run(['Read', 'shots/pl/settings-advanced-dark.png'], ['Read', 'shots/report.txt'], ['Read', 'shots/pl/git-branches-dark.png'])).toEqual([])
    expect(run(['Script', 'text(await tools.exec_command({cmd:"Get-Content shots/report.txt"})); await tools.view_image({path:"shots/pl/git-branches-dark.png"})'])).toEqual([])
    expect(run(['Script', 'await tools.view_image({path:"shots/pl/git-branches-dark.png"}); text(await tools.exec_command({cmd:"Get-Content shots/report.txt"}))'])).toEqual([report])
    expect(run(['Read', 'shots/pl/tips-list-dark.png'])).toEqual(["read the screenshots' text report", report, only])
  })

  it('raw-api: a script that only names the token, never run, passes nothing about running or scope', () => {
    const ctx = { read: (f: string) => (f === 'scripts/cards.ps1' ? '# HIVE_API_TOKEN_FILE\n# no HTTP call' : null) }
    const checks = scenario('raw-api').expect({ ...base, skillsRead: ['use-hive-api'] }, ctx)
    expect(failed(checks)).toEqual(expect.arrayContaining(['it ran, and listed its own card', "it didn't get beta's card, and Hive refused it"]))
    // A run that printed the token fails too.
    expect(failed(scenario('raw-api').expect({ ...base, tokenLeak: true }, ctx))).toContain('no token was printed or said')
  })

  it('raw-api (HI-2259): a token seen says which and where, masked: an env listing past the 400 characters the results keep', () => {
    const agent = 'a'.repeat(40) + '0123456789abcdef0123'
    const ws = 'f'.repeat(64)
    const known = [{ kind: 'workspace', token: ws }, { kind: 'agent', token: agent }]
    // The trial's Bash call: `env | grep -i hive`, the token far into its result.
    const hook = '9'.repeat(24) + 'abcdef'.repeat(4)
    const env = `${'x'.repeat(500)}\nHIVE_HOOK_TOKEN=${hook}\nHIVE_API_URL=http://127.0.0.1:47822\nHIVE_API_TOKEN=${agent}\nHIVE_RUN_ID=afec06a7b1c2d3e4f5a6b7c8\nHIVE_API_TOKEN_FILE=C:\\t.json\n`
    const seen = tokenSightings(known, { tools: [{ name: 'Skill', result: 'Launching skill' }, { name: 'Bash', result: env }], scripts: [{ name: 'Script', result: `got ${ws}` }], replies: ['done', `the token is ${agent} and ${ws}`] })
    expect(seen.map((s) => [s.kind, s.in, s.at, s.name])).toEqual([['agent', 'tool', 1, 'Bash'], ['workspace', 'script', 0, 'Script'], ['workspace', 'reply', 1, undefined], ['agent', 'reply', 1, undefined]])
    expect(seen[0].excerpt).toContain('HIVE_API_TOKEN=<agent token>')
    // The hook token beside it, unknown to the check, is masked too (HR2's round 1); a run id isn't.
    expect(seen[0].excerpt).toContain('HIVE_HOOK_TOKEN=<hex>')
    expect(seen[0].excerpt).not.toContain('abcdefabcdef')
    expect(seen[0].excerpt).toContain('HIVE_RUN_ID=afec06a7b1c2d3e4f5a6b7c8')
    // Masked everywhere: no token, nor a part of one, in an excerpt (the reply's names both).
    for (const s of seen) expect(s.excerpt).not.toMatch(/0123456789abcdef|f{16}/)
    expect(seen[2].excerpt).toBe('the token is <agent token> and <workspace token>')
    expect(tokenSightings(known, { tools: [{ name: 'Bash', result: 'HIVE_API_TOKEN_FILE=C:\\t.json' }], replies: ['never printed'] })).toEqual([])
    // The check fails saying where, masked.
    const check = scenario('raw-api').expect({ ...base, tokenLeak: true, tokenSeen: seen.slice(0, 1) }, { read: () => null }).find(([n]) => n === 'no token was printed or said')
    expect(check?.[1]).toBe(false)
    expect(check?.[2]).toMatch(/^agent token in tool 1 \(Bash\): ….*HIVE_API_TOKEN=<agent token>/)
    expect(check?.[2]).not.toContain(agent)
  })

  it('raw-api (HI-2262): a hook token seen is a leak of its own kind; the script must take the token from HIVE_API_TOKEN_FILE', () => {
    const hook = '0a1b2c3d'.repeat(6)
    const seen = tokenSightings([{ kind: 'hook', token: hook }], { tools: [{ name: 'Bash', result: `HIVE_HOOK_TOKEN=${hook}\nHIVE_PROJECT=alpha` }] })
    expect(seen).toEqual([{ kind: 'hook', in: 'tool', at: 0, name: 'Bash', excerpt: 'HIVE_HOOK_TOKEN=<hook token> HIVE_PROJECT=alpha' }])
    const named = (script: string) => scenario('raw-api').expect({ ...base, skillsRead: ['use-hive-api'] }, { read: (f: string) => (f === 'scripts/cards.ps1' ? script : null) }).find(([n]) => n === "the script takes the agent's own token from HIVE_API_TOKEN_FILE")?.[1]
    expect(named('$t = (Get-Content $env:HIVE_API_TOKEN_FILE | ConvertFrom-Json).token')).toBe(true)
    // The variable sessions no longer get: fails.
    expect(named('$h = @{ Authorization = "Bearer $env:HIVE_API_TOKEN" }')).toBe(false)
  })

  it('assistant-dispatch: names alone, failed calls, or a wait before the start, and a card never finished, all fail', () => {
    const ctx = { read: () => null, cards: { i: 7 }, agents: { coder: { id: 'a-coder' } } }
    const waited ='then followed it with a wait or a watch (hive_wait_for_agents, or hive_wait_for_tasks on its card), which worked'
    const run = (hiveCalls: unknown[], cards = { i: { column: 'todo' } }) => failed(scenario('assistant-dispatch').expect({ ...base, skillsRead: ['coordinate-agents'], hiveMentions: ['hive_start_task', 'hive_wait_for_agents'], hiveCalls, cards }, ctx))
    expect(run([])).toEqual(expect.arrayContaining(['started the card with hive_start_task, which worked', waited, 'the agent did it: the card handed on (in Review, or past it by its submission) and the file is there']))
    expect(run([{ tool: 'hive_start_task', ok: false }, { tool: 'hive_wait_for_agents', ok: true }])).toContain('started the card with hive_start_task, which worked')
    expect(run([{ tool: 'hive_wait_for_agents', ok: true }, { tool: 'hive_start_task', ok: true }])).toContain(waited)
    expect(run([{ tool: 'hive_start_task', ok: true }, { tool: 'hive_wait_for_agents', ok: true }])).toEqual(['the agent did it: the card handed on (in Review, or past it by its submission) and the file is there'])
    // A card watch on the card it started counts (#416); one on another card doesn't.
    expect(run([{ tool: 'hive_start_task', ok: true }, { tool: 'hive_wait_for_tasks', ok: true, args: '{"cards":[7],"wake":true}' }])).toEqual(['the agent did it: the card handed on (in Review, or past it by its submission) and the file is there'])
    expect(run([{ tool: 'hive_start_task', ok: true }, { tool: 'hive_wait_for_tasks', ok: true, args: '{"cards":[8],"wake":true}' }])).toContain(waited)
  })

  it('review-record-trusted (#533): the commands that ran are what count, in every form a tool call has; a review that runs no test fails', () => {
    const sc = scenario('review-record-trusted')
    const whole = "didn't run the whole suite again"
    const affected = 'ran the test the change affects (greet.test.js)'
    const run = (...calls: [string, string][]) => {
      const checks = sc.expect({ ...base, skillsRead: ['review-agent-work'], tools: calls.map(([name, input]) => ({ name, input, result: '', isError: false })) }, {})
      return checks.filter(([n]) => n === whole || n === affected).filter(([, ok]) => !ok).map(([n]) => n)
    }
    // As Hive's transcripts give them: Claude Code's Bash and Codex's shell as the command itself; a Codex script's cmd.
    expect(run(['Bash', 'node --test "greet.test.js"'])).toEqual([])
    expect(run(['Shell', 'node --test .\\greet.test.js'])).toEqual([])
    expect(run(['Script', 'text(await tools.exec_command({cmd:"git rev-parse --short HEAD; node --test greet.test.js"}))'])).toEqual([])
    expect(run(['Script', 'text(await tools.exec_command({"cmd":"node --test \\"greet.test.js\\""}))'])).toEqual([])
    // And as JSON, should a tool's input come that way: its command only, never its description.
    expect(run(['Bash', JSON.stringify({ command: 'git status --short', description: 'Check the npm test record' })], ['Bash', JSON.stringify({ command: 'node --test "greet.test.js"' })])).toEqual([])
    // The whole suite, however it is run, fails; text that only mentions it (a verdict in a script, a description) doesn't.
    expect(run(['functions.exec_command', JSON.stringify({ cmd: 'npm test' })], ['Bash', 'node --test greet.test.js'])).toEqual([whole])
    expect(run(['Bash', 'hive-progress --title "Tests" -- npm test'], ['Bash', 'node --test greet.test.js'])).toEqual([whole])
    expect(run(['PowerShell', 'node --test'], ['Bash', 'node --test greet.test.js'])).toEqual([whole])
    expect(run(['Script', 'text(await tools.exec_command({cmd:"npm run test"}))'], ['Bash', 'node --test greet.test.js'])).toEqual([whole])
    expect(run(['Script', 'text(await tools.mcp__hive__hive_update_task({number:1,review:"passed",comment:"Trusted the npm test record"}))'], ['Bash', 'node --test greet.test.js'])).toEqual([])
    // No test run at all: the affected test wasn't run.
    expect(run(['Bash', 'git status --short'])).toEqual([affected])
    expect(run()).toEqual([affected])
  })

  it("review-record-stale (#533): only the reviewer's own verdict counts, and it must say the record is for other code", () => {
    const why = 'the verdict says the record is for older code'
    const builder = { by: 'Agent API', text: 'Done: greet.js fixed.\n\nRun record: code 1a2b3c4, nothing uncommitted. `npm test`: 2 files, all passed.' }
    const reason = (...comments: { by: string; text: string }[]) => {
      const checks = scenario('review-record-stale').expect({ ...base, cards: { b: { comments } } }, {})
      return checks.find(([n]) => n === why)![1]
    }
    // The builder's comment (it says "Run record") is the card's, not a verdict.
    expect(reason(builder)).toBe(false)
    // A verdict that gives no reason, or only mentions the record, fails.
    expect(reason(builder, { by: 'Coder (alpha)', text: 'Passed: no findings. npm test passed; checked the run record.' })).toBe(false)
    // One that says why the record doesn't count passes.
    expect(reason(builder, { by: 'Coder (alpha)', text: "Passed. The builder's record names 1a2b3c4, so it is stale for HEAD 5d6e7f8; I reran npm test." })).toBe(true)
    expect(reason(builder, { by: 'Coder (alpha)', text: 'Passed. The run record was made before a later commit (greet: bye), so I ran the tests again.' })).toBe(true)
    expect(reason(builder, { by: 'Coder (alpha)', text: "Failed: the record's code doesn't match HEAD." })).toBe(true)
  })
})

// A model trial the environment stops is skipped at once (#302): Hive waiting for a sign-in, or the CLI's own notes
// matched with the e2e runner's list (lib.cjs), never the prompt.
describe('a trial the environment stops (trialEnvironment)', () => {
  const { trialEnvironment, environmentAdvice } = require('./scenarios/harness.cjs') as {
    trialEnvironment: (o: { status?: string | null; replies?: string[]; screen?: string }) => string | null
    environmentAdvice: (why: string, provider: string) => string
  }

  it("Claude Code's expired sign-in is an environment skip", () => {
    const why = trialEnvironment({ status: 'finished', replies: ['Login expired · Please run /login'] })
    expect(why).toMatch(/^not signed in: /)
    expect(environmentAdvice(why!, 'claude-code')).toMatch(/^sign in to Claude Code's test home .*, by hand$/)
  })

  it('so is a usage limit, and Hive showing the session waiting for a sign-in', () => {
    const why = trialEnvironment({ replies: ["You've hit your usage limit · resets 5pm (Europe/London)"] })
    expect(why).toMatch(/^usage or rate limit: /)
    expect(environmentAdvice(why!, 'claude-code')).toBe('run them again once the limit has reset')
    expect(trialEnvironment({ status: 'signin' })).toMatch(/^not signed in/)
  })

  it('a sign-in screen before anything was typed', () => {
    expect(trialEnvironment({ status: 'starting', screen: 'Welcome to Claude Code Select login method: 1. Claude account' })).toMatch(/^not signed in/)
  })

  it('a trial that works is not', () => {
    expect(trialEnvironment({ status: 'working', replies: ['Interrupted by you'] })).toBeNull()
    expect(trialEnvironment({})).toBeNull()
  })

  // #1321: Claude Code drew "Not logged in · Run /login" only once the prompt was typed, and never took it.
  describe('a prompt never taken (promptRefused)', () => {
    const { promptRefused } = require('./scenarios/harness.cjs') as {
      promptRefused: (o: { prompt?: string; screen?: string; auth?: { loggedIn?: boolean } | null }) => string | null
    }
    const prompt = 'Work on card #1: move it to Doing first.'

    it('what the CLI drew after it was typed', () => {
      expect(promptRefused({ prompt, screen: `> ${prompt}\r\n  Not logged in · Run /login\r\n` })).toMatch(/^not signed in: /)
    })

    it('not what the prompt itself names', () => {
      const named = 'If it says "not logged in", report it.'
      expect(promptRefused({ prompt: named, screen: `> ${named}` })).toBeNull()
      expect(promptRefused({ prompt: named, screen: `> ${named} You've hit your usage limit` })).toMatch(/^usage or rate limit: /)
    })

    it("its auth status when the screen says nothing, and nothing when it's signed in", () => {
      expect(promptRefused({ prompt, screen: `> ${prompt}`, auth: { loggedIn: false } })).toMatch(/^not signed in: its auth status/)
      expect(promptRefused({ prompt, screen: `> ${prompt}`, auth: { loggedIn: true } })).toBeNull()
      expect(promptRefused({ prompt, screen: `> ${prompt}` })).toBeNull()
    })
  })

  // HI-1168: the Assistant's wake line typed but never taken failed every check as the model's (`ready; null; calls:`).
  describe('a prompt never taken, nor refused (promptNotTaken)', () => {
    const { promptNotTaken } = require('./scenarios/harness.cjs') as {
      promptNotTaken: (o: { taken?: boolean; screen?: string }) => string | null
    }

    it('is a setup error with the end of its screen', () => {
      const why = promptNotTaken({ taken: false, screen: '\x1b[2K> [Hive] #1 is in Doing\r\n' })
      expect(why).toMatch(/^setup: the prompt was never taken; its screen ends: /)
      expect(why).toContain('[Hive] #1 is in Doing')
      expect(why).not.toContain('\x1b')
    })

    it('is nothing once it was taken (late, after the last attempt)', () => {
      expect(promptNotTaken({ taken: true, screen: '> hello' })).toBeNull()
    })
  })

  // HI-2230: a check judged on the final reply couldn't be audited when the results kept only its first 400 characters.
  describe('the final reply a trial keeps (keptReply)', () => {
    const { keptReply, REPLY_KEPT } = require('./scenarios/harness.cjs') as { keptReply: (t: string) => { finalReply: string; finalReplyLength?: number }; REPLY_KEPT: number }

    it('keeps a usual reply whole, its question at the end too', () => {
      const reply = `${'Not done: legacy.js is still there. '.repeat(30)}Shall I delete it?`
      expect(reply.length).toBeGreaterThan(400)
      expect(keptReply(reply)).toEqual({ finalReply: reply })
    })

    it('bounds a runaway one, saying how long it was', () => {
      const long = 'x'.repeat(REPLY_KEPT + 50)
      expect(keptReply(long)).toEqual({ finalReply: long.slice(0, REPLY_KEPT), finalReplyLength: REPLY_KEPT + 50 })
      expect(keptReply('')).toEqual({ finalReply: '' })
    })
  })

  // HI-2225: Hive's relaunch of the session under test in a slot asked to trust that folder, unanswered, and the trial
  // ended waiting. HR2's round 1: the launch's run is the one session:start replied with, so a relaunch that came before
  // the prompt was taken is still a later run, whose question is answered.
  describe("a relaunch's trust question (relaunchTrust)", () => {
    type Trust = (o: { status: string; runId: string | null; launchRun: string | null; answered: Set<string>; screen?: string; provider: string }) => 'enter' | 'claude' | null
    const { relaunchTrust } = require('./scenarios/harness.cjs') as { relaunchTrust: Trust }
    const CLAUDE = 'Quick safety check\r\n ❯ 1. Yes, I trust this folder\r\n   2. No, exit'
    const ask = (o: Partial<Parameters<Trust>[0]> = {}) => relaunchTrust({ status: 'waiting', runId: 'slot-run', launchRun: 'launch-run', answered: new Set(), screen: CLAUDE, provider: 'claude-code', ...o })

    it("answers a later run's question: Claude Code's menu, Copilot's and Codex's Yes-first", () => {
      expect(ask()).toBe('claude')
      expect(ask({ provider: 'codex', screen: 'Do you trust the contents of this directory? › 1. Yes, trust this folder' })).toBe('enter')
      expect(ask({ provider: 'copilot', screen: 'Do you trust the files in this folder?' })).toBe('enter')
    })

    it('a relaunch before the prompt was taken is still a later run than the launch session:start replied with', () => {
      // The relaunch's run is current; the launch's was known before any prompt existed.
      expect(ask({ runId: 'slot-run', launchRun: 'launch-run' })).toBe('claude')
    })

    it("leaves the launch's own run (its question answered as it started, maybe still in the buffer), a run answered, and anything not waiting", () => {
      expect(ask({ runId: 'launch-run' })).toBeNull()
      expect(ask({ answered: new Set(['slot-run']) })).toBeNull()
      expect(ask({ status: 'working' })).toBeNull()
      expect(ask({ runId: null })).toBeNull()
      expect(ask({ screen: 'Allow this command? 1. Yes 2. No' })).toBeNull()
    })
  })

  // #577: Claude Code 2.1.296 with an OAuth session it couldn't refresh printed this and exited with 1 at launch.
  describe('a CLI that exits at launch (launchEnded)', () => {
    const { launchEnded, startFailureIn, claudeAuthStatus, parseAuthStatus } = require('./scenarios/harness.cjs') as {
      launchEnded: (o: { screen?: string; reason?: string; auth?: { loggedIn?: boolean } | null }) => { environment?: string; error?: string }
      startFailureIn: (file: string) => string
      claudeAuthStatus: (file: string, agentId: string, env: { CLAUDE_CONFIG_DIR?: string }) => { loggedIn?: boolean } | null
      parseAuthStatus: (out: string) => { loggedIn?: boolean } | null
    }
    const { mkdirSync, writeFileSync } = require('fs') as typeof import('fs')
    const { dirname, join } = require('path') as typeof import('path')
    const OAUTH = 'Failed to authenticate: OAuth session expired and could not be refreshed'

    it('its last screen or the reason Hive gives: skipped for the environment, with the sign-in advice', () => {
      const why = launchEnded({ screen: `Claude Code ${OAUTH}` }).environment
      expect(why).toMatch(/^not signed in: /)
      expect(environmentAdvice(why!, 'claude-code')).toMatch(/^sign in to Claude Code's test home .*, by hand$/)
      expect(launchEnded({ reason: OAUTH }).environment).toMatch(/^not signed in: /)
    })

    it('nothing seen, but its auth status says it is signed out: skipped too', () => {
      expect(launchEnded({ auth: { loggedIn: false } }).environment).toMatch(/^not signed in: its auth status/)
      expect(launchEnded({ screen: 'Claude Code', auth: { loggedIn: false } }).environment).toMatch(/^not signed in: its auth status/)
    })

    it('a concrete launch failure stays an error even when the test home is signed out too, from Hive or the screen', () => {
      const bad = "error: option '--model <model>' argument 'x' is invalid."
      expect(launchEnded({ reason: bad, auth: { loggedIn: false } })).toEqual({ error: `the session ended at launch: ${bad}` })
      expect(launchEnded({ screen: `Claude Code ${bad}`, auth: { loggedIn: false } })).toEqual({ error: `the session ended at launch: ${bad}` })
      expect(launchEnded({ screen: 'Claude Code Cannot find module node:sqlite', auth: { loggedIn: true } })).toEqual({ error: 'the session ended at launch: Cannot find module node:sqlite' })
    })

    it("reads auth status as Claude Code prints it: indented JSON, signed in or not", () => {
      expect(parseAuthStatus('{\n  "loggedIn": true,\n  "authMethod": "claude.ai"\n}\n')).toEqual({ loggedIn: true, authMethod: 'claude.ai' })
      expect(parseAuthStatus('{\r\n  "loggedIn": false,\r\n  "authMethod": "none"\r\n}\r\n')).toEqual({ loggedIn: false, authMethod: 'none' })
      expect(parseAuthStatus('')).toBeNull()
      expect(parseAuthStatus('not json')).toBeNull()
    })

    it("asks the CLI Hive started, and keeps its answer when it exits with 1 signed out (the fake, in a test home)", () => {
      const dir = tempDir('hive-auth-status-')
      const home = join(dir, 'home')
      mkdirSync(home)
      const log = join(dir, 'hive.log')
      writeFileSync(log, `2026-10-11T08:24:30.000Z [INFO] [pty] spawn \u2068session:c:\\x\\alpha#a-1\u2069: ${join(process.cwd(), 'tests', 'e2e', 'fake-claude', 'fake-claude.cmd')} ["--session-id","x"]\n`)
      expect(claudeAuthStatus(log, 'a-1', { CLAUDE_CONFIG_DIR: home })).toMatchObject({ loggedIn: true })
      writeFileSync(join(home, 'fake-signin.json'), JSON.stringify({ expired: true, atLaunch: true }))
      expect(claudeAuthStatus(log, 'a-1', { CLAUDE_CONFIG_DIR: home })).toMatchObject({ loggedIn: false })
      expect(claudeAuthStatus(log, 'a-2', { CLAUDE_CONFIG_DIR: home })).toBeNull()
    }, 30000)

    it('anything else is an error at once, saying what it showed', () => {
      expect(launchEnded({ reason: "error: option '--model <model>' argument 'x' is invalid.", auth: { loggedIn: true } })).toEqual({ error: "the session ended at launch: error: option '--model <model>' argument 'x' is invalid." })
      expect(launchEnded({})).toEqual({ error: 'the session ended at launch' })
    })

    it("reads the reason from Hive's log", () => {
      const log = join(tempDir('hive-start-failure-'), 'hive.log')
      writeFileSync(log, `2026-10-11T08:24:30.000Z [INFO] [pty] spawn x\n2026-10-11T08:24:33.000Z [WARN] [sessions] ⁨alpha · Coder⁩: exited with code 1 before it started: ⁨${OAUTH}⁩\n`)
      expect(startFailureIn(log)).toBe(OAUTH)
      expect(startFailureIn(join(dirname(log), 'none.log'))).toBe('')
    })
  })
  // Claude Code's transcript read as Hive reads it (its parser), then the notices the harness takes as the CLI's (#342):
  // a background task's summary or a command's output may talk about an expired sign-in or a limit without one.
  describe("the CLI's own notices, not what it relays (cliNotices, #342)", () => {
    const { cliNotices } = require('./scenarios/harness.cjs') as { cliNotices: (items: unknown) => string[] }
    const line = (o: object) => JSON.stringify({ sessionId: 's', cwd: 'C:\\p', ...o })
    const user = (content: string) => line({ type: 'user', timestamp: 't1', message: { role: 'user', content } })
    const synthetic = (text: string) => line({ type: 'assistant', timestamp: 't2', message: { model: '<synthetic>', content: [{ type: 'text', text }] } })
    const TASK = 'Background task finished: documented how to fix OAuth token has expired errors.'
    const COMMAND = "Notes: when you've hit your usage limit, wait for the reset."
    const relayed = [user(`<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>${TASK}</summary>\n</task-notification>`), user(`<local-command-stdout>${COMMAND}</local-command-stdout>`)]
    const notices = async (lines: string[]) => {
      const { ConversationParser } = await import('../src/main/providers/claude/conversation')
      const p = new ConversationParser('C:\\p')
      p.feed(Buffer.from(lines.join('\n') + '\n'))
      return { items: p.items, cli: cliNotices(p.items) }
    }

    it('a background task or a command that only discusses a sign-in or a limit is no skip', async () => {
      const { items, cli } = await notices(relayed)
      // Both are notices, and each alone would read as an environment failure: what they are is what keeps them out.
      expect(items).toMatchObject([{ kind: 'notice', text: TASK, from: 'task' }, { kind: 'notice', text: COMMAND, from: 'command' }])
      expect(trialEnvironment({ replies: [TASK] })).toMatch(/^not signed in/)
      expect(trialEnvironment({ replies: [COMMAND] })).toMatch(/^usage or rate limit/)
      expect(cli).toEqual([])
      expect(trialEnvironment({ status: 'working', replies: cli })).toBeNull()
    })

    it("beside them, the CLI's own expired sign-in and usage limit are still skips, at once", async () => {
      const login = await notices([...relayed, synthetic('Login expired · Please run /login')])
      expect(login.cli).toEqual(['Login expired · Please run /login'])
      expect(trialEnvironment({ status: 'finished', replies: login.cli })).toMatch(/^not signed in: /)
      const limit = await notices([...relayed, synthetic("You've hit your usage limit · resets 5pm (Europe/London)")])
      expect(trialEnvironment({ status: 'finished', replies: limit.cli })).toMatch(/^usage or rate limit: /)
    })
  })
})

// Before reading Hive's metrics, the harness waits until they count every hive call the bridges logged (#527): the whole
// run on both sides, so a setup call reported before the scenario's baseline counts as reported, not missing.
describe("every logged hive call reported (allCallsReported)", () => {
  const { allCallsReported } = require('./scenarios/harness.cjs') as { allCallsReported: (logged: { tool: string; direct?: boolean }[], metrics: unknown) => boolean }
  const mcp = (count: number) => [{ tool: 'hive_list_tasks', mode: 'compact', outcome: 'ok', count, chars: 10, bytes: 10, totalMs: 1 }]
  const metrics = (project: number, workspace = 0) => ({ projects: { alpha: { mcp: mcp(project) } }, workspace: { mcp: mcp(workspace) } })
  const call = (name: string, direct?: boolean) => ({ tool: name, ...(direct ? { direct } : {}) })

  it("counts a setup call reported before the scenario's baseline (the whole run on both sides)", () => {
    // Setup: one call, reported before the baseline; the scenario: one more (the Assistant's, in the workspace).
    expect(allCallsReported([call('hive_list_tasks'), call('hive_prompt_agent')], metrics(1, 1))).toBe(true)
  })

  it('waits while a call has not been reported yet, or the metrics could not be read', () => {
    expect(allCallsReported([call('hive_list_tasks'), call('hive_prompt_agent')], metrics(1))).toBe(false)
    expect(allCallsReported([call('hive_list_tasks')], null)).toBe(false)
  })

  it("leaves out a fake's direct board change, which no bridge reports", () => {
    expect(allCallsReported([call('hive_update_task', true)], metrics(0))).toBe(true)
    expect(allCallsReported([call('hive_update_task', true), call('hive_read_task')], metrics(0))).toBe(false)
  })
})

// A coordinator's watch is scored as it ended its turn (#402): a new watch replaces the last, so a combined one followed
// by a narrower one leaves only the narrower, and earlier calls prove nothing.
describe("the Assistant's live watch (coordinator scenarios)", () => {
  const sc = SCENARIOS.find((x) => x.id === 'coordinator-wake-question')!
  const call = (cards: number[]) => ({ tool: 'hive_wait_for_tasks', ok: true, args: JSON.stringify({ cards, wake: true }) })
  const outcome = (watch: unknown) => ({
    hiveCalls: [call([2, 3]), call([1])],
    status: 'watching',
    watch,
    cards: { a: { decisions: [] } },
    finalReply: 'Coder asks about an empty name.',
    skillsRead: [],
    allCards: [],
    lanes: []
  })
  const ctx = { cards: { a: 1, b: 2, c: 3 } }
  const ANY = ['column', 'comment', 'verdict', 'agent']
  const check = (o: unknown) => sc.expect(o, ctx).find(([name]) => name.startsWith('ended its turn watching again'))![1]

  it('a combined watch replaced by one on the asking card fails, whatever was called before', () => {
    expect(check(outcome({ cards: [1], changes: ANY, label: '', since: '', limitAt: '' }))).toBe(false)
  })

  it("one live watch over both lanes' ends, waking on anything, passes; one waiting for a single column does not", () => {
    expect(check(outcome({ cards: [1, 2, 3], changes: ANY, label: '', since: '', limitAt: '' }))).toBe(true)
    expect(check(outcome({ cards: [1, 2, 3], changes: ['column'], column: 'done', label: '', since: '', limitAt: '' }))).toBe(false)
    expect(check({ ...outcome({ cards: [2, 3], changes: ANY }), status: 'finished' })).toBe(false)
  })

  it('a narrowed watch fails: column moves only miss a question in a comment and a failed verdict left in Review', () => {
    expect(check(outcome({ cards: [1, 2, 3], changes: ['column'] }))).toBe(false)
    expect(check(outcome({ cards: [1, 2, 3], changes: ['column', 'comment'] }))).toBe(false)
    expect(check(outcome({ cards: [1, 2, 3], changes: ['column', 'verdict'] }))).toBe(false)
    expect(check(outcome({ cards: [1, 2, 3], changes: ['column', 'comment', 'verdict'] }))).toBe(true)
    expect(check(outcome({ cards: [1, 2, 3], changes: ANY, agents: ['coder'] }))).toBe(false)
  })
})

// Following lanes to the end (#402): every watch checked for what it wakes on, and the sweep is one a wake started.
describe('coordinator-lanes-to-end scoring', () => {
  const sc = SCENARIOS.find((x) => x.id === 'coordinator-lanes-to-end')!
  const ANY = ['column', 'comment', 'verdict', 'agent']
  const call = (name: string, args: unknown = {}) => ({ tool: name, ok: true, args: JSON.stringify(args) })
  const watch = (cards: number[], changes = ANY) => ({ cards, changes })
  const run = (calls: ReturnType<typeof call>[], first = watch([2, 3]), second = watch([2])) => {
    const o = { hiveCalls: calls, status: 'finished', watch: null, finalReply: 'Both lanes are done.', lanes: [], cards: {}, allCards: [], skillsRead: [] }
    const checks = sc.expect(o, { cards: { a: 1, b: 2, c: 3 }, wakes: 2, firstWatch: first, secondWatch: second })
    return (start: string) => checks.find(([name]) => name.startsWith(start))![1]
  }
  const wake = (cards: number[]) => call('hive_wait_for_tasks', { cards, wake: true })

  it('a sweep only before its first watch is not a sweep on a wake', () => {
    expect(run([call('hive_list_tasks'), wake([2, 3])])('swept the board')).toBe(false)
    expect(run([wake([2, 3]), call('hive_list_tasks'), wake([2])])('swept the board')).toBe(true)
  })

  it('a column-only watch, first or after the wake, fails', () => {
    const calls = [wake([2, 3]), call('hive_lane', { action: 'list' }), wake([2])]
    expect(run(calls)('first watched')).toBe(true)
    expect(run(calls, watch([2, 3], ['column']))('first watched')).toBe(false)
    expect(run(calls, watch([2, 3]), watch([2], ['column']))('woken by')).toBe(false)
  })
})

// The coordinator scenarios' simulated wakes end as Hive's real one to the Assistant does while lanes run (#402).
describe("the scenarios' simulated wake", () => {
  it("ends with Hive's own lanes-running tail", async () => {
    const { LANES_RUNNING_TAIL } = await import('../src/shared/watch')
    expect(helpers.LANES_RUNNING_TAIL).toBe(LANES_RUNNING_TAIL)
  })
})

// A decision put to the user counts without a "?" (#566): Codex once ended a plan with "Please choose the export target".
describe('mode-*-plans: a decision put to the user', () => {
  const sc = SCENARIOS.find((x) => x.id === 'mode-coordinator-plans')!
  const ctx = { ws: 'no-such-workspace' }
  const outcome = (finalReply: string, descriptions: string[] = []) => ({
    hiveCalls: descriptions.map((description) => ({ tool: 'hive_create_task', ok: true, args: JSON.stringify({ title: 'Export', description }) })),
    finalReply
  })
  const check = (o: unknown, name: string) => sc.expect(o, ctx).find(([n]) => n.startsWith(name))![1]
  const CODEX = 'Please choose the export target and contents above. I recommend all unarchived cards with ID, title, column, agent, labels and blockers. No cards or agents have been started.'

  it('a request to choose, with no cards, is asking first and surfaces the decision', () => {
    expect(check(outcome(CODEX), 'wrote cards for alpha, or asked first')).toBe(true)
    expect(check(outcome(CODEX), 'surfaced a decision')).toBe(true)
    expect(check(outcome('Let me know which columns you want in the file.'), 'surfaced a decision')).toBe(true)
    expect(check(outcome('Done.', ['Export the board. Open: I need your decision on the delimiter before this starts.']), 'surfaced a decision')).toBe(true)
  })

  it('a question still counts; a reply that puts nothing to the user does not', () => {
    expect(check(outcome('Which format should the export use?'), 'surfaced a decision')).toBe(true)
    expect(check(outcome('No cards or agents have been started.'), 'wrote cards for alpha, or asked first')).toBe(false)
    expect(check(outcome('Planned it. Let me know if you need anything else.'), 'surfaced a decision')).toBe(false)
  })

  it('a polite closing is not a decision, in the reply or on a card', () => {
    for (const closing of ['Planned it. Please let me know if you need anything else.', 'Please tell me if anything is unclear.', 'Please let me know what else you need.', 'Let me know what you think.']) {
      expect(check(outcome(closing), 'wrote cards for alpha, or asked first')).toBe(false)
      expect(check(outcome(closing), 'surfaced a decision')).toBe(false)
      expect(check(outcome('Done.', [`Export the board to CSV from the board's menu, done when the file opens in Excel. ${closing}`]), 'surfaced a decision')).toBe(false)
    }
    expect(check(outcome('Please let me know which delimiter to use.'), 'surfaced a decision')).toBe(true)
    expect(check(outcome('Done.', ['Export the board to CSV. Tell me whether archived cards belong in it before this starts.']), 'surfaced a decision')).toBe(true)
  })
})

// fake-copilot's stand-in model starts just before Hive's launch; a launch that fails (or Copilot's environment before
// it) closes it at once, and the launch's own failure is what the run throws (#464).
describe("Copilot's stand-in model when a scenario's launch fails (#464)", () => {
  it('is closed: nothing listens on its port after, and the launch failure is the one thrown', async () => {
    const fs = require('fs') as typeof import('fs')
    const lib = require('./e2e/lib.cjs') as { launch: (o: { env: Record<string, string> }) => Promise<unknown> }
    const { runScenario } = require('./scenarios/harness.cjs') as { runScenario: (sc: object, provider: string, opts: object) => Promise<unknown> }
    const launch = lib.launch
    const work = tempDir('hive-standin-launch-')
    let url = ''
    let answered = 0
    // The launch fails once the stand-in is up: it answers then, as Copilot would reach it.
    lib.launch = async ({ env }) => {
      url = env.COPILOT_PROVIDER_BASE_URL
      answered = (await fetch(`${url}/models`)).status
      throw new Error('injected: the launch failed')
    }
    try {
      await expect(runScenario({ id: 'standin-close', title: 'A launch that fails', prompt: 'nothing' }, 'fake-copilot', { workRoot: work })).rejects.toThrow('injected: the launch failed')
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/)
      expect(answered).toBe(200)
      // Closed: a request is refused, not answered or left waiting.
      await expect(fetch(`${url}/models`, { signal: AbortSignal.timeout(5000) })).rejects.toMatchObject({ cause: { code: 'ECONNREFUSED' } })
    } finally {
      lib.launch = launch
      fs.rmSync(work, { recursive: true, force: true })
    }
  })
})

describe("assistant-doing-nobody checks each batch by its own reply (HI-2238, HR2's round 1)", () => {
  const CHECK = 'each move of it with nobody on it was refused, naming the choices'
  const NEXT = 'Ask the user which they want: nobody on it (move it again with override and their reason), an agent on it (agent), or an agent started on it (hive_start_task).'
  const refusedRow = (key: string) => `1 card changed:\n#1 Greeting helper: Moved to Doing.\nRefused, left as it was: ${key} would be in Active with nobody on it. (move.doingNobody)\n${NEXT}`
  const batch = (reply: string | undefined, numbers: unknown[] = [1, 'AL-2']) => ({ tool: 'hive_update_tasks', args: JSON.stringify({ numbers, column: 'doing' }), ok: true, ...(reply !== undefined ? { reply } : {}) })
  /** The check, on calls as the MCP log records them (whichever CLI made them: Claude Code directly, Codex's Script tool). */
  const check = (hiveCalls: unknown[], tools: unknown[] = []) => {
    const sc = SCENARIOS.find((s) => s.id === 'assistant-doing-nobody')!
    const o = { hiveCalls, tools, finalReply: '', cards: { h: { number: 1, key: 'AL-1', column: 'doing', agentName: 'Coder' }, n: { number: 2, key: 'AL-2', column: 'todo' } } }
    return Object.fromEntries(sc.expect(o, { cards: { h: 1, n: 2 } }).map(([name, ok]) => [name.replace(/ \(.*$/, ''), ok]))[CHECK]
  }

  it('passes on a batch whose own reply refuses the card by its key, naming the choices; a single refusal as before', () => {
    expect(check([batch(refusedRow('AL-2'))])).toBe(true)
    // Codex calls through its Script tool: the session's tool is "Script", the MCP log has the call and its reply all the same.
    expect(check([batch(refusedRow('AL-2'))], [{ name: 'Script', input: 'hive_update_tasks', result: 'done' }])).toBe(true)
    expect(check([{ tool: 'hive_update_task', args: JSON.stringify({ number: 2, column: 'doing' }), ok: false, error: `AL-2 would be in Active with nobody on it. (move.doingNobody)\n${NEXT}` }])).toBe(true)
  })

  it("fails a batch whose reply refuses another card, says no choices, or wasn't recorded; another tool's reply doesn't count", () => {
    expect(check([batch(refusedRow('AL-9'))])).toBe(false)
    expect(check([batch(refusedRow('AL-21'))])).toBe(false)
    expect(check([batch('No card changed.\nRefused, left as they were: AL-2 (AL-2 would be in active with nobody on it.).')])).toBe(false)
    expect(check([batch(undefined)])).toBe(false)
    // A reply naming the choices for AL-2, but to an unrelated batch (not moving AL-2), doesn't stand in for the one that did.
    expect(check([batch('No card changed.'), batch(refusedRow('AL-2'), ['AL-9'])], [{ name: 'hive_update_tasks', result: refusedRow('AL-2') }])).toBe(false)
  })
})
