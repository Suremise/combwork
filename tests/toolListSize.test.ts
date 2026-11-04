// The hive tool list's size as the bridge reports it (HI-2063): its characters, and of them the tools' descriptions and
// their parameters' descriptions, each as the list's JSON has it.
import { describe, expect, it } from 'vitest'
import { toolListSize } from '../src/shared/toolListSize'

const inJson = (s: string) => JSON.stringify(s).length - 2

describe('the tool list’s size and its parts', () => {
  const DESC = 'Add a card, "quoted"\nover two lines — café 🐝'
  const list = [
    {
      name: 'cw_create_task',
      description: DESC,
      inputSchema: {
        type: 'object',
        properties: {
          // A parameter named "description": an object, walked, not counted as a description itself.
          description: { type: 'string', description: 'What to do' },
          links: { type: 'array', description: 'Related cards', items: { type: ['number', 'string'], description: 'Its key ("HI-12")' } },
          options: { type: 'object', properties: { deep: { type: 'object', properties: { leaf: { type: 'boolean', description: 'Ünïcode\tleaf' } } } } }
        },
        required: ['description']
      }
    },
    { name: 'cw_inbox', description: 'What Hive has for you', inputSchema: { type: 'object', properties: {} } },
    { name: 'no_description', inputSchema: { type: 'object' } }
  ]

  it('counts descriptions and nested parameter descriptions as the JSON has them, escapes included', () => {
    const size = toolListSize(list)
    expect(size.toolsChars).toBe(JSON.stringify(list).length)
    expect(size.descriptionChars).toBe(inJson(DESC) + inJson('What Hive has for you'))
    expect(size.paramChars).toBe(['What to do', 'Related cards', 'Its key ("HI-12")', 'Ünïcode\tleaf'].map(inJson).reduce((a, b) => a + b, 0))
    // Escapes count as the JSON has them: \" and \n are two characters each, an emoji two UTF-16 code units.
    expect(inJson(DESC)).toBe(DESC.length + 3)
    // The parts are within the list, the rest its schemas and structure.
    expect(size.descriptionChars + size.paramChars).toBeLessThan(size.toolsChars)
    const text = JSON.stringify(list)
    for (const d of [DESC, 'Its key ("HI-12")', 'Ünïcode\tleaf']) expect(text).toContain(JSON.stringify(d).slice(1, -1))
  })

  it('measures the list without changing it', () => {
    const before = JSON.stringify(list)
    toolListSize(list)
    expect(JSON.stringify(list)).toBe(before)
    expect(toolListSize(Object.freeze([Object.freeze({ description: 'x', inputSchema: Object.freeze({ description: 'y' }) })]))).toMatchObject({ descriptionChars: 1, paramChars: 1 })
  })

  it('an empty list is two characters, no parts', () => {
    expect(toolListSize([])).toEqual({ toolsChars: 2, descriptionChars: 0, paramChars: 0 })
  })
})
