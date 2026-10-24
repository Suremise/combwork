// 0.9.3's agent field `worktree` (#1452, SPEC §16.10.3): `AgentDef` no longer types it, and an agent's stored one is read
// only through `legacyWorktree` (shared/agentFolders.ts, its module). This gate finds every `<name>.worktree` in src
// and allows only those of other things, named here with what they are: a request, a reply, a branch row, a merge
// target, a message key. A new one on an agent fails: read it with `legacyWorktree(agent)`, where the folder contract
// doesn't already say where the agent works (`agentPlace`, `currentFolder`).
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join, resolve } from 'path'

const ROOT = resolve(__dirname, '..')

/** `<receiver>.worktree` or `<receiver>?.worktree`, not inside a message id or a quoted name. */
const ACCESS = /([A-Za-z_$][\w$]*)\??\.worktree\b/g

/** Each file's receivers whose `.worktree` isn't an agent's, with what it is. */
const ALLOWED: Record<string, Record<string, string>> = {
  'src/shared/agentFolders.ts': { was: "carryLegacyAgentFields' stored agent", keep: 'the fields it carries' },
  'src/main/branchWatch.ts': { found: "findAgent's answer: an agent's 0.9 worktree, from legacyWorktree" },
  'src/main/gitRepo.ts': { local: "a local branch's checkout (GitBranch.worktree)" },
  'src/main/projectAgents.ts': { result: "Remove's reply (RemovedAgent.worktree)" },
  'src/main/servers.ts': { body: "an Agent API request's worktree, refused (#1451)" },
  'src/main/taskStart.ts': { target: "a card start's request for a new agent (refused by add-agent, #1451)" },
  'src/main/workflow/upgrade.ts': { at: "an adoption's place (AdoptionAt.worktree)" },
  'src/renderer/src/actions.ts': { r: "Remove All's reply (RemovedAgent.worktree)" },
  'src/renderer/src/components/AgentDialogs.tsx': { target: "the Merge dialog's unused worktree (store.mergeFor)" },
  'src/renderer/src/components/MoveRepair.tsx': { T: 'a message key' },
  'src/renderer/src/components/ProjectRemoval.tsx': { M: 'a message key' },
  'src/renderer/src/views/GitBranches.tsx': { b: "a branch row's checkout (GitBranch.worktree)" },
  'src/shared/templateLoad.ts': { a: "a template load's agent to remove (TemplateLoadPlan.remove[].worktree)" }
}

function sources(dir = 'src'): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`
    return e.isDirectory() ? sources(rel) : /\.(ts|tsx|mts)$/.test(e.name) && !e.name.endsWith('.d.ts') ? [rel] : []
  })
}

/** The `.worktree` reads in a file that aren't allowed: "file:line: receiver.worktree". */
function unexpected(rel: string, source: string): string[] {
  const allowed = ALLOWED[rel] ?? {}
  const out: string[] = []
  source.split(/\r?\n/).forEach((line, i) => {
    // Message ids ('panes.tab.worktree') and comments aren't reads.
    const code = line.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "''").replace(/\/\/.*$/, '')
    for (const m of code.matchAll(ACCESS)) if (!(m[1] in allowed)) out.push(`${rel}:${i + 1}: ${m[0]}`)
  })
  return out
}

describe("an agent's 0.9 worktree is read only through legacyWorktree (#1452)", () => {
  it('no `.worktree` in src but the allowed ones, each of something other than an agent', () => {
    const found = sources().flatMap((rel) => unexpected(rel, readFileSync(join(ROOT, rel), 'utf8')))
    expect(found).toEqual([])
  })

  it('finds an agent read, so the gate can fail', () => {
    expect(unexpected('src/main/example.ts', 'const p = agent.worktree?.path\nconst q = def.worktree')).toEqual(['src/main/example.ts:1: agent.worktree', 'src/main/example.ts:2: def.worktree'])
    expect(unexpected('src/main/example.ts', "msg({ id: 'panes.tab.worktree' }) // a.worktree in a comment")).toEqual([])
  })

  it('every allowed file still has what it allows (the list only shrinks)', () => {
    for (const [rel, receivers] of Object.entries(ALLOWED)) {
      const code = readFileSync(join(ROOT, rel), 'utf8')
        .split(/\r?\n/)
        .map((l) => l.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "''").replace(/\/\/.*$/, ''))
        .join('\n')
      const seen = new Set([...code.matchAll(ACCESS)].map((m) => m[1]))
      for (const r of Object.keys(receivers)) expect(seen.has(r), `${rel}: ${r}.worktree`).toBe(true)
    }
  })
})
