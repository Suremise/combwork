import { lstatSync } from 'original-fs'
import { delimiter, join } from 'path'
import { msg } from '../../../shared/i18n'
import type { ReadinessIssue } from '../../../shared/types'
import { installText } from '../common'

const M = {
  label: msg({ id: 'providers.codex.storePwsh.label', defaultMessage: 'PowerShell 7 from the Microsoft Store is installed', description: "Provider Setup and Settings → Providers (#585, #1404): the short label of the warning about the Microsoft Store's PowerShell 7 (a badge and the banner atop the window); the explanation follows under it." }),
  warning: msg({ id: 'providers.codex.storePwsh.warning', defaultMessage: "Codex agents' commands can fail while a PowerShell 7 from the Microsoft Store is open: Codex's Windows sandbox can't start that PowerShell while another copy of it runs.", description: "Provider Setup and Settings → Providers (#585): a warning that Codex's commands fail (Windows) while the Microsoft Store's PowerShell 7, the one found first, is running anywhere, e.g. in a terminal. Codex is the coding agent's name." }),
  symptom: msg({ id: 'providers.codex.storePwsh.symptom', defaultMessage: 'The symptom: a Codex command fails at once with `CreateProcessAsUserW failed: 5` (access denied), and works again once every PowerShell 7 window and command is closed.', description: "Provider Setup (#585), under the warning about the Microsoft Store's PowerShell 7: how the problem shows. `…` marks the error as Codex prints it: keep it as it is." }),
  fix: msg({ id: 'providers.codex.storePwsh.fix', defaultMessage: "To avoid it, replace the Store's PowerShell 7 with the installer's, in this order. First uninstall the Store one (Settings → Apps → Installed apps → PowerShell → Uninstall, or `Get-AppxPackage Microsoft.PowerShell | Remove-AppxPackage`): while it is there, winget takes it for the same app and installs nothing. Then install PowerShell 7 (`winget install --id Microsoft.PowerShell --source winget --installer-type wix`). Then restart Hive and its Codex agents: they keep their old PATH until they restart. Hive leaves your shell as it is.", description: "Provider Setup (#585, #1512), under the warning about the Microsoft Store's PowerShell 7: what to do, in an order that must stay (uninstall the Store copy first, then install, then restart). `…` marks a command to type: keep it as it is. Settings → Apps → Installed apps is Windows 11's settings page: use Windows' own names for it in your language." })
}

/**
 * Provider Setup's warning about the Store's PowerShell 7 (#585, Darren's decision: warn and name the symptom, never change the
 * shell): a short label (its badge, the window's banner), what goes wrong, the symptom and the fix under it (#1404).
 */
export function storePwshIssue(): ReadinessIssue {
  return { id: 'store-pwsh', level: 'warning', message: installText(M.label), detail: [installText(M.warning), installText(M.symptom), installText(M.fix)] }
}

/**
 * Whether the first PowerShell 7 (`pwsh.exe`) on `path` is the Microsoft Store's (#585): its app execution alias in
 * `%LOCALAPPDATA%\Microsoft\WindowsApps`, or the package's own folder (`…\WindowsApps\Microsoft.PowerShell_…`). Codex's
 * Windows sandbox can't start that one while any other process of the package runs on the machine (#499: Codex
 * 0.162.1, "CreateProcessAsUserW failed: 5"), so a Codex agent's commands fail whenever a pwsh is open. Windows only.
 */
export function storePwshFirst(path = process.env.PATH ?? '', localAppData = process.env.LOCALAPPDATA ?? '', platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false
  const alias = localAppData ? join(localAppData, 'Microsoft', 'WindowsApps').toLowerCase() : null
  for (const dir of path.split(delimiter).map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)) {
    let found = false
    try {
      // lstat: an app execution alias is a reparse point that stat (and existsSync) can't open (EACCES); lstat sees it.
      const s = lstatSync(join(dir, 'pwsh.exe'))
      found = s.isFile() || s.isSymbolicLink()
    } catch {
      // Not in this folder: the next one.
    }
    if (!found) continue
    const d = dir.replace(/[\\/]+$/, '').toLowerCase()
    return d === alias || /\\windowsapps\\microsoft\.powershell_/i.test(dir)
  }
  return false
}
