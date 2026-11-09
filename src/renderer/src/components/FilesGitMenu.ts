import type { FileEntry, FileGitDone, FileGitInfo, FileGitItem, FileGitRuleText, ProjectInfo } from '@shared/types'
import { exactIgnoreLine, extensionOf, extIgnoreLine, type IgnoreRule, type IgnoreTarget } from '@shared/gitIgnoreRules'
import { msg, tr } from '@shared/i18n'
import * as actions from '../actions'
import { call } from '../api'
import { offered, repoOp } from '../repoOps'
import { bumpGit, confirm, notify, set, showVersionControl } from '../store'
import type { MenuEntry } from './ui'

/**
 * The Files tab's Git section (HI-2743): Exclude from git, Stop tracking, Include again, Why is this ignored? and Show
 * changes, on the project folder's files only (never an agent's slot). A short menu, not a git client: no discard, stage
 * or commit. Main does the git (`files:git*`), off main's thread.
 */
export const FILES_GIT_TEXT = {
  section: msg({ id: 'files.git.section', defaultMessage: 'Git', description: "Heading of the Git section of the Files tab's right-click menu (HI-2743). Usually kept as Git." }),
  exclude: msg({ id: 'files.git.exclude', defaultMessage: 'Exclude from Git', description: "Files tab's right-click menu (HI-2743): opens a menu of ways to make git ignore the file or folder (a line in .gitignore)." }),
  inGitignore: msg({ id: 'files.git.inGitignore', defaultMessage: 'Shared with everyone', description: "A heading in the Exclude from Git menu (shown in capitals): the choices under it write the project's .gitignore, which is committed, so collaborators and agents get it. Each choice's second line names the file." }),
  onThisPc: msg({ id: 'files.git.onThisPc', defaultMessage: 'Only on this PC', description: "A heading in the Exclude from Git menu (shown in capitals): the choices under it write .git/info/exclude, which git never commits. Each choice's second line names the file." }),
  thisItem: msg({ id: 'files.git.thisItem', defaultMessage: '{count, plural, =1 {{folder, select, yes {This folder} other {This file}}} other {These # items}}', description: 'A choice in the Exclude from Git menu: ignore exactly the selected file, folder or items. {folder} is yes for one folder; {count} how many are selected.' }),
  allExt: msg({ id: 'files.git.allExt', defaultMessage: 'All *.{ext} files', description: 'A choice in the Exclude from Git menu: ignore every file with this extension ({ext}, such as log), anywhere in the project. Keep *.{ext}.' }),
  untrack: msg({ id: 'files.git.untrack', defaultMessage: 'Stop Tracking, Keep the File…', description: "Files tab's right-click menu (HI-2743), for files git tracks: removes them from git (git rm --cached) and leaves them on disk, after asking." }),
  include: msg({ id: 'files.git.include', defaultMessage: 'Include Again', description: "Files tab's right-click menu (HI-2743), for an ignored file: removes the .gitignore line that ignores exactly it, so git sees it again." }),
  why: msg({ id: 'files.git.why', defaultMessage: 'Why Is This Ignored?', description: "Files tab's right-click menu (HI-2743), for an ignored file: opens the ignore file at the rule that ignores it." }),
  showChanges: msg({ id: 'files.git.showChanges', defaultMessage: 'Show Changes', description: "Files tab's right-click menu (HI-2743), for a changed or new file: opens its diff in the Version Control tab." }),
  initialise: msg({ id: 'files.git.initialise', defaultMessage: 'Initialise Repository…', description: "Files tab's right-click menu in a project that isn't a git repository (HI-2743): opens the Initialise repository dialog in the Version Control tab." }),
  ignoredBy: msg({ id: 'files.git.ignoredBy', defaultMessage: 'Ignored by {file}:{line} `{pattern}`', description: "A dimmed file's tooltip in the Files tab (HI-2743): the rule git ignores it by, in its ignore file ({file}) at line {line}; {pattern} is the rule as written. Keep the backquotes." }),
  excluded: msg({ id: 'files.git.excluded', defaultMessage: '{added, plural, =0 {Already in {file}: nothing added.} one {Added {line} to {file}{branch, select, none {.} other { on {branch}.}}} other {Added # lines to {file}{branch, select, none {.} other { on {branch}.}}}}', description: 'Notification after Exclude from Git. {added} is how many lines were added to {file} (.gitignore or .git/info/exclude); {line} the one line; {branch} the branch of the project folder changed, or none.' }),
  excludedDetail: msg({ id: 'files.git.excludedDetail', defaultMessage: '{file, select, gitignore {The change to .gitignore shows in the Version Control tab, to commit.} other {Only this PC: nothing to commit.}}', description: 'Under the notification after Exclude from Git. {file} is gitignore for .gitignore, else .git/info/exclude.' }),
  untrackTitle: msg({ id: 'files.git.untrackTitle', defaultMessage: 'Stop tracking {count, plural, =1 {"{name}"} other {# items}}?', description: 'Title of the confirmation before Stop Tracking in the Files tab. {name} is the one file or folder; {count} how many.' }),
  untrackMessage: msg({ id: 'files.git.untrackMessage', defaultMessage: '{branch, select, none {Git stops tracking it in the project folder.} other {Git stops tracking it on {branch}, in the project folder.}} {count, plural, =1 {The file stays on disk.} other {The files stay on disk.}}', description: 'The confirmation before Stop Tracking. {branch} is the branch of the project folder, or none; {count} how many items.' }),
  untrackDetail: msg({ id: 'files.git.untrackDetail', defaultMessage: 'The Version Control tab shows the removal as a deletion, to commit. Exclude it from Git too, or git offers it as new again.', description: 'Under the confirmation before Stop Tracking.' }),
  untrackButton: msg({ id: 'files.git.untrackButton', defaultMessage: 'Stop Tracking', description: 'Button of the confirmation before Stop Tracking: git stops tracking the files.' }),
  untracked: msg({ id: 'files.git.untracked', defaultMessage: '{count, plural, one {Git stopped tracking # item} other {Git stopped tracking # items}}{branch, select, none {.} other { on {branch}.}}', description: 'Notification after Stop Tracking. {branch} is the branch of the project folder changed, or none.' }),
  included: msg({ id: 'files.git.included', defaultMessage: 'Removed {line} from {file}{branch, select, none {.} other { on {branch}.}}', description: 'Notification after Include Again: the line removed from the ignore file. {branch} is the branch of the project folder changed, or none.' }),
  excludeFailed: msg({ id: 'files.git.excludeFailed', defaultMessage: 'Could not exclude from Git', description: 'Title of an error notification in the Files tab.' }),
  untrackFailed: msg({ id: 'files.git.untrackFailed', defaultMessage: 'Could not stop tracking', description: 'Title of an error notification in the Files tab.' }),
  includeFailed: msg({ id: 'files.git.includeFailed', defaultMessage: 'Could not include it again', description: 'Title of an error notification in the Files tab.' }),
  whyFailed: msg({ id: 'files.git.whyFailed', defaultMessage: 'Could not open the rule', description: 'Title of an error notification in the Files tab: Why Is This Ignored? could not open the ignore file.' }),
  ruleTitle: msg({ id: 'files.git.ruleTitle', defaultMessage: 'Why {name} is ignored', description: "Title of the viewer Why Is This Ignored? opens (HI-2743) for a rule file the Files tab doesn't show (.git/info/exclude, the global excludes file). {name} is the ignored file's or folder's name." }),
  ruleAt: msg({ id: 'files.git.ruleAt', defaultMessage: 'Line {line} of {file}: `{pattern}`', description: "Above the rule file in Why Is This Ignored?'s viewer: the line ({line}) of the file ({file}, such as .git/info/exclude) whose rule ({pattern}) ignores it, highlighted below. Keep the backquotes." }),
  ruleClose: msg({ id: 'files.git.ruleClose', defaultMessage: 'Close', description: "Button: closes Why Is This Ignored?'s viewer." })
}

