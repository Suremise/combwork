import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitDiff, ProjectInfo } from '@shared/types'
import type { CombworkStash, StashFile, StashList, StashRef, StashRow } from '@shared/gitStashes'
import { formatDateTime } from '@shared/dates'
import { msg, tr } from '@shared/i18n'
import { errorMessage } from '../api'
import { attempt } from '../actions'
import { cardNumberOf } from '../projectKeys'
import { offered, repoOp } from '../repoOps'
import { bumpGit, confirm, notify, set } from '../store'
import { DiffView } from './Editors'
import { languageFor } from '../monacoLang'
import { cx } from '../util'
import { Icon, IconButton, Tooltip } from './ui'

// HI-3472: Changes' Stashes, under HI-3470's operation panel: the repository's stashes (git shares them between its
// folders), each with its message, branch, date and how many files it holds; Show lists its files, a click on one
// showing its diff in place of the folder's; Apply and Pop act on the folder Changes shows, Drop on the repository.
// Combwork's own (Set Aside's, HI-2944) say which card or target made them. Every click asks first (Show doesn't) and
// is checked again in main (stashPanel.ts, gitStashes.ts).

export const STASH_TEXT = {
  title: msg({ id: 'git.stash.title', defaultMessage: 'Stashes', description: 'HI-3472: the heading of the list of git stashes in Version Control → Changes (glossary: stash, git\'s word: changes kept aside).' }),
  toggle: msg({ id: 'git.stash.toggle', defaultMessage: '{open, select, yes {Hide the stashes} other {Show the stashes}}', description: "HI-3472: the tooltip of the Stashes heading, a button that opens or closes the list." }),
  readFailed: msg({ id: 'git.stash.readFailed', defaultMessage: "Couldn't read the stashes: {error}", description: 'HI-3472: under the Stashes heading when reading them failed. {error} is why.' }),
  combwork: msg({
    id: 'git.stash.combwork',
    defaultMessage: '{why, select, merging {Set aside by Combwork before merging {card}} catchUp {Set aside by Combwork before bringing {target} up to date with {card}} starting {Set aside by Combwork before starting work on {target}} discarding {Set aside by Combwork before discarding {file}} restoring {Set aside by Combwork before restoring {file} from {from}} other {Set aside by Combwork {text}}}',
    description: "HI-3472: a stash's name in the list when Combwork's Set Aside made it (HI-2944: a paused merge's button). {card} is a card's key (HI-12), {target} a branch; discarding and restoring (HI-3477: the Files tab's Discard Changes… and Restore From…): {file} is a file's path, {from} a short commit id; other: {text} is Combwork's own English words after \"set aside\". Keep the select keys."
  }),
  meta: msg({ id: 'git.stash.meta', defaultMessage: '{branch, select, none {no branch} other {on {branch}}} · {when} · {files, plural, one {# file} other {# files}}', description: "HI-3472: under a stash's name: the branch it was made on ({branch}; none: a detached HEAD), when ({when}, a date and time) and how many files it holds." }),
  openCard: msg({ id: 'git.stash.openCard', defaultMessage: 'Open {card}', description: "HI-3472: the tooltip of a Combwork stash's card key: opens the card ({card}, its key)." }),
  show: msg({ id: 'git.stash.show', defaultMessage: 'Show', description: "HI-3472: a stash's button: lists its files (a click on one shows its changes). Nothing changes." }),
  hide: msg({ id: 'git.stash.hide', defaultMessage: 'Hide', description: "HI-3472: a stash's button while its files are listed: hides them." }),
  apply: msg({ id: 'git.stash.apply', defaultMessage: 'Apply', description: "HI-3472: a stash's button: puts its changes into the folder Changes shows, and keeps the stash (git stash apply)." }),
  pop: msg({ id: 'git.stash.pop', defaultMessage: 'Pop', description: "HI-3472: a stash's button: puts its changes into the folder, then drops the stash (git stash pop). Git's word: keep it short." }),
  drop: msg({ id: 'git.stash.drop', defaultMessage: 'Drop', description: "HI-3472: a stash's button: deletes the stash (git stash drop), after asking." }),
  applyTip: msg({ id: 'git.stash.applyTip', defaultMessage: 'Puts its changes into {folder} and keeps the stash. Runs git stash apply.', description: "HI-3472: Apply's tooltip. {folder} is a slot's name or the project folder (git.operation.projectFolder). Keep git stash apply as it is: a command." }),
  popTip: msg({ id: 'git.stash.popTip', defaultMessage: 'Puts its changes into {folder}, then drops the stash if they went in without a conflict. Runs git stash apply, then git stash drop.', description: "HI-3472: Pop's tooltip. {folder} as in git.stash.applyTip. Keep the git commands as they are." }),
  dropTip: msg({ id: 'git.stash.dropTip', defaultMessage: 'Deletes the stash, after asking. Runs git stash drop.', description: "HI-3472: Drop's tooltip. Keep git stash drop as it is: a command." }),
  filesLoading: msg({ id: 'git.stash.filesLoading', defaultMessage: 'Reading its files…', description: "HI-3472: under a stash while Show reads its files." }),
  filesFailed: msg({ id: 'git.stash.filesFailed', defaultMessage: "Couldn't read its files: {error}", description: "HI-3472: under a stash when Show couldn't read its files. {error} is why." }),
  untracked: msg({ id: 'git.stash.untracked', defaultMessage: 'untracked', description: "HI-3472: beside a stash's file: it was an untracked file (new, never added to git) when the stash was made." }),
  fileTip: msg({ id: 'git.stash.fileTip', defaultMessage: 'Shows its changes in the stash', description: "HI-3472: the tooltip of a stash's file: a click shows its diff." }),
  applyTitle: msg({ id: 'git.stash.applyTitle', defaultMessage: '{pop, select, yes {Pop the stash into {folder}?} other {Apply the stash to {folder}?}}', description: 'HI-3472: the question before Apply or Pop. {folder} is a slot\'s name or the project folder (git.operation.projectFolder).' }),
  applyMessage: msg({ id: 'git.stash.applyMessage', defaultMessage: '“{name}”: {files, plural, one {its # file goes} other {its # files go}} into {folder}. {pop, select, yes {The stash is then dropped, unless a file is in conflict: then it is kept.} other {The stash is kept.}}', description: 'HI-3472: under git.stash.applyTitle. {name} is the stash\'s name as the list shows it; {files} how many files it holds; {folder} as in the title.' }),
  otherBranch: msg({ id: 'git.stash.otherBranch', defaultMessage: 'It was made on {branch}, and {folder} has {current} checked out.', description: "HI-3472: added to the question before Apply or Pop when the stash was made on another branch ({branch}) than the one checked out in the folder ({current}); {folder} as in git.stash.applyTitle." }),
  lentTitle: msg({ id: 'git.stash.lentTitle', defaultMessage: '{slot} is lent to {card, select, none {lane {lane}} other {{card}}}', description: "HI-3472: the question before Apply or Pop in a slot lent to a card ({card}, its key) or a lane ({lane}, its name) whose builder isn't running. Glossary: slot, lane." }),
  lentMessage: msg({ id: 'git.stash.lentMessage', defaultMessage: 'Its builder, {agent}, finds the folder as you leave it. Put the stash into it anyway?', description: 'HI-3472: under git.stash.lentTitle. {agent} is the builder agent\'s name.' }),
  goOn: msg({ id: 'git.stash.goOn', defaultMessage: 'Go On', description: 'HI-3472: the button that confirms putting a stash into a lent slot (git.stash.lentTitle).' }),
  applied: msg({ id: 'git.stash.applied', defaultMessage: '{dropped, select, yes {Popped the stash into {folder}: it is dropped.} other {Applied the stash to {folder}: it is kept.}}', description: 'HI-3472: a notice after Apply or Pop went in without a conflict. {folder} as in git.stash.applyTitle.' }),
  conflicts: msg({ id: 'git.stash.conflicts', defaultMessage: '{count, plural, one {# file is} other {# files are}} in conflict in {folder}', description: 'HI-3472: the title of the warning after Apply or Pop left files in conflict. {folder} as in git.stash.applyTitle.' }),
  conflictsDetail: msg({ id: 'git.stash.conflictsDetail', defaultMessage: 'The stash is kept. Settle {files} (each shows its conflict markers), then drop the stash when you no longer need it.', description: "HI-3472: under git.stash.conflicts. {files} lists the files in conflict." }),
  failed: msg({ id: 'git.stash.failed', defaultMessage: "Git couldn't do that", description: 'HI-3472: the title of the error notice when Apply, Pop or Drop failed or was refused.' }),
  dropTitle: msg({ id: 'git.stash.dropTitle', defaultMessage: 'Drop the stash “{name}”?', description: "HI-3472: the question before Drop. {name} is the stash's name as the list shows it." }),
  dropMessage: msg({ id: 'git.stash.dropMessage', defaultMessage: 'Git deletes it, with {files, plural, one {the # file} other {the # files}} it holds{card, select, none {} other {, set aside for {card}}}. Its commit, {commit}, can still be found in a terminal for a while (git fsck --unreachable).', description: "HI-3472: under git.stash.dropTitle: what Drop loses. {files}: how many files; {card}: the card Combwork set it aside for (none: not one of Combwork's); {commit}: its short commit id. Keep git fsck --unreachable as it is: a command." }),
  dropped: msg({ id: 'git.stash.dropped', defaultMessage: 'Dropped the stash. Its commit was {commit}: git stash apply {commit} brings it back while git keeps it.', description: "HI-3472: a notice after Drop. {commit} is the stash's full commit id. Keep git stash apply as it is: a command." }),
  projectFolder: msg({ id: 'git.stash.projectFolder', defaultMessage: 'the project folder', description: 'HI-3472: {folder} in the Stashes dialogs and notices when the folder shown is the project folder.' }),
  diffFailed: msg({ id: 'git.stash.diffFailed', defaultMessage: "Couldn't show the file's changes in the stash: {error}", description: "HI-3472: in place of a stash file's diff when reading it failed. {error} is why." }),
  inStash: msg({ id: 'git.stash.inStash', defaultMessage: 'in the stash “{name}”', description: "HI-3472: beside a file's path above its diff when it is a stash's file: {name} is the stash's name." }),
  close: msg({ id: 'git.stash.close', defaultMessage: "Back to the folder's changes", description: "HI-3472: the tooltip of the button above a stash file's diff that goes back to the folder's own changes." }),
  inline: msg({ id: 'git.stash.inline', defaultMessage: '{inline, select, yes {Side by side} other {Inline}}', description: "HI-3472: the tooltip of the button above a stash file's diff that switches its view." }),
  binary: msg({ id: 'git.stash.binary', defaultMessage: 'Binary file', description: "HI-3472: in place of a stash file's diff when it is binary." })
}
const T = STASH_TEXT

