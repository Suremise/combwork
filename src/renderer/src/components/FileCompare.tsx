import { useEffect, useState } from 'react'
import { compareRefOk, type CompareChoices, type CompareVersion } from '@shared/fileCompare'
import { msg, tr } from '@shared/i18n'
import { call, errorMessage } from '../api'
import { languageFor } from '../monacoLang'
import { cx } from '../util'
import { DiffView } from './Editors'
import { Icon, Modal, SearchInput } from './ui'

// HI-3478: Compare with… in the Files tab's viewer (SPEC §8, Compare a file): the file as the editor has it (its live
// text, unsaved edits included and labelled) against its version on the target branch, a branch, tag or commit (its
// path there found across renames, in main), or in a slot or worktree the project folder's copy. It shows over the
// editor, which stays as it was beneath; Back to file returns to it.

export const FILE_COMPARE_TEXT = {
  open: msg({ id: 'files.compare.open', defaultMessage: 'Compare with…', description: "HI-3478: the Files tab's toolbar button (and right-click menu item) that compares the file with its version on another branch, tag or commit, or the project folder's copy." }),
  title: msg({ id: 'files.compare.title', defaultMessage: 'Compare {name} with…', description: "HI-3478: the title of Compare with…'s picker. {name} is the file's name." }),
  target: msg({ id: 'files.compare.target', defaultMessage: 'Target branch ({branch})', description: "HI-3478: Compare with…'s first choice: the branch this folder's work merges into ({branch}, its name)." }),
  projectCopy: msg({ id: 'files.compare.projectCopy', defaultMessage: "The project folder's copy", description: "HI-3478: Compare with…'s choice in an agent's slot or worktree: the same file in the project folder, as it is on disk there." }),
  branches: msg({ id: 'files.compare.branches', defaultMessage: 'Branches', description: "HI-3478: a heading in Compare with…'s picker." }),
  tags: msg({ id: 'files.compare.tags', defaultMessage: 'Tags', description: "HI-3478: a heading in Compare with…'s picker." }),
  search: msg({ id: 'files.compare.search', defaultMessage: 'Branch, tag or commit', description: "HI-3478: the placeholder of Compare with…'s search box: filters the list, and a name or commit hash typed and Enter compares with it." }),
  typedRef: msg({ id: 'files.compare.typedRef', defaultMessage: 'Compare with “{ref}”', description: "HI-3478: in Compare with…'s picker, the choice that compares with exactly what was typed ({ref}: a branch, tag or commit hash)." }),
  badRef: msg({ id: 'files.compare.badRef', defaultMessage: 'Type a branch, tag or commit hash: not an option or a range.', description: "HI-3478: in Compare with…'s picker, what was typed can't be one (it starts with a dash, or holds spaces, .. or ~)." }),
  loading: msg({ id: 'files.compare.loading', defaultMessage: 'Reading…', description: "HI-3478: Compare with…'s picker, or its diff, while it reads." }),
  failed: msg({ id: 'files.compare.failed', defaultMessage: "Couldn't compare: {error}", description: 'HI-3478: in place of the comparison when reading the other version failed. {error} is why.' }),
  back: msg({ id: 'files.compare.back', defaultMessage: 'Back to file', description: "HI-3478: the button atop a comparison: shows the file's editor again, as it was left (unsaved edits kept)." }),
  heading: msg({ id: 'files.compare.heading', defaultMessage: '{side} ← → this file', description: "HI-3478: the heading of a comparison: the other version on the left ({side}, e.g. 'main · 1a2b3c4' or 'the project folder's copy'), the file as the editor has it on the right." }),
  refSide: msg({ id: 'files.compare.refSide', defaultMessage: '{ref} · {commit}', description: "HI-3478: the left side's name in a comparison: what was chosen ({ref}: a branch, tag or the commit's short id) and its commit's short id." }),
  projectSide: msg({ id: 'files.compare.projectSide', defaultMessage: "the project folder's copy", description: "HI-3478: the left side's name in a comparison with the project folder's copy (used inside files.compare.heading)." }),
  renamed: msg({ id: 'files.compare.renamed', defaultMessage: 'There it was {path}.', description: "HI-3478: under a comparison's heading: at the other version the file had another path ({path}), followed across a rename." }),
  notThere: msg({ id: 'files.compare.notThere', defaultMessage: "This file isn't in {side} under its name or a rename git found: the left side is empty.", description: "HI-3478: under a comparison's heading: the other version ({side}) has no such file (deleted there, never there, or renamed in a way git didn't follow)." }),
  notFile: msg({ id: 'files.compare.notFile', defaultMessage: 'In {side} this path is a folder or submodule, not a file.', description: "HI-3478: under a comparison's heading: at the other version ({side}) the file's path is a folder or a submodule." }),
  unsaved: msg({ id: 'files.compare.unsaved', defaultMessage: 'Right: your edits (not saved)', description: "HI-3478: under a comparison's heading when the editor has unsaved edits: the right side is the editor's text, not the file on disk." }),
  binary: msg({ id: 'files.compare.binary', defaultMessage: 'Binary or too large to compare as text.', description: "HI-3478: in place of a comparison when the other version is binary or too large." })
}
const T = FILE_COMPARE_TEXT

