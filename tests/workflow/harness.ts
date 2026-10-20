// The workflow spike's test harness (#1118): a real temporary Git repository (or a plain folder for None), the spike's
// store in a file of its own, and a Workflow over them, with wakes and notifications captured. Scenarios (SPEC §16.18)
// drive it as agents and the user would, and read the facts.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tempDir } from '../tempDir'
import { FactStore } from '../../src/main/workflow/factStore'
import { isRefusal, Workflow, type Reply } from '../../src/main/workflow/runtime'
import { MergeQueue, type CheckResult, type QueueConfig } from '../../src/main/workflow/mergeQueue'
import { allOff, type WorkflowOptions } from '../../src/shared/workflow/options'
import { agentActor, type FactKind } from '../../src/shared/workflow/facts'
import type { Refusal } from '../../src/shared/workflow/refusals'

export const B1 = agentActor('B1')
export const B2 = agentActor('B2')
export const B3 = agentActor('B3')
export const R1 = agentActor('R1')
export const R2 = agentActor('R2')

const ID = ['-c', 'user.name=Hive Test', '-c', 'user.email=test@hive.invalid']

/** git in a folder, as a person in a terminal would run it; its output. */
export function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** Writes a file (making its folder). */
export function put(dir: string, file: string, content: string): void {
  const p = join(dir, file)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, content)
}

/** Writes files and commits them; the new commit's id. */
export function commit(cwd: string, files: Record<string, string>, message: string, opts: { trailer?: string; email?: string } = {}): string {
  for (const [f, c] of Object.entries(files)) put(cwd, f, c)
  sh(cwd, 'add', '-A')
  const who = opts.email ? ['-c', `user.email=${opts.email}`] : []
  execFileSync('git', [...ID, ...who, 'commit', '-q', '-m', message, ...(opts.trailer ? ['--trailer', `Hive-Card: ${opts.trailer}`] : [])], { cwd, stdio: 'pipe' })
  return sh(cwd, 'rev-parse', 'HEAD')
}

/** A repository on `main` with one commit, its own identity set (unit tests have no global git config). */
export function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  sh(dir, 'config', 'user.name', 'Hive Test')
  sh(dir, 'config', 'user.email', 'test@hive.invalid')
  sh(dir, 'config', 'core.autocrlf', 'false')
  commit(dir, { 'README.md': 'hello\n', 'src/a.txt': 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n' }, 'initial')
  return dir
}

export interface Env {
  wf: Workflow
  store: FactStore
  project: string
  /** Where the spike's store and slots live: outside the repository. */
  home: string
  options: WorkflowOptions
  wakes: { agent: string; card: string; why: string }[]
  notes: { card: string; text: string }[]
  queue: (cfg?: Partial<QueueConfig>) => MergeQueue
  /** Another Hive on the same workspace: its own store connection and Workflow (§16.17). */
  another: () => Workflow
  /** Facts of a card, by kind. */
  kinds: (card: number) => FactKind[]
  close: () => void
}

/** A scenario's world: Git (a repository) or None (a folder), with these options. */
export function setup(options: Partial<WorkflowOptions> & { platform: 'git' | 'none' }, extra: { runsOf?: (a: string) => string[]; locksOf?: (a: string) => string[]; autoRun?: boolean; files?: Record<string, string> } = {}): Env {
  const home = tempDir('wf-')
  const project = join(home, 'project')
  if (options.platform === 'git') gitRepo(project)
  else mkdirSync(project, { recursive: true })
  if (extra.files) for (const [f, c] of Object.entries(extra.files)) put(project, f, c)
  const o: WorkflowOptions = { ...allOff(options.platform), ...options }
  const store = new FactStore(join(home, 'workflow.db'))
  const wakes: Env['wakes'] = []
  const notes: Env['notes'] = []
  const stores: FactStore[] = [store]
  const make = (s: FactStore) =>
    new Workflow({
      store: s,
      project,
      projectKey: 'AM',
      options: () => o,
      slots: join(home, 'slots'),
      runsOf: extra.runsOf,
      locksOf: extra.locksOf,
      autoRun: extra.autoRun,
      effects: { wake: (agent, card, why) => wakes.push({ agent, card: card.key, why }), notify: (card, text) => notes.push({ card: card.key, text }) }
    })
  const wf = make(store)
  const passing = async (): Promise<CheckResult> => ({ ok: true, output: '' })
  return {
    wf,
    store,
    project,
    home,
    options: o,
    wakes,
    notes,
    queue: (cfg = {}) => new MergeQueue(wf, { folder: join(home, 'queue'), runCheck: passing, ...cfg }),
    another: () => {
      const s = new FactStore(join(home, 'workflow.db'))
      stores.push(s)
      return make(s)
    },
    kinds: (card) => store.facts(card).map((f) => f.kind),
    close: () => {
      for (const s of stores) s.close()
    }
  }
}

/** The reply must be a move; else the test fails with the refusal's text. */
export function moved(r: Reply | unknown): asserts r is Exclude<Reply, Refusal> {
  if (isRefusal(r)) throw new Error(`refused ${r.rule}: ${r.message} ${r.next}`)
}

/** The reply must be a refusal of this rule. */
export function refusedBy(r: unknown, rule: string): Refusal {
  if (!isRefusal(r)) throw new Error(`expected a refusal by ${rule}, got ${JSON.stringify(r)}`)
  if (r.rule !== rule) throw new Error(`expected a refusal by ${rule}, got ${r.rule}: ${r.message}`)
  return r
}
