/**
 * What Combwork spots Claude Code's safeguards by (#606), as named defaults (data, not code): the note and the question
 * are Settings → Advanced's (#685: claude-code.safeguard.note, .prompt), which the detection reads through `advanced`, so
 * an override changes them; the lists join them once a real session of one is recorded (#697). Patterns are a
 * case-insensitive regular expression's source; lists are the CLI's own codes.
 */
export const CLAUDE_SAFEGUARDS = {
  /**
   * Claude Code's transcript note when its safety classifier stops a response (2.1.296: a system entry, "Opus 5.5's
   * safeguards stopped the response above · continuing once with that noted", and the notice it adds for the model,
   * "Your response above was stopped by a safety classifier…").
   */
  note: String.raw`\bsafeguards?\b.{0,60}\bstopped\b|\bstopped by a safety classifier\b`,
  /**
   * Claude Code's records of a request its safeguards flagged (system entries, by subtype): answered by another model
   * (`model_refusal_fallback`, saying which, and whether for the session or that response only), or by none.
   */
  records: ['model_refusal_fallback', 'model_refusal_no_fallback'],
  /**
   * Claude Code's question while it asks about a flagged message (2.1.296: "…'s safeguards flagged this message. Switch to
   * Opus 4.8 and keep going whenever this happens?", header "Model switch"), told by its two numbered choices while the
   * dialog is open ("1. Switch automatically", "2. Stay on Opus 5.5"): an answered one shows only the answer, and the
   * words "safeguards" or "safety classifier" elsewhere on screen never match.
   */
  prompt: String.raw`^(?=[\s\S]*\b\d\.\s*Switch automatically\b)(?=[\s\S]*\b\d\.\s*Stay on\b)`
} as const
