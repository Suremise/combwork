// A stand-in for Claude Code in end-to-end tests: Hive launches it through its real Claude Code adapter
// (Settings → Claude Code → path = fake-claude.cmd), so the launch, hooks, status, transcripts and the Agent API
// are tested without signing in or spending tokens. It must run with CLAUDE_CONFIG_DIR pointing at a test folder.
//
// What it does, like Claude Code:
// - `--version` and `auth status --json` answer as a signed-in CLI. `--version` says 2.1.999, or the version in
//   fake-version.txt in CLAUDE_CONFIG_DIR when there is one (#698: a CLI updated between launches).
// - In a folder it hasn't been told to trust, it first asks "Do you trust this folder?" with Claude Code's menu, but
//   starting on "Yes, I trust this folder" (Claude Code's starts on "No, exit"), so Enter trusts it; Down/Up move the
//   choice, and Enter on "No, exit" quits (exit 1).
// - It sends SessionStart, then takes prompts: the last command-line argument, or a line typed and sent with
//   Enter (Ctrl+U clears the line), shown on its input line as it is typed. With fake-launch-hold-<agent> in its home, it
//   holds its command line's task after SessionStart until the test makes fake-launch-go-<agent> (#712: a CLI ready but
//   not yet on its task). Each prompt sends UserPromptSubmit, is written to the transcript, "works"
//   (1 s, or N seconds for "work N"), and ends with a reply and Stop. "newfield": its UserPromptSubmit carries a
//   top-level field Claude Code doesn't send (hive_test_new_field: true), as a CLI update adding one would (#698). "edit <file>" first sends PreToolUse for
//   an Edit of that file and records the tool call. "background N" starts a background command that ends after
//   N seconds; its task notification then starts a turn by itself, as in Claude Code. "subagent N" (once or more)
//   launches a subagent in the background that finishes after N seconds, told the same way (#1584). "pad N" adds N KB to the
//   transcript. "context N": the reply's request reports N input tokens, so the session's context is about N. "ask" first asks for permission (a permission_prompt Notification), then carries on by itself.
//   It connects the launch's hive MCP server as it starts (#865: the real server, which tells Hive it has connected);
//   with fake-mcp-hold-<agent> in its home, only once the test makes fake-mcp-go-<agent>. With fake-start-hold-<agent>,
//   its session doesn't start (no SessionStart: Hive sees it starting) until fake-start-go-<agent> (HI-1707: never ready).
//   "holduntil NAME": the turn doesn't end until the test makes a file NAME in its home (CLAUDE_CONFIG_DIR).
//   "askwhen NAME": the permission prompt once the test makes a file NAME in its home (#667), not after a set time.
//   "waitfile NAME" as a step ("waitfile go then hive cw_inbox {}"): the steps after it wait for that file.
//   "shell: <command line>" runs a command in cmd with the session's environment (fake-shell.jsonl records it; its
//   standard error so far is in its agent's file while it runs, shellStderr.cjs, HI-1816).
//   "planusage F W": its status line reports the plan's limits as Claude Code's does (rate_limits: the 5-hour at F%,
//   the weekly at W%), with reset times every session of the machine agrees on (#383).
//   "linger N" leaves N processes running after it ends, as an agent's preview server or tail -f does (#507): each a
//   detached, hidden node started by a short-lived detached one that has exited by then (linger.cjs; their pids in
//   fake-linger.jsonl in its home; each ends by itself after two minutes, in case). With fake-linger-at-start.txt (N) in
//   its home, it leaves N the moment it starts, before anything else. "progress-linger" leaves a command running
//   through the session's hive-progress shim, as a Codex agent once did (#542): cmd → hive-progress → a lingering node
//   (linger.cjs; its pid in fake-progress-linger.jsonl in its home), and ends its turn once that node runs (#1100: as
//   an agent's command has started by then; fake-progress-delay-ms.txt in its home (N) starts it N ms late, as under load).
//   "progress-linger nowait" ends its turn at once, the command still to start (#1134). "hidden-linger" leaves one as
//   "linger 1" does, but its command line names no test folder (HI-2217; its pid in fake-hidden-linger.jsonl).
//   "devapp" leaves a dev copy of an Electron app running, as an agent's dev launch of Hive did (#614): Electron's
//   executable with Playwright's --inspect=0 --remote-debugging-port=0 and a copy of devapp in its home (a hidden window; quits after two
//   minutes, in case), started through a detached node that exits at once (linger.cjs); its pid in fake-devapp.jsonl.
//   "boardmove N COLUMN" moves card N as cw_update_task does (the hive tools' API, token and agent, from
//   --mcp-config) and records the answer in fake-calls.jsonl; "boardreview N ACTION [COLUMN]" reviews it the same way
//   (review: start, passed or failed; a column with the verdict), and "boardcomment N" comments on it. All are written to the transcript as the hive tool
//   call they stand for (mcp__combwork__cw_update_task), as Claude Code writes an MCP call. "hive TOOL {json}" calls a
//   hive tool through the real hive MCP server of the launch's --mcp-config (fake-bridge.cjs: logged and measured by
//   Hive's performance metrics as a real call is), written to the transcript as that MCP call and its reply. Hive's
//   doorbell ("[CW] New in your inbox: …", #650) it follows as a model does: it reads its inbox with cw_inbox (and
//   acks it too when it follows notices, below). New work (a task, a handover) it read is its prompt; what else it read
//   (a card watch's wake, "[CW] #12 is in Review…", a message), like a line Hive types to wake it, is logged in
//   fake-wakes.jsonl (with `enter`: which Enter since the line was begun sent it, 1 for the first, #664) and answered
//   with the next line of fake-wakes-<agent>.txt (a test's script of what this agent does next); with a number N in
//   fake-drop-enters-<agent>.txt, it drops the next N Enters after such a line, which stays typed (#376). It turns on
//   bracketed paste, as Claude Code does. While fake-slow-input-<agent>.txt is in its home it reads no input, as a busy
//   Claude Code (#597; fake-slow-input-<agent>.paused says it has stopped): what arrived meanwhile comes in one read,
//   taken as Claude Code 2.1.296 takes one that isn't a bracketed paste: a paste, in which a Ctrl+U or an Enter is
//   kept as text (not sent), and after which the next Enter is lost too. "skill NAME" reads a skill
//   as Claude Code's Skill tool does: a Skill call in the transcript ("hive:NAME"), answered with the skill's SKILL.md
//   from the launch's plugin folder (an error when it has none).
// - "/compact [focus]" compacts as Claude Code does: PreCompact, a compaction boundary in the transcript after 1 s (N
//   seconds when the focus has "hold N"), then PostCompact. With no messages yet it says "Not enough messages to compact."
//   and sends no hook; with "compactfail" in the focus it fails after PreCompact with "Error during compaction". A
//   compaction that worked sends SessionStart (compact) before PostCompact, as Claude Code does. The context Hive gives
//   in a SessionStart reply (#1032: the Assistant's state view) is logged in fake-start-context.jsonl.
// - Idle, as Claude Code 2.1.296 is (#612): with fake-idle-notify.txt (N) in its home, N ms after a turn ends with no
//   input since, it sends the Notification "Claude is waiting for your input" (idle_prompt) once, as Claude Code does a
//   minute after a turn. A prompt with "loststop" ends its turn without a Stop reaching Hive, as one of HB3's did. When
//   the test makes fake-idle-compact-<agent> in its home, it compacts while idle as Claude Code does before the prompt
//   cache expires: PreCompact (auto), a compaction boundary, and once the test makes fake-idle-compact-done-<agent>,
//   SessionStart (compact), PostCompact (auto) and "Compacted while idle, before the prompt cache expired";
//   fake-recap-<agent> makes it write a recap (an away_summary), which sends no hook of Hive's. Each file is taken
//   (removed) when acted on. While fake-nohooks-<agent> is in its home it sends no hook and no status line at all, as
//   when a CLI update broke them or a policy turned them off (#1336); it works on as before.
// - Turns, as Claude Code 2.1.296 has them (#648): each prompt (and each turn it begins by itself) has its own id, which
//   its hooks carry (prompt_id); its screen shows a spinner with "esc to interrupt" while it works and "✻ Worked for Ns ·
//   done H:MM" above its input once done. "latetool": a Read whose PostToolUse reaches Hive after the turn's Stop.
//   "stopcontinue": after its Stop, once the test makes fake-continue-<agent>, it goes on as when another Stop hook
//   blocks: a tool call in the same turn (held until fake-continue-done-<agent>), then Stop with stop_hook_active.
// - Safeguards, as Claude Code 2.1.296 records them (#606): "safeguard" runs a Bash call, then its safety classifier
//   stops the response: the system note ("…'s safeguards stopped the response above · continuing once with that noted")
//   and, the next entry in its chain, the notice for the model (a user entry with refusedMessageId), and it carries on
//   once. With "fallback" it then runs on Opus 4.8 by itself (claude-opus-4-8), as with /config's model switch on.
//   "safeguardprompt": after its turn's Stop it asks whether to switch models (its question dialog, "Model switch", with
//   the choices "1. Switch automatically" and "2. Stay on …"), drawn on a cleared screen, and a permission_prompt
//   Notification ("Claude needs your permission"); an Enter answers it (the screen cleared again, its input back, no
//   hook), and the idle notification follows as after a turn. Answered so, it stays on its model and records nothing
//   (as HB3's stop); "safeguardpromptswitch" is answered "Switch automatically": its record of the flagged request
//   (model_refusal_fallback, for the session) and the model it switched to (Opus 4.8, or Sonnet 5.5 if on Opus 4.8).
// - Its offer to teach auto mode, as Claude Code 2.1.312 made it to HB4 (HI-1959): "envsetup": after its turn's Stop,
//   "Teach auto mode about your environment?" on a cleared screen, with no hook; keys go to it, not the input: Esc puts
//   it off (its input back, empty), Enter answers it (recorded in fake-envsetup.jsonl). With fake-input-box.txt in its
//   home at its start, its input is 2.1.312's box (a rule, `❯` and a no-break space, a rule below). "envsetupunder": the
//   same offer as 2.1.314 draws it (HI-2191), under its input box and footer, the empty box kept above it; "swallow": a
//   dialog of its own Hive doesn't know ("Choose how long replies are kept?"), drawn and answered the same way. The test making
//   fake-clear-line-<agent> clears its input line while idle, as that screen took HB4's wake.
// - Notices (#650), as Claude Code 2.1.296 takes them: context in a PostToolUse or Stop reply reaches "the model", and a
//   Stop answered with context (or a block) carries the turn on to another Stop with stop_hook_active. Each notice
//   ("[CW] …") is logged in fake-notices.jsonl (agent, where, text). With fake-follow-notices.txt in its home (any
//   agent) or fake-follow-notices-<agent>.txt, it acts on one as a model that follows Hive's notices: cw_inbox, then
//   cw_inbox with ack for the ids it listed. "checkpoint" as a step is a tool call (a Bash, PreToolUse and PostToolUse)
//   whose PostToolUse reply it reads.
// - `--name` and "/rename <name>" set the session's name in the transcript (a custom title), as Claude Code does. With
//   fake-title-untimed-<agent> in its home (taken at launch), --name's title line has no timestamp, so a resumed old
//   session keeps its last activity until its next turn (#895).
// - Its system prompt (the --append-system-prompt-file's text) is recorded on a conversation's first request and that
//   record used on every later one and every resume, as Claude Code does since 2.1.267, until it compacts;
//   `--system-prompt-snapshot off` uses the file's text each time instead (#334). A prompt with "whatmode" says the
//   mode its system prompt is in ("# Your mode: <name>", the Hive Assistant's) at the end of its reply. With
//   fake-resume-draw.json ({ "ms": N }) in CLAUDE_CONFIG_DIR, a resumed session loses each Enter for its first N ms,
//   keeping what was typed, as Claude Code can while it draws a long conversation.
// - A prompt with "netdown" ends its turn as Claude Code 2.1.312 does when its API can't be reached after its retries
//   (HI-1612, tests/fixtures/advanced/stopfailure-connection-claude-2.1.312.json): the ECONNREFUSED message, then a
//   StopFailure hook (error server_error) instead of Stop.
// - Ctrl+C twice, or "/exit", ends it with SessionEnd.
// - With fake-signin.json in CLAUDE_CONFIG_DIR saying { "expired": true } (read each time; one test home, so one sign-in
//   for all its agents, #309), it acts out an expired sign-in as Claude Code 2.1.291 does: `auth status --json` says
//   it isn't logged in (indented JSON, exit 1, as 2.1.296 does), and each prompt's turn ends at once with "Login expired · Please run /login" and a StopFailure
//   hook (error authentication_failed) instead of Stop. "/login" typed in it signs in (the file says expired: false)
//   and carries the failed turn on by itself, as Claude Code did: a tool call (PostToolUse), then the reply and Stop.
//   With "atLaunch": true as well, it stops before its session starts, as Claude Code 2.1.296 did with an OAuth session
//   it couldn't refresh: "Failed to authenticate: OAuth session expired and could not be refreshed", exit 1 (#577).
//   With "late": true instead, nothing shows it until a prompt is sent: the prompt isn't taken (no turn, no hook) and
//   "Not logged in · Run /login" shows under it, as Claude Code's status line did in #1321.
// - "/crash" typed in it exits with 1 at once, a CLI crashing by itself (HI-1881's stopped pane says so).
// - `--model fail-start` makes it refuse to start, printing an error and exiting with 1, as Claude Code does for an
//   argument it rejects.
// - `-p --input-format stream-json` answers the Agent SDK's initialize control request with Claude Code 2.1.289's
//   recorded reply (tests/fixtures/claude-initialize.json), as Hive asks for its models (#125); FAKE_CLAUDE_MODELS=fail
//   makes it answer with an error instead. With fake-models.json in CLAUDE_CONFIG_DIR ({ "haikuAuto": true | false | null },
//   read each time, #234) it acts out a CLI that says Haiku takes Auto, doesn't (as 2.1.289), or says nothing about Auto
//   (no model has supportsAutoMode): asked for Auto with Haiku, it runs in Auto only when it said Haiku takes it, else
//   in Manual, and reports the mode it really runs in. Without the file it runs in the mode it was asked for.
const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')
const { spawn } = require('child_process')
const { callHiveTool, connectHive, parseHiveStep, isDoorbell, doorbellIsWork, inboxRows } = require('../fake-bridge.cjs')
const { shellStderrFile } = require('./shellStderr.cjs')

