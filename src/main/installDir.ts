import { spawnSync } from 'child_process'
import { existsSync, readFileSync, rmSync } from 'original-fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { app, dialog } from 'electron'
import { createLogger, userText } from './logger'
import { exitBy } from './exitLog'
import { testNotifyLog, testQuiet } from './testQuiet'
import { config } from './config'
import { language, msg, setLanguage, tr, type Catalogue } from '../shared/i18n'
import { languageOf, resolveLanguage, type LanguageSetting } from '../shared/i18n/languages'

const log = createLogger('installDir')

/** ALL APPLICATION PACKAGES: every AppContainer, Electron's sandboxed processes among them. */
const ALL_APP_PACKAGES = 'S-1-15-2-1'
/** Read access to a folder, inherited by what it holds. */
const FOLDER_GRANT = `*${ALL_APP_PACKAGES}:(OI)(CI)(RX)`
/** Read access to one file. */
const FILE_GRANT = `*${ALL_APP_PACKAGES}:(RX)`
/** The file Electron checks its sandbox can read (install_dir_access.cc): ICU's data, beside the executable. */
const CHECKED_FILE = 'icudtl.dat'

/** A PowerShell literal: its single quotes (PowerShell's typographic ones too) doubled, so nothing in it is expanded. */
function psQuote(s: string): string {
  return `'${s.replace(/['\u2018\u2019\u201a\u201b]/g, (q) => q + q)}'`
}

/**
 * The PowerShell command that gives ALL APPLICATION PACKAGES read access to a folder and what it holds, and to a file
 * in it that doesn't inherit that from the folder, if given.
 */
export function grantCommand(dir: string, file?: string): string {
  const folder = `icacls ${psQuote(dir)} /grant ${psQuote(FOLDER_GRANT)}` // i18n-ignore: a command, not text
  return file ? `${folder}; icacls ${psQuote(file)} /grant ${psQuote(FILE_GRANT)}` : folder // i18n-ignore: a command, not text
}

