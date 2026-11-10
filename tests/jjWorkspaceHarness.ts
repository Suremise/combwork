// The real-jj harness for jj's workspace port (HI-2795's J2): the pinned portable jj (npm run jj:fetch), jj's and git's
// config isolated, repositories in tempDir() only, an in-memory journal per key, and a test Recycle Bin (a folder the
// trashed items are moved into). Used by tests/jjWorkspaces.test.ts and tests/jjRecovery.test.ts.
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { mkdirSync, realpathSync, renameSync, writeFileSync } from 'fs'
import { basename, join, resolve } from 'path'
import { TESTED_JJ } from '../src/shared/jjTool'
import { createJjRunner, type JjRunner } from '../src/main/platform/jjRunner'
import { createJjWorkspacePort, type JjPortDeps, type JjWorkspacePort } from '../src/main/platform/jjWorkspacePort'
import type { WorkspaceJournal } from '../src/main/platform/workspacePort'
import { tempDir } from './tempDir'

const require = createRequire(import.meta.url)
const { portableJj } = require('./jjPortable.cjs') as { portableJj: () => string | null }
const { gitEnv } = require('./e2e/runContext.cjs') as { gitEnv: (vars?: Record<string, string>) => NodeJS.ProcessEnv }

export const jjExe = portableJj()
if (!jjExe && process.env.CW_JJ_REAL === '1') throw new Error(`CW_JJ_REAL=1 but jj ${TESTED_JJ.version} isn't fetched: run npm run jj:fetch`)

/** jj's home and config: a dummy identity, nothing of the user's. */
export function isolatedEnv(): NodeJS.ProcessEnv {
  const home = tempDir('jj-home-')
  const config = join(home, 'jj.toml')
  writeFileSync(config, '[user]\nname = "Combwork Test"\nemail = "test@example.invalid"\n[ui]\npaginate = "never"\n')
  return gitEnv({ HOME: home, USERPROFILE: home, APPDATA: home, JJ_CONFIG: config, NO_COLOR: '1' })
}

export const real = (p: string): string => resolve(realpathSync.native(p))

/** A map of journals by key, as board_meta keeps them. */
export class Journals {
  readonly rows = new Map<string, unknown>()
  of(key: string): WorkspaceJournal {
    return {
      read: () => (this.rows.has(key) ? structuredClone(this.rows.get(key)) : null),
      write: async (v) => void this.rows.set(key, structuredClone(v)),
      clear: async () => void this.rows.delete(key)
    }
  }
}

export interface Harness {
  env: NodeJS.ProcessEnv
  runner: JjRunner
  port: JjWorkspacePort
  journals: Journals
  trashed: string[]
  trashDir: string
  /** The plain jj, in a folder (writes, as an agent's would). */
  jj: (cwd: string, ...args: string[]) => string
  git: (cwd: string, ...args: string[]) => string
  /** A new jj repository with one commit `base` (base.txt, and a .gitignore ignoring node_modules/), and where its slots go. */
  repo: (name: string, colocated: boolean) => { repo: string; root: string; base: string }
  /** The commit id of a revset, read without a snapshot. */
  id: (cwd: string, rev: string) => string
  /** A port with other deps (a fresh process, as after a restart, shares the journals and the trash). */
  portWith: (more?: Partial<JjPortDeps>) => JjWorkspacePort
}

export function harness(o: { busy?: string } = {}): Harness {
  const env = isolatedEnv()
  const runner = createJjRunner({ exe: jjExe!, env })
  const journals = new Journals()
  const trashed: string[] = []
  const trashDir = tempDir('jj-trash-')
  let n = 0
  const deps = (more: Partial<JjPortDeps> = {}): JjPortDeps => ({
    runner,
    control: (repo) => ({ folder: join(resolve(repo, '..'), 'slots', '.cw-jj-control'), journal: journals.of(`jj_control:${repo.toLowerCase()}`) }),
    projectHold: () => (o.busy ? { busy: o.busy } : { release: () => undefined }),
    lock: (_store, fn) => fn(),
    trash: async (p) => {
      const to = join(trashDir, `${++n}-${basename(p)}`)
      renameSync(p, to)
      trashed.push(p)
    },
    ...more
  })
  const jj = (cwd: string, ...args: string[]): string => execFileSync(jjExe!, args, { cwd, env, windowsHide: true, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, windowsHide: true, encoding: 'utf8', timeout: 60_000 })
  const id = (cwd: string, rev: string): string => jj(cwd, '--ignore-working-copy', 'log', '--no-graph', '-r', rev, '-T', 'commit_id').trim()
  return {
    env,
    runner,
    port: createJjWorkspacePort(deps()),
    portWith: (more) => createJjWorkspacePort(deps(more)),
    journals,
    trashed,
    trashDir,
    jj,
    git,
    id,
    repo: (name, colocated) => {
      const top = tempDir(`jjw-${name}-`)
      const d = join(top, 'project')
      mkdirSync(d)
      mkdirSync(join(top, 'slots'))
      jj(d, 'git', 'init', colocated ? '--colocate' : '--no-colocate')
      writeFileSync(join(d, 'base.txt'), 'base\n')
      writeFileSync(join(d, '.gitignore'), 'node_modules/\n')
      jj(d, 'commit', '-m', 'base')
      jj(d, 'bookmark', 'create', 'main', '-r', '@-')
      return { repo: real(d), root: real(join(top, 'slots')), base: id(d, '@-') }
    }
  }
}
