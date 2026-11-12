// A jj slot's staleness as the slot listing shows it (HI-2912). Reading it runs jj in the slot and reads its
// `.jj/working_copy/checkout`, and either keeps the slot's folder from being renamed on Windows, which is how the pool's
// quiet probe (slots.ts `quiet`) looks: the listing polled (every 200 ms in jjwindow; the window's Slots and copies while
// shown) kept the probe failing, so a slot's owed settle found it busy for minutes after its builder had gone.
//
// So the listing doesn't read it while the pool works on the slot (an operation or a job on it) or the slot owes a
// settle: it shows the last answer it read for that folder's path, touching nothing of the folder (a stat holds it for a
// moment too), never a fresh one. Decided from the slot's state read right before the read would start, with nothing
// awaited between. Each read is of one folder incarnation (its creation generation, read before it and again after
// it): an answer is kept only when both agree and nothing kept for the slot was dropped meanwhile, so no answer is ever
// stamped with another folder's generation, and an answer kept for another folder at that path is never shown once the
// slot can be read again. At most one read per folder incarnation runs at a time, shared by the listings that ask
// meanwhile. An answer that couldn't be read never replaces a known one for the same folder, so a stale
// slot keeps showing Stale (and its Recover…). What it keeps is one entry per slot of its pool, dropped with the slot; a
// pool opened again starts with none.
//
// This only stops the listing from competing with the probe. It is no ordering of Combwork's reads against its writes:
// the probe samples quiet, and another reader can start after it (HI-2912's follow-up card).

/** What the view reads of a slot now (the pool's row). */
export interface StaleViewRow {
  folder: string
  state: string
  op: unknown
  job: unknown
}

export interface StaleViewDeps {
  /** The slot's row now, or null when it is no longer in the pool. Read synchronously. */
  row(name: string): StaleViewRow | null
  /** Whether the slot owes a settle now (HI-2906). Read synchronously. */
  owes(name: string): boolean
  /** The slot's staleness from jj: true or false, null when it couldn't be read. */
  read(folder: string): Promise<boolean | null>
  /** The folder's creation generation (jjWorkspacePort `generationOf`), null when it can't be read. */
  generation(folder: string): Promise<string | null>
}

interface Seen {
  folder: string
  generation: string
  stale: boolean
}

export class SlotStaleView {
  private readonly seen = new Map<string, Seen>()
  /** Reads under way, by folder and generation: a caller joins only a read of the same folder incarnation. */
  private readonly reading = new Map<string, Promise<boolean | null>>()
  /** Each slot's owner token: replaced when what was kept for it is dropped, so a read begun before can't publish. */
  private readonly owners = new Map<string, object>()

  constructor(private readonly deps: StaleViewDeps) {}

  /** Whether to show the slot as stale: true only from an answer read for this folder. */
  async staleOf(name: string): Promise<boolean> {
    const first = this.deps.row(name)
    if (!first || first.state === 'gone' || first.state === 'removing') {
      this.drop(name)
      return false
    }
    // Busy: nothing of the folder is touched (a stat holds it for a moment too); the answer last read for this path. Its
    // generation is checked at the next read, which the slot's release allows.
    if (this.busy(name, first)) {
      const was = this.seen.get(name)
      return was && samePath(was.folder, first.folder) ? was.stale : false
    }
    const generation = await this.deps.generation(first.folder)
    // Its state now, after the await, and nothing awaited from here until the read starts.
    const row = this.deps.row(name)
    if (!row || row.state === 'gone' || row.state === 'removing') {
      this.drop(name)
      return false
    }
    const was = this.seen.get(name)
    const known = was && generation && was.generation === generation && samePath(was.folder, row.folder) ? was.stale : null
    if (!generation || !samePath(row.folder, first.folder)) return known ?? false
    if (this.busy(name, row)) return known ?? false
    let owner = this.owners.get(name)
    if (!owner) this.owners.set(name, (owner = {}))
    const key = `${row.folder.toLowerCase()}|${generation}`
    let read = this.reading.get(key)
    if (!read) {
      read = this.deps.read(row.folder).catch(() => null)
      this.reading.set(key, read)
      const mine = read
      void read.finally(() => {
        if (this.reading.get(key) === mine) this.reading.delete(key)
      })
    }
    const stale = await read
    if (stale === null) return known ?? false
    // Published only when it is provably this incarnation's answer: nothing kept for the slot was dropped meanwhile (its
    // owner token), the slot is still that folder, not being removed and not busy (nothing of it touched then), and the
    // folder's generation is the same after the read as before it (a folder replaced during the read gave the answer
    // of one or the other). Otherwise its caller gets what was known, never an answer stamped with another generation.
    const now = this.deps.row(name)
    if (this.owners.get(name) !== owner || !now || !samePath(now.folder, row.folder) || now.state === 'gone' || now.state === 'removing' || this.busy(name, now)) return known ?? false
    if ((await this.deps.generation(row.folder)) !== generation || this.owners.get(name) !== owner) return known ?? false
    this.seen.set(name, { folder: row.folder, generation, stale })
    return stale
  }

  /** Forgets what it kept for a slot, and stops reads begun before from publishing for it. */
  private drop(name: string): void {
    this.seen.delete(name)
    this.owners.delete(name)
  }

  /** Whether the pool works on the slot (an operation or a job) or it owes a settle, now. */
  private busy(name: string, row: StaleViewRow): boolean {
    return !!row.op || !!row.job || this.deps.owes(name)
  }

  /** Drops what it kept for slots no longer in the pool. */
  keepOnly(names: Iterable<string>): void {
    const keep = new Set(names)
    for (const n of new Set([...this.seen.keys(), ...this.owners.keys()])) if (!keep.has(n)) this.drop(n)
  }

  /** How many slots it keeps an answer for (tests). */
  get size(): number {
    return this.seen.size
  }
}

const samePath = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
