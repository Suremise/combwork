// A list of the user's commands run by one runner (HI-1954, design HI-1954/s19 §2): the runner owns the sequence from
// its start, each attempt of a step run by runner.ts' runJob in a folder of its own, and Combwork only watches it and
// steers it by control files. Its job.json is a snapshot: the steps' templates and the placeholders' values as the run
// began, so editing a command meanwhile changes nothing in it; a Rerun may bring newer values (a project added since).
// Node built-ins only: it runs outside the asar (cw-close-runner.js).
import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'fs'
import { join } from 'path'
import { CONTROL_MS, fillCommand, OBSERVER_STALE_MS, type CommandValues } from '../../shared/commands'
import { nodeDeps, runJob, type RunnerDeps, type RunStatus } from './runner'

/** A step as the run's snapshot holds it: the command's template and its folder's, as saved when the run began. */
export interface ListStep {
  name: string
  command: string
  /** The working folder's template; empty: the workspace's folder (values.workspace), else the user's home. */
  folder: string
  needed: boolean
}

/** What Combwork asks the runner to run (job.json): the list, and what fills its placeholders. */
export interface ListJob {
  list: true
  steps: ListStep[]
  values: CommandValues
  /** Where a step with no folder runs when there is no workspace. */
  home: string
}

/** A step's state as the list's status says it. */
export interface StepState {
  name: string
  state: 'waiting' | 'running' | 'ok' | 'failed' | 'skipped'
  /** Each Rerun is the next attempt (from 1). */
  attempt: number
  exitCode: number | null
  /** Why it failed with no exit code: a placeholder or folder it couldn't use, or the command not starting. */
  failure?: 'placeholder' | 'folder' | 'spawn'
  /** The placeholders that couldn't be filled ('placeholder'), the folder ('folder'), the system's text ('spawn'). */
  detail?: string
  /** The command as it ran (its placeholders filled). */
  command?: string
  /** Its attempt's folder under the run's, where its tail is. */
  dir?: string
  startedAt?: string
  endedAt?: string
}

/** The list's status (status.json): `state` and `runnerPid` as runner.ts' RunStatus has them, for pruning (runs.ts). */
export interface ListStatus {
  list: true
  runnerPid: number
  state: 'running' | 'exited'
  /** Watched by Combwork: a failure waits for its choice. False after Don't wait, or once Combwork stopped watching. */
  attended: boolean
  steps: StepState[]
  /** The failed step waiting for a choice, and its attempt. */
  awaiting: { step: number; attempt: number } | null
  /** done: every step ended (each ok, failed and skipped past, or skipped); stopped: Stop here, or a needed step failing unattended. */
  ended: 'done' | 'stopped' | null
  /** How an unattended failure was settled, for the panel and the log ("needed: stopped", "went on"). */
  unattended?: string
  startedAt: string
  endedAt?: string
}

/** A control Combwork writes (control-<step>-<attempt>.json, or control-detach.json for Don't wait at any time). */
export interface ListControl {
  action: 'rerun' | 'skip' | 'stop' | 'detach'
  /** With rerun: the placeholders' values now (a project since added). */
  values?: CommandValues
}

export { OBSERVER_STALE_MS }

/** What the list's runner needs besides runJob's: reading the run's folder, and waiting. */
export interface ListDeps extends RunnerDeps {
  exists: (p: string) => boolean
  read: (p: string) => string | null
  /** Takes a control (renames it to .done): false if another took it, or it's gone. */
  take: (p: string) => boolean
  mtime: (p: string) => number | null
  isDir: (p: string) => boolean
  mkdir: (p: string) => void
}

export const nodeListDeps = (): ListDeps => ({
  ...nodeDeps(),
  exists: existsSync,
  read: (p) => {
    try {
      return readFileSync(p, 'utf8')
    } catch {
      return null
    }
  },
  take: (p) => {
    try {
      renameSync(p, `${p}.done`)
      return true
    } catch {
      return false
    }
  },
  mtime: (p) => {
    try {
      return statSync(p).mtimeMs
    } catch {
      return null
    }
  },
  isDir: (p) => {
    try {
      return statSync(p).isDirectory()
    } catch {
      return false
    }
  },
  mkdir: (p) => void mkdirSync(p, { recursive: true })
})

const sleep = (deps: ListDeps, ms: number): Promise<void> => new Promise((r) => deps.setTimer(r, ms))

/** A control waiting in the run's folder, and its name: Don't wait's, or the one for this step's attempt. */
function control(dir: string, deps: ListDeps, step: number, attempt: number): { file: string; c: ListControl } | null {
  for (const name of ['control-detach.json', `control-${step}-${attempt}.json`]) {
    const file = join(dir, name)
    if (!deps.exists(file)) continue
    const text = deps.read(file)
    if (!text) continue
    try {
      const c = JSON.parse(text) as ListControl
      if (['rerun', 'skip', 'stop', 'detach'].includes(c.action)) return { file, c }
    } catch {
      // Half written: read again next time.
    }
  }
  return null
}