/** What the file is compared with: a branch, tag or commit (`path`: its path there when known), or the project folder's copy. */
export type CompareSource = { kind: 'ref'; ref: string; path: string | null } | { kind: 'project'; folder: string }

/** HI-3478: Compare with…'s picker for the file `name` in the folder `root`. */
export function ComparePicker({ root, name, onPick, onClose }: { root: string; name: string; onPick: (s: CompareSource) => void; onClose: () => void }) {
  const [choices, setChoices] = useState<{ data: CompareChoices | null; error?: string } | null>(null)
  const [q, setQ] = useState('')
  useEffect(() => {
    let live = true
    void call('files:compareChoices', root).then(
      (data) => live && setChoices({ data }),
      (e) => live && setChoices({ data: null, error: errorMessage(e) })
    )
    return () => {
      live = false
    }
  }, [root])
  const c = choices?.data ?? null
  const typed = q.trim()
  const match = (n: string): boolean => !typed || n.toLowerCase().includes(typed.toLowerCase())
  const branches = (c?.branches ?? []).filter((b) => match(b.name))
  const tags = (c?.tags ?? []).filter((t) => match(t.name))
  const exact = !!typed && [...branches, ...tags].some((r) => r.name === typed)
  const pickRef = (ref: string): void => onPick({ kind: 'ref', ref, path: null })
  const row = (label: string, onClick: () => void, key: string, sub?: string): React.ReactNode => (
    <div key={key} className="row compare-choice" role="button" tabIndex={0} data-compare-choice={key} onClick={onClick} onKeyDown={(e) => e.key === 'Enter' && onClick()}>
      <span className="label">{label}</span>
      {sub && <code className="faint">{sub.slice(0, 7)}</code>}
    </div>
  )
  return (
    <Modal title={tr(T.title, { name })} icon="git-compare" onClose={onClose}>
      <div className="compare-picker" data-compare-picker="">
        <SearchInput
          value={q}
          onChange={setQ}
          placeholder={tr(T.search)}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter' && typed && compareRefOk(typed)) pickRef(typed)
          }}
        />
        {choices?.error && <div className="banner warn">{tr(T.failed, { error: choices.error })}</div>}
        {!choices && (
          <p className="hint">
            <Icon name="loading" spin /> {tr(T.loading)}
          </p>
        )}
        <div className="compare-choices">
          {typed && !exact && (compareRefOk(typed) ? row(tr(T.typedRef, { ref: typed }), () => pickRef(typed), `typed:${typed}`) : <p className="hint">{tr(T.badRef)}</p>)}
          {!typed && c?.target && row(tr(T.target, { branch: c.target.name }), () => pickRef(c.target!.name), `target:${c.target.name}`, c.target.commit)}
          {!typed && c?.projectFolder && row(tr(T.projectCopy), () => onPick({ kind: 'project', folder: c.projectFolder! }), 'project')}
          {branches.length > 0 && <div className="faint compare-heading">{tr(T.branches)}</div>}
          {branches.map((b) => row(b.name, () => pickRef(b.name), `branch:${b.name}`, b.commit))}
          {tags.length > 0 && <div className="faint compare-heading">{tr(T.tags)}</div>}
          {tags.map((t) => row(t.name, () => pickRef(t.name), `tag:${t.name}`, t.commit))}
        </div>
      </div>
    </Modal>
  )
}

