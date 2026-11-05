import { Children, useEffect, useState } from 'react'
import type { ProviderId, SkillAudience, SkillInfo, SkillLevel, SkillTarget } from '@shared/types'
import { providerDescriptor } from '@shared/providers'
import * as actions from '../actions'
import { call } from '../api'
import { clearEditorDraftsUnder } from '../editorDrafts'
import { DocEditor } from './DocEditor'
import { AssistantMark } from './AssistantMark'
import { Icon, IconButton, OneLineDesc, Switch, Tooltip } from './ui'
import { confirm, notify, prompt, set, showView, useStore } from '../store'
import { cx } from '../util'
import { msg, tr, tRich, type Msg } from '@shared/i18n'
import { shownText } from '@shared/advanced'
import { shippedSkillDescription } from '@shared/skillDescriptions'
import { skillOff } from '@shared/skillDelivery'
import { skillLinkTarget } from '@shared/skillLinks'

/**
 * Skills in Hive: the workspace's Hive skills (given to project agents, the Assistant or both, as each one's
 * metadata.audience says; edited in the Skills view), and, per
 * provider in a project, its local skills (editable in the project) and the user's own and plugin skills
 * (view only). Shared by the Skills view and the project's Skills tab.
 */

const LEVEL_LABEL: Record<SkillLevel, Msg> = {
  combwork: msg({ id: 'assistant.skills.levelCombwork', defaultMessage: 'Combwork', description: "A skill's kind, on a badge: one of the workspace's Combwork skills. Usually kept as Combwork." }),
  machine: msg({ id: 'assistant.skills.levelUser', defaultMessage: 'User', description: "A skill's kind, on a badge: one in the user's own profile (~/.claude/skills)." }),
  plugin: msg({ id: 'assistant.skills.levelPlugin', defaultMessage: 'Plugin', description: "A skill's kind, on a badge: one from a Claude Code plugin." }),
  local: msg({ id: 'assistant.skills.levelLocal', defaultMessage: 'Local (User Managed)', description: "A skill's kind, on a badge: one in the project's folder, which the user manages." })
}

const LEVEL_TIP: Record<SkillLevel, Msg> = {
  combwork: msg({ id: 'assistant.skills.tipCombwork', defaultMessage: "Combwork skills live in the workspace (.combwork/skills). Each goes to the project agents (every agent in every project, of every provider), to the Assistant, or to both, as the audience in its SKILL.md says (the project agents if it says none). Combwork copies them for each session when it starts, so edits reach new sessions. Add, edit and delete them in the Skills view.", description: 'Tooltip on the Combwork skills. Keep .combwork/skills, SKILL.md and audience as they are.' }),
  machine: msg({ id: 'assistant.skills.tipUser', defaultMessage: "Skills in your user profile (~/.claude/skills for Claude Code, ~/.codex/skills for Codex). That provider's agents always load them, in every project. Listed for reference; manage them outside Combwork.", description: "Tooltip on the user's own skills. Keep the paths as they are." }),
  plugin: msg({ id: 'assistant.skills.tipPlugin', defaultMessage: "Skills from Claude Code plugins you've installed. Claude Code agents always load them. Listed for reference; manage plugins in Claude Code.", description: "Tooltip on Claude Code plugins' skills." }),
  local: msg({ id: 'assistant.skills.tipLocal', defaultMessage: "Skills in the project folder for one provider (.claude/skills for Claude Code, .agents/skills for Codex). That provider's agents load them in this project. You manage them: add, edit and delete them here.", description: "Tooltip on a project's own skills. Keep the paths as they are." })
}

/** Each kind of skill, as its tooltip explains it: read when shown, so it follows a change of language. */
export const SKILL_LEVEL_TIP: Record<SkillLevel, string> = {
  get combwork() {
    return tr(LEVEL_TIP.combwork)
  },
  get machine() {
    return tr(LEVEL_TIP.machine)
  },
  get plugin() {
    return tr(LEVEL_TIP.plugin)
  },
  get local() {
    return tr(LEVEL_TIP.local)
  }
}

