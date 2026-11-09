import { useEffect, useRef, useState } from 'react'
import type { ProjectInfo } from '@shared/types'
import { GITIGNORE_CHOICES, initAbout, initProblem, type GitInitCheck, type GitignoreChoice } from '@shared/gitInit'
import { msg, tr } from '@shared/i18n'
import { shownText } from '@shared/advanced'
import { errorMessage } from '../api'
import { offered, repoOp } from '../repoOps'
import { bumpGit, notify, set, useStore } from '../store'
import { BusyButton, Icon, Modal, useBusy } from './ui'

/** Initialise repository's words; also the Git tab's (its Make first commit… and Initialise its own repository… buttons). */
export const INIT_TEXT = {
  button: msg({ id: 'git.init.button', defaultMessage: 'Initialise repository…', description: 'Button on the Git tab of a project that is not a git repository: opens the Initialise dialog.' }),
  firstCommitButton: msg({ id: 'git.init.firstCommitButton', defaultMessage: 'Make first commit…', description: "Button on the Git tab of a repository with no commit yet: opens the dialog that makes one." }),
  ownRepoButton: msg({ id: 'git.init.ownRepoButton', defaultMessage: 'Initialise its own repository…', description: 'Button on the Git tab of a project inside another repository: opens the Initialise dialog.' })
}

const M = {
  titleResume: msg({ id: 'git.init.titleResume', defaultMessage: 'Make the first commit in {project}', description: "Title of the dialog that makes a repository's first commit. {project} is the project's name." }),
  title: msg({ id: 'git.init.title', defaultMessage: 'Initialise {project} as a git repository', description: "Title of the Initialise repository dialog. {project} is the project's name." }),
  cancel: msg({ id: 'git.init.cancel', defaultMessage: 'Cancel', description: 'Button: closes the Initialise dialog without doing anything.' }),
  close: msg({ id: 'git.init.close', defaultMessage: 'Close', description: 'Button: closes the Initialise dialog when it can only say why it cannot be done.' }),
  committing: msg({ id: 'git.init.committing', defaultMessage: 'Committing…', description: 'The Make first commit button while it runs.' }),
  initialising: msg({ id: 'git.init.initialising', defaultMessage: 'Initialising…', description: 'The Initialise button while it runs.' }),
  makeFirstCommit: msg({ id: 'git.init.makeFirstCommit', defaultMessage: 'Make first commit', description: "The dialog's button: makes the repository's first commit." }),
  initialise: msg({ id: 'git.init.initialise', defaultMessage: 'Initialise', description: "The dialog's button: makes the folder a git repository." }),
  looking: msg({ id: 'git.init.looking', defaultMessage: 'Looking at the folder…', description: 'The Initialise dialog while Combwork checks the folder.' }),
  nestedAnyway: msg({ id: 'git.init.nestedAnyway', defaultMessage: 'Make a repository of its own inside {folder} anyway', description: "Check box in the Initialise dialog of a project inside another repository. {folder} is that repository's folder." }),
  starterGitignore: msg({ id: 'git.init.starterGitignore', defaultMessage: 'Starter .gitignore', description: 'Label of the drop-down of starter .gitignore files.' }),
  yourName: msg({ id: 'git.init.yourName', defaultMessage: 'Your name', description: 'Label of the box for the name commits are made as.' }),
  namePlaceholder: msg({ id: 'git.init.namePlaceholder', defaultMessage: 'Your Name', description: 'Placeholder in the box for the name commits are made as: an example name.' }),
  yourEmail: msg({ id: 'git.init.yourEmail', defaultMessage: 'Your email', description: 'Label of the box for the email commits are made as.' }),
  conditional: msg({ id: 'git.init.conditional', defaultMessage: "Your git config has conditional includes (includeIf), which may set the {missing, select, both {name and email} name {name} other {email}} for this repository. Combwork uses what you enter only where they don't, and saves it to this repository's config only, never your global one.", description: 'Under the name and email boxes, when git config has includeIf rules. Keep includeIf.' }),
  noIdentity: msg({ id: 'git.init.noIdentity', defaultMessage: "Git has no {missing, select, both {name or email} name {name} other {email}} to commit as: Combwork saves what you enter to this repository's config only, never your global one.", description: 'Under the name and email boxes, when git has none to commit as.' }),
  noReply: msg({ id: 'git.init.noReply', defaultMessage: 'On GitHub, its no-reply address keeps your email private.', description: 'After the note under the name and email boxes.' }),
  commitsAs: msg({ id: 'git.init.commitsAs', defaultMessage: 'Commits as {name} <{email}>.', description: 'The Initialise dialog, when git already knows who commits: the name and email it will use.' })
}

/**
 * Initialise repository (#701): the button on the Git tab of a project that isn't a git repository (or is inside
 * another one, or has no commit yet), and its dialog: a starter .gitignore, the commit identity when git has none, and
 * the nested repository's confirmation. Main does the work (`git:init`) and says what it did. The dialog is the Git
 * tab's (`gitInitFor`, `InitRepoHost`), not the button's: it stays open while the tab changes under it (a repository
 * made, then a first commit still to make).
 */
export function InitRepoButton({ project, label, small }: { project: ProjectInfo; label?: string; small?: boolean }) {
  if (!offered('git:init')) return null
  return (
    <button className={small ? 'btn small' : 'btn primary'} data-git-init="" onClick={() => set({ gitInitFor: project.path })}>
      <Icon name="repo" /> {label ?? tr(INIT_TEXT.button)}
    </button>
  )
}

