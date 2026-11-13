import { useEffect, useState } from 'react'
import type { PlatformSwitchCheck, ProjectInfo, WorkflowForm } from '@shared/types'
import { needsRepository, type PlatformId, type PlatformOffer, type ProjectPlatform } from '@shared/platform/descriptors'
import { detectedCaution, factOf, PLATFORM_VIEW } from '@shared/platform/presentation'
import { DETAILED_REFUSALS as DETAILED, PLATFORM_NAME, switchAtConfirm, switchRefused, switchRefusalText } from '@shared/platform/switching'
import { StoreSwitchDetails } from './StoreSwitchDetails'
import { FORM_OPTIONS } from '@shared/workflow/options'
import { PRESET_TEXT } from '@shared/workflow/optionTexts'
import { msg, tr } from '@shared/i18n'
import { call, errorMessage } from '../api'
import { cardLabelOf, confirm, notify, showVersionControl, useLanguage, useStore } from '../store'
import { cx } from '../util'
import { Icon, Tooltip } from '../components/ui'

/**
 * The top of the Version Control tab (#1416, SPEC §16.6 and §16.3.5): the project's version control as a None · Git
 * choice, what Combwork finds in its folder, and "Workflow: Git · Team", which opens the Workflow section. Combwork never switches
 * it silently (#1419): the user picks the other one (None always; Git only where a Git repository is found and nothing
 * else is), or takes the offer Combwork makes when it detects a change, after the warning: what changes, that it applies
 * from the next card, and what keeps the old rules. Not now hides an offer until Combwork starts again.
 */

/** The tab's words (the board's workflow link, #1420, says it as the tab does). */
export const M = {
  choice: msg({ id: 'git.vc.choice', defaultMessage: 'Version control', description: 'Accessible name of the None · Git choice atop the Version Control tab (glossary 2.1: version control).' }),
  previewTip: msg({ id: 'git.vc.previewTip', defaultMessage: 'Git needs this folder to be a repository: Initialise repository… makes it one. Nothing changes until you do.', description: 'Tooltip of Git in the None · Git choice atop the Version Control tab of a project whose folder has no repository of its own: clicking it shows Git’s page, which only offers Initialise repository… (keep it as translated on that button).' }),
  switchTip: msg({ id: 'git.vc.switchTip', defaultMessage: 'Switch this project to {platform}, from its next card. Combwork shows what changes first.', description: 'Tooltip of the version control not in use, in the None · Git choice atop the Version Control tab: clicking it asks before switching. {platform} is None or Git.' }),
  workflow: msg({ id: 'git.vc.workflow', defaultMessage: 'Workflow: {platform} · {state, select, preset {{preset}} custom {Custom (from {preset})} other {no preset chosen}}', description: 'A link atop the Version Control tab: the project’s workflow, its version control ({platform}: None or Git) and its preset ({preset}: Solo, Pair, Team); Custom when the options were changed after it. Opens the Workflow section. Glossary 2.1: workflow, preset, Custom.' }),
  workflowTip: msg({ id: 'git.vc.workflowTip', defaultMessage: 'Show the workflow options', description: 'Tooltip of the "Workflow: Git · Team" link atop the Version Control tab.' })
}

