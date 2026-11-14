// A jj project's lane end to end on a repository not colocated with Git (HI-2801, J8; jjLaneRun.cjs's steps).
process.env.CW_JJLANE_NONCOLOCATED = '1'
require('./jjLaneRun.cjs')
