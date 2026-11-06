// Sessions that can't be resumed (#239): each reason, from what Combwork knows, shown on a disabled Resume.
import { describe, expect, it } from 'vitest'
import { removedAgentNote, resumeBlock, type ResumeContext } from '../src/shared/sessionResume'

const s = { provider: 'codex' as const, hasTranscript: true, hasBackup: false }
const ok: ResumeContext = { live: false, providerEnabled: true, providerInstalled: true, runners: [{ id: 'a1', name: 'Codexette' }], canAddAgent: true }

describe('resumeBlock', () => {
  it('a resumable session has no reason', () => {
    expect(resumeBlock(s, ok)).toBeNull()
    // Not known yet whether the CLI is installed: not held against it.
    expect(resumeBlock(s, { ...ok, providerInstalled: null })).toBeNull()
  })
  it('a sub-session is not a conversation', () => {
    expect(resumeBlock({ ...s, sub: { parentId: null, kind: 'guardian review' } }, ok)).toMatch(/guardian review Codex ran for another session/)
  })
  it('a running session', () => {
    expect(resumeBlock(s, { ...ok, live: true })).toMatch(/running/)
  })
  it('no transcript left anywhere; a backup is enough', () => {
    expect(resumeBlock({ ...s, hasTranscript: false }, ok)).toMatch(/Neither Codex nor Combwork has its transcript/)
    expect(resumeBlock({ ...s, hasTranscript: false, hasBackup: true }, ok)).toBeNull()
  })
  it('its provider is turned off, or not installed', () => {
    expect(resumeBlock(s, { ...ok, providerEnabled: false })).toMatch(/Codex is turned off.*Settings → Providers/)
    expect(resumeBlock(s, { ...ok, providerInstalled: false })).toMatch(/Codex isn't installed.*Provider Setup/)
  })
  it('no agent can run it: a worktree no agent uses, or no room for another agent', () => {
    expect(resumeBlock({ ...s, cwd: 'D:\\p\\.worktrees\\x' }, { ...ok, runners: [], canAddAgent: false })).toMatch(/worktree no agent uses any more/)
    expect(resumeBlock(s, { ...ok, runners: [], canAddAgent: false })).toMatch(/no room for another agent/)
    // In the project folder, Resume adds an agent for it.
    expect(resumeBlock(s, { ...ok, runners: [], canAddAgent: true })).toBeNull()
  })
  it("the Assistant resumes a conversation in the provider it ran in, whatever it runs now (#506)", () => {
    expect(resumeBlock(s, { ...ok, runners: [], canAddAgent: false, assistant: true })).toBeNull()
    // Its provider must still be on and installed.
    expect(resumeBlock(s, { ...ok, assistant: true, providerInstalled: false })).toMatch(/Codex isn't installed/)
  })
})

describe('removedAgentNote', () => {
  it("says which agent resumes a removed agent's session", () => {
    const gone = { ...s, agentId: 'a-gone', agentName: 'Coder' }
    expect(removedAgentNote(gone, [{ id: 'a1' }], { name: 'Codexette' })).toBe('Its agent Coder was removed: it resumes in Codexette.')
    expect(removedAgentNote(gone, [{ id: 'a1' }], null)).toMatch(/Resume adds a Codex agent/)
    expect(removedAgentNote({ ...gone, agentId: 'a1' }, [{ id: 'a1' }], { name: 'Codexette' })).toBeNull()
    expect(removedAgentNote(s, [], null)).toBeNull()
  })
})
