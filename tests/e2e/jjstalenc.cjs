// A jj lane's slot through the user's integrations on a repository not colocated with Git (HI-2913; jjStaleRun.cjs's steps).
process.env.CW_JJSTALE_NONCOLOCATED = '1'
require('./jjStaleRun.cjs')
