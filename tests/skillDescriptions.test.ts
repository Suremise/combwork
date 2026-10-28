import { join } from 'path'
import { readdirSync, readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { parseSkillFrontmatter } from '../src/main/skills'
import { SHIPPED_SKILL_DESCRIPTIONS, SHIPPED_SKILL_SOURCES, shippedSkillDescription } from '../src/shared/skillDescriptions'
import { englishText } from '../src/shared/advanced'
import { setLanguage, tr } from '../src/shared/i18n'

// The window shows a shipped skill's description translated while the workspace's copy has Hive's words (#1104): each
// message's English must be its SKILL.md's description, or the skill falls back to English without anyone noticing.
const SKILLS = join(__dirname, '..', 'resources', 'skills')
const shipped = Object.fromEntries(readdirSync(SKILLS).map((name) => [name, parseSkillFrontmatter(readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8')).description]))

describe('shipped skill descriptions', () => {
  it('has a message for each skill Hive ships, with its SKILL.md description as the English (or as SHIPPED_SKILL_SOURCES says)', () => {
    const messages = Object.fromEntries(Object.entries(SHIPPED_SKILL_DESCRIPTIONS).map(([name, m]) => [name, SHIPPED_SKILL_SOURCES[name] ?? m.defaultMessage]))
    // On a failure: change the message in src/shared/skillDescriptions.ts (or its SHIPPED_SKILL_SOURCES entry) to the description shown here.
    expect(messages).toEqual(shipped)
  })

  it("work-on-card (HI-1585): an untouched copy is recognised by its SKILL.md words and shown with the board's stage names; an edited one as written", () => {
    const skill = { name: 'work-on-card', description: shipped['work-on-card'] ?? '', level: 'hive', bundled: 'x' }
    expect(skill.description).toMatch(/from Doing to Review/)
    const m = shippedSkillDescription(skill)
    expect(m?.id).toBe('assistant.skills.shipped.workOnCard')
    expect(englishText(m!)).toMatch(/from Active to Review/)
    // Edited by the user: shown as written, never replaced by Hive's message.
    expect(shippedSkillDescription({ ...skill, description: `${skill.description} Mine.` })).toBeUndefined()
    // Translated in the window: German shows the board's stage name for Active (In Arbeit).
    const de = join(__dirname, '..', 'locales', 'de')
    setLanguage('de', Object.assign({}, ...readdirSync(de).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(de, f), 'utf8')))))
    try {
      expect(tr(m!)).toMatch(/von In Arbeit bis Review/)
    } finally {
      setLanguage('en', {})
    }
    // Each other skill is still recognised by its message's English.
    for (const [name, d] of Object.entries(shipped)) expect(shippedSkillDescription({ name, description: d ?? '', level: 'hive', bundled: 'x' })?.id).toBe(SHIPPED_SKILL_DESCRIPTIONS[name].id)
  })
})
