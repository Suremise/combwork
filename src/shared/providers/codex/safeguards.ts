/** What Combwork spots Codex's safeguards by (#606), as named defaults (data, not code): the CLI's own codes. */
export const CODEX_SAFEGUARDS = {
  /** Why Codex reroutes a request to another model (its rollout's model_reroute event: the request was flagged). */
  reroute: ['high_risk_cyber_activity'],
  /** Codex's error kinds (codex_error_info) for a turn its usage policy stopped. */
  stop: ['cyber_policy', 'bio_policy']
} as const
