import { useEffect, useRef, useState } from 'react'
import { msg, tr } from '@shared/i18n'
import { nameGuard, offersNameGuard, type MergeGuard } from '@shared/workflow/mergeGuards'
import { useStore } from '../store'
import { Icon, Tooltip } from './ui'

// Version Control → Workflow → Merge guards (HI-3284): a row per guard (its name, pattern, case, the paths it applies to
// and skips, and its message), added, removed and moved; and the example guard that keeps the user's name out of the
// code (Darren's decision, 15 Nov), offered only when Settings → General gives a name, and filled in once.

const T = {
  none: msg({ id: 'workflow.mergeGuards.none', defaultMessage: 'No merge guards.', description: 'Under “Merge guards” (Version Control → Workflow) when there are none (HI-3284).' }),
  name: msg({ id: 'workflow.mergeGuards.name', defaultMessage: 'Name', description: 'The placeholder and label of a merge guard’s name field (HI-3284).' }),
  pattern: msg({ id: 'workflow.mergeGuards.pattern', defaultMessage: 'Pattern (regular expression)', description: 'The placeholder and label of a merge guard’s pattern field: a JavaScript regular expression (HI-3284).' }),
  ignoreCase: msg({ id: 'workflow.mergeGuards.ignoreCase', defaultMessage: 'Ignore case', description: 'A checkbox on a merge guard: its pattern matches capitals and small letters alike (HI-3284).' }),
  paths: msg({ id: 'workflow.mergeGuards.paths', defaultMessage: 'Only these paths (e.g. src/**, *.ts)', description: 'The placeholder and label of a merge guard’s field of paths it applies to, as globs separated by commas; empty means every file (HI-3284). Keep the examples as they are.' }),
  skip: msg({ id: 'workflow.mergeGuards.skip', defaultMessage: 'Skip these paths (e.g. LICENSE, docs/**)', description: 'The placeholder and label of a merge guard’s field of paths it skips, as globs separated by commas (HI-3284). Keep the examples as they are.' }),
  message: msg({ id: 'workflow.mergeGuards.message', defaultMessage: 'What to do instead', description: 'The placeholder and label of a merge guard’s message: what the builder is told to do instead when the guard matches (HI-3284).' }),
  remove: msg({ id: 'workflow.mergeGuards.remove', defaultMessage: 'Remove', description: 'The tooltip of the button removing a merge guard (HI-3284).' }),
  up: msg({ id: 'workflow.mergeGuards.up', defaultMessage: 'Move up', description: 'The tooltip of the button moving a merge guard up the list (HI-3284).' }),
  down: msg({ id: 'workflow.mergeGuards.down', defaultMessage: 'Move down', description: 'The tooltip of the button moving a merge guard down the list (HI-3284).' }),
  add: msg({ id: 'workflow.mergeGuards.add', defaultMessage: 'Add Guard', description: 'A button under the merge guards: adds an empty one (HI-3284).' }),
  addName: msg({ id: 'workflow.mergeGuards.addName', defaultMessage: 'Add “Keep My Name Out of the Code”', description: 'A button under the merge guards (HI-3284, Darren’s decision): adds a ready-made guard refusing the user’s own name (Settings → General → Your name) in what a merge adds. The quoted part is the guard’s name, as workflow.mergeGuards.nameGuard.' }),
  nameGuard: msg({ id: 'workflow.mergeGuards.nameGuard', defaultMessage: 'Keep my name out of the code', description: 'The name the ready-made merge guard is given (HI-3284): it refuses the user’s own name in what a merge adds. The user can rename it.' }),
  nameMessage: msg({ id: 'workflow.mergeGuards.nameMessage', defaultMessage: 'Your name is in this change. Cite the card or decision instead, or skip this file if a name belongs here.', description: 'The message the ready-made merge guard is given (HI-3284, Darren’s wording): what the builder is told when the user’s name is in what a merge adds. Card: a task on Combwork’s board. The user can edit it.' }),
  example: msg({ id: 'workflow.mergeGuards.example', defaultMessage: 'Fills in a guard once from your name in Settings → General; edit or remove it like any other.', description: 'The tooltip of the button adding the ready-made “Keep my name out of the code” merge guard (HI-3284).' })
}

type Row = { name: string; pattern: string; ignoreCase: boolean; paths: string; skip: string; message: string }