const T = FILES_GIT_TEXT

/** A dimmed file's tooltip: the rule git ignores it by. */
export const ignoredByText = (rule: IgnoreRule): string => tr(T.ignoredBy, { file: rule.source, line: rule.line, pattern: rule.pattern })

/** Git statuses Show changes opens a diff for (the Files tab's letters: modified, added, untracked, renamed, copied). */
const CHANGED = new Set(['M', 'A', 'U', 'R', 'C'])

export interface GitMenuContext {
  project: ProjectInfo
  /** The selection the menu is for. */
  items: FileEntry[]
  info: FileGitInfo
  /** The Files tab's git letter of a path. */
  status: (rel: string) => string | undefined
  /** Opens another menu in the menu's place (the Exclude choices). */
  openMenu: (entries: MenuEntry[]) => void
  /** Reads the tree and git's status again after a change. */
  reload: () => void
  /** Shows a file of the tab at a line (Why is this ignored?). */
  showAt: (rel: string, line: number) => void
  /** Shows a rule file the tab doesn't, at the rule's line (Why is this ignored?). */
  showRule: (rule: FileGitRuleText, name: string) => void
}

const arg = (items: { relPath: string; isDir: boolean }[]): { rel: string; isDir: boolean }[] => items.map((i) => ({ rel: i.relPath, isDir: i.isDir }))
const branchArg = (b: string | null): string => b ?? 'none'

