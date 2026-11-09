import { lstat, mkdir, readFile, stat, writeFile } from 'original-fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'
import { appendIgnoreLines, exactIgnoreLine, extensionOf, extIgnoreLine, parseCheckIgnore, removableRule, removeIgnoreLine, type IgnoreRule, type IgnoreTarget } from '../shared/gitIgnoreRules'
import type { FileGitInfo, FileGitItem, FileGitDone, FileGitRuleText } from '../shared/types'
import { msg } from '../shared/i18n'
import { combworkError } from './combworkError'
import { insideReal, withFileLock } from './fsutil'
import { INDEX_BUSY, branchOfRef, git, gitErrorLine, gitReading } from './git'
import { decodeUtf8 } from './files'
import { createLogger, userText } from './logger'
import { workspace } from './workspace'

/**
 * The Files tab's Git menu (HI-2743): Exclude from git, Stop tracking, Include again and Why is this ignored?. They act on
 * the project folder only (the main checkout the Files tab shows), never on an agent's slot or worktree. Git runs on
 * git's worker thread (git()), and files are read and written asynchronously, so none of it waits on main's thread.
 */

const log = createLogger('files-git')

const M = {
  notRepo: msg({ id: 'service.filesGit.notRepo', defaultMessage: 'This project is not a git repository.', description: "An error from the Files tab's Git menu (HI-2743): the project folder isn't in a git repository." }),
  busy: msg({ id: 'service.filesGit.busy', defaultMessage: 'Another git command is using the repository. Try again in a moment.', description: "An error from the Files tab's Git menu: git's index is locked by another git command (an agent's commit, say)." }),
  failed: msg({ id: 'service.filesGit.failed', defaultMessage: 'Git could not do it: {why}', description: "An error from the Files tab's Git menu. {why} is git's own message (English)." }),
  notUtf8: msg({ id: 'service.filesGit.notUtf8', defaultMessage: '{file} is not UTF-8 text, so Combwork leaves it alone.', description: "An error from the Files tab's Git menu: the ignore file ({file}) isn't UTF-8, so Combwork won't rewrite it." }),
  ruleChanged: msg({ id: 'service.filesGit.ruleChanged', defaultMessage: 'The rule that ignores it has changed. Look again with Why is this ignored?.', description: "An error from Include again in the Files tab's Git menu: the line it would remove isn't there any more, or it isn't one Combwork can remove. Why is this ignored? is the menu item (files.git.why)." }),
  notIgnored: msg({ id: 'service.filesGit.notIgnored', defaultMessage: 'Git no longer ignores it.', description: "An error from the Files tab's Git menu: the file isn't ignored any more." }),
  nothing: msg({ id: 'service.filesGit.nothing', defaultMessage: 'Choose a file or folder in the project.', description: "An error from the Files tab's Git menu: it was given nothing to act on." }),
  linked: msg({ id: 'service.filesGit.linked', defaultMessage: '{file} is a link, or leads outside the repository, so Combwork leaves it alone. Change it by hand.', description: "An error from the Files tab's Git menu (HI-2743): the ignore file ({file}: .gitignore or .git/info/exclude) is a symbolic link or junction, or its folder leads outside the repository, so Combwork won't write through it." }),
  tooLarge: msg({ id: 'service.filesGit.tooLarge', defaultMessage: '{file} is too large to show here.', description: "An error from Why Is This Ignored? in the Files tab's Git menu: the rule's file ({file}) is too large to show in Combwork's viewer." })
}

/** The most of a rule's file Why is this ignored? shows. */
const MAX_RULE_FILE = 1024 * 1024

/** A path as a literal pathspec: `src/[ab].txt` names that file, never `src/a.txt` and `src/b.txt` as a glob would. */
const literal = (rel: string): string => `:(literal)${rel}`

/** At most this many items in one action (a selection of the tree). */
const MAX_ITEMS = 500

type Item = { rel: string; isDir: boolean }

interface Repo {
  /** The project folder (the main checkout). */
  cwd: string
  top: string
  /** The project folder's path in the repository, `/` separated, ending in `/` (empty at the top). */
  prefix: string
  /** `.git/info/exclude` as git names it in check-ignore's output (relative to the top). */
  infoExclude: string
  /** The repository's git folder (`.git`, shared by its worktrees): where `info/exclude` must really be. */
  gitDir: string
  branch: string | null
}

function items(list: unknown): Item[] {
  const out = (Array.isArray(list) ? list : [])
    .filter((i): i is Item => !!i && typeof i.rel === 'string' && typeof i.isDir === 'boolean')
    .map((i) => ({ rel: i.rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''), isDir: i.isDir }))
    // Nothing outside the folder, and never the repository's own folder.
    .filter((i) => i.rel && !i.rel.split('/').some((p) => p === '..' || p === '.' || p === '') && !/^\.git(\/|$)/i.test(i.rel))
    .slice(0, MAX_ITEMS)
  if (!out.length) throw combworkError(M.nothing)
  return out
}

