// HI-2781's Git dependency inventory, rerun, with HI-2792's classification (SPEC §16.3.6's audit). The spike's patterns
// unchanged, over the tracked TypeScript under src/: its counts, then each Git-family import outside Git's implementation
// with its class from tests/gitAudit.mjs, then the text hits (refs, worktrees, branches, merges, trailers, platform
// switches) outside Git's implementation, grouped by area for the shared, UI and agent text audit.
//
//   node scripts/gitInventory.mjs           the summary and the classified edges
//   node scripts/gitInventory.mjs --text    the text hits too, by file (long)
//   node scripts/gitInventory.mjs --json    everything as JSON

import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { audit, EDGES, isGitModule, SEAMS } from '../tests/gitAudit.mjs'

const root = process.cwd()
const files = execFileSync('git', ['ls-files', 'src'], { cwd: root, encoding: 'utf8' })
  .split(/\r?\n/)
  .filter((p) => /\.(ts|tsx|cjs|mjs)$/.test(p))
const src = Object.fromEntries(files.map((p) => [p, readFileSync(join(root, p), 'utf8')]))

// HI-2781's patterns, as its inventory.py had them.
const PATTERNS = {
  directGitImport: /(?:from\s*|import\s*\()['"][^'"]*\/(?:git|gitTool|gitWorker|gitCompare|gitRepo|gitInit|platform\/git|platform\/gitPlatform)['"]/,
  gitExecution: /\b(?:git|gitTree|gitReading|gitRouted|withGitRoute|withoutGitRoute)\s*\(|['"]git['"]/,
  worktree: /worktree/i,
  refsAndReflog: /refs\/|reflog|packed-refs|update-ref|symbolic-ref/,
  branchesAndHead: /\bbranch(?:es)?\b|\bHEAD\b|merge-base|rev-parse|rev-list/,
  mergeAndRebase: /merge-tree|commit-tree|read-tree|--squash|--no-ff|--rebase-merges|rebase/,
  trailersAndAttribution: /Hive-Card|Combwork-Card|interpret-trailers|trailer|patch-id/,
  platformSwitch: /platform\s*===?\s*['"]git|platform\s*!==?\s*['"]git|PlatformId|gitFound|otherFound/
}

const hits = {}
for (const [kind, re] of Object.entries(PATTERNS)) {
  hits[kind] = {}
  for (const [p, t] of Object.entries(src)) {
    const ls = t.split(/\r?\n/).flatMap((l, i) => (re.test(l) ? [[i + 1, l.trim()]] : []))
    if (ls.length) hits[kind][p] = ls
  }
}

const mod = (p) => p.replace(/\.(tsx?|cjs|mjs)$/, '')
const counts = {
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  platformLines: Object.entries(src).filter(([p]) => p.startsWith('src/main/platform/')).reduce((n, [, t]) => n + t.split(/\r?\n/).length, 0),
  workflowLines: Object.entries(src).filter(([p]) => p.startsWith('src/main/workflow/')).reduce((n, [, t]) => n + t.split(/\r?\n/).length, 0),
  filesPerPattern: Object.fromEntries(Object.entries(hits).map(([k, v]) => [k, Object.keys(v).length])),
  directMainOutsidePlatform: Object.keys(hits.directGitImport).filter((p) => p.startsWith('src/main/') && !p.startsWith('src/main/platform/')).length
}

/** The area a file's hits belong to, for the text audit: Git's own implementation, or the common file's area. */
const area = (p) =>
  isGitModule(mod(p)) ? 'git implementation' : p.startsWith('src/renderer/') ? 'ui' : p.startsWith('src/shared/') ? 'shared' : p.startsWith('src/main/platform/') ? 'platform contract and registries' : p.startsWith('src/main/workflow/') ? 'workflow' : 'main'

const a = audit(root)
const byClass = {}
for (const e of EDGES) (byClass[e.class] ??= []).push(e)

const text = {}
for (const [kind, fs] of Object.entries(hits)) {
  if (kind === 'directGitImport') continue
  for (const [p, ls] of Object.entries(fs)) {
    const ar = area(p)
    if (ar === 'git implementation') continue
    ;((text[ar] ??= {})[kind] ??= {})[p] = ls.length
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ counts, audit: { unlisted: a.unlisted, stale: a.stale, extraNames: a.extraNames, seams: a.seams }, edges: EDGES, seams: SEAMS, text }, null, 2))
} else {
  console.log('# Git dependency inventory (HI-2781, rerun for HI-2792)\n')
  console.log(JSON.stringify(counts, null, 2))
  console.log(`\n## The audit: ${EDGES.length} classified edges, ${Object.keys(SEAMS).length} files with seams`)
  const bad = [...a.unlisted.map((x) => `unlisted: ${x}`), ...a.stale.map((x) => `stale: ${x}`), ...a.extraNames.map((x) => `name: ${x}`), ...a.seams.map((x) => `seam: ${x}`)]
  console.log(bad.length ? bad.join('\n') : 'every edge and seam classified')
  for (const [c, es] of Object.entries(byClass)) {
    console.log(`\n### ${c} (${es.length})`)
    for (const e of es) console.log(`- ${e.file} → ${e.module}${e.op ? ` [${e.op}]` : ''}${e.card ? ` [${e.card}]` : ''}: ${e.why}`)
  }
  console.log('\n### seams ("the platform with lines": Git alone in 1.4.0; J0 routes each)')
  for (const [f, s] of Object.entries(SEAMS)) console.log(`- ${f}: ${Object.entries(s.calls).map(([k, n]) => `${k}() ×${n}`).join(', ')}: ${s.why}`)
  console.log('\n## Text hits outside Git\'s implementation, by area (files per pattern)')
  for (const [ar, ks] of Object.entries(text)) console.log(`- ${ar}: ${Object.entries(ks).map(([k, fs]) => `${k} ${Object.keys(fs).length}`).join(', ')}`)
  if (process.argv.includes('--text')) {
    for (const [ar, ks] of Object.entries(text)) {
      console.log(`\n### ${ar}`)
      for (const [k, fs] of Object.entries(ks)) console.log(`- ${k}: ${Object.entries(fs).map(([p, n]) => `${p} (${n})`).join(', ')}`)
    }
  }
  if (bad.length) process.exitCode = 1
}
