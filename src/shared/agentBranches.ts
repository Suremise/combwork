// The branches Combwork makes for worktree agents (#703, Darren's decision on #702): cw/<workspace>/<project>/<agent>,
// e.g. cw/Work/ambrosia/amb1, always in full, so several workspaces can share a repository, even with projects of the
// same name, and never take each other's branches. Every branch and ref Combwork names starts with `cw/` (HI-2593):
// branches under the name it had before 1.1 are no longer its own, and nothing here recognises them.
import { slugify } from './defaults'

/** The first part of every branch Combwork names (card lines, agents' worktrees) and of its refs (refs/cw/…). */
export const BRANCH_PREFIX = 'cw'

/** The longest a workspace's or project's part of a branch is. */
const PART_MAX = 40

/**
 * A workspace's or project's folder name as one part of a git branch name: its case kept, anything git's ref rules
 * refuse (spaces, ~ ^ : ? * [ \, control characters, "..", "@{", a leading ".", a trailing "." or ".lock") turned into
 * "-" or dropped, at most 40 characters; `fallback` when nothing is left.
 */
export function refPart(name: string, fallback: string): string {
  let s = name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .slice(0, PART_MAX)
  for (let before = ''; before !== s; ) {
    before = s
    s = s.replace(/^[.-]+/, '').replace(/[.-]+$/, '').replace(/\.lock$/i, '')
  }
  return s || fallback
}

/**
 * Where a project is, for its branches: its workspace's folder name and its own. `spaces`: the other workspace parts
 * Combwork has given this project's branches (project.json's `branchSpaces`, #703 round 3: recorded when it first makes a
 * branch in one); with the workspace's own part, the only ones that are this project's. `space`: the part its new
 * branches take now (`chooseSpace`), when known.
 */
export interface BranchHome {
  workspace: string
  project: string
  spaces?: readonly string[]
  space?: string
}

const workspacePart = (home: BranchHome): string => refPart(home.workspace, 'workspace')
const projectPart = (home: BranchHome): string => refPart(home.project, 'project')

/** The workspace parts that are this project's: the workspace's own, then those Combwork gave it (recorded). */
export function ownSpaces(home: BranchHome): string[] {
  const out: string[] = []
  for (const s of [workspacePart(home), ...(home.spaces ?? [])]) if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s)
  return out
}

/**
 * The workspace parts that name this place now: the workspace's own, and those Combwork numbered from it (ws-2, ws-3:
 * `chooseSpace`). A part recorded under a name the workspace had before (Scratch-2, now it is Tools) is still the
 * project's (`ownSpaces`: its branches are its own) but no longer a name for here (#1305).
 */
export function currentSpaces(home: BranchHome): string[] {
  const own = ownSpaces(home)
  const stem = `${own[0].toLowerCase()}-`
  return own.filter((s, i) => i === 0 || (s.toLowerCase().startsWith(stem) && /^\d+$/.test(s.slice(stem.length))))
}

/**
 * The workspace part for this project's new branches in a repository that has `branches` (#703 rounds 2 and 3), and
 * whether it is a new one to record. Git can't make cw/ws/alpha/b1 while a branch cw/ws exists (one made outside
 * Combwork) or cw/ws/alpha does, case aside on Windows: such a part is blocked. Stable once chosen:
 * - the part last recorded (the project moved off its own once), while it isn't blocked;
 * - else the workspace's own, while it isn't blocked;
 * - else another recorded one that isn't;
 * - else a new one, ws-2, ws-3…: not blocked, and not in use by anyone else here (no branch under cw/<it>/<project>/,
 *   which would be another workspace's of that name sharing the repository). It is recorded once a branch is made in it.
 * The branch in the way is left as it is.
 */
export function chooseSpace(home: BranchHome, branches: readonly string[]): { space: string; isNew: boolean } {
  const lower = branches.map((b) => b.toLowerCase())
  const p = projectPart(home).toLowerCase()
  const blocked = (s: string): boolean => lower.includes(`${BRANCH_PREFIX}/${s}`.toLowerCase()) || lower.includes(`${BRANCH_PREFIX}/${s}/${p}`.toLowerCase())
  const used = (s: string): boolean => lower.some((b) => b.startsWith(`${BRANCH_PREFIX}/${s}/${p}/`.toLowerCase()))
  const own = ownSpaces(home)
  // Only the parts that name this place now (#1305): one recorded under the workspace's old name isn't taken again.
  const recorded = currentSpaces(home).slice(1)
  const last = recorded[recorded.length - 1]
  for (const s of [...(last ? [last] : []), own[0], ...recorded]) if (!blocked(s)) return { space: s, isNew: false }
  const owned = new Set(own.map((s) => s.toLowerCase()))
  for (let n = 2; ; n++) {
    const s = `${own[0]}-${n}`
    if (!owned.has(s.toLowerCase()) && !blocked(s) && !used(s)) return { space: s, isNew: true }
  }
}

