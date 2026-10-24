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

/**
 * The code of a source, with the text of its strings, template literals and comments blanked out (their characters
 * become spaces, line breaks kept, so offsets and line numbers stay): message ids ('panes.tab.worktree') and comments
 * aren't reads, but a template's `${…}` is code, nested and over several lines too. Regex literals are taken as code;
 * none in src holds `.worktree`.
 */
function codeOf(source: string): string {
  const out = source.split('')
  const blank = (i: number): void => {
    if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' '
  }
  // What each open `${` or `{` inside a template's expression closes into: 'template' (back to its text) or 'code'.
  const braces: ('template' | 'code')[] = []
  let i = 0
  const n = source.length
  /** Blanks a template literal's text from i (just past its backtick or a `}` closing an expression) to its end or `${`. */
  const templateText = (): void => {
    while (i < n) {
      const c = source[i]
      if (c === '\\') {
        blank(i)
        blank(i + 1)
        i += 2
      } else if (c === '`') {
        i++
        return
      } else if (c === '$' && source[i + 1] === '{') {
        braces.push('template')
        i += 2
        return
      } else {
        blank(i)
        i++
      }
    }
  }
  while (i < n) {
    const c = source[i]
    if (c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') blank(i++)
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end < 0 ? n : end + 2
      while (i < stop) blank(i++)
    } else if (c === "'" || c === '"') {
      i++
      while (i < n && source[i] !== c && source[i] !== '\n') {
        if (source[i] === '\\') blank(i++)
        blank(i++)
      }
      i++
    } else if (c === '`') {
      i++
      templateText()
    } else if (c === '{') {
      if (braces.length) braces.push('code')
      i++
    } else if (c === '}' && braces.length) {
      i++
      if (braces.pop() === 'template') templateText()
    } else i++
  }
  return out.join('')
}

/** The `.worktree` reads in a file that aren't allowed: "file:line: receiver.worktree". */
function unexpected(rel: string, source: string): string[] {
  const allowed = ALLOWED[rel] ?? {}
  const code = codeOf(source)
  const out: string[] = []
  for (const m of code.matchAll(ACCESS)) {
    if (m[1] in allowed) continue
    const line = code.slice(0, m.index).split('\n').length
    out.push(`${rel}:${line}: ${m[0]}`)
  }
  return out
}

describe("an agent's 0.9 worktree is read only through legacyWorktree (#1452)", () => {
  it('no `.worktree` in src but the allowed ones, each of something other than an agent', () => {
    const found = sources().flatMap((rel) => unexpected(rel, readFileSync(join(ROOT, rel), 'utf8')))
    expect(found).toEqual([])
  })

  it('finds an agent read, so the gate can fail: in code, and in a template literal\'s expressions (HR2\'s round 1)', () => {
    expect(unexpected('src/main/example.ts', 'const p = agent.worktree?.path\nconst q = def.worktree')).toEqual(['src/main/example.ts:1: agent.worktree', 'src/main/example.ts:2: def.worktree'])
    expect(unexpected('src/main/example.ts', 'const p = `${agent.worktree.path}`')).toEqual(['src/main/example.ts:1: agent.worktree'])
    // Over several lines, nested in another template and in an object literal's braces.
    const multi = 'log(`moved ${a.name}\nfrom ${`${x.worktree?.path}`} to ${{ p: def.worktree }.p}`)'
    expect(unexpected('src/main/example.ts', multi)).toEqual(['src/main/example.ts:2: x.worktree', 'src/main/example.ts:2: def.worktree'])
    // Text isn't a read: a message id, a comment, a template's own text, an escaped backtick.
    expect(unexpected('src/main/example.ts', "msg({ id: 'panes.tab.worktree' }) // a.worktree in a comment\n/* b.worktree */ const t = `c.worktree \\` ${'d.worktree'}`")).toEqual([])
  })

  it('every allowed file still has what it allows (the list only shrinks)', () => {
    for (const [rel, receivers] of Object.entries(ALLOWED)) {
      const code = codeOf(readFileSync(join(ROOT, rel), 'utf8'))
      const seen = new Set([...code.matchAll(ACCESS)].map((m) => m[1]))
      for (const r of Object.keys(receivers)) expect(seen.has(r), `${rel}: ${r}.worktree`).toBe(true)
    }
  })
})