/** The project's main checkout's Version Control tab, Changes, at a file. */
export function showChangesOf(projectPath: string, file: string): void {
  set((s) => ({ changesRoot: { ...s.changesRoot, [projectPath]: '' }, changesJump: { project: projectPath, file, nonce: Date.now() } }))
  showVersionControl(projectPath, 'changes')
}

async function exclude(ctx: GitMenuContext, target: IgnoreTarget, ext: boolean): Promise<void> {
  const done = await actions.attempt(tr(T.excludeFailed), () => repoOp('files:gitExclude', ctx.project.path, arg(ctx.items), target, ext))
  if (!done) return
  ctx.reload()
  bumpGit(ctx.project.path)
  notify('success', tr(T.excluded, { added: done.lines.length, line: done.lines[0] ?? '', file: done.file ?? '', branch: branchArg(target === 'shared' ? done.branch : null) }), done.lines.length ? tr(T.excludedDetail, { file: target === 'shared' ? 'gitignore' : 'exclude' }) : undefined)
}

async function untrack(ctx: GitMenuContext, tracked: FileGitItem[]): Promise<void> {
  const one = ctx.items.find((i) => i.relPath === tracked[0]?.rel)
  const ok = await confirm({
    title: tr(T.untrackTitle, { count: tracked.length, name: one?.name ?? '' }),
    message: tr(T.untrackMessage, { count: tracked.length, branch: branchArg(ctx.info.branch) }),
    detail: tr(T.untrackDetail),
    confirmLabel: tr(T.untrackButton)
  })
  if (!ok) return
  const done = await actions.attempt(tr(T.untrackFailed), () => repoOp('files:gitUntrack', ctx.project.path, tracked.map((t) => ({ rel: t.rel, isDir: t.isDir }))))
  if (!done) return
  ctx.reload()
  bumpGit(ctx.project.path)
  notify('success', tr(T.untracked, { count: done.count, branch: branchArg(done.branch) }))
}

async function include(ctx: GitMenuContext, item: FileGitItem): Promise<void> {
  const done: FileGitDone | undefined = await actions.attempt(tr(T.includeFailed), () => repoOp('files:gitInclude', ctx.project.path, [{ rel: item.rel, isDir: item.isDir }]))
  if (!done) return
  ctx.reload()
  bumpGit(ctx.project.path)
  notify('success', tr(T.included, { line: done.lines[0] ?? '', file: done.file ?? '', branch: branchArg(item.rule?.removable === 'shared' ? done.branch : null) }))
}

