// The Preview runner's shared half (HI-3614, design HI-3597 s8/s16/s21, SPEC §16.21): a project's preview setting, the
// command Project Settings suggests from package.json for the user to confirm, a running preview as the window and the
// agent tool read it, and the profile-wide port range. Main's half is previewRunner.ts (the runner) and previewApp.ts
// (places, ports across the profile, the supervisor, IPC).

/** A project's preview (project.json `preview`), set in Project Settings → Preview. */
export interface PreviewConfig {
  /** The command that starts the dev server, run in the place's folder (cmd, as a slot's setup command is). */
  command: string
  /** The page's path on the server (default "/"). */
  path?: string
  /** A second port for the server's hot reload socket (CW_PREVIEW_HMR_PORT). */
  hmrPort?: boolean
}

/** The longest a preview command may be. */
export const PREVIEW_COMMAND_MAX = 1000
/** The longest a preview's path may be. */
export const PREVIEW_PATH_MAX = 200

/** A preview setting as project.json may hold it: the setting, or null when there's none or it isn't one. */
export function previewConfigOf(raw: unknown): PreviewConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const command = typeof r.command === 'string' ? r.command.trim() : ''
  if (!command || command.length > PREVIEW_COMMAND_MAX || /[\r\n\0]/.test(command)) return null
  const path = typeof r.path === 'string' && r.path.trim() ? r.path.trim() : undefined
  if (path !== undefined && !validPreviewPath(path)) return null
  return { command, ...(path && path !== '/' ? { path } : {}), ...(r.hmrPort === true ? { hmrPort: true } : {}) }
}

/** A page path: from the server's root, at most PREVIEW_PATH_MAX characters, no spaces, backslashes or control characters. */
export const validPreviewPath = (p: string): boolean => p.startsWith('/') && !p.startsWith('//') && p.length <= PREVIEW_PATH_MAX && !/[\s\\\0-\x1f\x7f]/.test(p)

/** The scripts Project Settings suggests a preview command from, in the order it looks for them. */
export const PREVIEW_SCRIPTS = ['dev', 'start', 'preview'] as const

/** The package managers a lockfile names, and how each runs a script. */
const RUNNERS: { lock: string; run: (script: string) => string }[] = [
  { lock: 'pnpm-lock.yaml', run: (s) => `pnpm run ${s}` }, // i18n-ignore: a command line, run as it is
  { lock: 'yarn.lock', run: (s) => `yarn run ${s}` }, // i18n-ignore: a command line, run as it is
  { lock: 'bun.lockb', run: (s) => `bun run ${s}` }, // i18n-ignore: a command line, run as it is
  { lock: 'bun.lock', run: (s) => `bun run ${s}` } // i18n-ignore: a command line, run as it is
]

/** A suggested preview command: the script it runs, its line in package.json, and the command. */
export interface PreviewSuggestion {
  script: string
  /** The script's own command line, as package.json has it (cut at 200 characters). */
  line: string
  command: string
}

/**
 * The command Project Settings suggests (HI-3614): the first of `dev`, `start` and `preview` package.json's scripts have,
 * run by the package manager a lockfile in the folder names (npm with none). Null when the file isn't JSON or has none of
 * them. Only a suggestion: nothing is saved until the user confirms it.
 */
export function suggestPreviewCommand(packageJson: string | null, files: readonly string[] = []): PreviewSuggestion | null {
  if (!packageJson) return null
  let scripts: unknown
  try {
    scripts = (JSON.parse(packageJson) as { scripts?: unknown })?.scripts
  } catch {
    return null
  }
  if (!scripts || typeof scripts !== 'object') return null
  const s = scripts as Record<string, unknown>
  const script = PREVIEW_SCRIPTS.find((k) => typeof s[k] === 'string' && (s[k] as string).trim())
  if (!script) return null
  const have = new Set(files.map((f) => f.toLowerCase()))
  const runner = RUNNERS.find((r) => have.has(r.lock))
  return { script, line: (s[script] as string).trim().slice(0, 200), command: runner ? runner.run(script) : `npm run ${script}` } // i18n-ignore: a command line, run as it is
}

/** The lockfiles suggestPreviewCommand reads beside package.json. */
export const PREVIEW_LOCKFILES = RUNNERS.map((r) => r.lock)

