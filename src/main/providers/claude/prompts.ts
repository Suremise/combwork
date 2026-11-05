/**
 * Whether a Claude Code transcript entry is a prompt the person (or Combwork for them) sent: a user entry with any text,
 * markup and all ("<task>…</task>", a command, Combwork's typed lines), or images alone. Not Claude Code's own entries,
 * told by their fields: meta entries (its notices, caveats and reminders), a compaction's summary, and tool results.
 * One definition for every reader of the transcript that counts or follows prompts: the usage's user messages, and the
 * turns safeguard stops are matched by (#606).
 */
export function isUserPrompt(o: Record<string, any>): boolean {
  if (o?.type !== 'user' || o.isMeta || o.isCompactSummary || o.toolUseResult !== undefined) return false
  const c = o.message?.content
  if (typeof c === 'string') return !!c.trim()
  if (!Array.isArray(c) || c.some((b) => b?.type === 'tool_result')) return false
  return c.some((b) => b?.type === 'image' || (b?.type === 'text' && typeof b.text === 'string' && !!b.text.trim()))
}
