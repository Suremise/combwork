import type { ProviderModule } from './parts'
import claude from './claude'
import codex from './codex'
import copilot from './copilot'
import antigravity from './antigravity'
import opencode from './opencode'
import muse from './muse'

/**
 * Every provider Combwork knows (HI-3201), one line each, in display order: the first is the default. Shared code reads
 * providers only through this list (index.ts's helpers); main finds each one's adapter in src/main/providers/<folder>/.
 * Adding a provider: its two folders and a line here. Removing one: the same three.
 */
export const PROVIDER_MODULES: readonly ProviderModule[] = [claude, codex, copilot, antigravity, opencode, muse]

/** How many of PROVIDER_MODULES are built in: the user's own CLIs (HI-3196, data-only) come after them (index.ts). */
export const BUILT_IN_PROVIDERS = PROVIDER_MODULES.length

/**
 * The provider whose records were written before Combwork had providers (0.x): a session, agent or setting with no
 * provider of its own is its. An upgrade input, never a default for anything new.
 */
export const LEGACY_PROVIDER = claude.descriptor.id
