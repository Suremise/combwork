// "How do you work?" (#1423, SPEC §16.3.5): Not now, the step's answer that applies nothing. The project's options stay
// inherited (the workspace's and Hive's defaults, else all off) and the step isn't offered again for the platform in
// force: written under the project's lock, in its turn among workflow writes, with setPresetAsked (the answer goes into
// `kept` with the platform's options when the project switches away, #1419). Choose saves through the Workflow
// section's own save, which records `chosen` (optionsForm.ts).

import { createLogger, userText } from '../logger'
import { projectPlatform } from '../platform/registry'
import { isPlatformId } from '../../shared/platform/descriptors'
import { CombworkError } from '../combworkError'
import { asksPreset } from '../../shared/workflow/presetStep'
import { setPresetAsked } from '../../shared/workflow/projectWorkflow'
import type { WorkspaceService } from '../workspace'
import { workflowChanged } from './rulesets'
import { workflowWrite } from './writes'

const log = createLogger('workflow')

/**
 * Not now, for the platform the step was shown for (`shown`): answered without a preset. Nothing changes if it was
 * answered meanwhile, or if the project uses another platform now (a switch meanwhile, another Hive's: that platform's
 * own question isn't answered for it, HR3's #1423 round 1).
 */
export function presetNotNow(ws: WorkspaceService, projectPath: string, shown: unknown): Promise<void> {
  if (!isPlatformId(shown)) return Promise.reject(new CombworkError({ lines: ['A version control is one of: none, git'] }, { kind: 'invalid' })) // i18n-ignore: a mistake in a caller, never the window's
  return workflowWrite(async () => {
    const p = ws.info()?.projects.find((x) => x.path.toLowerCase() === projectPath.toLowerCase())
    if (!p?.platform) throw new CombworkError({ lines: [`${projectPath} isn't a project of this workspace`] }, { kind: 'notFound' }) // i18n-ignore: a mistake in a caller, never the window's
    let answered = false
    await ws.mutateProjectConfig(p.path, (cfg) => {
      const platform = projectPlatform(p.path, cfg.platform).id
      // Switched since the step was shown, or answered or given options meanwhile (another window, the Assistant).
      if (platform !== shown || !asksPreset(cfg, platform)) return {}
      answered = true
      return { workflow: setPresetAsked(cfg.workflow, platform, 'notNow') }
    })
    if (!answered) return
    log.info(`${userText(p.name)}: "How do you work?" answered Not now`)
    workflowChanged(ws, p.path)
  })
}
