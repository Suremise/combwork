import { dirname, join } from 'path'
import { readdir, writeFile } from 'original-fs/promises'
import { existsSync } from 'original-fs'
import { HIVE_DIR } from '../shared/defaults'
import { msg } from '../shared/i18n'
import { capitalised, englishText, listOf, shownText, withValues, type Text, type TextPart } from '../shared/advanced'
import { FIRST_COMMIT_MESSAGE, gitignoreNameText, gitignoreText, isGitignoreChoice, type GitInitCheck, type GitInitOptions } from '../shared/gitInit'
import { identityProblemData, type GitIdentityPart } from '../shared/gitRepo'
import { gitProblemData } from '../shared/gitTool'
import { samePlace } from './fsutil'
import { git, type GitResult } from './git'
import { gitSaid, oneAtATime, parseIdentity } from './gitRepo'
import { gitTool } from './gitTool'
import { HiveError, errorText, hiveError } from './hiveError'
import { ensureHiveExcluded, otherVcsOf, vcsOf } from './hiveVcs'
import { createLogger, userText } from './logger'
import { excludeCopies } from './providers/common'
import { workspace, workspaceOf } from './workspace'

const log = createLogger('gitInit')

/**
 * Initialise repository (#701): makes a project folder that isn't a git repository one, from its Git tab. In order:
 * `git init -b main`; the project's .hive (and Hive's copies of skills) added to `.git/info/exclude` and git asked
 * whether it ignores .hive, before anything is staged, so .hive can never be in the first commit (#345); the starter
 * .gitignore the user chose (never over one the folder has); the identity asked for, saved to this repository's config
 * only; everything staged and committed (an empty commit for an empty folder); then the workspace refreshed, so worktrees
 * work at once. Refused where another version control system keeps the folder, and inside another repository's working
 * tree unless the user confirmed it. There is no undo: what it did, and where it stopped, is said in full. A repository
 * with no commits yet (one that stopped short, say for an identity only the new repository could tell was missing, or one
 * made with `git init` by hand) can be taken on from there: everything but `git init`, with its identity read from it.
 */

const IDENTITY = '^user\\.(name|email)$'

/**
 * The identity a new repository in the folder is sure to have: the system config, then the global one over it, with the
 * files they include (`--includes`: a scoped query leaves them out by default), read as if no repository held the folder
 * (`GIT_CEILING_DIRECTORIES` above it), so neither an outer repository's own config nor a conditional include that
 * matches only it counts. And whether either has conditional includes (`includeIf`), which may add to it for the new
 * repository: only the repository itself can say, once it exists.
 */
async function outsideIdentity(cwd: string): Promise<{ identity: GitIdentityPart; conditional: boolean }> {
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(cwd) }
  const read = (scope: string, re: string): Promise<GitResult> => git(cwd, ['config', scope, '--includes', '--get-regexp', re], undefined, undefined, { env })
  const [system, global, sysIf, globalIf] = await Promise.all([read('--system', IDENTITY), read('--global', IDENTITY), read('--system', '^includeif\\.'), read('--global', '^includeif\\.')])
  return { identity: { ...parseIdentity(system), ...parseIdentity(global) }, conditional: [sysIf, globalIf].some((r) => r.ok && !!r.out.trim()) }
}

/** The identity git commits as in the new repository: every config it reads, conditional includes resolved for it. */
async function repoIdentity(projectPath: string): Promise<GitIdentityPart> {
  return parseIdentity(await git(projectPath, ['config', '--get-regexp', IDENTITY]))
}

/** Whether the folder holds nothing but .hive (an empty first commit). */
async function isEmpty(projectPath: string): Promise<boolean> {
  const names = await readdir(projectPath).catch(() => [] as string[])
  return names.every((n) => n === HIVE_DIR || n === '.git')
}

