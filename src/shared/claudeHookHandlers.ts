/**
 * Claude Code's hook handlers as Combwork gives them (HI-2777), in one place for its launch settings and for the admin
 * snippet an organisation pastes into its managed settings. Claude Code runs a handler defined in more than one settings
 * file once (its hooks reference), so a session with the snippet in managed settings and Combwork's launch settings
 * beside it sends each hook once: the two are built here, from the same values, to be identical.
 *
 * HTTP hooks post to a fixed URL (an HTTP hook's url takes no environment variables) on Combwork's Agent API port, and
 * carry the launch's own token from its environment (`CW_HOOK_TOKEN`), by which Combwork knows the run. SessionStart takes
 * only command hooks: it, and the snippet's status line, run one PowerShell command, given encoded so Git Bash and
 * PowerShell (the two shells Claude Code runs them in) pass it alike. It reads the URL and the launch's auth file from
 * the environment (`CW_HOOK_URL`, `CW_HOOK_AUTH_FILE`), so neither names a port, and gives curl only the auth file's
 * name, from its folder: the token is never in a command line, and no curl has to open a Unicode path. A session that
 * isn't Combwork's has neither variable, and the command sends nothing.
 */

/** The user guide's section on Claude Code under an organisation's managed policy (its heading's id). */
export const MANAGED_POLICY_GUIDE = 'claude-code-managed-policy'

/** Claude Code's hook events Combwork takes. */
export const CLAUDE_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'StopFailure', 'PreCompact', 'PostCompact', 'SessionEnd'] as const // i18n-ignore: Claude Code's hook event names

/** The variables a launch sets for its hook commands. */
export const HOOK_URL_ENV = 'CW_HOOK_URL' // i18n-ignore: an environment variable's name
export const HOOK_AUTH_FILE_ENV = 'CW_HOOK_AUTH_FILE' // i18n-ignore: an environment variable's name
export const HOOK_TOKEN_ENV = 'CW_HOOK_TOKEN' // i18n-ignore: an environment variable's name

/** The hooks' timeouts in seconds (Settings → Advanced: claude-code.hooks.timeoutSeconds and preToolUseTimeoutSeconds). */
export interface HookTimeouts {
  hook: number
  preToolUse: number
}

/** What the admin snippet is made from (HI-2777: servers.ts claudeSnippetFacts). */
export interface ClaudeSnippetFacts {
  /** This Combwork's Agent API port. */
  port: number
  /** The other build's default port (a development build's beside the installed app's), when it isn't this one. */
  otherPort: number | null
  /** An installed copy (else a development build). */
  packaged: boolean
  /** Whether the Agent API is listening on its port now (the fixed hook URL is there). */
  listening: boolean
  timeouts: HookTimeouts
}

/** The fixed URL Claude Code's HTTP hooks post to, for Combwork's Agent API on `port`. */
export const fixedHookUrl = (port: number): string => `http://127.0.0.1:${port}/hook`

/**
 * The PowerShell script the hook command runs: posts stdin to the launch's URL (`suffix` added) with the auth file's
 * header, curl's output as Claude Code reads it (SessionStart's JSON), and exits 0 whatever happened.
 */
export function forwardScript(seconds: number, suffix = ''): string {
  return [
    "$ProgressPreference='SilentlyContinue'",
    `$u=$env:${HOOK_URL_ENV}; $a=$env:${HOOK_AUTH_FILE_ENV}`,
    'if (-not $u -or -not $a) { exit 0 }',
    'Set-Location -LiteralPath (Split-Path -LiteralPath $a)',
    `curl.exe -s -m ${Math.round(seconds)} -X POST -H "@$(Split-Path $a -Leaf)" -H "Content-Type: application/json" --data-binary "@-" "$($u)${suffix}"`, // $($u): "$u?…" would read a variable named u?…
    'exit 0'
  ].join('\n') // i18n-ignore: a script the CLI runs
}

/** The command for forwardScript: one word of base64 after PowerShell's options, the same in Git Bash and PowerShell. */
export function forwardCommand(seconds: number, suffix = ''): string {
  // UTF-16LE, as -EncodedCommand takes it; btoa works in the window and in Node alike.
  const script = forwardScript(seconds, suffix)
  let bytes = ''
  for (let i = 0; i < script.length; i++) bytes += String.fromCharCode(script.charCodeAt(i) & 0xff, script.charCodeAt(i) >> 8)
  const encoded = btoa(bytes)
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}` // i18n-ignore: a command the CLI runs
}

/** Each event's handler groups, for the hook URLs given (one HTTP handler per URL, the snippet's ports). */
export function claudeHookHandlers(urls: readonly string[], t: HookTimeouts): Record<string, unknown[]> {
  const http = (url: string, timeout: number): Record<string, unknown> => ({ type: 'http', url, timeout, headers: { Authorization: `Bearer $${HOOK_TOKEN_ENV}` }, allowedEnvVars: [HOOK_TOKEN_ENV] }) // i18n-ignore: an HTTP header Claude Code sends
  const hooks: Record<string, unknown[]> = {}
  for (const ev of CLAUDE_HOOK_EVENTS) {
    if (ev === 'SessionStart') {
      hooks[ev] = [{ hooks: [{ type: 'command', command: forwardCommand(t.hook), timeout: t.hook }] }]
      continue
    }
    // Every tool's start and end (#648); PreToolUse answers an edit with a lock decision, so it waits longer.
    const timeout = ev === 'PreToolUse' ? t.preToolUse : t.hook
    const handlers = urls.map((u) => http(u, timeout))
    hooks[ev] = [ev === 'PreToolUse' || ev === 'PostToolUse' ? { matcher: '*', hooks: handlers } : { hooks: handlers }]
  }
  return hooks
}

/** The snippet's status line: forwards Claude Code's status JSON to the launch's Combwork, printing nothing. */
export function managedStatusLine(t: HookTimeouts): { type: 'command'; command: string; padding: number } {
  return { type: 'command', command: forwardCommand(t.hook, '?statusline'), padding: 0 }
}

/**
 * The admin snippet: a managed-settings block with Combwork's hooks for the Agent API ports given (the installed app's,
 * and a development build's where wanted) and, unless left out, its status line.
 */
export function claudeManagedSnippet(ports: readonly number[], t: HookTimeouts, opts: { statusLine?: boolean } = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { hooks: claudeHookHandlers([...new Set(ports)].map(fixedHookUrl), t) }
  if (opts.statusLine !== false) out.statusLine = managedStatusLine(t)
  return out
}

/** The snippet as an admin pastes it. */
export const claudeManagedSnippetText = (ports: readonly number[], t: HookTimeouts, opts: { statusLine?: boolean } = {}): string => JSON.stringify(claudeManagedSnippet(ports, t, opts), null, 2)