/** The offers (§16.3.5), the switch's warning (§16.6.5) and what it says when done. */
const S = {
  gitFound: msg({ id: 'git.vc.offer.gitFound', defaultMessage: 'Git found at {root}: switch to Git?', description: 'An offer atop the Version Control tab of a project without version control, after someone ran git init: {root} is the repository root. Combwork never switches by itself.' }),
  repositoryGone: msg({ id: 'git.vc.offer.repositoryGone', defaultMessage: 'The Git repository is gone. Git’s rules hold until you switch, because what they check can’t be read.', description: 'An offer atop the Version Control tab of a Git project whose .git folder was removed or moved: its cards are refused until the user switches to None or the repository is back.' }),
  jjFound: msg({ id: 'git.vc.offer.jjFound', defaultMessage: 'jj found at {root}: switch to jj?', description: 'An offer atop the Version Control tab (HI-2799, HI-2896): a jj (Jujutsu) repository, colocated with Git or not, was found in the project folder. Combwork never switches by itself. Keep jj.' }),
  jjGone: msg({ id: 'git.vc.offer.jjGone', defaultMessage: 'The jj repository is gone: switch this project back to {platform}?', description: 'An offer atop the Version Control tab of a project using jj (HI-2799) whose .jj folder is gone. {platform} is Git or None. Keep jj.' }),
  otherFound: msg({ id: 'git.vc.offer.otherFound', defaultMessage: '{vcs} found: not supported yet, so this project can only use None.', description: 'An offer atop the Version Control tab of a Git project where another version control ({vcs}: Mercurial, Jujutsu) is found now. None: glossary 2.1.' }),
  notNow: msg({ id: 'git.vc.offer.notNow', defaultMessage: 'Not Now', description: 'A button of the offer to switch version control (atop the Version Control tab): hides the offer until Combwork starts again.' }),
  title: msg({ id: 'git.vc.switch.title', defaultMessage: 'Switch {project} to {platform}?', description: 'Title of the warning before switching a project’s version control. {project} is its name, {platform} None or Git.' }),
  what: msg({ id: 'git.vc.switch.what', defaultMessage: 'From its next card, {project} uses {to} and {to}’s own workflow options. Cards already started keep {from}’s rules.', description: 'The warning before switching a project’s version control: what changes. {to} and {from} are None or Git.' }),
  restored: msg({ id: 'git.vc.switch.restored', defaultMessage: 'The {to} options it had before come back as they were; {from}’s are kept for a switch back.', description: 'In the warning before switching version control, when the project used the other one before: its options for it are restored. {to} and {from} are None or Git.' }),
  fresh: msg({ id: 'git.vc.switch.fresh', defaultMessage: 'It has no {to} options of its own yet: they come from the workspace’s and Combwork’s defaults until you choose some. {from}’s are kept for a switch back.', description: 'In the warning before switching version control, when the project never used the other one: it starts with no options of its own (inherited). {to} and {from} are None or Git.' }),
  gitFolder: msg({ id: 'git.vc.switch.gitFolder', defaultMessage: 'This folder is still a Git repository, but with None Combwork records no commits or merges for its cards.', description: 'In the warning before switching a project to None (no version control) while its folder is a Git repository. None: glossary 2.1.' }),
  lanes: msg({ id: 'git.vc.switch.lanes', defaultMessage: '{n, plural, one {This running lane keeps {from}’s rules until it ends:} other {These running lanes keep {from}’s rules until they end:}}', description: 'In the warning before switching version control, above the lanes running now (glossary: lane, old rules). {from} is None or Git.' }),
  lane: msg({ id: 'git.vc.switch.lane', defaultMessage: 'Lane “{name}” (builder {builder})', description: 'A running lane in the warning before switching version control. {builder} is the agent building its cards, {name} the lane’s name. A noun before the name (glossary §1 rule 4).' }),
  laneUnnamed: msg({ id: 'git.vc.switch.laneUnnamed', defaultMessage: 'Lane (builder {builder})', description: 'A running lane with no name in the warning before switching version control. {builder} is the agent building its cards. A noun before the name (glossary §1 rule 4).' }),
  inFlight: msg({ id: 'git.vc.switch.inFlight', defaultMessage: '{n, plural, one {This card in flight finishes under {from}’s rules (old rules):} other {These cards in flight finish under {from}’s rules (old rules):}}', description: 'In the warning before switching version control, above the cards already started (glossary: old rules). {from} is None or Git. Unlike other option changes, a switch can’t be applied to them.' }),
  queue: msg({ id: 'git.vc.switch.queue', defaultMessage: 'Their merge queue carries on, and stays in this tab and the Progress panel until it’s clear.', description: 'In the warning before switching from Git to None, under the Git cards in flight: their merge queue goes on until it is empty.' }),
  nothing: msg({ id: 'git.vc.switch.nothing', defaultMessage: 'Nothing is in flight: every card works under {to} from now.', description: 'In the warning before switching version control when no card has started and no lane runs. {to} is None or Git.' }),
  confirm: msg({ id: 'git.vc.switch.confirm', defaultMessage: 'Switch', description: 'The confirm button of the warning before switching a project’s version control.' }),
  done: msg({ id: 'git.vc.switch.done', defaultMessage: '{project} uses {platform} from its next card', description: 'A notice after switching a project’s version control. {project} is its name, {platform} None or Git.' }),
  checkAgain: msg({ id: 'git.vc.switch.checkAgain', defaultMessage: 'Check Again', description: 'The button of a refused switch between Git and jj (HI-2799): reads the repository and what runs on it again, and shows the warning again (or switches, after asking).' }),
  close: msg({ id: 'git.vc.switch.close', defaultMessage: 'Close', description: 'Closes the refused switch’s dialog (HI-2799) without switching.' }),
  notSwitched: msg({ id: 'git.vc.switch.notSwitched', defaultMessage: "{project} is a Git repository now, but it wasn't switched to Git: {error}", description: 'A notice after Initialise repository… chosen from Git’s page made the repository but switching the project to Git failed. {project} is its name, {error} why (already translated).' })
}

