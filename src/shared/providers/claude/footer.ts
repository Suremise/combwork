import type { FooterModeDef } from '../../footerModes'

/**
 * A mode's footer: its words after Claude Code's mode symbol (⏵⏵ or ⏸), or followed by its hint ("(shift+tab to
 * cycle)" or "·"). Manual shows only "⏸ manual mode on" (Claude Code 2.1.286), so the symbol is needed.
 */
const footer = (words: string): string => String.raw`[⏵⏸][\s⏵⏸]*${words}\s*on\b|${words}\s*on\s*(?:\(|·)`

/** Each mode's footer (Claude Code 2.1.296): the defaults of the advanced settings claude-code.footer.<key> (#696), flags i. */
export const CLAUDE_FOOTER_MODES: readonly FooterModeDef[] = [
  { mode: 'manual', key: 'manual', label: 'Manual', pattern: footer(String.raw`manual\s*mode`) }, // i18n-ignore: a footer's name in Settings → Advanced (advanced.ts words it)
  { mode: 'acceptEdits', key: 'acceptEdits', label: 'Accept edits', pattern: footer(String.raw`accept\s*edits`) }, // i18n-ignore: a footer's name in Settings → Advanced (advanced.ts words it)
  { mode: 'plan', key: 'plan', label: 'Plan', pattern: footer(String.raw`plan\s*mode`) }, // i18n-ignore: a footer's name in Settings → Advanced (advanced.ts words it)
  { mode: 'auto', key: 'auto', label: 'Auto', pattern: footer(String.raw`auto\s*mode`) }, // i18n-ignore: a footer's name in Settings → Advanced (advanced.ts words it)
  { mode: 'bypassPermissions', key: 'bypassPermissions', label: 'Bypass permissions', pattern: footer(String.raw`bypass\s*permissions`) }, // i18n-ignore: a footer's name in Settings → Advanced (advanced.ts words it)
  { mode: 'dontAsk', key: 'dontAsk', label: "Don't ask", pattern: footer(String.raw`don['’]?t\s*ask`) } // i18n-ignore: a footer's name in Settings → Advanced (advanced.ts words it)
]
