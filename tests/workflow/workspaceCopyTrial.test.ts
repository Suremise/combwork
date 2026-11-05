// The 1.0 upgrade's migration of agents' worktrees into slots (#1441), tried on a copy of a real 0.9 workspace. Skipped
// unless CW_TRIAL_WS names one (never committed with a path in it). Its Combwork files are copied read-only into a
// tempDir() (the board through SQLite's backup, workspace.json and each project.json), each project with git is a scratch
// clone sharing the original's objects (read, never written), and each agent's worktree is made again as a worktree of
// it at the same layout and commit. The copy's board is upgraded and adopted as the upgrade does, its sessions' folders
// moved to the copy's, and the migration run twice; what it did is printed as counts and names only (no card or
// conversation text), into CW_TRIAL_REPORT (else report.txt in its temp folder). Nothing is written in the original,
// and no real profile is used.
//   CW_TRIAL_WS=<workspace> CW_TRIAL_REPORT=<file> npx vitest run tests/workflow/workspaceCopyTrial.test.ts
import { execFileSync } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { DatabaseSync, backup } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from '../tempDir'

const SRC = process.env.CW_TRIAL_WS ?? ''
const base = tempDir('wscopy-trial-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

/**
 * Every git the trial starts gets this environment, given explicitly: what Windows and git need to run, nothing of the
 * shell's (no GIT_DIR, GIT_WORK_TREE or NODE_OPTIONS), and no global or system config (as tests/noGlobalGit.ts).
 */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'].flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : []))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0'
}
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const under = (p: string, root: string): boolean => p.toLowerCase().startsWith(root.toLowerCase())
const report: string[] = []

describe.skipIf(!SRC)('the slots migration on a copy of a 0.9 workspace (#1441)', () => {
  it('copies it, upgrades the copy and migrates it, twice', { timeout: 600_000 }, async () => {
    const dst = join(base, basename(SRC))
    const at = (p: string): string => (under(p, SRC) ? dst + p.slice(SRC.length) : p)
    // The workspace's own files, read-only.
    mkdirSync(join(dst, '.combwork'), { recursive: true })
    copyFileSync(join(SRC, '.combwork', 'workspace.json'), join(dst, '.combwork', 'workspace.json'))
    const src = new DatabaseSync(join(SRC, '.combwork', 'hive.db'), { readOnly: true })
    try {
      await backup(src, join(dst, '.combwork', 'hive.db'))
    } finally {
      src.close()
    }
    // Each project: a scratch clone (objects shared with the original, read only), its project.json, its agents'
    // worktrees made again at the copy's layout, at the commit each is at now.
    const projects = readdirSync(SRC, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(SRC, d.name, '.combwork', 'project.json'))).map((d) => d.name)
    const made: Record<string, string[]> = {}
    for (const name of projects) {
      const from = join(SRC, name)
      const to = join(dst, name)
      if (existsSync(join(from, '.git'))) git(base, 'clone', '-q', '--shared', '--no-checkout', from, to)
      mkdirSync(join(to, '.combwork'), { recursive: true })
      const cfg = JSON.parse(readFileSync(join(from, '.combwork', 'project.json'), 'utf8')) as { agents?: { name: string; worktree?: { path: string; branch: string } }[] }
      for (const a of cfg.agents ?? []) {
        const w = a.worktree
        if (!w?.path) continue
        if (existsSync(w.path) && existsSync(join(to, '.git'))) {
          const head = git(w.path, 'rev-parse', 'HEAD')
          git(to, 'worktree', 'add', '-q', '--no-checkout', '-B', w.branch, at(w.path), head)
          ;(made[name] ??= []).push(a.name)
        }
        w.path = at(w.path)
      }
      writeFileSync(join(to, '.combwork', 'project.json'), JSON.stringify(cfg, null, 2))
    }
    report.push(`copied: ${projects.join(', ')}; worktrees made: ${JSON.stringify(made)}`)

    const { createWorkspaceService, disposeWorkspaceService, inWorkspace, workspace } = await import('../../src/main/workspace')
    const { upgradeBoard, upgradeWaiting, boardRead, boardWrite, boardWriteOp } = await import('../../src/main/boardStore')
    const { adoptWorkspace } = await import('../../src/main/workflow/adoption')
    const { migrateSlots, keptFor, startSlotMigration, stopSlotMigration } = await import('../../src/main/slotMigration')
    const { folderAgent, folderFacts } = await import('../../src/main/agentFolders')
    const { canResumeNow, legacyWorktree } = await import('../../src/shared/agentFolders')
    const ws = createWorkspaceService()
    startSlotMigration()
    try {
      await ws.open(dst)
      expect(under(ws.path!, base)).toBe(true)
      if (upgradeWaiting(dst)) await inWorkspace(ws, () => upgradeBoard(ws))
      await adoptWorkspace(ws)
      // The sessions' folders moved to the copy's (as Repair would after a move): both spellings Windows paths have.
      await boardWrite(ws, async () =>
        boardWriteOp(ws, (db) => {
          for (const from of [SRC, SRC.toLowerCase()]) db.prepare('UPDATE sessions SET cwd = ? || substr(cwd, ?) WHERE substr(cwd, 1, ?) = ?').run(dst, from.length + 1, from.length, from)
        })
      )
      await migrateSlots(ws)
      const first = boardRead(ws, (db) => db.prepare("SELECT id FROM slot_leases WHERE kind = 'carried' AND ended_at IS NULL ORDER BY id").all())
      await migrateSlots(ws)
      expect(boardRead(ws, (db) => db.prepare("SELECT id FROM slot_leases WHERE kind = 'carried' AND ended_at IS NULL ORDER BY id").all())).toEqual(first)

      for (const name of projects) {
        const p = join(dst, name)
        const cfg = await ws.projectConfig(p)
        const facts = await inWorkspace(ws, () => folderFacts(p))
        const records = (await inWorkspace(ws, () => workspace.sessionsFile(p))).sessions
        const rows = facts.slots.map((s) => {
          const agent = cfg.agents.find((a) => a.id === s.open?.agent)
          const kept = s.open ? keptFor(ws, s.open.id) : null
          const bound = records.filter((r) => r.lease && r.lease === s.open?.id)
          const resumes = agent ? bound.filter((r) => canResumeNow(facts, folderAgent(agent), r)).length : 0
          return `${s.name} (${agent?.name ?? '?'}, ${s.open?.kind ?? 'free'}, kept for ${kept ? ('lane' in kept ? 'a lane' : `#${kept.card}`) : 'nothing'}; ${bound.length} conversation(s) bound, ${resumes} resuming in place)`
        })
        report.push(`${name}: migrated ${facts.migrated}; ${facts.slots.length} slot(s)${rows.length ? `: ${rows.join('; ')}` : ''}; ${facts.homes.length} retired home(s); not migrated (worktree not there): ${cfg.agents.filter((a) => legacyWorktree(a) && !facts.migratedAgents.includes(a.id)).map((a) => a.name).join(', ') || 'none'}`)
        expect(facts.migrated).toBe(true)
        for (const s of facts.slots) expect(under(s.folder, base)).toBe(true)
      }
      report.push(`run twice: ${first.length} carried lease(s) both times`)
    } finally {
      stopSlotMigration()
      await disposeWorkspaceService(ws)
      writeFileSync(process.env.CW_TRIAL_REPORT || join(base, 'report.txt'), report.join('\n') + '\n')
    }
  })
})