const M = {
  files: msg({ id: 'assistant.skills.files', defaultMessage: 'Files of {skill}', description: "Accessible name of the row of tabs above a skill's page, one tab per file of the skill ({skill}: the skill's name): its SKILL.md and the reference files it links." }),
  filesTip: msg({ id: 'assistant.skills.filesTip', defaultMessage: "SKILL.md is what an agent reads when it uses the skill. The other files are read only when SKILL.md's link to them is needed.", description: "Tooltip on the tabs of a skill's files: an agent reads SKILL.md whenever it uses the skill, and each reference file only when it follows SKILL.md's link to it." }),
  filesMore: msg({ id: 'assistant.skills.filesMore', defaultMessage: 'Only the first {count, number} files are shown.', description: "Shown after a skill's file tabs when the skill's folder has more files than Combwork lists ({count}: how many are shown)." }),
  warning: msg({ id: 'assistant.skills.warning', defaultMessage: '<b>Warning:</b> Editing these skills may change agent behaviour in Combwork', description: 'A banner over the Combwork skills and a Combwork skill being edited. <b> is bold.' }),
  notGivenTip: msg({ id: 'assistant.skills.notGivenTip', defaultMessage: "Nobody gets this skill until its header is fixed: {problem}. A skill's header starts and ends with a --- line; for who gets it, put audience: agents, assistant or all under metadata:.", description: "Tooltip on Not given: a Combwork skill whose header (SKILL.md's front matter) can't be read. {problem} says what is wrong. Keep ---, audience:, agents, assistant, all and metadata: as they are." }),
  notGiven: msg({ id: 'assistant.skills.notGiven', defaultMessage: 'Not given', description: "A badge on a Combwork skill nobody gets, because its header can't be read." }),
  nameRule: msg({ id: 'assistant.skills.nameRule', defaultMessage: 'Use letters, numbers, "-" and "_" (max 64)', description: "A skill's name that can't be used." }),
  whereCombwork: msg({ id: 'assistant.skills.whereCombwork', defaultMessage: 'the workspace (.combwork/skills)', description: 'Where a skill is added, inside New Skill and Add Skill from File: the Combwork skills. Lower case: it is part of a sentence.' }),
  whereLocal: msg({ id: 'assistant.skills.whereLocal', defaultMessage: "{provider}'s local skills", description: "Where a skill is added, inside New Skill and Add Skill from File: a project's own skills of {provider} (Claude Code, Codex…). Lower case: it is part of a sentence." }),
  readFailed: msg({ id: 'assistant.skills.readFailed', defaultMessage: 'Could not read the file', description: 'An error notice, adding a skill from a file.' }),
  alsoFor: msg({ id: 'assistant.skills.alsoFor', defaultMessage: 'Also add it for {provider}', description: "A tick box in New Skill: add it to the other provider's local skills too." }),
  newTitle: msg({ id: 'assistant.skills.newTitle', defaultMessage: 'New Skill', description: "The title of the dialog that creates a skill (a folder with a SKILL.md)." }),
  fileTitle: msg({ id: 'assistant.skills.fileTitle', defaultMessage: 'Add Skill from File', description: "The Add Skill from File dialog's title." }),
  newMessage: msg({ id: 'assistant.skills.newMessage', defaultMessage: 'Creates {file} in {where}. Use lowercase letters, numbers and dashes.', description: 'The New Skill dialog. {file} is <name>/SKILL.md, <name> standing for the name you type; {where} where it goes ("the workspace (.combwork/skills)").' }),
  fileMessage: msg({ id: 'assistant.skills.fileMessage', defaultMessage: "Adds {file} to {where}. A .md becomes the skill's SKILL.md; a .zip is unpacked as the skill's folder.", description: 'The Add Skill from File dialog. {file} is the file chosen; {where} where it goes ("the workspace (.combwork/skills)"). Keep .md, .zip and SKILL.md as they are.' }),
  create: msg({ id: 'assistant.skills.create', defaultMessage: 'Create', description: 'The New Skill dialog: its button.' }),
  add: msg({ id: 'assistant.skills.add', defaultMessage: 'Add', description: 'The Add Skill from File dialog: its button.' }),
  addFailed: msg({ id: 'assistant.skills.addFailed', defaultMessage: 'Could not add the skill', description: "An error notice: the new skill couldn't be added; the reason follows." }),
  deleteTitle: msg({ id: 'assistant.skills.deleteTitle', defaultMessage: 'Delete skill?', description: "Confirmation before a skill is deleted: its title." }),
  deleteMessage: msg({ id: 'assistant.skills.deleteMessage', defaultMessage: 'Move "{name}" to the Recycle Bin?', description: 'Confirmation before a skill is deleted. {name} is the skill.' }),
  deleteNobody: msg({ id: 'assistant.skills.deleteNobody', defaultMessage: "It's removed from the workspace. Nobody gets it now ({problem}), so no session loses it.", description: "Confirmation before a Combwork skill nobody gets is deleted. {problem} says what is wrong with its header." }),
  deleteCombwork: msg({ id: 'assistant.skills.deleteCombwork', defaultMessage: "It's removed from the workspace, so new sessions of {audience, select, assistant {the Assistant} all {the project agents and the Assistant} other {the project agents}} no longer get it. A running Claude Code session keeps its own copy until it restarts. Codex sessions share the copy in their folder: a running one loses it when another Codex session in that folder starts.", description: 'Confirmation before a Combwork skill is deleted: who loses it and when.' }),
  deleteLocal: msg({ id: 'assistant.skills.deleteLocal', defaultMessage: '{known, select, yes {{provider} agents} other {The agents}} in this project no longer load it in new sessions.', description: "Confirmation before a project's own skill is deleted. {provider} is Claude Code, Codex…" }),
  delete: msg({ id: 'assistant.skills.delete', defaultMessage: 'Delete', description: 'Confirmation before a skill is deleted: its button.' }),
  deleteFailed: msg({ id: 'assistant.skills.deleteFailed', defaultMessage: 'Could not delete the skill', description: "An error notice: a skill couldn't be deleted; the reason follows." }),
  revertTitle: msg({ id: 'assistant.skills.revertTitle', defaultMessage: 'Revert to default?', description: "Confirmation before an edited skill that ships with Combwork is put back as Combwork ships it." }),
  revertMessage: msg({ id: 'assistant.skills.revertMessage', defaultMessage: 'Replace the workspace\'s "{name}" with the version that ships with this version of Combwork?', description: 'Confirmation before an edited skill is put back as Combwork ships it. {name} is the skill.' }),
  revertDetail: msg({ id: 'assistant.skills.revertDetail', defaultMessage: 'The current copy goes to the Recycle Bin, so edits made to it can still be recovered from there.', description: 'Confirmation before an edited skill is put back as Combwork ships it.' }),
  revert: msg({ id: 'assistant.skills.revert', defaultMessage: 'Revert', description: 'Confirmation before an edited skill is put back as Combwork ships it: its button.' }),
  restoreFailed: msg({ id: 'assistant.skills.restoreFailed', defaultMessage: 'Could not restore the skill', description: "An error notice: a skill that ships with Combwork couldn't be put back; the reason follows." }),
  restored: msg({ id: 'assistant.skills.restored', defaultMessage: 'Restored "{name}"', description: "A notice: a deleted skill of Combwork's own is back." }),
  reverted: msg({ id: 'assistant.skills.reverted', defaultMessage: 'Reverted "{name}" to default', description: 'A notice: an edited skill is back as Combwork ships it.' }),
  copyFailed: msg({ id: 'assistant.skills.copyFailed', defaultMessage: 'Could not copy skill', description: "An error notice: a skill couldn't be copied into the workspace; the reason follows." }),
  copiedNobody: msg({ id: 'assistant.skills.copiedNobody', defaultMessage: 'Copied "{name}" to the workspace, but nobody gets it yet', description: "A notice: a skill was copied into the workspace's Combwork skills, but its header can't be read." }),
  copiedNobodyDetail: msg({ id: 'assistant.skills.copiedNobodyDetail', defaultMessage: 'Its header needs fixing first: {problem}. Open it in the Skills view to edit it.', description: "Under Copied … but nobody gets it yet. {problem} says what is wrong with the skill's header." }),
  copied: msg({ id: 'assistant.skills.copied', defaultMessage: 'Copied "{name}" to the workspace', description: "A notice: a skill was copied into the workspace's Combwork skills." }),
  copiedDetail: msg({ id: 'assistant.skills.copiedDetail', defaultMessage: '{audience, select, assistant {The Assistant now gets it} all {The project agents and the Assistant now get it} other {The project agents now get it}} as a Combwork skill, from their next session.', description: "Under Copied … to the workspace: who gets it now." }),
  stillLocal: msg({ id: 'assistant.skills.stillLocal', defaultMessage: '{known, select, yes {{provider} agents} other {The agents}} here also still load the local copy until you delete it.', description: "Under Copied … to the workspace, for a project's own skill: the project's copy stays. {provider} is Claude Code, Codex…" }),
  deletedBadge: msg({ id: 'assistant.skills.deletedBadge', defaultMessage: 'deleted', description: "A badge on a skill of Combwork's own that was deleted from the workspace." }),
  updateBadge: msg({ id: 'assistant.skills.updateBadge', defaultMessage: 'update', description: "A badge on an edited skill of Combwork's own when Combwork ships a newer version." }),
  deletedHere: msg({ id: 'assistant.skills.deletedHere', defaultMessage: 'Deleted from this workspace', description: "A badge over a skill of Combwork's own that was deleted from the workspace." }),
  restore: msg({ id: 'assistant.skills.restore', defaultMessage: 'Restore', description: "A button: puts back a deleted skill of Combwork's own." }),
  updateTip: msg({ id: 'assistant.skills.updateTip', defaultMessage: "This copy was edited, so Combwork didn't update it. This Combwork ships a newer version: Revert to default brings it in (your copy goes to the Recycle Bin).", description: 'Tooltip on Update available, over an edited skill. Revert to default is the button beside it.' }),
  updateAvailable: msg({ id: 'assistant.skills.updateAvailable', defaultMessage: 'Update available', description: "A badge over an edited skill of Combwork's own when Combwork ships a newer version." }),
  revertTip: msg({ id: 'assistant.skills.revertTip', defaultMessage: 'This skill ships with Combwork, and this copy was edited. Combwork keeps edited copies as they are; unedited ones it updates itself.', description: "Tooltip on Revert to default, over an edited skill that ships with Combwork." }),
  revertButton: msg({ id: 'assistant.skills.revertButton', defaultMessage: 'Revert to default', description: "A button over an edited skill of Combwork's own: puts it back as Combwork ships it." }),
  editTip: msg({ id: 'assistant.skills.editTip', defaultMessage: "Combwork skills are edited in the workspace's Skills view, since every project shares them. This takes you there.", description: 'Tooltip on Edit in workspace, over a Combwork skill in a project.' }),
  edit: msg({ id: 'assistant.skills.editInWorkspace', defaultMessage: 'Edit in workspace', description: 'A button over a Combwork skill in a project: opens it in the Skills view.' }),
  copyTip: msg({ id: 'assistant.skills.copyTip', defaultMessage: "Copy it into the workspace's Combwork skills. The project agents in every project get it, unless its SKILL.md's header sets another audience.", description: 'Tooltip on Copy to workspace. Keep SKILL.md as it is.' }),
  copy: msg({ id: 'assistant.skills.copy', defaultMessage: 'Copy to workspace', description: "A button over a user's or project's skill: copies it into the Combwork skills." }),
  deleteTip: msg({ id: 'assistant.skills.deleteTip', defaultMessage: 'Delete skill', description: "A trash button over an open skill: deletes it." })
}

