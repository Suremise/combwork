/**
 * Redaction for Help → Copy Diagnostics: what a bug report may carry from a user's machine. Folders
 * become placeholders, names of workspaces, projects and agents are removed, and anything that looks
 * like a secret is masked. It errs towards removing too much.
 */

export interface RedactContext {
  /** The user's home folder: becomes ~. */
  home: string
  /** Workspace folders, and other folders that name the user's work (worktrees): each becomes <workspace>. */
  folders: string[]
  /** Names to remove wherever they appear as a word: projects, agents, branches, workspaces. */
  names: { name: string; as: string }[]
  /** Hive's own folder (a development build's checkout): becomes <hive>, so its stack traces keep their file names. */
  app?: string
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A folder written with either slash, in any case. */
const folderRe = (p: string): RegExp => new RegExp(escape(p.replace(/[\\/]+$/, '')).replace(/\\\\|\//g, String.raw`[\\/]+`), 'gi')

// ---------------------------------------------------------------------------
// Credentials in free text (#699; the Assistant's rules after rounds 3–5): a credential's name anywhere in a string, bare
// or quoted (`password=`, `--api-key`, `"password":`, `'api key':`), masks everything after it to the end of that string.
// No parsing of quotes, escapes, continuations, options or JSON: a secret's value can't leave a fragment behind, and no
// container can hide one, when nothing after its name is kept. Losing what follows a secret (the flags after it, a JSON
// object's other fields) is the accepted cost. A payload Hive holds as an object is masked by its keys instead
// (devConsole.ts's redactPayload), not here. Names are found by a single pass of direct character checks, no regex: each
// character is looked at a bounded number of times, so it is linear on any input (round 5 found quadratic regexes).
// ---------------------------------------------------------------------------

type Step = (text: string) => string
const replacing =
  (re: RegExp, by: string): Step =>
  (text) =>
    text.replace(re, by)

/**
 * The words that make a name a secret's or a sign-in's, with spaces, dots, underscores and dashes taken out of the name
 * first (`api_key`, `x-api-key`, `"api key"` and `api.key` all hold `apikey`). A name holding one anywhere counts
 * (`GITHUB_TOKEN`, `csrftoken`, `client_secret`, `Authorization`).
 */
const CREDENTIAL_WORDS = ['token', 'secret', 'password', 'passwd', 'passphrase', 'passcode', 'pwd', 'apikey', 'credential', 'cookie', 'sessionkey', 'accesskey', 'privatekey', 'auth', 'devicecode', 'usercode', 'otp', 'codeverifier']

/** A name's characters: ASCII letters and digits, `_`, `-` and `.` (a key, an option, an environment variable). */
const isNameChar = (c: string | undefined): boolean =>
  c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '-' || c === '.')
const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || (c !== undefined && c > '~' && c.trim() === '') || c === '\v' || c === '\f'

function namesCredential(name: string): boolean {
  // Shorter than every credential word (`pwd`, `otp`): none can be in it.
  if (name.length < 3) return false
  let squeezed = ''
  for (const c of name.toLowerCase()) if (!isSpace(c) && c !== '.' && c !== '_' && c !== '-') squeezed += c
  return CREDENTIAL_WORDS.some((w) => squeezed.includes(w))
}

/**
 * Where a value starts after a name ending at `end`, or -1: past a key's closing quote (escaped or not), then `:` or `=`
 * (spaces around it); for an option (`dash`), whitespace alone will do too. Reads only the characters right after the
 * name, which belong to no other name.
 */
function valueAfter(text: string, end: number, dash: boolean): number {
  let k = end
  while (text[k] === '\\') k++
  if (text[k] === '"' || text[k] === "'") k++
  else k = end
  let s = k
  while (isSpace(text[s])) s++
  if (text[s] === ':' || text[s] === '=') {
    s++
    while (isSpace(text[s])) s++
    return s
  }
  return dash && s > k ? s : -1
}

/**
 * At most this far, `-u`'s value is read for the `:` of a user:password, and a quoted name for its closing quote. One that
 * reaches its limit without a clear end is masked, whatever it holds (#705 round 3: masking too much is fine, showing a
 * secret isn't, and no exact budget then decides whether a password shows).
 */
const LOOK = 256
const QUOTED_NAME_MAX = 100

/**
 * After `-u` or `--user` ending at `end`: where its value starts if it is a user:password (quoted, escaped or spaced), or
 * one too long to tell (no `:`, closing quote or space within LOOK characters), else -1.
 */
function userPasswordAfter(text: string, end: number): number {
  let s = end
  if (text[s] === '=') s++
  else if (isSpace(text[s])) while (isSpace(text[s])) s++
  else return -1
  // Escaping backslashes before a quote: read once, as no other name can start inside them.
  let k = s
  while (text[k] === '\\') k++
  const q = text[k] === '"' || text[k] === "'" ? text[k] : ''
  const from = q ? k + 1 : s
  for (let p = from; p < text.length; p++) {
    if (p - from >= LOOK) return s
    const c = text[p]
    if (c === ':') return s
    if (q ? c === q : isSpace(c) || c === '"' || c === "'") return -1
  }
  return -1
}

/**
 * Where a credential's value starts in free text, or -1: after a name holding a credential's word and its separator (a
 * key's `:` or `=`, `token=t`, `password: p`, `Authorization: Bearer t`, `$env:API_KEY = k`, `"password":`, `\"token\":`;
 * an option's `=` or whitespace, `--api-key k`), a quoted name of up to 100 characters, whatever is in it (`'api key':`, `"token[0]":`),
 * `-u` or `--user` with a user:password, or `Bearer `; a quoted name naming a credential, or `-u`'s value, that reaches its
 * limit without a clear end, from there. One pass: each name run is read once, each quote looks at most 100 characters
 * ahead, `-u` at most 256 after its quote.
 */
function credentialStart(text: string): number {
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text[i]
    if (c === '"' || c === "'") {
      // A quoted name, whatever is in it (`'api key':`, `"token[0]":`, `"password/value":`): up to the next quote of either
      // kind on its line, at most 100 characters on, tested whole (#705 round 1: a name a run of name characters can't
      // hold, read as runs, never reached its closing quote and separator).
      let close = i + 1
      while (close < n && close - i <= QUOTED_NAME_MAX && text[close] !== '"' && text[close] !== "'" && text[close] !== '\n' && text[close] !== '\r') close++
      // No closing quote within the limit, and what was read names a credential: masked from there (round 3).
      if (close < n && close - i > QUOTED_NAME_MAX && namesCredential(text.slice(i + 1, close))) return i + 1
      if (text[close] === '"' || text[close] === "'") {
        let nameEnd = close
        while (nameEnd > i + 1 && text[nameEnd - 1] === '\\') nameEnd--
        if (namesCredential(text.slice(i + 1, nameEnd))) {
          const v = valueAfter(text, close, false)
          if (v >= 0) return v
        }
      }
      i++
      continue
    }
    if (!isNameChar(c)) {
      i++
      continue
    }
    let j = i
    while (isNameChar(text[j])) j++
    const name = text.slice(i, j)
    // Its last part after a dot as well (`x.Bearer t`, `a.--token t`): a name starts after a dot too (#705 round 1).
    const last = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    if (last === '-u' || last === '--user') {
      const v = userPasswordAfter(text, j)
      if (v >= 0) return v
    } else if (last === 'bearer' && isSpace(text[j])) {
      let s = j
      while (isSpace(text[s])) s++
      if (s < n) return s
    } else if (namesCredential(name)) {
      const v = valueAfter(text, j, name[0] === '-' || last[0] === '-')
      if (v >= 0) return v
    }
    i = j
  }
  return -1
}

/** Everything after a credential's name in the string, masked. */
const maskCredentialTail: Step = (text) => {
  const at = credentialStart(text)
  return at < 0 || at >= text.length ? text : `${text.slice(0, at)}<redacted>`
}

const SECRETS: Step[] = [
  maskCredentialTail,
  // A sign-in's codes and signatures in a URL (OAuth's code and state, a device login's one-time code, a signed URL's signature).
  replacing(/([?&#](?:code|state|code_challenge|id_token|refresh_token|otc|ticket|sig|signature|nonce)=)[^&#\s"']+/gi, '$1<redacted>'),
  // Well-known key formats.
  replacing(/\b(?:sk-ant-|sk-|ghp_|gho_|ghu_|ghs_|github_pat_|xox[abprs]-|glpat-|AKIA)[\w-]{8,}/g, '<redacted>'),
  // JWTs.
  // (Only where a run of its characters starts: `eyJ-eyJ-…` read the rest of the run from each `eyJ`.)
  replacing(/(?<![\w-])eyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}/g, '<redacted>'),
  // Long hex or base64 runs (keys, tokens, hashes).
  replacing(/\b[0-9a-f]{20,}\b/gi, '<redacted>'),
  // (Only where a run starts: `+` and `=` before it too, or `+a+a…` was read again from after every `+`.)
  replacing(/(?<![\w/\\.+=-])[A-Za-z0-9+/]{40,}={0,2}(?![\w/\\.-])/g, '<redacted>'),
  // Email addresses. Each starts only where a run of its characters starts, so a long run is read once (from every word
  // boundary in `x-x-x…` it was read again and again).
  replacing(/(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
]

export function redact(text: string, ctx: RedactContext): string {
  let out = text
  if (ctx.app && ctx.app.length > 3) out = out.replace(folderRe(ctx.app), '<hive>')
  // Longest first, so a worktree inside a workspace isn't half replaced.
  for (const f of [...ctx.folders].filter((x) => x.length > 3).sort((a, b) => b.length - a.length)) out = out.replace(folderRe(f), '<workspace>')
  if (ctx.home.length > 3) out = out.replace(folderRe(ctx.home), '~')
  for (const n of [...ctx.names].filter((x) => x.name.trim().length > 1).sort((a, b) => b.name.length - a.name.length)) {
    out = out.replace(new RegExp(String.raw`(?<![\w-])${escape(n.name.trim())}(?![\w-])`, 'gi'), n.as)
  }
  return maskText(out)
}

/**
 * Masks what looks like a secret: everything after a credential's name (bare or quoted, a JSON key's too), known key and token
 * formats, sign-in codes in URLs, long hex or base64 runs and emails; names and paths before them stay.
 */
export function maskSecrets(text: string): string {
  // Server connections' keys in use first (HI-1772, main's keyMatcher.ts), whatever their shape.
  let out = keyMasker ? keyMasker(text) : text
  for (const step of SECRETS) out = step(out)
  return out
}

/** Masks the keys Hive holds in use: main's keyMatcher.ts sets it; nothing in a window holds a key. */
let keyMasker: ((text: string) => string) | null = null
export function setKeyMasker(fn: ((text: string) => string) | null): void {
  keyMasker = fn
}

/**
 * Sign-in codes in free text, which no name announces: a device code standing alone (`ABCD-EFGH`, `WXYZ-12345`), and a
 * code after the words a sign-in uses ("enter ABCD12345", "code: QX7-PL2-9KD"). Erring towards masking.
 */
const SIGN_IN_CODES: [RegExp, string][] = [
  [/(?<![\w-])[A-Z0-9]{4}-[A-Z0-9]{4,5}(?![\w-])/g, '<redacted>'],
  // (One run of spaces, then an optional `:` and its spaces: two runs side by side made a long run of spaces slow.)
  [/(\b(?:[Cc]ode|CODE|[Ee]nter|ENTER|OTP|otp|[Pp]asscode|PIN)\b[^\S\r\n]*(?:[:=][^\S\r\n]*)?)[A-Z0-9][A-Z0-9-]{5,15}(?![\w-])/g, '$1<redacted>']
]

/**
 * Masks what may be a secret in free text (a prompt, a reply, a command, a log line): maskSecrets' rules, then sign-in
 * codes. Names and identifiers use maskSecrets alone (a code-shaped name is no sign-in).
 */
export function maskText(text: string): string {
  let out = maskSecrets(text)
  for (const [re, by] of SIGN_IN_CODES) out = out.replace(re, by)
  return out
}

/**
 * Text the log marked as the user's own (logger.ts userText()): a span between Unicode isolate marks. A span stops at the
 * next opening mark too, so a line of opening marks is read once (not again from each one); what such a line leaves goes
 * with the next step's rest-of-line rule.
 */
const USER_TEXT = /⁨([^⁨⁩\n]*)⁩/g
const looksLikePath = (s: string): boolean => /^\s*(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/)/.test(s) || s.includes('\\')

/** Replaces the user's own text marked in log lines with <path> or <text>; a span cut off by the end of a line goes too. */
export function hideUserText(text: string): string {
  return text
    .replace(USER_TEXT, (_m, inner: string) => (looksLikePath(inner) ? '<path>' : '<text>'))
    .replace(/⁨[^\n]*/g, '<text>')
    .replace(/⁩/g, '')
}

/** Folders whose paths name nothing of the user's: app data, the CLIs' dot folders, Windows and installed programs. */
const PLAIN_FOLDER = /^(?:~[\\/](?:AppData|\.)|[A-Za-z]:[\\/](?:Program Files|Program Files \(x86\)|ProgramData|Windows)(?:[\\/]|$))/i
/** An absolute path, up to a space or a character that can't be in one (from a path with spaces, the words after the first space stay). */
const ABSOLUTE_PATH = /(?<![\w<>])(?:[A-Za-z]:[\\/](?:Program Files(?: \(x86\))?)?|~[\\/]|\\\\)[^\s"'<>|?*,;()[\]{}]*/gi
/** A string that is one absolute path as a whole, spaces and all (a drive's, a home-relative or a UNC path). */
const WHOLE_PATH = /^(?:[A-Za-z]:[\\/]|~[\\/]|\\\\)[^\n"<>|?*]*$/i

/**
 * The report's last step after redact() (HI-2332): any absolute path left that isn't one of Hive's or the CLIs' own
 * (outside every known folder: another drive, a share) becomes <path>. Shared by the log and recordings.
 */
export function hidePaths(text: string): string {
  return text.replace(ABSOLUTE_PATH, (p) => (PLAIN_FOLDER.test(p) ? p : '<path>'))
}

/**
 * Redaction for one string value of a report's structured attachment (a console recording's event fields): redact(),
 * then hidePaths(). A value that is a path as a whole goes whole, so the words after a space in it don't stay.
 */
export function redactValue(text: string, ctx: RedactContext): string {
  const out = redact(text, ctx)
  const whole = out.trim()
  if (WHOLE_PATH.test(whole)) return PLAIN_FOLDER.test(whole) ? out : '<path>'
  return hidePaths(out)
}

/** In the line Hive logs as it starts, once its log marks the user's own text. */
export const MARKED_LOG = 'your text marked'
const START_LINE = /^\S+ \[INFO\] \[main\] Hive \S+ starting \((.*)\)$/
/** What a line logged before Hive marked the user's text shows instead of its message. */
export const OLDER_LINE = '<message left out: logged by an older version of Hive>'

/**
 * Redaction for Hive's log: the user's own text it marked goes first, then redact(), then any absolute path left
 * that isn't one of Hive's or the CLIs' own (folders of workspaces no longer open) becomes <path>. Lines from a run
 * of Hive that didn't mark the user's text (its start line doesn't say so) keep only their time, level and scope:
 * card titles and names in them can't be told apart from the rest. `text` is the end of the log of the Hive that is
 * running: lines before the first start line in it are from an earlier run, unless there is none (then they all come
 * after the running Hive's own start line).
 */
export function redactLog(text: string, ctx: RedactContext): string {
  const lines = text.split('\n')
  let marked = !lines.some((l) => START_LINE.test(l))
  // Each line is a string of its own: a credential masks the rest of its line, and of the lines a continuation carries
  // it onto (a line ending in PowerShell's backtick or a shell's backslash), so a continued command can't leak there.
  let carried = false
  const continues = (line: string): boolean => /[`\\][^\S\n]*$/.test(line)
  return lines
    .map((line) => {
      const start = START_LINE.exec(line)
      if (start) {
        marked = start[1].includes(MARKED_LOG)
        carried = false
        return line
      }
      if (carried) {
        carried = continues(line)
        return '<redacted>'
      }
      // A line's time, level and [scope] stay as they are: a project called "sessions" mustn't take the scope with it.
      const head = /^\S+ \[[A-Z]+\] \[[\w-]+\] /.exec(line)?.[0] ?? ''
      if (!marked) return line.trim() ? `${head}${OLDER_LINE}` : line
      const rest = hidePaths(redact(hideUserText(line.slice(head.length)), ctx))
      carried = rest.endsWith('<redacted>') && continues(line)
      return head + rest
    })
    .join('\n')
}
