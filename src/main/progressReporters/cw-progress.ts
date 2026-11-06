// The cw-progress command (a .cmd and a sh script in Combwork's bin folder, on each session's PATH, start this with
// Combwork's own executable as Node): see wrapper.ts.
// The session's dialect (HI-2065), loaded before the wrapper says anything: first, on purpose.
import '../../shared/agentText/processDialect'
import { runWrapped } from './wrapper'

// Ctrl+C reaches the command too: wait for it to end, so its exit code is returned and Combwork hears how it ended.
process.on('SIGINT', () => undefined)
void runWrapped(process.argv.slice(2), { env: process.env, cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr }).then((code) => process.exit(code))
