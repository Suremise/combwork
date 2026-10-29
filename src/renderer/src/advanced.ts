import { AGENTS_PER_PROJECT, advancedDef, advancedRow, rightClickToCliId } from '@shared/advanced'
import { INBOX_SWITCH_ID, inboxSwitchOn, type InboxSwitch } from '@shared/inboxSwitches'
import type { ProjectConfig } from '@shared/types'
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

/** An advanced value as Hive uses it in this window (its workspace's own, the override, or the default). */
export function useAdvancedValue<T extends string | number | string[] | boolean>(id: string): T {
  const state = useStore((s) => s.advanced)
  return advancedRow(advancedDef(id)!, state).value as T
}
/** An advanced value as this window has it now, for tests: a change reaches the window in the states' batch (HI-1938), after its IPC answers. */
;(window as unknown as { __hiveAdvancedValue?: (id: string) => unknown }).__hiveAdvancedValue = (id) => {
  const def = advancedDef(id)
  return def ? advancedRow(def, useStore.getState().advanced).value : undefined
}

/** Whether right-click in a provider's terminal goes to its CLI rather than Hive's copy/paste (#737): off for a provider with no such setting. */
export function useRightClickToCli(provider: string | undefined): boolean {
  const state = useStore((s) => s.advanced)
  const def = provider ? advancedDef(rightClickToCliId(provider)) : undefined
  return !!def && advancedRow(def, state).value === true
}

/** How many agents a project of this window's workspace can have (#562): Settings → Advanced → Agents per project. The main process checks it again. */
export function useAgentLimit(): number {
  return useAdvancedValue<number>(AGENTS_PER_PROJECT)
}

/** The same, outside a component. */
export function agentLimit(): number {
  return advancedRow(advancedDef(AGENTS_PER_PROJECT)!, useStore.getState().advanced).value as number
}

/** Whether a carrying-on switch is on for a project's agents (#1432): its own over Settings → Advanced's; no project (the Assistant), Settings'. */
export function useInboxSwitch(which: InboxSwitch, project: Partial<ProjectConfig> | null | undefined): boolean {
  return inboxSwitchOn(which, project, useAdvancedValue<boolean>(INBOX_SWITCH_ID[which]))
}

/** The same, outside a component. */
export function inboxSwitchNow(which: InboxSwitch, project: Partial<ProjectConfig> | null | undefined): boolean {
  return inboxSwitchOn(which, project, advancedRow(advancedDef(INBOX_SWITCH_ID[which])!, useStore.getState().advanced).value === true)
}