const args = process.argv.slice(2)
if (args[0] === '--version') {
  let version = '2.1.999'
  try {
    version = fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || '', 'fake-version.txt'), 'utf8').trim() || version
  } catch {
    // No fake-version.txt: its own version.
  }
  console.log(`${version} (Claude Code)`)
  process.exit(0)
}
/** The test home's sign-in has expired (fake-signin.json, #309). */
function signedOut() {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || '', 'fake-signin.json'), 'utf8')).expired === true
  } catch {
    return false
  }
}
/** The expired sign-in shows only once a prompt is sent, which it doesn't take (fake-signin.json { "expired": true, "late": true }, #1321). */
function expiredLate() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || '', 'fake-signin.json'), 'utf8'))
    return s.expired === true && s.late === true
  } catch {
    return false
  }
}
/** The expired sign-in stops it at launch (fake-signin.json { "expired": true, "atLaunch": true }, #577). */
function expiredAtLaunch() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || '', 'fake-signin.json'), 'utf8'))
    return s.expired === true && s.atLaunch === true
  } catch {
    return false
  }
}
// As Claude Code prints it: indented JSON, and exit 1 when it isn't logged in (#577).
// An account's folder (HI-980: one in an accounts folder; a suite may trust folders in it, fake-trusted.json, as a sign-in would): `auth login` signs it in as fake-login-as.json beside the
// accounts folder says ({ email, orgId }), writing fake-account.json (and .claude.json, as a sign-in changes it), with no
// browser; `auth status` answers from fake-account.json, signed out without one.
const accountHome = process.env.CLAUDE_CONFIG_DIR || ''
const accountFolder = !!accountHome && path.basename(path.dirname(accountHome)).toLowerCase() === 'accounts'
if (args[0] === 'auth' && accountFolder) {
  const file = path.join(accountHome, 'fake-account.json')
  if (args[1] === 'login') {
    let as = { email: 'fake@example.com', orgId: 'org-fake' }
    try {
      as = JSON.parse(fs.readFileSync(path.join(accountHome, '..', 'fake-login-as.json'), 'utf8'))
    } catch {
      // The default identity.
    }
    console.log('Opening the browser to sign in… (the fake opens none)')
    // `hold` (HI-1870): waits for the browser that never comes, until its terminal is closed, signing nothing in.
    if (as.hold) return void setInterval(() => undefined, 60_000)
    fs.writeFileSync(file, JSON.stringify(as))
    fs.writeFileSync(path.join(accountHome, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: as.email } }))
    console.log(`Signed in as ${as.email}`)
    process.stdout.write('', () => process.exit(0))
    return
  }
  let acct = null
  try {
    acct = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    // Signed out.
  }
  const base = { authMethod: acct ? 'claude.ai' : 'none', apiProvider: 'firstParty', analyticsDisabled: false, projectsDirectory: path.join(accountHome, 'projects'), configDirectory: accountHome }
  console.log(JSON.stringify(acct ? { loggedIn: true, ...base, email: acct.email, orgId: acct.orgId, orgName: 'Fake Org', subscriptionType: 'max' } : { loggedIn: false, ...base }, null, 2))
  process.stdout.write('', () => process.exit(acct ? 0 : 1))
  return
}
if (args[0] === 'auth') {
  const out = signedOut()
  console.log(JSON.stringify(out ? { loggedIn: false, authMethod: 'none' } : { loggedIn: true, authMethod: 'claude.ai' }, null, 2))
  process.stdout.write('', () => process.exit(out ? 1 : 0))
  return
}
/** fake-models.json in the test home ({ haikuAuto }), or null (#234). */
function fakeModels() {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || '', 'fake-models.json'), 'utf8'))
  } catch {
    return null
  }
}
/** The recorded initialize reply, as fake-models.json says: Haiku with or without Auto, or no model saying. */
function withHaikuAuto(reply) {
  const f = fakeModels()
  if (!f || !('haikuAuto' in f)) return reply
  const models = reply.response.response.models.map((m) => {
    const out = { ...m }
    if (f.haikuAuto === null) delete out.supportsAutoMode
    else if (m.value === 'haiku') {
      if (f.haikuAuto) out.supportsAutoMode = true
      else delete out.supportsAutoMode
    }
    return out
  })
  return { ...reply, response: { ...reply.response, response: { ...reply.response.response, models } } }
}

if (args.includes('-p') && args.includes('stream-json')) {
  // The initialize request Hive sends to read the models; it stays open, as Claude Code does, until closed.
  let buf = ''
  process.stdin.on('data', (d) => {
    buf += d
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const m = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      if (m.type !== 'control_request' || m.request?.subtype !== 'initialize') continue
      const recorded = withHaikuAuto(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'claude-initialize.json'), 'utf8')))
      const reply = process.env.FAKE_CLAUDE_MODELS === 'fail' ? { type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'not supported' } } : { ...recorded, response: { ...recorded.response, request_id: m.request_id } }
      process.stdout.write(JSON.stringify(reply) + '\n')
    }
  })
  // Closed by Hive once it has the reply (killing a .cmd launcher leaves this process: its stdin ends).
  process.stdin.on('end', () => process.exit(0))
  return
}

const home = process.env.CLAUDE_CONFIG_DIR
if (!home) {
  console.error('fake-claude needs CLAUDE_CONFIG_DIR (a test folder)')
  process.exit(2)
}

// Options that take a value, so the first task (the last plain argument) can be told apart.
const WITH_VALUE = new Set(['--session-id', '--resume', '--name', '--plugin-dir', '--mcp-config', '--settings', '--append-system-prompt-file', '--allowedTools', '--model', '--effort', '--permission-mode', '--system-prompt-snapshot', '--add-dir'])
const opts = {}
let firstPrompt = ''
for (let i = 0; i < args.length; i++) {
  if (WITH_VALUE.has(args[i])) opts[args[i]] = args[++i]
  else if (args[i].startsWith('--')) opts[args[i]] = true
  else firstPrompt = args[i]
}
if (opts['--model'] === 'fail-start') {
  console.error("error: option '--model <model>' argument 'fail-start' is invalid.")
  process.exit(1)
}
const sessionId = opts['--resume'] || opts['--session-id'] || randomUUID()
/**
 * With fake-resume-draw.json in its home ({ "ms": N }, read at launch), a resumed session loses each Enter for its
 * first N ms, keeping what was typed, as Claude Code can while it draws a long conversation (#334).
 */
const drawingUntil = (() => {
  const file = home && path.join(home, 'fake-resume-draw.json')
  if (!opts['--resume'] || !file || !fs.existsSync(file)) return 0
  return Date.now() + Number(JSON.parse(fs.readFileSync(file, 'utf8')).ms ?? 0)
})()
/**
 * The mode it really runs in: the one asked for, unless fake-models.json has it act out Haiku without Auto (#234): then
 * Auto with Haiku runs in Manual ("default", as Claude Code's hooks say), as Claude Code 2.1.286 and 2.1.289 do.
 */
