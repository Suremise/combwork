// Agent text (dialects, HI-2065), card 5's launch and provider text (HI-2438): a skill delivery's problems and a swap's
// reasons (fsutil.ts, `skillCopy.*`), and the permission modes' names and descriptions agents read (`mode.*`). Each says
// its Default English byte for byte; the canary dialect finds every word of it in the catalogue; and what is stored (a
// delivery's problem, a kept revision's reason) stays in the Default whatever the session's dialect.
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'path'
import { inDialectOf, say, setChainResolver, setProcessChain, type DialectChain } from '../src/shared/agentText'
import { canaryProblems, canaryTexts } from '../src/shared/agentText/canary'
import { linksNotCopied, overBytes, sourceProblem, tooBigToDeliver, ContentTooLarge, CopyFailed, SKILL_COPY_MESSAGES } from '../src/main/fsutil'
import { CLAUDE_PERMISSION_MODES, claudeModeCaveat } from '../src/shared/claude'
import { CODEX_PERMISSION_MODES } from '../src/shared/codex'
import { COPILOT_PERMISSION_MODES } from '../src/shared/copilot'
import { ANTIGRAVITY_PERMISSION_MODES } from '../src/shared/antigravity'
import { OPENCODE_PERMISSION_MODES } from '../src/shared/opencode'
import { CLI_OWN_OPTION } from '../src/shared/cliOwnMode'
import { modeBadgeLabel, modeDescription, permissionLabel } from '../src/shared/providers'
// @ts-expect-error: a plain .mjs module without types
import { readCatalogue } from '../scripts/agentTextExtract.mjs'

const ROOT = join(__dirname, '..')
type Catalogue = Record<string, { text: string; note?: string }>
const catalogue = readCatalogue(ROOT) as Catalogue
const ids = new Set(Object.keys(catalogue))
const chain = (texts: Record<string, string>): DialectChain => ({ texts, files: ['test.json'], hash: 'test' })
const canary = (): void => setProcessChain(chain(canaryTexts(catalogue)))
const errno = (code: string): Error => Object.assign(new Error(code), { code })
const MODES = [...CLAUDE_PERMISSION_MODES, ...CODEX_PERMISSION_MODES, ...COPILOT_PERMISSION_MODES, ...ANTIGRAVITY_PERMISSION_MODES, ...OPENCODE_PERMISSION_MODES, CLI_OWN_OPTION]

afterEach(() => {
  setProcessChain(null)
  setChainResolver(null)
})

/**
 * Every skillCopy message, said as fsutil says it with each case's values. fsutil says them in the Default (they are
 * stored), so the canary reads the messages themselves here; the Default test checks fsutil's calls give the same text.
 */
function skillCopyTexts(): { name: string; text: string; values: string[] }[] {
  const A = SKILL_COPY_MESSAGES
  const v: Record<keyof typeof A, Record<string, string | number>[]> = {
    fileWent: [{}],
    folderGone: [{}],
    denied: [{}],
    notCopied: [{ hasCode: 'yes', code: 'ENOSPC' }, { hasCode: 'no', code: '' }],
    changedBeforeReplaced: [{ name: 'my-skill' }],
    changedWhileReplaced: [{ name: 'my-skill' }],
    putBackWhileReplaced: [{ name: 'my-skill' }],
    changedKeptBeside: [{ name: 'my-skill' }],
    changedBeforeRemoved: [{ name: 'my-skill' }],
    changedWhileRemoved: [{ name: 'my-skill' }],
    overBytes: [{ mb: '64' }],
    tooDeep: [{ depth: '12' }],
    tooMany: [{ entries: '2000' }],
    tooBigToDeliver: [{ why: 'WHY' }],
    linksNotCopied: [{ n: 1, paths: 'a/b.md' }, { n: 2, paths: 'a/b.md, c.md' }]
  }
  return (Object.keys(v) as (keyof typeof A)[]).flatMap((k) => v[k].map((values) => ({ name: k, text: say(A[k], values), values: Object.values(values).map(String).filter((x) => x.length > 2) })))
}

/** Every mode text agents read, and the Auto caveats. */
function modeTexts(): { name: string; text: string; values: string[] }[] {
  const out: { name: string; text: string; values: string[] }[] = []
  // Codex's Ask for approval and Approve for me keep their labels: they are Codex's own preset names too, which its
  // adapter matches in Codex's output (protocol).
  const protocol = new Set(CODEX_PERMISSION_MODES.filter((m) => m.value === 'ask' || m.value === 'approve-for-me'))
  for (const m of MODES) for (const f of ['label', 'description', 'short', 'cliNote'] as const) if (m[f] !== undefined && !(f === 'label' && protocol.has(m))) out.push({ name: `${m.value} ${f}`, text: m[f]!, values: [] })
  out.push({ name: 'auto unsupported', text: claudeModeCaveat('auto', 'claude-haiku-4-5', { supportsAuto: false, label: 'Haiku 4.5' })!, values: ['Haiku 4.5'] })
  out.push({ name: 'auto maybe', text: claudeModeCaveat('auto', 'claude-haiku-4-5')!, values: ['Haiku 4.5'] })
  return out
}

