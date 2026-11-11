// How many passes deep an intent is in being gathered again (#1206's `regather`; a jj start's several, HI-2916), its own:
// each intent's async call chain carries the depth of its own passes, so two intents on one card at once (the user's
// drag and an agent's start, say) never share, clear or restore each other's (HR1's round 1 on HI-2916: a depth kept in
// one map for the workflow, saved and restored around each pass, was left set once overlapping passes ended out of
// order). Nothing is kept once a chain ends, however it ends.

import { AsyncLocalStorage } from 'async_hooks'

export class GatherDepth {
  private readonly chain = new AsyncLocalStorage<ReadonlyMap<number, number>>()

  /** How many passes deep this call chain is in gathering card `id` again (0: its first gather). */
  depth(id: number): number {
    return this.chain.getStore()?.get(id) ?? 0
  }

  /** Runs `fn` one pass deeper for card `id`, in this call chain alone. */
  again<T>(id: number, fn: () => Promise<T>): Promise<T> {
    const next = new Map(this.chain.getStore() ?? [])
    next.set(id, this.depth(id) + 1)
    return this.chain.run(next, fn)
  }
}