function runMode() {
  const asked = opts['--permission-mode'] || 'default'
  const f = fakeModels()
  if (!f || !('haikuAuto' in f) || asked !== 'auto' || !/haiku/i.test(opts['--model'] || '')) return asked
  return f.haikuAuto === true ? 'auto' : 'default'
}
// What it was started with, for suites that check the launch: the options, Claude Code's own variables and the
// Agent API token Hive gave it.
// A server connection's (HI-1772): its ANTHROPIC_* variables too, a dummy key among them (a disposable test log).
// Its dialect's file (HI-2443: CW_DIALECT_FILE, CW_DIALECT), which hive-progress in its shell reads.
const launchEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('CLAUDE_CODE_') || k.startsWith('ANTHROPIC_') || k.startsWith('HIVE_API_TOKEN') || k.startsWith('CW_API_TOKEN') || k.startsWith('CW_DIALECT') || k === 'CW_AGENT' || k === 'CLAUDE_CONFIG_DIR'))
// The agent's own token, as its launch's file held it at the start (HI-2262: the session has the file, never the token
// in its environment; read now, as the file goes when the run ends). Null without one.
const launchToken = (() => {
  try {
    return process.env.CW_API_TOKEN_FILE ? (JSON.parse(fs.readFileSync(process.env.CW_API_TOKEN_FILE, 'utf8')).token ?? null) : null
  } catch {
    return null
  }
})()
fs.appendFileSync(path.join(home, 'fake-launches.jsonl'), JSON.stringify({ cwd: process.cwd(), sessionId, pid: process.pid, parent: process.ppid, opts, env: launchEnv, token: launchToken }) + '\n')
// In a connection's folder (HI-1870: its Set Up, or an agent's first launch there): its first-run screens answered at
// once, as Claude Code records them in the folder's .claude.json (tests/fixtures/advanced/onboarding-claude-2.1.311.jsonl).
if (accountFolder) {
  const file = path.join(accountHome, '.claude.json')
  let j = {}
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    // None yet.
  }
  // Run in a folder outside its own (HI-1870: Set Up opened where it isn't trusted yet): its trust question answered Yes,
  // recorded under the folder's real path as Claude Code does (forward slashes; tests/fixtures/advanced/trust-entry-*).
  const cwd = fs.realpathSync.native(process.cwd())
  const here = path.relative(accountHome, cwd).startsWith('..') ? cwd.replace(/\\/g, '/') : null
  const projects = j.projects ?? {}
  if (j.hasCompletedOnboarding !== true || (here && projects[here]?.hasTrustDialogAccepted !== true)) {
    fs.writeFileSync(file, JSON.stringify({ ...j, hasCompletedOnboarding: true, ...(here ? { projects: { ...projects, [here]: { ...projects[here], hasTrustDialogAccepted: true } } } : {}) }))
  }
}
// How it ended, in fake-exits.jsonl in its home (#551): its own exit with the code, or an error it didn't catch (then
// exit 1, as Node would). A launch with no line there was ended by Ctrl+C, its console closing or a kill.
const exitLog = (entry) => {
  try {
    fs.appendFileSync(path.join(home, 'fake-exits.jsonl'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, sessionId, ...entry }) + '\n')
  } catch {
    // Its home gone: nothing to tell.
  }
}
process.on('exit', (code) => exitLog({ code }))
for (const event of ['uncaughtException', 'unhandledRejection'])
  process.on(event, (e) => {
    exitLog({ [event]: String(e?.stack ?? e) })
    process.stderr.write(`${e?.stack ?? e}\n`)
    process.exit(1)
  })
/**
 * The terminal's size, recorded in fake-sizes.jsonl in its home at the start and at each change (#247): what Hive tells
 * the CLI. Polled as well as on 'resize', which a ConPTY child doesn't always get.
 */
function recordSizes(dir, id) {
  if (!dir || !process.stdout.isTTY) return
  let last = ''
  const note = () => {
    const s = []
    if (process.stdout._handle?.getWindowSize?.(s) !== 0 || s.length < 2) return
    const [cols, rows] = s
    if (`${cols}x${rows}` === last) return
    last = `${cols}x${rows}`
    fs.appendFileSync(path.join(dir, 'fake-sizes.jsonl'), JSON.stringify({ sessionId: id, cols, rows, at: Date.now() }) + '\n')
  }
  note()
  process.stdout.on('resize', note)
  setInterval(note, 50).unref()
}
recordSizes(home, sessionId)
const settings = opts['--settings'] ? JSON.parse(fs.readFileSync(opts['--settings'], 'utf8')) : {}
const hookUrl = settings.hooks?.Stop?.[0]?.hooks?.[0]?.url
// HTTP hooks send the launch's token from the environment; command hooks (SessionStart) and the status line run
// Hive's curl command, which reads the header from the launch's auth file (#345).
const token = process.env.CW_HOOK_TOKEN || ''
const authFile = /-H "@([^"]+)"/.exec(settings.statusLine?.command ?? '')?.[1]
const commandAuth = () => {
  try {
    return fs.readFileSync(authFile, 'utf8').replace(/^Authorization:\s*/i, '').trim()
  } catch {
    return ''
  }
}
const cwd = process.cwd()
const transcript = path.join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`)
fs.mkdirSync(path.dirname(transcript), { recursive: true })

/** Writes to its screen; counts the writes, so a busy line can be taken back only if nothing came after it. */
let writes = 0
/**
 * Whether the idle input box is drawn, the cursor at its line's end (HI-1979): what is written meanwhile goes above it
 * and the box is drawn again under it, as Claude Code keeps its box at the bottom (a notice written into the box's
 * rule made two boxes read as one). liftBox and dropBox draw it (set once the input line's layout is known, below).
 */
let boxShown = false
let liftBox = () => ''
let dropBox = () => ''
/** Writes as it is, the box or not (what draws the box itself). */
const rawOut = (s) => {
  writes++
  return process.stdout.write(s)
}
const out = (s) => {
  if (!boxShown) return rawOut(s)
  rawOut(liftBox())
  const r = rawOut(s)
  rawOut(dropBox())
  // The box drawn again holds the whole line, what was typed and not drawn yet too.
  undrawn = null
  return r
}
/** The box goes (a prompt sent, a turn begun): what comes next is written where it was, with no box under it. */
const takeBox = () => {
  if (!boxShown) return
  rawOut(liftBox())
  boxShown = false
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => new Date().toISOString()
/**
 * Each entry is chained to the one before by parentUuid, and a user entry carries its turn's promptId (the prompt_id its
 * hooks send), as Claude Code 2.1.306 writes them: what Hive joins a transcript turn to its hooks by (#1371).
 */
let lastUuid = null
const write = (entry) => {
  const uuid = entry.uuid ?? randomUUID()
  const turn = entry.type === 'user' && promptId ? { promptId } : {}
  fs.appendFileSync(transcript, JSON.stringify({ parentUuid: lastUuid, sessionId, cwd, timestamp: now(), ...turn, ...entry, uuid }) + '\n')
  lastUuid = uuid
}

/**
 * "ratelimited" (HI-1973): its model request refused with a 429 twice, as Claude Code 2.1.312 records each try in its
 * transcript (a system api_error entry: its try of 10, the wait before the next, the error's status; tests/fixtures/
 * advanced/retry-claude-2.1.312.jsonl), sending no hook. It waits, as Claude Code does for its retry, until
 * fake-retried-<agent> is in its home (taken), then goes on with its turn.
 */
async function rateLimited() {
  const error = { message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}', status: 429, formatted: '429 Number of request tokens has exceeded your per-minute rate limit', connection: null, isNetworkDown: false, rateLimits: null, noResponse: null }
  // Its first wait, then the second try: written apart, as Claude Code's are.
  for (const [attempt, wait] of [[1, 1000], [2, 600_000]]) {
    write({ isSidechain: false, type: 'system', subtype: 'api_error', level: 'error', error, retryInMs: wait, retryAttempt: attempt, maxRetries: 10, source: 'request_retry', userType: 'external', entrypoint: 'cli', version: '2.1.312' })
    if (attempt === 1) await sleep(wait)
  }
  const go = path.join(home, `fake-retried-${String(process.env.CW_AGENT || 'agent').replace(/[^\w-]/g, '_')}`)
  while (!fs.existsSync(go)) await sleep(100)
  fs.rmSync(go, { force: true })
}

/** The turn under way: each prompt's own id, which its hooks carry (prompt_id), as Claude Code 2.1.296's do (#648). */
let promptId = null
/** The model its replies are on: "fallback" switches it after a safeguard stop (#606). */
let model = 'claude-fake'
const FALLBACK_MODEL = 'claude-opus-4-8'

/**
 * A hook that didn't reach Hive (#684: under load a Stop never did, and the turn stayed running), in fake-hook-errors.jsonl
 * in its home: the hook, when, and the error or the status Hive answered. It goes on as Claude Code does.
 */
const hookFailed = (event, entry) => {
  try {
    fs.appendFileSync(path.join(home, 'fake-hook-errors.jsonl'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, prompt: promptId, ...entry }) + '\n')
  } catch {
    // Its home gone: nothing to tell.
  }
}

/**
 * Its hooks are off (#1336: a CLI update that broke them, a managed policy that turned them off): while fake-nohooks-<agent>
 * is in its home (read at each hook, so a test can turn them off mid-session), no hook is sent, nor its status line.
 */
const hooksOff = () => fs.existsSync(path.join(home, `fake-nohooks-${String(process.env.CW_AGENT || 'agent').replace(/[^\w-]/g, '_')}`))

async function hook(event, extra = {}) {
  if (!hookUrl || hooksOff()) return null
  try {
    const res = await fetch(hookUrl, {
      method: 'POST',
      headers: { Authorization: event === 'SessionStart' ? commandAuth() : `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hook_event_name: event, session_id: sessionId, transcript_path: transcript, cwd, permission_mode: runMode(), ...(promptId && event !== 'SessionStart' ? { prompt_id: promptId } : {}), ...extra })
    })
    if (!res.ok) hookFailed(event, { status: res.status })
    return await res.json().catch(() => null)
  } catch (e) {
    hookFailed(event, { error: String(e?.cause?.code ?? e?.cause?.message ?? e?.message ?? e) })
    return null
  }
}

/**
 * SessionStart, with the context Hive's reply carries (#1032: the Assistant's state view) logged in
 * fake-start-context.jsonl in its home (agent, source, text).
 */
async function sessionStart(source) {
  const reply = await hook('SessionStart', { source })
  const text = reply?.hookSpecificOutput?.additionalContext
  if (typeof text === 'string' && text && home) {
    const agent = String(process.env.CW_AGENT || 'agent').replace(/[^\w-]/g, '_')
    fs.appendFileSync(path.join(home, 'fake-start-context.jsonl'), JSON.stringify({ agent, source, text, when: new Date().toISOString() }) + '\n')
  }
}

/** Hive's notice in a hook's reply (#650: context, or a block's reason), logged in fake-notices.jsonl; null when none. */
function noticeIn(reply, at) {
  const text = reply?.hookSpecificOutput?.additionalContext ?? (reply?.decision === 'block' ? reply.reason : null)
  if (typeof text !== 'string' || !text.startsWith('[CW]')) return null
  const agent = String(process.env.CW_AGENT || 'agent').replace(/[^\w-]/g, '_')
  fs.appendFileSync(path.join(home, 'fake-notices.jsonl'), JSON.stringify({ agent, at, text, when: new Date().toISOString() }) + '\n')
  return text
}

/** Whether this agent follows Hive's notices (fake-follow-notices.txt, or its own fake-follow-notices-<agent>.txt). */
function followsNotices() {
  const agent = String(process.env.CW_AGENT || 'agent').replace(/[^\w-]/g, '_')
  return fs.existsSync(path.join(home, 'fake-follow-notices.txt')) || fs.existsSync(path.join(home, `fake-follow-notices-${agent}.txt`))
}

