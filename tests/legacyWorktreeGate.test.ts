// 0.9.3's agent field `worktree` (#1452, SPEC §16.10.3): `AgentDef` no longer types it, and an agent's stored one is read
// only through `legacyWorktree` (shared/agentFolders.ts, its module). This gate parses every source in src (Babel's
// TypeScript and JSX parser, as scripts/i18nGuard.mjs does: TypeScript 7 has no compiler API to call) and finds each
// read of `worktree`: `x.worktree`, `x?.worktree`, `x['worktree']`, and a destructuring of it, through casts and calls
// too (`(a as StoredAgent).worktree` is a's). It allows only those of other things, named here with what they are: a
// request, a reply, a branch row, a merge target, legacyWorktree's own. A new one on an agent fails: read it with
// `legacyWorktree(agent)`, where the folder contract doesn't already say where the agent works (`agentPlace`).
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { parse } from '@babel/parser'
import traverseModule, { type NodePath } from '@babel/traverse'
import type * as t from '@babel/types'

// @babel/traverse is CommonJS: its default export is the function, once or twice wrapped.
const traverse = ((traverseModule as unknown as { default?: typeof traverseModule }).default ?? traverseModule) as typeof traverseModule

const ROOT = resolve(__dirname, '..')

/** Each file's receivers whose `.worktree` isn't an agent's, with what it is. */
const ALLOWED: Record<string, Record<string, string>> = {
  'src/shared/branchCleanup.ts': { b: "a branch row's checkout (GitBranchRow.worktree): a branch in use isn't cleaned up" },
  'src/shared/agentFolders.ts': { raw: "legacyWorktree's own read", was: "carryLegacyAgentFields' stored agent", keep: 'the fields it carries' },
  'src/main/branchWatch.ts': { found: "findAgent's answer: an agent's 0.9 worktree, from legacyWorktree" },
  'src/main/gitRepo.ts': { local: "a local branch's checkout (GitBranch.worktree)" },
  'src/main/projectAgents.ts': { result: "Remove's reply (RemovedAgent.worktree)", worktreeOf: "worktreeOf's answer, from legacyWorktree" },
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

/** The name a receiver comes down to: through casts, `!`, `await`, calls and member chains, to its first identifier. */
function rootName(node: t.Node | null | undefined): string {
  let n: t.Node | null | undefined = node
  for (let i = 0; n && i < 50; i++) {
    switch (n.type) {
      case 'Identifier':
        return n.name
      case 'ThisExpression':
        return 'this'
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
      case 'TSTypeAssertion':
      case 'ParenthesizedExpression':
        n = n.expression
        break
      case 'AwaitExpression':
        n = n.argument
        break
      case 'CallExpression':
      case 'OptionalCallExpression':
        n = n.callee
        break
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        n = n.object
        break
      default:
        return `(${n.type})`
    }
  }
  return '(?)'
}

/** Whether a member expression's property is `worktree`: `.worktree` or `['worktree']`. */
const isWorktreeKey = (property: t.Node, computed: boolean): boolean => (computed ? property.type === 'StringLiteral' && property.value === 'worktree' : property.type === 'Identifier' && property.name === 'worktree')

/** Every read of `worktree` in a source: its receiver's root name and its line. */
function worktreeReads(source: string, tsx: boolean): { receiver: string; line: number }[] {
  const ast = parse(source, { sourceType: 'module', plugins: tsx ? ['typescript', 'jsx'] : ['typescript'] })
  const out: { receiver: string; line: number }[] = []
  const member = (p: NodePath<t.MemberExpression | t.OptionalMemberExpression>): void => {
    if (isWorktreeKey(p.node.property, p.node.computed)) out.push({ receiver: rootName(p.node.object), line: p.node.loc?.start.line ?? 0 })
  }
  traverse(ast, {
    MemberExpression: member,
    OptionalMemberExpression: member,
    // `const { worktree } = a` (and `{ worktree: w } = a`): a read of a's.
    VariableDeclarator(p) {
      if (p.node.id.type !== 'ObjectPattern') return
      for (const prop of p.node.id.properties) {
        if (prop.type === 'ObjectProperty' && !prop.computed && prop.key.type === 'Identifier' && prop.key.name === 'worktree') out.push({ receiver: rootName(p.node.init), line: prop.loc?.start.line ?? 0 })
      }
    }
  })
  return out
}

/** The reads in a file that aren't allowed: "file:line: receiver.worktree". */
function unexpected(rel: string, source: string): string[] {
  const allowed = ALLOWED[rel] ?? {}
  return worktreeReads(source, rel.endsWith('.tsx'))
    .filter((r) => !(r.receiver in allowed))
    .map((r) => `${rel}:${r.line}: ${r.receiver}.worktree`)
}

describe("an agent's 0.9 worktree is read only through legacyWorktree (#1452)", () => {
  it('no read of `worktree` in src but the allowed ones, each of something other than an agent', () => {
    const found = sources().flatMap((rel) => unexpected(rel, readFileSync(join(ROOT, rel), 'utf8')))
    expect(found).toEqual([])
  })

  it('finds an agent read, so the gate can fail: in code, in template expressions, after regex literals, through casts', () => {
    const at = (source: string, tsx = false) => unexpected(tsx ? 'src/main/example.tsx' : 'src/main/example.ts', source)
    expect(at('const p = agent.worktree?.path\nconst q = def.worktree')).toEqual(['src/main/example.ts:1: agent.worktree', 'src/main/example.ts:2: def.worktree'])
    // Template expressions (round 1), nested and over several lines.
    expect(at('const p = `${agent.worktree.path}`')).toEqual(['src/main/example.ts:1: agent.worktree'])
    expect(at('log(`moved ${a.name}\nfrom ${`${x.worktree?.path}`} to ${{ p: def.worktree }.p}`)')).toEqual(['src/main/example.ts:2: x.worktree', 'src/main/example.ts:2: def.worktree'])
    // A regex holding a quote, then a read (HR2's round 2), and a character class of quotes.
    expect(at("const quote = /'/; const p = agent.worktree?.path")).toEqual(['src/main/example.ts:1: agent.worktree'])
    expect(at('const q = /["\'`]/.test(s) && def.worktree')).toEqual(['src/main/example.ts:1: def.worktree'])
    // Through a cast, an await and a call; an element read; a destructuring.
    expect(at("const p = (agent as StoredAgent).worktree\nconst q = (await load(id)).worktree\nconst r = a['worktree']\nconst { worktree } = def")).toEqual([
      'src/main/example.ts:1: agent.worktree',
      'src/main/example.ts:2: load.worktree',
      'src/main/example.ts:3: a.worktree',
      'src/main/example.ts:4: def.worktree'
    ])
    // In JSX too.
    expect(at('const v = <span title={agent.worktree?.path}>x</span>', true)).toEqual(['src/main/example.tsx:1: agent.worktree'])
  })

  it('text is not a read: message ids, comments, template text, JSX text, a regex', () => {
    const source = "msg({ id: 'panes.tab.worktree' }) // a.worktree in a comment\n/* b.worktree */ const t = `c.worktree \\` ${'d.worktree'}`\nconst r = /e\\.worktree/\nconst j = <p>f.worktree</p>"
    expect(unexpected('src/main/example.tsx', source)).toEqual([])
  })

  it('every allowed receiver is still read in its file (the list only shrinks)', () => {
    for (const [rel, receivers] of Object.entries(ALLOWED)) {
      const seen = new Set(worktreeReads(readFileSync(join(ROOT, rel), 'utf8'), rel.endsWith('.tsx')).map((r) => r.receiver))
      for (const r of Object.keys(receivers)) expect(seen.has(r), `${rel}: ${r}.worktree`).toBe(true)
    }
  })
})
