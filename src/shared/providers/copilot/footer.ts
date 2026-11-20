import type { FooterModeDef } from '../../footerModes'

/**
 * Each mode's footer, by its two parts ("Plan · Manual Approval"), read by each part's first word: in a narrow terminal
 * Copilot wraps its footer item by item ("← open ·Interactive · Manual · / commands" over "sidebar Approval next tab",
 * 1.0.93). The defaults of the advanced settings copilot.footer.<key> (#696), case sensitive. Accept edits has none: its
 * footer is Ask's. Combwork has no mode for Assisted approval.
 */
export const COPILOT_FOOTER_MODES: readonly FooterModeDef[] = [
  { mode: 'ask', key: 'ask', label: 'Ask', pattern: String.raw`\bInteractive ?· ?Manual\b` }, // i18n-ignore: a footer's name in Settings → Advanced (advanced.ts words it)
  { mode: 'allow-all', key: 'allowAll', label: 'Allow all', pattern: String.raw`\bInteractive ?· ?Allow\b` }, // i18n-ignore: a footer's name in Settings → Advanced (advanced.ts words it)
  { mode: 'plan', key: 'plan', label: 'Plan', pattern: String.raw`\bPlan ?· ?(?:Manual|Allow|Assisted)\b` }, // i18n-ignore: a footer's name in Settings → Advanced (advanced.ts words it)
  { mode: 'autopilot', key: 'autopilot', label: 'Autopilot', pattern: String.raw`\bAutopilot ?· ?(?:Manual|Allow|Assisted)\b` } // i18n-ignore: a footer's name in Settings → Advanced (advanced.ts words it)
]
