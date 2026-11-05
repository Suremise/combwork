import type { SessionStatus } from './types'
import { tr } from './i18n'
import { msg } from './i18n/msg'

/** Settings → General → Keep the PC awake while agents work. */
export type KeepAwakeSetting = 'plugged-in' | 'always' | 'never'

/** Agents that count as working for this: working, or waiting on background tasks that will start them again. */
export function agentsWorking(states: readonly { status: SessionStatus }[]): number {
  return states.filter((s) => s.status === 'working' || s.status === 'background').length
}

/** Whether to keep Windows from sleeping now. The screen may still turn off and lock. */
export function shouldKeepAwake(working: number, setting: KeepAwakeSetting | undefined, onBattery: boolean): boolean {
  if (working <= 0 || setting === 'never') return false
  return setting === 'always' || !onBattery
}

const AWAKE = msg({ id: 'workspace.statusBar.keepAwake', defaultMessage: 'Keeping the PC awake: {working, plural, one {# agent} other {# agents}} working', description: "The status bar's note while Combwork keeps Windows from sleeping because agents are working (Settings → General → Keep the PC awake)." })

/** The status bar's note while it does. */
export function keepAwakeText(working: number): string {
  return tr(AWAKE, { working })
}
