// A window's health in combwork.log (HI-1775): where it was and its long tasks, in a line's words; what the page sends is
// bounded and checked; main writes a long-task line at most every ten seconds a window, counting the rest in the next.
import { describe, expect, it, vi } from 'vitest'
import { cleanTasks, cleanWhere, MAX_SCRIPTS, MAX_TASKS, taskText, whereText, type LongTask } from '../src/shared/windowHealth'

const lines: string[] = []
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => undefined, info: () => undefined, warn: (m: string) => lines.push(m), error: () => undefined }),
  userText: (s: string) => `<${s}>`
}))
const { noteLongTasks } = await import('../src/main/rendererWatch')

const where = { view: 'board', project: 'alpha', tab: null, dialog: 'Card HI-12: a title', panels: ['assistant'] }
const task = (ms: number, scripts: string[] = [], during: string[] = []): LongTask => ({ at: 1, ms, kind: scripts.length ? 'frame' : 'task', scripts, during })

describe("a window's health in combwork.log (HI-1775)", () => {
  it("names where it was, the user's own text wrapped, and what ran in a long task", () => {
    expect(whereText(where, (s) => `<${s}>`)).toBe('view board, project <alpha>, dialog <Card HI-12: a title>, panels assistant')
    expect(whereText({ view: 'projects', project: 'alpha', tab: 'sessions', dialog: null, panels: [] }, (s) => s)).toBe('view projects, project alpha, tab sessions')
    expect(whereText(null, (s) => s)).toBe('where unknown')
    expect(taskText(task(512.4, ['TimerHandler:setTimeout 500 ms']))).toBe('512 ms (TimerHandler:setTimeout 500 ms)')
    expect(taskText(task(300))).toBe('300 ms')
    expect(taskText({ at: 1, ms: 300, kind: 'frame', scripts: [], during: [] })).toBe('300 ms (no script: layout, style or paint)')
    // What arrived from main just before it: what it most likely handled.
    expect(taskText(task(420, [], ['reply tasks:changes', 'event tasks-changed ×3']))).toBe('420 ms (after reply tasks:changes, event tasks-changed ×3)')
  })

  it("takes the page's report as data: bounded, and nothing that isn't one", () => {
    const many = Array.from({ length: MAX_TASKS + 5 }, (_, i) => ({ at: i, ms: 250, kind: 'frame', scripts: Array.from({ length: 6 }, (__, j) => `s${j}${'x'.repeat(300)}`) }))
    const clean = cleanTasks(many)
    expect(clean).toHaveLength(MAX_TASKS)
    expect(clean[0].scripts).toHaveLength(MAX_SCRIPTS)
    expect(clean[0].scripts[0].length).toBe(200)
    expect(cleanTasks([{ at: 1, ms: 'long' }, null, 'x', { at: 1, ms: -1 }])).toEqual([])
    expect(cleanTasks('nope')).toEqual([])
    expect(cleanWhere({ view: '' })).toBeNull()
    expect(cleanWhere({ view: 'board', panels: ['a', 7, 'b'], project: 3 })).toEqual({ view: 'board', project: null, tab: null, dialog: null, panels: ['a', 'b'] })
  })

  it("names where each task ran, not where the window is by the time it's reported; the window's own place stays its own", () => {
    const entry = {} as never
    lines.length = 0
    const board = { ...where, dialog: null, panels: [] }
    const perf = { view: 'performance', project: 'alpha', tab: null, dialog: null, panels: [] }
    // The board's tasks, reported once the window shows Performance.
    noteLongTasks(entry, [{ ...task(800), where: board }, { ...task(300), where: perf }], perf, 200_000)
    expect(lines).toEqual(["The window's page was busy for 800 ms (view board, project <alpha>); 2 long task(s), 1100 ms in all; the longest: 800 ms; others in view performance, project <alpha>"])
  })

  it('writes one line for a burst, names its longest and where, and counts what it held back in the next', () => {
    const entry = {} as never
    lines.length = 0
    noteLongTasks(entry, [task(250), task(900, ['render 880 ms'])], where, 100_000)
    expect(lines).toEqual(["The window's page was busy for 900 ms (view board, project <alpha>, dialog <Card HI-12: a title>, panels assistant); 2 long task(s), 1150 ms in all; the longest: 900 ms (render 880 ms)"])
    // Within ten seconds: held back, counted.
    noteLongTasks(entry, [task(300)], null, 105_000)
    noteLongTasks(entry, [task(400), task(220)], null, 109_000)
    expect(lines).toHaveLength(1)
    noteLongTasks(entry, [task(260)], null, 110_001)
    expect(lines).toHaveLength(2)
    expect(lines[1]).toBe("The window's page was busy for 260 ms (view board, project <alpha>, dialog <Card HI-12: a title>, panels assistant); 1 long task(s), 260 ms in all; the longest: 260 ms; 3 more since the last line, not logged")
  })
})
