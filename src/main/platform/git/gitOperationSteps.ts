// HI-3470: a git operation left under way in a folder (the project folder, a slot, an agent's worktree), read and acted
// on from Changes' panel: Continue, Skip or Abort (a bisect: End bisect, `git bisect reset`), and each conflicted file
// settled with its own side, the other side, or as it is now. Every step is the user's click, never Combwork's own, and
// is checked again under the repository lock and the folder's fence before git runs, as Commit and Set aside are
// (gitFolderChanges.ts assertQuiet): the operation still the one the user saw, no Combwork run or agent's lock in the
// folder (folderBuilders), no agent working there (busyAgentIn), then the caller's guard (a slot's own: its pool's hold
// and quiet check, operationPanel.ts). Git does the work; a step that fails says git's own error.
import { readFile } from 'original-fs/promises'
import { join } from 'path'
import { mineIsTheirs, OPERATION_STEPS, type ConflictPick, type GitConflict, type GitOperationName, type GitOperationState, type OperationRequest } from '../../../shared/gitOperations'
import { msg } from '../../../shared/i18n'
import { combworkError } from '../../combworkError'
import { changingFolder } from '../../folderFence'
import { git, gitErrorLine } from '../../git'
import { busyAgentIn } from '../../gitRepo'
import { gitDirSync, operationSync } from '../../gitCommands'
import { createLogger, userText } from '../../logger'
import { withRepoLock } from '../../repoLock'
import { platformLimits } from '../limits'
import { workspace } from '../../workspace'

const log = createLogger('git-operation')

export const OPERATION_TEXT = {
  changed: msg({ id: 'service.gitOperation.changed', defaultMessage: "Git isn't in the middle of {was, select, merge {a merge} rebase {a rebase} am {an am} cherryPick {a cherry-pick} bisect {a bisect} other {a revert}} in {folder} any more: nothing was done. Look again.", description: "HI-3470: an error from the unfinished git operation panel (Version Control → Changes): the operation the user acted on ({was}, git's word for it) has ended or changed since they looked; {folder} is a path. Nothing was done." }),
  notStep: msg({ id: 'service.gitOperation.notStep', defaultMessage: "That isn't a step git offers for this operation.", description: 'HI-3470: an error from the unfinished git operation panel: a step (Continue, Skip, Abort) the operation has none of. Not reached from the window, which offers only the steps each has.' }),
  notConflicted: msg({ id: 'service.gitOperation.notConflicted', defaultMessage: "{file} isn't in conflict any more: nothing was done. Look again.", description: 'HI-3470: an error from the panel: the conflicted file the user settled ({file}, a path in the repository) was settled meanwhile (in a terminal, say).' }),
  unresolved: msg({ id: 'service.gitOperation.unresolved', defaultMessage: '{count, plural, one {# file is} other {# files are}} still in conflict: settle {count, plural, one {it} other {them}} first.', description: 'HI-3470: an error from the panel (and the reason Continue is greyed out): files still in conflict.' }),
  agentBusy: msg({ id: 'service.gitOperation.agentBusy', defaultMessage: '{agent} is working in {folder}: nothing was done. Try again once it has finished.', description: 'HI-3470: an error from the panel: an agent ({agent}) works in the folder ({folder}, a path).' }),
  busy: msg({ id: 'service.gitOperation.busy', defaultMessage: 'A run or an agent is working in {folder} ({what}): nothing was done. Try again once it has finished.', description: "HI-3470: an error from the panel: a run (a test, a build) or an agent's file lock is in the folder ({folder}, a path); {what} names the first one's folder or file." }),
  failed: msg({ id: 'service.gitOperation.failed', defaultMessage: 'Git refused: {why}', description: "HI-3470: an error from the panel: git's own command failed; {why} is git's error line, in English." }),
  moved: msg({ id: 'service.gitOperation.moved', defaultMessage: 'Git has moved on in {folder} since you looked (to another commit of the {what}, or a new one began): nothing was done. Look again.', description: "HI-3470 (a reviewer's round 1): an error from the panel: the operation is still of the same kind ({what}, git's word for it: keep it as it is) but git is no longer stopped where the user saw it (a terminal went on, or it was ended and another begun); {folder} is a path. Nothing was done." }),
  timedOut: msg({ id: 'service.gitOperation.timedOut', defaultMessage: 'Git was still running after {seconds, number} seconds, so Combwork ended it. Look at {folder} before you try again: a hook may have done part of its work.', description: "HI-3470: an error from the panel: git's step (a Continue running the repository's commit hooks, say) ran past Settings → Advanced's longest commit time ({seconds}) and was ended; {folder} is a path." })
}
const M = OPERATION_TEXT

