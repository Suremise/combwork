import { useCallback, useEffect, useRef, useState } from 'react'
import type { CopyView, GitFilesStatus, ProjectInfo, SlotView, WorkflowLevel } from '@shared/types'
import { SLOT_COPY_TEXT, type SlotLevelForm, type SlotOptionOrigin } from '@shared/slotDefaults'
import { COPIES_REVIEW } from '@shared/advanced'
import { reviewsWork, agentWorkflowRole } from '@shared/workflow/roles'
import { fmt, msg, tr } from '@shared/i18n'
import { revisionShort } from '@shared/platform/descriptors'
import * as actions from '../actions'
import { call } from '../api'
import { useAdvancedValue } from '../advanced'
import { cardLabelOf, confirm, notify, openVersionControl, set as setStore, setActivity, useStore } from '../store'
import { NumberField } from './NumberField'
import { Icon, Switch } from './ui'
import { ORIGIN_TEXT } from '../workflowOrigins'
import { OriginText } from './OriginText'

/**
 * The Version Control tab's Slots and copies group (#1445, SPEC §16.10.2, §16.10.5), Git only, beside the workflow
 * options: these aren't rules but the project's slot and copy settings (project.json `slots` and `copies`), each saved
 * as it is changed. With cards built in slots (G11): the setup and archive scripts and the files copied into a new slot,
 * each showing where its value comes from when unset (the setup command from before 1.0; the copied files as they
 * inherit, HI-1765: the workspace's, Combwork's, the default), and the slots in use or ready. With any G11: the review and check copies' pool size and whether reviewers review
 * in them (Settings → Advanced's switch).
 */

