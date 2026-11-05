import type { CloseReason } from './types'

// The close commands' placeholders (HI-1368): what main runs and what Settings previews, filled in the same way.

/** What a close command's placeholders stand for: the workspace's path and folder name (none for When Combwork quits), and why. */
export interface CloseCommandValues {
  workspace?: string
  name?: string
  reason: CloseReason
}

/**
 * The command with `{workspace}`, `{name}` and `{reason}` filled in, as written (the user quotes them where a path may
 * hold spaces). A placeholder with no value here (`{workspace}` in When Combwork quits) and any other `{…}` stay as they are.
 */
export function fillCloseCommand(command: string, v: CloseCommandValues): string {
  return command.replace(/\{(workspace|name|reason)\}/g, (all, key: keyof CloseCommandValues) => v[key] ?? all)
}

/** The command as saved, trimmed; empty: nothing runs. */
export const closeCommandOf = (s: { command?: unknown } | null | undefined): string => (typeof s?.command === 'string' ? s.command.trim() : '')
