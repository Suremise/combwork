// The Sessions tab's "where it ran, whose it was": from what the session recorded, never from which agent has its name
// or worktree now.
import { describe, expect, it } from 'vitest'
import { sessionOrigin } from '../src/shared/sessionOrigin'

const P = 'C:\\ws\\alpha'
const WT = 'C:\\ws\\.demo-worktrees\\alpha\\coder'

describe('sessionOrigin', () => {
  it('labels the project folder and a worktree, with the agent as it is named now', () => {
    const agents = [{ id: 'a-1', name: 'Coder' }, { id: 'a-2', name: 'Reviewer' }]
    expect(sessionOrigin(P, agents, { source: 'combwork', agentId: 'a-1', agentName: 'Old name' })?.label).toBe('Coder · Project folder')
    // The project folder in other case, as Windows may record it.
    expect(sessionOrigin(P, agents, { source: 'combwork', agentId: 'a-1', cwd: P.toUpperCase() })?.location).toBe('Project folder')
    const wt = sessionOrigin(P, agents, { source: 'combwork', agentId: 'a-2', cwd: WT, branch: 'cw/reviewer' })
    expect(wt?.label).toBe('Reviewer · Worktree · cw/reviewer')
    expect(wt?.detail).toContain(`Ran in ${WT}`)
    expect(wt?.detail).toContain('a-2')
  })

  it("an agent added later with the same name or worktree isn't the one that ran it", () => {
    const replacement = [{ id: 'a-new', name: 'Coder' }]
    expect(sessionOrigin(P, replacement, { source: 'combwork', agentId: 'a-old', agentName: 'Coder', cwd: WT, branch: 'cw/coder' })?.label).toBe('Coder (removed) · Worktree · cw/coder')
    // Recorded before names were: no name is made up.
    const old = sessionOrigin(P, replacement, { source: 'combwork', agentId: 'a-old' })
    expect(old?.label).toBe('Removed agent · Project folder')
    expect(old?.detail).toContain('has since been removed')
  })

  it('without a recorded agent (adopted, or from 0.1): the location only', () => {
    const o = sessionOrigin(P, [{ id: 'a-1', name: 'Coder' }], { source: 'combwork' })
    expect(o?.agent).toBeNull()
    expect(o?.label).toBe('Project folder')
  })

  it('a worktree with no branch recorded: its folder', () => {
    expect(sessionOrigin(P, [], { source: 'combwork', cwd: WT })?.location).toBe('Worktree · coder')
  })

  it("a slot's or a retired home's session is named by it (#1442); a folder the project doesn't name, as a worktree", () => {
    const slots = 'C:\\ws.worktrees\\alpha'
    const folders = [{ path: `${slots}\\slot-b`, name: 'slot-b', is: 'slot' as const }, { path: `${slots}\\hr4`, name: 'hr4', is: 'home' as const }]
    const agents = [{ id: 'a-1', name: 'HB1' }]
    expect(sessionOrigin(P, agents, { source: 'combwork', agentId: 'a-1', cwd: `${slots}\\SLOT-B` }, folders)?.label).toBe('HB1 · Slot · slot-b')
    expect(sessionOrigin(P, agents, { source: 'combwork', agentId: 'a-1', cwd: `${slots}\\hr4` }, folders)?.location).toBe('Home · hr4')
    expect(sessionOrigin(P, agents, { source: 'combwork', agentId: 'a-1', cwd: WT, branch: 'cw/coder' }, folders)?.location).toBe('Worktree · cw/coder')
    expect(sessionOrigin(P, agents, { source: 'combwork', agentId: 'a-1', cwd: P }, folders)?.location).toBe('Project folder')
  })

  it('a session started outside Combwork claims no agent', () => {
    expect(sessionOrigin(P, [{ id: 'a-1', name: 'Coder' }], { source: 'external', agentId: 'a-1' })).toBeNull()
  })
})