/**
 * Runs the list in `dir` to its end. Each step runs once it is its turn; one that fails waits, while watched, for Rerun,
 * Skip it and continue or Stop here (its control file); unwatched (Don't wait, or Combwork gone), a needed step failing
 * stops the list and any other goes on. Resolves with the final status.
 */
export async function runList(dir: string, job: ListJob, deps: ListDeps = nodeListDeps(), baseEnv: NodeJS.ProcessEnv = process.env): Promise<ListStatus> {
  const status: ListStatus = {
    list: true,
    runnerPid: deps.pid,
    state: 'running',
    attended: true,
    steps: job.steps.map((s) => ({ name: s.name, state: 'waiting', attempt: 0, exitCode: null })),
    awaiting: null,
    ended: null,
    startedAt: deps.now().toISOString()
  }
  const save = (): void => {
    try {
      deps.write(join(dir, 'status.json'), JSON.stringify(status))
    } catch {
      // Written again at the next change.
    }
  }
  /** Don't wait, at any time: from here nothing waits for a choice. */
  const detached = (): boolean => {
    if (status.attended && deps.exists(join(dir, 'control-detach.json')) && deps.take(join(dir, 'control-detach.json'))) status.attended = false
    return !status.attended
  }
  let values = job.values
  save()
  for (let i = 0; i < job.steps.length; i++) {
    const step = job.steps[i]
    const s = status.steps[i]
    let stop = false
    for (;;) {
      s.attempt++
      s.state = 'running'
      s.exitCode = null
      delete s.failure
      delete s.detail
      s.startedAt = deps.now().toISOString()
      delete s.endedAt
      save()
      const ok = await runAttempt(dir, i, step, s, values, job.home, deps, baseEnv, save)
      s.endedAt = deps.now().toISOString()
      s.state = ok ? 'ok' : 'failed'
      save()
      if (ok) break
      // Failed: watched, its choice; unwatched, the rule.
      let choice: ListControl['action'] | null = null
      if (!detached()) {
        status.awaiting = { step: i, attempt: s.attempt }
        save()
        while (choice === null) {
          if (detached()) break
          const c = control(dir, deps, i, s.attempt)
          if (c && c.c.action !== 'detach' && deps.take(c.file)) {
            choice = c.c.action
            if (c.c.values) values = c.c.values
            break
          }
          const seen = deps.mtime(join(dir, 'observer'))
          if (seen === null || deps.now().getTime() - seen > OBSERVER_STALE_MS) {
            status.attended = false
            break
          }
          await sleep(deps, CONTROL_MS)
        }
        status.awaiting = null
      }
      if (choice === null) {
        choice = step.needed ? 'stop' : 'skip'
        status.unattended = `${step.name}: ${choice === 'stop' ? 'needed, so the list stopped' : 'failed, the list went on'}` // i18n-ignore: the runner's own record
      }
      if (choice === 'rerun') continue
      if (choice === 'stop') stop = true
      break
    }
    if (stop) {
      for (const rest of status.steps.slice(i + 1)) rest.state = 'skipped'
      status.ended = 'stopped'
      break
    }
  }
  status.ended ??= 'done'
  status.state = 'exited'
  status.endedAt = deps.now().toISOString()
  save()
  return status
}

/** One attempt of a step: its placeholders and folder checked first (nothing malformed runs), then runJob. */
async function runAttempt(dir: string, i: number, step: ListStep, s: StepState, values: CommandValues, home: string, deps: ListDeps, baseEnv: NodeJS.ProcessEnv, save: () => void): Promise<boolean> {
  const command = fillCommand(step.command, values)
  const folder = fillCommand(step.folder, values)
  const missing = [...new Set([...command.missing, ...folder.missing])]
  s.command = command.text
  if (missing.length) {
    s.failure = 'placeholder'
    s.detail = missing.join(' ')
    return false
  }
  const cwd = folder.text || values.workspace || home
  if (!deps.isDir(cwd)) {
    s.failure = 'folder'
    s.detail = cwd
    return false
  }
  const sub = join(dir, `step-${i}-${s.attempt}`)
  s.dir = sub
  try {
    deps.mkdir(sub)
  } catch {
    // runJob's writes say so if it can't write there.
  }
  // Its command and folder in the list's status as it starts: Combwork's dialog shows them, and finds its output there.
  save()
  const r: RunStatus = await runJob(sub, { command: command.text, cwd }, deps, baseEnv)
  if (r.state === 'spawnFailed') {
    s.failure = 'spawn'
    s.detail = r.error
    return false
  }
  s.exitCode = r.exitCode
  return r.exitCode === 0
}

