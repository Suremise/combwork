import { useCallback, useEffect, useState } from 'react'
import type { CopyView, ProjectConfig, ProjectInfo, SlotView } from '@shared/types'
import { COPIES_REVIEW } from '@shared/advanced'
import { reviewsWork, agentWorkflowRole } from '@shared/workflow/roles'
import { msg, tr } from '@shared/i18n'
import * as actions from '../actions'
import { call } from '../api'
import { useAdvancedValue } from '../advanced'
import { cardLabelOf, openVersionControl, set as setStore, setActivity, useStore } from '../store'
import { NumberField } from './NumberField'
import { Icon } from './ui'

/**
 * The Version Control tab's Slots and copies group (#1445, SPEC §16.10.2, §16.10.5), Git only, beside the workflow
 * options: these aren't rules but the project's slot and copy settings (project.json `slots` and `copies`), each saved
 * as it is changed. With cards built in slots (G11): the setup and archive scripts and the files copied into a new slot,
 * each showing where its value comes from when unset (Agents & Worktrees' setup command and copied files, as before
 * 1.0), and the slots in use or ready. With any G11: the review and check copies' pool size and whether reviewers review
 * in them (Settings → Advanced's switch).
 */

const T = {
  heading: msg({ id: 'workflow.slots.heading', defaultMessage: 'Slots and copies', description: 'A heading of the Version Control tab’s Workflow section (Git): the project’s slots (worktrees Hive lends to cards and lanes) and its review and check copies (glossary 2.5: slot, review copy).' }),
  desc: msg({ id: 'workflow.slots.desc', defaultMessage: 'These are saved as you change them, apart from the options above.', description: 'Under the heading “Slots and copies”: its settings save at once, unlike the workflow options, which are saved with Save….' }),
  setup: msg({ id: 'workflow.slots.setup', defaultMessage: 'Setup script', description: 'A setting under “Slots and copies”: the command Hive runs in a new slot, and again when its lock files change (glossary 2.5: slot).' }),
  setupDesc: msg({ id: 'workflow.slots.setupDesc', defaultMessage: 'Runs in a new slot, and again in a slot whose lock files changed since its last install, e.g. npm ci. Review and check copies run it too.', description: 'What the setting “Setup script” does (glossary 2.5: slot, review copy; lock file).' }),
  archive: msg({ id: 'workflow.slots.archive', defaultMessage: 'Archive script', description: 'A setting under “Slots and copies”: the command Hive runs in a slot before removing it.' }),
  archiveDesc: msg({ id: 'workflow.slots.archiveDesc', defaultMessage: 'Runs in a slot before Hive removes it. If it fails, the slot is kept.', description: 'What the setting “Archive script” does (glossary 2.5: slot).' }),
  copy: msg({ id: 'workflow.slots.copy', defaultMessage: 'Files copied into new slots', description: 'A setting under “Slots and copies”: the git-ignored files copied from the project folder into each new slot.' }),
  copyDesc: msg({ id: 'workflow.slots.copyDesc', defaultMessage: 'Git-ignored files copied from the project folder into each new slot, one pattern per line, such as .env files.', description: 'What the setting “Files copied into new slots” does (glossary 2.5: slot).' }),
  fromSetup: msg({ id: 'workflow.slots.fromSetup', defaultMessage: 'From Agents & Worktrees’ setup command', description: 'Where the setting “Setup script” comes from while it isn’t set: the project’s setup command of Project Settings → Agents & Worktrees (its name as translated there).' }),
  fromCopy: msg({ id: 'workflow.slots.fromCopy', defaultMessage: 'From Agents & Worktrees’ files to copy', description: 'Where the setting “Files copied into new slots” comes from while it isn’t set: Agents & Worktrees’ list of files to copy into new worktrees (its name as translated there).' }),
  none: msg({ id: 'workflow.slots.none', defaultMessage: 'None', description: 'A slot script that isn’t set: nothing runs.' }),
  setHere: msg({ id: 'workflow.slots.setHere', defaultMessage: 'Set for this project', description: 'Where a slot setting’s value comes from: set in this project.' }),
  inUse: msg({ id: 'workflow.slots.inUse', defaultMessage: 'Slots in use and ready', description: 'A read-only list under “Slots and copies”: the project’s slots, what each is lent to, and those ready (glossary 2.5: slot).' }),
  noSlots: msg({ id: 'workflow.slots.noSlots', defaultMessage: 'No slots yet: one is made when a card starts.', description: 'Under “Slots in use and ready” when the project has no slot yet.' }),
  branches: msg({ id: 'workflow.slots.branches', defaultMessage: 'Branches & remotes', description: 'A link from “Slots in use and ready” to the Version Control tab’s Branches & remotes section, where each slot’s line is (its name as translated there).' }),
  state: {
    creating: msg({ id: 'workflow.slots.state.creating', defaultMessage: 'Being set up', description: 'A slot’s state in the list under “Slots and copies”.' }),
    ready: msg({ id: 'workflow.slots.state.ready', defaultMessage: 'Ready', description: 'A slot’s state in the list under “Slots and copies”: free, set up.' }),
    lent: msg({ id: 'workflow.slots.state.lent', defaultMessage: 'In use', description: 'A slot’s state in the list under “Slots and copies”: lent to a card or a lane.' }),
    dirty: msg({ id: 'workflow.slots.state.dirty', defaultMessage: 'Has changes left in it', description: 'A slot’s state in the list under “Slots and copies”: it has uncommitted or untracked files, so it isn’t lent until clean.' }),
    gone: msg({ id: 'workflow.slots.state.gone', defaultMessage: 'Folder missing', description: 'A slot’s state in the list under “Slots and copies”: its folder is gone (Hive recreates it).' }),
    removing: msg({ id: 'workflow.slots.state.removing', defaultMessage: 'Being removed', description: 'A slot’s state in the list under “Slots and copies”.' })
  } satisfies Record<SlotView['state'], ReturnType<typeof msg>>,
  lentCard: msg({ id: 'workflow.slots.lentCard', defaultMessage: '{agent}, for {card}', description: 'What a slot is lent to, in the list under “Slots and copies”: the builder agent {agent} (its name) for the card {card} (its key, HI-12).' }),
  lentLane: msg({ id: 'workflow.slots.lentLane', defaultMessage: '{agent}, for a lane', description: 'What a slot is lent to, in the list under “Slots and copies”: the builder agent {agent} (its name) for its lane (glossary: lane).' }),
  carried: msg({ id: 'workflow.slots.carried', defaultMessage: '{agent}’s old worktree, finishing its current work', description: 'What a slot holds, in the list under “Slots and copies”: an agent’s worktree from before 1.0, kept for it until its current card or lane ends (#1441). {agent} is its name.' }),
  copiesSize: msg({ id: 'workflow.slots.copiesSize', defaultMessage: 'Review and check copies', description: 'A setting under “Slots and copies”: how many review and check copies the project keeps (glossary 2.5: review copy).' }),
  copiesSizeDesc: msg({ id: 'workflow.slots.copiesSizeDesc', defaultMessage: 'How many copies the project keeps, each at exactly one revision, for reviewers and isolated checks. Empty keeps the larger of two and its reviewers plus one. They use the setup script.', description: 'What the setting “Review and check copies” does (glossary 2.5: review copy; isolated checks: hive-progress --check --isolated).' }),
  copiesDefault: msg({ id: 'workflow.slots.copiesDefault', defaultMessage: '{n, number} (the default)', description: 'The placeholder of the setting “Review and check copies” while it isn’t set: the number Hive keeps.' }),
  copiesNow: msg({ id: 'workflow.slots.copiesNow', defaultMessage: '{n, plural, =0 {No copies yet.} one {# copy now, {leased, number} in use.} other {# copies now, {leased, number} in use.}}', description: 'Under the setting “Review and check copies”: how many copies the project has now, and how many are leased.' }),
  reviewCopies: msg({ id: 'workflow.slots.reviewCopies', defaultMessage: 'Reviewers review in review copies', description: 'A read-only row under “Slots and copies”: the setting of Settings → Advanced with this name (as translated there).' }),
  reviewCopiesDesc: msg({ id: 'workflow.slots.reviewCopiesDesc', defaultMessage: 'Set in Settings → Advanced, for every project.', description: 'Under the row “Reviewers review in review copies” of “Slots and copies”: where it is changed.' }),
  on: msg({ id: 'workflow.slots.on', defaultMessage: 'On', description: 'A setting’s value: on.' }),
  off: msg({ id: 'workflow.slots.off', defaultMessage: 'Off', description: 'A setting’s value: off.' }),
  openAdvanced: msg({ id: 'workflow.slots.openAdvanced', defaultMessage: 'Open Advanced', description: 'A button beside “Reviewers review in review copies”: opens Settings → Advanced.' })
}

