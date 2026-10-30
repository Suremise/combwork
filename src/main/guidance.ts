import { assistantSkillsLine, controlRules, hiveInstructions, journalRule } from '../shared/hiveGuidance'
import { taskPrompt } from '../shared/tasks'
import type { SkillInfo } from '../shared/types'
import { ContentTooLarge, hashText } from './fsutil'
import { coalesced, revisionOf } from './revisions'
import { clock as metricsClock, metricsHandle, recordSkills } from './metrics'
import { hiveSkills } from './skills'
import type { SkillDelivery } from './providers/types'
import { utf8Bytes } from '../shared/metrics'
import { currentWorkspace, inWorkspace, type WorkspaceService } from './workspace'

/**
 * Where the guidance a session got came from, so a reviewer can tell what actually ran (an older build, an older
 * copy of a skill) without prompts, tokens or paths: a revision of Hive's own guidance text, and each Hive skill's.
 */

/** A hash of Hive's guidance text (the session contracts, the control rules, a card's prompt): changes when its wording does. */
export const GUIDANCE_REVISION = hashText(
  [
    hiveInstructions('{project}', 'agent'),
    hiveInstructions('{project}', 'agent', false),
    hiveInstructions('', 'assistant'),
    controlRules('look'),
    controlRules('agents'),
    controlRules('projects'),
    journalRule(['{scope}']),
    assistantSkillsLine(true),
    taskPrompt({ number: 0, title: '{title}', description: '', blockedBy: [], comments: [] } as never, true),
    taskPrompt({ number: 0, title: '{title}', description: '', blockedBy: [], comments: [] } as never, true, { inLane: true })
  ].join('\n')
)

/**
 * What a session was given, from what it asked for (each skill's source revision) and what its launch delivered:
 * - `skills`: the revision of each copy it reads (an old one kept while in use shows as that old one);
 * - `problems`: why a skill isn't as asked for (none: delivered as asked);
 * - `settled`: the skills to compare with the workspace's for "restart to apply". A skill a restart would deliver (a
 *   kept old copy, a failed copy) counts as its delivered revision, so the agent shows as needing a restart; one no
 *   restart will deliver (a folder of the user's has its name) counts as asked for, so it doesn't nag.
 */
export function launchRecord(requested: Record<string, string>, delivered: Record<string, SkillDelivery>): { skills: Record<string, string>; problems?: Record<string, string>; settled: Record<string, string> } {
  const skills: Record<string, string> = {}
  const problems: Record<string, string> = {}
  const settled: Record<string, string> = {}
  for (const [name, wanted] of Object.entries(requested)) {
    const d = delivered[name] ?? { revision: null, problem: 'it was not delivered' }
    if (d.revision) skills[name] = d.revision
    if (d.problem) problems[name] = d.problem
    settled[name] = d.lasting ? wanted : (d.revision ?? '')
  }
  return Object.keys(problems).length ? { skills, problems, settled } : { skills, settled }
}

/** A Hive skill as the Agent API's status shows it. */
export interface SkillRevision {
  name: string
  /** Who gets it; 'none' when its header can't be read (`problem` says why). */
  audience: NonNullable<SkillInfo['audience']> | 'none'
  /** Its content's hash (line endings ignored); empty when it couldn't be read (`problem` says why if it's too big). */
  revision: string
  problem?: string
  /** For a skill that ships with Hive: whether this copy is Hive's ('same') or was edited ('changed'). */
  bundled?: 'same' | 'changed'
  updateAvailable?: true
}

const scans = new WeakMap<WorkspaceService, { lifetime: AbortSignal; scan: () => Promise<SkillRevision[]> }>()

/**
 * The workspace's Hive skills with their revisions (the Agent API's status). Revisions are kept between calls
 * (revisions.ts); callers asking at the same time share one scan.
 */
export function skillRevisions(): Promise<SkillRevision[]> {
  const w = currentWorkspace()
  let s = scans.get(w)
  if (!s || s.lifetime !== w.lifetime) {
    // Each scan is timed, and callers that shared one are counted (performance metrics).
    s = {
      lifetime: w.lifetime,
      scan: coalesced(
        () =>
          inWorkspace(w, async () => {
            const h = metricsHandle(w)
            const t = metricsClock.mono()
            try {
              return await scanRevisions()
            } finally {
              recordSkills(h, { scanMs: metricsClock.mono() - t })
            }
          }),
        () => recordSkills(metricsHandle(w), { sharedScans: 1 })
      )
    }
    scans.set(w, s)
  }
  return s.scan()
}

async function scanRevisions(): Promise<SkillRevision[]> {
  const out: SkillRevision[] = []
  for (const s of await hiveSkills()) {
    const r: SkillRevision = { name: s.name, audience: s.audience ?? 'agents', revision: '' }
    // Nobody gets it (its header is broken or its audience unknown): its audience is none, and why.
    if (s.problem) {
      r.audience = 'none'
      r.problem = `nobody gets it: ${s.problem}`
    }
    try {
      r.revision = await revisionOf(s.path)
    } catch (e) {
      if (e instanceof ContentTooLarge) r.problem = [r.problem, `too big to check: ${e.message}`].filter(Boolean).join('; ')
    }
    if (s.bundled === 'same' || s.bundled === 'changed') r.bundled = s.bundled
    if (s.updateAvailable) r.updateAvailable = true
    out.push(r)
  }
  return out
}

/**
 * The parts of what a launch tells a session, for the performance metrics (exact sizes): the core session contract
 * (hiveInstructions, the same for every session of a role), what Hive adds for the project (the rest of `guidance`: the
 * latest handover's pointer, and the Workspace notes note given as `notes`, #1433), and for the Assistant its role and
 * its mode (which ends its text). Text that doesn't start or end as expected is counted whole as core or role, never
 * split by guesswork.
 */
export function launchParts(guidance: string, role: 'agent' | 'assistant', project: string, assistant: { text: string; modeText: string } | null, notes = ''): { guidanceBytes: number; guidanceChars: number; customBytes: number; customChars: number; roleBytes: number; roleChars: number; modeBytes: number; modeChars: number } {
  // The contract as the session got it: with long commands wrapped or not (Settings → General), and for the Assistant
  // with its journal's skills line when the journal is on (withJournal, HI-2048), whose rule after it is then custom.
  const contracts = [true, false].map((p) => hiveInstructions(role === 'assistant' ? '' : project, role, p))
  const candidates = role === 'assistant' ? contracts.flatMap((c) => [c, c.replace(assistantSkillsLine(false), assistantSkillsLine(true))]) : contracts
  const contract = guidance ? candidates.find((c) => guidance.startsWith(c)) : ''
  const core = contract || guidance
  const custom = guidance.slice(core.length) + notes.trim()
  const text = assistant?.text ?? ''
  const mode = assistant?.modeText && text.endsWith(assistant.modeText) ? assistant.modeText : ''
  const roleText = text.slice(0, text.length - mode.length)
  return { guidanceBytes: utf8Bytes(core), guidanceChars: core.length, customBytes: utf8Bytes(custom), customChars: custom.length, roleBytes: utf8Bytes(roleText), roleChars: roleText.length, modeBytes: utf8Bytes(mode), modeChars: mode.length }
}
