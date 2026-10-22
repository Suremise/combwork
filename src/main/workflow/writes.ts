// Workflow writes one at a time (#1422, HR5's round 1): a project's options (the Workflow section, the Assistant's settings
// tool) and the defaults at Hive's and the workspace's level are each checked against the others as they are now, then
// written. Their checks and writes take turns here, so a level's check of the projects inheriting it, or a project's
// check of the levels it inherits, can't go stale before its own write: a contradiction is refused, never committed for
// the project to fall back to all-off. One queue for this Hive (Hive's level reaches every open workspace); never nested.

let turn: Promise<unknown> = Promise.resolve()

/** Runs `fn` once every workflow write before it has ended, and before any after it starts. */
export function workflowWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = turn.then(fn)
  turn = run.catch(() => undefined)
  return run
}
