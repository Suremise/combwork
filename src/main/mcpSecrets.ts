import type { McpServerDef } from '../shared/types'
import { tr } from '../shared/i18n'
import { msg } from '../shared/i18n/msg'

/** Spotting literal secrets in MCP server definitions (they should be ${ENV} references). */

const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|credential|private[_-]?key|authorization)/i
const SECRET_VALUE = /^(sk-[A-Za-z0-9]|ghp_|gho_|github_pat_|xox[abp]-|AKIA[0-9A-Z]{12}|AIza[0-9A-Za-z_-]{20}|glpat-)/

function isEnvRef(v: string): boolean {
  const t = v.trim()
  return /^\$\{[^}]+\}$/.test(t) || /^\$[A-Z_][A-Z0-9_]*$/.test(t)
}

const M = {
  named: msg({ id: 'assistant.mcpSecret.named', defaultMessage: '{where, select, header {header} other {env}} "{key}" looks like a literal secret. Use an environment variable reference such as "{ref}".', description: "A warning on an MCP server's definition: an environment variable (env) or HTTP header of that name holds what looks like a password or token. Keep env and header as they are (the definition's fields); {ref} is the reference to use instead, such as ${GITHUB_TOKEN}." }),
  argument: msg({ id: 'assistant.mcpSecret.argument', defaultMessage: 'An argument starting "{start}…" looks like a literal secret.', description: "A warning on an MCP server's definition: one of its command's arguments looks like a password or token. {start} is its first characters." })
}

/** Flags values that look like literal secrets rather than ${ENV} references (window text: in Combwork's language). */
export function findSecretWarnings(def: McpServerDef): string[] {
  const warnings: string[] = []
  const check = (where: 'env' | 'header', key: string, raw: unknown): void => {
    if (typeof raw !== 'string') return
    const value = raw.replace(/^Bearer\s+/i, '').trim()
    if (!value || isEnvRef(value) || value.includes('${')) return
    // A file or folder that holds a secret (e.g. CW_API_TOKEN_FILE) isn't one itself.
    if (/_(FILE|PATH|DIR)$/i.test(key)) return
    if (SECRET_VALUE.test(value) || (SECRET_KEY.test(key) && value.length >= 8)) {
      const envName = key.toUpperCase().replace(/[^A-Z0-9]/g, '_')
      warnings.push(tr(M.named, { where, key, ref: `\${${envName}}` }))
    }
  }
  for (const [k, v] of Object.entries(def.env ?? {})) check('env', k, v)
  for (const [k, v] of Object.entries(def.headers ?? {})) check('header', k, v)
  for (const a of def.args ?? []) {
    if (typeof a === 'string' && SECRET_VALUE.test(a.trim())) warnings.push(tr(M.argument, { start: a.slice(0, 6) }))
  }
  return warnings
}