/** Offers hidden with Not now, by project and offer: until Combwork starts again (in memory, as the upgrade banner's). */
const hiddenOffers = new Set<string>()
const offerKey = (path: string, o: PlatformOffer): string => `${path.toLowerCase()}\n${o.why}`

/** A platform's name (the board's workflow link, #1420): the names the switch says too. */
export const PLATFORM_TEXT = PLATFORM_NAME

const CHOICES: PlatformId[] = ['none', 'git', 'jj']

/**
 * The refusals a switch between Git and jj shows with its lists (HI-2799), rather than as a notice. `memberNoJj`
 * (HI-3034): the group listed beside the project named, and Check Again once it is None.
 */

/**
 * Asks before switching a project's version control (§16.6.5's warning), then switches it, from its next card: refused
 * when it changed meanwhile (`from`, the platform shown) or what is detected doesn't allow it (said in the dialog).
 * Whether it switched.
 */
export async function switchPlatform(project: ProjectInfo, from: PlatformId, to: PlatformId): Promise<boolean> {
  let check: PlatformSwitchCheck
  try {
    check = await call('workflow:checkPlatform', project.path, to)
  } catch (e) {
    notify('error', errorMessage(e))
    return false
  }
  const names = { project: project.name, from: tr(PLATFORM_NAME[check.from]), to: tr(PLATFORM_NAME[to]) }
  if (check.refused) {
    const t = switchRefusalText(check.refused)
    // A switch between Git and jj refused for what its warning lists (HI-2799): the lists shown, Check again reads them
    // afresh (work finished meanwhile, a setting changed), never a switch made from this dialog.
    if (check.store && DETAILED.has(check.refused.why)) {
      const again = await confirm({ title: tr(S.title, { project: project.name, platform: names.to }), message: tr(t.m, t.values), wide: true, content: <StoreSwitchDetails store={check.store} to={to} />, confirmLabel: tr(S.checkAgain), cancelLabel: tr(S.close) })
      return again ? switchPlatform(project, from, to) : false
    }
    notify('error', tr(t.m, t.values))
    return false
  }
  // HI-3105: a switch of the repository refused as Switch is pressed (what its warning lists changed since it was read):
  // the check is read again, and when that refuses with lists, or reads clear now (HR1's round 1: a passing race), this
  // dialog gives way to a fresh look (the refused one showing them, or a fresh confirmation), never a refusal pointing
  // at a list the dialog doesn't have; never a switch made by itself. Only a refusal does (HR2's round 2): any other
  // failure (a save that failed) is the dialog's error as it is.
  let reread = false
  const ok = await confirm({
    title: tr(S.title, { project: project.name, platform: names.to }),
    message: tr(S.what, names),
    wide: true,
    content: <SwitchDetails project={project} check={check} names={names} />,
    confirmLabel: tr(S.confirm),
    run: async () => {
      const r = await switchAtConfirm({
        switchIt: () => call('workflow:switchPlatform', project.path, to, { expected: from, ...(check.store ? { token: check.store.token } : {}) }),
        recheck: () => call('workflow:checkPlatform', project.path, to)
      })
      if (r === 'reread') reread = true
      else if (r !== 'switched') {
        const t = switchRefusalText(r.refused)
        throw new Error(tr(t.m, t.values))
      }
    }
  })
  if (reread) return switchPlatform(project, from, to)
  if (ok) notify('success', tr(S.done, { project: project.name, platform: names.to }))
  return ok
}

/**
 * After Initialise repository… chosen from Git's page (HI-1905): the repository is made with its first commit, so the
 * project the dialog initialised switches to Git, as the user chose. Quietly, unless lanes or cards in flight keep None's
 * rules (then the switch's warning, which they can cancel). Refused, changed meanwhile or failed: the repository stays,
 * and the notice says it wasn't switched. Already Git (someone else switched it): nothing to do. Whether it is Git now.
 */
export async function switchAfterInit(project: ProjectInfo): Promise<boolean> {
  const notSwitched = (error: string): void => notify('error', tr(S.notSwitched, { project: project.name, error }))
  let check: PlatformSwitchCheck
  try {
    check = await call('workflow:checkPlatform', project.path, 'git')
  } catch (e) {
    notSwitched(errorMessage(e))
    return false
  }
  if (check.from === 'git') return true
  if (check.refused) {
    const t = switchRefusalText(check.refused)
    notSwitched(tr(t.m, t.values))
    return false
  }
  if (check.lanes.length || check.inFlight.length) return switchPlatform(project, 'none', 'git')
  try {
    await call('workflow:setPlatform', project.path, 'git', { expected: 'none' })
  } catch (e) {
    notSwitched(errorMessage(e))
    return false
  }
  notify('success', tr(S.done, { project: project.name, platform: tr(PLATFORM_NAME.git) }))
  return true
}