const AUDIENCE_LABEL: Record<SkillAudience, Msg> = {
  agents: msg({ id: 'assistant.skills.audienceAgents', defaultMessage: 'Project agents', description: "A Combwork skill's badge: the project agents get it." }),
  assistant: msg({ id: 'assistant.skills.audienceAssistant', defaultMessage: 'Assistant', description: "A Combwork skill's badge: the Combwork Assistant gets it." }),
  all: msg({ id: 'assistant.skills.audienceAll', defaultMessage: 'Agents + Assistant', description: "A Combwork skill's badge: the project agents and the Combwork Assistant get it. Keep it short." })
}

export const SKILL_ICON: Record<SkillLevel, string> = { combwork: 'sparkle', machine: 'account', plugin: 'extensions', local: 'folder' }

/** Over the Hive skills view and a Hive skill being edited there: these skills steer the agents. */
export function CombworkSkillsWarning() {
  return (
    <div className="banner warn skills-warning" role="note">
      <Icon name="warning" />
      <span>{Children.toArray(tRich<React.ReactNode>(M.warning, { b: bold }))}</span>
    </div>
  )
}

const bold = (c: React.ReactNode[]): React.ReactNode => <strong>{c}</strong>
const code = (c: React.ReactNode[]): React.ReactNode => <code>{c}</code>

