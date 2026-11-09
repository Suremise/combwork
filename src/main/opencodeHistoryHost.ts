import { join } from 'path'
import { OPENCODE } from '../shared/opencode'
import { onAccountRemoving } from './accounts'
import { localDataRoot } from './providers/antigravity/home'
import { opencode } from './providers/opencode/adapter'
import { opencodeHistory } from './providers/opencode/history'
import { opencodeCommand } from './providers/opencode/install'
import { providerService } from './providerService'
import { sessions } from './sessions'

let started = false

/**
 * The OpenCode history (HI-2762, providers/opencode/history.ts) joined to the rest of Combwork, once at startup: a run's
 * end exports its session; its plan limits and live cost reach its launch (sessions.reportDetails, the same way any
 * provider's status reports do); an account's removal waits until nothing writes into its folder, and is refused when that
 * can't be known.
 */
export function startOpencodeHistory(): void {
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
  onAccountRemoving((id) => opencodeHistory.removeRoot(join(localDataRoot(), 'accounts', id)))
}

/** Quitting: the history's worker ends what it started (its exports) and ends. */
export function stopOpencodeHistory(): void {
  void opencodeHistory.stop()
}