/** The environment a preview's server is given its ports in. */
export const PREVIEW_ENV = { port: 'PORT', preview: 'CW_PREVIEW_PORT', hmr: 'CW_PREVIEW_HMR_PORT' } as const

/** How many ports the preview range holds (`cw.preview.portRange` is its first). */
export const PREVIEW_RANGE_SIZE = 1000
/** The installed app's first preview port; a development build's range is the next PREVIEW_RANGE_SIZE ports (46000–46999). */
export const PREVIEW_PORT_DEFAULT = 45000

/** The preview ports from `first`, as [first, last]. */
export const previewRange = (first: number): [number, number] => [first, Math.min(65535, first + PREVIEW_RANGE_SIZE - 1)]

/** Where a preview runs: the project folder, a slot or a review copy. */
export type PreviewPlaceKind = 'project' | 'slot' | 'copy'

/** A place, as a preview records it. */
export interface PreviewPlace {
  kind: PreviewPlaceKind
  /** The slot's or copy's name; "project" for the project folder. */
  name: string
  folder: string
  /** Its generation: the slot's lease or the review copy's lease (the review); "project" for the project folder. */
  generation: string
}

/**
 * The source a place holds (HI-3614, s16 §B; HI-3614 round 1: a tree that couldn't be read is never taken for clean):
 * - `clean`: its files are exactly its commit's;
 * - `dirty`: they differ, `content` the tree id of its files (tracked, and untracked ones git doesn't ignore), the same
 *   files always giving the same id; `commit` null in a repository with none yet;
 * - `none`: the folder isn't in a git repository, so there is no source to name;
 * - `unknown`: git couldn't read it (why: its error's first line), so whether it changed can't be told.
 */
export type PreviewSource =
  | { kind: 'clean'; commit: string }
  | { kind: 'dirty'; commit: string | null; content: string }
  | { kind: 'none' }
  | { kind: 'unknown'; commit: string | null; why: string }

/** Why a preview isn't running. */
export type PreviewEnd =
  | { kind: 'stopped' }
  | { kind: 'exited'; code: number | null }
  | { kind: 'placeEnded' }
  | { kind: 'projectClosed' }
  | { kind: 'turnedOff' }
  | { kind: 'quitting' }
  | { kind: 'noFreePort'; first: number; last: number }
  | { kind: 'stranger'; port: number; pid: number }
  | { kind: 'otherPort'; port: number; listening: number[] }
  | { kind: 'notListening'; port: number; seconds: number }
  | { kind: 'noStart'; detail: string }
  /** Another preview's server in the same place couldn't be proved ended: nothing starts there until it is (HI-3614 round 2). */
  | { kind: 'placeHeld'; preview: string }
  /** Its page's network guard (the filtering proxy) stopped or couldn't start: its page is gone, nothing more loads (HI-3615). */
  | { kind: 'guardStopped' }

export type PreviewState = 'starting' | 'running' | 'stopped'

/** A preview as the window and the agent tool read it. */
export interface PreviewView {
  id: string
  projectPath: string
  place: PreviewPlace
  state: PreviewState
  port: number
  hmrPort: number | null
  /** Its address (http://127.0.0.1:<port><path>) while it runs. */
  url: string | null
  startedAt: string
  /** When it was seen listening, in its own tree. */
  readyAt: string | null
  stoppedAt: string | null
  /** Why it stopped, or failed to start. */
  end: PreviewEnd | null
  /** The source at its start (unknown until its stamp is read). */
  source: PreviewSource
  /** When the place's files last changed after its start, as its watcher saw (null: not since). */
  changedAt: string | null
  /** Its server couldn't be proved ended: its place and ports stay held until a later try proves it. */
  held: boolean
  /** Its server's log (Combwork's own folder, logs\preview). */
  logPath: string | null
}

/** The address a preview's page is at. */
export const previewUrl = (port: number, path = '/'): string => `http://127.0.0.1:${port}${path}`

/**
 * Whether two sources are the same files: true or false when both are known (two folders outside a repository are the
 * same, for want of anything to tell); null when either couldn't be read.
 */
export function sameSource(a: PreviewSource, b: PreviewSource): boolean | null {
  if (a.kind === 'unknown' || b.kind === 'unknown') return null
  if (a.kind !== b.kind) return false
  if (a.kind === 'none') return true
  if (a.kind === 'clean') return a.commit === (b as typeof a).commit
  return a.commit === (b as typeof a).commit && a.content === (b as typeof a).content
}
