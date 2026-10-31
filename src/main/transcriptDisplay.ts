import type { TranscriptTool } from '../shared/types'

/** Tool input and output longer than this are shortened in transcript:read; transcript:tool has the full text. */
export const DISPLAY_LIMIT = 4000

const clip = (s: string): string => (s.length > DISPLAY_LIMIT ? s.slice(0, DISPLAY_LIMIT) : s)

/**
 * A tool call shortened for display (transcript:read), with each length cut kept (`inputLength`, `resultLength`), and
 * each call a Codex script made shortened the same way (HI-2240); transcript:tool gives them whole.
 */
export function toolForDisplay(t: TranscriptTool): TranscriptTool {
  const tool: TranscriptTool = { ...t, input: clip(t.input), result: t.result === null ? null : clip(t.result) }
  if (t.input.length > DISPLAY_LIMIT) tool.inputLength = t.input.length
  if (t.result && t.result.length > DISPLAY_LIMIT) tool.resultLength = t.result.length
  if (t.calls) tool.calls = t.calls.map(toolForDisplay)
  return tool
}
