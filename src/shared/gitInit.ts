// Initialise repository (#701): a project that isn't a git repository becomes one from its Git tab, in one click: `git
// init -b main`, .combwork excluded before anything is staged, an optional starter .gitignore, a first commit, then a
// refresh so worktrees work at once. Shared by the main process, the window and their tests.

import type { Text } from './advanced'
import { identityProblem, type GitIdentityPart } from './gitRepo'
import { msg, tr, type Msg } from './i18n'

/** The starter .gitignore choices: none, a minimal one, or a template for a kind of project. */
export type GitignoreChoice = 'none' | 'minimal' | 'node' | 'python' | 'dotnet' | 'godot'

/** What the Initialise dialog needs to know first (`git:initCheck`). */
export interface GitInitCheck {
  /** Why it can't be done here (already a repository, another version control system, git missing), or null: in English (#881). */
  refused: string | null
  /** The same as text, which the window shows in its language (shownText) when the language changes too. */
  refusedText?: Text
  /**
   * The folder is a git repository with no commit yet (one that stopped short, or `git init` by hand): it is taken on
   * from there, everything but `git init`, and its identity is read from it, so it is exactly what it will commit as.
   */
  resume?: boolean
  /** The repository whose working tree holds the folder: initialising inside it needs the user's say. */
  parentRepo?: string
  /** The identity git would commit as, from the global and system config: a part missing is asked for. */
  identity: GitIdentityPart
  /**
   * The system or global config has conditional includes (`includeIf`), which may set the identity for the new
   * repository: only it can say, so what is entered is optional, used only for what git still lacks there.
   */
  conditionalIdentity?: boolean
  /** The folder has a .gitignore of its own: it is kept, and no starter one is offered. */
  hasGitignore: boolean
  /** The folder has nothing to commit (apart from .combwork): the first commit is an empty one. */
  empty: boolean
}

/** What the user chose in the dialog (`git:init`). */
export interface GitInitOptions {
  gitignore: GitignoreChoice
  /** Asked for only when git has none: saved to this repository's config, never the global one. */
  name?: string
  email?: string
  /** The user confirmed initialising inside another repository's working tree. */
  nested?: boolean
}

/** OS and editor leftovers and logs: in every starter .gitignore. */
// i18n-ignore: the starter .gitignore's content, written into the project
const MINIMAL = ['# OS and editor files', 'Thumbs.db', 'ehthumbs.db', 'desktop.ini', '.DS_Store', '*.swp', '*~', '', '# Logs', '*.log', 'logs/']

