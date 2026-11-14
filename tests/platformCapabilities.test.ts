// HI-3140: version control stays pluggable. Shared code and the window ask a platform's descriptor, its presentation
// rows or its port, never its id; these pin that each answer is exactly what the id switches it replaced gave, for Git,
// jj and None: the form's finish and folder choices, the agents' rule keys, the Version Control tab's fact line and its
// caution, the Agent API's found text, the slot pool's reading of jj's refusals, and the descriptor's own new data.
import { describe, expect, it } from 'vitest'
import { allRuleKeys, ownsWorkspaces, PLATFORMS, platformName, ruleKeyOf, type Detection, type PlatformId, type ProjectPlatform } from '../src/shared/platform/descriptors'
import { detectedCaution, factOf, PLATFORM_VIEW } from '../src/shared/platform/presentation'
import { formFinishes, formFolders } from '../src/shared/workflow/options'
import { platformRule, withPlatformRule } from '../src/shared/combworkGuidance'
import { FOUND } from '../src/main/platform/agentPresentation'
import { JJ_REFUSED, jjRefusal } from '../src/main/platform/jjWorkspacePort'
import { STORE_SIDES, noStoreFor, leavingSides } from '../src/main/platform/storeSides'

const IDS: PlatformId[] = ['git', 'jj', 'none']

/** The detections a fact line and a found text are asked of: each platform's, colocated or not, inside Git, other, none. */
const DETECTIONS: Detection[] = [
  { platform: 'git', root: 'D:\\r' },
  { platform: 'git', root: 'D:\\r', subfolder: true },
  { platform: 'git' },
  { platform: 'jj', root: 'D:\\j', jj: { colocated: true } },
  { platform: 'jj', root: 'D:\\j', jj: { colocated: false } },
  { platform: 'jj', root: 'D:\\j', jj: { colocated: false, inGit: 'D:\\outer' } },
  { platform: 'jj', root: 'D:\\j' },
  { platform: 'none' },
  { platform: 'none', other: 'Mercurial' },
  { platform: 'git', root: 'D:\\r', other: 'Mercurial' }
]

/** Today's fact line before HI-3140 (VersionControlHeader's factText, its message ids and values), verbatim in logic. */
function oldFact(p: ProjectPlatform): { id: string; values?: Record<string, string> } {
  const d = p.detected
  if (d.other) return { id: p.id === 'git' ? 'git.vc.fact.otherGit' : 'git.vc.fact.other', values: { vcs: d.other } }
  if (d.platform === 'jj') return d.jj?.inGit ? { id: 'git.vc.fact.jjInGit', values: { root: d.root ?? '', git: d.jj.inGit } } : { id: 'git.vc.fact.jj', values: { root: d.root ?? '', colocated: d.jj?.colocated ? 'yes' : 'no' } }
  if (p.id === 'jj') return { id: 'git.vc.fact.jjGone' }
  if (PLATFORMS[p.id].repository && d.platform !== p.id) return { id: 'git.vc.fact.gone' }
  if (d.platform === 'git' && d.root) return { id: d.subfolder ? 'git.vc.fact.subfolder' : 'git.vc.fact.repo', values: { root: d.root } }
  return { id: 'git.vc.fact.none' }
}

