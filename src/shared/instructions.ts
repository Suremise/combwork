// One instructions file for every provider in a project: AGENTS.md, which Codex (and most other CLIs) read
// themselves, imported into the files of CLIs that don't (Claude Code: an "@AGENTS.md" line in CLAUDE.md).

import { agentMsg, say } from './agentText'
import type { ProviderDescriptor } from './providers'

export const SHARED_INSTRUCTIONS = 'AGENTS.md'

const STARTER = agentMsg({ id: 'contract.instructions.starter', text: 'Instructions for every agent in this project.', note: "A new AGENTS.md's first line under the project's name, when Combwork makes the CLIs share one and none had any." })

export interface InstructionsFile {
  provider: string
  file: string
  /** The file's content, or null when it doesn't exist. */
  content: string | null
  /** The line that includes AGENTS.md; null when the CLI reads AGENTS.md itself. */
  importLine: string | null
}

export function instructionFiles(providers: ProviderDescriptor[], read: (file: string) => string | null): InstructionsFile[] {
  return providers.map((p) => ({
    provider: p.id,
    file: p.instructionsFile,
    content: read(p.instructionsFile),
    importLine: p.instructionsFile === SHARED_INSTRUCTIONS ? null : (p.instructionsImport ?? null)
  }))
}

export function importsShared(content: string, importLine: string): boolean {
  return content.split(/\r?\n/).some((l) => l.trim() === importLine)
}

/** Whether every provider reads the shared file (itself or through an import). Providers that can't import it are ignored. */
export function instructionsShared(files: InstructionsFile[]): boolean {
  return files.every((f) => !f.importLine || (f.content !== null && importsShared(f.content, f.importLine)))
}

/**
 * The writes that make the providers share AGENTS.md. With no AGENTS.md yet, the first existing provider file
 * moves into it (that file keeps only the import), so nothing already written is lost. Other provider files keep
 * their content below the import, for instructions that only apply to that CLI.
 */
export function shareInstructions(files: InstructionsFile[], shared: string | null, projectName: string): Record<string, string> {
  const writes: Record<string, string> = {}
  let agents = shared
  const importers = files.filter((f) => f.importLine)
  if (agents === null) {
    const source = importers.find((f) => f.content?.trim())
    agents = source?.content ?? `# ${projectName}\n\n${say(STARTER)}\n`
    writes[SHARED_INSTRUCTIONS] = agents
    if (source) {
      writes[source.file] = `${source.importLine}\n`
      source.content = writes[source.file]
    }
  }
  for (const f of importers) {
    if (f.content !== null && importsShared(f.content, f.importLine!)) continue
    writes[f.file] = f.content?.trim() ? `${f.importLine}\n\n${f.content}` : `${f.importLine}\n`
  }
  return writes
}