/** Acts on a notice as a model that follows them: reads its inbox (cw_inbox), then acks the ids it listed. */
async function readInbox() {
  const listed = await hiveCall('cw_inbox', {})
  const ids = [...new Set([...String(listed?.text ?? '').matchAll(/\bm\d+\b/g)].map((m) => m[0]))]
  if (ids.length) await hiveCall('cw_inbox', { ack: ids })
}

/**
 * Hive's doorbell (#650): it reads its inbox (cw_inbox, through the hive MCP server, a call in its transcript), as a
 * model does; one that follows Hive's notices acks what it read too. What it read: its items' texts in one line, or null
 * when it has no hive server to ask.
 */
async function followDoorbell() {
  if (!opts['--mcp-config']) return null
  const r = await hiveCall('cw_inbox', {})
  if (r.isError) return null
  const rows = inboxRows(r.text)
  if (rows.length && followsNotices()) await hiveCall('cw_inbox', { ack: rows.flatMap((x) => x.ids) })
  return rows.map((x) => x.text).join(' ')
}

/** A tool call of its own (a Bash), whose PostToolUse reply may carry a notice (#650: "checkpoint" as a step). */
async function checkpoint() {
  const id = `toolu_${randomUUID().slice(0, 8)}`
  const call = { tool_name: 'Bash', tool_input: { command: 'echo checkpoint' }, tool_use_id: id }
  await hook('PreToolUse', call)
  write({ type: 'assistant', requestId: `req_${id}`, message: { model: 'claude-fake', content: [{ type: 'tool_use', id, name: 'Bash', input: call.tool_input }], usage: { input_tokens: 10, output_tokens: 5 } } })
  write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'checkpoint' }] } })
  if (noticeIn(await hook('PostToolUse', call), 'checkpoint') && followsNotices()) await readInbox()
}

/**
 * A wake from Hive (a line starting "[CW]", typed when a watched card changed): recorded in fake-wakes.jsonl (agent,
 * line, time), and answered with the next line of fake-wakes-<agent>.txt in its home, which a test writes: the steps
 * this agent takes next (a builder's fix, a reviewer's verdict). Null for any other prompt, or with no script line left.
 */
function shell(cmd) {
  return new Promise((resolve) => {
    const p = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { cwd: process.cwd(), env: process.env, windowsVerbatimArguments: true, windowsHide: true })
    let stdout = ''
    let stderr = ''
    // Its standard error so far, for a test waiting on what a command says before it ends (HI-1816).
    const live = home ? shellStderrFile(home, process.env.CW_AGENT) : null
    if (live) fs.writeFileSync(live, '')
    p.stdout.on('data', (d) => (stdout += d))
    p.stderr.on('data', (d) => {
      stderr += d
      if (live) fs.appendFileSync(live, d)
    })
    p.on('close', (code) => {
      if (home) fs.appendFileSync(path.join(home, 'fake-shell.jsonl'), JSON.stringify({ agent: process.env.CW_AGENT || 'agent', cmd, code, stdout, stderr }) + '\n')
      resolve()
    })
  })
}

function wakeScript(text, doorbell = null) {
  if ((!doorbell && !text.startsWith('[CW]')) || !home) return null
  const agent = String(process.env.CW_AGENT || 'agent').replace(/[^\w-]/g, '_')
  fs.appendFileSync(path.join(home, 'fake-wakes.jsonl'), JSON.stringify({ agent, text, ...(doorbell ? { doorbell } : {}), enter: promptEnter, at: new Date().toISOString() }) + '\n')
  const file = path.join(home, `fake-wakes-${agent}.txt`)
  if (!fs.existsSync(file)) return null
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
  const next = lines.shift()
  fs.writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''))
  return next ?? null
}

/** The system prompt a request sends: the conversation's recorded one, recorded now if it has none (#334). */
function systemPrompt() {
  const file = opts['--append-system-prompt-file']
  const current = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (opts['--system-prompt-snapshot'] === 'off' || !home) return current
  const record = path.join(home, 'fake-prompts', `${sessionId}.txt`)
  if (fs.existsSync(record)) return fs.readFileSync(record, 'utf8')
  fs.mkdirSync(path.dirname(record), { recursive: true })
  fs.writeFileSync(record, current)
  return current
}

let busy = false
const isBusy = () => busy
/** The prompt whose turn the expired sign-in stopped: "/login" carries it on. */
let refused = null
/** Which Enter since its line was begun sent the prompt running now (#664): 1 for the first, null for one not typed. */
let promptEnter = null
async function runPrompt(text, enter = null) {
  takeBox()
  busy = true
  promptEnter = enter
  promptId = randomUUID()
  turnStarted = Date.now()
  out(`\r\n> ${text}\r\n`)
  // Its spinner above its input while it works, as Claude Code 2.1.296 draws them, taken back when the turn ends.
  out(BUSY)
  busyDrawn = writes
  write({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: text } })
  await hook('UserPromptSubmit', { prompt: text, ...(/\bnewfield\b/i.test(text) ? { hive_test_new_field: true } : {}) })
  if (/\bnetdown\b/i.test(text)) {
    const said = 'API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)'
    write({ type: 'assistant', requestId: `req_${randomUUID().slice(0, 8)}`, message: { model: '<synthetic>', content: [{ type: 'text', text: said }] }, isApiErrorMessage: true })
    out(`\r\n● ${said}\r\n`)
    await hook('StopFailure', { error: 'server_error', last_assistant_message: said })
    busy = false
    promptLine()
    return
  }
  if (signedOut()) {
    const said = 'Login expired · Please run /login'
    refused = text
    write({ type: 'assistant', requestId: `req_${randomUUID().slice(0, 8)}`, message: { model: '<synthetic>', content: [{ type: 'text', text: said }] }, isApiErrorMessage: true })
    out(`\r\n● ${said}\r\n`)
    await hook('StopFailure', { error: 'authentication_failed', last_assistant_message: said })
    busy = false
    promptLine()
    return
  }
  const prompt = systemPrompt()
  // Hive's doorbell (#650): what it reads in its inbox is what it acts on. New work (a task, a handover) is its prompt;
  // anything else (a card watch's wake, a message) is logged, and answered with the next line of its wake script, as a
  // line Hive typed to wake it is.
  const doorbell = isDoorbell(text) ? text : null
  if (doorbell) text = (await followDoorbell()) ?? text
  const woken = doorbell && doorbellIsWork(doorbell) ? null : wakeScript(text, doorbell)
  if (woken !== null) text = woken
  const edit = /\bedit\s+(\S+)/i.exec(text)
  if (edit) {
    const file = path.resolve(cwd, edit[1])
    const id = `toolu_${randomUUID().slice(0, 8)}`
    const reply = await hook('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' }, tool_use_id: id })
    write({ type: 'assistant', requestId: `req_${id}`, message: { model, content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' } }], usage: { input_tokens: 10, output_tokens: 5 } } })
    const denied = reply?.hookSpecificOutput?.permissionDecision === 'deny'
    write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: denied ? 'Blocked by a hook' : 'The file has been updated.', is_error: denied }] } })
    await hook('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: file }, tool_use_id: id })
  }
  if (/\bsafeguard\b/i.test(text)) safeguardStop(/\bfallback\b/i.test(text))
  if (/\bask\b/i.test(text)) await hook('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
  // "askafter N": the permission prompt N seconds into the turn (it starts working first).
  const askAfter = /\baskafter\s+(\d+)/i.exec(text)
  if (askAfter) setTimeout(() => void hook('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }), Number(askAfter[1]) * 1000)
  // "askwhen NAME": the permission prompt once the test makes NAME in its home (two minutes at most, in case the test
  // died), so it comes after what the test waits for (#667: a watch that a loaded machine set up after a set time).
  const askWhen = /\baskwhen\s+([\w.-]+)/i.exec(text)
  if (askWhen)
    void (async () => {
      const go = path.join(process.env.CLAUDE_CONFIG_DIR || '', askWhen[1])
      for (const end = Date.now() + 120_000; !fs.existsSync(go) && Date.now() < end; ) await sleep(100)
      await hook('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
    })()
  // "pad N": N KB more transcript, as a long conversation has.
  const pad = /\bpad\s+(\d+)/i.exec(text)
  if (pad) write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_pad', content: 'x'.repeat(Number(pad[1]) * 1024) }] } })
  // Steps joined by "then" run in order ("work N" in a step waits N seconds before the next).
  const steps = text.split(/\s+then\s+/i)
  for (const [i, step] of steps.entries()) {
    // "waitfile NAME": this step waits until the test makes a file NAME in its home (two minutes at most, in case the
    // test died), so the next step comes after what the test does meanwhile (a message left for it, #647).
    const waitFile = /\bwaitfile\s+([\w.-]+)/i.exec(step)
    if (waitFile) {
      const go = path.join(process.env.CLAUDE_CONFIG_DIR || '', waitFile[1])
      for (const end = Date.now() + 120_000; !fs.existsSync(go) && Date.now() < end; ) await sleep(100)
    }
    for (const m of step.matchAll(/\bskill\s+([a-z0-9][\w-]*)/gi)) readSkill(m[1])
    for (const m of step.matchAll(/\bskillref\s+([a-z0-9][\w-]*)\s+([\w.-]+\.md)/gi)) readSkillRef(m[1], m[2])
    const move = /\bboardmove\s+(\d+)\s+(\w+)/i.exec(step)
    if (move) await boardPatch(Number(move[1]), { column: move[2].toLowerCase() })
    const review = /\bboardreview\s+(\d+)\s+(\w+)(?:\s+(hold|todo|doing|review|passed|done)\b)?/i.exec(step)
    if (review) await boardPatch(Number(review[1]), { review: review[2].toLowerCase(), ...(review[3] ? { column: review[3].toLowerCase(), comment: 'Fake review: passed.' } : {}) })
    const comment = /\bboardcomment\s+(\d+)/i.exec(step)
    if (comment) await boardPatch(Number(comment[1]), { comment: 'Fake: done, see the files.' })
    const call = parseHiveStep(step)
    if (call) await hiveCall(call.tool, call.args)
    if (/\bcheckpoint\b/i.test(step)) await checkpoint()
    if (/\bratelimited\b/i.test(step)) await rateLimited()
    // "shell: <command line>": runs it in cmd with the session's environment (PATH, HIVE_*), as an agent's shell
    // would; the agent, command, exit code and output go to fake-shell.jsonl in its home.
    const sh = /\bshell:\s*(.+)$/i.exec(step)
    if (sh) await shell(sh[1].trim())
    // "planusage F W": the plan's limits in its status line as Claude Code 2.1.303 sends them (#383), the 5-hour at F%
    // and the weekly at W%, resetting at whole hours and days every session of the machine agrees on (epoch seconds).
    const plan = /\bplanusage\s+(\d+)\s+(\d+)/i.exec(step)
    if (plan) {
      const hour = Math.floor(Date.now() / 3600e3) * 3600
      const day = Math.floor(Date.now() / 86400e3) * 86400
      await statusLine({ rate_limits: { five_hour: { used_percentage: Number(plan[1]), resets_at: hour + 3 * 3600 }, seven_day: { used_percentage: Number(plan[2]), resets_at: day + 3 * 86400 } } })
    }
    const pause = /\bwork\s+(\d+)/i.exec(step)
    if (pause && i < steps.length - 1) await sleep(Number(pause[1]) * 1000)
  }
  const background = /\bbackground\s+(\d+)/i.exec(text)
  if (background) await startBackgroundTask(Number(background[1]))
  for (const [k, m] of [...text.matchAll(/\bsubagent\s+(\d+)/gi)].entries()) await startSubagent(Number(m[1]), k + 1)
  const linger = /(?<!-)\blinger\s+(\d+)/i.exec(text)
  if (linger) leaveRunning(Number(linger[1]))
  if (/\bhidden-linger\b/i.test(text)) leaveUnnamedRunning()
  if (/\bprogress-linger\b/i.test(text)) await leaveProgressRunning(!/\bnowait\b/i.test(text))
  if (/\bdevapp\b/i.test(text)) leaveAppRunning()
  const secs = Number(/\bwork\s+(\d+)/i.exec(text)?.[1] ?? 1)
  await sleep(secs * 1000)
  // "holduntil NAME": the turn goes on until the test makes NAME in its home, so it ends after what the test waits for
  // (two minutes at most, in case the test died).
  const release = /\bholduntil\s+([\w.-]+)/i.exec(text)
  if (release) {
    const go = path.join(process.env.CLAUDE_CONFIG_DIR || '', release[1])
    for (const end = Date.now() + 120_000; !fs.existsSync(go) && Date.now() < end; ) await sleep(100)
  }
  const mode = /\bwhatmode\b/i.test(text) ? ` (system prompt mode: ${/^# Your mode: (.+)$/m.exec(prompt)?.[1]?.trim() ?? 'none'})` : ''
  // "latetool": a Read whose PostToolUse reaches Hive only after the turn's Stop (#648).
  const late = /\blatetool\b/i.test(text) ? { tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'README.md') }, tool_use_id: `toolu_${randomUUID().slice(0, 8)}` } : null
  if (late) await hook('PreToolUse', late)
  await endTurn(`Done: ${text}${mode}`, Number(/\bcontext\s+(\d+)/i.exec(text)?.[1] ?? 20), /\bloststop\b/i.test(text), { late, carryOn: /\bstopcontinue\b/i.test(text) })
  if (/\bsafeguardprompt(switch)?\b/i.test(text)) await safeguardPrompt(/\bsafeguardpromptswitch\b/i.test(text))
  if (/\benvsetup\b/i.test(text)) envSetup()
  if (/\benvsetupunder\b/i.test(text)) envSetup(ENV_SETUP_TITLE)
  if (/\bswallow\b/i.test(text)) envSetup(SWALLOW_TITLE)
  // "statusmodel ID": the status line reports the model it runs as ID, as Claude Code's does (HI-1772: a server's model).
  const statusModel = /\bstatusmodel\s+(\S+)/i.exec(text)
  if (statusModel) await statusLine({ model: { id: statusModel[1], display_name: statusModel[1] } })
  // "window N": the status line reports a context window of N tokens, as Claude Code's does.
  const contextWindow = /\bwindow\s+(\d+)/i.exec(text)
  if (contextWindow) await statusLine({ context_window: { context_window_size: Number(contextWindow[1]) } })
}

/** Posts a status line, as Claude Code's statusLine command does (Hive's curl command, with the launch's auth file). */
async function statusLine(body) {
  if (!hookUrl || hooksOff()) return
  await fetch(`${hookUrl}&statusline`, {
    method: 'POST',
    headers: { Authorization: commandAuth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, ...body })
  }).catch(() => undefined)
}

