import { msg } from '../../../shared/i18n'
import type { Tr } from '../../../shared/tasks'
import type { DialectRow } from '../../../shared/dialects'

// The tooltip on a dialect file's on/off switch (HI-2524): what its texts fall back to when it is off, named for its
// row. A model file or test copy falls back to its folder's CLI file, a CLI's (or the API's) file to the Workspace file,
// and the Workspace file to Combwork's Default (the chain: src/main/dialects/chain.ts).

const ON_TIP = msg({ id: 'dialects.onTip', defaultMessage: "On: its texts apply. Off: {to, select, cli {it falls back to the {name} file} workspace {it falls back to the Workspace file} other {it falls back to Combwork's Default}}. Changes apply at each agent's next launch.", description: "Tooltip on a dialect file's on/off switch in the Dialects view: what its texts fall back to when it is off. Select keys (keep them): cli, a model file or test copy, which falls back to its CLI's file ({name}: \"Claude Code\", \"Codex\"); workspace, a CLI's or the API's file, which falls back to the Workspace file; other, the Workspace file, which falls back to Combwork's own wording. Glossary: dialect, Default (dialects)." })

/** The on/off switch's tooltip for a file's row; `folderName` is a folder's shown name ("Claude Code"). */
export function dialectOnTip(row: Pick<DialectRow, 'kind' | 'folder'>, folderName: (folder: string) => string, tr: Tr): string {
  if (row.kind === 'model' || row.kind === 'copy') return tr(ON_TIP, { to: 'cli', name: folderName(row.folder ?? '') })
  if (row.kind === 'cli' || row.kind === 'api') return tr(ON_TIP, { to: 'workspace', name: '' })
  return tr(ON_TIP, { to: 'default', name: '' })
}
