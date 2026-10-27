import { execFile } from 'child_process'
import { existsSync } from 'original-fs'
import { parentPort } from 'worker_threads'
import { readRepoRefs, type RepoRefs } from './platform/repoRefs'

/**
 * Git's worker (HI-1783): a thread of its own that starts Hive's git processes, so their starts (CreateProcess blocks the
 * thread that calls it, about 4 ms a process on Windows, and a check's resolve starts 9 to 21 of them) never hold up
 * Hive's main process and the keystrokes typed into a pane. Each command is run as git.ts always ran it (execFile, its
 * output as bytes, its bound and environment, its input); what it gives back is execFile's own outcome, which git.ts
 * reads as it always did. Its environment is main's, shared (SHARE_ENV), so a change main makes to it applies here too.
 * It also reads a repository's refs and working folders for the observer (HI-1814: a reset's read walked every ref file
 * on main). No Electron here (a worker can't load it).
 */

export interface GitRequest {
  id: number
  cwd: string
  /** The whole argument list, GIT_PREFIX included. */
  args: string[]
  maxBuffer: number
  input?: string
  env?: NodeJS.ProcessEnv
  timeout?: number
}

/** execFile's outcome: its output, and its error's code (a number: git's exit code; a string: Node's), killed and signal. */
export interface GitOutcome {
  stdout: Uint8Array
  stderr: Uint8Array
  error: { code: unknown; killed: boolean; signal: string | null } | null
  /** The command's folder is there (an ENOENT with it there is git missing, not the folder). */
  cwdExists: boolean
}

/** The observer's read of a repository (repoRefs.ts): its lines, its first `max` working folders and their HEADs. */
export interface RefsRequest {
  id: number
  kind: 'refs'
  common: string
  max: number
}

export type GitReply = { id: number; outcome: GitOutcome } | { id: number; refs: RepoRefs }

/** Runs one command as git.ts runs it. */
export function runGit(m: Omit<GitRequest, 'id'>): Promise<GitOutcome> {
  return new Promise((res) => {
    const child = execFile('git', m.args, { cwd: m.cwd, windowsHide: true, maxBuffer: m.maxBuffer, encoding: 'buffer', ...(m.env ? { env: m.env } : {}), ...(m.timeout ? { timeout: m.timeout } : {}) }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: unknown; killed?: boolean; signal?: string | null }) | null
      res({
        stdout: (stdout as unknown as Buffer) ?? Buffer.alloc(0),
        stderr: (stderr as unknown as Buffer) ?? Buffer.alloc(0),
        error: e ? { code: e.code, killed: !!e.killed, signal: e.signal ?? null } : null,
        // Only asked when git didn't start: a folder that isn't there makes Node say ENOENT too.
        cwdExists: e && typeof e.code === 'string' ? existsSync(m.cwd) : true
      })
    })
    // What the command reads (update-ref --stdin's transaction).
    if (m.input !== undefined) child.stdin?.end(m.input)
  })
}

const port = parentPort
if (port) {
  port.on('message', (m: GitRequest | RefsRequest) => {
    if ('kind' in m) {
      port.postMessage({ id: m.id, refs: readRepoRefs(m.common, m.max) } satisfies GitReply)
      return
    }
    void runGit(m).then((outcome) => {
      // The output moves to main rather than being copied (a diff can be megabytes), when it has its memory to itself: a
      // small one can be a slice of Node's shared pool, which moving would take from every other buffer in it, so that
      // one is copied first.
      const own = (b: Uint8Array): Uint8Array => (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b : new Uint8Array(b))
      const stdout = own(outcome.stdout)
      const stderr = own(outcome.stderr)
      const transfer = [...new Set([stdout.buffer, stderr.buffer])].filter((b): b is ArrayBuffer => b instanceof ArrayBuffer && b.byteLength > 0)
      port.postMessage({ id: m.id, outcome: { ...outcome, stdout, stderr } } satisfies GitReply, transfer)
    })
  })
}
