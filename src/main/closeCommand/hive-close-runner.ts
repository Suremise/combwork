// hive-close-runner.js (HI-1368): started by Hive, detached, with its own executable as Node, to run a close command
// (runner.ts). Its only argument is the run's folder.
import { runFolder } from './runner'

const dir = process.argv[2]
if (!dir) process.exit(2)
runFolder(dir).then(
  () => process.exit(0),
  () => process.exit(1)
)