/** What the Initialise dialog needs: whether it can be done here, the repository around the folder, the identity, the folder's .gitignore. */
export async function initCheck(projectPath: string): Promise<GitInitCheck> {
  projectPath = workspace.assertProject(projectPath)
  const base = { identity: {}, hasGitignore: existsSync(join(projectPath, '.gitignore')), empty: await isEmpty(projectPath) }
  // Refused: its English for the log and the error initRepo throws (#881), its text for the window.
  const refuse = (text: Text): GitInitCheck => ({ ...base, refused: englishText(text), refusedText: text })
  const problem = gitProblemData(gitTool())
  if (problem) return refuse(withValues(msg({ id: 'main.gitInit.noGit', defaultMessage: '{problem}: Provider Setup says how to fix it.', description: "Why a folder can't be made a git repository (the Initialise Git Repository dialog): git is missing or broken. {problem} says what's wrong. Provider Setup is a view's name." }), { problem }))
  // Looked for at every level whatever git is there: a colocated Jujutsu repository has .git beside .jj.
  const other = otherVcsOf(projectPath)
  if (other) return refuse(withValues(msg({ id: 'main.gitInit.otherVcs', defaultMessage: '{vcs} keeps this folder (in {root}): Hive makes a git repository only where no other version control system is.', description: "Why a folder can't be made a git repository: another version control system (Jujutsu, Mercurial…), {vcs}, keeps it. {root} is the folder it keeps." }), { vcs: other.name, root: other.root }))
  const found = vcsOf(projectPath)
  if (found && samePlace(found.root, projectPath)) {
    const head = await git(projectPath, ['rev-parse', '-q', '--verify', 'HEAD'])
    if (head.ok) return refuse(msg({ id: 'main.gitInit.already', defaultMessage: 'This folder is a git repository already.', description: "Why a folder can't be made a git repository again." }))
    if (head.code !== 1) return refuse(withValues(msg({ id: 'main.gitInit.unreadable', defaultMessage: "Git couldn't read this repository: {why}", description: "Why a folder can't be made a git repository. {why} is git's own message." }), { why: gitProblemData(gitTool()) ?? gitSaid(head) }))
    // No commit yet: taken on from there, its identity read from it (what it will commit as, exactly).
    return { ...base, refused: null, resume: true, identity: await repoIdentity(projectPath) }
  }
  const { identity, conditional } = await outsideIdentity(projectPath)
  return { ...base, refused: null, identity, ...(conditional ? { conditionalIdentity: true } : {}), ...(found ? { parentRepo: found.root } : {}) }
}

