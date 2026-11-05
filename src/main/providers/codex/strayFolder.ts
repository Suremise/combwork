import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { fmt, msg, tr } from '../../../shared/i18n'
import { readFileSync, readdirSync, statSync } from 'original-fs'
import { parse as parseToml } from 'smol-toml'

/**
 * What a project's .codex folder holds for Codex itself: its project config, custom agents (`agents/*.toml`, OpenAI's
 * subagents docs), execution policy rules, and the folders Codex has read prompts and skills from. Lower case.
 */
const CODEX_OWN = new Set(['config.toml', 'agents', 'rules', 'prompts', 'skills'])

/** Keys whose values name files or folders (`model_instructions_file`, a skill's `path`, `cwd`…): only these are references. */
const PATH_KEY = /(^|_)(file|files|path|paths|dir|dirs|cwd)$/i

/** The strings a TOML document gives under a path key (nested tables and arrays too). */
function paths(v: unknown, key = '', out: string[] = []): string[] {
  if (typeof v === 'string') {
    if (PATH_KEY.test(key)) out.push(v)
  } else if (Array.isArray(v)) for (const x of v) paths(x, key, out)
  else if (v && typeof v === 'object' && !(v instanceof Date)) for (const [k, x] of Object.entries(v)) paths(x, k, out)
  return out
}

/**
 * What in .codex its TOML files name, as full paths relative to .codex (forward slashes, lower case): each resolved
 * against the naming file's folder and against .codex.
 */
function referenced(dir: string, tomls: string[]): string[] {
  const refs: string[] = []
  for (const file of tomls) {
    let doc: unknown
    try {
      doc = parseToml(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    for (const s of paths(doc)) {
      if (!s || s.length > 500 || /[\r\n]/.test(s)) continue
      for (const base of [dirname(file), dir]) {
        const rel = relative(dir, resolve(base, s))
        if (rel && !rel.startsWith('..') && !isAbsolute(rel)) refs.push(rel.split(sep).join('/').toLowerCase())
      }
    }
  }
  return refs
}

/** Whether an entry of .codex (`instructions`, `agents/x.md`) is a named file or holds one. */
const named = (refs: string[], entry: string): boolean => refs.some((r) => r === entry || r.startsWith(`${entry}/`))

/**
 * What is in a folder's `.codex` that isn't Codex's own configuration (#509): an agent's scratch, logs or probes. Codex
 * treats the folder as its own and protects it before every sandboxed command; on 10 Oct a probe a Codex reviewer wrote
 * there made that fail ("deny ACE failed on …\.codex"), and every Codex agent's shell in the project with it ("setup
 * refresh had errors"). Codex's configuration is `CODEX_OWN`, the agent definitions in `agents/`, and what its TOML
 * files name under a path key (a named file, or the folders holding it). Null when there is no such folder or it holds
 * only configuration.
 */
export function strayCodexEntries(folder: string): string[] | null {
  const dir = join(folder, '.codex')
  try {
    if (!statSync(dir).isDirectory()) return null
    const top = readdirSync(dir)
    const agentsDir = top.find((n) => n.toLowerCase() === 'agents')
    const agents = agentsDir && statSync(join(dir, agentsDir)).isDirectory() ? readdirSync(join(dir, agentsDir)) : []
    const tomls = [...top.filter((n) => n.toLowerCase() === 'config.toml').map((n) => join(dir, n)), ...agents.filter((n) => n.toLowerCase().endsWith('.toml')).map((n) => join(dir, agentsDir!, n))]
    const refs = referenced(dir, tomls)
    const stray = [
      ...top.filter((n) => !CODEX_OWN.has(n.toLowerCase()) && !named(refs, n.toLowerCase())),
      // In agents/: anything but an agent's TOML file or a file one names.
      ...agents.filter((n) => !n.toLowerCase().endsWith('.toml') && !named(refs, `agents/${n.toLowerCase()}`)).map((n) => `agents/${n}`)
    ]
    return stray.length ? stray : null
  } catch {
    return null
  }
}

/** The warning for a stray .codex folder in `folder`, or null. */
export function strayCodexWarning(folder: string): { title: string; message: string } | null {
  const stray = strayCodexEntries(folder)
  if (!stray) return null
  // The first few, and how many more as the list's last item ("a.log, b.log, c.log and 2 more").
  const more = stray.length - 3
  const files = more > 0 ? fmt.list([...stray.slice(0, 3), tr(msg({ id: 'providers.codex.stray.more', defaultMessage: '{n, plural, one {# more} other {# more}}', description: 'The last item of the files a stray .codex folder holds, in its warning (providers.codex.stray.message), after the first few: how many more files there are. Combwork joins it to the list ("a.log, b.log, c.log and 2 more").' }), { n: more })]) : fmt.list(stray, 'unit')
  return {
    title: tr(msg({ id: 'providers.codex.stray.title', defaultMessage: 'A .codex folder here can stop Codex running commands', description: "A warning when an agent starts in a folder with a .codex folder that isn't Codex's configuration. .codex is a folder's name." })),
    message: tr(msg({ id: 'providers.codex.stray.message', defaultMessage: '{folder} holds {files}, which isn\'t Codex configuration (config.toml, agents, rules) or a file it names. Codex treats the folder as its own, and stray files in it (an agent\'s scratch or logs) can make every Codex agent\'s commands fail ("setup refresh had errors"). Move those files out of it (scratch belongs outside the project); leave Codex\'s configuration where it is.', description: 'The warning about a stray .codex folder. {folder} is its path, {files} what it holds. config.toml, agents and rules are Codex\'s own names; "setup refresh had errors" is Codex\'s message, in English: keep them.' }), { folder: join(folder, '.codex'), files })
  }
}
