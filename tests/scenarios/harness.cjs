// Runs one scenario (scenarios.cjs) through Hive's dev build: a throwaway profile and workspace, a CLI home that is
// never the user's own, the scenario's cards, notes, handovers and skill changes; the agent or the Assistant started
// with its prompt; then what it actually did:
// - the hive tool calls the hive MCP server ran (its test log, HIVE_TEST_MCP_LOG: executed, with whether each worked);
// - the Hive skills it read (a successful Skill call, or a read whose result is that skill's own text);
// - every tool call in its transcript (Hive's parser), names of hive tools it only mentions kept apart;
// - the board, notes and files afterwards (the Agent API and the disk), its usage, and whether any API token showed up
//   in what it printed or said;
// - what Hive's own parts cost during the turn (its performance metrics, before the launch and after the turn: the
//   difference is the scenario's), for benchmarks (measuresOf).
// Scenarios check outcomes, never wording.
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const lib = require('../e2e/lib.cjs')
const { processes, leftoverIdentities } = require('../e2e/folderProcesses.cjs')
const { measuresOf, metricsTotals } = require('./benchmark.cjs')
const { readWhole, withScriptCalls } = require('./codexScripts.cjs')

/**
 * The Claude Code home the model trials use: a test home signed in once by hand (never the user's own ~/.claude, and
 * never a copy of its credentials, whose refresh could sign the user out). See README.md.
 */
const { CLAUDE_TEST_HOME } = require('../e2e/runContext.cjs')
const { freshFolder } = require('../e2e/evidence.cjs')
const { startFakeCopilotApi, copilotTestEnv } = require('../e2e/fake-copilot-api.cjs')
const claudeSignedIn = () => fs.existsSync(path.join(CLAUDE_TEST_HOME, '.credentials.json'))

/**
 * `--dialect <file>` (dialects, HI-2439; plans/2026-11-03-dialects-design.md, section 6): a dialect file for the
 * provider's CLI, checked against the schema as Hive checks one (src/main/dialects/format.ts, loaded in plain Node), and
 * the chain it gives in the model slot (its files and hash, as the launch record will hold them). Each trial's workspace
 * gets it as a test copy in `.combwork/dialects/<CLI>/` (placeDialect). Null with no --dialect: the shipped files, all
 * empty, so the Default. Throws, saying why, for a file that isn't a dialect.
 * The run's agents pick it (their Dialect setting, HI-2443), so Hive pins it in their chain at launch and their launch
 * record shows it.
 */
function dialectForRun(file, providerKey) {
  if (!file) return null
  const { parseDialectFile, checkTexts, schemaOf, dialectFileText } = require('../../src/main/dialects/format.ts')
  const { resolveChain } = require('../../src/main/dialects/chain.ts')
  const p = PROVIDERS[providerKey]
  const parsed = parseDialectFile(fs.readFileSync(file, 'utf8'))
  if (parsed.problem) throw new Error(`${file} isn't a dialect file (${parsed.problem.problem}${parsed.problem.field ? `: ${parsed.problem.field}` : ''})`)
  const schemaDir = path.join(lib.ROOT, 'agent-text', 'schema')
  const schema = schemaOf(fs.readdirSync(schemaDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(schemaDir, f), 'utf8'))))
  const { texts, outdated } = checkTexts(parsed.file, schema)
  const label = path.basename(file).replace(/\.json$/i, '')
  // A test copy: no model, so Auto never picks it; the run puts it in the model slot of every agent of the CLI.
  const { model: _model, ...copy } = parsed.file
  const at = `${p.provider}/${label}.json`
  const loaded = { path: at, name: copy.name, texts, outdated, on: true }
  const chain = resolveChain({ workspace: null, folders: { [p.provider]: { cli: null, files: [loaded] } } }, { kind: 'session', cli: p.provider, modelFile: loaded })
  return { source: path.resolve(file), path: at, text: dialectFileText(copy), overrides: Object.keys(texts).length, outdated: outdated.map((o) => `${o.id} (${o.problem})`), files: chain.files, hash: chain.hash }
}

/** Puts a run's dialect (dialectForRun) into a scenario workspace: `.combwork/dialects/<CLI>/<label>.json`. */
function placeDialect(dialect, ws) {
  if (!dialect) return
  const dest = path.join(ws, '.combwork', 'dialects', ...dialect.path.split('/'))
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, dialect.text)
}

/** What a result records of its run's dialect: the file it came from, and its chain (files and hash). */
const dialectRecord = (dialect) => (dialect ? { source: dialect.source, path: dialect.path, files: dialect.files, hash: dialect.hash, overrides: dialect.overrides, ...(dialect.outdated.length ? { outdated: dialect.outdated } : {}) } : null)

/** The CLI each provider runs here: the fakes, or the real standalone CLIs, each in its test home. */
const PROVIDERS = {
  fake: { provider: 'claude-code', fake: true, executable: path.join(lib.ROOT, 'tests', 'e2e', 'fake-claude', 'fake-claude.cmd'), mode: 'bypassPermissions' },
  // The fake Codex, in a throwaway home of its own (never the signed-in test home).
  'fake-codex': { provider: 'codex', fake: true, executable: path.join(lib.ROOT, 'tests', 'e2e', 'fake-codex', 'fake-codex.cmd'), mode: 'full-access' },
  // Accept edits, with the hive tools, commands and skills allowed on the command line (its connection's extra arguments):
  // it never asks, and needs no bypass mode (which Claude Code asks to accept once). One value after `=`: the option
  // takes a list, and as separate words it also took the first task Hive passes last, so an agent started on a card sat
  // idle (#498).
  'claude-code': { provider: 'claude-code', executable: '', mode: 'acceptEdits', extraArgs: '--allowedTools=mcp__combwork,Bash,PowerShell,Skill,Monitor' },
  codex: { provider: 'codex', executable: '', mode: 'full-access' },
  // The real Copilot CLI, offline against the scripted stand-in model (tests/e2e/fake-copilot-api.cjs), in a home of the
  // run's own: a fake as far as cost and sign-in go (no credits, none), Copilot's own tools and hooks for the rest.
  'fake-copilot': { provider: 'copilot', fake: true, executable: '', mode: 'allow-all', standIn: true }
}

const sleep = lib.sleep
// The longest the harness waits for something it is waiting on (a file, a session, a report): a bound for a hung run,
// never how long the step should take.
const HUNG_MS = 30000
/** The most of a trial's final reply its results keep (HI-2230): whole for any usual reply, bounded for a runaway one. */
const REPLY_KEPT = 6000
const plain = (text) => String(text).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ').replace(/\x1b\][^\x07]*\x07/g, ' ').replace(/\s+/g, ' ')
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Tools that write or edit files: what they're given is never evidence of a read. */
const WRITERS = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch)$/i

/**
 * Where a token was seen (HI-2259): `known` the tokens, each `{ kind, token }` (the Agent API's workspace, agent and
 * assistant ones, and a launch's hook token: HI-2262),
 * and `seen` what the session printed or said (`tools` and `scripts`, each `{ name, result }`; `replies`, text). Each
 * sighting `{ kind, in: 'tool' | 'script' | 'reply', at, name?, excerpt }`: `at` its place in that list, `excerpt` up to
 * 80 characters before it and 40 after, every known token in it as `<kind token>`, never the token, and any other run
 * of 32 hex or more (a token it doesn't know) as `<hex>`.
 */
function tokenSightings(known, { tools = [], scripts = [], replies = [] }) {
  const mask = (s) => known.reduce((x, t) => x.split(t.token).join(`<${t.kind} token>`), s)
  const out = []
  const look = (where, list, textOf) =>
    list.forEach((item, at) => {
      const text = String(textOf(item) ?? '')
      for (const t of known) {
        if (!text.includes(t.token)) continue
        // Masked whole first, then cut: a cut through another token would leave a part of it.
        const label = `<${t.kind} token>`
        const sentinel = '\u0000'
        // Any other secret beside it (the hook token, 48 hex, HR2's HI-2259 round 1) is masked too: a run of 32 hex or
        // more, as Hive's tokens are, never ids (a run id is 24, a session id has dashes).
        const whole = mask(text.replace(t.token, sentinel)).replace(/[0-9a-fA-F]{32,}/g, '<hex>')
        const i = whole.indexOf(sentinel)
        const excerpt = (whole.slice(Math.max(0, i - 80), i) + label + whole.slice(i + 1, i + 1 + 40)).replace(/\s+/g, ' ').trim()
        out.push({ kind: t.kind, in: where, at, ...(typeof item === 'object' && item?.name ? { name: item.name } : {}), excerpt })
      }
    })
  look('tool', tools, (x) => x.result)
  look('script', scripts, (x) => x.result)
  look('reply', replies, (x) => x)
  return out
}

/**
 * Every token a scenario's Hive issued, for scoring and masking (HI-2262, HR1's rounds 1 and 2): the workspace's
 * (`apiToken`), then each line of its issuance record (`file`, HIVE_TEST_TOKEN_LOG: Hive appends each hook, agent and
 * Assistant token as it makes it, before any session can hold it), so a token whose launch ended and whose files went
 * long before the scoring is known. The record is evidence the result needs: missing, unreadable or with a line that
 * isn't `{ kind, token }` it throws, and the scenario fails rather than scoring with tokens left out.
 */
