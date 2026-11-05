// The Dialects view's model and service (HI-2444; plans/2026-11-03-dialects-design.md, section 4; HR1's design checks):
// what a text of a file shows (its own override, else the first layer beneath that is on, else the Default), each
// layer's value, the "changed here" and "changed anywhere" filters; Save against the text it started from, under the
// folder's lock; a raw JSON save checked as a form's; Delete's protected files; the import tokens' scope and life.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { changedAnywhere, changedHere, inheritedText, layerValues, shownText, type DialectFile, type DialectLayer } from '../src/shared/dialects'
import { deleteDialect, saveDialect, saveDialectRaw, type DialectSchema } from '../src/main/dialects'
import { dialectFileView, forgetPicks, listDialects, pickOfToken, rememberPick, spendPick } from '../src/main/dialects/view'
import { tempDir } from './tempDir'

const SCHEMA: DialectSchema = { 'a.plain': {}, 'a.named': { project: 'plain' } }
const layer = (l: DialectLayer['layer'], texts: Record<string, string>, on = true): DialectLayer => ({ layer: l, path: `${l}.json`, on, texts })
const fileOf = (texts: Record<string, string>): DialectFile => ({ name: 'x', texts: Object.fromEntries(Object.entries(texts).map(([id, text]) => [id, { text }])) })

describe('what a text of a file shows', () => {
  const below = [layer('cli', { 'a.plain': 'cli' }), layer('workspace', { 'a.plain': 'ws', 'a.named': 'ws {project}' })]

  it('its own override, else the first layer beneath that has it, else the Default', () => {
    expect(shownText('a.plain', fileOf({ 'a.plain': 'mine' }), below, 'Default')).toEqual({ text: 'mine', source: { from: 'file' } })
    expect(shownText('a.plain', fileOf({}), below, 'Default')).toEqual({ text: 'cli', source: { from: 'layer', index: 0 } })
    expect(shownText('a.named', fileOf({}), below, 'Default {project}')).toEqual({ text: 'ws {project}', source: { from: 'layer', index: 1 } })
    expect(shownText('a.other', fileOf({}), below, 'Default')).toEqual({ text: 'Default', source: { from: 'default' } })
  })

  it('a layer switched off is skipped: its texts fall through', () => {
    expect(inheritedText('a.plain', [layer('cli', { 'a.plain': 'cli' }, false), layer('workspace', { 'a.plain': 'ws' })], 'Default').text).toBe('ws')
  })

  it("each layer's value, top to bottom, undefined where a layer has none (shown as —)", () => {
    expect(layerValues('a.named', fileOf({}), below, 'D {project}').map((l) => l.text)).toEqual([undefined, undefined, 'ws {project}', 'D {project}'])
  })

  it('changed here: the file overrides it; changed anywhere: it or a layer beneath that is on', () => {
    const off = [layer('cli', { 'a.plain': 'cli' }, false)]
    expect(changedHere('a.plain', fileOf({ 'a.plain': 'x' }))).toBe(true)
    expect(changedHere('a.plain', fileOf({}))).toBe(false)
    expect(changedAnywhere('a.plain', fileOf({}), below)).toBe(true)
    expect(changedAnywhere('a.plain', fileOf({}), off)).toBe(false)
    expect(changedAnywhere('a.other', fileOf({}), below)).toBe(false)
  })
})

const base = tempDir('hive-dialects-view-')
afterAll(() => rmSync(base, { recursive: true, force: true }))
let n = 0
const folder = (): string => {
  const d = join(base, `d-${++n}`)
  mkdirSync(join(d, 'claude-code'), { recursive: true })
  return d
}
const text = (dir: string, path: string): string => readFileSync(join(dir, ...path.split('/')), 'utf8')

describe('saving against the text the draft started from', () => {
  it('saves when the file is still that text; refuses, writing nothing, when it changed meanwhile', async () => {
    const dir = folder()
    writeFileSync(join(dir, 'workspace.json'), '{ "name": "W", "texts": {} }\n')
    const startedFrom = text(dir, 'workspace.json')
    writeFileSync(join(dir, 'workspace.json'), '{ "name": "W", "texts": { "a.plain": { "text": "outside" } } }\n')
    const r = await saveDialect(dir, 'workspace.json', fileOf({ 'a.plain': 'mine' }), SCHEMA, { base: startedFrom })
    expect(r).toEqual({ refused: 'changedOnDisk', disk: text(dir, 'workspace.json') })
    expect(text(dir, 'workspace.json')).toContain('outside')
    expect(await saveDialect(dir, 'workspace.json', fileOf({ 'a.plain': 'mine' }), SCHEMA, { base: text(dir, 'workspace.json') })).toBeNull()
    expect(text(dir, 'workspace.json')).toContain('mine')
  })

  it('two saves from the same text: the second is refused, never overwriting the first', async () => {
    const dir = folder()
    writeFileSync(join(dir, 'workspace.json'), '{ "name": "W", "texts": {} }\n')
    const startedFrom = text(dir, 'workspace.json')
    const [a, b] = await Promise.all([saveDialect(dir, 'workspace.json', fileOf({ 'a.plain': 'one' }), SCHEMA, { base: startedFrom }), saveDialect(dir, 'workspace.json', fileOf({ 'a.plain': 'two' }), SCHEMA, { base: startedFrom })])
    expect([a, b].filter((r) => r === null)).toHaveLength(1)
    expect([a, b].filter((r) => r?.refused === 'changedOnDisk')).toHaveLength(1)
  })

  it("the JSON tab's text: refused when it isn't a dialect file, checked as a form's when it is", async () => {
    const dir = folder()
    writeFileSync(join(dir, 'workspace.json'), '{ "name": "W", "texts": {} }\n')
    expect(await saveDialectRaw(dir, 'workspace.json', '{ "name": ', SCHEMA)).toEqual({ refused: 'file', problem: { problem: 'json' } })
    expect(await saveDialectRaw(dir, 'workspace.json', '{ "name": "W", "texts": { "a.named": { "text": "no project" } } }', SCHEMA)).toMatchObject({ refused: 'texts', problems: [{ id: 'a.named', problem: 'placeholders', missing: ['project'] }] })
    expect(await saveDialectRaw(dir, 'workspace.json', '{ "name": "W", "texts": { "a.named": { "text": "in {project}" } } }', SCHEMA)).toBeNull()
    expect(text(dir, 'workspace.json')).toContain('in {project}')
  })
})