/** What else the switch does: the options restored or none, a Git folder under None, and what keeps the old rules. */
function SwitchDetails({ project, check, names }: { project: ProjectInfo; check: PlatformSwitchCheck; names: { from: string; to: string } }) {
  const tasks = useStore((s) => s.tasks)
  const kept = !!project.config.workflow?.kept?.[check.to]
  return (
    <div className="workflow-save vc-switch" data-vc-switch={check.to}>
      {project.config.workflow && <p>{tr(kept ? S.restored : S.fresh, names)}</p>}
      {check.gitFolder && (
        <p className="caution" data-vc-switch-gitfolder="">
          {tr(S.gitFolder)}
        </p>
      )}
      {check.store && <StoreSwitchDetails store={check.store} to={check.to} />}
      {check.lanes.length > 0 && (
        <>
          <p>{tr(S.lanes, { n: check.lanes.length, from: names.from })}</p>
          <ul data-vc-switch-lanes="">
            {check.lanes.map((l) => (
              <li key={l.id}>{l.name ? tr(S.lane, { builder: l.builder, name: l.name }) : tr(S.laneUnnamed, { builder: l.builder })}</li>
            ))}
          </ul>
        </>
      )}
      {check.inFlight.length > 0 && (
        <>
          <p>{tr(S.inFlight, { n: check.inFlight.length, from: names.from })}</p>
          <ul data-vc-switch-inflight="">
            {check.inFlight.map((c) => (
              <li key={c.number}>
                {cardLabelOf({ tasks }, c.number)} {c.title}
              </li>
            ))}
          </ul>
          {check.queue && <p>{tr(S.queue)}</p>}
        </>
      )}
      {!check.lanes.length && !check.inFlight.length && <p>{tr(S.nothing, names)}</p>}
    </div>
  )
}

/** The offer shown under the header (§16.3.5): the project's, unless Not now hid it until Combwork starts again. */
function shownOffer(project: ProjectInfo): PlatformOffer | null {
  const o = project.platform?.offer
  return o && !hiddenOffers.has(offerKey(project.path, o)) ? o : null
}

/** The offer Combwork makes when what it detects differs from the platform in force (§16.3.5), until Not now. */
function PlatformOfferLine({ project, platform, o, onHide }: { project: ProjectInfo; platform: PlatformId; o: PlatformOffer; onHide: () => void }) {
  const d = project.platform!.detected
  const text = o.why === 'gitFound' ? tr(S.gitFound, { root: d.root ?? project.path }) : o.why === 'jjFound' ? tr(S.jjFound, { root: d.root ?? project.path }) : o.why === 'jjGone' ? tr(S.jjGone, { platform: tr(PLATFORM_NAME[o.offer]) }) : o.why === 'otherFound' ? tr(S.otherFound, { vcs: d.other ?? tr(PLATFORM_NAME.jj) }) : tr(S.repositoryGone)
  return (
    <div className={cx('banner', o.why === 'gitFound' || o.why === 'jjFound' ? 'info' : 'warn', 'vc-offer')} data-vc-offer={o.why}>
      <span className="vc-offer-text">{text}</span>
      <span className="vc-offer-actions">
        <button type="button" className="btn small primary" data-action="vc-offer-switch" onClick={() => void switchPlatform(project, platform, o.offer)}>
          {tr(PLATFORM_VIEW[o.offer].switchTo)}
        </button>
        <button
          type="button"
          className="btn small subtle"
          data-action="vc-offer-notnow"
          onClick={() => {
            hiddenOffers.add(offerKey(project.path, o))
            onHide()
          }}
        >
          {tr(S.notNow)}
        </button>
      </span>
    </div>
  )
}

/** What Combwork finds in the folder, in the tab's words. */
function factText(p: ProjectPlatform): string {
  // HI-3140: each platform's own facts (presentation.ts).
  const f = factOf(p)
  return tr(f.m, f.values)
}

