import { advancedDef, advancedRow, rightClickToCliId } from '@shared/advanced'
import { AGENT_LIMIT_MAX } from '@shared/defaults'
import { INBOX_SWITCH_ID, inboxSwitchOn, type InboxSwitch } from '@shared/inboxSwitches'
import type { ProjectConfig, ProjectInfo } from '@shared/types'
import { projectInfoPreferences } from '@shared/workflow/preferences'
import { call } from './api'
import { setLoaded, useStore } from './store'

/** Settings → Advanced's state (#367), read again when it changes (an override, advanced.json, the workspace's own). */
export async function loadAdvanced(): Promise<void> {
  try {
    setLoaded({ advanced: await call('advanced:state') })
  } catch {
    // A window closing meanwhile: nothing to show.
  }
}

/** An advanced value as Combwork uses it in this window (its workspace's own, the override, or the default). */
export function useAdvancedValue<T extends string | number | string[] | boolean>(id: string): T {
  const state = useStore((s) => s.advanced)
  return advancedRow(advancedDef(id)!, state).value as T
}
/** An advanced value as this window has it now, for tests: a change reaches the window in the states' batch (HI-1938), after its IPC answers. */
;(window as unknown as { __cwAdvancedValue?: (id: string) => unknown }).__cwAdvancedValue = (id) => {
  const def = advancedDef(id)
  return def ? advancedRow(def, useStore.getState().advanced).value : undefined
}

/** Whether right-click in a provider's terminal goes to its CLI rather than Combwork's copy/paste (#737): off for a provider with no such setting. */
export function useRightClickToCli(provider: string | undefined): boolean {
  const state = useStore((s) => s.advanced)
  const def = provider ? advancedDef(rightClickToCliId(provider)) : undefined
  return !!def && advancedRow(def, state).value === true
}

/**
 * How many agents the user can give a project (#562, HI-2001): its workflow's Maximum agents, which binds the user too
 * (HI-2058), at most the most any project can have. No project (the Assistant's home): that most. Main checks it again.
 */
export function useAgentLimit(project: ProjectInfo | null | undefined): number {
  const global = useStore((s) => s.settings?.workflow)
  const workspace = useStore((s) => s.workspace?.config.workflow)
  return limitOf(project, global, workspace)
}

/** The same, outside a component. */
export function agentLimit(project: ProjectInfo | null | undefined): number {
  const st = useStore.getState()
  return limitOf(project, st.settings?.workflow, st.workspace?.config.workflow)
}

const limitOf = (project: ProjectInfo | null | undefined, global: Parameters<typeof projectInfoPreferences>[1], workspace: Parameters<typeof projectInfoPreferences>[2]): number =>
  project ? Math.min(AGENT_LIMIT_MAX, projectInfoPreferences(project, global, workspace).maxAgents) : AGENT_LIMIT_MAX

/** Whether a carrying-on switch is on for a project's agents (#1432): its own over Settings → Advanced's; no project (the Assistant), Settings'. */
export function useInboxSwitch(which: InboxSwitch, project: Partial<ProjectConfig> | null | undefined): boolean {
  return inboxSwitchOn(which, project, useAdvancedValue<boolean>(INBOX_SWITCH_ID[which]))
}

/** The same, outside a component. */
export function inboxSwitchNow(which: InboxSwitch, project: Partial<ProjectConfig> | null | undefined): boolean {
  return inboxSwitchOn(which, project, advancedRow(advancedDef(INBOX_SWITCH_ID[which])!, useStore.getState().advanced).value === true)
}
