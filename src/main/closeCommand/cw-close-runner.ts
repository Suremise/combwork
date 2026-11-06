// cw-close-runner.js (HI-1368): started by Combwork, detached, with its own executable as Node, to run the user's
// commands. Its only argument is the run's folder: its job.json is a list of commands (HI-1954, listRunner.ts) or, from
// before, one command (runner.ts).
import { readFileSync } from 'fs'
import { join } from 'path'
import { runFolder } from './runner'
import { runList, type ListJob } from './listRunner'

const dir = process.argv[2]
if (!dir) process.exit(2)
const job = JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8')) as ListJob | { list?: undefined }
;(job.list ? runList(dir, job) : runFolder(dir)).then(
  () => process.exit(0),
  () => process.exit(1)
)
