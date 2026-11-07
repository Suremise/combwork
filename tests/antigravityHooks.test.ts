// The Antigravity CLI's hooks and status line (HI-2545, design s56, against agy 1.5.0's recorded runs:
// tests/fixtures/advanced/hooks-run-antigravity-1.5.0.jsonl, statusline-run-…, and the conversations' transcripts in
// tests/fixtures/antigravity/run-*): Combwork's hooks in the profile (the command agy runs through cmd, its quoting, an
// allow when Combwork can't be reached), each hook prepared once (a turn per invocation zero, by the step that began it;
// later events by their position; a Stop by agy's blocking order; a subagent's conversation a child; the user's /new and
// /rewind another of its own), the replies as 1.5.0 takes them, and the status line.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { spawn } from 'child_process'
import { describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-agy-hooks-')
process.env.CW_USER_DATA = join(base, 'userdata')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { AGY_EVENTS, AGY_HOOK_ALLOW_VAR, AGY_HOOK_AUTH_VAR, PREPARED, agyHookEnv, agyHooks, agyLockReply, agyNoticeGiven, agyNoticeReply, agyNoticeWanted, agyStartContextReply, agyStatusAsk, agyStatusIdle, agyStopContinues, editedPaths, memoOf, normalizeAgyHook, prepareAgyHook, stepAt, AgyLaunchMemo } = await import('../src/main/providers/antigravity/hooks')
const { profilesRoot } = await import('../src/main/providers/antigravity/home')
const { launchSettings } = await import('../src/main/providers/antigravity/adapter')
const { TOOLS_SERVER } = await import('../src/shared/assistantTools')

const ADV = join(__dirname, 'fixtures', 'advanced')
const T = join(__dirname, 'fixtures', 'antigravity')
type Row = { at: string; event: string; payload: Record<string, any>; reply?: Record<string, unknown> }
const RUN: Row[] = readFileSync(join(ADV, 'hooks-run-antigravity-1.5.0.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l))
const STATUS: Record<string, any>[] = readFileSync(join(ADV, 'statusline-run-antigravity-1.5.0.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l))
const MAIN = 'db7643ec-6d85-4160-8c57-1dba0c9ab0b7'
const NEW = '7b021c00-2f4b-4025-8c8c-42eaf40d5306'
const PARENT = 'f57ee6fa-3d66-4a22-b458-764656e4d25d'
const CHILD = 'ded852d1-0c96-4f30-bf60-bc1a470ed6c8'
/** A recorded hook as Combwork's server passes it on: its event named from the URL; a fresh copy each time. */
const body = (r: Row, extra: Record<string, unknown> = {}): Record<string, any> => ({ ...structuredClone(r.payload), hook_event_name: r.event, ...extra })

/** An agent's profile holding conversations' transcripts (as agy keeps them). */
function profileWith(name: string, convs: Record<string, string>): string {
  const profile = join(profilesRoot(), name)
  for (const [conv, text] of Object.entries(convs)) {
    const logs = join(profile, '.gemini', 'antigravity-cli', 'brain', conv, '.system_generated', 'logs')
    mkdirSync(logs, { recursive: true })
    writeFileSync(join(logs, 'transcript_full.jsonl'), text)
  }
  return profile
}
const fixture = (name: string): string => readFileSync(join(T, name), 'utf8').replace(/\r\n/g, '\n')

describe("Combwork's hooks in the agent's profile", () => {
  const url = 'http://127.0.0.1:47822/hook?run=r-1'
  it('one named hook with each event agy has, the tool events under a matcher, each forwarding with the launch token', () => {
    const h = agyHooks(url, true).combwork as Record<string, any[]>
    expect(Object.keys(h)).toEqual([...AGY_EVENTS])
    expect(h.SessionStart[0].type).toBe('command')
    expect(h.PreToolUse[0].matcher).toBe('*')
    const cmd = h.PreToolUse[0].hooks[0].command as string
    expect(cmd).toContain(' http://127.0.0.1:47822/hook?run=r-1^&event=PreToolUse')
    expect(cmd).toContain(`-H %${AGY_HOOK_AUTH_VAR}%`)
    expect(agyHookEnv('C:\\data\\launches\\r-1\\hook-auth.txt')[AGY_HOOK_AUTH_VAR]).toBe('"@C:/data/launches/r-1/hook-auth.txt"')
    expect(cmd).not.toMatch(/Bearer/)
    // agy's limit past curl's own, so curl ends first.
    expect(h.Stop[0].timeout).toBeGreaterThan(Number(/-m (\d+)/.exec(h.Stop[0].command)![1]))
  })
  it("a tool's hook answers allow when Combwork can't be reached (1.5.0 takes no answer as a denial); the others don't", () => {
    const h = agyHooks(url, true).combwork as Record<string, any[]>
    expect(h.PreToolUse[0].hooks[0].command).toMatch(new RegExp(` \\|\\| echo %${AGY_HOOK_ALLOW_VAR}%$`))
    expect(agyHookEnv('a.txt')[AGY_HOOK_ALLOW_VAR]).toBe('{"decision":"allow"}')
    expect(h.Stop[0].command).not.toContain('||')
  })
  it('without the tool hooks (its switch): the other events only', () => {
    expect(Object.keys(agyHooks(url, false).combwork as object)).toEqual(['SessionStart', 'PreInvocation', 'PostInvocation', 'Stop'])
  })
  // HI-2548's run of the real agy 1.5.0: it runs a hook's command as `cmd /c "<command>"` with each `"` escaped as `\"`
  // (its probe recorded the command line), so a quoted argument reached curl with its backslashes (exit 3: malformed URL)
  // and no hook ever reached Combwork. The command holds no quote; its quoted values come from the launch's environment.
  it('a command agy can run: no quote in it, every hook and the status line', () => {
    const h = agyHooks(url, true).combwork as Record<string, any[]>
    const commands = [...Object.values(h).flatMap((x) => x.flatMap((y) => (y.hooks ?? [y]).map((z: { command: string }) => z.command))), (launchSettings({ hookUrl: url, hookAuthFile: 'a.txt', mcpServers: {}, trustedCombworkTools: undefined }, true) as any).statusLine.command]
    expect(commands).toHaveLength(7)
    for (const c of commands) expect(c, c).not.toContain('"')
  })
  it.runIf(process.platform === 'win32')('…which, run as agy runs it, posts to Combwork with the token file, a path with spaces and non-ASCII letters, and the URL whole', async () => {
    const dir = join(tempDir('cw-agy-hookcmd-'), 'Zoë Ångström', 'launches', 'r 1')
    mkdirSync(dir, { recursive: true })
    const auth = join(dir, 'hook-auth.txt')
    writeFileSync(auth, 'Authorization: Bearer launch-token\n')
    const got: { url: string; auth: string; body: string }[] = []
    const server = createServer((req, res) => {
      let posted = ''
      req.on('data', (d) => (posted += d))
      req.on('end', () => {
        got.push({ url: req.url ?? '', auth: String(req.headers.authorization ?? ''), body: posted })
        res.end('{"decision":"allow"}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port
    try {
      const hookUrl = `http://127.0.0.1:${port}/hook?run=r-1`
      const cmd = (agyHooks(hookUrl, true).combwork as Record<string, any[]>).Stop[0].command as string
      // agy's command line, as its probe recorded it: cmd /c, the command quoted, each " in it escaped as \".
      const asAgy = (c: string) =>
        new Promise<{ code: number | null; out: string }>((resolve) => {
          const p = spawn(process.env.ComSpec || 'cmd.exe', [`/c "${c.replace(/"/g, '\\"')}"`], { windowsVerbatimArguments: true, env: { ...process.env, ...agyHookEnv(auth) }, windowsHide: true })
          let out = ''
          p.stdout.on('data', (d) => (out += d))
          p.on('close', (code) => resolve({ code, out }))
          p.stdin.end('{"conversationId":"c-1"}')
        })
      const r = await asAgy(cmd)
      expect(r.code).toBe(0)
      expect(got).toEqual([{ url: '/hook?run=r-1&event=Stop', auth: 'Bearer launch-token', body: '{"conversationId":"c-1"}' }])
      // PreToolUse's fallback, with Combwork gone: agy reads allow.
      server.close()
      const pre = (agyHooks(`http://127.0.0.1:${port}/hook?run=r-1`, true).combwork as Record<string, any[]>).PreToolUse[0].hooks[0].command as string
      expect(JSON.parse((await asAgy(pre)).out.trim())).toEqual({ decision: 'allow' })
    } finally {
      server.close()
    }
  })
  it("the status line runs under agy's own (stack_with_default), and Combwork's tools are allowed as agy writes rules", () => {
    const ctx = { hookUrl: url, hookAuthFile: 'a.txt', mcpServers: { [TOOLS_SERVER]: { command: 'x' } }, trustedCombworkTools: undefined as string[] | undefined }
    const s = launchSettings(ctx, true) as Record<string, any>
    expect(s.statusLine.stack_with_default).toBe(true)
    expect(s.permissions.allow).toEqual([`mcp(${TOOLS_SERVER}/*)`])
    expect((launchSettings({ ...ctx, trustedCombworkTools: ['cw_inbox'] }, true) as any).permissions.allow).toEqual([`mcp(${TOOLS_SERVER}/cw_inbox)`])
  })
})

describe('a hook before it is prepared (the lock check and its reply): only what its raw fields say for sure', () => {
  const edit = RUN.find((r) => r.event === 'PreToolUse' && r.payload.toolCall.name === 'edit_file')!
  const read = RUN.find((r) => r.event === 'PreToolUse' && r.payload.toolCall.name === 'read_file')!
  it("an edit's start names the file it edits (edit_file's Path), whatever its conversation; a read edits none", () => {
    const n = normalizeAgyHook(body(edit))
    expect(n.event).toEqual({ kind: 'toolStart' })
    expect(n.editedPaths).toEqual(['C:\\work\\notes.txt'])
    expect(n.ids.call).toBe(`${MAIN}:${edit.payload.stepIdx}`)
    expect(n.sessionId).toBeNull()
    expect(normalizeAgyHook(body(read)).editedPaths).toEqual([])
    expect(editedPaths({ name: 'other_tool', args: { Path: 'x' } })).toEqual([])
  })
  it("a tool's end is its call's; anything else is left out (no turn or session guessed)", () => {
    const post = RUN.find((r) => r.event === 'PostToolUse')!
    expect(normalizeAgyHook(body(post)).event).toEqual({ kind: 'toolEnd', call: `${MAIN}:${post.payload.stepIdx}` })
    for (const e of ['SessionStart', 'PreInvocation', 'PostInvocation', 'Stop']) {
      const n = normalizeAgyHook(body(RUN.find((r) => r.event === e)!))
      expect([n.event, n.sessionId, n.ids.turn], e).toEqual([{ kind: 'ignore' }, null, null])
    }
  })
})

describe("each hook prepared once (s56), on agy 1.5.0's recorded run", () => {
  const main = fixture('run-tools-continue-1.5.0.jsonl')
  const userSteps = main.trim().split('\n').map((l) => JSON.parse(l)).filter((s) => s.type === 'USER_INPUT').map((s) => s.step_index as number)
  const ofMain = RUN.filter((r) => r.payload.conversationId === MAIN)

  async function prepare(b: Record<string, any>, o: { profile: string; sessionId: string | null; memo: Record<string, unknown>; alive?: () => boolean; waitMs?: number }) {
    await prepareAgyHook(b, { profile: o.profile, root: profilesRoot(), sessionId: o.sessionId, memo: o.memo, alive: o.alive ?? (() => true), waitMs: o.waitMs ?? 50 })
    return normalizeAgyHook(b)
  }

  it("a turn per invocation zero, named by its initialNumSteps, the user's words from the step that began it; nothing else is a prompt", async () => {
    const profile = profileWith('agent-run', { [MAIN]: main })
    const memo = {}
    const prompts: [string | null, string | null | undefined][] = []
    for (const r of ofMain) {
      const n = await prepare(body(r), { profile, sessionId: MAIN, memo })
      if (n.event.kind === 'prompt') prompts.push([n.ids.turn, n.event.text])
    }
    // Every turn the user began, once (the resumed conversation's included), and the continuation none.
    expect(prompts.map(([t]) => t)).toEqual(userSteps.map((s) => `${MAIN}:i${s + 1}`))
    expect(prompts[0][1]).toBe('Read notes.txt and reply with its first word only.')
    expect(prompts.at(-1)![1]).toBe('Reply with the single word FIRST.')
  })

  it("later events belong to their turn by position; a Stop to the conversation's latest; a continuation's PreInvocation may carry a checkpoint", async () => {
    const profile = profileWith('agent-pos', { [MAIN]: main })
    const memo = {}
    const seen: [string, string | null, unknown][] = []
    for (const r of ofMain) {
      const b = body(r)
      const n = await prepare(b, { profile, sessionId: MAIN, memo })
      seen.push([r.event, n.ids.turn, b[PREPARED].checkpoint?.at ?? null])
    }
    // The first turn (initialNumSteps 1): its model calls at 3 and 5, its read at step 2, its Stop.
    expect(seen.slice(0, 9)).toEqual([
      ['SessionStart', null, null],
      ['PreInvocation', `${MAIN}:i1`, null],
      ['PreToolUse', `${MAIN}:i1`, null],
      ['PostInvocation', `${MAIN}:i1`, null],
      ['PreInvocation', `${MAIN}:i1`, 3],
      ['PreToolUse', `${MAIN}:i1`, null],
      ['PostInvocation', `${MAIN}:i1`, null],
      ['PreInvocation', `${MAIN}:i1`, 5],
      ['PostInvocation', `${MAIN}:i1`, null]
    ])
    // The resumed turn's continuation (a Stop carried on: invocationNum 1, initialNumSteps 26) is still that turn.
    const cont = seen.findLast(([e, , c]) => e === 'PreInvocation' && c === 26)
    expect(cont?.[1]).toBe(`${MAIN}:i22`)
    // A Stop after a continuation is marked so (no drain after one).
    const stops = ofMain.filter((r) => r.event === 'Stop')
    const last = body(stops.at(-1)!)
    await prepare(last, { profile, sessionId: MAIN, memo })
    expect(normalizeAgyHook(last).ids.continued).toBe(true)
  })

  it('an invocation zero delivered again, or an older one, is old news: one turn whatever its read found', async () => {
    const profile = profileWith('agent-dup', { [MAIN]: main })
    const memo = {}
    const zero = ofMain.find((r) => r.event === 'PreInvocation' && r.payload.invocationNum === 0)!
    expect((await prepare(body(zero), { profile, sessionId: MAIN, memo })).event.kind).toBe('prompt')
    // The same prepared body normalizes the same each time it is read.
    const b = body(zero)
    await prepare(b, { profile, sessionId: MAIN, memo })
    expect([normalizeAgyHook(b).event, normalizeAgyHook(b).event]).toEqual([{ kind: 'ignore' }, { kind: 'ignore' }])
    const later = ofMain.filter((r) => r.event === 'PreInvocation' && r.payload.invocationNum === 0)[2]
    expect((await prepare(body(later), { profile, sessionId: MAIN, memo })).event.kind).toBe('prompt')
    expect((await prepare(body(zero), { profile, sessionId: MAIN, memo })).event.kind).toBe('ignore')
  })

  it("a step not on disk within the wait: a turn the CLI began (cli), under the same id; read again later, still the one turn", async () => {
    const profile = profileWith('agent-late', { [MAIN]: '' })
    const memo = {}
    const zero = ofMain.find((r) => r.event === 'PreInvocation' && r.payload.invocationNum === 0)!
    const first = await prepare(body(zero), { profile, sessionId: MAIN, memo, waitMs: 30 })
    expect([first.event, first.ids.turn]).toEqual([{ kind: 'prompt', cli: true }, `${MAIN}:i1`])
    writeFileSync(join(profile, '.gemini', 'antigravity-cli', 'brain', MAIN, '.system_generated', 'logs', 'transcript_full.jsonl'), main)
    expect((await prepare(body(zero), { profile, sessionId: MAIN, memo })).event).toEqual({ kind: 'ignore' })
  })

  it("a launch that ends during the read decides nothing, and takes no turn start: the hook again is a turn", async () => {
    const profile = profileWith('agent-gone', { [MAIN]: main })
    const memo = {}
    const zero = ofMain.find((r) => r.event === 'PreInvocation' && r.payload.invocationNum === 0)!
    const b = body(zero)
    await prepareAgyHook(b, { profile, root: profilesRoot(), sessionId: MAIN, memo, alive: () => false })
    expect(b[PREPARED]).toBeUndefined()
    expect(normalizeAgyHook(b).event).toEqual({ kind: 'ignore' })
    expect((await prepare(body(zero), { profile, sessionId: MAIN, memo })).event.kind).toBe('prompt')
  })

  it('an invocationNum or initialNumSteps that is no whole number (or initialNumSteps 0) is no turn', async () => {
    const profile = profileWith('agent-bad', { [MAIN]: main })
    const zero = ofMain.find((r) => r.event === 'PreInvocation' && r.payload.invocationNum === 0)!
    for (const bad of [{ invocationNum: -1 }, { invocationNum: 0.5 }, { initialNumSteps: 0 }, { initialNumSteps: 1e300 }, { initialNumSteps: '1' }]) {
      expect((await prepare(body(zero, bad), { profile, sessionId: MAIN, memo: {} })).event, JSON.stringify(bad)).toEqual({ kind: 'ignore' })
    }
  })

  it("the user's /new (and a rewind, which 1.5.0 makes a new conversation): its prompt carries it, so the launch follows it", async () => {
    const profile = profileWith('agent-new', { [MAIN]: main, [NEW]: fixture('run-new-1.5.0.jsonl') })
    const memo = {}
    const ofNew = RUN.filter((r) => r.payload.conversationId === NEW)
    const start = await prepare(body(ofNew.find((r) => r.event === 'SessionStart')!), { profile, sessionId: MAIN, memo })
    expect([start.event, start.sessionId]).toEqual([{ kind: 'ignore' }, null])
    const zero = await prepare(body(ofNew.find((r) => r.event === 'PreInvocation')!), { profile, sessionId: MAIN, memo })
    expect([zero.event, zero.sessionId, zero.ids.turn]).toEqual([{ kind: 'prompt', text: 'Reply with the single word NEW.' }, NEW, `${NEW}:i1`])
  })

  it("a subagent's conversation is a child: no prompt, session or notice, but its edits' files for the lock check", async () => {
    const profile = profileWith('agent-child', { [PARENT]: fixture('subagent-parent-1.5.0.jsonl'), [CHILD]: fixture('subagent-child-1.5.0.jsonl') })
    const memo = {}
    const edit = RUN.find((r) => r.event === 'PreToolUse' && r.payload.toolCall.name === 'edit_file')!
    const zero = RUN.find((r) => r.event === 'PreInvocation' && r.payload.invocationNum === 0)!
    const z = await prepare(body(zero, { conversationId: CHILD, initialNumSteps: 1 }), { profile, sessionId: PARENT, memo })
    expect([z.event, z.sessionId, z.ids.sub]).toEqual([{ kind: 'ignore' }, null, CHILD])
    const e = await prepare(body(edit, { conversationId: CHILD }), { profile, sessionId: PARENT, memo })
    expect([e.event, e.editedPaths, e.ids.sub, e.ids.turn, e.sessionId, e.transcriptPath]).toEqual([{ kind: 'toolStart' }, ['C:\\work\\notes.txt'], CHILD, null, null, null])
    expect(memoOf(memo).role(CHILD)).toBe('child')
  })

  it("a conversation that can't be read (not in this agent's own profile) is neither: left out", async () => {
    const profile = profileWith('agent-none', { [MAIN]: main })
    const zero = RUN.find((r) => r.event === 'PreInvocation' && r.payload.invocationNum === 0)!
    const n = await prepare(body(zero, { conversationId: NEW }), { profile, sessionId: MAIN, memo: {} })
    expect([n.event, n.sessionId, n.ids.sub]).toEqual([{ kind: 'ignore' }, null, null])
  })
})

describe("the launch's memo: positions, duplicates and checkpoints", () => {
  it('an event belongs to the latest turn start at or before its position; none before the first', () => {
    const m = new AgyLaunchMemo()
    m.addStart('c', 1)
    m.addStart('c', 5)
    expect([m.turnAt('c', 0), m.turnAt('c', 3), m.turnAt('c', 5), m.turnAt('c', 9), m.latest('c')]).toEqual([null, 'c:i1', 'c:i5', 'c:i5', 'c:i5'])
    expect([m.isNewStart('c', 5), m.isNewStart('c', 3), m.isNewStart('c', 6)]).toEqual([false, false, true])
  })
  it('positions older than the starts kept belong to no turn, and an old start stays old after its list is trimmed', () => {
    const m = new AgyLaunchMemo()
    for (let n = 1; n <= 300; n++) m.addStart('c', n * 10)
    expect(m.turnAt('c', 15)).toBeNull()
    expect(m.isNewStart('c', 10)).toBe(false)
  })
  it('a checkpoint once per position, and only once a reply carried it', () => {
    const memo = {}
    const b = { hook_event_name: 'PreInvocation', [PREPARED]: { checkpoint: { conversation: 'c', at: 3 } } }
    expect(agyNoticeWanted(b, memo)).toBe(true)
    expect(agyNoticeWanted(b, memo)).toBe(true)
    agyNoticeGiven(b, memo)
    expect(agyNoticeWanted(b, memo)).toBe(false)
    expect(agyNoticeWanted({ ...b, [PREPARED]: { checkpoint: { conversation: 'c', at: 5 } } }, memo)).toBe(true)
  })
})

describe('reading the step that began a turn (its end only)', () => {
  const dir = tempDir('cw-agy-step-')
  const file = join(dir, 'transcript_full.jsonl')
  const step = (i: number, o: Record<string, unknown> = {}) => JSON.stringify({ step_index: i, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: `<USER_REQUEST>\nhi ${i}\n</USER_REQUEST>`, ...o })
  it('the step when written; missing while not yet; uncertain past it without it, or in another shape; a line being written is not read', async () => {
    writeFileSync(file, step(0) + '\n' + step(1) + '\n')
    expect(await stepAt(file, 1)).toMatchObject({ step_index: 1 })
    expect(await stepAt(file, 2)).toBe('missing')
    writeFileSync(file, step(0) + '\n' + step(1).slice(0, 20))
    expect(await stepAt(file, 1)).toBe('missing')
    writeFileSync(file, step(0) + '\n' + step(3) + '\n')
    expect(await stepAt(file, 1)).toBe('uncertain')
    writeFileSync(file, step(0) + '\n' + JSON.stringify({ step_index: 1, type: 'USER_INPUT', content: { not: 'text' } }) + '\n')
    expect(await stepAt(file, 1)).toBe('uncertain')
  })
  it('a line longer than the window: uncertain, never a guess', async () => {
    writeFileSync(file, step(0, { content: 'x'.repeat(1 << 21) }) + '\n')
    expect(await stepAt(file, 0)).toBe('uncertain')
  })
})

describe('the replies, as agy 1.5.0 takes them', () => {
  it("a locked file is denied, saying why; a lock that would ask is denied too (ask and force_ask don't stop an edit); a warning allows", () => {
    expect(agyLockReply({ kind: 'deny', reason: 'held' })).toEqual({ decision: 'deny', reason: 'held' })
    expect(agyLockReply({ kind: 'ask', reason: 'ask first' })).toEqual({ decision: 'deny', reason: 'ask first' })
    expect(agyLockReply({ kind: 'warn', context: 'w' })).toEqual({ decision: 'allow' })
    // Recorded: the deny's reason reached the transcript and the model.
    const denied = RUN.find((r) => r.reply?.decision === 'deny')!
    expect(denied.reply).toEqual({ decision: 'deny', reason: 'notes.txt is locked by another agent (probe)' })
  })
  it('a notice before a model call (an ephemeral message) or carrying the turn on at its Stop, as recorded; none elsewhere', () => {
    expect(agyNoticeReply('PreInvocation', 'N')).toEqual({ injectSteps: [{ ephemeralMessage: 'N' }] })
    const stop = agyNoticeReply('Stop', 'N')!
    expect(stop).toEqual({ decision: 'continue', reason: 'N' })
    expect(agyStopContinues(stop)).toBe(true)
    expect(agyStopContinues({})).toBe(false)
    for (const e of ['PreToolUse', 'PostToolUse', 'SessionStart', 'PostInvocation']) expect(agyNoticeReply(e, 'N')).toBeNull()
    expect(RUN.some((r) => r.event === 'PreInvocation' && JSON.stringify(r.reply) === JSON.stringify({ injectSteps: [{ ephemeralMessage: 'Also end your reply with the word NOTED.' }] }))).toBe(true)
    expect(agyStartContextReply('C')).toEqual({ injectSteps: [{ systemMessage: { systemMessage: 'C' } }] })
  })
})

describe("the status line (recorded at agy's permission prompt)", () => {
  it('a prompt pending while it shows; idle with none pending once it is cancelled or the turn is over', () => {
    const pending = STATUS.filter((s) => s.tool_confirmation_pending === true)
    expect(pending.length).toBeGreaterThan(0)
    for (const s of pending) {
      expect(agyStatusAsk(s)).toEqual({ kind: 'permission', blocking: true, message: '' })
      expect(agyStatusIdle(s)).toBe(false)
    }
    const after = STATUS[STATUS.indexOf(pending.at(-1)!) + 1]
    expect([after.agent_state, agyStatusAsk(after), agyStatusIdle(after)]).toEqual(['idle', null, true])
    expect(agyStatusIdle(STATUS.find((s) => s.agent_state === 'working')!)).toBe(false)
  })
})
