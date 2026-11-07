import { useId } from 'react'
import { providerDescriptor } from '@shared/providers'
import type { ProviderId } from '@shared/types'
import { cx } from '../util'
import { Icon } from './ui'

/** A badge's outline, in a 16-unit box: each provider has its own, so they tell apart in one colour too. */
const SHAPES = {
  circle: <circle cx="8" cy="8" r="7.5" />,
  square: <rect x="0.75" y="0.75" width="14.5" height="14.5" rx="3.5" />,
  diamond: <rect x="2.05" y="2.05" width="11.9" height="11.9" rx="2.6" transform="rotate(45 8 8)" />,
  hexagon: <path d="M8 0.6 L14.4 4.3 L14.4 11.7 L8 15.4 L1.6 11.7 L1.6 4.3 Z" strokeLinejoin="round" />
}

/** What a badge shows inside its outline: white on the colour, or cut out of the single-colour form. */
const GLYPHS = {
  // Not Combwork's own >_ prompt (its app icon), so no badge reads as Combwork's mark.
  tilde: <path d="M4.2 8.9 C5.2 6.6 6.6 6.4 8 7.8 C9.4 9.2 10.8 9.4 11.8 7.1" fill="none" strokeWidth="1.9" strokeLinecap="round" />,
  braces: (
    <path
      d="M6.4 4.4 C5 4.4 5.3 5.6 5.3 6.6 C5.3 7.4 4.9 8 4.2 8 C4.9 8 5.3 8.6 5.3 9.4 C5.3 10.4 5 11.6 6.4 11.6 M9.6 4.4 C11 4.4 10.7 5.6 10.7 6.6 C10.7 7.4 11.1 8 11.8 8 C11.1 8 10.7 8.6 10.7 9.4 C10.7 10.4 11 11.6 9.6 11.6"
      fill="none"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  ),
  chevrons: <path d="M4.6 5.3 L7.3 8 L4.6 10.7 M8.4 5.3 L11.1 8 L8.4 10.7" fill="none" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />,
  rise: <path d="M8 11.6 L8 4.6 M5.2 7.3 L8 4.5 L10.8 7.3" fill="none" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
}

/**
 * Combwork's own badge for each provider, keyed by the descriptor's icon: never a provider's logo (#470), but an outline,
 * a glyph and a colour of Combwork's, always shown with the provider's name or as its tooltip. A provider without one
 * here shows a neutral terminal icon.
 */
const BADGES: Record<string, { shape: keyof typeof SHAPES; glyph: keyof typeof GLYPHS; color: string }> = {
  claude: { shape: 'circle', glyph: 'tilde', color: '#e8705f' },
  codex: { shape: 'square', glyph: 'braces', color: '#14a89a' },
  copilot: { shape: 'diamond', glyph: 'chevrons', color: '#8b6cf0' },
  antigravity: { shape: 'hexagon', glyph: 'rise', color: '#3d8fd6' }
}

/**
 * A provider's badge, next to its name or in place of it (with the name as a tooltip by the caller). `mono` draws it
 * in the text colour with its glyph cut out, for coloured backgrounds such as the status bar.
 */
export function ProviderIcon({ provider, className, mono }: { provider: ProviderId; className?: string; mono?: boolean }) {
  const p = providerDescriptor(provider)
  const badge = BADGES[p.icon]
  const mask = `provider-cut-${useId().replace(/[^\w-]/g, '')}`
  return (
    <span className={cx('provider-icon', `provider-${p.icon}`, className)} aria-label={p.name} role="img">
      {!badge ? (
        <Icon name="terminal" />
      ) : mono ? (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <mask id={mask}>
            <rect width="16" height="16" fill="#fff" />
            <g fill="#000" stroke="#000">
              {GLYPHS[badge.glyph]}
            </g>
          </mask>
          <g fill="currentColor" mask={`url(#${mask})`}>
            {SHAPES[badge.shape]}
          </g>
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <g fill={badge.color}>{SHAPES[badge.shape]}</g>
          <g fill="#fff" stroke="#fff">
            {GLYPHS[badge.glyph]}
          </g>
        </svg>
      )}
    </span>
  )
}