/**
 * A safety classifier stops its response after a Bash call, as Claude Code 2.1.296 records it (#606): the system note and
 * the notice for the model, then it carries on once; `fallback`: on Opus 4.8 from then on, by itself.
 */
function safeguardStop(fallback) {
  const id = `toolu_${randomUUID().slice(0, 8)}`
  write({ type: 'assistant', requestId: `req_${id}`, message: { model, content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'echo probe' } }], usage: { input_tokens: 10, output_tokens: 5 } } })
  write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'probe' }] } })
  const noteId = randomUUID()
  write({ type: 'system', subtype: 'informational', content: "Opus 5.5's safeguards stopped the response above · continuing once with that noted", level: 'notice', uuid: noteId })
  write({ type: 'user', isMeta: true, turnCompanion: true, refusedMessageId: `msg_${randomUUID().slice(0, 8)}`, uuid: randomUUID(), parentUuid: noteId, message: { role: 'user', content: [{ type: 'text', text: 'Your response above was stopped by a safety classifier. Continue with the task, noting that.' }] } })
  out("\r\n  ⎿  Opus 5.5's safeguards stopped the response above · continuing once with that noted\r\n")
  if (fallback) model = FALLBACK_MODEL
}

/**
 * After its turn's Stop, it asks whether to switch models, as Claude Code did after HB3's second stop (#606): its question
 * dialog on a cleared screen (as 2.1.296 draws it), a permission_prompt Notification naming no tool. An Enter answers it
 * (no hook says so): the screen cleared, its input back, and the idle notification as after a turn. Stayed on its model,
 * nothing is recorded (HB3's); `switchTo`: answered "Switch automatically", it records the flagged request
 * (model_refusal_fallback, by its requestId) and runs on the other model.
 */
async function safeguardPrompt(switchTo) {
  const to = model === FALLBACK_MODEL ? 'claude-sonnet-5-5' : FALLBACK_MODEL
  out(
    "\x1b[2J\x1b[H ☐ Model switch\r\n\r\n Opus 5.5's safeguards flagged this message. This sometimes happens with safe, normal conversations. Switch to Opus 4.8 and keep going whenever this happens? You can change this later in /config.\r\n\r\n" +
      ' ❯ 1. Switch automatically\r\n      Continue on Opus 4.8 now, and switch without asking from now on\r\n   2. Stay on Opus 5.5\r\n      Stop here without switching, and ask me each time a message is flagged\r\n   3. Type something.\r\n   4. Chat about this\r\n\r\n Enter to select · ↑/↓ to navigate · Esc to cancel\r\n'
  )
  onEnter = () => {
    if (switchTo) {
      write({ type: 'system', subtype: 'model_refusal_fallback', direction: 'retry', scope: 'session', content: "Opus 5.5's safeguards flagged this message. This sometimes happens with safe, normal conversations. Switched to Opus 4.8.", level: 'warning', trigger: 'refusal', originalModel: model, fallbackModel: to, requestId: `req_${randomUUID().slice(0, 8)}`, apiRefusalCategory: 'cyber', isMeta: false, uuid: randomUUID() })
      model = to
      write({ type: 'assistant', requestId: `req_${randomUUID().slice(0, 8)}`, message: { model, content: [{ type: 'text', text: 'Carrying on.' }], usage: { input_tokens: 10, output_tokens: 5 } } })
    }
    out('\x1b[2J\x1b[H')
    promptLine()
    idleNotice()
  }
  await hook('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission' })
}

/**
 * "envsetup": after its turn's Stop it offers to teach auto mode about the environment, as Claude Code 2.1.312 did to
 * HB4 (HI-1959): its question on a cleared screen, and no hook. While it shows, keys go to it, not to the input: Esc puts
 * it off (the screen cleared, its input back, empty), Enter answers it (Yes: recorded in fake-envsetup.jsonl, which a
 * suite checks Hive never does), anything else is taken by it and lost.
 */
let envSetupOpen = false
/** The title of the dialog shown under its input box, while it shows (null: none, or 2.1.312's on a cleared screen). */
let envSetupUnder = null
/**
 * The dialog under its input box and footer, from the box's own row (its cursor there, the box empty) and back to it:
 * moved back by rows, not saved and restored, as the dialog may scroll the screen (boxBelow's reason).
 */
const underDialog = () => `\x1b[2B\r\n${RULE}\r\n  ${envSetupUnder}\r\n\r\n  Auto mode works better when it knows your environment. Takes about a minute.\r\n\r\n  ❯ 1. Yes\r\n    2. Not now\r\n    3. Don't show again\r\n\r\n  Enter to confirm · Esc to cancel\x1b[12A\r\x1b[2C`
const ENV_SETUP_TITLE = 'Teach auto mode about your environment?'
/** "swallow" (HI-2191): a dialog of its own Hive doesn't know, drawn as 2.1.314 draws the offer, taking the keys the same way. */
const SWALLOW_TITLE = 'Choose how long replies are kept?'
/**
 * `under`: as Claude Code 2.1.314 draws it (HI-2191, recorded), under its input box and footer, the box (empty) kept above
 * it; the dialog titled `under`. Otherwise 2.1.312's, on a cleared screen.
 */
function envSetup(under = null) {
  envSetupOpen = true
  envSetupUnder = under
  if (under) {
    rawOut(underDialog())
    return
  }
  // In place of its input box, which the cleared screen takes with it (HI-1979: not drawn back under the question).
  boxShown = false
  out("\x1b[2J\x1b[H Teach auto mode about your environment?\r\n\r\n Auto mode works better when it knows your environment. Takes about a minute.\r\n\r\n ❯ 1. Yes\r\n   2. Not now\r\n   3. Don't show again\r\n\r\n Enter to select · ↑/↓ to navigate · Esc to cancel\r\n")
}
function envSetupAnswered(answer) {
  envSetupOpen = false
  envSetupUnder = null
  if (home) fs.appendFileSync(path.join(home, 'fake-envsetup.jsonl'), JSON.stringify({ agent: process.env.CW_AGENT || 'agent', answer, at: new Date().toISOString() }) + '\n')
  line = ''
  enters = 0
  out('\x1b[2J\x1b[H')
  promptLine()
}

/** Reads a Hive skill as Claude Code's Skill tool does, recording the call and its answer in the transcript. */
function readSkill(name) {
  const id = `toolu_skill_${randomUUID().slice(0, 8)}`
  const file = path.join(opts['--plugin-dir'] ?? '', 'skills', name, 'SKILL.md')
  const text = opts['--plugin-dir'] && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  write({ type: 'assistant', requestId: `req_${id}`, message: { model, content: [{ type: 'tool_use', id, name: 'Skill', input: { skill: `hive:${name}` } }], usage: { input_tokens: 10, output_tokens: 5 } } })
  write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text ?? `Unknown skill: hive:${name}`, is_error: text === null }] } })
}

/**
 * Follows a skill's link to one of its reference files (HI-2011), as Claude Code does: the link found in the delivered
 * SKILL.md, resolved against the skill's folder, and the file read with the Read tool (lines numbered, as Read shows
 * them). A SKILL.md without that link reads nothing there: the read fails, as a link that isn't there would.
 */
function readSkillRef(name, file) {
  const id = `toolu_ref_${randomUUID().slice(0, 8)}`
  const dir = path.join(opts['--plugin-dir'] ?? '', 'skills', name)
  const skill = opts['--plugin-dir'] && fs.existsSync(path.join(dir, 'SKILL.md')) ? fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8') : ''
  const linked = skill.includes(`](${file})`) || skill.includes(`](./${file})`)
  const target = linked ? path.resolve(dir, file) : path.join(dir, `no-link-to-${file}`)
  const text = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null
  write({ type: 'assistant', requestId: `req_${id}`, message: { model, content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: target } }], usage: { input_tokens: 10, output_tokens: 5 } } })
  const numbered = text === null ? `File does not exist: ${target}` : text.split(/\r?\n/).map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n')
  write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: numbered, is_error: text === null }] } })
}