describe('HI-3140: the descriptor, presentation and port answers equal the id switches they replaced', () => {
  it("offers the form's finishes and folders exactly as before, in order", () => {
    expect(formFinishes('git')).toEqual(['combworkMerges', 'agentMerges', 'committed', 'notChecked'])
    expect(formFinishes('none')).toEqual(['combworkMerges', 'agentMerges', 'committed', 'notChecked'])
    expect(formFinishes('jj')).toEqual(['userIntegrates'])
    expect(formFolders('git')).toEqual(['slots', 'project'])
    expect(formFolders('none')).toEqual(['slots', 'project'])
    expect(formFolders('jj')).toEqual(['slots'])
  })

  it("gives the agents' rule keys as before: jj's two, in the guidance revision's order, by what detection found", () => {
    // The guidance revision hashes these texts in this order (guidance.ts): jj, then jj-separate.
    expect(allRuleKeys()).toEqual(['jj', 'jj-separate'])
    const at = (d: Detection | null) => () => d
    expect(ruleKeyOf('jj', at({ platform: 'jj', root: 'D:\\j', jj: { colocated: true } }))).toBe('jj')
    expect(ruleKeyOf('jj', at({ platform: 'jj', root: 'D:\\j', jj: { colocated: false } }))).toBe('jj-separate')
    // Detection that found no jj (unknown, or its .jj gone): the colocated rule, as `platformRuleKey('jj', …) ?? 'jj'` gave.
    expect(ruleKeyOf('jj', at({ platform: 'none' }))).toBe('jj')
    expect(ruleKeyOf('jj', at(null))).toBe('jj')
    // Git and None: none (CW_PLATFORM unset; the instructions without a rule, as platformRule('git') was empty).
    let asked = 0
    const counted = () => {
      asked++
      return null
    }
    expect(ruleKeyOf('git', counted)).toBeNull()
    expect(ruleKeyOf('none', counted)).toBeNull()
    expect(ruleKeyOf(undefined, counted)).toBeNull()
    expect(ruleKeyOf('hg', counted)).toBeNull()
    // Detection, which reads the folder, is asked only for a platform with a rule (as before: only for jj).
    expect(asked).toBe(0)
    expect(platformRule('jj')).not.toBe('')
    expect(platformRule('jj-separate')).not.toBe('')
    expect(platformRule('jj')).not.toBe(platformRule('jj-separate'))
    for (const k of ['git', 'none', '', null, undefined, 'toString']) expect(platformRule(k)).toBe('')
    expect(withPlatformRule('x', null)).toBe('x')
    expect(withPlatformRule('x', 'jj')).toBe(`x\n${platformRule('jj')}`)
  })

  it("says the tab's fact line, and its caution, as before for every platform and detection", () => {
    for (const id of IDS)
      for (const d of DETECTIONS) {
        const p: ProjectPlatform = { id, capabilities: PLATFORMS[id].capabilities, detected: d }
        const f = factOf(p)
        const was = oldFact(p)
        expect({ id: f.m.id, values: f.values }, `${id} ${JSON.stringify(d)}`).toEqual({ id: was.id, values: was.values })
        expect(detectedCaution(d), JSON.stringify(d)).toBe(d.platform === 'jj' && !!d.jj?.inGit)
      }
  })

  it("names the offer's button and the None · Git preview as before", () => {
    expect(PLATFORM_VIEW.git.switchTo.id).toBe('git.vc.offer.switchGit')
    expect(PLATFORM_VIEW.jj.switchTo.id).toBe('git.vc.offer.switchJj')
    expect(PLATFORM_VIEW.none.switchTo.id).toBe('git.vc.offer.switchNone')
    // The preview moved between None and Git's page (`id !== 'jj'`), its tooltip on Git (`id === 'git'`).
    expect(IDS.filter((id) => PLATFORM_VIEW[id].previewable)).toEqual(['git', 'none'])
  })

  it("tells agents what was found as before (servers' versionControlOf)", () => {
    const old = (d: Detection): string =>
      d.platform === 'git' ? `git at ${d.root ?? ''}${d.subfolder ? ' (a subfolder of that repository)' : ''}` : d.platform === 'jj' ? `jj at ${d.root ?? ''}${d.jj?.colocated ? ' (colocated with git)' : ' (not colocated: no git working copy)'}` : 'none'
    for (const d of DETECTIONS.filter((x) => !x.other)) expect(FOUND[d.platform](d), JSON.stringify(d)).toBe(old(d))
  })

  it("reads jj's refusals for the slot pool as its id switches did", () => {
    expect(jjRefusal(JJ_REFUSED.fence)).toBe('fence')
    expect(jjRefusal(JJ_REFUSED.uncertain)).toBe('uncertain')
    expect(jjRefusal(JJ_REFUSED.stale)).toBe('stale')
    for (const held of [JJ_REFUSED.unintegrated, JJ_REFUSED.notIntegrated, JJ_REFUSED.divergent, JJ_REFUSED.notEmpty, JJ_REFUSED.journal]) expect(jjRefusal(held)).toBe('held')
    for (const other of [JJ_REFUSED.identity, JJ_REFUSED.heads, JJ_REFUSED.exists, 'busy', 'anything else', '']) expect(jjRefusal(other)).toBeNull()
  })

  it("keeps the descriptor's names, owned workspaces and detection as the id switches had them", () => {
    expect(IDS.map(platformName)).toEqual(['Git', 'jj', 'None'])
    expect(platformName('hg')).toBe('hg')
    expect(IDS.filter((id) => ownsWorkspaces(id))).toEqual(['jj'])
    expect([ownsWorkspaces(null), ownsWorkspaces(undefined)]).toEqual([false, false])
    expect(IDS.filter((id) => PLATFORMS[id].detectionSteady)).toEqual(['jj'])
  })

  it("asks a store switch's sides as storeSwitch's id switches did", () => {
    expect([noStoreFor('jj'), noStoreFor('git'), noStoreFor('none')]).toEqual(['noJj', 'noGit', 'noGit'])
    expect(IDS.filter((id) => !!STORE_SIDES[id]?.arrive)).toEqual(['jj'])
    expect(leavingSides()).toEqual([STORE_SIDES.jj])
    // jj's gates refused whatever the repository: its descriptor's, less those a repository is assessed for.
    expect(STORE_SIDES.jj!.arrive!.unsupported.every((g) => PLATFORMS.jj.gates.includes(g))).toBe(true)
  })
})