function why(ctx: GitMenuContext, item: FileGitItem): void {
  const rule = item.rule
  if (!rule) return
  if (rule.file) return ctx.showAt(rule.file, rule.line)
  const name = ctx.items.find((i) => i.relPath === item.rel)?.name ?? item.rel
  void actions.attempt(tr(T.whyFailed), () => call('files:gitRuleText', ctx.project.path, [{ rel: item.rel, isDir: item.isDir }])).then((r) => r && ctx.showRule(r, name))
}

/** The Exclude from Git choices: the selection's exact paths, or one file's extension; in .gitignore, or only on this PC. */
function excludeChoices(ctx: GitMenuContext): MenuEntry[] {
  const { items } = ctx
  const one = items.length === 1 ? items[0] : null
  const ext = one && !one.isDir ? extensionOf(one.name) : null
  // The line as written in the project folder's terms: main adds where the folder is in its repository.
  const exact = items.map((i) => exactIgnoreLine(i.relPath, i.isDir))
  const choices = (target: IgnoreTarget): MenuEntry[] => {
    // The line, then the file it goes in (file names, not words: the same in every language).
    const file = target === 'shared' ? '.gitignore' : '.git/info/exclude' // i18n-ignore: file names
    return [
      { header: true, label: tr(target === 'shared' ? T.inGitignore : T.onThisPc) },
      { label: tr(T.thisItem, { count: items.length, folder: one?.isDir ? 'yes' : 'no' }), detail: `${exact.length > 1 ? `${exact[0]} …` : exact[0]}  →  ${file}`, icon: one?.isDir ? 'folder' : 'file', onClick: () => void exclude(ctx, target, false) },
      ...(ext ? [{ label: tr(T.allExt, { ext }), detail: `${extIgnoreLine(ext)}  →  ${file}`, icon: 'files', onClick: () => void exclude(ctx, target, true) }] : [])
    ]
  }
  return [...choices('shared'), { separator: true }, ...choices('local')]
}

/**
 * The Git section of the Files tab's menu for a selection of the project folder. Outside a repository, Initialise
 * repository instead. Several items: Exclude (exact paths) and Stop tracking only.
 */
export function gitMenuEntries(ctx: GitMenuContext): MenuEntry[] {
  const { project, info, items } = ctx
  if (!info.repo) {
    if (!offered('git:init')) return []
    return [
      { separator: true },
      {
        label: tr(T.initialise),
        icon: 'repo',
        onClick: () => {
          showVersionControl(project.path, 'changes')
          set({ gitInitFor: project.path })
        }
      }
    ]
  }
  const byRel = new Map(info.items.map((i) => [i.rel, i]))
  const states = items.map((i) => byRel.get(i.relPath)).filter((i): i is FileGitItem => !!i)
  const single = items.length === 1 ? (states[0] ?? null) : null
  const tracked = states.filter((s) => s.tracked)
  const out: MenuEntry[] = []
  // Excluding what git ignores already does nothing: offered while something selected isn't ignored.
  if (states.some((s) => !s.rule) && offered('files:gitExclude')) out.push({ label: tr(T.exclude), icon: 'eye-closed', more: true, onClick: () => ctx.openMenu(excludeChoices(ctx)) })
  if (tracked.length && offered('files:gitUntrack')) out.push({ label: tr(T.untrack), icon: 'remove', onClick: () => void untrack(ctx, tracked) })
  if (single?.rule?.removable && offered('files:gitInclude')) out.push({ label: tr(T.include), icon: 'eye', onClick: () => void include(ctx, single) })
  if (single?.rule) out.push({ label: tr(T.why), icon: 'question', onClick: () => why(ctx, single) })
  const st = single && !single.isDir ? ctx.status(single.rel) : undefined
  if (st && CHANGED.has(st)) out.push({ label: tr(T.showChanges), icon: 'diff', onClick: () => showChangesOf(project.path, single!.rel) })
  return out.length ? [{ separator: true }, { header: true, label: tr(T.section) }, ...out] : []
}
