import type { TestedCli } from './types'
import { msg, tr } from './i18n'

/**
 * The CLI versions this Hive release was tested with (#365), in words, for Provider Setup, Copy Diagnostics and the
 * Agent API: the versions side by side, and a note when the installed one isn't the tested one. Calm on purpose: a
 * newer CLI usually works, so nothing is blocked.
 */

/** "Tested with 2.1.287 · installed 2.1.290" (the installed version unknown: "installed version unknown"). */
export function testedSummary(t: TestedCli, installed: string | null): string {
  if (installed && t.installed !== 'unknown') return tr(msg({ id: 'agents.tested.summary', defaultMessage: 'Tested with {tested} · installed {installed}', description: "Provider Setup: the CLI version this Hive release was tested with ({tested}) and the one installed ({installed}), version numbers." }), { tested: t.version, installed })
  return tr(msg({ id: 'agents.tested.summaryUnknown', defaultMessage: 'Tested with {tested} · installed version unknown', description: "Provider Setup: the CLI version this Hive release was tested with ({tested}), and that the installed one's version isn't known." }), { tested: t.version })
}

/** What to make of the installed version against the tested one; null when they are the same. */
export function testedNote(t: TestedCli): string | null {
  switch (t.installed) {
    case 'same':
      return null
    case 'newer':
      return tr(msg({ id: 'agents.tested.newer', defaultMessage: 'This version came out after this Hive release was tested. Most updates work; if something behaves oddly, report it (Copy Diagnostics).', description: "Provider Setup: the installed CLI is newer than the one this Hive release was tested with. Copy Diagnostics is a Help command: use its translated name." }))
    case 'older':
      return tr(msg({ id: 'agents.tested.older', defaultMessage: 'Older than tested; consider updating.', description: 'Provider Setup: the installed CLI is older than the one this Hive release was tested with.' }))
    case 'unknown':
      return tr(msg({ id: 'agents.tested.unknown', defaultMessage: "Hive couldn't tell which version is installed, so it can't compare it with the tested one.", description: "Provider Setup: Hive couldn't read the installed CLI's version." }))
  }
}

/** The installed version against the tested one, in a few words (diagnostics, the Agent API). */
export const testedComparison = (t: TestedCli): string => (t.installed === 'same' ? 'the tested version' : t.installed === 'unknown' ? 'version unknown' : `${t.installed} than tested`) // i18n-ignore: diagnostics and the Agent API (English)
