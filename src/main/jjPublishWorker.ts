// jj's publish worker thread (HI-2882's J9b2, design HI-2882/s10–s22): a publish observation's authoritative step, on a
// connection of its own to the workspace database, so its `BEGIN IMMEDIATE` (which may wait for the database's lock) and
// its synchronous validator and writes never hold up main's thread (AGENTS: main carries every keystroke). One request
// at a time, each on a connection opened for it and closed after it; its cancel fence is the shared flag main's follow
// sets synchronously as it drops (jjPublishCommit.ts). No Electron here: a worker thread can't load it.

import { DatabaseSync } from 'node:sqlite'
import { parentPort } from 'worker_threads'
import { commitPublish, type PublishCommitAnswer, type PublishCommitRequest } from './platform/jjPublishCommit'

/** How long a request waits for the database's lock before it gives up (its observation is asked again next run). */
export const PUBLISH_BUSY_MS = 30_000

export type JjPublishMessage = { id: number; req: PublishCommitRequest; flag: SharedArrayBuffer }
export type JjPublishReply = { id: number; answer: PublishCommitAnswer } | { id: number; error: string }

/** One request on a connection of its own (the worker's, or main's in unit tests, which have no build). */
export function handlePublish(m: JjPublishMessage): JjPublishReply {
  const flag = new Int32Array(m.flag)
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(m.req.file, { timeout: PUBLISH_BUSY_MS })
    return { id: m.id, answer: commitPublish(db, m.req, () => Atomics.load(flag, 0) === 1) }
  } catch (e) {
    return { id: m.id, error: e instanceof Error ? e.message : String(e) }
  } finally {
    db?.close()
  }
}

const port = parentPort
if (port) port.on('message', (m: JjPublishMessage) => port.postMessage(handlePublish(m) satisfies JjPublishReply))