/** Initialises the project folder as a git repository with a first commit; replies with what it did, in a sentence or two. */
export async function initRepo(projectPath: string, opts: GitInitOptions): Promise<string> {
  projectPath = workspace.assertProject(projectPath)
  const choice = opts?.gitignore ?? 'none'
  if (!isGitignoreChoice(choice)) throw new Error(`There's no starter .gitignore ${String(choice)}.`) // i18n-ignore: a programming error, the dialog offers only these
  const name = typeof opts.name === 'string' ? opts.name.trim() : ''
  const email = typeof opts.email === 'string' ? opts.email.trim() : ''
  // Refusals are HiveErrors (#881): their English in the log, the window's language in the dialog.
  const problem = identityProblemData(name, email)
  if (problem) throw new HiveError(problem)
  return oneAtATime(projectPath, async () => {
    // Checked again here: the folder may have changed since the dialog asked.
    const check = await initCheck(projectPath)
    if (check.refusedText) throw new HiveError(check.refusedText)
    if (check.parentRepo && opts.nested !== true) throw hiveError(msg({ id: 'main.gitInit.nested', defaultMessage: 'This folder is inside the git repository in {root}. Confirm that you want a repository of its own inside it.', description: "Why a folder wasn't made a git repository yet: it is inside another one, {root}, and the user didn't confirm a repository of its own." }), { root: check.parentRepo })
    // With conditional includes, only the new repository knows its identity: checked once it exists, below.
    if (!check.conditionalIdentity && !check.identity.name && !name) throw hiveError(msg({ id: 'main.gitInit.noName', defaultMessage: 'Git has no name to make the first commit as: enter one.', description: 'Why a folder was not made a git repository: no name to commit as is set, and the user entered none.' }))
    if (!check.conditionalIdentity && !check.identity.email && !email) throw hiveError(msg({ id: 'main.gitInit.noEmail', defaultMessage: 'Git has no email to make the first commit as: enter one.', description: 'Why a folder was not made a git repository: no email address to commit as is set, and the user entered none.' }))

    // Each step that worked, so a failure says plainly where it stopped (there's no undo): clauses, the first
    // capitalised where they start a sentence.
    const done: Text[] = []
    // At most four (initialise, identity, .gitignore, commit), joined as the language joins a list.
    const steps = (): Text => capitalised(listOf(done))
    const stop = (what: Text, why: TextPart): HiveError =>
      new HiveError(
        done.length
          ? withValues(msg({ id: 'main.gitInit.stoppedAfter', defaultMessage: '{done}, but {what}: {why}', description: "Why making a git repository stopped part way. {done} lists the steps that worked (main.gitInit.step.*), {what} what failed (main.gitInit.failed.*), {why} why (git's message, or what to do)." }), { done: steps(), what, why })
          : withValues(msg({ id: 'main.gitInit.stopped', defaultMessage: '{what}: {why}', description: 'Why making a git repository failed at its first step. {what} is what failed (main.gitInit.failed.*, which starts with a small letter in English), {why} why.' }), { what, why })
      )

    if (!check.resume) {
      const init = await git(projectPath, ['init', '-q', '-b', 'main'])
      if (!init.ok) throw stop(msg({ id: 'main.gitInit.failed.init', defaultMessage: "couldn't initialise the repository", description: 'What failed in making a git repository, a clause (main.gitInit.stoppedAfter).' }), gitProblemData(gitTool()) ?? gitSaid(init))
      done.push(msg({ id: 'main.gitInit.step.init', defaultMessage: 'initialised a git repository on main', description: 'A step that worked in making a git repository: a clause in a list of them ("Initialised a git repository on main, added a Node .gitignore and committed 3 files."); Hive capitalises the first of the list. main is the branch\'s name: keep it.' }))
      log.info(`Initialised a git repository in ${userText(projectPath)}`)
    }

    // Before anything is staged: .hive is never in the first commit, whatever the folder's .gitignore says.
    let ex: Awaited<ReturnType<typeof ensureHiveExcluded>>
    try {
      ex = await ensureHiveExcluded(projectPath)
    } catch (e) {
      throw stop(msg({ id: 'main.gitInit.failed.exclude', defaultMessage: "couldn't keep .hive out of git", description: "What failed in making a git repository, a clause (main.gitInit.stoppedAfter). .hive is a folder's name." }), errorText(e))
    }
    if (!ex?.excluded)
      throw stop(
        msg({ id: 'main.gitInit.failed.ignored', defaultMessage: "git still doesn't ignore .hive here (a rule in a .gitignore may bring it back), so nothing was committed", description: 'What failed in making a git repository, a clause (main.gitInit.stoppedAfter). .hive and .gitignore are names.' }),
        msg({ id: 'main.gitInit.fix.ignored', defaultMessage: 'fix that, then choose Make first commit in the Version Control tab', description: 'What to do after .hive was found not ignored by git (main.gitInit.failed.ignored). Make first commit is a button in the Version Control tab (glossary 2.1): use its name as shown.' })
      )
    await excludeCopies(projectPath).catch((e) => log.warn('excluding skill copies after git init', e))

    // What the user entered fills only what git still lacks in the new repository (its config as git reads it there,
    // includes and conditional includes too), saved to this repository's own config, never the global one.
    const has = await repoIdentity(projectPath)
    let saved = false
    for (const [key, part, value] of [['user.name', 'name', name], ['user.email', 'email', email]] as const) {
      if (has[part] || !value) continue
      const r = await git(projectPath, ['config', '--local', key, value])
      if (!r.ok) throw stop(withValues(msg({ id: 'main.gitInit.failed.config', defaultMessage: "couldn't set {key}", description: 'What failed in making a git repository, a clause (main.gitInit.stoppedAfter). {key} is a git setting (user.name, user.email).' }), { key }), gitSaid(r))
      saved = true
    }
    if (saved) done.push(msg({ id: 'main.gitInit.step.identity', defaultMessage: "set this repository's commit identity", description: 'A step that worked in making a git repository: a clause in a list of them ("Initialised a git repository on main, added a Node .gitignore and committed 3 files."); Hive capitalises the first of the list: the name and email the commits are made as.' }))
    const now = saved ? await repoIdentity(projectPath) : has
    const lacking = (['name', 'email'] as const).filter((k) => !now[k])
    // Nothing else is written yet: the dialog asks for it, and taking the repository on from here finishes the job.
    if (lacking.length) {
      const which = lacking.length > 1 ? 'both' : lacking[0]
      throw stop(
        withValues(msg({ id: 'main.gitInit.failed.identity', defaultMessage: '{which, select, name {git has no name to make the first commit as here} email {git has no email to make the first commit as here} other {git has no name or email to make the first commit as here}}', description: 'What failed in making a git repository, a clause (main.gitInit.stoppedAfter): git has no identity to commit as. {which} says what it lacks.' }), { which }),
        withValues(msg({ id: 'main.gitInit.fix.identity', defaultMessage: '{which, select, name {enter it and choose Make first commit} email {enter it and choose Make first commit} other {enter them and choose Make first commit}}', description: 'What to do when git has no name or email to commit as (main.gitInit.failed.identity). Make first commit is a button: use its name as shown.' }), { which })
      )
    }

    const template = check.hasGitignore || existsSync(join(projectPath, '.gitignore')) ? null : gitignoreText(choice)
    if (template && choice !== 'none') {
      try {
        await writeFile(join(projectPath, '.gitignore'), template, { flag: 'wx' })
      } catch (e) {
        throw stop(msg({ id: 'main.gitInit.failed.gitignore', defaultMessage: "couldn't write the .gitignore", description: 'What failed in making a git repository, a clause (main.gitInit.stoppedAfter). .gitignore is a file name.' }), (e as NodeJS.ErrnoException).code ?? String(e))
      }
      done.push(withValues(msg({ id: 'main.gitInit.step.gitignore', defaultMessage: 'added {gitignore}', description: 'A step that worked in making a git repository: a clause in a list of them ("Initialised a git repository on main, added a Node .gitignore and committed 3 files."); Hive capitalises the first of the list. {gitignore} names the starter .gitignore (a Node .gitignore).' }), { gitignore: gitignoreNameText(choice) }))
    }

    const add = await git(projectPath, ['add', '-A', '--', '.'])
    if (!add.ok) throw stop(msg({ id: 'main.gitInit.failed.stage', defaultMessage: "couldn't stage the folder's files", description: 'What failed in making a git repository, a clause (main.gitInit.stoppedAfter).' }), gitSaid(add))
    // A last check that git's ignore did its job: nothing of .hive staged.
    const staged = await git(projectPath, ['diff', '--cached', '--name-only', '-z', '--', HIVE_DIR])
    if (!staged.ok || staged.out.replace(/\0/g, '')) {
      await git(projectPath, ['reset', '-q'])
      throw stop(
        msg({ id: 'main.gitInit.failed.staged', defaultMessage: '.hive was staged, so nothing was committed', description: "What failed in making a git repository, a clause (main.gitInit.stoppedAfter). .hive is a folder's name." }),
        msg({ id: 'main.gitInit.fix.staged', defaultMessage: 'check the .gitignore for a rule that brings .hive back', description: 'What to do after .hive was staged (main.gitInit.failed.staged).' })
      )
    }
    const files = await git(projectPath, ['diff', '--cached', '--name-only', '-z'])
    const count = files.ok ? files.out.split('\0').filter(Boolean).length : 0
    const commit = await git(projectPath, ['commit', '-q', '--allow-empty', '-m', FIRST_COMMIT_MESSAGE])
    if (!commit.ok)
      throw stop(
        msg({ id: 'main.gitInit.failed.commit', defaultMessage: "couldn't make the first commit", description: 'What failed in making a git repository, a clause (main.gitInit.stoppedAfter).' }),
        withValues(msg({ id: 'main.gitInit.fix.commit', defaultMessage: '{git}. Commit in a terminal, or ask an agent to', description: "Why the first commit failed and what to do. {git} is git's own message." }), { git: gitSaid(commit) })
      )
    done.push(
      count
        ? withValues(msg({ id: 'main.gitInit.step.commit', defaultMessage: '{n, plural, one {committed # file} other {committed # files}}', description: 'A step that worked in making a git repository: a clause in a list of them ("Initialised a git repository on main, added a Node .gitignore and committed 3 files."); Hive capitalises the first of the list. {n} is how many files the first commit has.' }), { n: count })
        : msg({ id: 'main.gitInit.step.empty', defaultMessage: 'made an empty first commit', description: 'A step that worked in making a git repository: a clause in a list of them ("Initialised a git repository on main, added a Node .gitignore and committed 3 files."); Hive capitalises the first of the list.' })
    )
    log.info(`Made the first commit in ${userText(projectPath)} (${count} files)`)

    await workspaceOf(projectPath)
      .refresh()
      .catch((e) => log.warn('refreshing after git init', e))
    return shownText(withValues(msg({ id: 'main.gitInit.done', defaultMessage: '{steps}. .hive stays out of git. Agents can work in worktrees now.', description: "What making a git repository did. {steps} lists the steps (main.gitInit.step.*), its first capitalised. .hive is a folder's name." }), { steps: steps() }))
  })
}