/** A slot's line in the list: what it is lent to (or carries), in words. */
function lentText(s: SlotView, agentName: (id: string) => string, card: (n: number) => string): string | null {
  const l = s.lease
  if (!l) return null
  if (l.kind === 'carried') return tr(T.carried, { agent: agentName(l.agent) })
  if (l.card !== null) return tr(T.lentCard, { agent: agentName(l.agent), card: card(l.card) })
  return tr(T.lentLane, { agent: agentName(l.agent) })
}

export function SlotsAndCopies({ project, slots }: { project: ProjectInfo; slots: boolean }) {
  const settings = useStore((s) => s.settings)
  const tasks = useStore((s) => s.tasks)
  const reviewOn = useAdvancedValue<boolean>(COPIES_REVIEW) !== false
  const cfg = project.config
  const [list, setList] = useState<SlotView[] | null>(null)
  const [copies, setCopies] = useState<CopyView[] | null>(null)
  const reload = useCallback(() => {
    void call('slots:list', project.path).then(setList, () => setList([]))
    void call('copies:list', project.path).then(setCopies, () => setCopies([]))
  }, [project.path])
  useEffect(reload, [reload, project.config])
  const update = async (patch: Partial<ProjectConfig>): Promise<void> => {
    await actions.attempt(tr(msg({ id: 'workflow.slots.saveFailed', defaultMessage: 'Couldn’t save the slot settings', description: 'An error saving a setting under “Slots and copies”.' })), () => call('project:updateConfig', project.path, patch))
    await actions.refreshWorkspace()
  }
  /** A slot setting: its own value set, or left out to fall back (an empty field). */
  const setSlot = (key: 'setup' | 'archive' | 'copy', v: string): Promise<void> => {
    const next = { ...cfg.slots }
    if (v.trim()) next[key] = key === 'copy' ? v : v.trim()
    else delete next[key]
    return update({ slots: next })
  }
  const copySize = cfg.copies?.size ?? null
  const reviewers = project.agents.filter((a) => reviewsWork(agentWorkflowRole(a))).length
  const defaultSize = Math.max(2, reviewers + 1)
  const agentName = (id: string): string => project.agents.find((a) => a.id === id)?.name ?? id
  const card = (n: number): string => cardLabelOf({ tasks }, n)
  const setupOwn = cfg.slots?.setup
  const copyOwn = cfg.slots?.copy
  const copyInherited = cfg.worktreeCopy ?? settings?.agents.worktreeCopy ?? ''
  return (
    <section className="workflow-group workflow-slots" data-group="slots">
      <h3 className="workflow-group-h">{tr(T.heading)}</h3>
      <div className="s-desc">{tr(T.desc)}</div>
      {slots && (
        <>
          <div className="setting" data-slot-option="setup">
            <div className="s-text">
              <div className="s-title">
                {setupOwn !== undefined && <span className="modified" />}
                {tr(T.setup)}
              </div>
              <div className="s-desc">{tr(T.setupDesc)}</div>
              <div className="s-desc workflow-origin" data-origin={setupOwn !== undefined ? 'project' : 'worktreeSetup'}>
                {setupOwn !== undefined ? tr(T.setHere) : `${tr(T.fromSetup)}: ${cfg.worktreeSetup.trim() || tr(T.none)}`}
              </div>
            </div>
            <div className="s-control">
              <Field value={setupOwn ?? ''} placeholder={cfg.worktreeSetup.trim() || 'npm ci'} onCommit={(v) => void setSlot('setup', v)} /> {/* i18n-ignore: an example command */}
            </div>
          </div>
          <div className="setting" data-slot-option="archive">
            <div className="s-text">
              <div className="s-title">
                {cfg.slots?.archive !== undefined && <span className="modified" />}
                {tr(T.archive)}
              </div>
              <div className="s-desc">{tr(T.archiveDesc)}</div>
            </div>
            <div className="s-control">
              <Field value={cfg.slots?.archive ?? ''} placeholder={tr(T.none)} onCommit={(v) => void setSlot('archive', v)} />
            </div>
          </div>
          <div className="setting" data-slot-option="copy">
            <div className="s-text">
              <div className="s-title">
                {copyOwn !== undefined && <span className="modified" />}
                {tr(T.copy)}
              </div>
              <div className="s-desc">{tr(T.copyDesc)}</div>
              <div className="s-desc workflow-origin" data-origin={copyOwn !== undefined ? 'project' : 'worktreeCopy'}>
                {copyOwn !== undefined ? tr(T.setHere) : `${tr(T.fromCopy)}: ${copyInherited.trim() || tr(T.none)}`}
              </div>
            </div>
            <div className="s-control">
              <Field multiline value={copyOwn ?? ''} placeholder={copyInherited} onCommit={(v) => void setSlot('copy', v)} />
            </div>
          </div>
          <div className="setting wide" data-slot-option="slots">
            <div className="s-text">
              <div className="s-title">{tr(T.inUse)}</div>
              {list && !list.length && <div className="s-desc">{tr(T.noSlots)}</div>}
              {list && list.length > 0 && (
                <table className="workflow-slots-table">
                  <tbody>
                    {list.map((s) => (
                      <tr key={s.name} data-slot={s.name} data-state={s.state}>
                        <td className="mono">{s.name}</td>
                        <td>{tr(T.state[s.state])}</td>
                        <td>{lentText(s, agentName, card) ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <button className="btn subtle small" data-action="open-branches" onClick={() => openVersionControl(project.path, 'branches')}>
                <Icon name="git-branch" /> {tr(T.branches)}
              </button>
            </div>
          </div>
        </>
      )}
      <div className="setting" data-slot-option="copies">
        <div className="s-text">
          <div className="s-title">
            {copySize !== null && <span className="modified" />}
            {tr(T.copiesSize)}
          </div>
          <div className="s-desc">{tr(T.copiesSizeDesc)}</div>
          {copies && <div className="s-desc">{tr(T.copiesNow, { n: copies.length, leased: copies.filter((c) => c.lease && !c.lease.returned).length })}</div>}
        </div>
        <div className="s-control">
          <NumberField value={copySize} min={1} max={32} step={1} label={tr(T.copiesSize)} inherit={tr(T.copiesDefault, { n: defaultSize })} onCommit={(v) => update({ copies: v === null ? {} : { size: v } })} />
        </div>
      </div>
      <div className="setting" data-slot-option="reviewCopies">
        <div className="s-text">
          <div className="s-title">{tr(T.reviewCopies)}</div>
          <div className="s-desc">{tr(T.reviewCopiesDesc)}</div>
        </div>
        <div className="s-control workflow-readonly">
          <strong data-value={reviewOn ? 'on' : 'off'}>{tr(reviewOn ? T.on : T.off)}</strong>
          <button className="btn subtle small" onClick={() => (setStore({ settingsSection: 'advanced', settingsQuery: tr(T.reviewCopies) }), setActivity('settings'))}>
            {tr(T.openAdvanced)}
          </button>
        </div>
      </div>
    </section>
  )
}

/** A field taken when it loses focus or on Enter (a script, a list of patterns). */
function Field({ value, placeholder, onCommit, multiline }: { value: string; placeholder: string; onCommit: (v: string) => void; multiline?: boolean }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  if (multiline) return <textarea className="input mono" rows={3} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={() => text !== value && onCommit(text)} />
  return <input className="input mono" value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={() => text !== value && onCommit(text)} onKeyDown={(e) => e.key === 'Enter' && text !== value && onCommit(text)} />
}