/** An agent's part of its full-form branch: its slug (as its worktree's folder is named), with git's ref rules applied too. */
export const agentPart = (agent: string): string => refPart(slugify(agent), 'agent')

/** The branch Combwork makes for an agent's new worktree: cw/<workspace>/<project>/<agent>, in `space` when given. */
export function agentBranch(home: BranchHome, agent: string): string {
  return `${BRANCH_PREFIX}/${home.space ?? workspacePart(home)}/${projectPart(home)}/${agentPart(agent)}`
}

/** An agent's branch in Combwork's form, cw/<workspace>/<project>/<agent>, as its three parts; null for any other. */
function fullForm(branch: string): [string, string, string] | null {
  const parts = branch.split('/')
  return parts.length === 4 && parts[0] === BRANCH_PREFIX && parts.slice(1).every(Boolean) ? [parts[1], parts[2], parts[3]] : null
}

/**
 * The name an agent's branch takes here (#1305, Darren's decision on #1303: renamed at Repair, never offered): a branch
 * in the full form whose workspace part isn't one naming this place now (`currentSpaces`) or whose project part isn't this
 * project's, named after where the workspace or project was, moves to `home`: its workspace part becomes `home.space`
 * (the one its new branches take, `chooseSpace`) when it was another, its project part this project's; its agent part,
 * numbered or not, stays (renaming an agent is its own step). Null when it is already named for here, or isn't
 * Combwork's form.
 */
export function branchHere(branch: string, home: BranchHome): string | null {
  const full = fullForm(branch)
  if (!full) return null
  const spaces = currentSpaces(home)
  const spaceHere = spaces.some((s) => s.toLowerCase() === full[0].toLowerCase())
  const projectHere = full[1].toLowerCase() === projectPart(home).toLowerCase()
  if (spaceHere && projectHere) return null
  return `${BRANCH_PREFIX}/${spaceHere ? full[0] : (home.space ?? spaces[0])}/${projectPart(home)}/${full[2]}`
}

/** 0 when `part` is `stem`, n when it is `stem-n` (numbered when taken), else null; case aside. */
function numberOf(part: string, stem: string): number | null {
  const p = part.toLowerCase()
  const s = stem.toLowerCase()
  if (p === s) return 0
  const rest = p.startsWith(`${s}-`) ? p.slice(s.length + 1) : ''
  return /^\d+$/.test(rest) ? Number(rest) : null
}

/**
 * Whether `branch` is one Combwork made for an agent called `name` in this project: 0 its own, n one numbered "-n" when
 * it was taken, null not. cw/<workspace>/<project>/<agent> in one of this project's own workspace parts (`ownSpaces`:
 * never a part only because it looks numbered, which another workspace may be called) and this project, case aside.
 */
export function agentBranchNumber(branch: string, home: BranchHome, name: string): number | null {
  const full = fullForm(branch)
  if (!full || !ownSpaces(home).some((s) => s.toLowerCase() === full[0].toLowerCase()) || full[1].toLowerCase() !== projectPart(home).toLowerCase()) return null
  return numberOf(full[2], agentPart(name))
}

/**
 * The branches a new worktree on `branch` for an agent called `name` may find an unused worktree on (#456), in order:
 * that branch; when it is that agent's own branch here, the same agent's in this project's other own workspace parts
 * (kept from before a part changed, #703 round 3).
 */
export function reusableBranches(branch: string, home: BranchHome, name?: string): string[] {
  if (!name || agentBranchNumber(branch, home, name) !== 0) return [branch]
  const others = ownSpaces(home)
    .map((space) => agentBranch({ ...home, space }, name))
    .filter((b) => b.toLowerCase() !== branch.toLowerCase())
  return [branch, ...others]
}
