import type { ProjectConfig, SkillDeliveryChoice, WorkspaceConfig } from './types'

/**
 * Which Hive skills reach a project's agents (#1431, SPEC §16.15 C row 15): every valid one for their audience, unless
 * the workspace or the project switched it off (Skills → Delivered to agents). The Assistant's skills aren't chosen
 * here: it always gets its own.
 */

/** The names a choice switches off (a hand-edited file may hold anything), lower case. */
export function offNames(choice: SkillDeliveryChoice | undefined): Set<string> {
  const list = Array.isArray(choice?.off) ? choice.off : []
  return new Set(list.filter((n): n is string => typeof n === 'string').map((n) => n.toLowerCase()))
}

/** Whether a skill is switched off in the workspace (where `project` is absent) or for a project's agents. */
export function skillOff(name: string, ws: Pick<WorkspaceConfig, 'skillDelivery'> | undefined, project?: Pick<ProjectConfig, 'skillDelivery'>): boolean {
  const n = name.toLowerCase()
  return offNames(ws?.skillDelivery).has(n) || offNames(project?.skillDelivery).has(n)
}

/** A choice with `name` switched on or off (the others kept, sorted). */
export function withSkillDelivered(choice: SkillDeliveryChoice | undefined, name: string, on: boolean): SkillDeliveryChoice {
  const off = new Set([...offNames(choice)])
  if (on) off.delete(name.toLowerCase())
  else off.add(name.toLowerCase())
  return { off: [...off].sort() }
}