/** Who gets a Hive skill (SKILL.md's metadata.audience; none means the project agents), as a badge's tooltip says it. */
const AUDIENCE_TIP: Record<SkillAudience, Msg> = {
  agents: msg({ id: 'assistant.skills.audienceAgentsTip', defaultMessage: "For the project agents: every agent in every project of this workspace gets it. The Assistant doesn't. This is the default; to change it, set <code>audience</code> under <code>metadata:</code> in its SKILL.md's header (<code>assistant</code>, or <code>all</code> for both).", description: 'Tooltip on Project agents. Keep the <code> tags and what is inside them (audience, metadata:, assistant, all) as they are, and SKILL.md.' }),
  assistant: msg({ id: 'assistant.skills.audienceAssistantTip', defaultMessage: "For the Assistant only (<code>audience: assistant</code> in its SKILL.md's header). Project agents don't get it.", description: 'Tooltip on Assistant. Keep the <code> tags and audience: assistant inside them as they are, and SKILL.md.' }),
  all: msg({ id: 'assistant.skills.audienceAllTip', defaultMessage: "For both the project agents (every agent in every project) and the Assistant (<code>audience: all</code> in its SKILL.md's header).", description: 'Tooltip on Agents + Assistant. Keep the <code> tags and audience: all inside them as they are, and SKILL.md.' })
}