function knownTokens(file, apiToken) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    throw new Error(`the token record (HIVE_TEST_TOKEN_LOG) can't be read (${e?.code ?? 'error'}): the leak check can't be scored`, { cause: e })
  }
  const issued = text.split(/\r?\n/).filter((l) => l.trim()).map((line, i) => {
    let t = null
    try {
      t = JSON.parse(line)
    } catch {
      // not JSON: said below
    }
    if (!t || !['hook', 'agent', 'assistant'].includes(t.kind) || typeof t.token !== 'string' || !/^[0-9a-f]{32,}$/.test(t.token)) throw new Error(`the token record (HIVE_TEST_TOKEN_LOG) has a malformed line ${i + 1}: the leak check can't be scored`)
    return { kind: t.kind, token: t.token }
  })
  if (typeof apiToken !== 'string' || apiToken.length < 16) throw new Error("no workspace token: the leak check can't be scored")
  return [{ kind: 'workspace', token: apiToken }, ...issued.filter((t, i) => t.token !== apiToken && issued.findIndex((u) => u.token === t.token) === i)]
}

/** Text with every token in `tokens` as `<token>`: what a result keeps of what the session printed or said. */
const maskTokens = (tokens, v) => tokens.reduce((x, t) => x.split(t).join('<token>'), String(v))

/** What a result keeps of `observed`: each tool call's input and result 400 characters, the final reply bounded, every token in `tokens` masked. */
function retainedObserved(observed, tokens) {
  const short = (v) => maskTokens(tokens, v).slice(0, 400)
  return { ...observed, tools: observed.tools.map((t) => ({ ...t, input: short(t.input), result: short(t.result) })), replies: undefined, settings: undefined, ...keptReply(maskTokens(tokens, observed.finalReply ?? '')) }
}

/**
 * What a session's transcript shows: every tool call (name, summary, input, result, error), the Hive skills it read,
 * the hive tools it names (mentions: a transcript isn't proof a call ran; the server's log is), and its last reply.
 * A skill counts as read only when the read worked and shows the skill: a Skill call for it that didn't fail, or a
 * tool (not a writer) given its SKILL.md whose result has the skill's own `name:` line. That line may come JSON-escaped
 * (a Codex code-mode script's exec_command result carries the file as `"output":"---\r\nname: x\r\n…"`), so the result
 * is also matched with escaped line breaks and quotes turned back into real ones.
 */
/** A skill copy's folder prefix, as a pattern: cw-<name> since HI-2463, hive-<name> before, or none (HI-2560). */
const COPY_PREFIX = '(?:hive-|cw-)?'
function observeTranscript(items, skillNames, skillRefs = new Map()) {
  // `cwd`: the folder a command ran in, where its CLI recorded it apart from the command (a Codex Shell's, HI-2264).
  const tools = items.filter((x) => x.kind === 'tool').map((x) => ({ name: x.tool.name, summary: x.tool.summary, input: String(x.tool.input ?? ''), isError: x.tool.isError, result: String(x.tool.result ?? ''), ...(x.tool.cwd ? { cwd: String(x.tool.cwd) } : {}) }))
  const unescaped = (text) => text.replace(/\\+r\\+n|\\+[rn]/g, '\n').replace(/\\+"/g, '"')
  const skillsRead = []
  for (const t of tools) {
    if (t.isError || WRITERS.test(t.name)) continue
    for (const n of skillNames) {
      if (skillsRead.includes(n)) continue
      const viaTool = /^skill$/i.test(t.name) && new RegExp(`(^|[":\\s])(hive:)?${escape(n)}(\\b|$)`).test(t.input)
      const nameLine = new RegExp(`(^|\\s)name:\\s*["']?${escape(n)}["']?\\s*$`, 'm')
      const viaRead = new RegExp(`skills[\\\\/]+${COPY_PREFIX}${escape(n)}[\\\\/]+SKILL\\.md`, 'i').test(t.input) && (nameLine.test(t.result) || nameLine.test(unescaped(t.result)))
      if (viaTool || viaRead) skillsRead.push(n)
    }
  }
  // A skill's reference files read (HI-2011: SKILL.md as a contents page): only a read that worked, of that one file,
  // whose result holds the file's own first line (its heading). A writer, a failed call, a listing, a search, or a
  // command that mentions the path but shows something else never counts; nor does reading SKILL.md (skillsRead).
  const skillRefsRead = []
  const LISTING = /\b(ls|dir|Get-ChildItem|gci|grep|rg|Select-String|findstr|find|tree|Glob|Grep)\b/i
  for (const t of tools) {
    if (t.isError || WRITERS.test(t.name) || /^(Glob|Grep|LS)$/i.test(t.name)) continue
    const shell = !/^(Read|view|read_file)$/i.test(t.name)
    if (shell && (LISTING.test(t.input) || !/\b(cat|type|Get-Content|gc)\b/i.test(t.input))) continue
    for (const [n, files] of skillRefs) {
      for (const [file, head] of files) {
        const ref = `${n}/${file}`
        if (skillRefsRead.includes(ref)) continue
        const at = new RegExp(`skills[\\\\/]+${COPY_PREFIX}${escape(n)}[\\\\/]+${escape(file)}`, 'gi')
        // One file a call: a command naming two of the skill's files is no evidence of either.
        const named = [...t.input.matchAll(new RegExp(`skills[\\\\/]+${COPY_PREFIX}${escape(n)}[\\\\/]+[\\w.-]+\\.md`, 'gi'))].length
        if ((t.input.match(at) ?? []).length && named === 1 && (t.result.includes(head) || unescaped(t.result).includes(head))) skillRefsRead.push(ref)
      }
    }
  }
  // Names of hive tools in the transcript: a direct call (mcp__combwork__x, combwork.x, Combwork's "combwork · x"), or one written in a
  // Codex script (tools.mcp__combwork__x(...)), which may or may not have run: a script whose calls were read from its
  // rollout (HI-2235) is a `script` item, its calls tools of their own.
  const hiveName = (name) => /(?:^|[_.\s])(cw_[a-z]+(?:_[a-z]+)*)$/.exec(name)?.[1]
  const scripts = items.filter((x) => x.kind === 'script').map((x) => ({ name: x.tool.name, input: String(x.tool.input ?? '') }))
  const hiveMentions = [...tools, ...scripts].flatMap((t) => (hiveName(t.name) ? [hiveName(t.name)] : [...t.input.matchAll(/\btools\.(?:mcp__combwork__)?(cw_[a-z]+(?:_[a-z]+)*)\s*\(/g)].map((m) => m[1])))
  const replies = items.filter((x) => x.kind === 'assistant').map((x) => x.text)
  return { tools, skillsRead, skillRefsRead, hiveMentions, finalReply: replies.at(-1) ?? '', replies }
}

/**
 * Each skill's reference files (HI-2011) and their first lines, by skill: what a read of one is known by.
 */
function skillRefsOf(dir, names) {
  const out = new Map()
  for (const n of names) {
    const folder = path.join(dir, n)
    const files = new Map()
    for (const f of fs.existsSync(folder) ? fs.readdirSync(folder) : []) {
      if (f === 'SKILL.md' || !f.endsWith('.md')) continue
      const head = fs.readFileSync(path.join(folder, f), 'utf8').split(/\r?\n/)[0].trim()
      if (head) files.set(f, head)
    }
    if (files.size) out.set(n, files)
  }
  return out
}

/**
 * Whether Hive's metrics count every hive call the bridges logged. Both sides are the whole run: the log has every call
 * since the launch, setup's too, and the metrics read covers the run's own workspace from before its setup. (Against the
 * scenario's baseline instead, a setup call reported before it would be in the log but not the difference, #527.) A
 * fake's `direct` board change went through no bridge, so nothing reports it.
 */
function allCallsReported(logged, metrics) {
  return !!metrics && metricsTotals(metrics).toolCalls >= logged.filter((c) => !c.direct).length
}

/**
 * The calls the hive MCP servers ran, from their test log: [{ tool, role, project, agent, ok, error, args, mode, chars,
 * bytes }]. Its other lines (HI-2186: `kind: 'list'`, a server's tool list) are left out: readMcpLists has those.
 */
function readMcpLog(file) {
  return readJsonLines(file).filter((l) => l.kind === undefined)
}

/** The tool lists the hive MCP servers sent (HI-2186), one a server: [{ at, role, project, agent, tools, bytes, chars }]. */
function readMcpLists(file) {
  return readJsonLines(file).filter((l) => l.kind === 'list')
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

/**
 * The source a run used: the commit, and a fingerprint of everything uncommitted: changes to tracked files (the diff
 * against HEAD) and the untracked files that aren't ignored, each by its path and its bytes, in path order. Null when
 * there's nothing uncommitted.
 */
function sourceFingerprint(root = lib.ROOT) {
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, env: lib.baseEnv() })
  const head = git('rev-parse', '--short', 'HEAD').toString().trim()
  const h = require('crypto').createHash('sha256')
  const diff = git('diff', '--binary', 'HEAD')
  h.update('diff\0').update(diff)
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z').toString().split('\0').filter(Boolean).sort()
  for (const f of untracked) {
    h.update(`\0file\0${f}\0`)
    h.update(fs.readFileSync(path.join(root, f)))
  }
  return { head, dirty: diff.length || untracked.length ? h.digest('hex').slice(0, 12) : null }
}

/**
 * What keeps a model trial from running, or null (#302): Hive showing the session waiting for a sign-in, or the CLI's
 * own words, matched with the e2e runner's list (lib.cjs environmentProblem: a usage or rate limit, the sign-in, an
 * overloaded API, the network). `replies` are what the CLI said (never the prompt, which may name any of these);
 * `screen` is its terminal before anything was typed. Such a trial is skipped for the environment, at once.
 */
function trialEnvironment({ status = null, replies = [], screen = '' } = {}) {
  if (status === 'signin') return 'not signed in: Hive shows the session waiting for a sign-in'
  return lib.environmentProblem([...replies, screen].join('\n'))
}

/**
 * Why a prompt the CLI never took was refused by the environment, or null (#1321): what it drew once the prompt was
 * typed (Claude Code's "Not logged in · Run /login" can show only then), not counting what the prompt itself names, or,
 * when its screen says nothing, its own sign-in status (`auth`: Claude Code's `auth status --json`, or null).
 */
function promptRefused({ prompt = '', screen = '', auth = null } = {}) {
  const named = new Set(lib.environmentProblems(prompt).map((x) => x.why.split(':')[0]))
  const drawn = lib.environmentProblems(screen).find((x) => !named.has(x.why.split(':')[0]))
  if (drawn) return drawn.why
  if (auth?.loggedIn === false) return "not signed in: its auth status says it isn't logged in"
  return null
}

/**
 * How the session under test's trust question is answered in a run after its launch's (HI-2225: Hive's relaunch in a slot,
 * which can come before the harness's prompt has even been taken): 'enter' (Copilot's, Codex's: Yes first), 'claude'
 * (Claude Code's menu, starting on "No, exit": lib.acceptClaudeTrust), or null. Never in the launch's own run (answered as
 * it started; its question may still be in the buffer), nor twice in a run.
 */
function relaunchTrust({ status, runId, launchRun, answered, screen = '', provider }) {
  if (status !== 'waiting' || !runId || runId === launchRun || answered.has(runId)) return null
  if (/Do you trust the files in this folder/i.test(screen)) return 'enter'
  if (/trust this folder/i.test(screen)) return provider === 'codex' ? 'enter' : 'claude'
  return null
}

/**
 * The final reply as a trial's results keep it (HI-2230: checks judge it, and one cut at 400 characters couldn't be
 * audited): whole up to REPLY_KEPT characters, with its whole length when longer (a trial's results are about 40 KB;
 * a reply about 1 KB). `text` is already masked of tokens.
 */
function keptReply(text) {
  const reply = String(text ?? '')
  return { finalReply: reply.slice(0, REPLY_KEPT), ...(reply.length > REPLY_KEPT ? { finalReplyLength: reply.length } : {}) }
}

/**
 * A prompt the CLI never took, nor refused for the environment (HI-1168): nothing of the model's ran, so the trial is a
 * setup error (no checks, incomplete in the benchmark), never its checks failed as the model's. Null once it was taken.
 */
function promptNotTaken({ taken = false, screen = '' } = {}) {
  if (taken) return null
  return `setup: the prompt was never taken; its screen ends: ${JSON.stringify(lib.plainText(screen).trim().slice(-300))}`
}

/** The lines of Hive's log (a test profile's), or none. */
const logLines = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/)
  } catch {
    return []
  }
}
/** Whether Hive's log says this agent's terminal exited (its process ended). */
const ptyExitedIn = (file, agentId) => logLines(file).some((l) => /\[pty\] exit /.test(l) && l.includes(`#${agentId}⁩`))
/**
 * Why Hive says a CLI exited before its session started (sessions.ts failedStart), or '': the latest such line, which
 * names the agent by its label, not its id (a scenario's session under test starts first).
 */
