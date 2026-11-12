// The merge checks on a jj card's candidate on a repository not colocated with Git (HI-2938; jjCandidateChecksRun.cjs's steps).
process.env.CW_JJCHECKS_NONCOLOCATED = '1'
require('./jjCandidateChecksRun.cjs')