/** A Hive skill nobody gets, because its header can't be read or names an audience Hive doesn't know: why, and how to fix it. */
/** Why nobody gets a Hive skill, in the window's language (#849): its header's problem as text, else main's English. */
export const skillProblem = (s: Pick<SkillInfo, 'problem' | 'problemText'>): string | undefined => (s.problemText ? shownText(s.problemText) : s.problem)

export function ProblemBadge({ problem, small }: { problem: string; small?: boolean }) {
  return (
    <Tooltip content={tr(M.notGivenTip, { problem })}>
      <span className={cx(/* i18n-ignore: class names */ 'badge warn', small && 'audience')} data-audience="none">
        <Icon name="warning" /> {tr(M.notGiven)}
      </span>
    </Tooltip>
  )
}

/** A Hive skill's audience as a badge, with what it means. */
export function AudienceBadge({ audience, small }: { audience: SkillAudience | undefined; small?: boolean }) {
  const a = audience ?? 'agents'
  return (
    <Tooltip content={<>{Children.toArray(tRich<React.ReactNode>(AUDIENCE_TIP[a], { code }))}</>}>
      <span className={cx('badge', small && 'audience', a !== 'agents' && 'accent')} data-audience={a}>
        {a === 'assistant' ? <AssistantMark /> : <Icon name={a === 'agents' ? 'folder' : 'organization'} />} {tr(AUDIENCE_LABEL[a])}
      </span>
    </Tooltip>
  )
}

const NAME_RULE = (v: string): string | null => (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(v.trim()) ? null : tr(M.nameRule))

function where(target: SkillTarget): string {
  return target.kind === 'combwork' ? tr(M.whereCombwork) : tr(M.whereLocal, { provider: providerDescriptor(target.provider).name })
}

/** "Claude Code agents", or "The agents" for a skill of no provider, in a message's select. */
const agentsOf = (s: SkillInfo): { known: 'yes' | 'no'; provider: string } => ({ known: s.provider ? 'yes' : 'no', provider: s.provider ? providerDescriptor(s.provider).name : '' })

function bump(): void {
  set((s) => ({ skillsVersion: s.skillsVersion + 1 }))
}

/**
 * Adds a skill: a new one from a starter SKILL.md, or from a .md or .zip file. `also` is the other provider's
 * local folder in the same project, offered as a tick box so a skill can be added for both at once.
 */
export async function addSkill(mode: 'new' | 'file', target: SkillTarget, also?: SkillTarget): Promise<SkillInfo | null> {
  let file: { path: string; name: string } | null = null
  if (mode === 'file') {
    file = (await actions.attempt(tr(M.readFailed), () => call('skills:pickFile'))) ?? null
    if (!file) return null
  }
  let both = false
  const check = also?.kind === 'local' ? { label: tr(M.alsoFor, { provider: providerDescriptor(also.provider).name }), initial: false, set: (v: boolean) => (both = v) } : undefined
  const name = await prompt({
    title: tr(mode === 'new' ? M.newTitle : M.fileTitle),
    message: mode === 'new' ? tr(M.newMessage, { file: '<name>/SKILL.md', where: where(target) }) : tr(M.fileMessage, { file: file!.path.split(/[\\/]/).pop() ?? '', where: where(target) }),
    placeholder: 'my-skill', // i18n-ignore: an example skill name (letters, numbers and dashes)
    initial: file?.name ?? '',
    confirmLabel: tr(mode === 'new' ? M.create : M.add),
    validate: NAME_RULE,
    check
  })
  if (!name) return null
  const targets = both && also ? [target, also] : [target]
  const s = await actions.attempt(tr(M.addFailed), () =>
    mode === 'new' ? call('skills:create', name.trim(), '', targets) : call('skills:addFromFile', file!.path, name.trim(), targets)
  )
  if (s) bump()
  return s ?? null
}