describe('deleting', () => {
  const removed: string[] = []
  const remove = async (f: string): Promise<void> => {
    removed.push(f)
    rmSync(f)
  }

  it('refuses the Workspace file, a CLI file and a shipped file', async () => {
    const dir = folder()
    for (const p of ['workspace.json', 'claude-code/cli.json', 'claude-code/Opus 5.5.json']) writeFileSync(join(dir, ...p.split('/')), '{ "name": "x", "texts": {} }')
    const shipped = new Set(['claude-code/Opus 5.5'])
    for (const p of ['workspace.json', 'claude-code/cli.json', 'claude-code/Opus 5.5.json']) expect(await deleteDialect(dir, p, { shipped, remove })).toEqual({ refused: 'protected' })
    expect(removed).toEqual([])
  })

  it("removes a file the user made, and its switch; a path that isn't a dialect file's is refused", async () => {
    const dir = folder()
    writeFileSync(join(dir, 'claude-code', 'Mine.json'), '{ "name": "Mine", "texts": {} }')
    writeFileSync(join(dir, '.state.json'), JSON.stringify({ off: ['claude-code/Mine.json'] }))
    expect(await deleteDialect(dir, 'claude-code/Mine.json', { shipped: new Set(), remove })).toBeNull()
    expect(removed.at(-1)).toBe(join(dir, 'claude-code', 'Mine.json'))
    expect(JSON.parse(readFileSync(join(dir, '.state.json'), 'utf8')).off).toEqual([])
    expect(await deleteDialect(dir, '../outside.json', { shipped: new Set(), remove })).toEqual({ refused: 'path' })
    expect(await deleteDialect(dir, 'claude-code/Gone.json', { shipped: new Set(), remove })).toEqual({ refused: 'missing', path: 'claude-code/Gone.json' })
  })
})

describe('import tokens', () => {
  it("are opaque, one window's and one workspace's, and spent by a successful import", () => {
    const t = rememberPick('C:\\x\\a.json', 1, 'C:\\ws\\.combwork', 1000)
    expect(t).not.toContain('a.json')
    expect(pickOfToken(t, 1, 'c:\\WS\\.combwork', 2000)).toBe('C:\\x\\a.json')
    expect(pickOfToken(t, 2, 'C:\\ws\\.combwork', 2000)).toBeNull()
    expect(pickOfToken(t, 1, 'C:\\other\\.combwork', 2000)).toBeNull()
    expect(spendPick(t)).toBe(true)
    expect(pickOfToken(t, 1, 'C:\\ws\\.combwork', 2000)).toBeNull()
  })

  it('last ten minutes, and go with their window or workspace; at most 8 are kept, the oldest first out', () => {
    const t = rememberPick('a', 1, 'W', 0)
    expect(pickOfToken(t, 1, 'W', 10 * 60_000 + 1)).toBeNull()
    const w = rememberPick('b', 3, 'W', 0)
    const v = rememberPick('c', 4, 'V', 0)
    forgetPicks({ window: 3 })
    forgetPicks({ combworkDir: 'v' })
    expect(pickOfToken(w, 3, 'W', 1)).toBeNull()
    expect(pickOfToken(v, 4, 'V', 1)).toBeNull()
    const many = Array.from({ length: 9 }, (_, i) => rememberPick(`f${i}`, 5, 'W', 100 + i))
    expect(pickOfToken(many[0], 5, 'W', 200)).toBeNull()
    expect(pickOfToken(many[8], 5, 'W', 200)).toBe('f8')
  })
})

describe('the Workspace file before it is made', () => {
  it('is listed and opens empty, its first Save making it; Combwork writes nothing until then', async () => {
    const hive = join(base, `h-${++n}`)
    mkdirSync(join(hive, 'dialects', 'claude-code'), { recursive: true })
    writeFileSync(join(hive, 'dialects', 'claude-code', 'cli.json'), '{ "name": "Claude Code", "texts": {} }')
    const rows = await listDialects(hive)
    expect(rows[0]).toMatchObject({ path: 'workspace.json', kind: 'workspace', overrides: 0, on: true })
    const view = await dialectFileView(hive, 'workspace.json')
    expect(view).toMatchObject({ raw: '', file: { name: 'Workspace', texts: {} }, below: [] })
    expect(() => readFileSync(join(hive, 'dialects', 'workspace.json'))).toThrow()
    expect(await dialectFileView(hive, 'claude-code/Missing.json')).toBeNull()
    const dir = join(hive, 'dialects')
    expect(await saveDialect(dir, 'workspace.json', { name: 'Workspace', texts: {} }, SCHEMA, { base: view!.raw })).toBeNull()
    expect(text(dir, 'workspace.json')).toContain('"Workspace"')
  })
})