type Left = { kind: 'ref'; v: CompareVersion } | { kind: 'project'; text: string; there: boolean }

/** HI-3478: the comparison over the editor: `source`'s version on the left, the editor's live `text` on the right. */
export function CompareDiff({ root, rel, source, text, dirty, onBack }: { root: string; rel: string; source: CompareSource; text: string; dirty: boolean; onBack: () => void }) {
  const key = `${root}\n${rel}\n${source.kind === 'ref' ? `ref:${source.ref}:${source.path ?? ''}` : `project:${source.folder}`}`
  const [got, setGot] = useState<{ for: string; left: Left | null; error?: string } | null>(null)
  useEffect(() => {
    let live = true
    const read = async (): Promise<Left> => {
      if (source.kind === 'ref') return { kind: 'ref', v: await call('files:compareWith', root, rel, source.ref, source.path) }
      const c = await call('files:read', source.folder, rel).catch(() => null)
      return { kind: 'project', text: c?.kind === 'text' ? c.text : '', there: c?.kind === 'text' }
    }
    void read().then(
      (left) => live && setGot({ for: key, left }),
      (e) => live && setGot({ for: key, left: null, error: errorMessage(e) })
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const shown = got?.for === key ? got : null
  const left = shown?.left ?? null
  const side = !left ? '' : left.kind === 'ref' ? tr(T.refSide, { ref: left.v.ref.length === 40 ? left.v.short : left.v.ref, commit: left.v.short }) : tr(T.projectSide)
  const notes: React.ReactNode[] = []
  if (left?.kind === 'ref' && left.v.how === 'renamed' && left.v.path) notes.push(<div key="renamed" className="faint small">{tr(T.renamed, { path: left.v.path })}</div>)
  if ((left?.kind === 'ref' && left.v.state === 'missing') || (left?.kind === 'project' && !left.there)) notes.push(<div key="missing" className="faint small" data-compare-missing="">{tr(T.notThere, { side })}</div>)
  if (left?.kind === 'ref' && left.v.state === 'notFile') notes.push(<div key="notFile" className="faint small">{tr(T.notFile, { side })}</div>)
  if (dirty) notes.push(<div key="unsaved" className="faint small" data-compare-unsaved="">{tr(T.unsaved)}</div>)
  const original = !left ? '' : left.kind === 'ref' ? left.v.text : left.text
  return (
    <div className="history-diff compare-diff" data-compare-diff={left?.kind === 'ref' ? left.v.commit : left?.kind ?? ''}>
      <div className="history-diff-head">
        <button className="btn small" data-action="compare-back" onClick={onBack}>
          <Icon name="arrow-left" /> {tr(T.back)}
        </button>
        {left && <strong className={cx('compare-heading')}>{tr(T.heading, { side })}</strong>}
      </div>
      {notes}
      {shown?.error ? (
        <div className="empty-state">
          <Icon name="error" /> {tr(T.failed, { error: shown.error })}
        </div>
      ) : !left ? (
        <div className="empty-state">
          <Icon name="loading" spin /> {tr(T.loading)}
        </div>
      ) : left.kind === 'ref' && left.v.binary ? (
        <div className="empty-state">{tr(T.binary)}</div>
      ) : (
        <div className="editor-host">
          <DiffView original={original} modified={text} language={languageFor(rel)} inline={false} />
        </div>
      )}
    </div>
  )
}