/** A stash's name as the list shows it: Combwork's in its own words, else git's message. */
export function stashName(s: StashRow): string {
  const c: CombworkStash | null = s.combwork
  if (!c) return s.message
  return tr(T.combwork, { why: c.why, card: 'card' in c ? c.card : '', target: 'target' in c ? c.target : '', file: 'file' in c ? c.file : '', from: c.why === 'restoring' ? c.from : '', text: c.why === 'other' ? c.text : '' })
}

/** The card a Combwork stash names, if any. */
const cardOf = (s: StashRow): string | null => (s.combwork && 'card' in s.combwork ? s.combwork.card : null)

/** HI-3527: a row's key: several rows can hold one commit (`git stash store`), so a row is its place and its commit. */
const rowKey = (s: StashRow): string => `${s.index}:${s.commit}`

/** A row as Drop and Pop name it. */
const refOf = (s: StashRow): StashRef => ({ commit: s.commit, index: s.index, message: s.message })

/** A stash file shown in place of the folder's diff. */
export interface StashFileShown {
  root: string
  commit: string
  /** The row it was shown from (rowKey). */
  row: string
  name: string
  file: StashFile
}

/**
 * HI-3472: the Stashes section, under the operation panel, for the Changes root `root` (`folder`: its name, null for the
 * project folder; `branch` what it has checked out). Read again whenever `reloadKey` changes and after each action.
 */