export async function deleteSkill(s: SkillInfo): Promise<boolean> {
  const hive = s.level === 'combwork'
  const ok = await confirm({
    title: tr(M.deleteTitle),
    message: tr(M.deleteMessage, { name: s.name }),
    detail: hive ? (s.problem ? tr(M.deleteNobody, { problem: skillProblem(s) ?? '' }) : tr(M.deleteCombwork, { audience: s.audience ?? 'agents' })) : tr(M.deleteLocal, agentsOf(s)),
    confirmLabel: tr(M.delete),
    danger: true
  })
  if (!ok) return false
  const ok2 = await actions.attempt(tr(M.deleteFailed), async () => {
    await call('skills:delete', s.path)
    return true
  })
  // Unsaved edits of it would otherwise bring it back (Save All, or saving before quitting).
  if (ok2) clearEditorDraftsUnder(s.path)
  bump()
  return !!ok2
}

export async function restoreBundled(s: SkillInfo): Promise<SkillInfo | null> {
  if (s.bundled === 'changed') {
    const ok = await confirm({
      title: tr(M.revertTitle),
      message: tr(M.revertMessage, { name: s.name }),
      detail: tr(M.revertDetail),
      confirmLabel: tr(M.revert)
    })
    if (!ok) return null
  }
  const r = await actions.attempt(tr(M.restoreFailed), () => call('skills:restoreBundled', s.name))
  if (r) {
    clearEditorDraftsUnder(r.path)
    notify('success', tr(s.bundled === 'missing' ? M.restored : M.reverted, { name: s.name }))
    bump()
  }
  return r ?? null
}

async function copyToWorkspace(s: SkillInfo): Promise<void> {
  const r = await actions.attempt(tr(M.copyFailed), () => call('skills:copyToWorkspace', s.path))
  if (!r) return
  // A project's own skill: its copy there stays, said in a sentence of its own after the notice's.
  const local = s.level === 'local' ? [tr(M.stillLocal, agentsOf(s))] : []
  // Copied, but its header can't be read or names no audience Hive knows: nobody gets it until that's fixed.
  if (r.problem) notify('warning', tr(M.copiedNobody, { name: s.name }), [tr(M.copiedNobodyDetail, { problem: skillProblem(r) ?? '' }), ...local].join(' '))
  else notify('success', tr(M.copied, { name: s.name }), [tr(M.copiedDetail, { audience: r.audience ?? 'agents' }), ...local].join(' '))
  bump()
}

/** Opens a Hive skill for editing in the Skills view (from a project, where Hive skills are view only). */
export function editInWorkspace(s: SkillInfo): void {
  set({ selectedSkill: s.path, skillEdit: s.path })
  showView('skills')
}

/** A skill's description as the window shows it: one Hive ships in the window's language while its copy has Hive's words (#1104). */
export function skillDescription(s: SkillInfo): string {
  const shipped = shippedSkillDescription(s)
  return shipped ? tr(shipped) : s.description
}

/** One skill in a list: icon, name, description and its actions. */
export function SkillRow({ skill, selected, onSelect, actionsFor, delivered }: { skill: SkillInfo; selected: boolean; onSelect: () => void; actionsFor?: React.ReactNode; delivered?: React.ReactNode }) {
  const missing = skill.bundled === 'missing'
  return (
    <div className={cx(/* i18n-ignore: class names */ 'row tall skill-row', selected && 'selected', missing && 'missing')} onClick={onSelect}>
      <Icon name={missing ? 'circle-slash' : SKILL_ICON[skill.level]} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="label with-badges">
          <span className="row-name">
            {skill.name} {skill.plugin && <span className="desc">· {skill.plugin}</span>}
          </span>
          {missing && <span className="badge">{tr(M.deletedBadge)}</span>}{skill.updateAvailable && <span className="badge accent">{tr(M.updateBadge)}</span>}
          {skill.level === 'combwork' && skill.problem && <ProblemBadge problem={skillProblem(skill) ?? ''} small />}
          {skill.level === 'combwork' && !skill.problem && skill.audience && skill.audience !== 'agents' && <AudienceBadge audience={skill.audience} small />}
        </div>
        {skill.description && (
          <OneLineDesc text={skillDescription(skill)} />
        )}
      </div>
      {actionsFor && (
        <div className="row-actions" onClick={(e) => e.stopPropagation()}>
          {actionsFor}
        </div>
      )}
      {delivered && (
        <div className="skill-delivered" onClick={(e) => e.stopPropagation()}>
          {delivered}
        </div>
      )}
    </div>
  )
}

