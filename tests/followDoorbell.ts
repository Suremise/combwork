/**
 * Stand-in agents and Hive's doorbell (#650): a line Hive types names what waits by its ids, never its text, and the
 * agent reads it with cw_inbox, which alone makes it received. A stand-in follows it as a model does: it reads its
 * inbox and keeps what it read (each item's text, oldest first, in one line), so a test checks what the agent was told.
 */
import type { InboxItem } from '../src/shared/deliveries'

/** Whether a line Hive typed is its doorbell. */
export const isDoorbell = (line: string): boolean => line.startsWith('[CW] New in your inbox: ')

/** What the items read say, in one line. */
export const toldOf = (items: readonly InboxItem[]): string => items.map((i) => i.text).join(' ')

/**
 * What a stand-in agent reads for a line Hive typed: a doorbell followed with cw_inbox (now received), as a model does;
 * any other line as it is.
 */
export async function follow(host: string, agentId: string, line: string): Promise<string> {
  if (!isDoorbell(line)) return line
  const { readInbox } = await import('../src/main/deliveries')
  return toldOf((await readInbox(host, agentId)).items)
}