export function StashesSection({ project, root, folder, branch, reloadKey, shown, onShow, onChanged }: { project: ProjectInfo; root: string; folder: string | null; branch: string | null; reloadKey: unknown; shown: StashFileShown | null; onShow: (f: StashFileShown | null) => void; onChanged: () => void }) {
  const [state, setState] = useState<{ for: string; list: StashList | null; error?: string } | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [files, setFiles] = useState<{ row: string; files: StashFile[] | null; error?: string } | null>(null)
  const reads = useRef(0)
  const read = useCallback(() => {
    if (!offered('git:stashes')) return
    const n = ++reads.current
    void repoOp('git:stashes', root).then(
      (list) => n === reads.current && setState({ for: root, list }),
      (e) => n === reads.current && setState({ for: root, list: null, error: errorMessage(e) })
    )
  }, [root])
  useEffect(read, [read, reloadKey])
  const confirmed = useRef<string | null>(null)
  if (!offered('git:stashes')) return null
  const mine = state?.for === root ? state : null
  if (mine?.error) return <div className="banner warn stash-section" data-stash-error="">{tr(T.readFailed, { error: mine.error })}</div>
  const list = mine?.list
  if (!list || !list.stashes.length) return null
  const where = folder ?? tr(T.projectFolder)
  const agentName = (id: string): string => project.agents.find((a) => a.id === id)?.name ?? id

  const after = (): void => {
    bumpGit(project.path)
    read()
    onChanged()
  }

  const toggleFiles = (s: StashRow): void => {
    const row = rowKey(s)
    if (files?.row === row) {
      setFiles(null)
      if (shown?.row === row) onShow(null)
      return
    }
    setFiles({ row, files: null })
    void repoOp('git:stashFiles', root, s.commit).then(
      (f) => setFiles((x) => (x?.row === row ? { row, files: f } : x)),
      (e) => setFiles((x) => (x?.row === row ? { row, files: null, error: errorMessage(e) } : x))
    )
  }

  const apply = async (s: StashRow, pop: boolean): Promise<void> => {
    if (busy) return
    const other = s.branch && branch && s.branch !== branch ? ` ${tr(T.otherBranch, { branch: s.branch, folder: where, current: branch })}` : ''
    const ok = await confirm({ title: tr(T.applyTitle, { pop: pop ? 'yes' : 'no', folder: where }), message: tr(T.applyMessage, { name: stashName(s), files: s.files, folder: where, pop: pop ? 'yes' : 'no' }) + other, confirmLabel: tr(pop ? T.pop : T.apply) })
    if (!ok) return
    if (list.lent && confirmed.current !== list.lent.lease) {
      const go = await confirm({ title: tr(T.lentTitle, { slot: list.lent.slot, card: list.lent.card ?? 'none', lane: list.lent.lane ?? '' }), message: tr(T.lentMessage, { agent: agentName(list.lent.agent) }), confirmLabel: tr(T.goOn) })
      if (!go) return
      confirmed.current = list.lent.lease
    }
    setBusy(`${pop ? 'pop' : 'apply'}:${rowKey(s)}`)
    const r = await attempt(tr(T.failed), () => repoOp('git:applyStash', root, { ...refOf(s), pop, ...(list.lent ? { lease: list.lent.lease } : {}) }))
    setBusy(null)
    after()
    if (!r) return
    if (r.conflicts.length) notify('warning', tr(T.conflicts, { count: r.conflicts.length, folder: where }), tr(T.conflictsDetail, { files: r.conflicts.join(', ') }))
    else notify('success', tr(T.applied, { dropped: r.dropped ? 'yes' : 'no', folder: where }))
  }

  const drop = async (s: StashRow): Promise<void> => {
    if (busy) return
    const ok = await confirm({ title: tr(T.dropTitle, { name: stashName(s) }), message: tr(T.dropMessage, { files: s.files, card: cardOf(s) ?? 'none', commit: s.commit.slice(0, 10) }), confirmLabel: tr(T.drop), danger: true })
    if (!ok) return
    setBusy(`drop:${rowKey(s)}`)
    const r = await attempt(tr(T.failed), () => repoOp('git:dropStash', root, refOf(s)).then(() => true))
    setBusy(null)
    if (shown?.row === rowKey(s)) onShow(null)
    after()
    if (r) notify('success', tr(T.dropped, { commit: s.commit }))
  }

  return (
    <div className="stash-section" data-stashes={list.stashes.length}>
      <Tooltip content={tr(T.toggle, { open: open ? 'yes' : 'no' })}>
        <button type="button" className="stash-head" data-action="stashes-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} /> <strong>{tr(T.title)}</strong> <span className="badge">{list.stashes.length}</span>
        </button>
      </Tooltip>
      {open && (
        <div className="stash-list">
          {list.stashes.map((s) => {
            const card = cardOf(s)
            const n = card ? cardNumberOf(card) : null
            const off = !!busy
            const row = rowKey(s)
            const showing = files?.row === row
            return (
              <div key={row} className="stash-row" data-stash={s.commit} data-stash-index={s.index} data-combwork={s.combwork ? s.combwork.why : undefined}>
                <div className="stash-line">
                  <div className="stash-name">
                    <span className="label" title={s.message}>
                      {stashName(s)}
                    </span>
                    {card && n !== null && (
                      <Tooltip content={tr(T.openCard, { card })}>
                        <button type="button" className="btn small subtle" data-action="stash-card" onClick={() => set({ taskOpen: n })}>
                          {card}
                        </button>
                      </Tooltip>
                    )}
                    <div className="faint stash-meta">{tr(T.meta, { branch: s.branch ?? 'none', when: formatDateTime(s.at), files: s.files })}</div>
                  </div>
                  <span className="stash-actions">
                    <button type="button" className="btn small" data-action="stash-show" onClick={() => toggleFiles(s)}>
                      {tr(showing ? T.hide : T.show)}
                    </button>
                    <Tooltip content={tr(T.applyTip, { folder: where })}>
                      <button type="button" className="btn small" data-action="stash-apply" disabled={off} onClick={() => void apply(s, false)}>
                        {busy === `apply:${row}` && <Icon name="loading" spin />} {tr(T.apply)}
                      </button>
                    </Tooltip>
                    <Tooltip content={tr(T.popTip, { folder: where })}>
                      <button type="button" className="btn small" data-action="stash-pop" disabled={off} onClick={() => void apply(s, true)}>
                        {busy === `pop:${row}` && <Icon name="loading" spin />} {tr(T.pop)}
                      </button>
                    </Tooltip>
                    <Tooltip content={tr(T.dropTip)}>
                      <button type="button" className="btn small" data-action="stash-drop" disabled={off} onClick={() => void drop(s)}>
                        {busy === `drop:${row}` && <Icon name="loading" spin />} {tr(T.drop)}
                      </button>
                    </Tooltip>
                  </span>
                </div>
                {showing && (
                  <div className="stash-files">
                    {files.error ? (
                      <div className="faint">{tr(T.filesFailed, { error: files.error })}</div>
                    ) : !files.files ? (
                      <div className="faint">
                        <Icon name="loading" spin /> {tr(T.filesLoading)}
                      </div>
                    ) : (
                      files.files.map((f) => (
                        <Tooltip block key={`${f.untracked ? 'u' : 't'}:${f.path}`} content={tr(T.fileTip)}>
                          <div className={cx('row', shown?.row === row && shown.file.path === f.path && shown.file.untracked === f.untracked && 'selected')} data-stash-file={f.path} onClick={() => onShow({ root, commit: s.commit, row, name: stashName(s), file: f })}>
                            <span className="label">{f.path}</span>
                            {f.untracked && <span className="faint">{tr(T.untracked)}</span>}
                            <span className={cx('git-status', f.untracked ? 'U' : f.status)}>{f.untracked ? 'U' : f.status /* i18n-ignore: git's status letter */}</span>
                          </div>
                        </Tooltip>
                      ))
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** HI-3472: a stash's file, in place of the folder's diff: as it was where the stash was made against the stash's. */
export function StashFileDiff({ shown, onClose }: { shown: StashFileShown; onClose: () => void }) {
  const key = `${shown.root}\0${shown.commit}\0${shown.file.untracked ? 'u' : 't'}\0${shown.file.path}`
  const [state, setState] = useState<{ for: string; diff: GitDiff | null; error?: string } | null>(null)
  const [inline, setInline] = useState(false)
  useEffect(() => {
    let live = true
    void repoOp('git:stashDiff', shown.root, shown.commit, shown.file.path, shown.file.untracked).then(
      (diff) => live && setState({ for: key, diff }),
      (e) => live && setState({ for: key, diff: null, error: errorMessage(e) })
    )
    return () => {
      live = false
    }
  }, [key, shown.root, shown.commit, shown.file.path, shown.file.untracked])
  const mine = state?.for === key ? state : null
  return (
    <>
      <div className="editor-toolbar" data-stash-diff={shown.file.path}>
        <Icon name="archive" />
        <span className="path">
          <strong>{shown.file.path}</strong> <span className="faint">{tr(T.inStash, { name: shown.name })}</span>
        </span>
        <IconButton icon={inline ? 'split-horizontal' : 'list-flat'} title={tr(T.inline, { inline: inline ? 'yes' : 'no' })} onClick={() => setInline(!inline)} />
        <IconButton icon="close" action="stash-diff-close" title={tr(T.close)} onClick={onClose} />
      </div>
      <div className="editor-host">
        {mine?.error ? (
          <div className="empty-state">
            <Icon name="error" /> {tr(T.diffFailed, { error: mine.error })}
          </div>
        ) : !mine?.diff ? (
          <div className="empty-state">
            <Icon name="loading" spin />
          </div>
        ) : mine.diff.binary ? (
          <div className="empty-state">{mine.diff.modified || tr(T.binary)}</div>
        ) : (
          <DiffView original={mine.diff.original} modified={mine.diff.modified} language={languageFor(mine.diff.path)} inline={inline} />
        )}
      </div>
    </>
  )
}
