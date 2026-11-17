// HI-3339: jj-slot-stale's checks on what its agent did to the stale slot read commands from shell tools only. A model
// trial (HI-3335's sample: Claude Code 2.1.326, Opus 5.5, seed 20261116) failed "didn't update, snapshot or roll back the
// stale slot with jj itself" for a question to the user that named `jj workspace update-stale` as the user's option: its
// cw_ask_user call's input was read as a command. Checked on the scenario's own helper, with that trial's tool calls.
import { describe, expect, it } from 'vitest'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
type Tool = { name: string; input: string; cwd?: string }
type Found = { updates: Tool[]; recorded: Tool[]; written: Tool[] }
const { helpers, SCENARIOS } = require('./scenarios/scenarios.cjs') as { helpers: { staleSlotCommands: (o: { tools: Tool[] }, folder: string) => Found }; SCENARIOS: { id: string }[] }
const { staleSlotCommands } = helpers

const SLOT = 'C:\\combwork-test\\scenarios\\lanes\\0\\ws\\alpha.worktrees\\slot-a'
const ASK = 'card: AL-2\nkind: other\ntext: I can\'t start AL-2 because slot-a is stale. Another jj workspace rewrote its working copy, so `jj status` fails with "working copy is stale (not updated since operation 6c5058c7cf8f)". Combwork says to fix it with Recover… under Slots and copies. Please run that, or tell me to run `jj workspace update-stale` myself.'
/** The trial's tool calls, as the harness recorded them (results 2026-11-17T02-23-16-claude-code). */
const trial: Tool[] = [
  { name: 'ToolSearch', input: 'select:mcp__combwork__cw_inbox' },
  { name: 'combwork · cw_inbox', input: '' },
  { name: 'combwork · cw_read_task', input: 'number: AL-2' },
  { name: 'Bash', input: 'jj status 2>&1 | head -20', cwd: SLOT },
  { name: 'combwork · cw_ask_user', input: ASK },
  { name: 'combwork · cw_inbox', input: 'ack: m1, m4' },
  { name: 'combwork · cw_wait_for_tasks', input: 'cards: AL-2\nwake: true' }
]

describe("jj-slot-stale reads the commands its agent ran, not what it said (HI-3339)", () => {
  it('is still a scenario', () => {
    expect(SCENARIOS.some((s) => s.id === 'jj-slot-stale')).toBe(true)
  })

  it('the trial that failed: a read-only jj status and a question naming the command run nothing', () => {
    expect(staleSlotCommands({ tools: trial }, SLOT)).toEqual({ updates: [], recorded: [], written: [] })
  })

  it('the command run in a shell still fails it, in each CLI\'s shell tool', () => {
    for (const t of [
      { name: 'Bash', input: 'jj workspace update-stale', cwd: SLOT },
      { name: 'PowerShell', input: 'jj.exe util snapshot', cwd: SLOT },
      { name: 'exec_command', input: JSON.stringify({ cmd: 'jj op restore 6c5058c7cf8f', workdir: SLOT }) }
    ]) expect(staleSlotCommands({ tools: [...trial, t] }, SLOT).updates, t.name).toEqual([t])
  })

  it('recording in the slot is read from shells too, and a file written there still counts', () => {
    const commit = { name: 'Bash', input: `jj commit -m "bye" ${SLOT}`, cwd: SLOT }
    const said = { name: 'combwork · cw_ask_user', input: `text: should I run jj commit in ${SLOT}?` }
    const write = { name: 'Write', input: `file_path: ${SLOT}\\bye.js\ncontent: module.exports = (n) => 'Bye, ' + n` }
    expect(staleSlotCommands({ tools: [said] }, SLOT)).toEqual({ updates: [], recorded: [], written: [] })
    expect(staleSlotCommands({ tools: [commit, write] }, SLOT)).toEqual({ updates: [], recorded: [commit], written: [write] })
  })
})