/** What the folder fence says while a step runs (the queue's log and its starts' wait). */
const FENCE = 'the user settling a git operation' // i18n-ignore: the fence's name, in the log

/** Git never waits on an editor nobody sees: its prepared message is taken as it is. */
const stepEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' })

/** A small file of git's, trimmed; null when it isn't there. */
async function gitFile(dir: string, ...parts: string[]): Promise<string | null> {
  try {
    return (await readFile(join(dir, ...parts), 'utf8')).trim()
  } catch {
    return null
  }
}

/** The files git lists as unmerged in a folder, with whether each side has them (index stages 2 and 3). */
export async function conflictsIn(folder: string, what: GitOperationName): Promise<GitConflict[]> {
  const r = await git(folder, ['ls-files', '-u', '-z'])
  if (!r.ok) throw combworkError(M.failed, { why: gitErrorLine(r.err) || r.err.trim().slice(0, 400) })
  const stages = new Map<string, Set<string>>()
  for (const row of r.out.split('\0')) {
    // `<mode> <object> <stage>\t<path>`
    const tab = row.indexOf('\t')
    if (tab < 0) continue
    const stage = row.slice(0, tab).split(' ')[2]
    const path = row.slice(tab + 1)
    if (!stages.has(path)) stages.set(path, new Set())
    stages.get(path)!.add(stage)
  }
  const swap = mineIsTheirs(what)
  return [...stages].map(([path, s]) => ({ path, mine: s.has(swap ? '3' : '2'), theirs: s.has(swap ? '2' : '3') })).sort((a, b) => a.path.localeCompare(b.path))
}

/** The commit an operation stopped at, from git's own files in the folder's git dir. */
async function stoppedAt(dir: string, what: GitOperationName): Promise<string | null> {
  switch (what) {
    case 'merge':
      return gitFile(dir, 'MERGE_HEAD').then((t) => t?.split(/\s/)[0] ?? null)
    case 'rebase':
      return (await gitFile(dir, 'rebase-merge', 'stopped-sha')) ?? (await gitFile(dir, 'REBASE_HEAD'))
    case 'cherry-pick':
      return gitFile(dir, 'CHERRY_PICK_HEAD')
    case 'revert':
      return gitFile(dir, 'REVERT_HEAD')
    default:
      return null
  }
}

/** A rebase's or am's place in its list: git's own counters. */
async function stepOf(dir: string, what: GitOperationName): Promise<{ at: number; of: number } | null> {
  const pair = async (sub: string, at: string, of: string): Promise<{ at: number; of: number } | null> => {
    const [a, o] = [Number(await gitFile(dir, sub, at)), Number(await gitFile(dir, sub, of))]
    return Number.isInteger(a) && Number.isInteger(o) && o > 0 && a > 0 ? { at: Math.min(a, o), of: o } : null
  }
  if (what === 'rebase') return (await pair('rebase-merge', 'msgnum', 'end')) ?? (await pair('rebase-apply', 'next', 'last'))
  if (what === 'am') return pair('rebase-apply', 'next', 'last')
  return null
}

/**
 * HR1's round 1: which stop of the operation git is at, to tell the one the user saw from another of the same kind:
 * its kind, HEAD, the commit it stopped at, its step and its sequencer's next command. Git moves at least one of them
 * when it goes on (a commit made, the next one picked) or another begins.
 */
async function stopId(folder: string, dir: string, what: GitOperationName, commit: string | null, step: { at: number; of: number } | null): Promise<string> {
  const head = await git(folder, ['rev-parse', '--verify', '-q', 'HEAD'])
  const next = (await gitFile(dir, 'sequencer', 'todo'))?.split(/\r?\n/)[0] ?? ''
  return [what, head.ok ? head.out.trim() : '', commit ?? '', step ? `${step.at}/${step.of}` : '', next].join('|')
}

/** HI-3470: the operation under way in a folder, with its conflicted files; null with none. */
export async function operationState(folder: string): Promise<GitOperationState | null> {
  const what = operationSync(folder)
  const dir = what ? gitDirSync(folder) : null
  if (!what || !dir) return null
  const [conflicts, commit, step] = await Promise.all([conflictsIn(folder, what), stoppedAt(dir, what), stepOf(dir, what)])
  const id = await stopId(folder, dir, what, commit, step)
  let at: GitOperationState['at']
  if (commit && /^[0-9a-f]{40,64}$/.test(commit)) {
    const r = await git(folder, ['log', '-1', '--format=%h%x00%s', commit, '--'])
    const [short, subject] = r.ok ? r.out.trim().split('\0') : []
    if (short) at = { commit: short, subject: subject ?? '' }
  }
  return { what, id, conflicts, ...(at ? { at } : {}), ...(step ? { step } : {}) }
}

