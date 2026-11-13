// What each platform's detection says to agents (HI-3140): the Agent API's project status names what was found in a
// project folder in the platform's own words (`api.project.vcsGit`, `api.project.vcsJj`). The platforms own these rows;
// servers.ts asks by the detected platform, never by its id. A platform found nothing to say: 'none'.

import { agentMsg, say } from '../../shared/agentText'
import type { Detection, PlatformId } from '../../shared/platform/descriptors'

const T = {
  vcsGit: agentMsg({ id: 'api.project.vcsGit', text: 'git at {root}{subfolder, select, yes { (a subfolder of that repository)} other {}}', note: 'The version control found in a project folder.' }),
  vcsJj: agentMsg({ id: 'api.project.vcsJj', text: 'jj at {root}{colocated, select, yes { (colocated with git)} other { (not colocated: no git working copy)}}', note: 'HI-2799: a jj repository found in a project folder.' })
}

/** Each platform's words for a folder detection found it in (another system found is the caller's: not a platform). */
export const FOUND: Record<PlatformId, (d: Detection) => string> = {
  git: (d) => say(T.vcsGit, { root: d.root ?? '', subfolder: d.subfolder ? 'yes' : 'no' }),
  jj: (d) => say(T.vcsJj, { root: d.root ?? '', colocated: d.jj?.colocated ? 'yes' : 'no' }),
  none: () => 'none' // agent-protocol: the status's value for no version control found
}
