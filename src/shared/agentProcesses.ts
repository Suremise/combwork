import { msg } from './i18n/msg'
import type { Tr } from './tasks'

/** A process an agent's launch started (its job's, #507), as listed to the user. */
export interface AgentProcess {
  pid: number
  /** Its executable's file name (node.exe). */
  name: string
  /** What it runs, short: the executable without .exe and its arguments, paths cut to their last part (node serve.js --port 8080). */
  label: string
  /** When it started (a Windows FILETIME, as text): with its pid, which process it is, kept across Combwork's restart (#614). */
  created?: string
  /** The process that started it, by id (#1008): a test run's tree is told as one. */
  parent?: number
  /** A cw-progress run's title, on the cw-progress process itself (#1008): what the run is, as the agent named it. */
  run?: string
}

/**
 * The title of a cw-progress run (#1008), from its process's command line (Combwork's executable running cw-progress.js
 * --title "<title>" -- <command>): its --title, else the command it runs. Undefined for any other process.
 */
export function progressRunTitle(commandLine: string): string | undefined {
  const args = splitCommandLine(commandLine)
  const at = args.findIndex((a) => /(^|[\\/])cw-progress\.js$/i.test(a))
  if (at < 0) return undefined
  const rest = args.slice(at + 1)
  const dash = rest.indexOf('--')
  const flag = rest.indexOf('--title')
  const title = flag >= 0 && (dash < 0 || flag < dash) ? rest[flag + 1]?.trim() : ''
  const command = (dash >= 0 ? rest.slice(dash + 1) : rest).map((a) => lastPart(a)).join(' ').trim()
  const named = (title || command || 'cw-progress').replace(/\s+/g, ' ')
  return named.length > MAX_LABEL ? `${named.slice(0, MAX_LABEL - 1)}…` : named
}

/** A cw-progress run among processes (#1008): its own process (root, the one with `run`) and all it started that are listed. */
export interface ProgressRunGroup {
  title: string
  root: AgentProcess
  /** What its whole tree is under: the shell that ran it through the cw-progress command (cmd /c "cw-progress …"), else root. */
  top: AgentProcess
  processes: AgentProcess[]
}

/**
 * The processes in their cw-progress runs (#1008): each run's process with everything below it in the list, and the
 * shell above it that ran the cw-progress command, by parent, each started after its parent (so a parent id a later
 * process took is never followed); the rest apart.
 */
export function groupProgressRuns(processes: readonly AgentProcess[]): { runs: ProgressRunGroup[]; rest: AgentProcess[] } {
  const byPid = new Map(processes.map((p) => [p.pid, p]))
  const started = (p: AgentProcess): bigint => (p.created && /^\d+$/.test(p.created) ? BigInt(p.created) : 0n)
  const parentOf = (p: AgentProcess): AgentProcess | undefined => {
    const up = p.parent ? byPid.get(p.parent) : undefined
    return up && up !== p && started(up) <= started(p) ? up : undefined
  }
  /** The cw-progress process p is under (itself included), if any. */
  const runOf = (p: AgentProcess): AgentProcess | undefined => {
    const seen = new Set<number>()
    for (let at: AgentProcess | undefined = p; at && !seen.has(at.pid); at = parentOf(at)) {
      if (at.run) return at
      seen.add(at.pid)
    }
    return undefined
  }
  // The shells that ran a run's process through the cw-progress command: the run's too, the topmost its tree's top.
  const shellOf = new Map<number, AgentProcess>()
  const tops = new Map<number, AgentProcess>()
  for (const r of processes.filter((p) => p.run)) {
    let top = r
    for (let s = parentOf(r); s && !s.run && /\bcw-progress\b/i.test(s.label) && !shellOf.has(s.pid); s = parentOf(s)) {
      shellOf.set(s.pid, r)
      top = s
    }
    tops.set(r.pid, top)
  }
  const runs = new Map<number, ProgressRunGroup>()
  const rest: AgentProcess[] = []
  for (const p of processes) {
    const root = runOf(p) ?? shellOf.get(p.pid)
    if (!root) {
      rest.push(p)
      continue
    }
    const g = runs.get(root.pid) ?? { title: root.run!, root, top: tops.get(root.pid) ?? root, processes: [] }
    g.processes.push(p)
    runs.set(root.pid, g)
  }
  return { runs: [...runs.values()], rest }
}

/**
 * Of the processes still running, those in cw-progress runs and the rest (#1008), the runs found among all that were
 * kept (running holds the same processes, as id and start time): a run whose own process has ended, with what it started
 * still running, is still that run. Each run lists only its processes still running; runs with none are left out.
 */
export function progressRunsIn(running: readonly AgentProcess[], kept: readonly AgentProcess[] = running): { runs: ProgressRunGroup[]; rest: AgentProcess[] } {
  const key = (p: AgentProcess): string => `${p.pid}:${p.created ?? ''}`
  const live = new Set(running.map(key))
  const seen = new Set<string>()
  const all = [...kept, ...running].filter((p) => !seen.has(key(p)) && !!seen.add(key(p)))
  const inRun = new Set<string>()
  const runs: ProgressRunGroup[] = []
  for (const g of groupProgressRuns(all).runs) {
    const processes = g.processes.filter((p) => live.has(key(p)))
    if (!processes.length) continue
    runs.push({ ...g, processes })
    for (const p of processes) inRun.add(key(p))
  }
  return { runs, rest: running.filter((p) => !inRun.has(key(p))) }
}

