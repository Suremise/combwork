// HI-3140: moved to platform/jjCandidateChecks.ts (jj's own, reached by the workflow through its reconcile port). This
// path is kept only so the existing tests' imports still resolve: no production module imports it (tests/gitAudit.mjs's
// COMPAT_ONLY fails one that does).
export * from '../platform/jjCandidateChecks'