/** The preset the options came from, and whether they were changed since (Custom), as the form shows them. */
export function presetState(f: WorkflowForm): { state: 'preset' | 'custom' | 'none'; preset: WorkflowForm['preset'] } {
  if (!f.preset) return { state: 'none', preset: null }
  const p = f.presets.find((x) => x.id === f.preset)?.options
  const custom = !!p && FORM_OPTIONS[f.platform].some((k) => JSON.stringify(p[k]) !== JSON.stringify(f.options[k]))
  return { state: custom ? 'custom' : 'preset', preset: f.preset }
}

/** The project's workflow form, read again when its saved options change (here, or by the Assistant's tool). */
export function useWorkflowForm(project: ProjectInfo): WorkflowForm | null {
  const saved = JSON.stringify(project.config.workflow ?? null)
  const [form, setForm] = useState<{ for: string; form: WorkflowForm } | null>(null)
  useEffect(() => {
    let live = true
    call('workflow:form', project.path).then(
      (f) => live && setForm({ for: project.path, form: f }),
      () => live && setForm(null)
    )
    return () => {
      live = false
    }
  }, [project.path, saved])
  return form?.for === project.path ? form.form : null
}

/**
 * `form`: the project's workflow form (useWorkflowForm), read once for the tab: its header and the preset step.
 * `preview` (HI-1905): the tab shows Git's page for a None folder with no repository of its own, a view only: Git is
 * chosen in the choice while the project's platform, its fact and its workflow link stay None's. `onPreview` turns it on
 * (Git's click, instead of a refusal or the switch) or off (None's).
 */
export function VersionControlHeader({ project, platform, form, preview, onPreview }: { project: ProjectInfo; platform: PlatformId; form: WorkflowForm | null; preview?: boolean; onPreview?: (on: boolean) => void }) {
  useLanguage()
  const preset = form ? presetState(form) : null
  const [, redraw] = useState(0)
  // The offer says what Combwork found, with its action: the fact line beside the choice waits until it's hidden (Not now).
  const offer = shownOffer(project)
  return (
    <>
      <div className="vc-head" data-vc-head="">
        <div className="segmented vc-choice" role="radiogroup" aria-label={tr(M.choice)}>
          {CHOICES.map((id) => {
            const chosen = preview ? 'git' : platform
            if (id === chosen)
              return (
                <button key={id} type="button" role="radio" aria-checked className="active" data-platform={id}>
                  {tr(PLATFORM_NAME[id])}
                </button>
              )
            // Back to None from Git's page, or to Git's page from None: a view, nothing switched or saved.
            if (onPreview && !needsRepository(platform) && PLATFORM_VIEW[id].previewable) {
              const button = (
                <button key={id} type="button" role="radio" aria-checked={false} aria-disabled={false} data-platform={id} onClick={() => onPreview(needsRepository(id))}>
                  {tr(PLATFORM_NAME[id])}
                </button>
              )
              return needsRepository(id) ? (
                <Tooltip key={id} content={tr(M.previewTip)}>
                  {button}
                </Tooltip>
              ) : (
                button
              )
            }
            // Git only where a Git repository is found and nothing else is: why not, in its tooltip (#1419).
            const refused = project.platform ? switchRefused(id, project.platform.detected) : null
            const why = refused ? switchRefusalText(refused) : null
            return (
              <Tooltip key={id} content={why ? tr(why.m, why.values) : tr(M.switchTip, { platform: tr(PLATFORM_NAME[id]) })}>
                <button type="button" role="radio" aria-checked={false} aria-disabled={!!refused} className={cx(refused && 'vc-choice-off')} data-platform={id} onClick={() => !refused && void switchPlatform(project, platform, id)}>
                  {tr(PLATFORM_NAME[id])}
                </button>
              </Tooltip>
            )
          })}
        </div>
        {project.platform && !offer && (
          <span className={cx('vc-fact', 'faint', project.platform.detected.other || (needsRepository(platform) && project.platform.detected.platform !== platform) || detectedCaution(project.platform.detected) ? 'caution' : null)} data-vc-fact="">
            {factText(project.platform)}
          </span>
        )}
        {preset && (
          <Tooltip content={tr(M.workflowTip)}>
            <button type="button" className="link vc-workflow" data-action="vc-workflow" onClick={() => showVersionControl(project.path, 'workflow')}>
              <Icon name="git-pull-request" /> {tr(M.workflow, { platform: tr(PLATFORM_NAME[platform]), state: preset.state, preset: preset.preset ? tr(PRESET_TEXT[preset.preset]) : '' })}
            </button>
          </Tooltip>
        )}
      </div>
      {offer && <PlatformOfferLine project={project} platform={platform} o={offer} onHide={() => redraw((n) => n + 1)} />}
    </>
  )
}