function gitFailed(err: string): Error {
  if (INDEX_BUSY.test(err)) return combworkError(M.busy)
  return combworkError(M.failed, { why: gitErrorLine(err) || err.trim().slice(0, 200) })
}

/** The project's repository, or null when the project folder isn't in one. */
async function repoOf(projectPath: string): Promise<Repo | null> {
  const cwd = workspace.assertProject(projectPath)
  const r = await git(cwd, ['rev-parse', '--show-toplevel', '--show-prefix', '--git-path', 'info/exclude', '--git-common-dir'])
  if (!r.ok) {
    if (/not a git repository/i.test(r.err)) return null
    throw gitFailed(r.err)
  }
  const [top, prefix, exclude, common] = r.out.split(/\r?\n/)
  const topAbs = resolve(top)
  const head = await git(cwd, ['symbolic-ref', '-q', 'HEAD'])
  return {
    cwd,
    top: topAbs,
    prefix: prefix ?? '',
    infoExclude: relative(topAbs, resolve(cwd, exclude ?? '.git/info/exclude')).split(sep).join('/'),
    gitDir: resolve(cwd, common || '.git'),
    branch: head.ok ? branchOfRef(head.out) : null
  }
}

async function needRepo(projectPath: string): Promise<Repo> {
  const repo = await repoOf(projectPath)
  if (!repo) throw combworkError(M.notRepo)
  return repo
}

const repoRel = (repo: Repo, rel: string): string => repo.prefix + rel

/** check-ignore -v for these items: their rules, by project-relative path. */
async function rulesOf(repo: Repo, list: Item[]): Promise<Map<string, IgnoreRule>> {
  const rules = new Map<string, IgnoreRule>()
  for (let i = 0; i < list.length; i += 200) {
    const r = await gitReading(repo.cwd, ['check-ignore', '-v', '--', ...list.slice(i, i + 200).map((x) => (x.isDir ? `${x.rel}/` : x.rel))])
    if (r.code !== 0 && r.code !== 1) throw gitFailed(r.err)
    for (const [k, v] of parseCheckIgnore(r.out)) rules.set(k, v)
  }
  return rules
}

/** Which of these items git tracks (a folder: any file in it). */
async function trackedOf(repo: Repo, list: Item[]): Promise<Set<string>> {
  const tracked = new Set<string>()
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200)
    const r = await gitReading(repo.cwd, ['ls-files', '-z', '--', ...chunk.map((x) => literal(x.rel))])
    if (!r.ok) throw gitFailed(r.err)
    // Each tracked file and the folders it is in (a folder of thousands of files is read once, not once per item).
    const have = new Set<string>()
    for (const f of r.out.split('\0')) for (let p = f; p && !have.has(p); p = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '') have.add(p)
    for (const x of chunk) if (have.has(x.rel)) tracked.add(x.rel)
  }
  return tracked
}

/** The rule's file inside the project folder, as a Files tab path (not under .git), or null. */
function ruleFileInProject(repo: Repo, rule: IgnoreRule): string | null {
  const abs = isAbsolute(rule.source) ? resolve(rule.source) : resolve(repo.top, rule.source)
  const rel = relative(repo.cwd, abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  const p = rel.split(sep).join('/')
  return /^\.git(\/|$)/i.test(p) ? null : p
}

/** What the Git menu shows for these items: whether the project is a repository, its branch, and each item's state. */
export async function gitInfo(projectPath: string, list: unknown): Promise<FileGitInfo> {
  const repo = await repoOf(projectPath)
  if (!repo) return { repo: false, branch: null, items: [] }
  const its = items(list)
  const [rules, tracked] = await Promise.all([rulesOf(repo, its), trackedOf(repo, its)])
  return {
    repo: true,
    branch: repo.branch,
    items: its.map((x): FileGitItem => {
      const rule = rules.get(x.rel) ?? null
      return {
        rel: x.rel,
        isDir: x.isDir,
        tracked: tracked.has(x.rel),
        rule: rule && { ...rule, file: ruleFileInProject(repo, rule), removable: removableRule(rule, repoRel(repo, x.rel), x.isDir, repo.infoExclude) }
      }
    })
  }
}

/**
 * The ignore file a target writes: the repository's top .gitignore, or .git/info/exclude, with the folder it must
 * really be in (the repository's top, or its git folder).
 */
function targetFile(repo: Repo, target: IgnoreTarget): { abs: string; name: string; within: string } {
  return target === 'shared' ? { abs: resolve(repo.top, '.gitignore'), name: '.gitignore', within: repo.top } : { abs: resolve(repo.top, repo.infoExclude), name: repo.infoExclude, within: repo.gitDir }
}

/**
 * Refuses to read or write an ignore file that is a link (a symbolic link or junction), or whose folders lead outside
 * where it belongs, as the Files tab refuses paths through a link out of the project: Combwork never rewrites a file
 * elsewhere through one. Checked under the file's lock, just before it is read and written.
 */
async function assertOwnFile(t: { abs: string; name: string; within: string }): Promise<void> {
  const st = await lstat(t.abs).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null
    throw e
  })
  if ((st && (st.isSymbolicLink() || !st.isFile())) || !insideReal(t.abs, [t.within])) throw combworkError(M.linked, { file: t.name })
}