describe("card 5's launch and provider text, in the Default", () => {
  it("says a skill delivery's problems and a copy's limits as before", () => {
    expect(sourceProblem(errno('ENOENT'), join(ROOT, 'no-such-folder'))).toBe('its folder in the workspace is gone')
    expect(sourceProblem(errno('ENOENT'), ROOT)).toBe('a file in it went while it was being copied')
    expect(sourceProblem(errno('EACCES'), ROOT)).toBe('its folder in the workspace could not be read (access denied)')
    expect(sourceProblem(errno('ENOSPC'), ROOT)).toBe('it could not be copied (ENOSPC)')
    expect(sourceProblem(new CopyFailed('x' as never, { cause: errno('EIO') }), ROOT)).toBe('it could not be copied (EIO)')
    expect(sourceProblem(new Error('x'), ROOT)).toBe('it could not be copied')
    expect(linksNotCopied(['a/b.md'])).toBe("the link a/b.md is missing from its copy: Windows didn't let Combwork make it (a link to a file needs a privilege)")
    expect(linksNotCopied(['a/b.md', 'c.md'])).toBe("the links a/b.md, c.md are missing from its copy: Windows didn't let Combwork make them (a link to a file needs a privilege)")
    expect(overBytes(64 * 1024 * 1024)).toBe('it is over 64 MB')
    expect(overBytes(1536 * 1024 * 1024)).toBe('it is over 1536 MB')
    expect(tooBigToDeliver(new ContentTooLarge('it has folders more than 12 deep'))).toBe('it is too big for Combwork to check (it has folders more than 12 deep)')
    const A = SKILL_COPY_MESSAGES
    expect(say(A.changedBeforeReplaced, { name: 'web' })).toBe('web changed before it could be replaced')
    expect(say(A.changedWhileReplaced, { name: 'web' })).toBe('web changed while it was being replaced')
    expect(say(A.putBackWhileReplaced, { name: 'web' })).toBe('web was put back while it was being replaced')
    expect(say(A.changedKeptBeside, { name: 'web' })).toBe('web changed while it was being replaced; the edited copy is kept beside it')
    expect(say(A.changedBeforeRemoved, { name: 'web' })).toBe('web changed before it could be removed')
    expect(say(A.changedWhileRemoved, { name: 'web' })).toBe('web changed while it was being removed')
    expect(say(A.tooDeep, { depth: '12' })).toBe('it has folders more than 12 deep')
    expect(say(A.tooMany, { entries: '2000' })).toBe('it has more than 2000 files and folders')
  })

  it("says the modes' names and descriptions as before, and as the window's English", () => {
    for (const m of MODES) {
      expect(m.label, m.value).toBe(m.text!.label.defaultMessage)
      expect(m.description, m.value).toBe(m.text!.description.defaultMessage)
      if (m.cliNote !== undefined) expect(m.cliNote, m.value).toBe(m.text!.cliNote!.defaultMessage)
      if (m.short !== undefined) expect(m.short, m.value).toBe(m.text!.short!.defaultMessage)
    }
    expect(permissionLabel('claude-code', 'bypassPermissions')).toBe('Bypass permissions')
    expect(modeDescription('codex', 'read-only')).toBe('Reads workspace files; asks before any edit or internet access.')
    expect(modeBadgeLabel('copilot', 'cli-own')).toBe("CLI's own")
    expect(claudeModeCaveat('auto', 'claude-haiku-4-5', { supportsAuto: false, label: 'Haiku 4.5' })).toBe("Claude Code doesn't offer Auto with Haiku 4.5: it runs in Manual instead (asking before edits and commands), and Combwork shows that mode.")
    expect(claudeModeCaveat('auto', 'claude-haiku-4-5')).toBe("Claude Code may not offer Auto with Haiku. If it doesn't, it runs in Manual (asking before edits and commands), and Combwork shows that mode.")
  })
})

describe("the canary dialect over card 5's launch and provider text", () => {
  it('finds every word of it in the catalogue, and every skillCopy and mode id in some text', () => {
    canary()
    const seen = new Set<string>()
    for (const { name, text, values } of [...skillCopyTexts(), ...modeTexts()]) {
      expect(canaryProblems(text, ids, values), name).toEqual([])
      for (const m of text.matchAll(/⟦([^/⟧][^⟧]*)⟧/g)) seen.add(m[1])
    }
    const said = [...ids].filter((id) => id.startsWith('mode.') || id.startsWith('skillCopy.'))
    expect(said.filter((id) => !seen.has(id))).toEqual([])
  })

  it("keeps what is stored in the Default: a delivery's problem and a copy's reasons are the same in any dialect", () => {
    canary()
    setChainResolver(() => chain(canaryTexts(catalogue)))
    const inSession = inDialectOf({ projectPath: 'C:/ws/p', agentId: 'a1' }, () => [sourceProblem(errno('EPERM'), ROOT), linksNotCopied(['a.md']), overBytes(1024 * 1024), tooBigToDeliver(new ContentTooLarge('x'))])
    expect(inSession).toEqual(['its folder in the workspace could not be read (access denied)', "the link a.md is missing from its copy: Windows didn't let Combwork make it (a link to a file needs a privilege)", 'it is over 1 MB', 'it is too big for Combwork to check (x)'])
    // Every skillCopy id is one of fsutil's messages, said through `stored` (the Default).
    expect([...ids].filter((id) => id.startsWith('skillCopy.')).sort()).toEqual(Object.values(SKILL_COPY_MESSAGES).map((m) => m.id).sort())
  })

  it("says a mode in the reader's dialect, as it is read", () => {
    setChainResolver((scope) => chain(scope.kind === 'session' ? { 'mode.claude.plan.desc': 'Plans only.' } : {}))
    const plan = CLAUDE_PERMISSION_MODES.find((m) => m.value === 'plan')!
    expect(inDialectOf({ projectPath: 'C:/ws/p', agentId: 'a1' }, () => plan.description)).toBe('Plans only.')
    expect(plan.description).toBe('Read-only: explores and proposes a plan, changes nothing until you approve.')
  })
})
