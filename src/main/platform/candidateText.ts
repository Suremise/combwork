// The candidate's agent-facing logs, one wording for every platform's candidate (Git's gitIntegration.ts, jj's
// jjCandidates.ts). Kept apart from integration.ts, whose contract imports only types (tests/integrationPortsImports.test.ts).

import { agentMsg } from '../../shared/agentText'

/**
 * A card's log when a rebased candidate isn't what lands (agent-facing: the builder reads it on the card), each platform's
 * candidate (Git's, gitIntegration.ts; jj's, jjCandidates.ts) saying it in the same words.
 */
export const CANDIDATE_TEXT = {
  notOnTop: agentMsg({ id: 'queue.candidate.notOnTop', text: "{card}: {revision} rebased onto {expected} isn't on top of the target: rebase it onto the target yourself and submit it again.", note: "A card's log from the merge queue (Rebase and fast-forward): the rebased revision doesn't sit on the target's head, so the card goes back. card: its key; revision and expected: short commit ids." }),
  mergeCommit: agentMsg({ id: 'queue.candidate.mergeCommit', text: '{card}: {revision} rebased onto {expected} would land a merge commit (Rebase and fast-forward lands a linear history): rebase it onto the target yourself and submit it again.', note: "A card's log from the merge queue (Rebase and fast-forward): the rebased revision would add a merge commit to the target, so the card goes back. card: its key; revision and expected: short commit ids." }),
  rebasedNotSame: agentMsg({ id: 'queue.candidate.rebasedNotSame', text: "{card}: {revision} rebased onto {expected} isn't the same change as reviewed: rebase it onto the target yourself and submit it again.", note: "A card's log from the merge queue (Rebase and fast-forward): the rebased revision isn't the same change as was reviewed, so the card goes back. card: its key; revision and expected: short commit ids." })
}
