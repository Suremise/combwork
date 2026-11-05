// The workflow spike's test harness (#1118): a real temporary Git repository (or a plain folder for None), the spike's
// store in a file of its own, and a Workflow over them, with wakes and notifications captured. Scenarios (SPEC §16.18)
// drive it as agents and the user would, and read the facts.
import { execFileSync } from 'child_process'
import { cpSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tempDir } from '../tempDir'
import { FactStore } from '../../src/main/workflow/factStore'
import { boardFile, closeBoard, workspaceDb } from '../../src/main/boardStore'
import { admitted } from '../admitted'
import { isRefusal, Workflow, type Reply, type WorkflowConfig } from '../../src/main/workflow/runtime'
import { MergeQueue, type CheckResult, type QueueConfig } from '../../src/main/workflow/mergeQueue'
import type { QueueLive } from '../../src/main/workflow/queueState'
import { allOff, type WorkflowOptions } from '../../src/shared/workflow/options'
import { agentActor, agentOf, type Actor, type FactKind } from '../../src/shared/workflow/facts'
import type { Refusal } from '../../src/shared/workflow/refusals'
import type { StoredText } from '../../src/shared/types'

export const B1 = agentActor('B1')
export const B2 = agentActor('B2')
export const B3 = agentActor('B3')
export const R1 = agentActor('R1')
export const R2 = agentActor('R2')

const ID = ['-c', 'user.name=Hive Test', '-c', 'user.email=test@hive.invalid']

/**
 * HI-2025 (Darren's decision): the bound of a merge-queue test whose work is 65 to 110 git processes (Combwork's own git per
 * queue step, about 95% of its time; nothing in it waits for time). Alone they take 2 to 11 s. 15 such tests passed 20 s
 * (the run's limit, vitest.config.ts) in HI-2025's runs of the workflow files under load: 5 in the baseline run, 13 in
 * the run beside three other lanes' full unit runs (CPU at 80%), after git was made cheaper, and 1 in the first final
 * set (some in more than one). A bound for a hung run, as that limit is, never a wait: three times it. Each test that
 * takes it says why beside it; only those take it, and S27's second case, which shares its test.
 */
export const GIT_HEAVY_MS = 60_000

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

/** A repository on `main` with one commit, its own identity set (unit tests have no global git config), made by git. */
export function freshGitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  sh(dir, 'config', 'user.name', 'Hive Test')
  sh(dir, 'config', 'user.email', 'test@hive.invalid')
  sh(dir, 'config', 'core.autocrlf', 'false')
  commit(dir, { 'README.md': 'hello\n', 'src/a.txt': 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n' }, 'initial')
  return dir
}

/**
 * HI-2025: freshGitRepo's repository, made once per test file (Vitest isolates modules per file) in a temp folder of its
 * own that the file's clean-up removes, and never handed out or changed after. Each gitRepo is a whole copy of it (no
 * links, no shared .git): 1 git process instead of 7, where a queue test's time is its git processes.
 */
let template: string | null = null

/** A repository on `main` with one commit, its own identity set: freshGitRepo's, as a copy of this file's template. */
export function gitRepo(dir: string): string {
  template ??= freshGitRepo(join(tempDir('wf-template-'), 'repo'))
  cpSync(template, dir, { recursive: true })
  // The copied files are newer than the index says: refreshed, so git sees them unchanged (diff-files doesn't refresh).
  execFileSync('git', ['update-index', '-q', '--refresh'], { cwd: dir, stdio: 'pipe' })
  return dir
}

export interface Env {
  wf: Workflow
  store: FactStore
  project: string
  /** The workspace folder: its combwork.db holds the store (#1215); slots live here too, outside the repository. */
  home: string
  options: WorkflowOptions
  wakes: { agent: string; card: string; why: string }[]
  notes: { card: string; text: string; shown?: StoredText }[]
  queue: (cfg?: Partial<QueueConfig>) => MergeQueue
  /** Another Combwork on the same workspace: its own store connection and Workflow (§16.17). */
  another: () => Workflow
  /** A store on a connection of its own to the workspace's combwork.db, as a restarted Combwork opens it (closed with the rest). */
  reopen: () => FactStore
  /** Facts of a card, by kind. */
  kinds: (card: number) => FactKind[]
  close: () => void
}

/** A scenario's world: Git (a repository) or None (a folder), with these options. */
export function setup(options: Partial<WorkflowOptions> & { platform: 'git' | 'none' }, extra: { runsOf?: (a: string) => string[]; autoRun?: boolean; files?: Record<string, string>; enforced?: () => boolean; queueLive?: (target: string) => QueueLive; checksSettled?: () => Promise<void>; focused?: WorkflowConfig['focused']; hooks?: WorkflowConfig['hooks']; reviewersPresent?: WorkflowConfig['reviewersPresent'] } = {}): Env {
  const home = tempDir('wf-')
  const project = join(home, 'project')
  if (options.platform === 'git') gitRepo(project)
  else mkdirSync(project, { recursive: true })
  if (extra.files) for (const [f, c] of Object.entries(extra.files)) put(project, f, c)
  const o: WorkflowOptions = { ...allOff(options.platform), ...options }
  // The workspace's combwork.db, made through the board's open path (#1215: the project's cards are the board's); the
  // runtime, outside any board change, has a connection of its own to it, as another Combwork would.
  const scope = { project: 'project', key: 'AM' }
  // Its window's, as a window opening it would admit it (#1395).
  const dismiss = admitted(home)
  workspaceDb(home)
  const store = FactStore.open(boardFile(home), scope)
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
      autoRun: extra.autoRun,
      enforced: extra.enforced,
      queueLive: extra.queueLive,
      checksSettled: extra.checksSettled,
      focused: extra.focused,
      hooks: extra.hooks,
      reviewersPresent: extra.reviewersPresent,
      // The P2 scenarios run the P4 runtime: reconciliation acts on what it observes (#1217: the app's P3 records only).
      reconcileActs: true,
      effects: { wake: (agent, card, why) => wakes.push({ agent, card: card.key, why }), notify: (card, text, shown) => notes.push({ card: card.key, text, ...(shown ? { shown } : {}) }) }
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
      const s = FactStore.open(boardFile(home), scope)
      stores.push(s)
      return make(s)
    },
    reopen: () => {
      const s = FactStore.open(boardFile(home), scope)
      stores.push(s)
      return s
    },
    kinds: (card) => store.facts(card).map((f) => f.kind),
    close: () => {
      for (const s of stores) s.close()
      closeBoard(home)
      dismiss()
    }
  }
}

/** An agent's file locks recorded as the app records them (#1481): on its current card, in that cycle. */
export function locked(wf: Workflow, agent: Actor, paths: string[]): Promise<boolean> {
  const a = agentOf(agent)!
  const c = wf.currentCards().get(a)
  return c ? wf.recordLocks(a, paths, { card: c.card.id, cycle: c.s.cycle }) : Promise.resolve(false)
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
