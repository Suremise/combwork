// Switching a project's version control (#1419, SPEC §16.3.5 and §16.6.5): detected, never switched silently. The user
// (or the Assistant within Control, through its settings tool) switches it, after the warning: what changes, that it
// applies from the next card, and the running lanes and cards in flight that keep their platform's rules ("old rules": a
// Git card in flight finishes under Git's, its queue entry carrying on). Under the project's lock the detection is read
// again: Git only where a Git repository is found and no other version control is; None always.
//
// Each platform keeps its own preset, options and answer to "How do you work?" (`workflow.kept`, setKept): the platform
// left is kept, the one chosen comes back as it was. project.json's `platform` and `workflow.platform` change together.

import { basename } from 'path'
import { listLanes } from '../lanes'
import { createLogger, userText } from '../logger'
import { CombworkError, combworkError } from '../combworkError'
import { foundKey, projectPlatform } from '../platform/registry'
import { isPlatformId, needsRepository, type PlatformId } from '../../shared/platform/descriptors'
import { PLATFORM_NAME, storeWide, SWITCH_REFUSED, switchRefused, switchRefusalText } from '../../shared/platform/switching'
import { checkStoreSwitch, noteMemberChoice, storeSwitch } from './storeSwitch'
import { setKept } from '../../shared/workflow/projectWorkflow'
import { withValues } from '../../shared/advanced'
import type { PlatformSwitchCheck } from '../../shared/types'
import type { WorkspaceService } from '../workspace'
import { cardsInFlight } from './optionsForm'
import { workflowFor } from './service'
import { queueChanged } from './queueHost'
import { workflowChanged } from './rulesets'
import { workflowWrite } from './writes'
import { withFolderRepoLocks } from '../platform/repoPorts'
import { cardRef } from '../../shared/projectKeys'

const log = createLogger('workflow')

/** A project of the workspace by its folder (the Assistant's home has no platform). */
function projectOf(ws: WorkspaceService, projectPath: string): { path: string; name: string } {
  const p = ws.info()?.projects.find((x) => x.path.toLowerCase() === projectPath.toLowerCase())
  if (!p?.platform) throw new CombworkError({ lines: [`${projectPath} isn't a project of this workspace`] }, { kind: 'notFound' }) // i18n-ignore: a mistake in a caller, never the window's
  return { path: p.path, name: p.name }
}

function platformArg(to: unknown): PlatformId {
  if (!isPlatformId(to)) throw new CombworkError({ lines: [`A version control is one of: none, git, jj`] }, { kind: 'invalid' }) // i18n-ignore: a mistake in a caller, never the window's
  return to
}

/** The running lanes and cards in flight a switch leaves on their rules, in a line for the Assistant (English), or null. */
export function oldRulesLine(c: PlatformSwitchCheck): string | null {
  const parts = [...c.lanes.map((l) => `lane ${l.name ? `"${l.name}" ` : ''}(${l.builder})`), ...c.inFlight.map((x) => `${cardRef(x.number)} ${x.title}`)] // i18n-ignore: the Assistant's tools (English)
  return parts.length ? `These keep ${c.from}'s rules until they finish: ${parts.join('; ')}.` : null // i18n-ignore: the Assistant's tools (English)
}

/** Whether a card in flight goes through Combwork's merge queue, by its own ruleset (#1356's rule: it carries on after a switch). */
async function queueInFlight(ws: WorkspaceService, projectPath: string): Promise<boolean> {
  const wf = await workflowFor(ws, projectPath)
  if (!wf) return false
  return wf.store.cards().some((c) => {
    const s = wf.state(c)
    return !!s.started && s.stage !== 'todo' && s.stage !== 'done' && wf.rulesetOf(c, s).options.finish === 'combworkMerges'
  })
}

/** What switching a project's version control to `to` would do (§16.6.5's warning), before it is made. */
export async function checkPlatformSwitch(ws: WorkspaceService, projectPath: string, raw: unknown): Promise<PlatformSwitchCheck> {
  const to = platformArg(raw)
  const project = projectOf(ws, projectPath)
  const now = projectPlatform(project.path, (await ws.projectConfig(project.path)).platform)
  const same = now.id === to
  const lanes = same ? [] : (await listLanes(ws, { project: project.name })).filter((l) => l.state === 'active' || l.state === 'paused')
  const detected = same ? null : switchRefused(to, now.detected)
  // Git ↔ jj (HI-2799): the repository's projects switch together, after a drain and jj's checks.
  const store = !same && !detected && storeWide(now.id, to, now.detected) ? await checkStoreSwitch(ws, project.path, to) : null
  return {
    from: now.id,
    to,
    refused: detected ?? store?.refused ?? null,
    ...(store ? { store: store.store } : {}),
    lanes: lanes.map((l) => ({ id: l.id, name: l.name, builder: l.builder.name })),
    inFlight: same ? [] : await cardsInFlight(ws, project),
    // Git's repository stays in the folder, unused, when switched to a platform that needs none (the warning says Git's: a
    // colocated jj repository is jj's, HI-2799).
    gitFolder: !needsRepository(to) && now.detected.platform === 'git',
    queue: !same && (await queueInFlight(ws, project.path))
  }
}

