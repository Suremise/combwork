import { useState } from 'react'
import { msg, tr } from '@shared/i18n'
import { shortCommit, type GitlinkChange, type GitlinkSide } from '@shared/gitlink'
import type { GitDiff } from '@shared/types'
import { languageFor } from '../monacoLang'
import { DiffView } from './Editors'
import { Icon } from './ui'

// A moved submodule (HI-2864, design HI-2864/s10): one row, "Submodule lib/sub: 0bbdde2 → 0fc182f", in place of git's
// `Subproject commit` lines, which stay one click away. Shown in the Changes tab's diff, its comparison, and a card's
// Work section (its submitted files).

const M = {
  summary: msg({
    id: 'git.gitlink.summary',
    defaultMessage:
      '{change, select, moved {Submodule {path}: {from} → {to}} added {Submodule {path} added at {to}} removed {Submodule {path} removed (was {from})} toFile {Submodule {path} ({from}) replaced by a file} toLink {Submodule {path} ({from}) replaced by a symbolic link} fromFile {A file replaced by submodule {path} ({to})} other {A symbolic link replaced by submodule {path} ({to})}}',
    description:
      "HI-2864: a change to a submodule (a git repository inside the project, kept at one commit) in a diff or a card's list of changed files. {path}: its folder. {from}/{to}: the commit before and after (short ids). {change} picks the kind: moved to another commit, added, removed, replaced by a file or symbolic link, or a file or symbolic link replaced by it. Keep the select keys. Glossary: submodule, commit."
  }),
  dirty: msg({ id: 'git.gitlink.dirty', defaultMessage: 'Its folder has uncommitted changes inside.', description: "HI-2864: after a submodule's row in the Changes tab: the submodule's own folder has changes not committed in it." }),
  showGit: msg({ id: 'git.gitlink.showGit', defaultMessage: 'Show git’s diff', description: "HI-2864: a button under a submodule's row in the Changes tab: shows the change as git itself writes it (\"Subproject commit …\" lines)." }),
  hideGit: msg({ id: 'git.gitlink.hideGit', defaultMessage: 'Hide git’s diff', description: "HI-2864: the same button once git's own lines are shown: hides them again." }),
  binary: msg({ id: 'git.gitlink.binary', defaultMessage: 'The file’s side is binary: its content can’t be shown.', description: "HI-2864: in place of git's lines for a submodule replaced by a binary file (or the reverse): that file isn't text." })
}

type Kind = 'moved' | 'added' | 'removed' | 'toFile' | 'toLink' | 'fromFile' | 'fromLink'

function kindOf(from: GitlinkSide, to: GitlinkSide): Kind {
  if (from.kind === 'gitlink') return to.kind === 'gitlink' ? 'moved' : to.kind === 'file' ? 'toFile' : to.kind === 'link' ? 'toLink' : 'removed'
  return from.kind === 'file' ? 'fromFile' : from.kind === 'link' ? 'fromLink' : 'added'
}

const commitOf = (s: GitlinkSide, short: boolean): string => (s.kind === 'gitlink' ? (short ? shortCommit(s.commit) : s.commit) : '')

/** The row's words: short ids, or the full ones (its tooltip). */
export function gitlinkSummary(path: string, change: Pick<GitlinkChange, 'from' | 'to'>, short = true): string {
  return tr(M.summary, { change: kindOf(change.from, change.to), path, from: commitOf(change.from, short), to: commitOf(change.to, short) })
}

/** A submodule's row, its full ids in the tooltip. */
export function GitlinkRow({ path, change, className }: { path: string; change: Pick<GitlinkChange, 'from' | 'to'>; className?: string }) {
  return (
    <span className={className ?? 'gitlink-row'} title={gitlinkSummary(path, change, false)} data-gitlink={path}>
      <Icon name="repo" /> {gitlinkSummary(path, change)}
    </span>
  )
}

/** A diff with a gitlink side: the row, a note when its checkout is dirty, and git's own lines on request. */
export function GitlinkDiff({ diff, change, inline }: { diff: GitDiff; change: GitlinkChange; inline: boolean }) {
  const [git, setGit] = useState(false)
  return (
    <div className="gitlink-diff" data-gitlink-diff={diff.path}>
      <div className="gitlink-diff-head">
        <GitlinkRow path={diff.path} change={change} />
        {change.dirty && <span className="faint">{tr(M.dirty)}</span>}
        <button type="button" className="btn small subtle" aria-expanded={git} onClick={() => setGit(!git)}>
          <Icon name={git ? 'chevron-down' : 'chevron-right'} /> {tr(git ? M.hideGit : M.showGit)}
        </button>
      </div>
      {git && (
        <div className="editor-host" data-gitlink-git={diff.path}>
          {diff.binary ? <div className="empty-state">{diff.modified || tr(M.binary)}</div> : <DiffView original={diff.original} modified={diff.modified} language={languageFor(diff.path)} inline={inline} />}
        </div>
      )}
    </div>
  )
}