const T = {
  heading: msg({ id: 'workflow.slots.heading', defaultMessage: 'Slots and copies', description: 'A heading of the Version Control tab’s Workflow section (Git): the project’s slots (worktrees Combwork lends to cards and lanes) and its review and check copies (glossary 2.5: slot, review copy).' }),
  desc: msg({ id: 'workflow.slots.desc', defaultMessage: 'These are saved as you change them, apart from the options above.', description: 'Under the heading “Slots and copies”: its settings save at once, unlike the workflow options, which are saved with Save….' }),
  setup: msg({ id: 'workflow.slots.setup', defaultMessage: 'Setup script', description: 'A setting under “Slots and copies”: the command Combwork runs in a new slot, and again when its lock files change (glossary 2.5: slot).' }),
  setupDesc: msg({ id: 'workflow.slots.setupDesc', defaultMessage: 'Runs in a new slot, and again in a slot whose lock files changed since its last install, e.g. npm ci. Review and check copies run it too.', description: 'What the setting “Setup script” does (glossary 2.5: slot, review copy; lock file).' }),
  archive: msg({ id: 'workflow.slots.archive', defaultMessage: 'Archive script', description: 'A setting under “Slots and copies”: the command Combwork runs in a slot before removing it.' }),
  archiveDesc: msg({ id: 'workflow.slots.archiveDesc', defaultMessage: 'Runs in a slot before Combwork removes it. If it fails, the slot is kept.', description: 'What the setting “Archive script” does (glossary 2.5: slot).' }),
  copy: msg({ id: 'workflow.slots.copy', defaultMessage: 'Files copied into new slots', description: 'A setting under “Slots and copies”: the git-ignored files copied from the project folder into each new slot.' }),
  copyDesc: msg({ id: 'workflow.slots.copyDesc', defaultMessage: 'Git-ignored files copied from the project folder into each new slot, one pattern per line, such as .env files.', description: 'What the setting “Files copied into new slots” does (glossary 2.5: slot).' }),
  fromSetup: msg({ id: 'workflow.slots.fromSetup', defaultMessage: 'From the project’s setup command before 1.0', description: 'Where the setting “Setup script” comes from while it isn’t set: the setup command the project had for agents’ worktrees before 1.0.' }),
  none: msg({ id: 'workflow.slots.none', defaultMessage: 'None', description: 'A slot script that isn’t set: nothing runs.' }),
  setNone: msg({ id: 'workflow.slots.setNone', defaultMessage: 'Set for this project: none', description: 'Where a slot setting’s value comes from: this project sets it to nothing (no script runs, no files are copied), over the value it would inherit.' }),
  toNone: msg({ id: 'workflow.slots.useNone', defaultMessage: 'Set to none', description: 'A button beside a slot setting this project inherits (from the workspace, Combwork’s settings or before 1.0): set it to nothing for this project (no script runs, no files are copied).' }),
  inherit: msg({ id: 'workflow.slots.inherit', defaultMessage: 'Inherit', description: 'A button beside a slot setting set for this project: stop setting it here, and use the inherited value again (the workspace’s, Combwork’s or the default).' }),
  setHere: msg({ id: 'workflow.slots.setHere', defaultMessage: 'Set for this project', description: 'Where a slot setting’s value comes from: set in this project.' }),
  inUse: msg({ id: 'workflow.slots.inUse', defaultMessage: 'Slots in use and ready', description: 'A read-only list under “Slots and copies”: the project’s slots, what each is lent to, and those ready (glossary 2.5: slot).' }),
  noSlots: msg({ id: 'workflow.slots.noSlots', defaultMessage: 'No slots yet: one is made when a card starts.', description: 'Under “Slots in use and ready” when the project has no slot yet.' }),
  branches: msg({ id: 'workflow.slots.branches', defaultMessage: 'Branches & remotes', description: 'A link from “Slots in use and ready” to the Version Control tab’s Branches & remotes section, where each slot’s line is (its name as translated there).' }),
  state: {
    creating: msg({ id: 'workflow.slots.state.creating', defaultMessage: 'Being set up', description: 'A slot’s state in the list under “Slots and copies”.' }),
    ready: msg({ id: 'workflow.slots.state.ready', defaultMessage: 'Ready', description: 'A slot’s state in the list under “Slots and copies”: free, set up.' }),
    lent: msg({ id: 'workflow.slots.state.lent', defaultMessage: 'In use', description: 'A slot’s state in the list under “Slots and copies”: lent to a card or a lane.' }),
    dirty: msg({ id: 'workflow.slots.state.dirty', defaultMessage: 'Has changes left in it', description: 'A slot’s state in the list under “Slots and copies”: it has uncommitted or untracked files, so it isn’t lent until clean.' }),
    gone: msg({ id: 'workflow.slots.state.gone', defaultMessage: 'Folder missing', description: 'A slot’s state in the list under “Slots and copies”: its folder is gone (Combwork recreates it).' }),
    removing: msg({ id: 'workflow.slots.state.removing', defaultMessage: 'Being removed', description: 'A slot’s state in the list under “Slots and copies”.' })
  } satisfies Record<SlotView['state'], ReturnType<typeof msg>>,
  // HI-2869: a stale jj slot and its recovery (J9a's explicit action).
  stale: msg({ id: 'workflow.slots.stale', defaultMessage: 'Stale: another jj workspace changed it', description: 'Beside a jj slot in the list under “Slots and copies” (HI-2869): its files are behind its working-copy commit because another jj workspace rewrote it; it isn’t lent until recovered. “workspace” is jj’s term.' }),
  recover: msg({ id: 'workflow.slots.recover', defaultMessage: 'Recover…', description: 'A button beside a stale jj slot (HI-2869): brings it up to date, keeping any edits jj hadn’t recorded (asks first).' }),
  recoverTitle: msg({ id: 'workflow.slots.recoverTitle', defaultMessage: 'Recover {slot}?', description: 'The title of the confirmation before recovering a stale jj slot (HI-2869). {slot} is the slot’s name.' }),
  recoverMessage: msg({ id: 'workflow.slots.recoverMessage', defaultMessage: 'Combwork copies any edits jj hadn’t recorded in it aside first, into the folder below, then brings the slot up to date with jj. It runs only while nothing works in the slot.', description: 'The confirmation before recovering a stale jj slot (HI-2869); the folder edits are copied into is listed under it.' }),
  recovered: msg({ id: 'workflow.slots.recovered', defaultMessage: '{slot} is recovered.', description: 'A notice after a stale jj slot was recovered (HI-2869).' }),
  // HI-2996: what Recover… did, when there is something to look at.
  recoveredTitle: msg({ id: 'workflow.slots.recoveredTitle', defaultMessage: '{slot} is recovered: look at these', description: 'HI-2996: the title of the window shown after a stale jj slot ({slot}, its name) was recovered, when the recovery left something for the user to look at: copies it wrote, deleted files it kept, or a commit it kept.' }),
  recoveredCopies: msg({ id: 'workflow.slots.recoveredCopies', defaultMessage: '{n, plural, one {# file had changed meanwhile, so your version of it was written beside it, under the name below.} other {# files had changed meanwhile, so your version of each was written beside it, under the names below.}} Compare them, keep what you want under the original name, then delete the copies: a card’s work that holds one can’t be submitted.', description: 'HI-2996: after a stale jj slot was recovered: files the user had edited (not yet recorded by jj) had also changed in the update, so Combwork kept the update in the file and wrote the user’s version beside it as a copy (listed under this, as paths). The user compares and deletes the copies; a card can’t be submitted for review while they are in its work.' }),
  recoveredPutBack: msg({ id: 'workflow.slots.recoveredPutBack', defaultMessage: '{n, plural, =0 {No other file needed putting back.} one {# other file was put back as it was.} other {# other files were put back as they were.}}', description: 'HI-2996: after a stale jj slot was recovered, the number of the user’s edited files put back unchanged (nothing to look at for these).' }),
  recoveredKeptDeleted: msg({ id: 'workflow.slots.recoveredKeptDeleted', defaultMessage: '{n, plural, one {You had deleted {files}, but it changed or came back meanwhile, so it was kept.} other {You had deleted {files}, but they changed or came back meanwhile, so they were kept.}}', description: 'HI-2996: after a stale jj slot was recovered: files the user had deleted there (not yet recorded by jj) changed in the update or were created again, so Combwork kept them rather than deleting them. {files} lists their paths, joined as a list.' }),
  recoveredAsides: msg({ id: 'workflow.slots.recoveredAsides', defaultMessage: '{n, plural, one {# file was created again during the recovery, so the version it had before was left beside it: {files}.} other {# files were created again during the recovery, so the version each had before was left beside it: {files}.}} Keep what you want of it, then delete it.', description: 'HI-2996: after a stale jj slot was recovered: while it put files back, something created some of them again, so Combwork left the version the file had just before (moved aside) under another name beside it. {files} lists their full paths, joined as a list. The user keeps what they want and deletes that copy.' }),
  recoveredDivergent: msg({ id: 'workflow.slots.recoveredDivergent', defaultMessage: 'jj also kept commit {commit}, which holds what it recorded of the slot during the recovery. It shows as divergent in jj: once you’ve looked at it, abandon it with jj abandon {commit}.', description: 'HI-2996: after a stale jj slot was recovered, jj made a commit of the slot’s files that Combwork couldn’t prove was only what it kept, so it left it (a divergent change in jj). {commit} is its short id. jj abandon is a command: keep it as it is.' }),
  notRecovered: msg({ id: 'workflow.slots.notRecovered', defaultMessage: '{slot} wasn’t recovered: {why, select, busy {something works in it (an agent working there: stop it first)} preparing {its card is still being prepared there} notStale {it isn’t stale any more} identity {its folder isn’t the workspace Combwork made} other {jj couldn’t do it}}.', description: 'A notice after recovering a stale jj slot was refused (HI-2869, HI-2913). {why} picks the reason: busy (something works in the slot, such as the agent of the lane holding it, which the user stops first), preparing (the card the slot is lent to is still being prepared there), and the others. Keep the select keys.' }),
  keptState: msg({ id: 'workflow.slots.state.kept', defaultMessage: 'Holds a card’s commits', description: 'HI-2995: a jj slot’s state in the list under “Slots and copies”, in place of “Has changes left in it”: it holds the commits of a card that was put back (named beside it, workflow.slots.keptFor), not uncommitted files.' }),
  keptFor: msg({ id: 'workflow.slots.keptFor', defaultMessage: 'Kept for {card}: its committed work isn’t in the target yet', description: 'HI-2995: beside a jj slot in the list under “Slots and copies”: the card {card} (its key, HI-12) was put back with commits that aren’t in its target yet, and the slot holds them, so it is kept for that card and given back to it when it starts again; no other card is lent it.' }),
  lentCard: msg({ id: 'workflow.slots.lentCard', defaultMessage: '{agent}, for {card}', description: 'What a slot is lent to, in the list under “Slots and copies”: the builder agent {agent} (its name) for the card {card} (its key, HI-12).' }),
  lentLane: msg({ id: 'workflow.slots.lentLane', defaultMessage: '{agent}, for a lane', description: 'What a slot is lent to, in the list under “Slots and copies”: the builder agent {agent} (its name) for its lane (glossary: lane).' }),
  carried: msg({ id: 'workflow.slots.carried', defaultMessage: '{agent}’s old worktree, finishing its current work', description: 'What a slot holds, in the list under “Slots and copies”: an agent’s worktree from before 1.0, kept for it until its current card or lane ends (#1441). {agent} is its name.' }),
  copiesSize: msg({ id: 'workflow.slots.copiesSize', defaultMessage: 'Review and check copies', description: 'A setting under “Slots and copies”: how many review and check copies the project keeps (glossary 2.5: review copy).' }),
  copiesSizeDesc: msg({ id: 'workflow.slots.copiesSizeDesc', defaultMessage: 'How many copies the project keeps, each at exactly one revision, for reviewers and isolated checks. Empty keeps the larger of two and its reviewers plus one. They use the setup script.', description: 'What the setting “Review and check copies” does (glossary 2.5: review copy; isolated checks: cw-progress --check --isolated).' }),
  copiesDefault: msg({ id: 'workflow.slots.copiesDefault', defaultMessage: '{n, number} (the default)', description: 'The placeholder of the setting “Review and check copies” while it isn’t set: the number Combwork keeps.' }),
  copiesNow: msg({ id: 'workflow.slots.copiesNow', defaultMessage: '{n, plural, =0 {No copies yet.} one {# copy now, {leased, number} in use.} other {# copies now, {leased, number} in use.}}', description: 'Under the setting “Review and check copies”: how many copies the project has now, and how many are leased.' }),
  reviewCopies: msg({ id: 'workflow.slots.reviewCopies', defaultMessage: 'Reviewers review in review copies', description: 'A read-only row under “Slots and copies”: the setting of Settings → Advanced with this name (as translated there).' }),
  reviewCopiesDesc: msg({ id: 'workflow.slots.reviewCopiesDesc', defaultMessage: 'Set in Settings → Advanced, for every project.', description: 'Under the row “Reviewers review in review copies” of “Slots and copies”: where it is changed.' }),
  on: msg({ id: 'workflow.slots.on', defaultMessage: 'On', description: 'A setting’s value: on.' }),
  off: msg({ id: 'workflow.slots.off', defaultMessage: 'Off', description: 'A setting’s value: off.' }),
  held: msg({ id: 'workflow.slots.held', defaultMessage: 'Held by an ended session of agent {agent}', description: "In the list of slots (Version Control → Slots and copies): the agent's ({agent}) last session there has ended, but Combwork doesn't know that everything it started has, so nothing else uses the slot until it is released (#1506). A noun before the name (glossary §1 rule 4)." }),
  release: msg({ id: 'workflow.slots.release', defaultMessage: 'Release…', description: 'A button beside a held slot in the list of slots: asks, then frees it for other work (#1506).' }),
  openAdvanced: msg({ id: 'workflow.slots.openAdvanced', defaultMessage: 'Open Advanced', description: 'A button beside “Reviewers review in review copies”: opens Settings → Advanced.' }),
  gitFiles: msg({ id: 'workflow.slots.gitFiles', defaultMessage: 'Set up submodules and LFS', description: 'A switch under “Slots and copies” (HI-1182): whether Combwork checks out the repository’s submodules and fetches its Git LFS files in each slot and copy it makes. Keep LFS (Git LFS, a product’s name).' }),
  gitFilesDesc: msg({ id: 'workflow.slots.gitFilesDesc', defaultMessage: 'Before the setup script, checks out submodules and fetches Git LFS files in each new slot, in each review and check copy, and in the merge queue’s folder. Without it, they have empty submodule folders and LFS pointer files.', description: 'What the switch “Set up submodules and LFS” does (HI-1182; glossary 2.5: slot, review copy). Keep Git LFS (a product’s name); pointer files are the small text files Git LFS keeps in place of the real ones.' }),
  gitFilesSubmodules: msg({ id: 'workflow.slots.gitFilesSubmodules', defaultMessage: '{n, plural, one {This project has # submodule.} other {This project has # submodules.}}', description: 'Under the switch “Set up submodules and LFS” (HI-1182): how many submodules the project folder’s repository has.' }),
  gitFilesLfs: msg({ id: 'workflow.slots.gitFilesLfs', defaultMessage: 'It uses Git LFS ({version}).', description: 'Under the switch “Set up submodules and LFS” (HI-1182): the project uses Git LFS, and git-lfs is installed. {version} is git-lfs’s own version line, such as git-lfs/3.8.1 (GitHub; windows amd64; go 1.27.3). Keep Git LFS.' }),
  gitFilesNoFilter: msg({ id: 'workflow.slots.gitFilesNoFilter', defaultMessage: 'It uses Git LFS, but it isn’t set up for this repository: slots and copies can’t be prepared until you run git lfs install.', description: 'Under the switch “Set up submodules and LFS” (HI-1182): git-lfs is installed but its filter isn’t configured, so LFS files would stay pointer files. Keep Git LFS and the command git lfs install as they are.' }),
  gitFilesNoLfs: msg({ id: 'workflow.slots.gitFilesNoLfs', defaultMessage: 'It uses Git LFS, but git-lfs isn’t installed: slots and copies can’t be prepared until it is. Turning this off skips the step, but where your git config requires the LFS filter, git itself still can’t check files out.', description: 'Under the switch “Set up submodules and LFS” (HI-1182): the project uses Git LFS and the git-lfs program can’t be found. Keep Git LFS and git-lfs (a product and its program).' }),
  saveFailed: msg({ id: 'workflow.slots.saveFailed', defaultMessage: 'Couldn’t save the slot settings', description: 'An error saving a setting under “Slots and copies”.' }),
  levelNone: msg({ id: 'workflow.slots.levelNone', defaultMessage: 'Set here: none', description: 'Where a slot default’s value comes from, in Settings → Workflow defaults or Settings → Workspace: this level sets it to nothing (no files are copied), over the value it would inherit.' }),
  levelInherit: msg({ id: 'workflow.slots.levelInherit', defaultMessage: 'Inherit', description: 'A button beside a slot default set at this level (Settings → Workflow defaults or Settings → Workspace): stop setting it here, and use the inherited value (Combwork’s, or the default).' })
}