const DELIVERY = {
  on: msg({ id: 'assistant.skills.delivered.switch', defaultMessage: '{name} delivered to agents', description: "A Combwork skill's switch in the Skills view and a project's Skills tab (Delivered to agents), for screen readers: whether agents are given the skill. {name} is the skill." }),
  tipWorkspace: msg({ id: 'assistant.skills.delivered.tipWorkspace', defaultMessage: "Delivered to agents: on, every project's agents get this skill from their next session; off, none of them do, and Combwork removes its copies at their next launch.", description: "Tooltip on a Combwork skill's switch in the workspace's Skills view." }),
  tipProject: msg({ id: 'assistant.skills.delivered.tipProject', defaultMessage: "Delivered to agents: on, this project's agents get this skill from their next session; off, they don't, and Combwork removes its copies at their next launch.", description: "Tooltip on a Combwork skill's switch in a project's Skills tab." }),
  offInWorkspace: msg({ id: 'assistant.skills.delivered.offInWorkspace', defaultMessage: "Off in the workspace's Skills view, so no project's agents get it. Turn it on there first.", description: "Tooltip on a Combwork skill's switch in a project's Skills tab, shown off and disabled: the skill is switched off for the whole workspace." }),
  failed: msg({ id: 'assistant.skills.delivered.failed', defaultMessage: "Couldn't change whether agents get {name}", description: 'A notice: switching a skill on or off for agents (Delivered to agents) failed. {name} is the skill.' })
}

/**
 * A Hive skill's Delivered to agents switch (#1431): in the workspace (no `projectPath`), or in one project, where a skill
 * the workspace has off shows off and can't be turned on.
 */
export function DeliveredSwitch({ skill, projectPath }: { skill: SkillInfo; projectPath?: string }) {
  const ws = useStore((s) => s.workspace?.config.skillDelivery)
  const project = useStore((s) => (projectPath ? s.workspace?.projects.find((p) => p.path === projectPath)?.config.skillDelivery : undefined))
  const offHere = skillOff(skill.name, { skillDelivery: ws })
  const on = !skillOff(skill.name, { skillDelivery: ws }, { skillDelivery: project })
  const blocked = !!projectPath && offHere
  const change = (v: boolean): void => void actions.attempt(tr(DELIVERY.failed, { name: skill.name }), () => call('skills:setDelivered', projectPath ?? null, skill.name, v))
  return (
    <Tooltip content={blocked ? tr(DELIVERY.offInWorkspace) : tr(projectPath ? DELIVERY.tipProject : DELIVERY.tipWorkspace)}>
      <Switch small checked={on} disabled={blocked || !!skill.problem || skill.bundled === 'missing'} label={tr(DELIVERY.on, { name: skill.name })} onChange={change} />
    </Tooltip>
  )
}

/**
 * A skill's SKILL.md, previewed, with what can be done to it. `where` is 'workspace' (the Skills view, where
 * Hive skills are edited) or 'project' (where Hive skills are view only and local skills are edited).
 */
