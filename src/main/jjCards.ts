// jj's card work's dependencies, composed by the app (HI-2868, J9b1; design HI-2868/s7 §1, s13): what JjPlatform needs
// beside jj, from the app's own services, so platform code imports no app module. Given to each project's workflow
// through service.ts' `setJjCards` (slotCards.ts sets it while slots run). Behind the guard: nothing here runs for a
// real card until J9e lifts `start.platformReady`.
//
// - the jj workspace port: J9a's registered one (slotsApp.ts' jjPort), with its bindings in the workspace database;
// - the store's lock: the app's re-entrant store lock (the repository lock, one per store);
// - git on the store, as `git --git-dir <store>`;
// - J5's reads (jjTargetHead): pinned reads in the project's folder (`--at-op`: no snapshot), git on the store, §16.3.2's
//   containment on the store, the bundles' journal in board_meta (J9b2's);
// - the card's lease and slot rows, read synchronously in the write under way (the final Submitted transaction's);
// - the pins' ownership records in board_meta.

import { basename } from 'path'
import { git } from './git'
import { jjRunner } from './platform/jjRunner'
import { historyFor } from './platform/historyPorts'
import { jjContextOf } from './platform/jjDetect'
import { boundaryOf, canonicalStore } from './platform/repoBoundary'
import { JjStoreChanged } from './platform/jjWorkspacePort'
import type { JjCardDeps, JjPinRecord } from './platform/jjPlatform'
import type { JjBundle, JjIntegrationDeps } from './platform/jjIntegration'
import { boardConn, jjPort, storeLock } from './slotsApp'
import { boardFile } from './boardStore'
import { commitPublishOff } from './jjPublish'
import { mergeBundles, type SqlDb } from './platform/jjObligations'
import { SlotStore } from './slots'
import type { WorkspaceService } from './workspace'

/** A project's jj card dependencies in a workspace. `projectId`: the slot tables' id of the project (as poolFor keys it). */
export function jjCardsFor(ws: WorkspaceService, projectPath: string, projectId: () => string): JjCardDeps {
  const slots = (): SlotStore => new SlotStore(boardConn(ws), projectId() || basename(projectPath))
  const journal = (key: string) => slots().journal(key)
  const gitOn = (store: string, args: readonly string[]) => git(store, ['--git-dir', store, ...args])
  return {
    runner: jjRunner,
    port: () => jjPort(),
    lock: (store) => (fn) => storeLock(store, fn),
    git: gitOn,
    history: historyFor('git'),
    integration: async (): Promise<JjIntegrationDeps | null> => {
      const d = await jjContextOf(projectPath, jjRunner).catch(() => null)
      if (!d || !('jj' in d)) return null
      const ctx = d.jj
      return {
        runner: jjRunner,
        view: { jjRepo: ctx.jjRepo, store: ctx.store, colocated: ctx.colocated },
        folder: projectPath,
        git: (args) => gitOn(ctx.store, args),
        gitContains: (store, target, c, at) => historyFor('git').contains(store, target, c, at),
        // The store checked again inside its lock (HI-2896, s13 §3): a colocation change since this context was read
        // refuses before any pin or journal write.
        lock: (fn) =>
          storeLock(ctx.store, async () => {
            const b = await boundaryOf(ctx.root)
            const now = 'jj' in b && !ctx.colocated ? b.jj.store : 'colocated' in b && ctx.colocated ? b.colocated.store : null
            if (!now || (await canonicalStore(now)) !== (await canonicalStore(ctx.store))) throw new JjStoreChanged(ctx.root)
            return fn()
          }),
        // Merged in one write with what is journalled (HR1's round 1): an observer's older snapshot never erases a bundle
        // another observer's proof journalled.
        journal: (card: string, cycle: number, bundles: JjBundle[]) =>
          boardConn(ws).write((db) => {
            const key = `jj_bundles:${card.toLowerCase()}:${cycle}`
            const r = db.prepare('SELECT value FROM board_meta WHERE key = ?').get(key) as { value: string } | undefined // i18n-ignore: SQL
            let stored: JjBundle[] = []
            try {
              const v = r ? (JSON.parse(r.value) as unknown) : []
              stored = Array.isArray(v) ? (v as JjBundle[]) : []
            } catch {
              stored = []
            }
            db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(mergeBundles(stored, bundles))) // i18n-ignore: SQL
          })
      }
    },
    slotHold: (lease, expect) => {
      const store = slots()
      const l = store.lease(lease)
      if (!l) return null
      const s = store.slot(l.slot)
      if (!s) return null
      const held = !l.to && l.slot === expect.slot && l.agent === expect.agent && (l.card === null || l.card === expect.card) && !s.op && !s.job && (!s.writer || (s.writer.lease === lease && s.writer.agent === expect.agent))
      return { held, print: `lease:${l.to ? 'ended' : 'open'}:${l.slot}:${l.agent}:${l.card ?? '-'}:${s.op ? s.op.token : '-'}:${s.job ?? '-'}:${s.writer ? s.writer.run : '-'}` }
    },
    // J9b2's (HI-2882): the project's rows on the workspace database, its bundles' journal, and the publish worker.
    records: {
      projectId: () => projectId() || basename(projectPath),
      dbFile: () => boardFile(ws.path!),
      read: (fn) => boardConn(ws).read((db) => fn(db as unknown as SqlDb)),
      write: async (fn) => void (await boardConn(ws).write((db) => fn(db as unknown as SqlDb))),
      bundles: (card, cycle) => {
        const v = journal(`jj_bundles:${card.toLowerCase()}:${cycle}`).read()
        return Array.isArray(v) ? (v as JjBundle[]) : []
      },
      publish: (req) => commitPublishOff(req)
    },
    pins: {
      read: (ref) => {
        const v = journal(`jj_pin:${ref}`).read() as JjPinRecord | { unreadable: true } | null
        return v && 'seq' in v ? v : null
      },
      write: (ref, rec) => journal(`jj_pin:${ref}`).write(rec)
    }
  }
}