/** What the page under the dialog hears of it (HI-1905's Git preview): the repository made with its first commit, or why not. */
export interface InitRepoEvents {
  /** Called after the dialog has closed on success, with the project it initialised. */
  onInitialised?: (project: ProjectInfo) => void
  /** Called with each failure the dialog shows. */
  onFailed?: (error: string) => void
}

/** The project's Initialise dialog while it is open: in the Git tab, which stays as the page under it changes. */
export function InitRepoHost({ project, ...events }: { project: ProjectInfo } & InitRepoEvents) {
  const open = useStore((s) => s.gitInitFor === project.path)
  return open ? <InitRepoDialog project={project} onClose={() => set({ gitInitFor: null })} {...events} /> : null
}

function InitRepoDialog({ project, onClose, onInitialised, onFailed }: { project: ProjectInfo; onClose: () => void } & InitRepoEvents) {
  const [check, setCheck] = useState<GitInitCheck | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [gitignore, setGitignore] = useState<GitignoreChoice>('minimal')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [nested, setNested] = useState(false)
  const { busy, error, run } = useBusy()
  const failed = useRef(onFailed)
  failed.current = onFailed
  useEffect(() => {
    if (error) failed.current?.(error)
  }, [error])
  useEffect(() => {
    let live = true
    repoOp('git:initCheck', project.path).then(
      (c) => live && setCheck(c),
      (e) => live && setLoadError(errorMessage(e))
    )
    return () => {
      live = false
    }
  }, [project.path])
  const problem = check && !check.refused ? initProblem(check, { name, email }) : null
  const blocked = !check || !!check.refused || !!problem || (!!check.parentRepo && !nested)
  const submit = async (): Promise<void> => {
    if (blocked || !check) return
    const r = await run('init', () => repoOp('git:init', project.path, { gitignore: check.hasGitignore ? 'none' : gitignore, ...(check.identity.name ? {} : { name: name.trim() }), ...(check.identity.email ? {} : { email: email.trim() }), ...(check.parentRepo ? { nested: true } : {}) }))
    bumpGit(project.path)
    if (!r) {
      // It may have stopped part way (a repository made, no commit yet): asked again, the dialog goes on from there,
      // with the identity the new repository lacks, its failure still shown.
      await repoOp('git:initCheck', project.path).then(setCheck, () => undefined)
      return
    }
    notify('success', r.value)
    onClose()
    onInitialised?.(project)
  }
  const asks = check && !check.refused
  return (
    <Modal
      title={tr(check?.resume ? M.titleResume : M.title, { project: project.name })}
      icon="repo"
      onClose={onClose}
      busy={!!busy}
      error={error ?? loadError}
      footer={
        <>
          <button className="btn subtle" onClick={onClose}>
            {tr(asks ? M.cancel : M.close)}
          </button>
          {asks && (
            <BusyButton className="primary" busy={!!busy} busyLabel={tr(check.resume ? M.committing : M.initialising)} disabled={blocked} onClick={() => void submit()}>
              {tr(check.resume ? M.makeFirstCommit : M.initialise)}
            </BusyButton>
          )}
        </>
      }
    >
      {!check ? (
        !loadError && (
          <p className="hint">
            <Icon name="loading" spin /> {tr(M.looking)}
          </p>
        )
      ) : check.refused ? (
        <div className="banner warn" data-git-init-refused="">
          <Icon name="warning" /> {check.refusedText ? shownText(check.refusedText) : check.refused}
        </div>
      ) : (
        <div data-git-init-form="">
          <p className="hint">{initAbout(project.name, check)}</p>
          {check.parentRepo && (
            <div className="banner warn" data-git-init-nested="">
              <label className="flex">
                <input type="checkbox" className="checkbox" checked={nested} onChange={(e) => setNested(e.target.checked)} /> {tr(M.nestedAnyway, { folder: check.parentRepo })}
              </label>
            </div>
          )}
          <div className="agent-form git-form">
            {!check.hasGitignore && (
              <>
                <label htmlFor="git-init-gitignore">{tr(M.starterGitignore)}</label>
                <select id="git-init-gitignore" className="select" value={gitignore} onChange={(e) => setGitignore(e.target.value as GitignoreChoice)}>
                  {GITIGNORE_CHOICES.map((o) => (
                    <option key={o.value} value={o.value}>
                      {tr(o.label)}
                    </option>
                  ))}
                </select>
              </>
            )}
            {!check.identity.name && (
              <>
                <label htmlFor="git-init-name">{tr(M.yourName)}</label>
                <input id="git-init-name" className="input" value={name} placeholder={tr(M.namePlaceholder)} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
              </>
            )}
            {!check.identity.email && (
              <>
                <label htmlFor="git-init-email">{tr(M.yourEmail)}</label>
                <input id="git-init-email" className="input" value={email} placeholder={/* i18n-ignore: an example address in GitHub's own form */ 'id+you@users.noreply.github.com'}autoFocus={!!check.identity.name} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
              </>
            )}
          </div>
          {!check.identity.name || !check.identity.email ? (
            <p className="hint">
              {tr(check.conditionalIdentity ? M.conditional : M.noIdentity, { missing: !check.identity.name && !check.identity.email ? 'both' : !check.identity.name ? 'name' : 'email' })} {tr(M.noReply)}
            </p>
          ) : (
            <p className="hint faint">
              {tr(M.commitsAs, { name: check.identity.name, email: check.identity.email })}
            </p>
          )}
          {problem && (name.trim() || email.trim()) && <div className="field-error">{problem}</div>}
        </div>
      )}
    </Modal>
  )
}