/** Where an inherited slot option comes from (HI-1765), in the workflow options' words. */
const copyOrigin = (o: SlotOptionOrigin) => (o === 'default' ? 'platform' : o)

/** A slot's line in the list: what it is lent to (or carries), in words. */
function lentText(s: SlotView, agentName: (id: string) => string, card: (n: number) => string): string | null {
  const l = s.lease
  if (!l) return s.keptFor !== undefined ? tr(T.keptFor, { card: card(s.keptFor) }) : null
  if (l.kind === 'carried') return tr(T.carried, { agent: agentName(l.agent) })
  if (l.card !== null) return tr(T.lentCard, { agent: agentName(l.agent), card: card(l.card) })
  return tr(T.lentLane, { agent: agentName(l.agent) })
}

/** A held slot's words and its Release… (HI-1886: the Worktrees list in Branches & remotes shows them too). */
export const SLOT_HELD_TEXT = { held: T.held, release: T.release }

export function SlotsAndCopies({ project, slots }: { project: ProjectInfo; slots: boolean }) {
  const tasks = useStore((s) => s.tasks)
  const reviewOn = useAdvancedValue<boolean>(COPIES_REVIEW) !== false
  const cfg = project.config
  const [list, setList] = useState<SlotView[] | null>(null)
  const [copies, setCopies] = useState<CopyView[] | null>(null)
  const [copyNow, setCopyNow] = useState<{ value: string; origin: SlotOptionOrigin } | null>(null)
  const [gitFiles, setGitFiles] = useState<GitFilesStatus | null>(null)
  const reload = useCallback(() => {
    void call('slots:list', project.path).then(setList, () => setList([]))
    void call('copies:list', project.path).then(setCopies, () => setCopies([]))
    void call('slots:copyOf', project.path).then(setCopyNow, () => setCopyNow(null))
    void call('slots:gitFiles', project.path).then(setGitFiles, () => setGitFiles(null))
  }, [project.path])
  // Combwork's slot defaults are the settings' (a change there reaches every project's tab); the workspace's come with it.
  const levels = useStore((s) => s.settings?.slotDefaults)
  const wsLevels = useStore((s) => s.workspace?.config.slotDefaults)
  useEffect(reload, [reload, project.config, levels, wsLevels])
  // Each setting saved on its own, one key under the project's lock in main (HR5's round 1: never the whole `slots` as this
  // window last read it), and each field's saves in the order made. A save that fails shows what is stored again.
  const queues = useRef(new Map<string, Promise<void>>())
  const [shown, setShown] = useState(0)
  const save = (key: 'setup' | 'archive' | 'copy' | 'copiesSize' | 'gitFiles', value: string | number | boolean | null): Promise<void> => {
    const next = (queues.current.get(key) ?? Promise.resolve()).then(async () => {
      const done = await actions.attempt(tr(T.saveFailed), () => call('slots:setSetting', project.path, key, value))
      await actions.refreshWorkspace()
      if (!done) setShown((x) => x + 1)
    })
    queues.current.set(key, next)
    return next
  }
  /**
   * A field's text as the project's own value. The setup script and copied files: emptied, it is "none" (nothing runs, no
   * file is copied, over the inherited value). An inherited one has Set to none (HR5's round 2: an empty field over an inherited value
   * isn't a change), and one set here Inherit. The archive script has nothing to inherit.
   */
  const setSlot = (key: 'setup' | 'archive' | 'copy', v: string): Promise<void> => save(key, key === 'archive' && !v.trim() ? null : v)
  const copySize = cfg.copies?.size ?? null
  const reviewers = project.agents.filter((a) => reviewsWork(agentWorkflowRole(a))).length
  const defaultSize = Math.max(2, reviewers + 1)
  const agentName = (id: string): string => project.agents.find((a) => a.id === id)?.name ?? id
  const card = (n: number): string => cardLabelOf({ tasks }, n)
  const setupOwn = cfg.slots?.setup
  // The project's own copy: its slots.copy, else its worktreeCopy from before 1.0 (HI-1765); what it inherits otherwise,
  // and from where, is main's (slots:copyOf, the one resolver).
  const copyOwn = cfg.slots?.copy ?? cfg.worktreeCopy ?? undefined
  const copyInherited = copyNow && copyNow.origin !== 'project' ? copyNow.value : ''
  // HI-1182: shown where the project folder uses submodules or Git LFS, or where it was turned off.
  const gitFilesOff = cfg.slots?.gitFiles === false
  const gitFilesShown = gitFilesOff || (!!gitFiles && (gitFiles.submodules > 0 || gitFiles.lfs))
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
              <div className="s-desc workflow-origin" data-origin={setupOwn === undefined ? 'worktreeSetup' : setupOwn.trim() ? 'project' : 'none'}>
                {setupOwn === undefined ? `${tr(T.fromSetup)}: ${cfg.worktreeSetup.trim() || tr(T.none)}` : tr(setupOwn.trim() ? T.setHere : T.setNone)}
                {setupOwn !== undefined ? (
                  <button className="btn subtle small workflow-inherit" data-action="inherit-setup" onClick={() => void save('setup', null)}>
                    {tr(T.inherit)}
                  </button>
                ) : (
                  <button className="btn subtle small workflow-inherit" data-action="none-setup" onClick={() => void save('setup', '')}>
                    {tr(T.toNone)}
                  </button>
                )}
              </div>
            </div>
            <div className="s-control">
              <Field key={`setup-${shown}`} value={setupOwn ?? ''} placeholder={setupOwn !== undefined ? tr(T.none) : cfg.worktreeSetup.trim() || 'npm ci'} onCommit={(v) => void setSlot('setup', v)} /> {/* i18n-ignore: an example command */}
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
              <Field key={`archive-${shown}`} value={cfg.slots?.archive ?? ''} placeholder={tr(T.none)} onCommit={(v) => void setSlot('archive', v)} />
            </div>
          </div>
          <div className="setting" data-slot-option="copy">
            <div className="s-text">
              <div className="s-title">
                {copyOwn !== undefined && <span className="modified" />}
                {tr(T.copy)}
              </div>
              <div className="s-desc">{tr(T.copyDesc)}</div>
              <div className="s-desc workflow-origin" data-origin={copyOwn === undefined ? (copyNow?.origin ?? 'default') : copyOwn.trim() ? 'project' : 'none'}>
                {copyOwn === undefined ? (
                  <>
                    <OriginText origin={copyOrigin(copyNow?.origin ?? 'default')} />: {copyInherited.trim() || tr(T.none)}
                  </>
                ) : (
                  tr(copyOwn.trim() ? T.setHere : T.setNone)
                )}
                {copyOwn !== undefined ? (
                  <button className="btn subtle small workflow-inherit" data-action="inherit-copy" onClick={() => void save('copy', null)}>
                    {tr(T.inherit)}
                  </button>
                ) : (
                  <button className="btn subtle small workflow-inherit" data-action="none-copy" onClick={() => void save('copy', '')}>
                    {tr(T.toNone)}
                  </button>
                )}
              </div>
            </div>
            <div className="s-control">
              <Field key={`copy-${shown}`} multiline value={copyOwn ?? ''} placeholder={copyOwn !== undefined ? tr(T.none) : copyInherited} onCommit={(v) => void setSlot('copy', v)} />
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
                        <td>
                          {s.keptFor !== undefined ? tr(T.keptState) : tr(T.state[s.state])}
                          {s.stale && (
                            <>
                              {' · '}
                              <span className="s-desc" data-stale="">
                                {tr(T.stale)}
                              </span>
                            </>
                          )}
                        </td>
                        <td data-kept-for={s.keptFor}>{lentText(s, agentName, card) ?? ''}</td>
                        <td>
                          {s.stale && (
                            <button className="btn subtle small" data-action="recover" onClick={() => void recoverSlot(project.path, s, reload)}>
                              {tr(T.recover)}
                            </button>
                          )}
                          {s.writer?.held && (
                            <>
                              <span className="s-desc" data-held={s.writer.agent}>
                                {tr(T.held, { agent: agentName(s.writer.agent) })}
                              </span>{' '}
                              <button className="btn subtle small" data-action="release-held" onClick={() => void actions.releaseHeldSlot(project.path, s.name).then(reload)}>
                                {tr(T.release)}
                              </button>
                            </>
                          )}
                        </td>
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
      {gitFilesShown && (
        <div className="setting" data-slot-option="gitFiles">
          <div className="s-text">
            <div className="s-title">
              {gitFilesOff && <span className="modified" />}
              {tr(T.gitFiles)}
            </div>
            <div className="s-desc">{tr(T.gitFilesDesc)}</div>
            {gitFiles && gitFiles.submodules > 0 && <div className="s-desc" data-git-files="submodules">{tr(T.gitFilesSubmodules, { n: gitFiles.submodules })}</div>}
            {gitFiles?.lfs && (
              <div className="s-desc" data-git-files={!gitFiles.lfsVersion ? 'noLfs' : gitFiles.lfsFilter ? 'lfs' : 'noFilter'}>
                {!gitFiles.lfsVersion ? tr(T.gitFilesNoLfs) : gitFiles.lfsFilter ? tr(T.gitFilesLfs, { version: gitFiles.lfsVersion }) : tr(T.gitFilesNoFilter)}
              </div>
            )}
          </div>
          <div className="s-control">
            <Switch checked={!gitFilesOff} label={tr(T.gitFiles)} onChange={(v) => void save('gitFiles', v ? null : false)} />
          </div>
        </div>
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
          <NumberField value={copySize} min={1} max={32} step={1} label={tr(T.copiesSize)} inherit={tr(T.copiesDefault, { n: defaultSize })} onCommit={(v) => save('copiesSize', v)} />
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

/**
 * A level's copied files (HI-1765), in Settings → Workflow defaults (Git: Combwork's) and Settings → Workspace's workflow
 * defaults: its own patterns, none, or inherit (the workspace's: Combwork's; Combwork's: the default), saved as it is changed.
 * Its projects inherit it in Version Control → Slots and copies.
 */
export function SlotCopyLevel({ level }: { level: WorkflowLevel }) {
  const workspacePath = useStore((s) => s.workspace?.path ?? '')
  const [form, setForm] = useState<SlotLevelForm | null>(null)
  const [shown, setShown] = useState(0)
  // Read again when either level changes, from here or elsewhere (the settings tool, another window: HR5's round 1): Combwork's
  // come with the settings, the workspace's with the workspace. Only the latest read or save counts.
  const levels = useStore((s) => s.settings?.slotDefaults)
  const wsLevels = useStore((s) => s.workspace?.config.slotDefaults)
  const latest = useRef(0)
  useEffect(() => {
    const n = ++latest.current
    void call('slots:levelForm', level).then(
      (f) => n === latest.current && setForm(f),
      () => n === latest.current && setForm(null)
    )
  }, [level, workspacePath, levels, wsLevels])
  useEffect(
    () => () => {
      latest.current++
    },
    []
  )
  const save = async (value: string | null): Promise<void> => {
    const n = ++latest.current
    const next = await actions.attempt(tr(T.saveFailed), () => call('slots:setLevelDefault', level, 'copy', value))
    if (next && n === latest.current) setForm(next)
    else if (!next) setShown((x) => x + 1)
    // The projects' tabs read it again: Combwork's comes with the settings, the workspace's with the workspace.
    if (level === 'workspace') await actions.refreshWorkspace()
  }
  if (!form) return null
  const own = form.own.copy
  const inherited = form.inherited.copy
  return (
    <div className="setting" data-slot-default="copy" data-level={level}>
      <div className="s-text">
        <div className="s-title">
          {own !== undefined && <span className="modified" />}
          {tr(SLOT_COPY_TEXT.title)}
        </div>
        <div className="s-desc">{tr(SLOT_COPY_TEXT.desc)}</div>
        <div className="s-desc workflow-origin" data-origin={own === undefined ? inherited.origin : own.trim() ? 'here' : 'none'}>
          {own === undefined ? (
            <>
              <OriginText origin={copyOrigin(inherited.origin)} />: {inherited.value.trim() || tr(T.none)}
            </>
          ) : (
            tr(own.trim() ? ORIGIN_TEXT.here : T.levelNone)
          )}
          {own !== undefined ? (
            <button className="btn subtle small workflow-inherit" data-action="inherit-copy" onClick={() => void save(null)}>
              {tr(T.levelInherit)}
            </button>
          ) : (
            <button className="btn subtle small workflow-inherit" data-action="none-copy" onClick={() => void save('')}>
              {tr(T.toNone)}
            </button>
          )}
        </div>
      </div>
      <div className="s-control">
        <Field key={`copy-${shown}`} multiline value={own ?? ''} placeholder={own !== undefined ? tr(T.none) : inherited.value} onCommit={(v) => void save(v)} />
      </div>
    </div>
  )
}

/** A field taken when it loses focus or on Enter (a script, a list of patterns). */
function Field({ value, placeholder, onCommit, multiline }: { value: string; placeholder: string; onCommit: (v: string) => void; multiline?: boolean }) {
  const [text, setText] = useState(value)
  // A value changed elsewhere shows at once, but not over text the user typed since the last commit: only typing is
  // theirs (HR5's round 2: a field merely focused takes the new value, and leaving it saves nothing).
  const typed = useRef(false)
  useEffect(() => {
    if (!typed.current) setText(value)
  }, [value])
  const type = (v: string): void => {
    typed.current = true
    setText(v)
  }
  const commit = (): void => {
    // Untyped, the text is already the latest value (or one just committed, on its way).
    if (typed.current && text !== value) onCommit(text)
    typed.current = false
  }
  if (multiline) return <textarea className="input mono" rows={3} value={text} placeholder={placeholder} onChange={(e) => type(e.target.value)} onBlur={commit} />
  return <input className="input mono" value={text} placeholder={placeholder} onChange={(e) => type(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
}

/** A stale jj slot recovered, the user's explicit action (HI-2869, J9a's `slots:recoverStale`), after their confirmation. */
async function recoverSlot(projectPath: string, s: SlotView, reload: () => void): Promise<void> {
  const aside = `${s.folder.replace(/[\\/][^\\/]+$/, '')}${s.folder.includes('\\') ? '\\' : '/'}.cw-recovery${s.folder.includes('\\') ? '\\' : '/'}${s.name}`
  if (!(await confirm({ title: tr(T.recoverTitle, { slot: s.name }), message: tr(T.recoverMessage), list: [aside], confirmLabel: tr(T.recover).replace('…', '') }))) return
  const r = await call('slots:recoverStale', projectPath, s.name).catch(() => ({ ok: false as const, why: '' }))
  reload()
  if (!r.ok) return notify('warning', tr(T.notRecovered, { slot: s.name, why: recoverWhy(r.why) }))
  // What it did (HI-2996): said in a window when it wrote copies, kept deletions or kept a commit; else a notice.
  const done = r.recovered
  if (!done || (!done.copies.length && !done.asides.length && !done.keptDeleted.length && !done.divergent)) return notify('success', tr(T.recovered, { slot: s.name }))
  const sep = s.folder.includes('\\') ? '\\' : '/'
  const full = (copy: string): string => `${s.folder}${sep}${copy.split('/').join(sep)}`
  const copies = done.copies.map((c) => full(c.copy))
  const paragraphs = [
    copies.length ? tr(T.recoveredPutBack, { n: done.restored }) : null,
    done.asides.length ? tr(T.recoveredAsides, { n: done.asides.length, files: fmt.list(done.asides.map((a) => full(a.copy))) }) : null,
    done.keptDeleted.length ? tr(T.recoveredKeptDeleted, { n: done.keptDeleted.length, files: fmt.list(done.keptDeleted) }) : null,
    done.divergent ? tr(T.recoveredDivergent, { commit: revisionShort('jj', done.divergent) }) : null
  ].filter((x): x is string => !!x)
  await confirm({
    title: tr(T.recoveredTitle, { slot: s.name }),
    message: copies.length ? tr(T.recoveredCopies, { n: copies.length }) : tr(T.recoveredPutBack, { n: done.restored }),
    list: copies,
    okOnly: true,
    ...(paragraphs.length ? { content: <div data-recovered="">{paragraphs.map((p, i) => <p key={i}>{p}</p>)}</div> } : {})
  })
}

/** The select key of a refused recovery's reason (the port's refusal text, English, never shown). */
function recoverWhy(why: string): string {
  if (/^preparing$/.test(why)) return 'preparing' // i18n-ignore: a select key
  if (/busy|in use|quiet/i.test(why)) return 'busy' // i18n-ignore: a select key
  if (/stale/i.test(why)) return 'notStale' // i18n-ignore: a select key
  if (/identity|recorded/i.test(why)) return 'identity' // i18n-ignore: a select key
  return 'other' // i18n-ignore: a select key
}