/** What an agent's stopped launches left running. No processes: nothing (any more). */
export interface AgentLeftovers {
  projectPath: string
  agentId: string
  agentName: string
  processes: AgentProcess[]
  /** Processes running beyond those listed. */
  more: number
  /** When the earliest of them was found left running (ISO). */
  since: string
}

/** What to do with the processes an agent leaves running when it stops (Settings → Agents). */
export type LeftoverProcessMode = 'ask' | 'end'
export const LEFTOVER_PROCESS_MODES: readonly LeftoverProcessMode[] = ['ask', 'end']

const MAX_LABEL = 80

/** The arguments of a Windows command line, as CommandLineToArgvW splits them (quotes kept out, enough for a label). */
function splitCommandLine(cmd: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  let any = false
  for (const ch of cmd) {
    if (ch === '"') {
      quoted = !quoted
      any = true
    } else if (!quoted && /\s/.test(ch)) {
      if (cur || any) out.push(cur)
      cur = ''
      any = false
    } else cur += ch
  }
  if (cur || any) out.push(cur)
  return out
}

/** A path's last part: C:\a\b\serve.js is serve.js. A switch (`/d`, `/c`: HI-1743, it lost its slash) and anything else as it is. */
const lastPart = (arg: string): string => (/^\/[A-Za-z?]{1,4}$/.test(arg) ? arg : /^(?:[A-Za-z]:)?[\\/]/.test(arg) || /^[A-Za-z]:/.test(arg) ? (arg.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? arg) : arg)

/** A process as the user recognises it: `node npm-cli.js run serve`, `tail -f capture-1.log`. */
export function processLabel(name: string, commandLine: string): string {
  const exe = name.replace(/\.exe$/i, '')
  // The executable unquoted, with spaces in its path (C:\Program Files\Git\usr\bin\tail.exe -f x): up to its name.
  let line = commandLine.trim()
  const at = line.startsWith('"') ? -1 : line.toLowerCase().indexOf(name.toLowerCase())
  if (at >= 0 && /^(\s|$)/.test(line.slice(at + name.length))) line = `x${line.slice(at + name.length)}`
  const args = splitCommandLine(line).slice(1).map((a) => (a.includes(' ') ? `"${lastPart(a)}"` : lastPart(a)))
  const label = [exe, ...args].join(' ').replace(/\s+/g, ' ').trim()
  return label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label
}

/** "2 processes": a count with its noun; in the window's language with tr (#799), else English (main's notices, until theirs are converted). */
export const processCount = (n: number, tr?: Tr): string =>
  tr ? tr(msg({ id: 'panes.processes.count', defaultMessage: '{n, plural, one {# process} other {# processes}}', description: 'How many processes an agent left running ("2 processes").' }), { n }) : `${n} process${n === 1 ? '' : 'es'}` // i18n-ignore: English for main's notices (the window passes tr)

/** A list joined as a language joins it (fmt.list's shape): passed in with tr, as this module can't load the i18n runtime. */
export type ListWords = (items: readonly string[], type?: 'conjunction' | 'unit') => string

/** Lists in Combwork's English, as the Agent API and agents read them: "A, B and C". */
const englishList: ListWords = (items, type = 'conjunction') => new Intl.ListFormat('en-GB', { type, style: type === 'unit' ? 'short' : 'long' }).format(items)

/**
 * The leftovers in a line: "node serve.js, 4 × tail -f …" (each label once, with how many share it), at most `max` labels,
 * then how many more. In the window's language with its tr and list (fmt.list), else English.
 */
export function leftoversSummary(l: Pick<AgentLeftovers, 'processes' | 'more'>, max = 4, words?: { tr: Tr; list: ListWords }): string {
  const counts = [...l.processes.reduce((m, p) => m.set(p.label, (m.get(p.label) ?? 0) + 1), new Map<string, number>())]
  const shown = counts.slice(0, max)
  const extra = l.processes.length - shown.reduce((a, [, n]) => a + n, 0) + l.more
  const tr = words?.tr
  const labels = shown.map(([label, n]) => (n < 2 ? label : tr ? tr(msg({ id: 'session.leftovers.times', defaultMessage: '{n, number} × {label}', description: 'A process an agent left running, in a list of them, when several run the same command: how many, and the command ({label}: "tail -f capture.log").' }), { n, label }) : `${n} × ${label}`)) // i18n-ignore: English for agents and the Agent API (the window passes tr)
  const list = words?.list ?? englishList
  if (extra <= 0) return list(labels, 'unit')
  const more = tr ? tr(msg({ id: 'session.leftovers.more', defaultMessage: '{n, plural, one {# more process} other {# more processes}}', description: 'The last item of a list of the processes an agent left running, after the first few: how many more there are. Combwork joins it to the list ("node serve.js, 2 × tail -f capture.log and 3 more processes").' }), { n: extra }) : `${extra} more ${extra === 1 ? 'process' : 'processes'}` // i18n-ignore: English for agents and the Agent API (the window passes tr)
  return list([...labels, more])
}