/** The SIDs of an SDDL's DACL entries (aliases such as AC as they are), upper case. */
export function daclSids(sddl: string): string[] {
  const start = sddl.indexOf('D:')
  if (start < 0) return []
  const sids: string[] = []
  let depth = 0
  let ace = ''
  for (let i = start + 2; i < sddl.length; i++) {
    const ch = sddl[i]
    // The DACL's flags come before its first entry; another part (S: for the SACL) ends it.
    if (depth === 0 && ch !== '(') {
      if (/[A-Z]/i.test(ch) && sddl[i + 1] === ':') break
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (depth === 0) {
      // A conditional entry's condition, in brackets of its own, comes after the SID.
      sids.push((ace.slice(1).split(';')[5] ?? '').toUpperCase())
      ace = ''
    } else ace += ch
  }
  return sids
}

/**
 * Whether a folder's DACL (as SDDL) has an entry for an AppContainer package but none for ALL APPLICATION PACKAGES.
 * Windows then denies Electron's sandboxed processes access to it, and Electron refuses to start from such a folder.
 */
export function lacksAllAppPackages(sddl: string): boolean {
  const sids = daclSids(sddl)
  const hasPackage = sids.some((s) => /^S-1-15-2(-\d+){2,}$/.test(s))
  return hasPackage && !sids.some((s) => s === 'AC' || s === ALL_APP_PACKAGES)
}

function system32(...parts: string[]): string {
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', ...parts)
}

/** A file's or folder's DACL as SDDL, or null if it can't be read. */
function readSddl(target: string): string | null {
  const out = join(tmpdir(), `hive-acl-${process.pid}-${Date.now()}.txt`)
  try {
    const r = spawnSync(system32('icacls.exe'), [target, '/save', out], { windowsHide: true, timeout: 10_000 })
    if (r.status !== 0) return null
    // icacls /save writes UTF-16: the name, then its SDDL.
    return readFileSync(out, 'utf16le').replace(/^\uFEFF/, '').split(/\r?\n/)[1] ?? null
  } catch {
    return null
  } finally {
    try {
      rmSync(out, { force: true })
    } catch {
      // A file left in the temp folder mustn't stop Hive starting.
    }
  }
}

const DIALOG_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
# A test's picture of it is drawn off screen from a form that never takes the focus.
if ($env:CW_DIALOG_SNAPSHOT) {
  Add-Type -WarningAction SilentlyContinue -ReferencedAssemblies System.Windows.Forms -TypeDefinition 'public class QuietForm : System.Windows.Forms.Form { protected override bool ShowWithoutActivation { get { return true; } } }'
  $f = New-Object QuietForm
} else { $f = New-Object System.Windows.Forms.Form }
$f.Text = $env:CW_DIALOG_TITLE
try { $f.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:CW_DIALOG_ICON) } catch { }
$f.Font = New-Object System.Drawing.Font($(if ($env:CW_DIALOG_FONT) { $env:CW_DIALOG_FONT } else { 'Segoe UI' }), 9)
$f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false
$f.StartPosition = 'CenterScreen'; $f.TopMost = $true
$f.AutoSize = $true; $f.AutoSizeMode = 'GrowAndShrink'
$t = New-Object System.Windows.Forms.TableLayoutPanel
$t.AutoSize = $true; $t.ColumnCount = 1; $t.Padding = New-Object System.Windows.Forms.Padding(12)
$l = New-Object System.Windows.Forms.Label
$l.Text = $env:CW_DIALOG_TEXT; $l.UseMnemonic = $false; $l.AutoSize = $true
$l.MaximumSize = New-Object System.Drawing.Size(560, 0); $l.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 10)
$c = New-Object System.Windows.Forms.TextBox
$c.Text = $env:CW_DIALOG_COMMAND; $c.ReadOnly = $true; $c.Width = 560; $c.Multiline = $true; $c.WordWrap = $true
$c.Font = New-Object System.Drawing.Font('Consolas', 9)
# As many lines as the command wraps to, so all of it shows.
$null = $c.Handle
$c.Height = ($c.GetLineFromCharIndex($c.TextLength) + 1) * $c.Font.Height + 8
$b = New-Object System.Windows.Forms.FlowLayoutPanel
$b.FlowDirection = 'RightToLeft'; $b.AutoSize = $true; $b.Dock = 'Fill'; $b.Margin = New-Object System.Windows.Forms.Padding(0, 12, 0, 0)
$close = New-Object System.Windows.Forms.Button
$close.Text = $env:CW_DIALOG_CLOSE; $close.AutoSize = $true; $close.DialogResult = 'Cancel'
$copy = New-Object System.Windows.Forms.Button
$copy.Text = $env:CW_DIALOG_COPY; $copy.AutoSize = $true
$copy.add_Click({ [System.Windows.Forms.Clipboard]::SetText($c.Text); $copy.Text = $env:CW_DIALOG_COPIED })
$b.Controls.AddRange(@($close, $copy))
$t.Controls.AddRange(@($l, $c, $b))
$f.Controls.Add($t)
$f.AcceptButton = $copy; $f.CancelButton = $close
$f.add_Shown({ $copy.Focus() })
if ($env:CW_DIALOG_SNAPSHOT) {
  $f.StartPosition = 'Manual'; $f.Location = New-Object System.Drawing.Point(-32000, -32000); $f.TopMost = $false; $f.ShowInTaskbar = $false
  $f.Show(); [System.Windows.Forms.Application]::DoEvents()
  $bmp = New-Object System.Drawing.Bitmap($f.Width, $f.Height)
  $f.DrawToBitmap($bmp, (New-Object System.Drawing.Rectangle(0, 0, $f.Width, $f.Height)))
  $bmp.Save($env:CW_DIALOG_SNAPSHOT)
  exit 0
}
[void]$f.ShowDialog()
`

/**
 * What Hive tells the user when it can't start from its folder: about the folder, or about the file in it that Electron
 * checks, when that is what still lacks the entry (a file that doesn't inherit the folder's permissions).
 */
export function cantStartMessage(dir: string, file?: string): { title: string; text: string; command: string; buttons: { copy: string; copied: string; close: string } } {
  // Each paragraph a message (a message keeps no line break): what Windows won't let it read, the path, why and what to run.
  const what = file
    ? tr(msg({ id: 'main.installDir.whatFile', defaultMessage: "Windows won't let Combwork's windows read a file in the folder Combwork is installed in:", description: "The message when Combwork can't start from its install folder, its first line (the file's path follows on the next)." }))
    : tr(msg({ id: 'main.installDir.whatFolder', defaultMessage: "Windows won't let Combwork's windows read the folder Combwork is installed in:", description: "The message when Combwork can't start from its install folder, its first line (the folder's path follows on the next)." }))
  const why = file
    ? tr(msg({ id: 'main.installDir.whyFile', defaultMessage: "Its permissions have an entry for an app package but none for ALL APPLICATION PACKAGES, which Combwork's sandboxed windows need, and Combwork couldn't add one. Run this command in PowerShell (as an administrator if you don't own them): it adds the entry to the folder and to the file. Then start Combwork again:", description: "The message when Combwork can't start from its install folder, its last paragraph (a command follows). ALL APPLICATION PACKAGES is a Windows name and PowerShell a program: keep them." }))
    : tr(msg({ id: 'main.installDir.whyFolder', defaultMessage: "Its permissions have an entry for an app package but none for ALL APPLICATION PACKAGES, which Combwork's sandboxed windows need, and Combwork couldn't add one. Run this command in PowerShell (as an administrator if you don't own the folder), then start Combwork again:", description: "The message when Combwork can't start from its install folder, its last paragraph (a command follows). ALL APPLICATION PACKAGES is a Windows name and PowerShell a program: keep them." }))
  return {
    title: tr(msg({ id: 'main.installDir.title', defaultMessage: "Combwork can't start", description: "The title of the message when Combwork can't start from its install folder." })),
    text: `${what}\n${file ?? dir}\n\n${why}`,
    command: grantCommand(dir, file),
    buttons: {
      copy: tr(msg({ id: 'main.installDir.copyCommand', defaultMessage: 'Copy Command', description: "A button of the message window when Combwork can't start from its install folder: copies the command to run." })),
      copied: tr(msg({ id: 'main.installDir.copied', defaultMessage: 'Copied', description: "A button of the message window when Combwork can't start from its install folder: what Copy Command says once it has copied the command." })),
      close: tr(msg({ id: 'main.installDir.close', defaultMessage: 'Close', description: "A button of the message window when Combwork can't start from its install folder: closes it (Combwork then quits)." }))
    }
  }
}

/** How the message reaches the user: Windows' tools in Hive, stand-ins in tests. */
export interface MessageTools {
  quiet: boolean
  /** The PowerShell window: whether it showed (or, given a picture to draw, drew it). */
  window(message: ReturnType<typeof cantStartMessage>, snapshot?: string): boolean
  /** Electron's error box, which, unlike its other dialogs, works before Electron is ready. */
  errorBox(title: string, content: string): void
  record(title: string, body: string): void
}

/** Shows the Windows Forms window in PowerShell and waits for it to close. */
function powershellWindow(message: ReturnType<typeof cantStartMessage>, snapshot?: string): boolean {
  const r = spawnSync(system32('WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Sta', '-EncodedCommand', Buffer.from(DIALOG_SCRIPT, 'utf16le').toString('base64')], {
    windowsHide: true,
    env: { ...process.env, CW_DIALOG_TITLE: message.title, CW_DIALOG_TEXT: message.text, CW_DIALOG_COMMAND: message.command, CW_DIALOG_COPY: message.buttons.copy, CW_DIALOG_COPIED: message.buttons.copied, CW_DIALOG_CLOSE: message.buttons.close, CW_DIALOG_ICON: process.execPath, CW_DIALOG_FONT: languageOf(language())?.uiFont ?? '', CW_DIALOG_SNAPSHOT: snapshot ?? '' }
  })
  if (r.status === 0) return true
  log.error(`Couldn't show the message window (PowerShell exited with ${r.status ?? r.error?.message})`)
  return false
}