/** Calls a hive tool through the launch's own hive MCP server; the call and its reply go in the transcript. */
async function hiveCall(tool, input) {
  const id = `toolu_hive_${randomUUID().slice(0, 8)}`
  write({ type: 'assistant', requestId: `req_${id}`, message: { model, content: [{ type: 'tool_use', id, name: `mcp__combwork__${tool}`, input }], usage: { input_tokens: 10, output_tokens: 5 } } })
  let r
  try {
    r = await callHiveTool(JSON.parse(fs.readFileSync(opts['--mcp-config'], 'utf8')).mcpServers.combwork, tool, input)
  } catch (e) {
    r = { text: String(e), isError: true }
  }
  write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: r.text, is_error: r.isError }] } })
  return r
}

/** Changes card n as cw_update_task does: the hive tools' API, with this agent's token; the call is in the transcript. */
async function boardPatch(n, change) {
  const id = `toolu_board_${randomUUID().slice(0, 8)}`
  write({ type: 'assistant', requestId: `req_${id}`, message: { model, content: [{ type: 'tool_use', id, name: 'mcp__combwork__cw_update_task', input: { number: n, ...change } }], usage: { input_tokens: 10, output_tokens: 5 } } })
  let record
  try {
    const env = JSON.parse(fs.readFileSync(opts['--mcp-config'], 'utf8')).mcpServers.combwork.env
    const apiToken = JSON.parse(fs.readFileSync(env.CW_API_TOKEN_FILE, 'utf8')).token
    const res = await fetch(`${env.CW_API_URL}/v1/tasks/${n}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json', 'X-Hive-Workspace': encodeURIComponent(env.CW_WORKSPACE) },
      body: JSON.stringify({ ...change, reply: 'short' })
    })
    record = { n, ...change, status: res.status, body: await res.json().catch(() => null) }
  } catch (e) {
    record = { n, ...change, error: String(e) }
  }
  fs.appendFileSync(path.join(home, 'fake-calls.jsonl'), JSON.stringify(record) + '\n')
  write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(record.body ?? record.error ?? null), is_error: record.status !== 200 }] } })
  // Where Hive's hive server logs the calls it runs (tests only), this call is logged too, as the server would; `direct`:
  // no hive server ran it, so none reports it to Hive's metrics.
  try {
    const env = JSON.parse(fs.readFileSync(opts['--mcp-config'], 'utf8')).mcpServers.combwork.env
    if (env.HIVE_TEST_MCP_LOG) fs.appendFileSync(env.HIVE_TEST_MCP_LOG, JSON.stringify({ at: new Date().toISOString(), tool: 'cw_update_task', role: env.HIVE_ROLE === 'assistant' ? 'assistant' : 'agent', project: env.CW_PROJECT, agent: env.HIVE_AGENT_ID ?? null, ok: record.status === 200, args: JSON.stringify({ number: n, ...change }), direct: true }) + '\n')
  } catch {
    // No log.
  }
}

/** "/login": signs the test home in again, and carries on the turn the expired sign-in stopped, by itself. */
async function login() {
  fs.writeFileSync(path.join(home, 'fake-signin.json'), JSON.stringify({ expired: false }))
  out('\r\nLogin successful\r\n')
  const text = refused
  refused = null
  if (!text) return promptLine()
  busy = true
  await hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'echo carried on' } })
  await sleep(1000)
  await endTurn(`Done: ${text}`)
}

/**
 * A turn's end: the reply, Stop (unless lost), and the line Claude Code 2.1.296 shows above its input once a turn is
 * done ("✻ Worked for 1s · done 16:52"). `late`: a tool call whose PostToolUse comes only after the Stop. `carryOn`:
 * another Stop hook (the user's) makes it go on (#648): once the test makes fake-continue-<agent> in its home, a tool
 * call in the same turn (held until fake-continue-done-<agent>), then Stop again with stop_hook_active.
 */
async function endTurn(answer, inputTokens = 20, lostStop = false, { late = null, carryOn = false } = {}) {
  write({ type: 'assistant', requestId: `req_${randomUUID().slice(0, 8)}`, message: { model, content: [{ type: 'text', text: answer }], usage: { input_tokens: inputTokens, output_tokens: 10 } } })
  // The spinner and input drawn while it worked go, as Claude Code redraws them (when nothing was written since).
  if (busyDrawn === writes) out(`\x1b[${BUSY_LINES}A\r\x1b[J`)
  out(`\r\n${answer}\r\n`)
  // "loststop": the turn ends, but its Stop never reaches Hive (#612).
  if (!lostStop) {
    const reply = await hook('Stop', { last_assistant_message: answer, stop_hook_active: false })
    // Carried on (#650: Hive's drain, or any Stop hook's block): one more call to the model, then Stop again.
    if (reply?.decision === 'block' || reply?.hookSpecificOutput?.additionalContext) {
      if (noticeIn(reply, 'drain') && followsNotices()) await readInbox()
      await hook('Stop', { last_assistant_message: answer, stop_hook_active: true })
    }
  }
  if (late) await hook('PostToolUse', late)
  if (carryOn) {
    for (const end = Date.now() + 120_000; !take('fake-continue') && Date.now() < end; ) await sleep(100)
    const call = { tool_name: 'Bash', tool_input: { command: 'echo again' }, tool_use_id: `toolu_${randomUUID().slice(0, 8)}` }
    // Its spinner shows it working again, as Claude Code's does (#648: the turn goes on from its ids alone, a tool call it
    // never started, whether Hive draws the spinner before the hook comes or after).
    out(BUSY)
    busyDrawn = writes
    await hook('PreToolUse', call)
    for (const end = Date.now() + 120_000; !take('fake-continue-done') && Date.now() < end; ) await sleep(100)
    await hook('PostToolUse', call)
    if (busyDrawn === writes) out(`\x1b[${BUSY_LINES}A\r\x1b[J`)
    out('\r\nCarried on past the Stop.\r\n')
    await hook('Stop', { last_assistant_message: 'Carried on past the Stop.', stop_hook_active: true })
  }
  const d = new Date()
  out(`✻ Worked for ${Math.max(0, Math.round((Date.now() - turnStarted) / 1000))}s · done ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}\r\n`)
  busy = false
  promptLine()
  idleNotice()
}

/** When the turn under way began (its "Worked for" line). */
let turnStarted = Date.now()

/** Turns ended, and when input last came: the idle notification goes once per turn, and only with no input since. */
let turnsEnded = 0
let lastInput = 0
/** Claude Code's "Claude is waiting for your input" (idle_prompt), N ms after a turn ends: fake-idle-notify.txt (N). */
function idleNotice() {
  const file = path.join(home, 'fake-idle-notify.txt')
  if (!fs.existsSync(file)) return
  const turn = ++turnsEnded
  const since = Date.now()
  setTimeout(() => {
    if (turn === turnsEnded && !busy && lastInput <= since) void hook('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })
  }, Number(fs.readFileSync(file, 'utf8')) || 0)
}

/** Takes a file the test made in its home for this agent (NAME-<agent>): true once, when it was there. */
function take(name) {
  try {
    fs.rmSync(path.join(home, `${name}-${String(process.env.CW_AGENT || 'agent').replace(/[^\w-]/g, '_')}`))
    return true
  } catch {
    return false
  }
}

/** What Claude Code does by itself while idle (#612): a compaction before the prompt cache expires, and a recap. */
async function whileIdle() {
  if (busy) return
  // fake-clear-line-<agent>: its input line goes, as when a screen of Claude Code's took it (HI-1959: the offer to teach
  // auto mode ate HB4's wake), its input drawn back empty.
  if (take('fake-clear-line')) {
    line = ''
    enters = 0
    out('\x1b[2J\x1b[H')
    promptLine()
  }
  if (take('fake-recap')) {
    write({ type: 'system', subtype: 'away_summary', content: 'The fake did its turns. (disable recaps in /config)', isMeta: false })
    out('\r\n※ recap: the fake did its turns.\r\n')
  }
  if (!take('fake-idle-compact')) return
  busy = true
  // A compaction while idle has a prompt_id of its own, with no prompt (Claude Code 2.1.296, #648).
  promptId = randomUUID()
  await hook('PreCompact', { trigger: 'auto', custom_instructions: null })
  out('\r\nCompacting conversation…\r\n')
  write({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 30, postTokens: 10 } })
  // Until the test has seen it under way (two minutes at most, in case the test died).
  for (const end = Date.now() + 120_000; !take('fake-idle-compact-done') && Date.now() < end; ) await sleep(100)
  await sessionStart('compact')
  await hook('PostCompact', { trigger: 'auto' })
  write({ type: 'system', subtype: 'informational', content: 'Compacted while idle, before the prompt cache expired', level: 'notice', isMeta: false })
  out('\r\nCompacted while idle, before the prompt cache expired\r\n')
  busy = false
  promptLine()
}

/**
 * A Bash command run in the background for `secs` seconds, recorded the way Claude Code records one. When it
 * ends, the task notification starts a new turn by itself, which replies and stops: under a new prompt_id, with a
 * UserPromptSubmit whose prompt is the notification (as Claude Code 2.1.296 does, #648).
 */
async function startBackgroundTask(secs) {
  const id = `toolu_${randomUUID().slice(0, 8)}`
  const task = `b${randomUUID().slice(0, 8)}`
  const input = { command: `sleep ${secs}`, description: 'Run the tests', run_in_background: true }
  await hook('PreToolUse', { tool_name: 'Bash', tool_input: input, tool_use_id: id })
  write({ type: 'assistant', requestId: `req_${id}`, message: { model, content: [{ type: 'tool_use', id, name: 'Bash', input }], usage: { input_tokens: 10, output_tokens: 5 } } })
  write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Command running in background with ID: ${task}.` }] }, toolUseResult: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: task } })
  await hook('PostToolUse', { tool_name: 'Bash', tool_input: input, tool_use_id: id })
  setTimeout(async () => {
    // A turn in progress finishes first, as Claude Code takes the notification after it.
    for (let i = 0; i < 600 && isBusy(); i++) await sleep(200)
    busy = true
    // A turn of its own: the notification is its prompt.
    promptId = randomUUID()
    turnStarted = Date.now()
    const note = `<task-notification>\n<task-id>${task}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n<summary>Background command "Run the tests" completed (exit code 0)</summary>\n</task-notification>`
    write({ type: 'user', origin: { kind: 'task-notification' }, promptSource: 'system', message: { role: 'user', content: note } })
    await hook('UserPromptSubmit', { prompt: note })
    await sleep(1500)
    await endTurn(`The background task ${task} has finished.`)
  }, secs * 1000)
}

/**
 * A subagent the Agent tool runs in the background for `secs` seconds (#1584), recorded as Claude Code 2.1 records one
 * (an `async_launched` result with its agentId). Its end is told as a background command's is: a notification that
 * starts a turn by itself.
 */
