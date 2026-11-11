// A jj card's candidate on a repository not colocated with Git (HI-2871; jjCandidateRun.cjs's steps, as jjcandidate's):
// Candidate ready, the user's jj bookmark set onto it, Done from a prepared candidate, in both themes and all seven locales.
process.env.CW_JJCANDIDATE_NONCOLOCATED = '1'
require('./jjCandidateRun.cjs')