/** The git command (its arguments) a step runs. */
export function stepArgs(what: GitOperationName, step: 'continue' | 'skip' | 'abort'): string[] {
  if (what === 'bisect') return ['bisect', 'reset']
  return [what, `--${step}`]
}

/** The git commands that settle a conflicted file, in order. */
export function pickArgs(what: GitOperationName, c: GitConflict, pick: ConflictPick): string[][] {
  if (pick === 'resolved') return [['add', '-A', '--', c.path]]
  const has = pick === 'mine' ? c.mine : c.theirs
  if (!has) return [['rm', '-q', '--', c.path]]
  const ours = (pick === 'mine') !== mineIsTheirs(what)
  return [
    ['checkout', ours ? '--ours' : '--theirs', '--', c.path],
    ['add', '--', c.path]
  ]
}

/**
 * HI-3470: a step of the operation under way in `folder` (the project's, or a worktree of its repository: the caller
 * checked which), or a conflicted file settled, as `req` asks. Under the repository lock and the folder's fence: the
 * operation still `req.what`, at the stop `req.id` names, nothing of Combwork's or an agent's working there, then `guard` (refusing by throwing).
 * Answers git's own output, trimmed; throws the refusal or git's error, in the window's words.
 */
export async function operationStep(projectPath: string, folder: string, req: OperationRequest, guard?: () => Promise<void> | void): Promise<string> {
  if ('step' in req && !OPERATION_STEPS[req.what].includes(req.step)) throw combworkError(M.notStep, undefined, { kind: 'invalid' })
  return withRepoLock(
    projectPath,
    () =>
      changingFolder(folder, FENCE, async () => {
        if (operationSync(folder) !== req.what) throw combworkError(M.changed, { was: req.what === 'cherry-pick' ? 'cherryPick' : req.what, folder })
        // The same kind, but is it the stop the user saw? (HR1's round 1: a terminal went on, or another began.)
        const dir = gitDirSync(folder)
        if (!dir || (await stopId(folder, dir, req.what, await stoppedAt(dir, req.what), await stepOf(dir, req.what))) !== req.id) throw combworkError(M.moved, { what: req.what, folder })
        const { folderBuilders } = await import('../../workflow/queueHost')
        const held = folderBuilders(workspace, folder)
        if (held) throw combworkError(M.busy, { folder, what: held[0] })
        const agent = await busyAgentIn(projectPath, folder)
        if (agent) throw combworkError(M.agentBusy, { agent, folder })
        await guard?.()
        const run = async (args: string[]): Promise<string> => {
          log.info(`The user's ${userText(args.join(' '))} in ${userText(folder)}`)
          // A Continue or Skip commits, running the repository's hooks: Commit's own bound (Settings → Advanced,
          // `cw.git.commitMinutes`, HR1's round 1), never one of its own.
          const r = await git(folder, args, undefined, undefined, { env: stepEnv(), timeout: platformLimits.gitCommitMs() })
          if (r.timedOut) {
            log.warn(`git ${userText(args[0] ?? '')} in ${userText(folder)} ran past its bound and was ended`)
            throw combworkError(M.timedOut, { seconds: Math.round(platformLimits.gitCommitMs() / 1000), folder })
          }
          if (!r.ok) {
            log.info(`git ${userText(args[0] ?? '')} in ${userText(folder)} failed: ${userText(gitErrorLine(r.err))}`)
            throw combworkError(M.failed, { why: gitErrorLine(`${r.err}\n${r.out}`) || r.err.trim().slice(0, 400) || r.out.trim().slice(0, 400) })
          }
          return `${r.out}\n${r.err}`.trim()
        }
        if ('step' in req) {
          if (req.step === 'continue') {
            const left = await conflictsIn(folder, req.what)
            if (left.length) throw combworkError(M.unresolved, { count: left.length })
          }
          return run(stepArgs(req.what, req.step))
        }
        const c = (await conflictsIn(folder, req.what)).find((x) => x.path === req.file)
        if (!c) throw combworkError(M.notConflicted, { file: req.file })
        let out = ''
        for (const args of pickArgs(req.what, c, req.pick)) out = await run(args)
        return out
      }),
    { project: projectPath }
  )
}
