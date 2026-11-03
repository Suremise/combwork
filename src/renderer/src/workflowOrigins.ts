// Where a workflow option's value comes from, as the Version Control tab and Settings → Workflow defaults say it: the
// workflow options' origins, and the slot defaults' (HI-1765: Slots and copies, which inherit the same way).
import type { WorkflowOptionOrigin } from '@shared/types'
import { msg } from '@shared/i18n'

export const ORIGIN_TEXT = {
  preset: msg({ id: 'workflow.form.from.preset', defaultMessage: 'From the preset', description: 'Where a workflow option’s value comes from: the preset chosen.' }),
  project: msg({ id: 'workflow.form.from.project', defaultMessage: 'Set for this project', description: 'Where a workflow option’s value comes from: set in this project.' }),
  workspace: msg({ id: 'workflow.form.from.workspace', defaultMessage: 'From the workspace', description: 'Where a workflow option’s value comes from: the workspace’s default.' }),
  global: msg({ id: 'workflow.form.from.global', defaultMessage: 'From Combwork defaults', description: 'Where a workflow option’s value comes from: Hive’s own default.' }),
  platform: msg({ id: 'workflow.form.from.platform', defaultMessage: 'Default', description: 'Where a workflow option’s value comes from: nobody set it (every rule off).' }),
  here: msg({ id: 'workflow.form.from.here', defaultMessage: 'Set here', description: 'Where a workflow default’s value comes from, in Settings → Workflow defaults or Settings → Workspace: set at this level.' })
} satisfies Record<WorkflowOptionOrigin | 'preset' | 'here', ReturnType<typeof msg>>