/**
 * Switches a project's version control to `to`, from the next card: under the project's lock, refused when `expected`
 * (the platform the window showed) isn't the one in force, or the detection read again there doesn't allow it. `guard`:
 * the caller's authority, checked again under the lock (the Assistant's Control). Nothing in flight changes. Returns the
 * platform it was and is now.
 */
export async function setPlatform(ws: WorkspaceService, projectPath: string, raw: unknown, o: { expected?: unknown; guard?: (current: PlatformId) => void; token?: unknown } = {}): Promise<{ from: PlatformId; to: PlatformId }> {
  const to = platformArg(raw)
  const project = projectOf(ws, projectPath)
  const now = projectPlatform(project.path, (await ws.projectConfig(project.path)).platform)
  const current = now.id
  // Git ↔ jj (HI-2799): the repository's switch, its own locks and fence (storeSwitch.ts); refused when what the window
  // showed isn't the platform in force, or the group it showed isn't the group now.
  if (storeWide(current, to, now.detected)) {
    const expected = o.expected === undefined || o.expected === null ? current : platformArg(o.expected)
    return storeSwitch(ws, project.path, expected, to, { token: o.token, ...(o.guard ? { guard: o.guard } : {}) })
  }
  // In its turn among workflow writes (#1422): an options save or a level's check never interleaves with it.
  // Its repository's lock first (#1642 round 5): a switch moves what the project's branches are measured against.
  return withFolderRepoLocks([projectPath], () => workflowWrite(() => switchPlatform(ws, projectPath, raw, o)), { quiet: true, project: projectPath })
}

async function switchPlatform(ws: WorkspaceService, projectPath: string, raw: unknown, o: { expected?: unknown; guard?: (current: PlatformId) => void }): Promise<{ from: PlatformId; to: PlatformId }> {
  const to = platformArg(raw)
  const expected = o.expected === undefined || o.expected === null ? null : platformArg(o.expected)
  const project = projectOf(ws, projectPath)
  let from: PlatformId = to
  await ws.mutateProjectConfig(project.path, (cfg) => {
    const now = projectPlatform(project.path, cfg.platform)
    from = now.id
    if (expected && expected !== from) throw combworkError(SWITCH_REFUSED.changed, { platform: PLATFORM_NAME[from] }, { kind: 'conflict' })
    o.guard?.(from)
    if (from === to) return {}
    // A switch that became the repository's meanwhile (HI-2799) never takes this path: its drain and fence are storeSwitch's.
    if (storeWide(from, to, now.detected)) throw combworkError(SWITCH_REFUSED.changed, { platform: PLATFORM_NAME[from] }, { kind: 'conflict' })
    const refused = switchRefused(to, now.detected)
    if (refused) {
      const t = switchRefusalText(refused)
      // agent-text: switchRefusalText
      throw new CombworkError(t.values ? withValues(t.m, t.values) : t.m, { kind: 'conflict' })
    }
    // A project from before 1.0 the upgrade hasn't given options yet has no `workflow`: only its platform changes. What
    // the folder shows now is kept, so the switch isn't offered back while it shows that (None for a Git folder).
    return { platform: to, platformFound: foundKey(now.detected), ...(cfg.workflow ? { workflow: setKept(cfg.workflow, to) } : {}) }
  })
  if (from === to) return { from, to }
  // A member of a switched repository's fence (HI-2799): its admissions held to its new choice.
  await noteMemberChoice(ws, project.path).catch((e) => log.warn('recording a switch in its repository’s platform fence', e))
  log.info(`${userText(basename(project.path))} switched its version control from ${from} to ${to}: from its next card`)
  // The window's project (its platform, the offer gone) and the runtime read it afresh; its stages, its queues' sections.
  await ws.refresh().catch((e) => log.warn('refreshing after a switch of version control', e))
  workflowChanged(ws, project.path)
  queueChanged(ws, project.path, '')
  return { from, to }
}
