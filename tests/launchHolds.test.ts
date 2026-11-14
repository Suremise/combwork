// A folder held against agent launches (HI-2887; design HI-2887/s17–s20): a hold refused while a session is admitted or
// live in the folder; a start whose folder becomes known while the hold stands (it reserved its start before the hold,
// its place resolved after) waits and is admitted once released; a start in another folder (a slot's) isn't held; a start
// cancelled while waiting is never admitted; a hold released after a failure lets the next one in.
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { admitLaunch, endAdmission, holdLaunches, resetLaunchHolds, setLiveFolders } from '../src/main/launchHolds'
import { tempDir } from './tempDir'

afterEach(() => {
  resetLaunchHolds()
  setLiveFolders(() => [])
})

describe('launch holds (HI-2887)', () => {
  it('refused while a session is admitted or live in the folder; held, then a start resolving there waits for the release', async () => {
    const project = tempDir('hold-')
    let live: string[] = [join(project, 'sub')]
    setLiveFolders(() => live)
    expect(holdLaunches(project)).toMatchObject({ busy: join(project, 'sub') })
    live = []
    expect(await admitLaunch('p|a1', project, () => false)).toBe(true)
    expect(holdLaunches(project)).toMatchObject({ busy: 'p|a1' })
    endAdmission('p|a1')
    // Held; a start reserved before it resolves its folder now: it waits, admitted only once released.
    const h = holdLaunches(project)
    if ('busy' in h) throw new Error('not held')
    let admitted = false
    const start = admitLaunch('p|a2', join(project, 'deep'), () => false).then((ok) => (admitted = ok))
    await Promise.resolve()
    expect(admitted).toBe(false)
    // While held, a second hold of the same or an inner folder is refused.
    expect(holdLaunches(join(project, 'deep'))).toMatchObject({ busy: project })
    h.release()
    await start
    expect(admitted).toBe(true)
    endAdmission('p|a2')
  })

  it("a slot's start isn't held by the project folder's hold; a start cancelled while waiting is never admitted; release after a failure", async () => {
    const top = tempDir('hold2-')
    const project = join(top, 'project')
    const slot = join(top, 'project.worktrees', 'slot-a')
    const h = holdLaunches(project)
    if ('busy' in h) throw new Error('not held')
    expect(await admitLaunch('p|slot', slot, () => false)).toBe(true)
    endAdmission('p|slot')
    let cancel = false
    const waiting = admitLaunch('p|c', project, () => cancel)
    cancel = true
    expect(await waiting).toBe(false)
    expect(holdLaunches(project)).toMatchObject({ busy: project })
    // The holder fails: released in its finally, and the next hold is taken.
    try {
      throw new Error('add failed')
    } catch {
      // the failure
    } finally {
      h.release()
    }
    const again = holdLaunches(project)
    expect('release' in again).toBe(true)
  })
})