async function readIgnoreFile(abs: string, name: string): Promise<string> {
  const buf = await readFile(abs).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return Buffer.alloc(0)
    throw e
  })
  const text = decodeUtf8(buf)
  if (text === null) throw combworkError(M.notUtf8, { file: name })
  return text
}

/**
 * Exclude from git: appends a line per item to the top .gitignore (`shared`) or .git/info/exclude (`local`), each only
 * once (a line already there is left), in the file's own line ending. `ext`: one `*.ext` line, from the first file
 * with an extension. Which file, the lines added, and the branch.
 */
export async function gitExclude(projectPath: string, list: unknown, target: IgnoreTarget, ext: boolean): Promise<FileGitDone> {
  const repo = await needRepo(projectPath)
  const its = items(list)
  const t = targetFile(repo, target === 'local' ? 'local' : 'shared')
  let lines: string[]
  if (ext) {
    const e = its.filter((x) => !x.isDir).map((x) => extensionOf(x.rel.slice(x.rel.lastIndexOf('/') + 1))).find((x) => x)
    if (!e) throw combworkError(M.nothing)
    lines = [extIgnoreLine(e)]
  } else lines = its.map((x) => exactIgnoreLine(repoRel(repo, x.rel), x.isDir))
  const added = await withFileLock(t.abs, async () => {
    await assertOwnFile(t)
    const before = await readIgnoreFile(t.abs, t.name)
    const r = appendIgnoreLines(before, lines)
    if (r.added.length) {
      await mkdir(dirname(t.abs), { recursive: true })
      await writeFile(t.abs, r.text, 'utf8')
    }
    return r.added
  })
  log.info(`Excluded ${added.length} of ${lines.length} lines in ${t.name} of ${userText(repo.cwd)}`)
  return { file: t.name, lines: added, count: lines.length, branch: repo.branch }
}

/** Stop tracking, keep the file: `git rm --cached` (`-r` with a folder), the files left on disk. */
export async function gitUntrack(projectPath: string, list: unknown): Promise<FileGitDone> {
  const repo = await needRepo(projectPath)
  const its = items(list)
  const tracked = await trackedOf(repo, its)
  const rels = its.filter((x) => tracked.has(x.rel))
  if (!rels.length) return { file: null, lines: [], count: 0, branch: repo.branch }
  const r = await git(repo.cwd, ['rm', '--cached', '--quiet', ...(rels.some((x) => x.isDir) ? ['-r'] : []), '--', ...rels.map((x) => literal(x.rel))])
  if (!r.ok) throw gitFailed(r.err)
  log.info(`Stopped tracking ${rels.length} items in ${userText(repo.cwd)}`)
  return { file: null, lines: [], count: rels.length, branch: repo.branch }
}

/** Include again: takes out the line Combwork can remove (removableRule) that ignores this item, after checking it is still that line. */
export async function gitInclude(projectPath: string, list: unknown): Promise<FileGitDone> {
  const repo = await needRepo(projectPath)
  const [it] = items(list)
  const rule = (await rulesOf(repo, [it])).get(it.rel)
  if (!rule) throw combworkError(M.notIgnored)
  const target = removableRule(rule, repoRel(repo, it.rel), it.isDir, repo.infoExclude)
  if (!target) throw combworkError(M.ruleChanged)
  const t = targetFile(repo, target)
  await withFileLock(t.abs, async () => {
    await assertOwnFile(t)
    const out = removeIgnoreLine(await readIgnoreFile(t.abs, t.name), rule.line, rule.pattern)
    if (out === null) throw combworkError(M.ruleChanged)
    await writeFile(t.abs, out, 'utf8')
  })
  log.info(`Removed line ${rule.line} of ${t.name} in ${userText(repo.cwd)}`)
  return { file: t.name, lines: [rule.pattern], count: 1, branch: repo.branch }
}

/**
 * Why is this ignored?, for a rule outside the Files tab's tree (.git/info/exclude, the global excludes file, a
 * .gitignore above the project folder): the rule's file, its text and line, for Combwork's viewer. Main finds the rule
 * again itself, so the window can only show the file a rule is in.
 */
export async function ignoreRuleText(projectPath: string, list: unknown): Promise<FileGitRuleText> {
  const repo = await needRepo(projectPath)
  const [it] = items(list)
  const rule = (await rulesOf(repo, [it])).get(it.rel)
  if (!rule) throw combworkError(M.notIgnored)
  const abs = isAbsolute(rule.source) ? resolve(rule.source) : resolve(repo.top, rule.source)
  const st = await stat(abs)
  if (st.size > MAX_RULE_FILE) throw combworkError(M.tooLarge, { file: rule.source })
  const text = decodeUtf8(await readFile(abs))
  if (text === null) throw combworkError(M.notUtf8, { file: rule.source })
  return { file: rule.source, path: abs, text: text.replace(/^\uFEFF/, ''), line: rule.line, pattern: rule.pattern }
}