const windowsMessages = (): MessageTools => ({
  quiet: testQuiet(),
  window: powershellWindow,
  errorBox: (title, content) => dialog.showErrorBox(title, content),
  record: (title, body) => testNotifyLog({ kind: 'dialog', title, body })
})

/**
 * Tells the user Hive can't start, with the command that fixes it: a window with a Copy Command button, or if that
 * can't be shown (PowerShell missing or locked down), Electron's error box (Ctrl+C copies its text). Electron's other
 * dialogs only work once it is ready, which is too late. A quiet test copy only records it, and draws the window to
 * CW_TEST_DIALOG_SNAPSHOT, if set, without showing it.
 */
export function tellCantStart(dir: string, file?: string, tools: MessageTools = windowsMessages()): void {
  const message = cantStartMessage(dir, file)
  tools.record(message.title, `${message.text}\n${message.command}`)
  if (tools.quiet) {
    const snapshot = process.env.CW_TEST_DIALOG_SNAPSHOT
    if (snapshot) tools.window(message, snapshot)
    return
  }
  if (tools.window(message)) return
  try {
    tools.errorBox(message.title, `${message.text}\n\n${message.command}\n\n${tr(msg({ id: 'main.installDir.copy', defaultMessage: '(Ctrl+C copies this message.)', description: "The last line of Electron's error box when Combwork can't start from its install folder. Ctrl+C is a key: keep it." }))}`)
  } catch (e) {
    log.error("Couldn't show the error box either", e)
  }
}

/** What checkInstallDir works with: Windows' tools in Hive, stand-ins in tests. */
export interface InstallDirTools {
  /** A file's or folder's DACL as SDDL, or null if it can't be read. */
  read(path: string): string | null
  exists(path: string): boolean
  /** Adds an ALL APPLICATION PACKAGES entry (FOLDER_GRANT or FILE_GRANT): icacls's exit code, null if it didn't finish. */
  grant(path: string, entry: string): number | null
  /** Tells the user Hive can't start: about the folder, or the file in it that still lacks the entry. */
  tell(dir: string, file?: string): void
  exit(code: number): void
}

