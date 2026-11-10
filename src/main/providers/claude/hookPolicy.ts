import { msg, tr } from '../../../shared/i18n'
import type { HookCause } from '../../../shared/types'
import type { SettingsScope } from './autoCompact'
import { usedAdminSources, type AdminSourceKind, type ChannelSources } from './updateChannel'

// What on this PC would keep Combwork's hooks from reaching Claude Code's sessions (HI-2777), read only, for the warning
// when they don't arrive. Only what is local is read: the registry policies, the managed settings file with its
// drop-ins (chosen as Claude Code chooses them: updateChannel.ts usedAdminSources), and the other settings scopes. An
// organisation's server-managed settings come first and aren't on the PC: when it has them, the local managed sources
// aren't used at all. So whatever this finds is what Combwork observed here, never the effective policy.

const LABELS: Record<AdminSourceKind, () => string> = {
  hklm: () => tr(msg({ id: 'providers.claude.policy.hklm', defaultMessage: "the computer's Claude Code policy in the registry (HKLM)", description: "Where a Claude Code setting that blocks Combwork's hooks was found: a policy in the Windows registry for the whole computer. Used after \"in\" or as a subject in the hooks warning. Keep HKLM." })),
  file: () => tr(msg({ id: 'providers.claude.policy.file', defaultMessage: "Claude Code's managed settings file", description: "Where a Claude Code setting that blocks Combwork's hooks was found: the managed-settings.json an administrator gives Claude Code (C:\\Program Files\\ClaudeCode). Used after \"in\" or as a subject in the hooks warning." })),
  hkcu: () => tr(msg({ id: 'providers.claude.policy.hkcu', defaultMessage: "your Claude Code policy in the registry (HKCU)", description: "Where a Claude Code setting that blocks Combwork's hooks was found: a policy in the Windows registry for the current user. Used after \"in\" or as a subject in the hooks warning. Keep HKCU." }))
}

/** A settings value as a list of strings, or null when it isn't a list. */
const list = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null)

/** Whether a URL matches one of Claude Code's allowlist patterns (`*` matches anything; the host's case is ignored). */
export function urlAllowed(url: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(url))
}

const obj = (j: unknown): Record<string, unknown> | null => (j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null)

/** What usedAdminSources answered: the managed sources used, or the first that couldn't be read. */
export type AdminRead = { used: { kind: AdminSourceKind; settings: Record<string, unknown> }[] } | { unreadable: AdminSourceKind }

/**
 * The cause Combwork can see of a launch's hooks not arriving, first that applies, or null:
 * 1. a managed source it would use can't be read: what it holds can't be told (said, never taken as none);
 * 2. the managed sources Claude Code uses turn hooks off (disableAllHooks): every hook is off, managed ones too, so the
 *    admin snippet can't help;
 * 3. they allow only their own hooks (allowManagedHooksOnly): the snippet can (a disableAllHooks in a scope below doesn't
 *    turn managed hooks off, so it is named beside it). Merged sources (managedSourcesBehavior "merge") lock it if any
 *    of them does, the first that does named;
 * 4. an HTTP hook allowlist (allowedHttpHookUrls, or httpHookAllowedEnvVars without the token's variable; Claude Code
 *    merges them across files) doesn't let the hook through;
 * 5. the settings scope that decides disableAllHooks (the first, highest first, that sets it) turns them off;
 * 6. a settings scope Combwork couldn't read (or can't tell whether Claude Code reads): it can't be told.
 * `admin` is usedAdminSources' answer (null: it failed), `scopes` settingsScopes' (its managed file is in `admin`).
 */
export function hookCause(admin: AdminRead | null, scopes: readonly SettingsScope[], need: { url: string; envVar: string }): HookCause | null {
  if (admin && 'unreadable' in admin) return { why: 'unreadable', setting: '', where: LABELS[admin.unreadable](), snippet: true } // i18n-ignore: a select key, never shown
  const managed = admin?.used ?? []
  const others = scopes.filter((s) => s.kind !== 'managed')
  // A lock any used source sets: the first that sets it on.
  const locked = (key: string): AdminSourceKind | null => managed.find((a) => a.settings[key] === true)?.kind ?? null
  const deciding = others.find((s) => typeof obj(s.json)?.disableAllHooks === 'boolean')
  const lowerOff = deciding && obj(deciding.json)!.disableAllHooks === true ? deciding.label : undefined
  const off = locked('disableAllHooks')
  if (off) return { why: 'off', setting: 'disableAllHooks', where: LABELS[off](), snippet: false } // i18n-ignore: select keys and setting names, never shown
  const only = locked('allowManagedHooksOnly')
  if (only) return { why: 'managedOnly', setting: 'allowManagedHooksOnly', where: LABELS[only](), snippet: true, ...(lowerOff ? { also: lowerOff } : {}) } // i18n-ignore: select keys and setting names, never shown
  // The allowlists, merged across every file that sets one.
  const files = [...managed.map((a) => ({ where: LABELS[a.kind](), json: a.settings as unknown })), ...others.map((s) => ({ where: s.label, json: s.json }))]
  const allow = (key: string, ok: (entries: string[]) => boolean): HookCause | null => {
    const setting = files.filter((f) => list(obj(f.json)?.[key]) !== null)
    if (!setting.length) return null
    const entries = setting.flatMap((f) => list(obj(f.json)![key])!)
    return ok(entries) ? null : { why: 'blocked', setting: key, where: setting[0].where, snippet: true } // i18n-ignore: select keys and setting names, never shown
  }
  const blocked = allow('allowedHttpHookUrls', (e) => urlAllowed(need.url, e)) ?? allow('httpHookAllowedEnvVars', (e) => e.includes(need.envVar))
  if (blocked) return blocked
  if (lowerOff) return { why: 'off', setting: 'disableAllHooks', where: lowerOff, snippet: false } // i18n-ignore: select keys and setting names, never shown
  const unsure = others.find((s) => s.unsure !== undefined)
  if (unsure) return { why: 'unreadable', setting: '', where: unsure.label, snippet: true } // i18n-ignore: a select key, never shown
  return null
}

/** hookCause for this PC's managed sources (`sources`, as updateChannel.ts reads them) and a launch's scopes. */
export async function readHookCause(sources: Pick<ChannelSources, 'hklm' | 'files' | 'hkcu'>, scopes: readonly SettingsScope[], need: { url: string; envVar: string }): Promise<HookCause | null> {
  return hookCause(await usedAdminSources(sources).catch(() => null), scopes, need)
}
