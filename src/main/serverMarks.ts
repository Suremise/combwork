import { sep } from 'path'

/**
 * Server-session markers whose record couldn't be saved (HI-1829, HI-1772). A conversation that ran on a server
 * connection is read without its CLI's cost reports: while a run of it is live, by the run's own markers (sessions.ts'
 * `serverSids`); after, by its record (`serverRan`). When that record's write failed, here, so it is never read as
 * Claude-priced, within a strict bound and never evicted back to Claude pricing:
 * - at most UNSAVED_MAX ids, by host (a session's project path), each retried after the host's next record write
 *   (`pending`, then `saved`), and dropped when its session is deleted;
 * - past that, the host whose id overflows fails closed: its ids are let go and every read in it ignores cost reports;
 *   so do the hosts of a closing workspace that still had unsaved ids (they can't be kept for its reopening otherwise);
 * - at most FAIL_CLOSED_HOSTS_MAX such hosts; past that, every read anywhere ignores cost reports until Combwork restarts.
 * Over-cautious for a Claude session there (priced from its tokens), never Claude-priced for a server one. A fail-closed
 * state isn't left in this run.
 */

export const UNSAVED_MAX = 32
export const FAIL_CLOSED_HOSTS_MAX = 16

const key = (host: string): string => host.toLowerCase()

export class ServerMarks {
  private readonly unsaved = new Map<string, Set<string>>()
  private readonly failClosedHosts = new Set<string>()
  private everywhere = false

  constructor(private readonly warn: (line: string, host: string | null) => void = () => undefined) {}

  /** Whether a read of this host's session must leave its CLI's cost reports out, by what is kept here. */
  ignoresReports(host: string, sessionId: string): boolean {
    const k = key(host)
    return this.everywhere || this.failClosedHosts.has(k) || !!this.unsaved.get(k)?.has(sessionId)
  }

  /** A session whose `serverRan` record couldn't be saved, its run over. */
  add(host: string, sessionId: string): void {
    const k = key(host)
    if (this.everywhere || this.failClosedHosts.has(k) || this.unsaved.get(k)?.has(sessionId)) return
    if (this.count() >= UNSAVED_MAX) {
      this.failClosed(k, `more than ${UNSAVED_MAX} server sessions' records couldn't be saved`) // i18n-ignore: combwork.log
      return
    }
    const ids = this.unsaved.get(k) ?? new Set<string>()
    ids.add(sessionId)
    this.unsaved.set(k, ids)
  }

  /** Its record now says it ran on a server: the record decides from here. */
  saved(host: string, sessionId: string): void {
    const k = key(host)
    const ids = this.unsaved.get(k)
    if (!ids?.delete(sessionId)) return
    if (!ids.size) this.unsaved.delete(k)
  }

  /** Its session was deleted: nothing reads it again. */
  deleted(host: string, sessionId: string): void {
    this.saved(host, sessionId)
  }

  /** A host's ids still waiting for their record, to retry after one of its writes succeeded. */
  pending(host: string): string[] {
    return [...(this.unsaved.get(key(host)) ?? [])]
  }

  /** A workspace closing: its hosts' unsaved ids can't be kept for its reopening, so those hosts fail closed. */
  closing(workspacePath: string): void {
    const root = key(workspacePath).replace(/[\\/]+$/, '')
    for (const k of [...this.unsaved.keys()]) if (k === root || k.startsWith(root + sep) || k.startsWith(root + '/')) this.failClosed(k, 'its workspace closed with server sessions whose records couldn\'t be saved') // i18n-ignore: combwork.log
  }

  /** For tests and diagnostics: how much is kept. */
  size(): { unsaved: number; failClosedHosts: number; everywhere: boolean } {
    return { unsaved: this.count(), failClosedHosts: this.failClosedHosts.size, everywhere: this.everywhere }
  }

  private count(): number {
    let n = 0
    for (const ids of this.unsaved.values()) n += ids.size
    return n
  }

  private failClosed(k: string, why: string): void {
    this.unsaved.delete(k)
    if (this.everywhere || this.failClosedHosts.has(k)) return
    if (this.failClosedHosts.size >= FAIL_CLOSED_HOSTS_MAX) {
      this.failClosedHosts.clear()
      this.everywhere = true
      this.warn(`Every session's usage is read without its CLI's cost reports until Combwork restarts: ${why}, in more than ${FAIL_CLOSED_HOSTS_MAX} folders`, null) // i18n-ignore: combwork.log
      return
    }
    this.failClosedHosts.add(k)
    this.warn(`Sessions here are read without their CLI's cost reports until Combwork restarts: ${why}`, k) // i18n-ignore: combwork.log
  }
}
