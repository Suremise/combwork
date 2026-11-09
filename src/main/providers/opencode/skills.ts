import { join } from 'path'
import { mkdir } from 'original-fs/promises'
import { atMost } from '../../../shared/atMost'
import { contentHash, ContentTooLarge, copySkillTree, linksNotCopied, removePath, sourceProblem, tooBigToDeliver } from '../../fsutil'
import type { LaunchContext, SkillDelivery } from '../types'

/** Skills copied at once: each waits on the disk. */
const AT_ONCE = 4

/**
 * Where an OpenCode launch's skills go (HI-2761): its private config folder's `skills`, the one skill folder 2.2.6 reads
 * with both discovery switches on (R0b, tests/fixtures/opencode/real-2.2.6/skills/config-dir.json: listed to the model by
 * id, name and description, loaded with its `skill` tool). Never the project: the switches keep its folders out.
 */
export const opencodeSkillsDir = (configDir: string): string => join(configDir, 'skills')

/**
 * Copies the launch's skills into `skillsDir`, as Claude Code's launch folder gets them: each skill a copy of its source
 * (links kept as links), what the agent gets the copy's own revision, one skill's failure its own (too large, or its
 * source unreadable: no copy, and why). Anything else in the folder goes first, so a skill no longer given (or one an
 * earlier launch left) is never read. The folder is the launch's private one, removed when it ends.
 */
export async function copyOpencodeSkills(skillsDir: string, skills: LaunchContext['skills']): Promise<Record<string, SkillDelivery>> {
  await removePath(skillsDir)
  const delivered: Record<string, SkillDelivery> = {}
  if (!skills.length) return delivered
  await mkdir(skillsDir, { recursive: true })
  await atMost(AT_ONCE, skills, async (skill) => {
    const dest = join(skillsDir, skill.name)
    try {
      // The source within the hashing limits first (it reads no more than them), then the copy, which may have grown since.
      await contentHash(skill.sourcePath)
      const skipped = await copySkillTree(skill.sourcePath, dest)
      const revision = await contentHash(dest)
      delivered[skill.name] = skipped.length ? { revision, problem: linksNotCopied(skipped), lasting: true } : { revision }
    } catch (e) {
      await removePath(dest).catch(() => undefined)
      delivered[skill.name] = e instanceof ContentTooLarge ? { revision: null, problem: tooBigToDeliver(e), lasting: true } : { revision: null, problem: sourceProblem(e, skill.sourcePath) }
    }
  })
  return delivered
}