/**
 * The main area's translations, in the bundle (#796): the install folder's message shows before Hive is ready, when it
 * hasn't loaded any (they load, a file at a time, once it is).
 */
const MAIN_TEXT = import.meta.glob<Catalogue>(['../../locales/*/main.json', '!../../locales/en/main.json'], { eager: true, import: 'default' })

/**
 * The language Hive would start in, before it has chosen it (chooseStartLanguage) or loaded its translations: --lang
 * (CW_LANG in an unpackaged build), else the setting in config.json, else Windows' display languages.
 */
export function setLanguageBeforeReady(): void {
  const forced = app.commandLine.getSwitchValue('lang') || (!app.isPackaged && process.env.CW_LANG) || null
  const codeOf = (path: string): string => path.split('/').at(-2) ?? ''
  const available = Object.keys(MAIN_TEXT).map(codeOf)
  const chosen = resolveLanguage(config.savedLanguage() as LanguageSetting | undefined, app.getPreferredSystemLanguages(), available, forced)
  setLanguage(chosen.code, Object.entries(MAIN_TEXT).find(([p]) => codeOf(p) === chosen.code)?.[1] ?? {}, chosen.locale)
}

const windowsTools: InstallDirTools = {
  read: readSddl,
  exists: existsSync,
  grant: (path, entry) => spawnSync(system32('icacls.exe'), [path, '/grant', entry], { windowsHide: true, timeout: 120_000 }).status,
  tell: (dir, file) => {
    setLanguageBeforeReady()
    tellCantStart(dir, file)
  },
  exit: (code) => exitBy('process.exit', "Combwork can't start from its install folder", () => process.exit(code))
}

/**
 * The folder Hive runs from, and whether Hive may change its permissions: only its own installed folder. A development
 * or test copy runs from node_modules' Electron, which it never changes; CW_TEST_INSTALL_DIR gives it a test folder
 * of its own to check and change instead (unpackaged builds only).
 */
export function installDirTarget(): { dir: string; mayChange: boolean } {
  const test = !app.isPackaged ? process.env.CW_TEST_INSTALL_DIR : undefined
  if (test) return { dir: test, mayChange: true }
  return { dir: dirname(process.execPath), mayChange: app.isPackaged }
}

/**
 * Electron refuses to start (a deliberate crash, with nothing on screen) when its sandbox can't read the folder Hive
 * runs from: when the folder's permissions have an entry for an AppContainer package but none for ALL APPLICATION
 * PACKAGES. It checks after the main script's first synchronous run, so this runs there (on Windows), first. It reads
 * the permissions of the file Electron checks (the folder's, if that file isn't there) and in that state adds the
 * entry to the folder, as the installer does, and to that file if it doesn't inherit it from the folder. When it can't,
 * or can't confirm it did, it tells the user what to run and quits. Permissions it can't read at all leave the start
 * as it was.
 */
export function checkInstallDir(target = installDirTarget(), tools: InstallDirTools = windowsTools): void {
  const icu = join(target.dir, CHECKED_FILE)
  const file = tools.exists(icu) ? icu : undefined
  const checked = file ?? target.dir
  const before = tools.read(checked)
  if (before === null || !lacksAllAppPackages(before)) return
  log.warn(`The install folder ${userText(target.dir)} has an app package's entry but none for ALL APPLICATION PACKAGES`)
  if (target.mayChange) {
    /** Whether the checked file has the entry now: null if its permissions can't be read. */
    const fixed = (): boolean | null => {
      const sddl = tools.read(checked)
      return sddl === null ? null : !lacksAllAppPackages(sddl)
    }
    let status = tools.grant(target.dir, FOLDER_GRANT)
    let ok = fixed()
    // A file that doesn't inherit the folder's permissions gets the entry of its own: read access to that one file.
    if (ok === false && file) {
      log.warn(`${CHECKED_FILE} doesn't inherit the install folder's permissions: adding the entry to it too`)
      status = tools.grant(file, FILE_GRANT)
      ok = fixed()
    }
    if (ok) {
      log.info('Added ALL APPLICATION PACKAGES to the install folder')
      return
    }
    log.error(`Couldn't add ALL APPLICATION PACKAGES to the install folder (icacls exited with ${status}${ok === null ? ", and the permissions couldn't be read again" : ''})`)
  } else log.error("A development or test copy doesn't change its Electron's folder")
  tools.tell(target.dir, file)
  tools.exit(1)
}
