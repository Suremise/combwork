import { msg } from './i18n/msg'

/**
 * Settings → General → External terminal (HI-3582): what Open External Terminal Here opens on Windows. Automatic is
 * Windows Terminal, else Command Prompt; a named one that can't open says so rather than opening another.
 */
export type ExternalTerminalSetting = 'auto' | 'wt' | 'cmd' | 'powershell'

export const EXTERNAL_TERMINAL_SETTINGS: readonly ExternalTerminalSetting[] = ['auto', 'wt', 'cmd', 'powershell']

/** The setting as stored, or Automatic for anything else (an older or hand-edited config). */
export const externalTerminalSetting = (value: unknown): ExternalTerminalSetting => (EXTERNAL_TERMINAL_SETTINGS.includes(value as ExternalTerminalSetting) ? (value as ExternalTerminalSetting) : 'auto')

/** Each terminal's name, in the setting's choices and in what the window says when one can't open. */
export const EXTERNAL_TERMINAL_NAME = {
  wt: msg({ id: 'settings.general.externalTerminal.option.wt', defaultMessage: 'Windows Terminal', description: 'A choice of the setting "External terminal" (Settings → General), and the name of that terminal where Combwork says it couldn\'t open. Windows Terminal is the name of a Microsoft app: use the name Windows gives it in this language.' }),
  cmd: msg({ id: 'settings.general.externalTerminal.option.cmd', defaultMessage: 'Command Prompt', description: 'A choice of the setting "External terminal" (Settings → General), and the name of that terminal where Combwork says it couldn\'t open. Command Prompt is the name of a Windows program (cmd.exe): use the name Windows gives it in this language.' }),
  powershell: msg({ id: 'settings.general.externalTerminal.option.powershell', defaultMessage: 'PowerShell', description: 'A choice of the setting "External terminal" (Settings → General), and the name of that terminal where Combwork says it couldn\'t open. PowerShell is a name: keep it.' })
}

export const EXTERNAL_TERMINAL_AUTO = msg({ id: 'settings.general.externalTerminal.option.auto', defaultMessage: 'Automatic (Windows Terminal, else Command Prompt)', description: 'A choice of the setting "External terminal" (Settings → General): Windows Terminal when it opens, else Command Prompt. Use the names Windows gives them in this language.' })
