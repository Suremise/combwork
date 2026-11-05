import type { PermissionMode } from '../../../shared/types'
import { advanced } from '../../advanced'

/**
 * Codex's /permissions menu (#396): each preset on a numbered line, by the label Codex draws for it. Codex 0.160 listed
 * Read Only, Ask for approval, Approve for me, Full Access; 0.161 lists Ask for approval, Approve for me, Full Access,
 * Read Only, whichever is current. So Combwork picks a preset by its label on the screen, never by where it used to be:
 *
 *   › 1. Ask for approval (current)  Read and edit workspace files and run commands, with approval required for …
 *     2. Approve for me              Only ask for actions detected as potentially unsafe
 */
const PERMISSIONS_MENU_LABEL_IDS: Record<PermissionMode, string> = {
  'read-only': 'codex.permissions.readOnly',
  ask: 'codex.permissions.ask',
  'approve-for-me': 'codex.permissions.approveForMe',
  'full-access': 'codex.permissions.fullAccess'
}

/** The label the menu shows for a preset: an advanced setting each (#685), so a renamed one can be fixed by an override. */
export function permissionsMenuLabel(target: PermissionMode): string | null {
  const id = PERMISSIONS_MENU_LABEL_IDS[target]
  return id ? advanced.get<string>(id) : null
}

/** A menu line: its number and label, after the selection marker, before "(current)" and the description. */
const LINE = /^\s*(?:›\s*)?(\d+)\.\s+(.*?)(?:\s\(current\))?(?:\s{2,}.*)?$/

/**
 * The number to type for `target` in the /permissions menu on this screen (the rendered terminal, a line per row), or
 * null while no menu line shows its label. The lowest such line wins: the menu is drawn at the bottom.
 */
export function permissionsMenuNumber(screen: string, target: PermissionMode): string | null {
  const want = permissionsMenuLabel(target)?.trim().toLowerCase()
  if (!want) return null
  let found: string | null = null
  for (const line of screen.split('\n')) {
    const m = LINE.exec(line.trimEnd())
    if (m && m[2].trim().toLowerCase() === want) found = m[1]
  }
  return found
}
