// HI-3470: a git operation left under way in a folder (the project folder, a slot, an agent's worktree), read and acted
// on from Changes' panel: Continue, Skip or Abort (a bisect: End bisect, `git bisect reset`), and each conflicted file
// settled with its own side, the other side, or as it is now. Every step is the user's click, never Combwork's own, and
// is checked again under the repository lock and the folder's fence before git runs, as Commit and Set aside are
// (gitFolderChanges.ts assertQuiet): the operation still the one the user saw, no Combwork run or agent's lock in the
// folder (folderBuilders), no agent working there (busyAgentIn), then the caller's guard (a slot's own: its pool's hold
// and quiet check, operationPanel.ts). Git does the work; a step that fails says git's own error.
import { readFile } from 'original-fs/promises'
import { createHash } from 'crypto'
import { join } from 'path'
import { mineIsTheirs, OPERATION_STEPS, type ConflictPick, type GitConflict, type GitOperationName, type GitOperationState, type OperationRequest, type OperationStepResult, type PanelKind } from '../../../shared/gitOperations'
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
  unreadable: msg({ id: 'service.gitOperation.unreadable', defaultMessage: "Combwork can't read where git stopped in {folder}, so it can't tell it's still where you saw it: nothing was done. Finish it in a terminal there.", description: "HI-3470 (a reviewer's round 2): an error from the panel: git's files that say where the operation stopped (in the folder's git dir) are missing or can't be read, so Combwork refuses any step; {folder} is a path." }),
  timedOut: msg({ id: 'service.gitOperation.timedOut', defaultMessage: 'Git was still running after {seconds, number} seconds, so Combwork ended it. Look at {folder} before you try again: a hook may have done part of its work.', description: "HI-3470: an error from the panel: git's step (a Continue running the repository's commit hooks, say) ran past Settings → Advanced's longest commit time ({seconds}) and was ended; {folder} is a path." }),
  fileChanged: msg({ id: 'service.gitOperation.fileChanged', defaultMessage: "{file}'s conflict changed since you looked: nothing was done. Look again.", description: "HI-3518 (a reviewer's round 1): an error from the unfinished git operation panel: the conflicted file the user settled ({file}, a path in the repository) is still in conflict, but not the conflict they saw (it was settled in a terminal and another took its place). Nothing was done." }),
  leftChanged: msg({ id: 'service.gitOperation.leftChanged', defaultMessage: '{folder} changed since you looked (a commit, or a git operation began): nothing was done. Look again.', description: "HI-3518: an error from the panel showing files left in conflict with no git operation under way (after a stash's Apply, say): since the user looked, HEAD moved or a git operation (a merge, a rebase…) began in the folder ({folder}, a path). Nothing was done." })
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
export async function conflictsIn(folder: string, what: PanelKind): Promise<GitConflict[]> {
  const r = await git(folder, ['ls-files', '-u', '-z'])
  if (!r.ok) throw combworkError(M.failed, { why: gitErrorLine(r.err) || r.err.trim().slice(0, 400) })
  /** Each path's stages: stage → its object, and whether it is a gitlink (a submodule's commit, mode 160000). */
  const stages = new Map<string, Map<string, { object: string; link: boolean }>>()
  /** HI-3518 (HR1's round 1): each path's unmerged entries as git lists them, for the conflict's fingerprint. */
  const rows = new Map<string, string[]>()
  for (const row of r.out.split('\0')) {
    // `<mode> <object> <stage>\t<path>`
    const tab = row.indexOf('\t')
    if (tab < 0) continue
    const [mode, object, stage] = row.slice(0, tab).split(' ')
    const path = row.slice(tab + 1)
    if (!stages.has(path)) stages.set(path, new Map())
    stages.get(path)!.set(stage, { object, link: mode === '160000' })
    rows.set(path, [...(rows.get(path) ?? []), row.slice(0, tab)])
  }
  const swap = mineIsTheirs(what)
  return [...stages]
    .map(([path, s]): GitConflict => {
      const [mine, theirs] = [s.get(swap ? '3' : '2'), s.get(swap ? '2' : '3')]
      // HI-3502: a side that is a submodule, by its commit (pickArgs stages it: git's checkout never moves one).
      const link = { ...(mine?.link ? { mine: mine.object } : {}), ...(theirs?.link ? { theirs: theirs.object } : {}) }
      const seen = createHash('sha256').update((rows.get(path) ?? []).sort().join('\n')).digest('hex').slice(0, 16)
      return { path, mine: !!mine, theirs: !!theirs, stages: seen, ...(link.mine || link.theirs ? { submodule: link } : {}) }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
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
 * HR1's rounds 1 and 2: git's own files that say where each operation is, in its git dir: hashed into the stop's id, so
 * one of the same kind at another stop, or another of the same kind begun at the same HEAD (an am of another patch), has
 * another id. `needs`: the files that must be read for the id to say anything (one group, all of it); `{patch}` is an am's
 * or an apply-rebase's current numbered patch (`rebase-apply/0001`…, by its `next`).
 */
const STOP_FILES: Record<GitOperationName, { files: string[]; needs: string[][] }> = {
  merge: { files: ['MERGE_HEAD', 'MERGE_MODE'], needs: [['MERGE_HEAD']] },
  rebase: {
    files: ['rebase-merge/head-name', 'rebase-merge/onto', 'rebase-merge/orig-head', 'rebase-merge/done', 'rebase-merge/git-rebase-todo', 'rebase-merge/msgnum', 'rebase-merge/end', 'rebase-merge/stopped-sha', 'rebase-apply/head-name', 'rebase-apply/onto', 'rebase-apply/orig-head', 'rebase-apply/next', 'rebase-apply/last', 'rebase-apply/original-commit', '{patch}'],
    needs: [['rebase-merge/done'], ['rebase-merge/msgnum'], ['rebase-apply/next', '{patch}']]
  },
  am: { files: ['rebase-apply/next', 'rebase-apply/last', '{patch}', 'rebase-apply/patch', 'rebase-apply/info', 'rebase-apply/msg', 'rebase-apply/final-commit', 'rebase-apply/original-commit', 'rebase-apply/orig-head', 'rebase-apply/abort-safety'], needs: [['rebase-apply/next', '{patch}']] },
  'cherry-pick': { files: ['CHERRY_PICK_HEAD', 'sequencer/head', 'sequencer/todo', 'sequencer/abort-safety'], needs: [['CHERRY_PICK_HEAD'], ['sequencer/todo']] },
  revert: { files: ['REVERT_HEAD', 'sequencer/head', 'sequencer/todo', 'sequencer/abort-safety'], needs: [['REVERT_HEAD'], ['sequencer/todo']] },
  bisect: { files: ['BISECT_LOG', 'BISECT_START', 'BISECT_EXPECTED_REV', 'BISECT_TERMS'], needs: [['BISECT_LOG']] }
}

/** A git file's bytes; null when it isn't there or can't be read. */
async function gitBytes(dir: string, rel: string): Promise<Buffer | null> {
  try {
    return await readFile(join(dir, ...rel.split('/')))
  } catch {
    return null
  }
}

/**
 * HR1's rounds 1 and 2: which stop of the operation git is at, to tell the one the user saw from another: its kind, HEAD
 * and a hash of its files (STOP_FILES). Null when the files that say where it is can't be read: no step is taken then.
 */
export async function stopId(folder: string, dir: string, what: GitOperationName): Promise<string | null> {
  const spec = STOP_FILES[what]
  const next = Number(await gitFile(dir, 'rebase-apply', 'next'))
  const patch = Number.isInteger(next) && next > 0 ? `rebase-apply/${String(next).padStart(4, '0')}` : null
  const read = new Map<string, Buffer | null>()
  for (const f of spec.files) {
    const rel = f === '{patch}' ? patch : f
    read.set(f, rel ? await gitBytes(dir, rel) : null)
  }
  if (!spec.needs.some((group) => group.every((f) => read.get(f)))) return null
  const head = await git(folder, ['rev-parse', '--verify', '-q', 'HEAD'])
  const hash = createHash('sha256')
  for (const [f, b] of read) {
    hash.update(`${f}\0${b ? b.length : -1}\0`)
    if (b) hash.update(b)
  }
  return [what, head.ok ? head.out.trim() : '', hash.digest('hex')].join('|')
}

/** HI-3470: the operation under way in a folder, with its conflicted files; null with none. */
export async function operationState(folder: string): Promise<GitOperationState | null> {
  const what = operationSync(folder)
  const dir = gitDirSync(folder)
  if (!dir) return null
  if (!what) return leftConflicts(folder)
  const [conflicts, commit, step, id] = await Promise.all([conflictsIn(folder, what), stoppedAt(dir, what), stepOf(dir, what), stopId(folder, dir, what)])
  let at: GitOperationState['at']
  if (commit && /^[0-9a-f]{40,64}$/.test(commit)) {
    const r = await git(folder, ['log', '-1', '--format=%h%x00%s', commit, '--'])
    const [short, subject] = r.ok ? r.out.trim().split('\0') : []
    if (short) at = { commit: short, subject: subject ?? '' }
  }
  return { what, id, conflicts, ...(at ? { at } : {}), ...(step ? { step } : {}) }
}

/**
 * HI-3518: files left in conflict with no operation under way (a stash's Apply or Pop that conflicted, or a terminal's),
 * as the panel shows them; null with none. Their stop is HEAD: a commit, or an operation begun, since the user looked
 * refuses a click (leftId); a file settled meanwhile is refused by its own pick.
 */
async function leftConflicts(folder: string): Promise<GitOperationState | null> {
  const conflicts = await conflictsIn(folder, 'conflicts')
  if (!conflicts.length) return null
  return { what: 'conflicts', id: await leftId(folder), conflicts }
}

/**
 * HI-3518: the stop of files left in conflict: HEAD, when no operation is under way. Null (HR1's round 1) when HEAD can't
 * be read: the panel then takes no step, as with an operation's unreadable stop.
 */
async function leftId(folder: string): Promise<string | null> {
  const head = await git(folder, ['rev-parse', '--verify', '-q', 'HEAD'])
  const sha = head.ok ? head.out.trim() : ''
  return /^[0-9a-f]{40,64}$/.test(sha) ? `conflicts|${sha}` : null
}

/** The git command (its arguments) a step runs. */
export function stepArgs(what: GitOperationName, step: 'continue' | 'skip' | 'abort'): string[] {
  if (what === 'bisect') return ['bisect', 'reset']
  return [what, `--${step}`]
}

/**
 * The git commands that settle a conflicted file, in order. HI-3501: each takes its path literally
 * (`--literal-pathspecs`), so `a[1].txt` never also settles, stages or deletes `a1.txt` as a glob would.
 */
export function pickArgs(what: PanelKind, c: GitConflict, pick: ConflictPick): string[][] {
  const literal = (args: string[]): string[] => ['--literal-pathspecs', ...args, '--', c.path]
  if (pick === 'resolved') return [literal(['add', '-A'])]
  const has = pick === 'mine' ? c.mine : c.theirs
  if (!has) return [literal(['rm', '-q'])]
  // HI-3502: a submodule's side is its commit staged, whatever its folder has checked out: `checkout --theirs` leaves a
  // submodule as it is, so `add` would stage the folder's own commit, the other side. update-index takes a path as it is.
  const link = c.submodule?.[pick]
  if (link) return [['update-index', '--cacheinfo', '160000', link, c.path]]
  const ours = (pick === 'mine') !== mineIsTheirs(what)
  return [literal(['checkout', ours ? '--ours' : '--theirs']), literal(['add'])]
}

/**
 * HI-3470: a step of the operation under way in `folder` (the project's, or a worktree of its repository: the caller
 * checked which), or a conflicted file settled, as `req` asks. Under the repository lock and the folder's fence: the
 * operation still `req.what`, at the stop `req.id` names, nothing of Combwork's or an agent's working there, then `guard` (refusing by throwing).
 * Answers git's own output, trimmed, and whether a Continue or Skip went on and stopped again (HI-3503); throws the
 * refusal or git's error, in the window's words.
 */
export async function operationStep(projectPath: string, folder: string, req: OperationRequest, guard?: () => Promise<void> | void): Promise<OperationStepResult> {
  // HI-3518: files left in conflict have no step, only their files' picks.
  if ('step' in req && (req.what === 'conflicts' || !OPERATION_STEPS[req.what].includes(req.step))) throw combworkError(M.notStep, undefined, { kind: 'invalid' })
  return withRepoLock(
    projectPath,
    () =>
      changingFolder(folder, FENCE, async () => {
        const what = req.what
        if (what === 'conflicts') {
          // HI-3518: still no operation under way, at the HEAD the user saw (a file settled meanwhile: its pick's own refusal).
          if (operationSync(folder)) throw combworkError(M.leftChanged, { folder })
          const now = await leftId(folder)
          if (now === null) throw combworkError(M.unreadable, { folder })
          if (now !== req.id) throw combworkError(M.leftChanged, { folder })
        } else {
          if (operationSync(folder) !== what) throw combworkError(M.changed, { was: what === 'cherry-pick' ? 'cherryPick' : what, folder })
          // The same kind, but is it the stop the user saw? (HR1's round 1: a terminal went on, or another began.)
          const dir = gitDirSync(folder)
          const now = dir ? await stopId(folder, dir, what) : null
          if (now === null) throw combworkError(M.unreadable, { folder })
          if (now !== req.id) throw combworkError(M.moved, { what, folder })
        }
        const { folderBuilders } = await import('../../workflow/queueHost')
        const held = folderBuilders(workspace, folder)
        if (held) throw combworkError(M.busy, { folder, what: held[0] })
        const agent = await busyAgentIn(projectPath, folder)
        if (agent) throw combworkError(M.agentBusy, { agent, folder })
        await guard?.()
        /** `wentOn`: for a Continue or Skip, whether git went on to another stop though it exited non-zero (HI-3503). */
        const run = async (args: string[], wentOn?: () => Promise<boolean>): Promise<OperationStepResult> => {
          const name = args.find((x) => !x.startsWith('--')) ?? '' // the command, past --literal-pathspecs
          log.info(`The user's ${userText(args.join(' '))} in ${userText(folder)}`)
          // A Continue or Skip commits, running the repository's hooks: Commit's own bound (Settings → Advanced,
          // `cw.git.commitMinutes`, HR1's round 1), never one of its own.
          const r = await git(folder, args, undefined, undefined, { env: stepEnv(), timeout: platformLimits.gitCommitMs() })
          if (r.timedOut) {
            log.warn(`git ${userText(name)} in ${userText(folder)} ran past its bound and was ended`)
            throw combworkError(M.timedOut, { seconds: Math.round(platformLimits.gitCommitMs() / 1000), folder })
          }
          const output = `${r.out}\n${r.err}`.trim()
          if (!r.ok && wentOn && (await wentOn())) {
            log.info(`git ${userText(name)} in ${userText(folder)} went on and stopped again: ${userText(gitErrorLine(r.err))}`)
            return { output, stoppedAgain: true }
          }
          if (!r.ok) {
            log.info(`git ${userText(name)} in ${userText(folder)} failed: ${userText(gitErrorLine(r.err))}`)
            throw combworkError(M.failed, { why: gitErrorLine(`${r.err}\n${r.out}`) || r.err.trim().slice(0, 400) || r.out.trim().slice(0, 400) })
          }
          return { output }
        }
        if ('step' in req) {
          // Refused above for files left in conflict (HI-3518): a step is always an operation's.
          if (what === 'conflicts') throw combworkError(M.notStep, undefined, { kind: 'invalid' })
          if (req.step === 'continue') {
            const left = await conflictsIn(folder, what)
            if (left.length) throw combworkError(M.unresolved, { count: left.length })
          }
          // HI-3503: a Continue or Skip that commits its step and then stops at the next conflict exits non-zero: the
          // same operation, at another stop than the one the user acted on, is git having gone on, not a refusal. A
          // step git refused leaves the stop as it was.
          const wentOn = async (): Promise<boolean> => {
            if (req.step === 'abort' || operationSync(folder) !== what) return false
            const after = gitDirSync(folder)
            const id = after ? await stopId(folder, after, what) : null
            return id !== null && id !== req.id
          }
          return run(stepArgs(what, req.step), wentOn)
        }
        const c = (await conflictsIn(folder, what)).find((x) => x.path === req.file)
        if (!c) throw combworkError(M.notConflicted, { file: req.file })
        // HR1's round 1: the conflict the user saw, entry for entry (another one in its place at the same stop refuses;
        // other files' picks meanwhile don't). Files left in conflict always name it: their stop is only HEAD.
        if (req.seen !== undefined ? req.seen !== c.stages : what === 'conflicts') throw combworkError(M.fileChanged, { file: req.file })
        let out: OperationStepResult = { output: '' }
        for (const args of pickArgs(req.what, c, req.pick)) out = await run(args)
        return out
      }),
    { project: projectPath }
  )
}