const rowOf = (g: MergeGuard): Row => ({ name: g.name, pattern: g.pattern, ignoreCase: !!g.ignoreCase, paths: (g.paths ?? []).join(', '), skip: (g.skip ?? []).join(', '), message: g.message })
const globs = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
const guardOf = (r: Row): MergeGuard => {
  const paths = globs(r.paths)
  const skip = globs(r.skip)
  return { name: r.name.trim(), pattern: r.pattern, ...(r.ignoreCase ? { ignoreCase: true } : {}), ...(paths.length ? { paths } : {}), ...(skip.length ? { skip } : {}), message: r.message.trim() }
}

/** The merge guards' rows: typed freely, taken as a field loses focus (as the checks' rows are). */
export function MergeGuardsEditor({ guards, onChange }: { guards: MergeGuard[]; onChange: (guards: MergeGuard[]) => void }) {
  const userName = useStore((s) => s.settings?.general.userName ?? '')
  const given = JSON.stringify(guards)
  const [rows, setRows] = useState<Row[]>(() => guards.map(rowOf))
  // What it last gave back: the props coming back as that keep the rows as typed; anything else replaces them.
  const sent = useRef(given)
  useEffect(() => {
    if (given === sent.current) return
    sent.current = given
    setRows((JSON.parse(given) as MergeGuard[]).map(rowOf))
  }, [given])
  const commit = (next: Row[]): void => {
    const out = next.map(guardOf)
    sent.current = JSON.stringify(out)
    onChange(out)
  }
  const edit = <K extends keyof Row>(i: number, part: K, v: Row[K]): void => setRows(rows.map((x, j) => (j === i ? { ...x, [part]: v } : x)))
  const change = (next: Row[]): void => {
    setRows(next)
    commit(next)
  }
  const move = (i: number, by: -1 | 1): void => {
    const next = [...rows]
    ;[next[i], next[i + by]] = [next[i + by], next[i]]
    change(next)
  }
  return (
    <div className="workflow-stack workflow-guards" data-note="merge-guards">
      {!rows.length && <div className="s-desc">{tr(T.none)}</div>}
      {rows.map((r, i) => (
        <div className="workflow-guard" key={i} data-guard={i}>
          <div className="workflow-guard-head">
            <input className="input" value={r.name} placeholder={tr(T.name)} aria-label={tr(T.name)} onChange={(e) => edit(i, 'name', e.target.value)} onBlur={() => commit(rows)} />
            <Tooltip content={tr(T.up)}>
              <button className="btn subtle small" aria-label={tr(T.up)} disabled={i === 0} onClick={() => move(i, -1)}>
                <Icon name="arrow-up" />
              </button>
            </Tooltip>
            <Tooltip content={tr(T.down)}>
              <button className="btn subtle small" aria-label={tr(T.down)} disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
                <Icon name="arrow-down" />
              </button>
            </Tooltip>
            <Tooltip content={tr(T.remove)}>
              <button className="btn subtle small" aria-label={tr(T.remove)} onClick={() => change(rows.filter((_x, j) => j !== i))}>
                <Icon name="close" />
              </button>
            </Tooltip>
          </div>
          <input className="input mono" value={r.pattern} placeholder={tr(T.pattern)} aria-label={tr(T.pattern)} spellCheck={false} onChange={(e) => edit(i, 'pattern', e.target.value)} onBlur={() => commit(rows)} />
          <label className="flex">
            <input type="checkbox" className="checkbox" checked={r.ignoreCase} onChange={(e) => change(rows.map((x, j) => (j === i ? { ...x, ignoreCase: e.target.checked } : x)))} /> {tr(T.ignoreCase)}
          </label>
          <input className="input mono" value={r.paths} placeholder={tr(T.paths)} aria-label={tr(T.paths)} spellCheck={false} onChange={(e) => edit(i, 'paths', e.target.value)} onBlur={() => commit(rows)} />
          <input className="input mono" value={r.skip} placeholder={tr(T.skip)} aria-label={tr(T.skip)} spellCheck={false} onChange={(e) => edit(i, 'skip', e.target.value)} onBlur={() => commit(rows)} />
          <input className="input" value={r.message} placeholder={tr(T.message)} aria-label={tr(T.message)} onChange={(e) => edit(i, 'message', e.target.value)} onBlur={() => commit(rows)} />
        </div>
      ))}
      <div className="flex">
        <button className="btn subtle small" onClick={() => change([...rows, { name: '', pattern: '', ignoreCase: false, paths: '', skip: '', message: '' }])}>
          {tr(T.add)}
        </button>
        {offersNameGuard(userName) && (
          <Tooltip content={tr(T.example)}>
            <button className="btn subtle small" data-note="name-guard" onClick={() => change([...rows, rowOf(nameGuard(userName, tr(T.nameGuard), tr(T.nameMessage)))])}>
              {tr(T.addName)}
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
