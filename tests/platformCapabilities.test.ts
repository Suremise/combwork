// HI-3140: version control stays pluggable. Shared code and the window ask a platform's descriptor, its presentation
// rows or its port, never its id; these pin that each answer is exactly what the id switches it replaced gave, for Git
// and None: the form's finish and folder choices, the Version Control tab's fact line, the Agent API's found text, and
// the descriptor's own data.
import { describe, expect, it } from 'vitest'
import { hasCapability, merges, PLATFORMS, type Detection, type PlatformId, type ProjectPlatform } from '../src/shared/platform/descriptors'
import { factOf, PLATFORM_VIEW } from '../src/shared/platform/presentation'
import { formFinishes, formFolders } from '../src/shared/workflow/options'
import { FOUND } from '../src/main/platform/agentPresentation'

const IDS: PlatformId[] = ['git', 'none']

/** The detections a fact line and a found text are asked of: each platform's, a subfolder, other, none. */
const DETECTIONS: Detection[] = [
  { platform: 'git', root: 'D:\\r' },
  { platform: 'git', root: 'D:\\r', subfolder: true },
  { platform: 'git' },
  { platform: 'none' },
  { platform: 'none', other: 'Mercurial' },
  { platform: 'git', root: 'D:\\r', other: 'Mercurial' }
]

/** Today's fact line before HI-3140 (VersionControlHeader's factText, its message ids and values), verbatim in logic. */
function oldFact(p: ProjectPlatform): { id: string; values?: Record<string, string> } {
  const d = p.detected
  if (d.other) return { id: p.id === 'git' ? 'git.vc.fact.otherGit' : 'git.vc.fact.other', values: { vcs: d.other } }
  if (PLATFORMS[p.id].repository && d.platform !== p.id) return { id: 'git.vc.fact.gone' }
  if (d.platform === 'git' && d.root) return { id: d.subfolder ? 'git.vc.fact.subfolder' : 'git.vc.fact.repo', values: { root: d.root } }
  return { id: 'git.vc.fact.none' }
}

describe('HI-3140: the descriptor, presentation and port answers equal the id switches they replaced', () => {
  it("offers the form's finishes and folders exactly as before, in order", () => {
    expect(formFinishes('git')).toEqual(['combworkMerges', 'agentMerges', 'committed', 'notChecked'])
    // HI-2840: None's own finish, its descriptor's (its form has no finish row, so nothing it shows changed).
    expect(formFinishes('none')).toEqual(['accept'])
    expect(formFolders('git')).toEqual(['slots', 'project'])
    expect(formFolders('none')).toEqual(['slots', 'project'])
  })

  it("says the tab's fact line as before for Git and None, and every detection of theirs", () => {
    for (const id of ['git', 'none'] as const)
      for (const d of DETECTIONS) {
        const p: ProjectPlatform = { id, capabilities: PLATFORMS[id].capabilities, detected: d }
        const f = factOf(p)
        const was = oldFact(p)
        expect({ id: f.m.id, values: f.values }, `${id} ${JSON.stringify(d)}`).toEqual({ id: was.id, values: was.values })
      }
  })

  it("names the offer's button and the None · Git preview as before", () => {
    expect(PLATFORM_VIEW.git.switchTo.id).toBe('git.vc.offer.switchGit')
    expect(PLATFORM_VIEW.none.switchTo.id).toBe('git.vc.offer.switchNone')
  })

  it("tells agents what was found as before (servers' versionControlOf)", () => {
    const old = (d: Detection): string =>
      d.platform === 'git' ? `git at ${d.root ?? ''}${d.subfolder ? ' (a subfolder of that repository)' : ''}` : 'none'
    for (const d of DETECTIONS.filter((x) => !x.other)) expect(FOUND[d.platform](d), JSON.stringify(d)).toBe(old(d))
  })

  it("keeps the descriptor's names as the id switches had them", () => {
    expect(IDS.map((id) => PLATFORMS[id].name)).toEqual(['Git', 'None'])
  })

  it('HI-3487: check copies follow isolation, and moving a card to another target follows merging (the capabilities they folded into)', () => {
    expect(IDS.filter((id) => hasCapability(id, 'isolation'))).toEqual(['git'])
    expect(IDS.filter((id) => merges(id))).toEqual(['git'])
  })
})