async function startSubagent(secs, k) {
  const id = `toolu_${randomUUID().slice(0, 8)}`
  const agentId = `a${randomUUID().replace(/-/g, '').slice(0, 16)}`
  const description = `Review part ${k}`
  const input = { description, prompt: 'Review the change.', subagent_type: 'general-purpose', run_in_background: true }
  await hook('PreToolUse', { tool_name: 'Agent', tool_input: input, tool_use_id: id })
  write({ type: 'assistant', requestId: `req_${id}`, message: { model, content: [{ type: 'tool_use', id, name: 'Agent', input }], usage: { input_tokens: 10, output_tokens: 5 } } })
  write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${agentId}` }] }] }, toolUseResult: { isAsync: true, status: 'async_launched', agentId, description, resolvedModel: model, prompt: input.prompt, canContinueAgent: true } })
  await hook('PostToolUse', { tool_name: 'Agent', tool_input: input, tool_use_id: id })
  setTimeout(async () => {
    for (let i = 0; i < 600 && isBusy(); i++) await sleep(200)
    busy = true
    promptId = randomUUID()
    turnStarted = Date.now()
    const note = `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n<summary>Agent "${description}" finished</summary>\n</task-notification>`
    write({ type: 'queue-operation', operation: 'enqueue', content: note })
    write({ type: 'user', origin: { kind: 'task-notification' }, promptSource: 'system', message: { role: 'user', content: note } })
    await hook('UserPromptSubmit', { prompt: note })
    await sleep(1500)
    await endTurn(`The subagent ${description} has finished.`)
  }, secs * 1000)
}

// Its input and its footer, as Claude Code 2.1.296 marks them (no taller than the fake's prompt before #648).
/**
 * Its input is Claude Code 2.1.312's box (HI-1959; by default since HI-1979, as the real CLI draws it): a rule, `❯`
 * and a no-break space, the line typed after it, and a rule and its footer below (drawn back after the line changes).
 * With fake-plain-prompt.txt in its home at its start, `❯ ` on its own, as before.
 */
const inputBox = !(home && fs.existsSync(path.join(home, 'fake-plain-prompt.txt')))
/**
 * Whether what is typed goes into the box now (HI-1979): while it works, typing goes after its busy lines, as before
 * (the box under its spinner stays as drawn), so the box is drawn round the line only while it is idle.
 */
const boxed = () => inputBox && !busy
const RULE = '─'.repeat(40)
/**
 * The box's rule and footer under its line, the cursor taken back to where the line ends (`col`, its cells on its last
 * row): moved back two rows rather than saved and restored, as a line feed at the bottom of the screen scrolls it,
 * and a restored place is then a row lower (HI-1979: a box at the bottom left its rule and footer behind).
 */
const boxBelow = (col = lineEnd()) => `\r\n${RULE}\r\n  ? for shortcuts\x1b[2A\r${col > 0 ? `\x1b[${col}C` : ''}`
const promptLine = () => {
  // One box: one already shown goes first (HI-1979: an idle compaction's end drew a second over it).
  takeBox()
  rawOut(inputBox ? `\r\n${RULE}\r\n❯ ${boxBelow(2)}` : '\r\n❯ \r\n  ? for shortcuts\r\n')
  boxShown = inputBox
  // Its dialog under the box (HI-2191, as 2.1.314 draws it) stays under it.
  if (inputBox && envSetupUnder) rawOut(underDialog())
}
/** While it works: its spinner, then its input (the box, empty: HI-1979) and footer below (BUSY_LINES lines down from where it starts). */
const BUSY = inputBox ? `\r\n✻ Brewing… (esc to interrupt)\r\n${RULE}\r\n❯ \r\n${RULE}\r\n  ? for shortcuts\r\n` : '\r\n✻ Brewing… (esc to interrupt)\r\n❯ \r\n  ? for shortcuts\r\n'
const BUSY_LINES = inputBox ? 6 : 4
/** The write after which the busy lines were drawn (taken back at the turn's end only if nothing came since). */
let busyDrawn = -1

/** "/compact [focus]", as Claude Code runs it. */
async function compact(focus) {
  const messages = fs.existsSync(transcript) && fs.readFileSync(transcript, 'utf8').includes('"type":"user"')
  if (!messages) {
    out('\r\nNot enough messages to compact.\r\n')
    promptLine()
    return
  }
  busy = true
  // Typed while idle: a prompt_id of its own, with no prompt (Claude Code 2.1.296, #648).
  promptId = randomUUID()
  await hook('PreCompact', { trigger: 'manual', custom_instructions: focus })
  out('\r\nCompacting conversation…\r\n')
  await sleep(Number(/\bhold\s+(\d+)/i.exec(focus)?.[1] ?? 1) * 1000)
  if (/\bcompactfail\b/i.test(focus)) {
    out('\r\nError during compaction: Error: API Error: 500\r\n')
  } else {
    write({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 30, postTokens: 10 } })
    // The next request records the system prompt afresh.
    if (home) fs.rmSync(path.join(home, 'fake-prompts', `${sessionId}.txt`), { force: true })
    out('\r\nConversation compacted.\r\n')
    // Claude Code starts the session again after a compaction, manual or not (SessionStart, source compact).
    await sessionStart('compact')
    await hook('PostCompact', { trigger: 'manual' })
  }
  busy = false
  promptLine()
}

async function quit() {
  await hook('SessionEnd', { reason: 'prompt_input_exit' })
  process.exit(0)
}

/**
 * Whether to drop this Enter: fake-drop-enters-<agent>.txt in its home holds how many Enters after a line from Hive to
 * drop (a test writes it); each drop counts it down.
 */
function dropEnter() {
  if (!home) return false
  const agent = String(process.env.CW_AGENT || 'agent').replace(/[^\w-]/g, '_')
  const file = path.join(home, `fake-drop-enters-${agent}.txt`)
  try {
    const n = Number(fs.readFileSync(file, 'utf8').trim())
    if (!(n > 0)) return false
    fs.writeFileSync(file, String(n - 1))
    return true
  } catch {
    return false
  }
}

/**
 * fake-slow-input-<agent>.txt in its home: while it is there, no input is read (#597), as a busy Claude Code doesn't;
 * fake-slow-input-<agent>.paused says the reading has stopped. Once it goes, the next read is what came meanwhile.
 */
let slowRead = false
let lostEnters = 0
if (home && process.stdin.isTTY) {
  const agent = String(process.env.CW_AGENT || 'agent').replace(/[^\w-]/g, '_')
  const knob = path.join(home, `fake-slow-input-${agent}.txt`)
  const paused = path.join(home, `fake-slow-input-${agent}.paused`)
  setInterval(() => {
    const slow = fs.existsSync(knob)
    if (slow && !process.stdin.isPaused()) {
      process.stdin.pause()
      fs.writeFileSync(paused, '')
    } else if (!slow && fs.existsSync(paused)) {
      fs.rmSync(paused, { force: true })
      slowRead = true
      process.stdin.resume()
    }
  }, 100) // kept, not unref'd: with its input paused, it is what keeps the fake running
}

// What arrives from the terminal: a line, Enter, Ctrl+U, Ctrl+C.
let line = ''
/** The Enters pressed since the line was begun, dropped and lost ones too (#664: was a line sent at its first Enter?). */
let enters = 0
let onEnter = null
/** The trust question while it is asked: { on: 'No' | 'Yes' }, the choice its menu shows. */
let trustMenu = null
function drawTrust() {
  out(`\r\nQuick safety check: Do you trust the files in ${cwd}?\r\n ${trustMenu.on === 'No' ? '>' : ' '} No, exit\r\n ${trustMenu.on === 'Yes' ? '>' : ' '} Yes, I trust this folder\r\n Enter to confirm · Esc to cancel\r\n`)
}
let ctrlC = 0
/**
 * A character's cells as a terminal draws it (HI-1974, HR6's round 1): two for East Asian wide and full-width ones and
 * pictographs, none for joiners, variation selectors and combining marks, one for the rest.
 */
const cells = (ch) => (/\p{M}|\u200d|[\ufe00-\ufe0f]/u.test(ch) ? 0 : /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u.test(ch) ? 2 : 1)
/**
 * The input line on the screen's rows, each its characters, as the terminal wraps it: at its width by each character's
 * cells (one that doesn't fit begins the next row) and at its line breaks; begun after the box's `❯ ` (inputBox), else
 * at the row's start.
 */
const lineLayout = () => {
  const cols = process.stdout.columns || 80
  const rows = [[]]
  let x = boxed() ? 2 : 0
  for (const ch of line) {
    if (ch === '\n') {
      rows.push([])
      x = 0
      continue
    }
    const w = cells(ch)
    if (x + w > cols) {
      rows.push([])
      x = 0
    }
    rows[rows.length - 1].push(ch)
    x += w
  }
  return rows
}
/** The screen rows the input line takes (lineLayout). */
const lineRows = () => lineLayout().length
/** The column where the input line ends on its last row (lineLayout): what boxBelow takes the cursor back to. */
const lineEnd = () => {
  const rows = lineLayout()
  const cells0 = rows.length === 1 && boxed() ? 2 : 0
  return Math.min((process.stdout.columns || 80) - 1, cells0 + rows[rows.length - 1].reduce((n, ch) => n + cells(ch), 0))
}
/**
 * Draws the input line again (after a key took some of it back), from its first row: `rows`, the rows it took before.
 * In the box, from its top rule, as Claude Code draws its whole box again (HI-1979: a draft taller than the screen
 * scrolled the rule off, and the box drawn back without it could never be read again).
 */
const redrawLine = (rows) => {
  const box = boxed()
  const up = rows - 1 + (box ? 1 : 0)
  rawOut(`\r${up > 0 ? `\x1b[${up}A` : ''}\x1b[J${box ? `${RULE}\r\n❯ ` : ''}${line.replace(/\n/g, '\r\n')}${box ? boxBelow() : ''}`)
  boxShown = box
}
liftBox = () => `\r\x1b[${lineRows()}A\x1b[J`
dropBox = () => `\r\n${RULE}\r\n❯ ${line.replace(/\n/g, '\r\n')}${boxBelow()}`
/** In the box (inputBox): the rows its line took as last drawn, while what was typed since isn't drawn yet. */
let undrawn = null
/** Draws what was typed into the box since it was last drawn (a read's end, or a key that changes the line otherwise). */
const drawTyped = () => {
  if (undrawn === null) return
  const rows = undrawn
  undrawn = null
  redrawLine(rows)
}
/** Inside a bracketed paste, which can come in several reads. */
let inPaste = false
/** fake-log-input.txt in its home at its start: each read of its input, as it came, goes into fake-input.jsonl there (#1286). */
const inputLog = home && fs.existsSync(path.join(home, 'fake-log-input.txt')) ? path.join(home, 'fake-input.jsonl') : null
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (data) => {
  lastInput = Date.now()
  if (inputLog) fs.appendFileSync(inputLog, JSON.stringify({ agent: process.env.CW_AGENT || 'agent', data, at: new Date().toISOString() }) + '\n')
  // Down or Up in the trust menu moves its choice (two choices).
  if (trustMenu)
    for (const _ of data.matchAll(/\x1b\[[AB]/g)) {
      trustMenu.on = trustMenu.on === 'No' ? 'Yes' : 'No'
      drawTrust()
    }
  // A bracketed paste's start and end stay as a mark each (private-use characters): what is between them is text.
  const chars = data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, (m) => (m === '\x1b[200~' ? '\ue000' : m === '\x1b[201~' ? '\ue001' : ''))
  // The read after a slow spell (#597): several characters, not a bracketed paste, are a paste, as in Claude Code.
  const pasted = slowRead && chars.length > 1 && !data.includes('\x1b[200~')
  slowRead = false
  if (pasted && /[\x15\r]/.test(chars)) lostEnters++
  for (const ch of chars) {
    if (ch === '\ue000' || ch === '\ue001') {
      inPaste = ch === '\ue000'
      continue
    }
    // Its offer to teach auto mode on screen (HI-1959): Esc puts it off, Enter answers it, the rest it takes.
    if (envSetupOpen) {
      if (ch === '\x1b') envSetupAnswered('later')
      else if (ch === '\r' && !inPaste) envSetupAnswered('accept')
      continue
    }
    // A line break or tab in a bracketed paste is text, as in Claude Code: the line keeps it (#1286).
    if (inPaste && (ch === '\r' || ch === '\n' || ch === '\t')) {
      if (boxed() && undrawn === null) undrawn = lineRows()
      line += ch === '\t' ? ch : '\n'
      if (!boxed()) out(ch === '\t' ? ch : '\r\n')
      continue
    }
    // A Ctrl+U or an Enter in a paste is text: nothing is cleared or sent.
    if (pasted && (ch === '\x15' || ch === '\r')) continue
    if (ch === '\x03') {
      if (++ctrlC >= 2) void quit()
      continue
    }
    ctrlC = 0
    // Any other key draws what was typed into the box first.
    if (ch < ' ') drawTyped()
    // What is typed shows on its input line, as in Claude Code (a pasted image's path too, #195).
    if (ch === '\x15') {
      // Only the screen row the cursor is on goes, as in Claude Code 2.1.312 (HI-1974: a narrow pane kept a stopped
      // wake's first rows, sent with the next): the rows before it stay. At a row begun by a line break, that break goes.
      if (line) {
        const rows = lineRows()
        const last = lineLayout().at(-1)
        line = last.length ? [...line].slice(0, -last.length).join('') : line.slice(0, -1)
        redrawLine(rows)
      }
      if (!line) enters = 0
    } else if ((ch === '\r' || ch === '\n') && !onEnter && Date.now() < drawingUntil) {
      // Still drawing the resumed conversation: the Enter is lost, what was typed stays on the line (#334).
      continue
    } else if (ch === '\r' || ch === '\n') {
      enters++
      // A CLI that doesn't take the Enter after a line Hive typed (#376: Codex once left a wake in its prompt): the line
      // stays, as typed, for the next Enter.
      if (line.startsWith('[CW]') && dropEnter()) continue
      // The Enter after such a paste is lost too (#597).
      if (lostEnters > 0 && line) {
        lostEnters--
        continue
      }
      // Signed out, shown late (#1321): a prompt isn't sent; its status line says so under the line, which stays as typed.
      if (!onEnter && line.trim() && !line.trim().startsWith('/') && expiredLate()) {
        out(`\r\n  Not logged in · Run /login\r\n> ${line}`)
        continue
      }
      const text = line.trim()
      const enter = enters
      // Sent, the box goes from its top rule (HI-1979): an old one left on screen with its prompt would be read as the
      // input, as Claude Code's isn't. The prompt shows in the conversation (runPrompt), as before.
      if (line && boxShown) takeBox()
      else if (line) out('\r\n')
      line = ''
      enters = 0
      if (onEnter) {
        const f = onEnter
        onEnter = null
        f()
      } else if (text === '/exit') void quit()
      // A crash, for its stopped pane's "exited with code 1" (HI-1881): not a command Claude Code has.
      else if (text === '/crash') process.exit(1)
      // /rename: the session's name, as Claude Code keeps it (no hook; Hive sees it in the transcript).
      else if ((text === '/compact' || text.startsWith('/compact ')) && !busy) void compact(text.slice(8).trim())
      else if (text === '/login' && !busy) void login()
      else if (text.startsWith('/rename ')) {
        write({ type: 'custom-title', customTitle: text.slice(8).trim() })
        promptLine()
      }
      else if (text && !busy) void runPrompt(text, enter)
      // A prompt sent while it is busy (a turn, a compaction) is dropped: recorded in fake-dropped.jsonl in its home (#725).
      else if (text && home) fs.appendFileSync(path.join(home, 'fake-dropped.jsonl'), JSON.stringify({ agent: process.env.CW_AGENT || 'agent', text: text.slice(0, 200), at: new Date().toISOString() }) + '\n')
    } else if (ch === '\x7f' || ch === '\b') {
      // One character, however wide it is drawn or whichever row it is on, as in Claude Code 2.1.312 (HI-1974).
      if (line) {
        const rows = lineRows()
        line = [...line].slice(0, -1).join('')
        redrawLine(rows)
      }
    } else if (ch >= ' ') {
      if (!line) enters = 0
      if (boxed() && undrawn === null) undrawn = lineRows()
      line += ch
      if (!boxed()) out(ch)
    }
  }
  drawTyped()
})

/** "linger N": N processes left running after it ends (linger.cjs), started through one that exits at once. */
function leaveRunning(n) {
  for (let i = 0; i < n; i++) spawn(process.execPath, [path.join(__dirname, 'linger.cjs'), 'starter', path.join(home, 'fake-linger.jsonl'), process.env.CW_AGENT || 'agent'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

/** "hidden-linger": one process left running as "linger 1" leaves it, but naming no test folder (HI-2217; fake-hidden-linger.jsonl). */
function leaveUnnamedRunning() {
  spawn(process.execPath, [path.join(__dirname, 'linger.cjs'), 'unnamed-starter', path.join(home, 'fake-hidden-linger.jsonl'), process.env.CW_AGENT || 'agent'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

/** "devapp": a dev copy of an Electron app left running (devapp/main.js), started through one that exits at once (#614). */
function leaveAppRunning() {
  // In its home, so its command line names the test's folder (and its profile stays there: devapp/main.js).
  const app = path.join(home, 'devapp')
  fs.cpSync(path.join(__dirname, 'devapp'), app, { recursive: true })
  spawn(process.execPath, [path.join(__dirname, 'linger.cjs'), 'app-starter', path.join(home, 'fake-devapp.jsonl'), process.env.CW_AGENT || 'agent', app], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

/**
 * "progress-linger": a command left running through the session's hive-progress shim (on its PATH), not waited for to end
 * (#542). The turn goes on until its node runs (it writes its pid; two minutes at most, in case): what the agent started is
 * there when its turn ends, so the running marker written after the turn's status has it (#1100: under load the three
 * processes took longer to start than the turn, and the marker, written two seconds after the turn ended and then only
 * each minute, missed them). fake-progress-delay-ms.txt (N) starts the command N ms late, as a machine under load does.
 * wait false ("progress-linger nowait"): the turn ends at once, the command still to start, as a real agent's may be (#1134).
 */
async function leaveProgressRunning(wait = true) {
  const q = (x) => `"${x}"`
  const pids = path.join(home, 'fake-progress-linger.jsonl')
  const had = fs.existsSync(pids) ? fs.readFileSync(pids, 'utf8').length : 0
  const command = ['hive-progress', '--title', q('Left running'), '--', q(process.execPath), q(path.join(__dirname, 'linger.cjs')), 'linger', q(pids), process.env.CW_AGENT || 'agent'].join(' ')
  const delayFile = path.join(home, 'fake-progress-delay-ms.txt')
  const delay = fs.existsSync(delayFile) ? Number(fs.readFileSync(delayFile, 'utf8')) || 0 : 0
  const start = () => spawn('cmd.exe', ['/d', '/s', '/c', q(command)], { cwd, env: process.env, detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref()
  // Started late on its own, while the turn goes on, as a command that is slow to start.
  if (delay) setTimeout(start, delay)
  else start()
  if (!wait) return
  for (const end = Date.now() + 120_000; Date.now() < end && !(fs.existsSync(pids) && fs.readFileSync(pids, 'utf8').length > had); ) await sleep(100)
}

async function main() {
  // fake-linger-at-start.txt (N) in its home: N lingering processes the moment it starts, before anything else (#507).
  const atStart = path.join(home, 'fake-linger-at-start.txt')
  if (fs.existsSync(atStart)) leaveRunning(Number(fs.readFileSync(atStart, 'utf8')) || 1)
  // Bracketed paste on, as Claude Code turns it on.
  out('\x1b[?2004hClaude Code (fake, for Hive tests)\r\n')
  const trustFile = path.join(home, 'fake-trusted.json')
  const trusted = fs.existsSync(trustFile) ? JSON.parse(fs.readFileSync(trustFile, 'utf8')) : []
  if (!trusted.includes(cwd.toLowerCase())) {
    // Claude Code's menu, but starting on "Yes" (Claude Code's starts on "No, exit"), so the suites' bare Enter trusts:
    // Down and Up move it, and Enter on "No, exit" quits (exit 1).
    trustMenu = { on: 'Yes' }
    drawTrust()
    const yes = await new Promise((r) => (onEnter = () => r(trustMenu.on === 'Yes')))
    trustMenu = null
    if (!yes) process.exit(1)
    fs.writeFileSync(trustFile, JSON.stringify([...trusted, cwd.toLowerCase()]))
  }
  // An OAuth session that expired and can't be refreshed: Claude Code says so and exits with 1 before its session
  // starts (#577, as 2.1.296 did).
  if (expiredAtLaunch()) {
    out('Failed to authenticate: OAuth session expired and could not be refreshed\r\n')
    process.stdout.write('', () => process.exit(1))
    return
  }
  // --name: Claude Code keeps it as the session's name (a custom title, as /rename does).
  if (opts['--name']) {
    if (take('fake-title-untimed')) fs.appendFileSync(transcript, JSON.stringify({ type: 'custom-title', customTitle: opts['--name'], sessionId }) + '\n')
    else write({ type: 'custom-title', customTitle: opts['--name'] })
  }
  // Its MCP servers connect as it starts, beside its session (#865): the launch's hive server, through the real server,
  // which tells Hive. With fake-mcp-hold-<agent> in its home, not until the test makes fake-mcp-go-<agent>, as a
  // resumed Claude Code connects them after its SessionStart.
  const hive = opts['--mcp-config'] ? JSON.parse(fs.readFileSync(opts['--mcp-config'], 'utf8')).mcpServers?.hive : null
  const held = take('fake-mcp-hold')
    ? (async () => {
        while (!take('fake-mcp-go')) await sleep(100)
      })()
    : null
  void connectHive(hive, held)
  if (take('fake-start-hold')) while (!take('fake-start-go')) await sleep(100)
  await sessionStart(opts['--resume'] ? 'resume' : 'startup')
  promptLine()
  setInterval(() => void whileIdle(), 200)
  if (firstPrompt && take('fake-launch-hold')) while (!take('fake-launch-go')) await sleep(100)
  if (firstPrompt) await runPrompt(firstPrompt)
}
void main()