export function SkillDetail({ skill, where: place, projectPath, onDeleted, onRestored }: { skill: SkillInfo; where: 'workspace' | 'project'; projectPath?: string; onDeleted?: () => void; onRestored?: (s: SkillInfo) => void }) {
  const workspace = useStore((s) => s.workspace)
  const editRequest = useStore((s) => s.skillEdit)
  const missing = skill.bundled === 'missing'
  const editable = !missing && ((skill.level === 'combwork' && place === 'workspace') || skill.level === 'local')
  // "Edit in workspace" is for the Skills view's page: the project tab's, showing the same skill, leaves it be.
  const forMe = place === 'workspace' && editRequest === skill.path
  const [editing] = useState(() => forMe)
  useEffect(() => {
    if (forMe) set({ skillEdit: null })
  }, [forMe])
  // Its files (HI-2011): SKILL.md, then the reference files it links, each in a tab; read again when skills change
  // (a Restore or Revert puts back the whole folder).
  const skillsVersion = useStore((s) => s.skillsVersion)
  const [files, setFiles] = useState<{ files: string[]; truncated: boolean }>({ files: ['SKILL.md'], truncated: false })
  const [file, setFile] = useState('SKILL.md')
  useEffect(() => {
    let live = true
    void call('skills:files', skill.path, place === 'project' ? projectPath : undefined)
      .then((r) => live && setFiles({ files: ['SKILL.md', ...r.files.filter((f) => f !== 'SKILL.md')], truncated: r.truncated }))
      .catch(() => live && setFiles({ files: ['SKILL.md'], truncated: false }))
    return () => {
      live = false
    }
  }, [skill.path, skill.bundled, place, projectPath, skillsVersion])
  const shown = files.files.includes(file) ? file : 'SKILL.md'
  // A link in its Markdown to another of its files opens that file's tab; any other link as usual.
  const onLink = (href: string): boolean => {
    const to = skillLinkTarget(href, files.files)
    if (!to) return false
    setFile(to)
    return true
  }

  return (
    <div className="skill-detail">
      {(files.files.length > 1 || files.truncated) && (
        <Tooltip content={tr(M.filesTip)}>
          <div className="skill-files" role="tablist" aria-label={tr(M.files, { skill: skill.name })}>
            {files.files.map((f) => (
              <button key={f} role="tab" aria-selected={f === shown} className={cx('skill-file-tab', f === shown && 'active')} onClick={() => setFile(f)}>
                {f}
              </button>
            ))}
            {files.truncated && <span className="faint">{tr(M.filesMore, { count: files.files.length })}</span>}
          </div>
        </Tooltip>
      )}
      <DocEditor
        key={`${skill.path}:${skill.bundled ?? ''}:${shown}`}
        path={`${skill.path}\\${shown.replace(/\//g, '\\')}`}
        title={shown === 'SKILL.md' ? skill.name : `${skill.name} · ${shown}`}
        onLink={onLink}
        readOnly={!editable || !workspace}
        defaultPreview={!editing}
        editingNote={skill.level === 'combwork' && place === 'workspace' ? <CombworkSkillsWarning /> : undefined}
        toolbarExtra={
          <>
            <Tooltip content={SKILL_LEVEL_TIP[skill.level]}>
              <span className={cx('badge', skill.level === 'combwork' ? 'accent' : '')}>
                {tr(LEVEL_LABEL[skill.level])}
                {skill.provider && skill.level !== 'combwork' ? ` · ${providerDescriptor(skill.provider).name}` : ''}
                {skill.plugin ? ` · ${skill.plugin}` : ''}
              </span>
            </Tooltip>
            {skill.level === 'combwork' && (skill.problem ? <ProblemBadge problem={skillProblem(skill) ?? ''} /> : <AudienceBadge audience={skill.audience} />)}
            {missing && (
              <>
                <span className="badge warn">{tr(M.deletedHere)}</span>
                <button className="btn small primary" onClick={() => void restoreBundled(skill).then((s) => s && onRestored?.(s))}>
                  <Icon name="history" /> {tr(M.restore)}
                </button>
              </>
            )}
            {skill.bundled === 'changed' && place === 'workspace' && (
              <>
                {skill.updateAvailable && (
                  <Tooltip content={tr(M.updateTip)}>
                    <span className="badge accent">{tr(M.updateAvailable)}</span>
                  </Tooltip>
                )}
                <Tooltip content={tr(M.revertTip)}>
                  <button className="btn small subtle" onClick={() => void restoreBundled(skill).then((s) => s && onRestored?.(s))}>
                    <Icon name="discard" /> {tr(M.revertButton)}
                  </button>
                </Tooltip>
              </>
            )}
            {skill.level === 'combwork' && place === 'project' && (
              <Tooltip content={tr(M.editTip)}>
                <button className="btn small subtle" onClick={() => editInWorkspace(skill)}>
                  <Icon name="go-to-file" /> {tr(M.edit)}
                </button>
              </Tooltip>
            )}
            {skill.level !== 'combwork' && workspace && (
              <Tooltip content={tr(M.copyTip)}>
                <button className="btn small subtle" onClick={() => void copyToWorkspace(skill)}>
                  <Icon name="cloud-upload" /> {tr(M.copy)}
                </button>
              </Tooltip>
            )}
            {editable && <IconButton icon="trash" title={tr(M.deleteTip)} onClick={() => void deleteSkill(skill).then((ok) => ok && onDeleted?.())} />}
          </>
        }
      />
    </div>
  )
}

/** The provider whose local folder is `target`'s counterpart, for "also add it for …". */
export function otherLocal(projectPath: string, provider: ProviderId, providers: ProviderId[]): SkillTarget | undefined {
  const other = providers.find((p) => p !== provider)
  return other ? { kind: 'local', projectPath, provider: other } : undefined
}