function startFailureIn(file) {
  const line = logLines(file).filter((l) => /exited with code -?\d+ before it started: /.test(l)).pop() ?? ''
  return /before it started: ⁨([^⁩]*)⁩/.exec(line)?.[1].trim() ?? ''
}
/**
 * What Claude Code's own `auth status --json` says of its home now, through the executable Hive started this agent
 * with (its log's spawn line), or null if it can't be asked. A test home only: `env` names it.
 */
function claudeAuthStatus(file, agentId, env) {
  const spawned = logLines(file).filter((l) => /\[pty\] spawn /.test(l) && l.includes(`#${agentId}⁩`)).pop() ?? ''
  const exe = /⁩: (.+?) \[/.exec(spawned)?.[1]
  if (!exe || !env.CLAUDE_CONFIG_DIR) return null
  let out = ''
  try {
    out = execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${exe}" auth status --json`], { env: lib.childEnv({ CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR }), encoding: 'utf8', timeout: 30000, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (e) {
    // Signed out, it exits with 1, still printing its answer.
    out = typeof e?.stdout === 'string' ? e.stdout : ''
  }
  return parseAuthStatus(out)
}
/** `auth status --json`'s answer (indented JSON over several lines), or null when it printed none. */
function parseAuthStatus(out) {
  try {
    const j = JSON.parse(String(out ?? '').trim())
    return j && typeof j === 'object' ? j : null
  } catch {
    return null
  }
}

/** Where a CLI's screen (plain text, one line) says something failed: from that word on. */
const FAILURE_WORDS = /\b(?:error|errors|failed|failure|invalid|cannot|can't|unknown|not found|exception|refused|denied)\b.*$/i

/**
 * A CLI that exited before its session started (#577): skipped for the environment when what it last showed, the
 * reason Hive gives, or (when Hive gives none) its sign-in status says so (an OAuth session it couldn't refresh prints
 * its error and exits at once, often before a poll sees the screen); otherwise an error, at once rather than after the
 * trial's limits.
 */
function launchEnded({ screen = '', reason = '', auth = null } = {}) {
  const env = trialEnvironment({ screen: [screen, reason].join('\n') })
  if (env) return { environment: env }
  // Its auth status only stands in for a failure nobody saw: a concrete one, in Hive's reason or on its screen (an
  // argument it rejects), stays an error even when the test home is signed out too, so a broken launch isn't hidden as
  // the environment. A screen with no error on it (its banner) is no failure.
  const failure = reason.trim() || (FAILURE_WORDS.exec(screen)?.[0] ?? '').slice(0, 200).trim()
  if (!failure && auth?.loggedIn === false) return { environment: "not signed in: its auth status says it isn't logged in" }
  const said = failure || screen.slice(-200).trim()
  return { error: `the session ended at launch${said ? `: ${said}` : ''}` }
}
/**
 * The CLI's own notices in a transcript's items (#342): not a background task's summary or a command's output (a
 * notice `from` them), which may discuss a sign-in or a limit without the CLI having one.
 */
const cliNotices = (items) => (items ?? []).filter((x) => x.kind === 'notice' && !x.from).map((x) => x.text)

/** What to do about an environment skip, said once for the trials it stops (never a sign-in from here). */
function environmentAdvice(why, providerKey) {
  if (PROVIDERS[providerKey]?.fake) return 'run them without --signed-out (the fake was started signed out)'
  const home = providerKey === 'codex' ? `Codex's test home (${lib.CODEX_HOME}), see tests/e2e/README.md` : `Claude Code's test home (${CLAUDE_TEST_HOME}), see tests/scenarios/README.md`
  if (why.startsWith('not signed in')) return `sign in to ${home}, by hand`
  if (why.startsWith('usage or rate limit')) return 'run them again once the limit has reset'
  return 'run them again later'
}

/**
 * Claude Code's memory of the folders in and under `root` (HI-2260): its auto-memory is kept in its home, in
 * `projects/<the folder's path, each character but a letter or digit a dash>/memory`, so a later trial in the same
 * folder (each trial of a scenario has the same one) would start from what an earlier one remembered. Removes those
 * `memory` folders only, never a transcript. The name can't tell a dash from a path separator, so a sibling named as
 * `root` and a dash (the same scenario's evidence folder `<id>-2`, run.mjs) is forgotten too, which is as wanted;
 * `<id>2` or any other name isn't. Returns the folders removed.
 */
function forgetClaudeMemory(home, root) {
  const name = path.resolve(root).replace(/[^A-Za-z0-9]/g, '-').toLowerCase()
  const projects = path.join(home, 'projects')
  let entries = []
  try {
    entries = fs.readdirSync(projects, { withFileTypes: true })
  } catch {
    return []
  }
  const removed = []
  for (const e of entries) {
    const n = e.name.toLowerCase()
    if (!e.isDirectory() || (n !== name && !n.startsWith(`${name}-`))) continue
    const memory = path.join(projects, e.name, 'memory')
    if (!fs.existsSync(memory)) continue
    fs.rmSync(memory, { recursive: true, force: true, maxRetries: 3 })
    removed.push(memory)
  }
  return removed
}

/**
 * Runs `sc` with `providerKey` (fake, claude-code or codex). `opts`: { model, effort, timeoutMs, port, keep, workRoot,
 * signedOut (a fake only: it acts out an expired sign-in, for checking the environment skip; 'launch': one that stops it
 * at launch; 'late': one shown only once the prompt is sent, #1321) }.
 * Returns { scenario, provider, model, cliVersion, guidance, observed, checks, usage, seconds, error }.
 */
async function runScenario(sc, providerKey, opts = {}) {
  const p = PROVIDERS[providerKey]
  const id = `${sc.id}-${providerKey}`
  // A folder of its own, made fresh (#253: evidence.cjs keeps an earlier one a card cites, or every earlier one while the
  // board can't be read, and takes `<id>-2`… instead).
  const base = path.join(opts.workRoot ?? path.join(lib.WORK, '..', 'scenarios'), id)
  const root = opts.evidence ? freshFolder(base, opts.evidence) : base
  const userData = path.join(root, 'profile')
  const ws = path.join(root, 'ws')
  const alpha = path.join(ws, 'alpha')
  const fakeHome = path.join(root, 'claude-home')
  const fakeCodexHome = path.join(root, 'codex-home')
  const mcpLog = path.join(root, 'mcp-calls.jsonl')
  // Every token its Hive issues (HIVE_TEST_TOKEN_LOG, HI-2262): in the scenario's own folder, gone with it.
  const tokenLog = path.join(root, 'tokens.jsonl')
  // Each change to the merge slots, with its time (HIVE_TEST_MERGE_SLOT_LOG, #374): who held one and who waited, when.
  const slotLog = path.join(root, 'merge-slots.jsonl')
  // Each state view Hive gave the Assistant at a session start (#1032), as Hive's development builds record them.
  const startViewLog = path.join(root, 'start-views.jsonl')
  // What fake-copilot's stand-in model was sent (it starts just before the launch, below).
  const modelLog = path.join(root, 'copilot-api.jsonl')
  // Emptied first (with no evidence store: a caller of its own, like an e2e suite). Still in use (something an earlier
  // run left running holds it, #542): this scenario fails, saying so, and the run goes on.
  if (!opts.evidence) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
    } catch (e) {
      return { scenario: sc.id, title: sc.title, provider: providerKey, model: opts.model ?? '(default)', role: sc.role ?? 'agent', checks: [], observed: null, usage: null, measures: null, seconds: 0, error: `its folder ${root} is still in use from an earlier run (${e.code ?? e.message}): something left running holds it` }
    }
  }
  // What the real Claude Code remembered in an earlier trial in these folders (its auto-memory, kept in its test home by
  // folder path, the same path each trial of a scenario) is forgotten, so no trial starts from another's (HI-2260).
  if (providerKey === 'claude-code') forgetClaudeMemory(CLAUDE_TEST_HOME, root)
  fs.mkdirSync(fakeHome, { recursive: true })
  if (providerKey === 'fake-codex') {
    fs.mkdirSync(fakeCodexHome, { recursive: true })
    fs.writeFileSync(path.join(fakeCodexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  }
  // The fakes follow Hive's notices as a model does (#650): told of something in their inbox, they read it and ack it.
  fs.writeFileSync(path.join(fakeHome, 'fake-follow-notices.txt'), '')
  if (providerKey === 'fake-codex') fs.writeFileSync(path.join(fakeCodexHome, 'fake-follow-notices.txt'), '')
  // In code mode, as real Codex works (HI-2235): its calls come from scripts, read back from its rollout.
  if (providerKey === 'fake-codex') fs.writeFileSync(path.join(fakeCodexHome, 'fake-code-mode.txt'), '')
  lib.gitProject(alpha, { 'README.md': '# alpha\n\nA small project for Hive scenarios.\n', 'math.js': 'module.exports = {}\n', ...sc.files })
  for (const other of sc.projects ?? []) lib.gitProject(path.join(ws, other), { 'README.md': `# ${other}\n` })
  // The run's dialect (--dialect), for the trial's CLI.
  placeDialect(opts.dialect, ws)
  // The fake trusts these folders; the real Claude Code asks (answered below); Codex reads its test home's trust list.
  fs.writeFileSync(path.join(fakeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase(), ws.toLowerCase()]))
  // A fake that acts out an expired sign-in: each prompt's turn ends with "Login expired · Please run /login".
  if (opts.signedOut && p.fake) fs.writeFileSync(path.join(fakeHome, 'fake-signin.json'), JSON.stringify({ expired: true, ...(opts.signedOut === 'launch' ? { atLaunch: true } : opts.signedOut === 'late' ? { late: true } : {}) }))
  if (providerKey === 'codex') {
    lib.trustForCodex(alpha)
    lib.trustForCodex(ws)
  }

  lib.enableProviders(userData, ['claude-code', 'codex', ...(p.provider === 'copilot' ? ['copilot'] : [])])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  if (p.executable) cfg.settings.providers[p.provider].executablePath = p.executable
  for (const pid of ['claude-code', 'codex', 'copilot']) cfg.settings.providers[pid] = { ...cfg.settings.providers[pid], enableDangerousMode: true }
  // A scenario's own General settings (sc.general) on top.
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', ...sc.general }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  // The Assistant runs on the provider under test: the subject, or (sc.assistantMessages) the sender of messages to it.
  if (sc.role === 'assistant' || sc.assistantMessages) {
    cfg.settings.assistant = {
      ...cfg.settings.assistant,
      provider: p.provider,
      control: sc.control ?? (sc.role === 'assistant' ? 'projects' : 'agents'),
      // Settings → Assistant → Control → Change settings (#186): off unless the scenario turns it on.
      changeSettings: sc.changeSettings === true,
      // Its mode (#259): the scenario's, else Hive's default.
      ...(sc.mode ? { mode: sc.mode } : {}),
      providers: { ...cfg.settings.assistant?.providers, [p.provider]: { model: opts.model ?? '', effort: opts.effort ?? '', permissionMode: p.mode, extraArgs: p.extraArgs ?? '' } }
    }
  }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const port = opts.port ?? 47930
  const started = Date.now()
  // The stand-in model for fake-copilot, on a port of its own: closed when the run ends, or at once if Copilot's
  // environment or the launch fails before the run begins (#464), and that failure is the one thrown.
  const standIn = p.standIn ? await startFakeCopilotApi({ log: modelLog }) : null
  let app, inv, env, page
  try {
    // Each CLI's home is a test one: the fake's per run, the real Claude Code's and Codex's signed-in test homes.
    env = {
      HIVE_API_PORT: String(port),
      HIVE_TEST_TIPS: 'off',
      HIVE_TEST_MCP_LOG: mcpLog,
      HIVE_TEST_TOKEN_LOG: tokenLog,
      HIVE_TEST_MERGE_SLOT_LOG: slotLog,
      HIVE_TEST_START_VIEW_LOG: startViewLog,
      CLAUDE_CONFIG_DIR: providerKey === 'claude-code' ? CLAUDE_TEST_HOME : fakeHome,
      CODEX_HOME: providerKey === 'fake-codex' ? fakeCodexHome : lib.CODEX_HOME,
      // The real Codex runs its commands in Windows PowerShell, not the Store's PowerShell 7 (#584, lib.cjs).
      ...(providerKey === 'codex' ? { PATH: lib.pathWithoutStoreAliases() } : {}),
      // Copilot in the run's own home, its profile folder faked and the GitHub CLI's login hidden (fake-copilot-api.cjs).
      ...(standIn ? copilotTestEnv(standIn, root, { above: root }) : {})
    }
    // Its token record starts empty: a scenario's Hive appends to it (missing at the end, the run is invalid).
    fs.writeFileSync(tokenLog, '')
    ;({ app, inv, page } = await lib.launch({ userData, env }))
  } catch (e) {
    await standIn?.close().catch(() => undefined)
    throw e
  }
  const result = { scenario: sc.id, title: sc.title, provider: providerKey, model: opts.model ?? '(default)', role: sc.role ?? 'agent', control: sc.role === 'assistant' ? (sc.control ?? 'projects') : undefined, cliVersion: null, guidance: null, ...(opts.dialect ? { dialect: dialectRecord(opts.dialect) } : {}), checks: [], observed: null, usage: null, measures: null, metricsOverheadMs: 0, seconds: 0, error: null }
  try {
    const info = await lib.waitForProvider(inv, p.provider, 60000)
    result.cliVersion = info.version ?? null
    await inv('workspace:open', ws)
    // The Agent API's token, once Hive has written its file (read whole: a file still being written doesn't parse).
    const apiFile = path.join(userData, 'agent-api.json')
    const readToken = () => {
      try {
        return JSON.parse(fs.readFileSync(apiFile, 'utf8')).token || null
      } catch {
        return null
      }
    }
    const apiToken = await lib.until(async () => readToken(), HUNG_MS)
    if (!apiToken) throw new Error(`no Agent API token in ${apiFile} after ${HUNG_MS / 1000} s`)
    const api = async (method, route, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      const text = await res.text()
      let parsed = null
      try {
        parsed = JSON.parse(text)
      } catch {
        // not JSON
      }
      return { status: res.status, body: parsed, text }
    }
    // The guidance and skills Hive has before the scenario's setup (the session's own, after it, are recorded below).
    const first = await api('GET', '/v1/status')
    // A refused token here is another Hive answering on this port, not this one's API (#1127): say so, not "card a: …".
    if (first.status === 401) throw new Error(`the Agent API on port ${port} refused this test Hive's token: another Hive is listening on that port`)
    result.guidance = { atStart: first.body?.guidance ?? null, delivered: null }

    // The project's agents: the one under test (Coder), and another that did earlier work (Implementer, never started),
    // on a connection with the scenario's extra arguments (HI-2122: a connection's, not the project's).
    const launch = { provider: p.provider, model: opts.model ?? '', effort: opts.effort ?? '', permissionMode: p.mode, extraArgs: p.extraArgs ?? '' }
    const coder = await lib.addAgent(inv, alpha, { name: 'Coder', ...launch })
    const implementer = await lib.addAgent(inv, alpha, { name: 'Implementer', ...launch })
    // The run's dialect in their model slot (HI-2443: their Dialect setting), applied at their launch.
    if (opts.dialect) for (const a of [coder, implementer]) await inv('agents:update', alpha, a.id, { dialect: opts.dialect.path })
    const ctx = {
      api,
      inv,
      /** A fake provider acts the scenario out (the fake CLIs, or Copilot against the scripted stand-in model). */
      fake: !!p.fake,
      /** What Copilot sent the stand-in model (its system prompt first), for fake-copilot; null for the others. */
      modelLog: standIn ? modelLog : null,
      ws,
      alpha,
      skillsDir: path.join(ws, '.combwork', 'skills'),
      agents: { coder, implementer },
      cards: {},
      /** A card: { title, description, project (alpha), column, agent ('coder' | 'implementer'), labels, comments: [text] }. */
      card: async (key, c) => {
        const r = await api('POST', '/v1/tasks', { title: c.title, description: c.description ?? '', project: c.project ?? 'alpha', labels: c.labels ?? [], ...(c.context ? { context: c.context } : {}), ...(c.agent ? { agent: ctx.agents[c.agent].id } : {}) })
        if (r.status !== 200) throw new Error(`card ${key}: ${r.text}`)
        for (const text of c.comments ?? []) await api('POST', `/v1/tasks/${r.body.number}/comments`, { text })
        if (c.column && c.column !== 'todo') {
          await inv('tasks:update', r.body.number, { column: c.column, ...(c.agent ? { agent: ctx.agents[c.agent].id } : {}) })
          // Under a project's rules a move can stop part way (#1537: a submission with nothing committed stays in Doing):
          // the scenario never runs on a card that isn't where its setup put it.
          const now = (await api('GET', `/v1/tasks/${r.body.number}`)).body?.column
          if (now !== c.column) throw new Error(`setup: card ${key} is in ${now}, not ${c.column}: under the project's rules, move it as the user does (a real submission)`)
        }
        ctx.cards[key] = r.body.number
        return r.body.number
      },
      handover: (title, content) => api('POST', '/v1/shared/handovers', { title, content, project: 'alpha' }),
      note: (rel, content) => api('PUT', `/v1/shared/file?path=${encodeURIComponent(rel)}`, { content }),
      write: (rel, text) => fs.writeFileSync(path.join(alpha, rel), text),
      read: (rel) => (fs.existsSync(path.join(alpha, rel)) ? fs.readFileSync(path.join(alpha, rel), 'utf8') : null),
      git: (...a) => execFileSync('git', a, { cwd: alpha, encoding: 'utf8', env: lib.baseEnv() }),
      /** Starts another of alpha's agents ('implementer'), with no prompt: running, so it can hold the merge slot. */
      startAgent: async (key) => {
        await inv('session:start', alpha, { agentId: ctx.agents[key].id })
        const up = await lib.until(async () => (await inv('session:live')).some((x) => x.projectPath.toLowerCase() === alpha.toLowerCase() && x.agentId === ctx.agents[key].id), 30000)
        if (!up) throw new Error(`${key} didn't start within 30 s`)
      },
      /**
       * alpha's merge slot as another of its running agents ('implementer') uses it: claim or release with that agent's
       * own Agent API token (each agent's in the profile's agent-api folder, as its hive tools read it).
       */
      slot: async (key, action, body = {}) => {
        const file = path.join(userData, 'agent-api', `${require('crypto').createHash('sha256').update(`${alpha.toLowerCase()}#${ctx.agents[key].id}`).digest('hex').slice(0, 16)}.json`)
        const token = JSON.parse(fs.readFileSync(file, 'utf8')).token
        const res = await fetch(`http://127.0.0.1:${port}/v1/projects/alpha/merge-slot/${action}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        const reply = await res.json().catch(() => null)
        if (res.status !== 200) throw new Error(`${key}'s merge slot ${action}: ${res.status} ${JSON.stringify(reply)}`)
        return reply
      },
      /**
       * A call of the Agent API as another of alpha's running agents ('implementer', started with startAgent), with its own
       * token (#1382: a builder's design posted for the subject to check): { status, body }.
       */
      as: async (key, method, route, body) => {
        const file = path.join(userData, 'agent-api', `${require('crypto').createHash('sha256').update(`${alpha.toLowerCase()}#${ctx.agents[key].id}`).digest('hex').slice(0, 16)}.json`)
        const token = JSON.parse(fs.readFileSync(file, 'utf8')).token
        const res = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
        return { status: res.status, body: await res.json().catch(() => null) }
      },
      /** alpha's merge slot now, as a script reads it. */
      slotNow: async () => (await api('GET', '/v1/projects/alpha/merge-slot')).body,
      /**
       * The Assistant started and ready (sc.assistantMessages, #650), with no prompt: nothing is sent to its model. Its
       * trust question answered.
       */
      startAssistant: async () => {
        const home = (await inv('workspace:refresh')).assistant.path
        const up = async () => (await inv('session:live')).find((x) => x.projectPath.toLowerCase() === home.toLowerCase() && x.agentId === 'assistant')
        if (!(await up())) await inv('session:start', home, { agentId: 'assistant' })
        const k = lib.ptyKey(home, 'assistant')
        for (let t = Date.now(); Date.now() - t < 90000 && !['ready', 'finished', 'working'].includes((await up())?.status); ) {
          const screen = plain(await inv('pty:buffer', k).catch(() => ''))
          if (/Do you trust the files in this folder/i.test(screen)) await inv('pty:write', k, '\r')
          else if (/trust this folder/i.test(screen)) {
            if (p.provider === 'codex') await inv('pty:write', k, '\r')
            else await lib.acceptClaudeTrust(inv, home, 'assistant', 3000)
          }
          await sleep(500)
        }
        if (!['ready', 'finished', 'working'].includes((await up())?.status)) throw new Error(`setup: the Assistant didn't get ready (${(await up())?.status ?? 'not running'})`)
      },
      /**
       * Leaves one of alpha's agents ('coder') a message as the Assistant does (#650): cw_message_agent through the real
       * hive MCP server with the Assistant's own token (the Assistant started first if it isn't); `extra`: more of the tool's
       * arguments (#652: `card`). Its reply's text.
       */
      assistantMessage: async (key, text, extra = {}) => ctx.assistantTool('cw_message_agent', { project: 'alpha', agent: ctx.agents[key].name, text, ...extra }),
      /**
       * Calls a hive tool as the Assistant does: through the real hive MCP server with the Assistant's own token (the
       * Assistant started first if it isn't), its journal's tools offered (#1032). The reply's text.
       */
      assistantTool: async (name, args) => {
        await ctx.startAssistant()
        const tokenFile = path.join(userData, 'assistant-api', `${require('crypto').createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
        const out = execFileSync(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'cw-mcp.js')], {
          input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n',
          env: lib.childEnv({ CW_API_URL: `http://127.0.0.1:${port}`, CW_WORKSPACE: ws, HIVE_ROLE: 'assistant', HIVE_ASSISTANT_CONTROL: 'agents', HIVE_JOURNAL: '1', CW_API_TOKEN_FILE: tokenFile, HIVE_API_TOKEN: '', CW_PROJECT: '' }),
          timeout: 60000
        }).toString()
        return JSON.parse(out.split('\n')[0]).result?.content?.[0]?.text ?? ''
      },
      /** Stops the Assistant started in setup, so the scenario launches it afresh (a new conversation). */
      stopAssistant: async () => {
        const home = (await inv('workspace:refresh')).assistant.path
        await inv('session:stop', home, 'assistant')
        const gone = await lib.until(async () => !(await inv('session:live')).some((x) => x.projectPath.toLowerCase() === home.toLowerCase() && x.agentId === 'assistant'), 30000)
        if (!gone) throw new Error("setup: the Assistant didn't stop within 30 s")
      },
      /** The fake Claude Code's home (CLAUDE_CONFIG_DIR), where it reads its scripts and writes its logs. */
      fakeHome,
      /** The provider under test (claude-code, codex, copilot), whichever of its fakes or the real CLI runs. */
      provider: p.provider,
      /** The state views Hive gave the Assistant (#1032), oldest first: { at, provider, source, text }. */
      startViews: () => (fs.existsSync(startViewLog) ? fs.readFileSync(startViewLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
      /** An agent's deliveries (#647) as the Agent API gives them, newest last. */
      deliveries: async (key) => (await api('GET', `/v1/projects/alpha/agents/${encodeURIComponent(ctx.agents[key].name)}/deliveries?limit=50`)).body?.deliveries ?? []
    }
    if (sc.setup) await sc.setup(ctx)
    // What the fake Claude Code does when Hive wakes it (fake-wakes-<agent>.txt, a line per wake): a scenario's next steps,
    // for the session under test (the Assistant's by its name, #402).
    const wakesOf = sc.role === 'assistant' ? 'Assistant' : coder.name
    if (providerKey === 'fake' && sc.fakeWakes) fs.writeFileSync(path.join(fakeHome, `fake-wakes-${String(wakesOf).replace(/[^\w-]/g, '_')}.txt`), sc.fakeWakes(ctx).join('\n') + '\n')
    const skillNames = fs.existsSync(ctx.skillsDir) ? fs.readdirSync(ctx.skillsDir).filter((d) => !d.startsWith('.')) : []

    // Start the session under test, answer a trust question, wait until it's ready, and send the prompt.
    const home = (await inv('workspace:refresh')).assistant.path
    const [host, agentId] = sc.role === 'assistant' ? [home, 'assistant'] : [alpha, coder.id]
    const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === host.toLowerCase() && s.agentId === agentId)
    // Hive's performance metrics before the launch (the run's own workspace: everything in it is this run's).
    const metricsFrom = new Date(started - 2 * 3600_000).toISOString()
    // Each snapshot's request, from just before it was sent to just after its answer (HI-2186): a hive call is in the
    // measured window when its report reached Hive after the first and before the last (benchmark.cjs splitOf).
    const snapshots = { before: null, after: null }
    const snapshot = async (side) => {
      const t = Date.now()
      const start = new Date().toISOString()
      const r = await api('GET', `/v1/metrics?scope=workspace&from=${encodeURIComponent(metricsFrom)}`)
      result.metricsOverheadMs += Date.now() - t
      if (r.status !== 200) return null
      snapshots[side] = { start, end: new Date().toISOString() }
      return r.body
    }
    const metricsBefore = await snapshot('before')
    // A change made inside the measured window (a skill edited after the snapshot, before the launch), for scenarios
    // that compare the skill service's work on unchanged and changed revisions.
    if (sc.beforeLaunch) await sc.beforeLaunch(ctx)
    // Hive's log as the session under test starts: its hive tools connecting is counted from here.
    const launchMark = lib.hiveLogLines(userData).length
    // A subject Hive starts itself (HI-2046: a reviewer given a card that reached Review outside a lane): its launch is
    // the session under test, and Hive's line its prompt.
    const byHive = !!sc.startedByHive
    // A prompt given at launch (HI-2225), on the CLI's command line: the session's first input, before anything setup left
    // for it (Hive types nothing into a launch whose CLI hasn't taken its task yet, #712, and a wake waits for the turn
    // after), so a wake can't come first and do the prompt's work without it. Never with beforePrompt, which waits for
    // that wake's turn.
    const atLaunch = !byHive && !!sc.promptAtLaunch
    if (atLaunch && sc.beforePrompt) throw new Error(`${sc.id}: promptAtLaunch and beforePrompt don't go together`)
    const launchPrompt = !atLaunch ? null : p.fake ? (typeof sc.fake === 'function' ? sc.fake(ctx) : sc.fake) : typeof sc.prompt === 'function' ? sc.prompt(ctx) : sc.prompt
    // The run the session under test launched as (HI-2225), known before any prompt can have Hive relaunch it (a card
    // given in a slot): its trust is answered as it starts (below); a later run's is answered while its turn is waited for.
    let launchRun = null
    if (!byHive) {
      // Refused as already running or starting (HI-2215): Hive started it itself after setup (a lane's card, a review),
      // which a scenario says with startedByHive; never taken as Hive's start here, whose line would then race the prompt.
      const refused = await inv('session:start', host, { agentId, ...(atLaunch ? { prompt: launchPrompt } : {}) }).then((st) => ((launchRun = st?.runId ?? null), null), (e) => e)
      if (refused && /already running or starting/i.test(String(refused.message))) {
        result.error = `setup: Hive started the session under test itself (${String(refused.message).replace(/^.*Error: /, '')}): mark the scenario startedByHive, or have its setup leave it unstarted`
        return result
      }
      if (refused) throw refused
    } else if (!(await lib.until(async () => !!(launchRun = (await live())?.runId ?? null), 90000))) {
      result.error = "Hive didn't start the session under test"
      return result
    }
    const key = lib.ptyKey(host, agentId)
    /** The session under test's conversation as Hive reads it (its transcript's items), or [] before it has one. */
    const conversation = async () => {
      const s = await live()
      return s?.sessionId ? ((await inv('transcript:read', host, s.sessionId).catch(() => null))?.items ?? []) : []
    }
    /** Whether the conversation has a prompt with this text (its start), counted from the `after`th such prompt. */
    const promptIndex = (items, text, after = 0) => items.map((x, i) => (x.kind === 'user' && x.text.includes(text.slice(0, 40)) ? i : -1)).filter((i) => i >= 0)[after] ?? -1
    /**
     * Whether a prompt with this text was answered (#1032 round 3: durable evidence, never a working state sampled in
     * passing): the conversation has it and a reply after it, and the session is idle again.
     */
    ctx.answered = async (text) => {
      const s = await live()
      if (!['finished', 'ready'].includes(s?.status)) return false
      const items = await conversation()
      const at = promptIndex(items, text)
      if (at >= 0 && items.slice(at + 1).some((x) => x.kind === 'assistant')) return true
      // A CLI whose records Hive doesn't read as a conversation (the fake Codex's rollout has no messages): Hive's turn
      // ledger has a turn over that began after the prompt was sent (its own id, not the one before).
      return !!s.turn?.id && s.turn.state === 'over' && s.turn.id !== (turnBefore.get(text) ?? null)
    }
    /** The turn the session was on when a prompt was sent (promptSubject's; none before the first prompt). */
    const turnBefore = new Map()
    /**
     * Sends the session under test another prompt (a scenario's later step, from `during`): typed until it works, which
     * is the session working or the conversation having it (a quick turn may be over before a look sees it working).
     */
    ctx.promptSubject = async (text) => {
      const before = (await conversation()).filter((x) => x.kind === 'user' && x.text.includes(text.slice(0, 40))).length
      turnBefore.set(text, (await live())?.turn?.id ?? null)
      const taken = async () => {
        const s = await live()
        return ['working', 'background'].includes(s?.status) || (!!s?.turn?.id && s.turn.id !== turnBefore.get(text)) || promptIndex(await conversation(), text, before) >= 0
      }
      return lib.sendPrompt(inv, key, text, { submitted: taken, waitMs: 20000 })
    }
    // Skipped for the environment (#302): no checks, no cost; the runner stops the provider's other trials.
    const skipFor = (why) => {
      result.environment = why
      result.skipped = `environment: ${why}`
      return result
    }
    // A trust question answered: the session goes on to its prompt (asked again if it doesn't).
    const answered = () => lib.until(async () => ['ready', 'finished'].includes((await live())?.status), HUNG_MS)
    const readyBy = Date.now() + 90000
    // The CLI's last screen while it starts: Hive drops a terminal's buffer when its process exits (#577).
    let lastScreen = ''
    let seen = false
    let endedAtLaunch = null
    while (Date.now() < readyBy) {
      const s = await live()
      if (s?.status === 'ready' || s?.status === 'finished') break
      // Hive's line already at work: a model's turn on it is the trial. The prompt given at launch, the same.
      if (((byHive && !p.fake) || atLaunch) && ['working', 'background'].includes(s?.status)) break
      const screen = plain(await inv('pty:buffer', key).catch(() => ''))
      if (screen) lastScreen = screen
      // Exited before its session started (an OAuth session it couldn't refresh, #577): no prompt can reach it.
      const hiveLog = path.join(userData, 'logs', 'hive.log')
      if (s) seen = true
      else if (seen || ptyExitedIn(hiveLog, agentId)) {
        endedAtLaunch = launchEnded({ screen: lastScreen, reason: startFailureIn(hiveLog), auth: p.provider === 'claude-code' ? claudeAuthStatus(hiveLog, agentId, env) : null })
        if (endedAtLaunch.environment) return skipFor(endedAtLaunch.environment)
        break
      }
      // Nothing typed yet: what the terminal shows is the CLI's own (a sign-in screen, a limit).
      const before = trialEnvironment({ status: s?.status, screen })
      if (before) return skipFor(before)
      // Copilot asks "Do you trust the files in this folder?", Yes first.
      if (/Do you trust the files in this folder/i.test(plain(await inv('pty:buffer', key).catch(() => '')))) {
        await inv('pty:write', key, '\r')
        await answered()
      } else if (/trust this folder/i.test(plain(await inv('pty:buffer', key).catch(() => '')))) {
        // Claude Code's menu starts on "No, exit": lib's answer presses Enter only once "Yes" shows selected (#218).
        if (p.provider === 'codex') await inv('pty:write', key, '\r')
        else await lib.acceptClaudeTrust(inv, host, agentId)
        await answered()
      }
      await sleep(500)
    }
    // What the session under test was given at its launch (after setup): Hive's guidance and each skill as delivered.
    const subject = sc.role === 'assistant' ? (await inv('workspace:refresh')).assistant : (await inv('workspace:refresh')).projects.find((x) => x.name === 'alpha')
    result.guidance.delivered = subject?.agents.find((a) => a.id === agentId)?.live?.launched ?? null
    // What setup left the session under test rings its doorbell once it's idle, as the prompt is typed (#1613: on Copilot
    // the prompt was lost to the doorbell's turn). A scenario's beforePrompt waits for that turn, so the prompt comes after.
    ctx.subjectStatus = async () => (await live())?.status ?? 'stopped'
    // Every status the session under test reports, in order, as Hive emits it (HI-2022): a state the loop below would
    // look at between its looks (each a few calls and a second apart; a short watch ends in between) is still seen.
    // Each with the watch it had then (HI-2086): the watch a turn ended with, even once a wake has ended it since.
    await page.evaluate((who) => {
      window.__subjectStatuses = []
      window.hive.onEvent((e) => {
        if (e.type === 'session-status' && e.state?.agentId === who.agentId && String(e.state.projectPath).toLowerCase() === who.host.toLowerCase()) window.__subjectStatuses.push({ status: e.state.status, watch: e.state.watch ?? null })
      })
    }, { host, agentId })
    /** The statuses the session under test has reported since its prompt was sent, in order (`watching` included). */
    ctx.statusesSeen = () => page.evaluate(() => (window.__subjectStatuses ?? []).map((x) => x.status))
    /** The same from the `from`th on, each with its watch. */
    ctx.statesSeen = (from = 0) => page.evaluate((n) => (window.__subjectStatuses ?? []).slice(n), from)
    if (sc.beforePrompt && !endedAtLaunch) await sc.beforePrompt(ctx)
    const prompt = typeof sc.prompt === 'function' ? sc.prompt(ctx) : sc.prompt
    const fakePrompt = typeof sc.fake === 'function' ? sc.fake(ctx) : sc.fake
    // Started by Hive: its line, once the conversation has it. A model works on it, typed nothing more; a fake (which
    // does nothing on a line it has no script for) is typed its steps once that turn is over.
    let hiveLine = null
    if (byHive && !endedAtLaunch) {
      const lineOf = async () => (await conversation()).find((x) => x.kind === 'user' && String(x.text ?? '').startsWith('[CW]'))?.text ?? null
      await lib.until(async () => !!(hiveLine = await lineOf()) && (!p.fake || ['ready', 'finished'].includes((await live())?.status)), 60000)
      if (!hiveLine) {
        result.error = "Hive's line never reached the session under test"
        return result
      }
    }
    const text = launchPrompt ?? (p.fake ? fakePrompt : (hiveLine ?? prompt))
    // The prompt is sent, then checked: a CLI still drawing its first screen can drop an Enter (sent again) or the
    // whole line (typed again).
    const submitted = async () => {
      const s = await live()
      if (['working', 'background'].includes(s?.status)) return true
      const items = s?.sessionId ? ((await inv('transcript:read', host, s.sessionId).catch(() => null))?.items ?? []) : []
      return items.some((x) => x.kind === 'user' && x.text.includes(text.slice(0, 40)))
    }
    let notTaken = null
    // Where the prompt's states begin (HI-2086): a watch a turn before it left (a setup wake's, beforePrompt) isn't the
    // prompt's. A model started by Hive's line has no prompt typed: its turn is the line's, all of them; a prompt given at
    // launch was the first input, so the same.
    const statesFrom = (hiveLine && !p.fake) || atLaunch ? 0 : ((await page.evaluate(() => (window.__subjectStatuses ?? []).length).catch(() => 0)) ?? 0)
    if (!endedAtLaunch && !(hiveLine && !p.fake) && !atLaunch) {
      turnBefore.set(text, (await live())?.turn?.id ?? null)
      const mark = String((await inv('pty:buffer', key).catch(() => '')) ?? '').length
      // Real Claude Code: its first prompt waits for its hive tools, as Hive's own first line does (HI-1148).
      const ready = p.provider === 'claude-code' ? () => lib.hiveToolsConnected(userData, agentId, launchMark) : null
      if (!(await lib.sendPrompt(inv, key, text, { submitted, ready, waitMs: 20000 }))) {
        // Never taken: a sign-in or a limit the CLI shows only once something is typed is the environment (#1321).
        const drawn = String((await inv('pty:buffer', key).catch(() => '')) ?? '').slice(mark)
        const refused = promptRefused({ prompt: text, screen: drawn, auth: p.provider === 'claude-code' ? claudeAuthStatus(path.join(userData, 'logs', 'hive.log'), agentId, env) : null })
        if (refused) return skipFor(refused)
        notTaken = promptNotTaken({ taken: await submitted(), screen: drawn })
      }
    }
    const sentAt = Date.now()
    // Later runs of the session under test whose trust question was answered (below).
    const subjectTrusted = new Set()

    // Wait for the turn to end: working (or background) first, then finished/ready for a few seconds. `during` sees the
    // board while it works, for scenarios that change things under it. A quick turn can start and end between two looks
    // (each look is several calls, slow under load: #1311), so the prompt answered counts as the work seen too.
    // A session that ended at launch, or whose prompt was never taken, has no turn to wait for.
    const limit = endedAtLaunch || notTaken ? Date.now() : Date.now() + (opts.timeoutMs ?? 300000)
    let sawWork = false
    let quietSince = 0
    const trustAnswered = new Set()
    while (Date.now() < limit) {
      const s = await live()
      const status = s?.status ?? 'stopped'
      // The CLI's own notes in the transcript (an API error, "Login expired · Please run /login", a usage limit: notices,
      // never the prompt or the model's replies), or Hive waiting for a sign-in: skipped for the environment at once,
      // rather than waiting out the limit and failing every check (#302).
      const notices = s?.sessionId ? cliNotices((await inv('transcript:read', host, s.sessionId).catch(() => null))?.items) : []
      const stopped = trialEnvironment({ status, replies: notices })
      if (stopped) return skipFor(stopped)
      if (['working', 'background', 'starting'].includes(status)) {
        sawWork = true
        quietSince = 0
      } else if (sawWork || (sawWork = await ctx.answered(text)) || Date.now() - sentAt > 60000) {
        quietSince ||= Date.now()
        if (Date.now() - quietSince > (status === 'waiting' ? 3000 : 6000)) break
      }
      // The session under test asking to trust a folder again (HI-2225): Hive gave it its card in a slot, a new run there
      // (preset-pair-lane), whose question (waiting) ended the trial 3 s later, unanswered. Until it is answered the run is
      // still starting.
      // (The screen read only while it waits.)
      const trust = status === 'waiting' ? relaunchTrust({ status, runId: s.runId, launchRun, answered: subjectTrusted, screen: plain(await inv('pty:buffer', key).catch(() => '')).slice(-2000), provider: p.provider }) : null
      if (trust === 'enter') await inv('pty:write', key, '\r')
      if (trust === 'enter' || (trust === 'claude' && (await lib.acceptClaudeTrust(inv, host, agentId, 10000)))) {
        subjectTrusted.add(s.runId)
        quietSince = 0
      }
      if (sc.during) await sc.during(ctx, status)
      // Other agents of the project started during the run (the Assistant dispatching one) ask to trust its folder, once
      // each. Claude Code's menu starts on "No, exit": lib's answer presses Enter only with "Yes" selected (#498: a blind
      // Down and Enter could quit it, and was sent again each second while the question was still in the buffer).
      const running = (await inv('session:live').catch(() => [])).filter((x) => x.projectPath.toLowerCase() === alpha.toLowerCase())
      for (const a of Object.values(ctx.agents)) {
        if ((sc.role !== 'assistant' && a.id === coder.id) || trustAnswered.has(a.id) || !running.some((x) => x.agentId === a.id)) continue
        const k = lib.ptyKey(alpha, a.id)
        const tail = plain(await inv('pty:buffer', k).catch(() => '')).slice(-2000)
        if (/Do you trust the files in this folder/i.test(tail)) {
          await inv('pty:write', k, '\r')
          trustAnswered.add(a.id)
        } else if (/trust this folder/i.test(tail)) {
          if (p.provider === 'codex') await inv('pty:write', k, '\r')
          if (p.provider === 'codex' || (await lib.acceptClaudeTrust(inv, alpha, a.id, 3000))) trustAnswered.add(a.id)
        }
      }
      // A dispatched agent's work is part of the outcome: wait while one is still working, or at a question (its folder's
      // trust, answered above; #498), within the limit.
      if (sc.waitForAgents && quietSince && running.some((x) => ['working', 'starting', 'background', 'waiting'].includes(x.status))) quietSince = Date.now()
      // Something Hive does after the turn has ended (a line it types later, #401) is part of the outcome: wait for it.
      if (sc.keepWaiting && quietSince && (await sc.keepWaiting(ctx, status))) quietSince = Date.now()
      await sleep(1000)
    }
    const s = await live()
    if (endedAtLaunch) result.error = endedAtLaunch.error
    else if (notTaken) result.error = notTaken
    else if (!s || Date.now() >= limit) result.error = s ? 'timed out' : 'the session ended'
    // The bridges report their calls to Hive a batch at a time (every 2 s, or as their CLI closes input): read the
    // metrics once they count every call the bridges logged (allCallsReported). Not all within the bound (a report
    // dropped): the last read, shown as partial.
    let metricsAfter = await snapshot('after')
    let allReported = !metricsBefore || !metricsAfter || allCallsReported(readMcpLog(mcpLog), metricsAfter)
    if (!allReported)
      allReported = !!(await lib.until(async () => {
        metricsAfter = (await snapshot('after')) ?? metricsAfter
        return allCallsReported(readMcpLog(mcpLog), metricsAfter)
      }, HUNG_MS))
    const sessionId = s?.sessionId ?? (await inv('workspace:refresh')).projects.find((x) => x.name === 'alpha')?.agents.find((a) => a.id === coder.id)?.lastSessionId
    // The session under test, for checks of what it was launched with (Codex's rollout carries its instructions, #520).
    ctx.session = { id: sessionId ?? null, codexHome: env.CODEX_HOME }
    const transcript = sessionId ? await inv('transcript:read', host, sessionId).catch(() => null) : null
    // Tool calls the parser shortened for display are read in full (for the token check and read evidence), a Codex
    // script's calls too (HI-2246).
    const items = await readWhole(transcript?.items ?? [], (itemId) => inv('transcript:tool', host, sessionId, itemId))
    // Codex in code mode (HI-2235): each script's calls as Hive's parser gives them (HI-2240, HI-2246), in the script's
    // place. A script whose calls aren't known is no tool: what it ran is unobservable (codeMode.unknown).
    const code = p.provider === 'codex' ? withScriptCalls(items) : { items, scripts: 0, calls: 0, unknown: 0 }
    const observed = observeTranscript(code.items, skillNames, skillRefsOf(ctx.skillsDir, skillNames))
    observed.codeMode = { scripts: code.scripts, calls: code.calls, unknown: code.unknown }
    observed.status = s?.status ?? 'stopped'
    // Every status it reported during the turn, in order (HI-2022): `watching` seen even when it came and went between looks.
    observed.statuses = await ctx.statusesSeen().catch(() => [])
    // The watch it ended its turn with (#402): the live one, not every watch it started (a new one replaces the last).
    observed.watch = s?.watch ?? null
    // The watch of the last turn it ended watching since its prompt (HI-2086), as it reported it then: a wake may have
    // ended that watch before the run looked (the snapshot above), and the turn the wake started, a fake's inbox read,
    // ended with none. Null if it never ended a turn watching. With no states seen, the snapshot's.
    const states = await ctx.statesSeen(statesFrom).catch(() => [])
    observed.turnWatch = states.length ? (states.findLast((x) => x.status === 'watching')?.watch ?? null) : observed.status === 'watching' ? observed.watch : null
    // What Hive woke it with (#402), in order: a line it typed in, or (#650: its doorbell) what the session's next
    // cw_inbox call read, the inbox's own items after the doorbell. Codex calls hive tools from its code tool (Script):
    // its read is the cw_inbox call the script made (HI-2235); with the script's calls unknown, the doorbell's line.
    observed.wakeLines = code.items.flatMap((x, i) => {
      const line = String(x.kind === 'user' ? (x.text ?? '') : '').trim()
      if (!line.startsWith('[CW]')) return []
      if (!line.startsWith('[CW] New in your inbox: ')) return [line.slice(0, 1000)]
      const read = code.items.slice(i + 1).find((y) => y.kind === 'tool' && /cw_inbox/.test(y.tool.name))
      return [String(read?.tool.result ?? line).trim().slice(0, 1000)]
    })
    observed.guidance = result.guidance
    // What the hive servers ran: the subject's own calls, and everyone's (an agent the Assistant started).
    observed.allHiveCalls = readMcpLog(mcpLog)
    observed.mcpLists = readMcpLists(mcpLog)
    observed.mcpReports = readJsonLines(mcpLog).filter((l) => l.kind === 'reported')
    observed.hiveCalls = observed.allHiveCalls.filter((c) => (sc.role === 'assistant' ? c.role === 'assistant' : c.agent === coder.id))
    // Each change to the merge slots (JSON lines, as the MCP log): { at, slots: [{ project, branch, holder, waiting }] }.
    observed.slotLog = readMcpLog(slotLog)
    // Any Agent API token (the workspace's, or an agent's for this launch) in what the session printed or said.
    // Every one this Hive issued (its record, knownTokens), each launch's hook token among them (HI-2262, Darren's
    // decision: CW_HOOK_TOKEN stays in the session's environment, so a listing of it would print that), those of
    // launches long ended too.
    const known = knownTokens(tokenLog, apiToken)
    const tokens = known.map((t) => t.token)
    // A script's own output too (what it printed), beside its calls'.
    const scripts = code.items.filter((x) => x.kind === 'script').map((x) => ({ name: x.tool.name, result: String(x.tool.result ?? '') }))
    // Where each was seen, masked (HI-2259: the results keep 400 characters of a result, so a leak further on was found
    // but not where).
    observed.tokenSeen = tokenSightings(known, { tools: observed.tools, scripts, replies: observed.replies })
    observed.tokenLeak = observed.tokenSeen.length > 0
    observed.cards = Object.fromEntries(await Promise.all(Object.entries(ctx.cards).map(async ([k, n]) => [k, (await api('GET', `/v1/tasks/${n}`)).body])))
    // Each card's workflow facts (1.0: Moved, Override, Refused…), for scenarios about what a move recorded (#1319).
    observed.facts = Object.fromEntries(await Promise.all(Object.entries(ctx.cards).map(async ([k, n]) => [k, (await inv('tasks:facts', n).catch(() => null)) ?? []])))
    observed.allCards = (await api('GET', '/v1/tasks')).body ?? []
    // The lanes as the run left them (#402): running and lately ended.
    observed.lanes = (await api('GET', '/v1/lanes')).body ?? []
    observed.notes = ((await api('GET', '/v1/shared')).body ?? []).flatMap(function flat(e) {
      return e.isDir ? (e.children ?? []).flatMap(flat) : [e.relPath]
    })
    observed.gitStatus = ctx.git('status', '--porcelain')
    observed.live = (await inv('session:live')).map((x) => ({ project: path.basename(x.projectPath), agentId: x.agentId, status: x.status }))
    // Hive's settings afterwards, for scenarios about changing them.
    observed.settings = await inv('settings:get')
    result.usage = sessionId ? await inv('session:usage', host, sessionId).catch(() => null) : null
    // A fake acts a scenario out with scripted board moves: checks only a model's own work can meet are skipped there.
    result.metricsRecording = metricsAfter?.recording ?? null
    // How complete the measurement was: both reads, recording on, nothing dropped or evicted in between.
    const partial = []
    if (!metricsBefore || !metricsAfter) partial.push('Hive’s metrics weren’t read')
    if (metricsAfter && metricsAfter.recording === false) partial.push('recording was off')
    if (!allReported) partial.push('not every hive call was reported')
    const dropped = Math.max(0, (metricsAfter?.dropped ?? 0) - (metricsBefore?.dropped ?? 0))
    if (dropped) partial.push(`${dropped} measurements dropped`)
    if (metricsAfter?.coverage?.evictedThrough) partial.push('history removed for space')
    result.coverage = { recording: metricsAfter?.recording ?? null, dropped, partial }
    // The subject apart from the other agents (HI-2186): who is who by the fixture's roster (the project's agents, by
    // their fixture names) and the run's lanes.
    const roster = (((await api('GET', '/v1/projects/alpha')).body?.agents ?? []) || []).map((a) => ({ id: a.id, name: a.name, workflowRole: a.workflowRole ?? null }))
    const parts = { kind: sc.role === 'assistant' ? 'assistant' : 'agent', agentId, snapshots, complete: partial.length === 0, roster, lanes: observed.lanes }
    result.measures = metricsBefore && metricsAfter ? measuresOf(metricsBefore, metricsAfter, observed, result.usage, parts) : null
    // Every scenario starts a new session (session:start with no resumeId): its usage is the scenario's own.
    result.resumed = false
    observed.measures = result.measures
    // The guidance Hive had at the start against what the session was given: a mismatch is a stale launch.
    const startRev = result.guidance?.atStart?.revision
    const gotRev = result.guidance?.delivered?.guidance
    result.staleGuidance = !!(startRev && gotRev && startRev !== gotRev)
    // What the session left running (#613): stopped as Hive stops an agent, its launch's job is looked at (#507), and
    // what Hive then lists as left running is what it left. Read once every exited launch has been looked at.
    if (sc.leftovers) {
      await inv('session:stop', host, agentId)
      await lib.until(async () => !(await live()), HUNG_MS)
      observed.leftovers = ((await inv('session:leftovers', true)) ?? []).filter((l) => l.projectPath.toLowerCase() === host.toLowerCase() && l.agentId === agentId)
      // HI-2571: Combwork's handling of what it listed, checked: its End Them (as the notice's), then each listed process
      // looked for again by its id and start time. Bounded at 30 s (a job's kill lands within a second or two).
      if (observed.leftovers.some((l) => l.processes?.length || l.more)) {
        observed.leftoversEnded = await inv('session:settleLeftovers', host, agentId, 'end').catch((e) => `failed: ${e?.message ?? e}`)
        let still = []
        await lib.until(async () => {
          still = leftoverIdentities(processes(), observed.leftovers)
          return !still.length
        }, 30000)
        observed.leftoversStillRunning = still
      }
    }
    result.checks = (notTaken ? [] : (sc.expect?.(observed, ctx) ?? [])).map(([name, ok, detail]) =>
      p.fake && (typeof sc.fakeSkips === 'function' ? sc.fakeSkips(providerKey) : (sc.fakeSkips ?? [])).includes(name) ? { name, ok: null, skipped: 'fake provider' } : { name, ok: !!ok, ...(ok ? {} : { detail: String(detail ?? '').slice(0, 300) }) }
    )
    // What a scenario records without checking it (#1611: whether the skill that owns the workflow was read, when the
    // behaviour is what's checked): in the results and the benchmark, never a pass or a failure.
    if (sc.observe) result.observations = sc.observe(observed, ctx).map(([name, value, detail]) => ({ name, value: !!value, ...(detail === undefined ? {} : { detail: String(detail).slice(0, 300) }) }))
    // Kept short in the results (whole tool calls can be large, and must not carry a token).
    result.observed = retainedObserved(observed, tokens)
    // What each of the project's agents showed at the end, for a check that failed on an agent's work (#498).
    if (sc.waitForAgents) result.observed.panes = Object.fromEntries(await Promise.all(Object.entries(ctx.agents).map(async ([k, a]) => [k, maskTokens(tokens, plain(await inv('pty:buffer', lib.ptyKey(alpha, a.id)).catch(() => ''))).slice(-1200)])))
  } catch (e) {
    result.error = String(e?.stack ?? e)
  } finally {
    // What its Hive started, while it still runs (a command an agent left can outlive its session, #542).
    const tree = lib.processTree(app.process()?.pid)
    for (const x of await inv('session:live').catch(() => [])) await inv('session:stop', x.projectPath, x.agentId).catch(() => undefined)
    // Closed once every session has stopped (a CLI still writing its transcript as Hive closes leaves it half-written).
    await lib.until(async () => !(await inv('session:live').catch(() => [])).some((x) => !['stopped', 'error'].includes(x.status)), HUNG_MS)
    // What the agents left running, as their launches' jobs hold it (HI-2217): a command whose parent has exited and that
    // names no scenario folder is in neither the tree nor a command line. Asked once their leftovers are settled.
    const left = await inv('session:leftovers', true).catch(() => [])
    if (left?.some((l) => l.processes?.length)) {
      try {
        tree.push(...leftoverIdentities(processes(), left))
      } catch {
        // No process list: the tree and the folder's own still go.
      }
    }
    await app.close().catch(() => undefined)
    await standIn?.close()
    // A command an agent started can outlive its session (#542): stop it, so it doesn't hold the folder.
    const leftOver = lib.stopProcessesIn(root, started, tree)
    if (leftOver) result.leftOver = `${leftOver} process(es) the scenario's Hive or its agents started, or still running from its folder, were stopped`
    result.seconds = Math.round((Date.now() - started) / 1000)
    // Unless a card cites it now, or the board can't be read (evidence.cjs reads it afresh): then it stays, said in the result.
    const kept = opts.keep ? null : opts.evidence?.protects(root)
    if (kept) result.kept = `${root} (${kept})`
    else if (!opts.keep) {
      // Still locked: this scenario says so, and the run goes on.
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
      } catch (e) {
        result.kept = `${root} (couldn't be removed: ${e.code ?? e.message})`
      }
    }
  }
  return result
}

module.exports = { runScenario, dialectForRun, dialectRecord,forgetClaudeMemory, observeTranscript, tokenSightings, knownTokens, maskTokens, retainedObserved, skillRefsOf, readMcpLog, allCallsReported, sourceFingerprint, metricsTotals, measuresOf, trialEnvironment, promptRefused, promptNotTaken, relaunchTrust, keptReply, REPLY_KEPT, cliNotices, launchEnded, startFailureIn, claudeAuthStatus, parseAuthStatus, environmentAdvice, PROVIDERS, CLAUDE_TEST_HOME, claudeSignedIn }