const TEMPLATES: Record<Exclude<GitignoreChoice, 'none' | 'minimal'>, string[]> = {
  node: ['# Node', 'node_modules/', 'dist/', 'build/', 'out/', 'coverage/', '.cache/', '.env', '.env.*', '!.env.example', 'npm-debug.log*', 'yarn-debug.log*', 'yarn-error.log*', 'pnpm-debug.log*'],
  python: ['# Python', '__pycache__/', '*.py[cod]', '.venv/', 'venv/', 'env/', '.env', 'build/', 'dist/', '*.egg-info/', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', '.coverage', 'htmlcov/', '.ipynb_checkpoints/'],
  // i18n-ignore: the starter .gitignore's content, written into the project
  dotnet: ['# .NET', '[Bb]in/', '[Oo]bj/', '.vs/', '*.user', '*.suo', '*.userprefs', 'TestResults/', '[Pp]ackages/', '*.nupkg', 'artifacts/'],
  godot: ['# Godot 4', '.godot/', '/android/', '', '# Godot 3', '.import/', 'export.cfg', 'export_presets.cfg', '*.translation', '.mono/', 'data_*/', 'mono_crash.*.json']
}

const M = {
  none: msg({ id: 'git.init.gitignore.none', defaultMessage: 'None', description: 'Initialise repository, Starter .gitignore: no .gitignore.' }),
  minimal: msg({ id: 'git.init.gitignore.minimal', defaultMessage: 'Minimal (OS files, logs)', description: 'Initialise repository, Starter .gitignore: one that leaves out OS and editor files and logs.' }),
  node: msg({ id: 'git.init.gitignore.node', defaultMessage: 'Node', description: 'Initialise repository, Starter .gitignore: for a Node project. A name: usually kept.' }),
  python: msg({ id: 'git.init.gitignore.python', defaultMessage: 'Python', description: 'Initialise repository, Starter .gitignore: for a Python project. A name: usually kept.' }),
  dotnet: msg({ id: 'git.init.gitignore.dotnet', defaultMessage: '.NET', description: 'Initialise repository, Starter .gitignore: for a .NET project. A name: usually kept.' }),
  godot: msg({ id: 'git.init.gitignore.godot', defaultMessage: 'Godot', description: 'Initialise repository, Starter .gitignore: for a Godot game. A name: usually kept.' }),
  gitignoreName: msg({ id: 'git.init.gitignoreName', defaultMessage: '{choice, select, minimal {a minimal .gitignore} other {a {kind} .gitignore}}', description: 'The starter .gitignore Initialise repository added, in what it reports it did ("added a Node .gitignore"). {choice} is minimal, or another kind: {kind} is Node, Python, .NET or Godot.' }),
  resume: msg({ id: 'git.init.resume', defaultMessage: '{name} is a git repository with no commits yet, and worktrees need one. This keeps its .combwork out of git and commits {empty, select, yes {nothing yet (an empty first commit)} other {everything in the folder}} as the first commit.{gitignore, select, yes { Its own .gitignore is kept.} other {}}', description: "Make the first commit dialog, for a repository with no commit. {name} is the project; {empty} is yes when its folder has nothing to commit; {gitignore} is yes when it has a .gitignore of its own." }),
  makes: msg({ id: 'git.init.makes', defaultMessage: 'Makes {name} a git repository on a branch called main, keeps its .combwork out of git, and commits {empty, select, yes {nothing yet (an empty first commit)} other {everything in the folder}} as the first commit, so agents can work in worktrees at once.', description: 'The Initialise repository dialog: what it will do. {name} is the project; {empty} is yes when its folder has nothing to commit. Keep main (the branch name).' }),
  kept: msg({ id: 'git.init.kept', defaultMessage: 'Its own .gitignore is kept.', description: 'The Initialise repository dialog, after what it will do, when the folder has a .gitignore.' }),
  nested: msg({ id: 'git.init.nested', defaultMessage: 'It is inside the git repository in {folder}: a repository inside another is usually a mistake, and that one will no longer see the files here as its own.', description: "The Initialise repository dialog, when the project's folder is inside another repository. {folder} is that repository's folder." }),
  enterName: msg({ id: 'git.init.enterName', defaultMessage: 'Enter the name your commits are made as', description: 'Under the Initialise repository dialog while the name git needs is empty.' }),
  enterEmail: msg({ id: 'git.init.enterEmail', defaultMessage: 'Enter the email your commits are made as', description: 'Under the Initialise repository dialog while the email git needs is empty.' })
}

/** The dialog's choices, in order. */
export const GITIGNORE_CHOICES: { value: GitignoreChoice; label: Msg }[] = [
  { value: 'none', label: M.none },
  { value: 'minimal', label: M.minimal },
  { value: 'node', label: M.node },
  { value: 'python', label: M.python },
  { value: 'dotnet', label: M.dotnet },
  { value: 'godot', label: M.godot }
]

/** The starter .gitignore added, in a sentence: "a Node .gitignore". */
export function gitignoreName(choice: Exclude<GitignoreChoice, 'none'>): string {
  return tr(M.gitignoreName, { choice, kind: tr(GITIGNORE_CHOICES.find((c) => c.value === choice)!.label) })
}

/** The same as text, formatted when it is shown (in an error's English, or the window's language): #881. */
export function gitignoreNameText(choice: Exclude<GitignoreChoice, 'none'>): Text {
  return { m: M.gitignoreName, values: { choice, kind: GITIGNORE_CHOICES.find((c) => c.value === choice)!.label } }
}

export function isGitignoreChoice(v: unknown): v is GitignoreChoice {
  return GITIGNORE_CHOICES.some((c) => c.value === v)
}

/** The starter .gitignore's text for a choice (null for none). Never lists .combwork: git's info/exclude keeps it out (#345). */
export function gitignoreText(choice: GitignoreChoice): string | null {
  if (choice === 'none') return null
  const lines = choice === 'minimal' ? MINIMAL : [...TEMPLATES[choice], '', ...MINIMAL]
  return `${lines.join('\n')}\n`
}

/** The first commit's message. */
// i18n-ignore: a commit message, written into the repository
export const FIRST_COMMIT_MESSAGE = 'Initial commit'

/** What the dialog says before the user initialises: what will happen, and the nested repository's warning. */
export function initAbout(name: string, check: GitInitCheck): string {
  const empty = check.empty ? 'yes' : 'no'
  if (check.resume) return tr(M.resume, { name, empty, gitignore: check.hasGitignore ? 'yes' : 'no' })
  // Sentences, each a message of its own.
  const parts = [tr(M.makes, { name, empty })]
  if (check.hasGitignore) parts.push(tr(M.kept))
  if (check.parentRepo) parts.push(tr(M.nested, { folder: check.parentRepo }))
  return parts.join(' ')
}

/** Why the dialog's values can't be sent yet, or null: a missing name or email is needed for the first commit. */
export function initProblem(check: GitInitCheck, v: { name: string; email: string }): string | null {
  if (!check.conditionalIdentity && !check.identity.name && !v.name.trim()) return tr(M.enterName)
  if (!check.conditionalIdentity && !check.identity.email && !v.email.trim()) return tr(M.enterEmail)
  return identityProblem(v.name, v.email)
}
