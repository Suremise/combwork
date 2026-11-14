import { join } from 'path'
import { OPENCODE } from '../../../shared/providers/opencode'
import { onAccountRemoving } from '../../accounts'
import { localDataRoot } from '../localData'
import type { OpencodeAdapter } from './adapter'
import { opencodeHistory } from './history'
import { untrackContextRun } from './context'
import { opencodeCommand } from './install'
import { providerService } from '../../providerService'
import { sessions } from '../../sessions'

let started = false

/**
 * The OpenCode history (HI-2762, providers/opencode/history.ts) joined to the rest of Combwork, once at startup: a run's
 * end exports its session; its plan limits and live cost reach its launch (sessions.reportDetails, the same way any
 * provider's status reports do); an account's removal waits until nothing writes into its folder, and is refused when that
 * can't be known.
 */
export function startOpencodeHistory(opencode: Pick<OpencodeAdapter, 'allHomes'>): void {
  if (started) return
  started = true
  opencodeHistory.start({
    limits: (runId, usage) => (usage ? sessions.reportDetails(runId, { planUsage: usage }) : sessions.clearPlanUsage(runId)),
    cost: (runId, costUsd) => sessions.reportDetails(runId, { costUsd }),
    executable: () => providerService.info(OPENCODE).path ?? null,
    homes: () => opencode.allHomes(),
    command: (executable, args, home) => opencodeCommand(executable, args, home)
  })
  sessions.onLaunchEnded.add((_projectPath, _agentId, runId) => void opencodeHistory.ended(runId))
  // The run's server credentials for its state view go with it (HI-2771).
  sessions.onLaunchEnded.add((_projectPath, _agentId, runId) => untrackContextRun(runId))
  onAccountRemoving((id) => opencodeHistory.removeRoot(join(localDataRoot(), 'accounts', id)))
}
