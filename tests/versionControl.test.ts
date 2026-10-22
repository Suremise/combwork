// The Version Control tab's sections (#1416, SPEC §16.6): Workflow, then the platform's own (Git: Changes, History,
// Branches & remotes, Merge queue; None: none), and a None project's Merge queue while an old Git ruleset's queue is still
// there by #1356's actual-state rule (testing, paused, only an unseen return), gone once that is clear. The section a
// project opens at, and a kept one no longer shown.
import { describe, expect, it } from 'vitest'
import { vcSections, vcSectionShown } from '../src/shared/gitRepo'
import { RETURN_SEEN_SHOWN_MS, type QueueRecent, type QueueView } from '../src/shared/workflow/queue'

const NOW = new Date(2026, 9, 22, 12, 0, 0).getTime()
const iso = (ms: number): string => new Date(ms).toISOString()

const view = (over: Partial<QueueView> = {}): QueueView => ({
  project: 'alpha',
  projectPath: 'D:\\ws\\alpha',
  target: 'main',
  paused: null,
  runBy: null,
  runHere: false,
  testing: null,
  queued: [],
  recent: [],
  returns: [],
  returnsMore: 0,
  hiveMerges: false,
  inFlight: [],
  ...over
})

const returned = (over: Partial<QueueRecent> = {}): QueueRecent => ({ card: 61, key: 'HI-61', title: 'Tidy', entry: 'HI-61/e9', outcome: 'returned', reason: 'conflict', files: ['tasks.ts'], at: iso(NOW - 60_000), ...over })
const testing: QueueView['testing'] = { card: 61, key: 'HI-61', title: 'Tidy', entry: 'HI-61/e9', revision: 'a'.repeat(40), expected: null, started: iso(NOW - 60_000), step: null, run: null }

describe('the Version Control tab’s sections', () => {
  it('Git: Workflow, Changes, History, Branches & remotes and Merge queue, with or without a queue', () => {
    expect(vcSections('git', [], NOW)).toEqual(['workflow', 'changes', 'history', 'branches', 'queue'])
    expect(vcSections('git', [view({ testing })], NOW)).toEqual(['workflow', 'changes', 'history', 'branches', 'queue'])
  })

  it('None: Workflow only, with no queue or one that is clear', () => {
    expect(vcSections('none', [], NOW)).toEqual(['workflow'])
    expect(vcSections('none', [view()], NOW)).toEqual(['workflow'])
  })

  it('None keeps an old Git queue’s section while it tests, is paused, or has only an unseen return', () => {
    expect(vcSections('none', [view({ testing })], NOW)).toEqual(['workflow', 'queue'])
    expect(vcSections('none', [view(), view({ target: 'release', paused: { reason: 'user', card: null, files: [], by: 'user', at: iso(NOW) } })], NOW)).toEqual(['workflow', 'queue'])
    expect(vcSections('none', [view({ returns: [returned()] })], NOW)).toEqual(['workflow', 'queue'])
  })

  it('None’s queue section goes once that state is clear: the return seen a while ago, nothing in flight', () => {
    expect(vcSections('none', [view({ returns: [returned({ seen: iso(NOW - RETURN_SEEN_SHOWN_MS - 1) })] })], NOW)).toEqual(['workflow'])
  })

  it('opens at Changes for Git and Workflow for None; a kept section shows while it is in the list', () => {
    expect(vcSectionShown(undefined, vcSections('git', [], NOW))).toBe('changes')
    expect(vcSectionShown(undefined, vcSections('none', [], NOW))).toBe('workflow')
    expect(vcSectionShown('history', vcSections('git', [], NOW))).toBe('history')
    expect(vcSectionShown('workflow', vcSections('git', [], NOW))).toBe('workflow')
    // A section kept from Git, or a queue that has cleared since: Workflow.
    expect(vcSectionShown('branches', vcSections('none', [], NOW))).toBe('workflow')
    expect(vcSectionShown('queue', vcSections('none', [view({ testing })], NOW))).toBe('queue')
    expect(vcSectionShown('queue', vcSections('none', [], NOW))).toBe('workflow')
  })
})
