// The merge queue's own claims of round 1 (#1118, HB3 4, 5 and 10): an entry that isn't approved any more gets an
// outcome instead of stalling the target; a swap that loses the race after `IntegrationStarted` tests again; restarts
// at each point of the advance recover from the platform, never by assumption, a rerun keeping its entry id.
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { B1, commit, moved, R1, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { MergeQueue } from '../../src/main/workflow/mergeQueue'
import { FactStore } from '../../src/main/workflow/factStore'
import { Workflow } from '../../src/main/workflow/runtime'
import { transientRequeues, type FactData } from '../../src/shared/workflow/facts'

let env: Env | null = null
const extra: FactStore[] = []
afterEach(() => {
  for (const s of extra.splice(0)) s.close()
  env?.close()
  env = null
})

const team = () => (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [] }))

async function queued(e: Env, title: string, file: string) {
  const card = e.wf.createCard({ title })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  commit(s.data!.folder as string, { [file]: `${title}\n` }, title)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  moved(await e.wf.startReview(card.key, R1))
  moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  return card
}

/** Another Hive (a restart): its own store connection, Workflow and queue on the same files. */
function restarted(e: Env): { wf: Workflow; q: MergeQueue } {
  const store = e.reopen()
  extra.push(store)
  const wf = new Workflow({ ...e.wf.cfg, store })
  return { wf, q: new MergeQueue(wf, { folder: join(e.home, 'queue'), runCheck: async () => ({ ok: true, output: '' }) }) }
}

const started = (e: Env, card: number, entry: string) => e.store.facts(card).filter((f) => f.kind === 'IntegrationStarted' && (f.data as FactData['IntegrationStarted']).entry === entry)

describe('the merge queue, round 1 claims', () => {
  it('an entry that is no longer approved is cancelled with an outcome; the card behind it merges', async () => {
    const e = team()
    sh(e.project, 'checkout', '-q', '--detach')
    const a = await queued(e, 'A', 'a.txt')
    const b = await queued(e, 'B', 'b.txt')
    // A pass goes stale without its entry being cancelled (the defence the queue must have on its own).
    e.store.tx((tx) => tx.append(a.id, { kind: 'Stale', actor: 'outside', source: 'observed', data: { approved: null, current: null, why: 'change' } }))
    const out = await e.queue().drain('main')
    expect(out.map((o) => o.outcome)).toEqual(['skipped', 'integrated'])
    expect(e.wf.state(a)).toMatchObject({ stage: 'review' })
    expect(e.wf.state(a).entries.at(-1)).toMatchObject({ state: 'cancelled', cancelled: 'stale' })
    expect(e.wf.state(b).stage).toBe('done')
  })

  it('a swap that loses the race after IntegrationStarted fails as target moved, is queued again by Hive and merges', async () => {
    const e = team()
    sh(e.project, 'checkout', '-q', '--detach')
    const a = await queued(e, 'A', 'a.txt')
    let raced = false
    const q = e.queue({
      hooks: {
        afterStarted: () => {
          if (raced) return
          raced = true
          sh(e.project, 'update-ref', 'refs/heads/main', commit(e.project, { 'race.txt': 'r\n' }, 'race'))
        }
      }
    })
    const [o] = await q.drain('main')
    expect(o).toMatchObject({ outcome: 'integrated', retests: 1 })
    const s = e.wf.state(a)
    expect(s.entries.map((x) => x.state)).toEqual(['failed', 'integrated'])
    expect(s.entries[0].failure).toMatchObject({ reason: 'targetMoved', transient: true })
    expect(transientRequeues(s)).toBe(0)
    expect(sh(e.project, 'log', '-1', '--format=%s', 'main^1')).toBe('race')
  })

  it('a restart after IntegrationStarted, the target unmoved: the entry runs again with its id, a second IntegrationStarted', async () => {
    const e = team()
    sh(e.project, 'checkout', '-q', '--detach')
    const a = await queued(e, 'A', 'a.txt')
    await expect(e.queue({ hooks: { afterStarted: () => Promise.reject(new Error('crash')) } }).drain('main')).rejects.toThrow('crash')
    const entry = e.wf.state(a).entries[0].id
    const r = restarted(e)
    expect(await r.q.recover()).toEqual([{ card: a.key, entry, outcome: 'rerun' }])
    expect((await r.q.drain('main'))[0]).toMatchObject({ outcome: 'integrated', entry })
    expect(started(e, a.id, entry)).toHaveLength(2)
    expect(r.wf.state(a).stage).toBe('done')
  })

  it('a restart after IntegrationStarted, the target moved elsewhere and the change not in it: failed, queued again, merged', async () => {
    const e = team()
    sh(e.project, 'checkout', '-q', '--detach')
    const a = await queued(e, 'A', 'a.txt')
    await expect(e.queue({ hooks: { afterStarted: () => Promise.reject(new Error('crash')) } }).drain('main')).rejects.toThrow('crash')
    sh(e.project, 'update-ref', 'refs/heads/main', commit(e.project, { 'meanwhile.txt': 'm\n' }, 'meanwhile'))
    const r = restarted(e)
    expect(await r.q.recover()).toEqual([{ card: a.key, entry: expect.any(String), outcome: 'failed' }])
    expect(r.wf.state(a).stage).toBe('merging')
    expect((await r.q.drain('main'))[0]).toMatchObject({ outcome: 'integrated' })
  })

  it('target checked out: a restart after the files phase finishes the swap from the journal; the folder ends at the result', async () => {
    const e = team()
    const a = await queued(e, 'A', 'a.txt')
    await expect(e.queue({ hooks: { afterFiles: () => Promise.reject(new Error('crash')) } }).drain('main')).rejects.toThrow('crash')
    expect(e.wf.state(a).entries[0].phases).toEqual(['files'])
    const r = restarted(e)
    expect(await r.q.recover()).toEqual([{ card: a.key, entry: expect.any(String), outcome: 'integrated' }])
    expect(r.wf.state(a).stage).toBe('done')
    expect(readFileSync(join(e.project, 'a.txt'), 'utf8')).toBe('A\n')
    expect(sh(e.project, 'status', '--porcelain')).toBe('')
  })

  it("target checked out, a listed file edited after the crash: still stuck (Resume's check, #1353) until the file is back", async () => {
    const e = team()
    const a = await queued(e, 'A', 'a.txt')
    await expect(e.queue({ hooks: { afterFiles: () => Promise.reject(new Error('crash')) } }).drain('main')).rejects.toThrow('crash')
    writeFileSync(join(e.project, 'a.txt'), 'edited by the user\n')
    const r = restarted(e)
    expect(await r.q.stillStuck('main')).toEqual(['a.txt'])
    // The file back as the journal left it (the index's): recovery can finish the swap, so Resume may run it.
    sh(e.project, 'checkout', '--', 'a.txt')
    expect(await r.q.stillStuck('main')).toBeNull()
    expect(await r.q.recover('main')).toEqual([{ card: a.key, entry: expect.any(String), outcome: 'integrated' }])
  })
})
