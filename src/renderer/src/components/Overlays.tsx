import { useEffect, useMemo, useRef, useState } from 'react'
import iconUrl from '../assets/icon.svg'
import { call, errorMessage } from '../api'
import { commandCategory, commandKeybinding, commandLabel, commands, runCommand } from '../commands'
import { closeDialog, findProject, NO_PROJECTS, notify, set, setActivity, useLanguage, useStore } from '../store'
import { cacheState, useLiveUsage } from '../usage'
import { actClass, cx, formatKeybinding, formatTokens, timeAgo } from '../util'
import { EntryActions, EntryText, entryIcon } from './Popups'
import { kindOf } from '@shared/notify'
import { TerminalView } from './TerminalView'
import { UpdateStatusRow } from './Updates'
import { discardDrafts, saveAllDrafts, unsavedFiles } from './FileView'
import type { CustomCommand, ProviderId, ProviderTask, QuitChoice, QuitSession, SessionStatus, TestedCli, HostCheck } from '@shared/types'
import { PROVIDERS, enabledProviders, installSourceText, isProviderEnabled, providerDescriptor, shownText } from '@shared/providers'
import { distinguishingParents } from '@shared/folderLabels'
import { GIT_DOWNLOAD, GIT_MIN, gitFixText, gitOldText, gitProblemText } from '@shared/gitTool'
import { testedNote, testedSummary } from '@shared/testedClis'
import { APP_NAME } from '@shared/appName'
import { fmt, msg, tr, tRich, type Msg } from '@shared/i18n'
import { formatDateTime } from '@shared/dates'
import { cardLabel } from '@shared/projectKeys'
import { cardMatches } from '@shared/tasks'
import type { ConsoleRecordingInfo } from '@shared/devConsole'
import { ProviderIcon } from './ProviderIcon'
import { ConnectionSetupLine, ServerSetupLines, useProviderWarnings } from './ConnectionChoice'
import { AgentsDetail, CARD_COLUMN, PROJECT_COLUMN, STATE_COLUMN, type AgentColumn, type AgentTableGroup, type AgentTableRow } from './AgentsTable'
import { BusyButton, CodeText, CopyableCode, Icon, IconButton, LoadFailed, Modal, SearchInput, STATUS_TEXT, useBackdrop, useBusy } from './ui'

// A message's tags (tRich), drawn the same everywhere: <b> bold, <muted> and <faint> greyed, a link.
const bold = (chunks: React.ReactNode[]): React.ReactNode => <strong key="b">{chunks}</strong>
const muted = (chunks: React.ReactNode[]): React.ReactNode => (
  <span key="muted" className="muted">
    {chunks}
  </span>
)
const faint = (chunks: React.ReactNode[]): React.ReactNode => (
  <span key="faint" className="faint">
    {chunks}
  </span>
)
const linkTo =
  (key: string, onClick: () => void) =>
  (chunks: React.ReactNode[]): React.ReactNode => (
    <a key={key} onClick={onClick}>
      {chunks}
    </a>
  )

export function Dialogs() {
  const dialog = useStore((s) => s.dialog)
  const blocked = useStore((s) => s.dialogBlocked)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState(false)
  const [checked2, setChecked2] = useState(false)
  const [checked3, setChecked3] = useState(false)
  const [picked, setPicked] = useState('')
  // The prompt's second box (a new project's key) and whether the user has typed in it.
  const [second, setSecond] = useState('')
  const [secondOwn, setSecondOwn] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // The dialog shown now, for a callback started for one that may have closed since.
  const shownDialog = useRef(dialog)
  shownDialog.current = dialog
  const action = useBusy()
  const { setError: setActionError } = action

  useEffect(() => {
    setActionError(null)
    if (dialog?.kind === 'confirm') setChecked(dialog.check?.initial ?? false)
    if (dialog?.kind === 'prompt') {
      setValue(dialog.initial ?? '')
      setSecond(dialog.second?.follow(dialog.initial ?? '') ?? '')
      setSecondOwn(false)
      setChecked(dialog.check?.initial ?? false)
      setChecked2(dialog.check2?.initial ?? false)
      setChecked3(dialog.check3?.initial ?? false)
      setError(null)
      // Its box takes the focus as it opens, from wherever it was (a search box or a terminal behind the dialog too),
      // unless the user has already gone into one of this dialog's own boxes (#1221: run late, on a busy machine, the
      // select took what was being typed into the key box into the name box). Not once this prompt has closed.
      const opened = dialog
      setTimeout(() => {
        const box = inputRef.current
        if (shownDialog.current !== opened || !box?.isConnected) return
        const active = document.activeElement
        const own = box.closest('.dialog')
        if (own && active !== box && own.contains(active) && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) return
        if (active === box && box.value !== (opened.initial ?? '')) return
        box.select()
      }, 30)
    }
    if ((dialog?.kind === 'choice' || dialog?.kind === 'prompt') && dialog.select) setPicked(dialog.select.initial)
  }, [dialog, setActionError])

  // The second box's check and suggestion follow the projects' keys (HI-2653): a New Project dialog opened before the
  // board's first read landed checks the key typed again once it has, and a suggestion not typed over is made again.
  const projectKeys = useStore((s) => s.projectKeys)
  useEffect(() => {
    if (dialog?.kind === 'prompt' && dialog.second && !secondOwn) setSecond(dialog.second.follow(value))
    // Only when the keys change: typing in either box already updates the suggestion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectKeys])

  if (!dialog) return null
  const close = (result: boolean | string | null): void => {
    closeDialog()
    if (dialog.kind === 'confirm') {
      dialog.check?.set(checked)
      dialog.resolve(result === true)
    } else if (dialog.kind === 'prompt') {
      dialog.check?.set(checked)
      dialog.check2?.set(checked2)
      dialog.check3?.set(checked3)
      if (typeof result === 'string') dialog.select?.set(picked)
      if (typeof result === 'string') dialog.second?.set(second)
      dialog.resolve(typeof result === 'string' ? result : null)
    }
  }

  if (dialog.kind === 'choice') {
    const answer = (v: string | null): void => {
      closeDialog()
      if (v !== null) dialog.select?.set(picked)
      dialog.resolve(v)
    }
    return (
      <Modal
        title={dialog.title}
        icon={dialog.danger ? 'warning' : 'question'}
        onClose={() => answer(null)}
        footer={
          <>
            <button className="btn subtle" onClick={() => answer(null)}>
              {tr(msg({ id: 'shell.dialog.cancel', defaultMessage: 'Cancel', description: "A dialog's button that closes it without doing anything." }))}
            </button>
            {dialog.choices.map((c, i) => (
              <button key={c.value} className={cx('btn', i === dialog.choices.length - 1 ? (c.action ? cx(actClass(c.action), 'solid') : dialog.danger ? 'danger' : 'primary') : (actClass(c.action) || 'subtle'))} autoFocus={i === dialog.choices.length - 1} onClick={() => answer(c.value)}>
                {c.label}
              </button>
            ))}
          </>
        }
      >
        <div>{dialog.message}</div>
        {dialog.list && dialog.list.length > 0 && <DialogList items={dialog.list} />}
        {dialog.detail && <div className="detail">{dialog.detail}</div>}
        {dialog.select && <DialogSelect select={dialog.select} picked={picked} setPicked={setPicked} />}
      </Modal>
    )
  }

  if (dialog.kind === 'confirm') {
    return (
      <Modal
        title={dialog.title}
        icon={dialog.danger ? 'warning' : dialog.okOnly ? 'info' : 'question'}
        wide={dialog.wide}
        onClose={() => close(false)}
        busy={!!action.busy}
        error={action.error}
        footer={
          <>
            {!dialog.okOnly && (
              <button className="btn subtle" onClick={() => close(false)}>
                {dialog.cancelLabel ?? tr(msg({ id: 'shell.dialog.cancel', defaultMessage: 'Cancel', description: "A dialog's button that closes it without doing anything." }))}
              </button>
            )}
            <BusyButton
              className={dialog.action ? cx(actClass(dialog.action), 'solid') : dialog.danger ? 'danger' : 'primary'}
              autoFocus
              busy={action.busy === 'confirm'}
              busyLabel={dialog.busyLabel ?? tr(msg({ id: 'shell.dialog.working', defaultMessage: 'Working…', description: "A dialog's button while what it does runs." }))}
              disabled={!!blocked}
              onClick={() => {
                const run = dialog.run
                if (!run) return close(true)
                // The tick box's answer first: the action may depend on it (a template load removing old worktrees, #289).
                dialog.check?.set(checked)
                void action.run('confirm', run).then((r) => r && close(true))
              }}
            >
              {action.error ? tr(msg({ id: 'shell.dialog.tryAgain', defaultMessage: 'Try Again', description: "A dialog's button after what it did failed: does it again." })) : (dialog.confirmLabel ?? tr(msg({ id: 'shell.dialog.ok', defaultMessage: 'OK', description: "A dialog's button that agrees, when the dialog gives it no other name." })))}
            </BusyButton>
          </>
        }
      >
        <div>{dialog.message}</div>
        {dialog.list && dialog.list.length > 0 && <DialogList items={dialog.list} copy={!dialog.listOnly} mono={dialog.listMono} />}
        {dialog.content ? <div className={cx('detail rich' /* i18n-ignore: class names */, dialog.scrollDetail && 'scroll')}>{dialog.content}</div> : dialog.detail && <div className={cx('detail', dialog.scrollDetail && 'scroll')}>{dialog.detail}</div>}
        {dialog.check && (
          <label className="flex dialog-check">
            <input type="checkbox" checked={checked} disabled={!!action.busy} onChange={(e) => setChecked(e.target.checked)} /> {dialog.check.label}
          </label>
        )}
      </Modal>
    )
  }

  const secondError = dialog.second ? dialog.second.validate(second) : null
  const submit = (): void => {
    const err = dialog.validate?.(value) ?? null
    if (err) return setError(err)
    if (secondError) return
    close(value)
  }
  return (
    <Modal
      title={dialog.title}
      onClose={() => close(null)}
      footer={
        <>
          <button className="btn subtle" onClick={() => close(null)}>
            {tr(msg({ id: 'shell.dialog.cancel', defaultMessage: 'Cancel', description: "A dialog's button that closes it without doing anything." }))}
          </button>
          <button className="btn primary" onClick={submit} disabled={!!secondError}>
            {dialog.confirmLabel ?? tr(msg({ id: 'shell.dialog.ok', defaultMessage: 'OK', description: "A dialog's button that agrees, when the dialog gives it no other name." }))}
          </button>
        </>
      }
    >
      {dialog.message && <p style={{ marginTop: 0 }} className="muted">{dialog.message}</p>}
      {dialog.list && dialog.list.length > 0 && <DialogList items={dialog.list} copy={!dialog.listOnly} />}
      {dialog.detail && <div className="detail" style={{ marginBottom: 10 }}>{dialog.detail}</div>}
      {dialog.fieldLabel && <label className="dialog-field-label" htmlFor="dialog-prompt-field">{dialog.fieldLabel}</label>}
      <input
        ref={inputRef}
        id="dialog-prompt-field"
        className={cx('input', error && 'invalid')}
        style={{ width: '100%' }}
        value={value}
        placeholder={dialog.placeholder}
        onChange={(e) => {
          setValue(e.target.value)
          setError(null)
          if (dialog.second && !secondOwn) setSecond(dialog.second.follow(e.target.value))
        }}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      {error && <div className="field-error">{error}</div>}
      {dialog.second && (
        <label className="dialog-select">
          {dialog.second.label}
          <input
            className={cx('input', secondError && 'invalid')}
            value={second}
            aria-label={dialog.second.label}
            aria-invalid={!!secondError}
            spellCheck={false}
            onChange={(e) => {
              setSecond(e.target.value.toUpperCase())
              setSecondOwn(true)
            }}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </label>
      )}
      {dialog.second && (secondError ? <div className="field-error">{secondError}</div> : dialog.second.hint?.(second) && <div className="field-hint">{dialog.second.hint(second)}</div>)}
      {dialog.select && <DialogSelect select={dialog.select} picked={picked} setPicked={setPicked} />}
      {dialog.check && (
        <label className="flex" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> {dialog.check.label}
        </label>
      )}
      {dialog.check2 && (
        <label className="flex" style={{ marginTop: 6 }} data-check2>
          <input type="checkbox" checked={checked2} onChange={(e) => setChecked2(e.target.checked)} /> {dialog.check2.label}
        </label>
      )}
      {dialog.check3 && (
        <label className="flex" style={{ marginTop: 6 }} data-check3>
          <input type="checkbox" checked={checked3} onChange={(e) => setChecked3(e.target.checked)} /> {dialog.check3.label}
        </label>
      )}
    </Modal>
  )
}

/** A dialog's drop-down (a choice's or a prompt's), its label beside it. */
function DialogSelect({ select, picked, setPicked }: { select: { label: string; options: { label: string; value: string }[] }; picked: string; setPicked: (v: string) => void }) {
  return (
    <label className="dialog-select">
      {select.label}
      <select className="select" aria-label={select.label} value={picked} onChange={(e) => setPicked(e.target.value)}>
        {select.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/** A confirm's list (paths): one per line, a long one wrapping inside itself, and a Copy button for them all (#347). */
export function DialogList({ items, copy = true, mono = false }: { items: readonly string[]; copy?: boolean; mono?: boolean }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className={cx('dialog-list', !copy && 'plain', mono && 'mono')}>
      <ul>
        {items.map((item, i) => (
          <li key={`${i}:${item}`}>{item}</li>
        ))}
      </ul>
      {copy && <IconButton
        icon={copied ? 'check' : 'copy'}
        title={items.length === 1 ? tr(msg({ id: 'shell.dialog.copy', defaultMessage: 'Copy', description: 'Button beside a list in a dialog: copies it.' })) : tr(msg({ id: 'shell.dialog.copyAll', defaultMessage: 'Copy all', description: 'Button beside a list of several in a dialog: copies them all.' }))}
        onClick={() => {
          void navigator.clipboard.writeText(items.join('\n'))
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        }}
      />}
    </div>
  )
}

/** What the palette takes for a card's name (#1221): a key with or without its number (AM-12, AM-), or #1061. */
const CARD_QUERY = /^(#\d{1,9}|[A-Za-z]{2,4}-\d{0,9})$/

function score(text: string, q: string): number {
  if (!q) return 1
  const t = text.toLowerCase()
  const s = q.toLowerCase()
  if (t.includes(s)) return 100 - t.indexOf(s)
  let ti = 0
  for (const ch of s) {
    ti = t.indexOf(ch, ti)
    if (ti < 0) return 0
    ti++
  }
  return 10
}

/** No commands: a stable value for the store's selectors (a fresh [] would render forever). */
const NO_COMMANDS: CustomCommand[] = []

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen)
  const mode = useStore((s) => s.paletteMode)
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  const tasks = useStore((s) => s.tasks)
  const keys = useStore((s) => s.projectKeys)
  const moved = useStore((s) => s.movedCardNames)
  // The user's commands (HI-1954): each one runs by hand from here, as from Settings.
  const combworkCommands = useStore((s) => s.settings?.commands?.list ?? NO_COMMANDS)
  const wsCommands = useStore((s) => s.workspace?.config.commands?.list ?? NO_COMMANDS)
  // Toggles' states as one string, so their rows' checkmarks follow live changes (pinning the window
  // while the palette is open) without rebuilding the item list; a string keeps the selector stable.
  useStore(() => commands.map((c) => (c.checked ? (c.checked() ? '1' : '0') : '')).join(''))
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  // The rows are labelled in the language shown: made again when it changes, the palette open or not (#795).
  const shownLanguage = useLanguage()

  // It opens empty (HI-2730): what was typed last is cleared as it opens, before its first render, not in an effect after
  // it, when the input has already taken the focus showing the old text and keys typed at once would join it.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setQ('')
      setActive(0)
    }
  }

  const items = useMemo(() => {
    const cmdItems = mode === 'projects' ? [] : commands
      .filter((c) => !c.internal && !c.hidden?.() && (!c.when || c.when()))
      .map((c) => ({ id: c.id, command: c.id as string | undefined, label: tr(msg({ id: 'shell.palette.command', defaultMessage: '{category}: {command}', description: 'A command in the command palette: its category, then its name.' }), { category: commandCategory(c), command: commandLabel(c) }), keybinding: commandKeybinding(c.id), run: () => runCommand(c.id), icon: 'symbol-event', checked: c.checked }))
    const projectItems = projects.map((p) => ({
      id: `project:${p.path}`,
      command: undefined as string | undefined,
      label: mode === 'projects' ? p.name : tr(msg({ id: 'shell.palette.goToProject', defaultMessage: 'Go to Project: {project}', description: 'A project in the command palette: choosing it shows the project.' }), { project: p.name }),
      keybinding: undefined as string | undefined,
      run: () => runCommand('project.focus', p.path),
      icon: 'folder',
      checked: undefined as (() => boolean) | undefined
    }))
    // Cards by name (#1221): typed as a card reference (AM-12, am-12, AM- for all of that project's, #1061), the cards it
    // finds come first, those on the board before archived ones; choosing one opens it.
    const ref = mode !== 'projects' && CARD_QUERY.test(q.trim())
    const cardItems = ref
      ? [...tasks.filter((c) => !c.archived), ...tasks.filter((c) => c.archived)]
          .filter((c) => cardMatches(c, q, keys, moved))
          .map((c) => ({
            id: `card:${c.number}`,
            command: undefined as string | undefined,
            label: tr(msg({ id: 'shell.palette.openCard', defaultMessage: 'Open Card: {card} {title}', description: 'A card in the command palette, found by its name: choosing it opens the card. {card} is its name (its key, such as AM-12, or #12 for a card with none), {title} its title (the user’s own words).' }), { card: cardLabel(c), title: c.title }),
            keybinding: undefined as string | undefined,
            run: () => set({ taskOpen: c.number }),
            icon: 'project',
            checked: undefined as (() => boolean) | undefined
          }))
      : []
    const runItems = mode === 'projects' ? [] : [...wsCommands.map((c) => ({ c, scope: 'workspace' as const })), ...combworkCommands.map((c) => ({ c, scope: 'combwork' as const }))].map(({ c, scope }) => ({
      id: `run:${scope}:${c.id}`,
      command: undefined as string | undefined,
      label: tr(msg({ id: 'shell.palette.runCommand', defaultMessage: 'Run Command: {name}', description: "One of the user's own commands in the command palette (Settings → Commands, HI-1954): choosing it runs it now. {name} is the command's name." }), { name: c.name }),
      keybinding: undefined as string | undefined,
      run: () => void call('commands:run', { scope, id: c.id }).catch((e) => notify('error', errorMessage(e))),
      icon: 'play',
      checked: undefined as (() => boolean) | undefined
    }))
    return [...cardItems.map((i) => ({ ...i, s: 1000 })), ...[...projectItems, ...cmdItems, ...runItems].map((i) => ({ ...i, s: score(i.label, q) }))]
      .filter((i) => i.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
    // `open`: commands' availability (when()) is read again each time the palette opens; `shownLanguage`: their labels.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, projects, open, mode, shownLanguage, tasks, keys, moved, combworkCommands, wsCommands])

  useEffect(() => {
    listRef.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null
  const close = (): void => set({ paletteOpen: false })
  const exec = (i: number): void => {
    const it = items[i]
    if (!it) return
    close()
    setTimeout(it.run, 0)
  }
  return (
    <div className="overlay" style={{ paddingTop: 60 }} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <Backdrop />
      <div className="palette">
        {/* Escape clears what is typed first (#433), then closes the palette. */}
        <SearchInput
          autoFocus
          placeholder={mode === 'projects' ? tr(msg({ id: 'shell.palette.projectsPlaceholder', defaultMessage: 'Go to project', description: "The command palette's placeholder when it lists projects (Go to Project…)." })) : tr(msg({ id: 'shell.palette.placeholder', defaultMessage: 'Type a command or project name', description: "The command palette's placeholder." }))}
          value={q}
          onChange={(v) => {
            setQ(v)
            setActive(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close()
            else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(items.length - 1, a + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(0, a - 1))
            } else if (e.key === 'Enter') exec(active)
          }}
        />
        <div className="palette-list" ref={listRef}>
          {items.length === 0 && <div className="pane-empty">{tr(msg({ id: 'shell.palette.noMatch', defaultMessage: 'No matching commands', description: 'The command palette when what is typed matches nothing.' }))}</div>}
          {items.map((it, i) => (
            <div key={it.id} className={cx('palette-item', i === active && 'active')} data-command={it.command} onMouseMove={() => setActive(i)} onClick={() => exec(i)}>
              <Icon name={it.checked?.() ? 'check' : it.icon} />
              <span>{it.label}</span>
              {it.keybinding && <kbd>{formatKeybinding(it.keybinding)}</kbd>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** The window is dimmed (its native buttons too) while this is shown. */
function Backdrop(): null {
  useBackdrop()
  return null
}

export function NotificationCenter() {
  const open = useStore((s) => s.showNotifications)
  const items = useStore((s) => s.notifications)
  // Escape closes it (HI-2376), after anything else had its turn: not one a handler took (a shortcut being recorded,
  // a pop-up with the focus), nor while a dialog is open, nor from a field, a terminal or an editor, which use Escape.
  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return
      set({ showNotifications: false })
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [open])
  if (!open) return null
  return (
    <div className="notif-panel">
      <div className="pane-header">
        {tr(msg({ id: 'shell.notifications.title', defaultMessage: 'Notifications', description: 'The heading of the notifications panel (the bell in the status bar).' }))}
        <div className="actions">
          <IconButton icon="clear-all" title={tr(msg({ id: 'shell.notifications.clearAll', defaultMessage: 'Clear all', description: 'Button of the notifications panel: removes every notification.' }))} onClick={() => set({ notifications: [], toasts: [] })} />
          <IconButton icon="close" title={tr(msg({ id: 'shell.close', defaultMessage: 'Close', description: 'Closes a panel or a dialog.' }))} onClick={() => set({ showNotifications: false })} />
        </div>
      </div>
      <div className="list">
        {items.length === 0 && (
          <div className="empty-state">
            <Icon name="bell" />
            {tr(msg({ id: 'shell.notifications.none', defaultMessage: 'No notifications', description: 'The notifications panel when it is empty.' }))}
          </div>
        )}
        {/* Every entry this window was given (HI-2320), with its buttons while they still apply, or what happened. */}
        {items.map((t) => (
          <div key={t.id} className={cx('notif-item', t.level, `kind-${kindOf(t)}`, t.resolved && 'resolved')} data-entry={t.id} data-kind={kindOf(t)}>
            <Icon name={entryIcon(t)} className={cx('lead')} />
            <EntryText t={t} onOpen={() => set({ showNotifications: false })}>
              <EntryActions t={t} onNavigate={() => set({ showNotifications: false })} />
              <div className="time">{timeAgo(t.timestamp)}</div>
            </EntryText>
          </div>
        ))}
      </div>
    </div>
  )
}

export function AboutDialog() {
  const open = useStore((s) => s.aboutOpen)
  const info = useStore((s) => s.appInfo)
  const providers = useStore((s) => s.providers)
  if (!open || !info) return null
  const rows: [string, string][] = [
    [tr(msg({ id: 'shell.about.version', defaultMessage: 'Version', description: "A row of Help → About: Combwork's version." })), info.version],
    ...PROVIDERS.map((p): [string, string] => {
      const i = providers[p.id]
      return [p.name, i?.found ? tr(msg({ id: 'shell.about.cli', defaultMessage: 'CLI {version} ({source})', description: "A row of Help → About, a coding agent's: its CLI's version and where Combwork found it." }), { version: i.version ?? '', source: installSourceText(i.source, tr) }) : tr(msg({ id: 'shell.about.noCli', defaultMessage: 'CLI not installed', description: "A row of Help → About, a coding agent's, when its CLI isn't installed." }))]
    }),
    // Names of software, the same in every language.
    ['Electron', info.electron], // i18n-ignore: a name
    ['Chromium', info.chrome], // i18n-ignore: a name
    ['Node.js', info.node],
    ['V8', info.v8],
    ['OS', `${info.platform} ${info.arch}`],
    [tr(msg({ id: 'shell.about.dataFolder', defaultMessage: 'Data folder', description: "A row of Help → About: the folder of Combwork's profile." })), info.userData]
  ]
  const showDoc = (page: string): void => {
    set({ aboutOpen: false, docsPage: page })
    setActivity('docs')
  }
  const copy = (): void => {
    void navigator.clipboard.writeText(rows.map(([k, v]) => `${k}: ${v}`).join('\n'))
    notify('success', tr(msg({ id: 'shell.about.copied', defaultMessage: 'Version information copied', description: "A notice after Help → About's Copy." })))
  }
  return (
    <Modal
      title={tr(msg({ id: 'shell.about.title', defaultMessage: 'About {app}', description: "Help → About's title. {app} is Combwork's name." }), { app: APP_NAME })}
      onClose={() => set({ aboutOpen: false })}
      footer={
        <>
          <button className="btn subtle" onClick={copy}>
            <Icon name="copy" /> {tr(msg({ id: 'shell.about.copy', defaultMessage: 'Copy', description: "Help → About's button: copies the versions." }))}
          </button>
          <button className="btn subtle" onClick={() => {
              set({ aboutOpen: false })
              runCommand('help.releaseNotes')
            }}>
            {tr(msg({ id: 'shell.about.releaseNotes', defaultMessage: 'Release Notes', description: "Help → About's button: opens the release notes." }))}
          </button>
          <button className="btn primary" onClick={() => set({ aboutOpen: false })}>
            {tr(msg({ id: 'shell.dialog.ok', defaultMessage: 'OK', description: "A dialog's button that agrees, when the dialog gives it no other name." }))}
          </button>
        </>
      }
    >
      <div className="about">
        <img src={iconUrl} alt={APP_NAME} />
        <h1>{APP_NAME}</h1>
        <div className="version">{tr(msg({ id: 'shell.about.versionLine', defaultMessage: 'Version {version}', description: "Under Combwork's name in Help → About." }), { version: info.version })}</div>
        <p className="muted" style={{ maxWidth: 360, margin: '10px auto 0' }}>
          {tr(msg({ id: 'shell.about.blurb', defaultMessage: 'An agent-first workspace for AI-assisted coding. Run coding agents such as {providers} across your projects, side by side.', description: 'Help → About: what Combwork is. {providers} lists the coding agents (Claude Code, Codex and GitHub Copilot).' }), { providers: fmt.list(PROVIDERS.map((p) => p.name)) })}
        </p>
        <table className="about-table">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td>{k}</td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="about-update">
          <UpdateStatusRow />
        </div>
        <p className="about-licence">
          {tRich(msg({ id: 'shell.about.licence', defaultMessage: 'Open source under the <licence>MIT License</licence>. Includes <notices>third-party software</notices> and <chromium>Chromium</chromium>.', description: "Help → About: Combwork's licence. Each tag is a link: to the licence, the notices of the software Combwork includes, and Chromium's licences. MIT and Chromium are names: keep them." }), {
            licence: linkTo('licence', () => showDoc('license')),
            notices: linkTo('notices', () => showDoc('notices')),
            chromium: linkTo('chromium', () => void call('app:openChromiumLicenses').then((ok) => ok || notify('info', tr(msg({ id: 'shell.about.noLicences', defaultMessage: 'Licences not found', description: "A notice when Chromium's licence file can't be opened." })), tr(msg({ id: 'shell.about.noLicencesDetail', defaultMessage: 'The Chromium licence file is in the folder Combwork is installed in.', description: "More in the notice that Chromium's licence file wasn't found." })))))
          })}
        </p>
        <p className="faint" style={{ fontSize: 11, marginTop: 8 }}>
          {tr(msg({ id: 'shell.about.legal', defaultMessage: "© 2026 Darren Marshall. {app} is independently developed and isn't affiliated with, endorsed or sponsored by {companies}. {products}; each is installed separately under its maker's terms.", description: "Help → About's small print. {app} is Combwork's name; {companies} lists the coding agents' makers (joined with “or”); {products} says whose each agent is, a sentence per agent (shell.about.productOf)." }), { app: APP_NAME, companies: fmt.list([...new Set(PROVIDERS.map((p) => p.company))], 'disjunction'), products: PROVIDERS.map((p) => tr(msg({ id: 'shell.about.productOf', defaultMessage: '{product} is a product of {company}', description: "Help → About's small print, a part per coding agent, joined with semicolons: whose it is." }), { product: p.name, company: p.company })).join('; ') })}
        </p>
      </div>
    </Modal>
  )
}

/** Help → Copy Diagnostics: shows exactly what will be copied (redacted in main), then copies it. */
export function DiagnosticsDialog() {
  const open = useStore((s) => s.diagnosticsOpen)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  // The newest developer console recording (#638): attached only when asked, and only a redacted one.
  const [recording, setRecording] = useState<ConsoleRecordingInfo | null>(null)
  const [attach, setAttach] = useState(false)
  useEffect(() => {
    // Cleared while closed, so an open never shows the last open's row (or choice) until its read returns (#723).
    setRecording(null)
    setAttach(false)
    if (!open) return
    let current = true
    void call('console:recordings').then(
      (r) => current && setRecording(r.latest),
      () => current && setRecording(null)
    )
    return () => {
      current = false
    }
  }, [open])
  useEffect(() => {
    if (!open) return
    setText(null)
    setError(null)
    let current = true
    void call('app:diagnostics', { recording: attach }).then(
      (t) => current && setText(t),
      (e) => current && setError(errorMessage(e))
    )
    return () => {
      current = false
    }
  }, [open, attempt, attach])
  if (!open) return null
  const close = (): void => set({ diagnosticsOpen: false })
  const copy = (): void => {
    if (!text) return
    void navigator.clipboard.writeText(text).then(
      () => {
        notify('success', tr(msg({ id: 'shell.diagnostics.copied', defaultMessage: 'Diagnostics copied', description: 'A notice after Help → Copy Diagnostics copied them.' })), tr(msg({ id: 'shell.diagnostics.copiedDetail', defaultMessage: 'Paste them into your bug report.', description: 'More in the notice after the diagnostics were copied.' })))
        close()
      },
      (e) => notify('error', tr(msg({ id: 'shell.diagnostics.copyFailed', defaultMessage: 'Could not copy the diagnostics', description: "An error's title: copying the diagnostics failed." })), errorMessage(e))
    )
  }
  return (
    <Modal
      title={tr(msg({ id: 'shell.diagnostics.title', defaultMessage: 'Copy Diagnostics', description: 'The title of Help → Copy Diagnostics.' }))}
      icon="bug"
      wide
      onClose={close}
      footer={
        <>
          <button className="btn subtle" onClick={close}>
            {tr(msg({ id: 'shell.dialog.cancel', defaultMessage: 'Cancel', description: "A dialog's button that closes it without doing anything." }))}
          </button>
          <button className="btn primary" disabled={!text} onClick={copy}>
            <Icon name="copy" /> {tr(msg({ id: 'shell.diagnostics.copy', defaultMessage: 'Copy', description: "Copy Diagnostics' button: copies them." }))}
          </button>
        </>
      }
    >
      <p className="muted">{tr(msg({ id: 'shell.diagnostics.what', defaultMessage: "For a bug report: Combwork's version, your coding agents, counts, the settings that change how Combwork behaves and the end of its log. Folders, workspace, project and agent names, and anything that looks like a key or token are taken out. This is exactly what will be copied.", description: 'Copy Diagnostics: what it copies (shown below it).' }))}</p>
      {recording &&
        (recording.includeText ? (
          <p className="muted diagnostics-recording">{tr(msg({ id: 'shell.diagnostics.recordingText', defaultMessage: "The newest developer console recording includes prompt and reply text, so it can't be attached.", description: 'Copy Diagnostics, when the newest developer console recording has text in it.' }))}</p>
        ) : (
          <label className="flex dialog-check diagnostics-recording">
            <input type="checkbox" className="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} /> {tr(msg({ id: 'shell.diagnostics.attach', defaultMessage: 'Attach the newest developer console recording ({when}, {n, plural, one {# event} other {# events}}), its newest events redacted again', description: 'A box in Copy Diagnostics. {when} is when the recording started; {n} how many events it has.' }), { when: formatDateTime(recording.startedAt), n: recording.events })}
          </label>
        ))}
      {error ? (
        <LoadFailed what={tr(msg({ id: 'shell.diagnostics.what2', defaultMessage: 'the diagnostics', description: 'Fills "Could not load {what}" when the diagnostics fail to load.' }))} error={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : (
        <pre className="diagnostics-preview">{text ?? tr(msg({ id: 'shell.diagnostics.collecting', defaultMessage: 'Collecting…', description: 'Copy Diagnostics while it gathers them.' }))}</pre>
      )}
    </Modal>
  )
}

export function ShortcutsDialog() {
  const open = useStore((s) => s.shortcutsOpen)
  if (!open) return null
  const withKeys = commands.map((c) => ({ ...c, keybinding: commandKeybinding(c.id) })).filter((c) => c.keybinding)
  return (
    <Modal
      title={tr(msg({ id: 'shell.shortcuts.title', defaultMessage: 'Keyboard Shortcuts', description: 'The title of Help → Keyboard Shortcuts.' }))}
      icon="keyboard"
      wide
      onClose={() => set({ shortcutsOpen: false })}
      footer={
        <>
          <button className="btn subtle" onClick={() => {
              set({ shortcutsOpen: false })
              runCommand('settings.keybindings')
            }}>
            <Icon name="settings" /> {tr(msg({ id: 'shell.shortcuts.customise', defaultMessage: 'Customise…', description: 'Button of Help → Keyboard Shortcuts: opens Settings → Keyboard Shortcuts.' }))}
          </button>
          <button className="btn primary" onClick={() => set({ shortcutsOpen: false })}>
            {tr(msg({ id: 'shell.dialog.ok', defaultMessage: 'OK', description: "A dialog's button that agrees, when the dialog gives it no other name." }))}
          </button>
        </>
      }
    >
      <table className="table kbd-table">
        <tbody>
          {withKeys.map((c) => (
            <tr key={c.id}>
              <td className="muted">{commandCategory(c)}</td>
              <td>{c.label}</td>
              <td>
                {c.keybinding!.split(' ').map((k, i) => (
                  <kbd key={i} style={{ marginLeft: 4 }}>
                    {formatKeybinding(k)}
                  </kbd>
                ))}
              </td>
            </tr>
          ))}
          <tr>
            <td className="muted">{tr(msg({ id: 'shell.shortcuts.terminal', defaultMessage: 'Terminal', description: "Help → Keyboard Shortcuts: keys an agent's terminal takes (the category column)." }))}</td>
            <td>{tr(msg({ id: 'shell.shortcuts.switchMode', defaultMessage: 'Switch mode inside the agent (Claude Code: permission mode)', description: "Help → Keyboard Shortcuts: what Shift+Tab does in an agent's terminal." }))}</td>
            <td>
              <kbd>Shift+Tab</kbd>{/* i18n-ignore: a key's name */}
            </td>
          </tr>
          <tr>
            <td className="muted">{tr(msg({ id: 'shell.shortcuts.terminal', defaultMessage: 'Terminal', description: "Help → Keyboard Shortcuts: keys an agent's terminal takes (the category column)." }))}</td>
            <td>{tr(msg({ id: 'shell.shortcuts.copyPaste', defaultMessage: 'Copy selection / paste', description: "Help → Keyboard Shortcuts: copying and pasting in an agent's terminal." }))}</td>
            <td>
              {tRich(msg({ id: 'shell.shortcuts.copyPasteKeys', defaultMessage: '{copy} {paste} or right-click', description: 'Help → Keyboard Shortcuts: the keys for copy and paste ({copy} is Ctrl+C, {paste} Ctrl+V), or the right mouse button.' }), { copy: <kbd key="copy">Ctrl+C</kbd>, paste: <kbd key="paste">Ctrl+V</kbd> }) /* i18n-ignore: keys' names */}
            </td>
          </tr>
        </tbody>
      </table>
      {PROVIDERS.filter((p) => p.reservedKeys.length).map((p) => (
        <p key={p.id} className="hint">
          {tr(msg({ id: 'shell.shortcuts.reserved', defaultMessage: '{keys} are left to {provider} while its terminal has focus.', description: "Under Help → Keyboard Shortcuts: keys a coding agent keeps in its terminal. {keys} lists them; {provider} is the agent's name." }), { keys: fmt.list(p.reservedKeys.map((k) => k.replace('MOD+', 'Ctrl+')), 'unit'), provider: p.name })}
        </p>
      ))}
    </Modal>
  )
}

/**
 * After Provider Setup's install found the CLI (#472). Installers say to restart the terminal; Combwork looked again on the
 * PATH a new process gets, so neither it nor new agents need a restart. Running agents keep the PATH they started with.
 */
function installedText(name: string): string {
  return tr(msg({ id: 'shell.setup.installed', defaultMessage: "{provider} is installed and Combwork has found it: agents you start now can use it, without restarting Combwork (the installer's advice to restart your terminal is for terminals already open). Agents already running get the new PATH when they restart.", description: "Provider Setup, after an install found the coding agent's CLI. {provider} is its name; PATH is a Windows setting: keep it." }), { provider: name })
}

/** An install that ended without Combwork finding the CLI. */
function installNotFoundText(name: string): string {
  return tr(msg({ id: 'shell.setup.notFound', defaultMessage: "The install ended, but Combwork can't find {provider}. If the installer reported an error, it's shown below; if it says it worked, Check again, or set {provider}'s path in Settings → {provider}.", description: "Provider Setup, after an install ended without Combwork finding the CLI. {provider} is its name; Check again is the dialog's button." }), { provider: name })
}

/**
 * Git, under every provider's tab (#346): worktrees, merging, the Changes tab and the unmerged counts need it, whichever
 * CLI runs. Check again looks at it too.
 */
function GitSetupRow() {
  const git = useStore((s) => s.gitTool)
  const problem = gitProblemText(git)
  const download = (
    <button className="btn" onClick={() => void call('app:openExternal', GIT_DOWNLOAD)}>
      <Icon name="link-external" /> Git for Windows {/* i18n-ignore: a product's name */}
    </button>
  )
  if (!git || (git.state === 'unknown' && !git.error)) {
    return (
      <div className="setup-status setup-git">
        <Icon name="loading" spin />
        <div>{tr(msg({ id: 'shell.setup.lookingForGit', defaultMessage: 'Looking for Git…', description: 'Provider Setup while Combwork looks for git.' }))}</div>
      </div>
    )
  }
  if (git.state === 'ok') {
    return (
      <div className="setup-status setup-git" data-git="ok">
        <Icon name="pass-filled" />
        <div className="grow">
          <div>
            {tRich(msg({ id: 'shell.setup.gitOk', defaultMessage: '<b>Git {version}</b> <muted>— for worktrees, merging and the Version Control tab</muted>', description: 'Provider Setup: the git Combwork found. {version} is its version; <b> is bold, <muted> greyed. Git is a name: keep it.' }), { version: git.version ?? '', b: bold, muted })}
          </div>
          {git.path && <div className="muted mono" style={{ fontSize: 11 }}>{git.path}</div>}
        </div>
      </div>
    )
  }
  const title = git.state === 'missing' ? tr(msg({ id: 'shell.setup.gitMissing', defaultMessage: 'Git not found', description: 'Provider Setup when Combwork finds no git. Git is a name: keep it.' })) : git.state === 'old' ? tr(msg({ id: 'shell.setup.gitOld', defaultMessage: 'Git {version} is older than {min}', description: 'Provider Setup when the git found is too old. {version} and {min} are version numbers.' }), { version: git.version ?? '', min: GIT_MIN }) : tr(msg({ id: 'shell.setup.gitUnknown', defaultMessage: "Couldn't check Git", description: "Provider Setup when Combwork couldn't run git to check it." }))
  const detail =
    git.state === 'old' && !problem
      ? tr(msg({ id: 'shell.setup.gitOldDetail', defaultMessage: '{why} Update Git for Windows to {min} or later, then Check again.', description: "Provider Setup, under a too old git. {why} says why (in English for now); Git for Windows is a product's name; Check again is the dialog's button." }), { why: gitOldText(git.version!), min: GIT_MIN })
      : git.state === 'unknown'
        ? tr(msg({ id: 'shell.setup.gitUnknownDetail', defaultMessage: '{error}. Combwork needs Git {min} or later for worktrees, merging and the Version Control tab.', description: "Provider Setup when git couldn't be checked. {error} is the error, as given." }), { error: git.error ?? '', min: GIT_MIN })
        : tr(msg({ id: 'shell.setup.gitProblemDetail', defaultMessage: "{problem}: worktree agents, merging, the Version Control tab's Git sections and the unmerged counts don't work. {fix}", description: 'Provider Setup under a git problem. {problem} and {fix} say what is wrong and what to do (in English for now).' }), { problem: problem ?? '', fix: gitFixText(git) })
  return (
    <div className="setup-status setup-git" data-git={git.state}>
      <Icon name="warning" />
      <div className="grow">
        <strong>{title}</strong>
        <div className="muted">{detail}</div>
      </div>
      {download}
    </div>
  )
}

/** Installing, updating, signing in to and setting up each provider's CLI, one tab per provider. */
/**
 * The CLI version this Combwork release was tested with, against the installed one (#365): a quiet tick when they match,
 * else a calm note (a newer CLI usually works; nothing is blocked).
 */
function TestedLine({ tested, installed }: { tested: TestedCli; installed: string | null }) {
  const note = testedNote(tested)
  return (
    <div className="setup-tested" data-tested={tested.installed} title={tested.testedAt ? tr(msg({ id: 'shell.setup.testedAt', defaultMessage: "Combwork's tests ran against {version} on {date}", description: "Tooltip of Provider Setup's tested-version line. {version} is the CLI's version; {date} when Combwork's tests ran." }), { version: tested.version, date: tested.testedAt }) : undefined}>
      <span className="muted">{testedSummary(tested, installed)}</span>
      {tested.installed === 'same' && <Icon name="check" className="setup-tested-ok" />}
      {note && <div className="hint">{note}</div>}
    </div>
  )
}

/** Each GitHub host's sign-in state (HI-2779), in Provider Setup's words. */
const HOST_STATE = {
  installed: msg({ id: 'shell.setup.host.installed', defaultMessage: 'Not signed in', description: 'Provider Setup, a GitHub host’s sign-in state (HI-2779): no credentials found for this host.' }),
  configured: msg({ id: 'shell.setup.host.configured', defaultMessage: 'Credentials set, identity not checked', description: 'Provider Setup, a GitHub host’s sign-in state (HI-2779): a token is set or a login is stored for this host, but nothing has checked it.' }),
  configuredModels: msg({ id: 'shell.setup.host.configuredModels', defaultMessage: 'Credentials set, models available; identity not checked', description: 'Provider Setup, a GitHub host’s sign-in state (HI-2779): credentials are set and Copilot listed models, but that doesn’t prove whose they are.' }),
  verified: msg({ id: 'shell.setup.host.verified', defaultMessage: 'GitHub CLI signed in as {account} on {host}', description: 'Provider Setup, a GitHub host’s sign-in state (HI-2779): the GitHub CLI checked its login on this host. {account} is the login, {host} the host. It says nothing of a Copilot seat.' }),
  denied: msg({ id: 'shell.setup.host.denied', defaultMessage: 'Every model is unavailable to this account: an organisation’s policy or the plan may not allow Copilot here', description: 'Provider Setup, a GitHub host’s sign-in state (HI-2779): Copilot listed models, each marked unavailable to the account.' }),
  noSignIn: msg({ id: 'shell.setup.host.noSignIn', defaultMessage: 'Runs a model of its own (BYOK or offline): no GitHub sign-in needed', description: 'Provider Setup, a GitHub host’s sign-in state (HI-2779): Copilot is set up with its own model provider (BYOK) or offline, so it doesn’t sign in to GitHub. BYOK: bring your own key.' }),
  unverified: msg({ id: 'shell.setup.host.unverified', defaultMessage: 'Couldn’t confirm the sign-in', description: 'Provider Setup, a GitHub host’s sign-in state (HI-2779): a check answered with an error Combwork can’t classify; its message follows.' }),
  unknown: msg({ id: 'shell.setup.host.unknown', defaultMessage: 'Couldn’t reach the host to check', description: 'Provider Setup, a GitHub host’s sign-in state (HI-2779): a check timed out or answered nothing readable.' }),
  chooseHost: msg({ id: 'shell.setup.host.chooseHost', defaultMessage: 'Choose where Copilot signs in', description: 'Provider Setup, a GitHub host’s sign-in state (HI-2779): the repositories are on GitHub Enterprise Server and no Copilot host was chosen.' }),
  proxyUnsupported: msg({ id: 'shell.setup.host.proxy', defaultMessage: 'GitHub Enterprise Server’s Copilot proxy: not supported yet', description: 'Provider Setup, a GitHub host’s sign-in state (HI-2779): GHES’s Copilot proxy (a preview) was chosen.' })
}
const HOST_ROW = {
  heading: msg({ id: 'shell.setup.host.heading', defaultMessage: 'Sign-in per GitHub host', description: 'A heading in Provider Setup → GitHub Copilot (HI-2779): one row per GitHub host the open projects use.' }),
  usedBy: msg({ id: 'shell.setup.host.usedBy', defaultMessage: '{projects, select, none {{workspace}} other {{workspace}: {projects}}}', description: 'Provider Setup (HI-2779): who uses a GitHub host: a workspace’s name, and its projects named (none: the workspace’s own default).' }),
  via: msg({ id: 'shell.setup.host.via', defaultMessage: 'Through {source}{account, select, none {} other {, as {account}}}', description: 'Provider Setup (HI-2779): the sign-in’s source by name ({source}: a variable such as COPILOT_GITHUB_TOKEN, Copilot login, GitHub CLI), and its account (none: unknown).' }),
  models: msg({ id: 'shell.setup.host.models', defaultMessage: '{available, plural, one {# model offered} other {# models offered}}{unavailable, plural, =0 {} other {, # unavailable to this account}}', description: 'Provider Setup (HI-2779): what Copilot listed for this host: models offered, and those marked unavailable.' }),
  repo: msg({ id: 'shell.setup.host.repo', defaultMessage: 'Repositories on {host}', description: 'Provider Setup (HI-2779): the repositories’ host, when it differs from where Copilot signs in. {host} is the host.' }),
  tokens: msg({ id: 'shell.setup.host.tokens', defaultMessage: 'Copilot takes a token from COPILOT_GITHUB_TOKEN first. GH_TOKEN and GITHUB_TOKEN are kept from Copilot agents unless Settings → Advanced → GitHub Copilot → Keep GH_TOKEN and GITHUB_TOKEN from Copilot is off. Combwork never reads a token.', description: 'Provider Setup → GitHub Copilot (HI-2779): which token variables Copilot uses, and where the switch keeping two of them out is (its name as Settings shows it). Keep the variable names.' })
}

/** Provider Setup's rows of a CLI's sign-in per GitHub host (HI-2779). */
function HostChecks({ checks }: { checks: HostCheck[] }) {
  return (
    <div className="setup-hosts" data-host-checks={checks.length}>
      <div className="setup-hosts-h">{tr(HOST_ROW.heading)}</div>
      {checks.map((c) => (
        <div key={c.key} className="setup-host" data-host={c.host ?? ''} data-state={c.state} data-source={c.source ?? ''}>
          <div>
            <strong className="mono">{c.host ?? c.repoHost}</strong>{' '}
            <span className={cx('badge', c.state === 'verified' || c.state === 'noSignIn' ? 'success' : c.state === 'configured' ? '' : 'warn')}>
              {c.state === 'verified' ? tr(HOST_STATE.verified, { account: c.account ?? '?', host: c.host ?? '' }) : c.state === 'configured' && c.models ? tr(HOST_STATE.configuredModels) : tr(HOST_STATE[c.state])}
            </span>
          </div>
          {c.usedBy.length > 0 && <div className="hint">{c.usedBy.map((u) => tr(HOST_ROW.usedBy, { workspace: u.workspace, projects: u.projects.length ? fmt.list(u.projects) : 'none' })).join(' · ')}</div>}
          {c.host && c.repoHost !== c.host && <div className="hint">{tr(HOST_ROW.repo, { host: c.repoHost })}</div>}
          {c.source && c.state !== 'verified' && <div className="hint">{tr(HOST_ROW.via, { source: c.source, account: c.account || 'none' })}</div>}
          {c.models && <div className="hint">{tr(HOST_ROW.models, { available: c.models.available, unavailable: c.models.unavailable })}</div>}
          {c.diagnostic && <div className="hint mono setup-host-diagnostic">{c.diagnostic}</div>}
        </div>
      ))}
      <p className="hint">{tr(HOST_ROW.tokens)}</p>
    </div>
  )
}

export function AgentSetupDialog() {
  const open = useStore((s) => s.setupOpen)
  const providers = useStore((s) => s.providers)
  const settings = useStore((s) => s.settings)
  const [tab, setTab] = useState<ProviderId>(PROVIDERS[0].id)
  const [task, setTask] = useState<{ key: string; kind: ProviderTask; issues: string[] } | null>(null)
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [finished, setFinished] = useState<{ text: string; ok: boolean } | null>(null)
  useEffect(() => {
    if (typeof open === 'string') setTab(open)
    else if (open) setTab(enabledProviders(settings)[0]?.id ?? PROVIDERS[0].id)
    // Only when the dialog opens: a settings change while it is open doesn't move the tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null
  const p = providerDescriptor(tab)
  const info = providers[tab]
  const on = isProviderEnabled(settings, tab)
  const start = async (kind: ProviderTask, retryUpdate = false, host?: string): Promise<void> => {
    try {
      const key = retryUpdate ? await call('provider:retryUpdate', tab) : await call('provider:task', tab, kind, host)
      setTask({ key, kind, issues: (info?.readiness ?? []).filter((r) => r.action?.task === kind).map((r) => r.id) })
      setFinished(null)
      setRunning(true)
    } catch (e) {
      notify('error', tr(msg({ id: 'shell.setup.startFailed', defaultMessage: 'Could not start', description: "An error's title: Provider Setup couldn't start an install, an update or a sign-in." })), errorMessage(e))
    }
  }
  const recheck = async (): Promise<typeof providers | null> => {
    setBusy(true)
    try {
      const next = await call('provider:refresh', tab)
      set({ providers: next })
      // A "can't find it" note from an install is out of date once looked again.
      setFinished((f) => (f?.ok === false ? null : f))
      return next
    } catch {
      return null
    } finally {
      setBusy(false)
    }
  }
  // When the issue the task was for is gone after it ends, it did its job: say so instead of leaving its last screen up.
  const taskEnded = async (): Promise<void> => {
    setRunning(false)
    const next = await recheck()
    const kind = task?.kind
    const after = next?.[tab]
    if (!kind || !after || after.checking) return
    const left = kind === 'update' ? after.updateAvailable || !!after.updateRetry : (after.readiness ?? []).some((r) => task.issues.includes(r.id))
    // An install that ended without Combwork finding the CLI: its terminal stays, with what to do next.
    if (left && kind === 'install' && !after.found) setFinished({ ok: false, text: installNotFoundText(p.name) })
    if (left) return
    // Installers say to restart the terminal (#472): Combwork looked again on the PATH a new process gets, so it needn't.
    const what: Record<ProviderTask, string> = {
      install: installedText(p.name),
      update: tr(msg({ id: 'shell.setup.updated', defaultMessage: '{provider} is up to date.', description: "Provider Setup after an update. {provider} is the coding agent's name." }), { provider: p.name }),
      login: tr(msg({ id: 'shell.setup.signedIn', defaultMessage: '{provider} is signed in.', description: "Provider Setup after signing in. {provider} is the coding agent's name." }), { provider: p.name }),
      setup: tr(msg({ id: 'shell.setup.setUp', defaultMessage: '{provider} is set up.', description: "Provider Setup after a setup step. {provider} is the coding agent's name." }), { provider: p.name })
    }
    setFinished({ ok: true, text: tr(msg({ id: 'shell.setup.done', defaultMessage: '{what} You can close this window.', description: 'Provider Setup after a task did its job. {what} says what happened.' }), { what: what[kind] }) })
    setTask(null)
  }
  const close = (): void => {
    if (task && running) void call('pty:kill', task.key)
    setTask(null)
    setFinished(null)
    set({ setupOpen: false })
  }
  const issues = (info?.readiness ?? []).filter((r) => r.id !== 'not-installed')

  return (
    <Modal
      title={tr(msg({ id: 'shell.setup.title', defaultMessage: 'Provider Setup', description: 'The title of Help → Provider Setup.' }))}
      icon="hubot"
      wide
      onClose={close}
      footer={
        <>
          <button className="btn subtle" onClick={() => void call('app:openExternal', p.setupUrl)}>
            <Icon name="link-external" /> {tr(msg({ id: 'shell.setup.docs', defaultMessage: '{provider} docs', description: "Provider Setup's button: opens the coding agent's own documentation. {provider} is its name." }), { provider: p.name })}
          </button>
          <div className="grow" />
          <button className="btn subtle" onClick={() => void recheck()} disabled={busy || running}>
            <Icon name={busy ? 'loading' : 'refresh'} spin={busy} /> {tr(msg({ id: 'shell.setup.checkAgain', defaultMessage: 'Check again', description: "Provider Setup's button: looks for the CLI, git and updates again." }))}
          </button>
          <button className="btn primary" onClick={close}>
            {running ? tr(msg({ id: 'shell.dialog.cancel', defaultMessage: 'Cancel', description: "A dialog's button that closes it without doing anything." })) : tr(msg({ id: 'shell.close', defaultMessage: 'Close', description: 'Closes a panel or a dialog.' }))}
          </button>
        </>
      }
    >
      {PROVIDERS.length > 1 && (
        <div className="setup-tabs">
          {PROVIDERS.map((x) => (
            <button key={x.id} className={cx('setup-tab', tab === x.id && 'selected')} disabled={running} onClick={() => { setTab(x.id); setFinished(null) }}>
              <ProviderIcon provider={x.id} /> {isProviderEnabled(settings, x.id) ? x.name : <span>{tRich(msg({ id: 'shell.setup.tabOff', defaultMessage: '{provider}<faint> (off)</faint>', description: 'A tab of Provider Setup for a provider that is turned off. {provider} is its name; <faint> is greyed.' }), { provider: x.name, faint })}</span>}
            </button>
          ))}
        </div>
      )}
      {!on && (
        <div className="banner info" style={{ borderRadius: 6, marginBottom: 10 }}>
          <Icon name="info" />
          <span>
            {tRich(msg({ id: 'shell.setup.off', defaultMessage: "{provider} is turned off, so Combwork doesn't run it. <on>Turn it on</on>", description: 'Provider Setup for a provider that is turned off. {provider} is its name; <on> is a link that turns it on.' }), {
              provider: p.name,
              on: linkTo('on', () => void call('settings:update', { providers: { [tab]: { enabled: true } } }).then((ns) => set({ settings: ns })))
            })}
          </span>
        </div>
      )}
      {on && <ConnectionSetupLine cli={tab} onOpen={close} />}
      {on && <ServerSetupLines cli={tab} />}
      {!info || info.checking ? (
        <div className="setup-status">
          <Icon name="loading" spin />
          <div>{tr(msg({ id: 'shell.setup.looking', defaultMessage: 'Looking for {provider}…', description: 'Provider Setup while Combwork looks for a CLI. {provider} is its name.' }), { provider: p.name })}</div>
        </div>
      ) : info.found ? (
        <>
        <div className="setup-status">
          <Icon name="pass-filled" className="" />
          <div className="grow">
            <div>
              {tRich(msg({ id: 'shell.setup.found', defaultMessage: '<b>{provider} {version}</b> <muted>— found via {source}</muted>', description: 'Provider Setup: the CLI Combwork found. {provider} is its name, {version} its version, {source} where it was found (PATH, an install folder); <b> is bold, <muted> greyed.' }), { provider: p.name, version: info.version ?? '', source: installSourceText(info.source, tr), b: bold, muted })}
            </div>
            <div className="setup-path muted mono" title={info.path ?? undefined}>
              {info.path}
            </div>
            {info.tested && <TestedLine tested={info.tested} installed={info.version} />}
            <div className="setup-badges">
              {info.loggedIn === true && !info.hostChecks?.length && (
                <span className="badge success" data-signin={info.authMethod ?? ''}>
                  <Icon name="account" /> {tr(msg({ id: 'shell.setup.signedInAs', defaultMessage: '{account, select, none {Signed in} other {Signed in as {account}}}{method, select, none {} other { ({method})}}', description: 'A badge in Provider Setup: the CLI is signed in. {account} is the account, {method} how it signed in (none: not known).' }), { account: info.account || 'none', method: info.authMethod || 'none' })}
                </span>
              )}
              {issues.map((r) => (
                <span key={r.id} className={cx('badge', r.level === 'error' ? 'warn' : r.level === 'warning' ? 'warn' : 'accent')}>
                  {r.message}
                </span>
              ))}
              {!info.updateAvailable && info.latestVersion && <span className="badge">{tr(msg({ id: 'shell.setup.upToDate', defaultMessage: 'Up to date', description: 'A badge in Provider Setup: the CLI is the newest version.' }))}</span>}
            </div>
            {!!info.notes?.length && (
              <div className="setup-notes">
                {info.notes.map((n) => (
                  <p key={n} className="hint">
                    {n}
                  </p>
                ))}
              </div>
            )}
          </div>
          <div className="setup-actions">
            {issues
              .filter((r) => r.action)
              .map((r) => (
                <button key={r.id} className="btn primary" disabled={running} data-host={r.action!.host ?? ''} onClick={() => void start(r.action!.task, false, r.action!.host)}>
                  {r.action!.label}
                </button>
              ))}
          </div>
        </div>
        {p.capabilities.githubHost && !!info.hostChecks?.length && <HostChecks checks={info.hostChecks} />}
        {issues
          .filter((r) => r.detail?.length)
          .map((r) => (
            <div key={r.id} className="setup-detail">
              {r.detail!.map((para, i) => (
                <p key={i} className="hint">
                  <CodeText text={para} />
                </p>
              ))}
            </div>
          ))}
        </>
      ) : (
        <>
          <div className="setup-status">
            <Icon name="warning" />
            <div className="grow">
              <strong>{tr(msg({ id: 'shell.setup.notInstalled', defaultMessage: '{provider} is not installed', description: "Provider Setup when a CLI isn't installed. {provider} is its name." }), { provider: p.name })}</strong>
              <div className="muted">{tr(msg({ id: 'shell.setup.notInstalledDetail', defaultMessage: "Combwork runs the standalone {provider} command-line tool in each project. It isn't bundled with Combwork — install it with {company}'s official installer.", description: 'Provider Setup, under "<provider> is not installed". {provider} is the coding agent\'s name, {company} its maker\'s.' }), { provider: p.name, company: p.company })}</div>
            </div>
            <button className="btn primary" disabled={running} onClick={() => void start('install')}>
              <Icon name="cloud-download" /> {tr(msg({ id: 'shell.setup.install', defaultMessage: 'Install {provider}', description: "Provider Setup's button: installs the CLI. {provider} is its name." }), { provider: p.name })}
            </button>
          </div>
          {info.editorExtensionOnly && p.extensionNote && (
            <div className="banner info" style={{ borderRadius: 6, marginBottom: 10 }}>
              <Icon name="info" />
              <span>{shownText(p.extensionNote, p.text?.extensionNote, tr)}</span>
            </div>
          )}
          {p.installNote && (
            <p className="hint" data-install-note>
              <CodeText text={shownText(p.installNote, p.text?.installNote, tr)} />
            </p>
          )}
        </>
      )}
      {!!info?.rejected?.length && (
        <p className="hint setup-wrap">
          <Icon name="info" /> {tRich(msg({ id: 'shell.setup.rejected', defaultMessage: '{n, plural, one {Ignored a copy} other {Ignored copies}} bundled with an editor extension ({path}). Combwork only uses the standalone CLI.', description: "Provider Setup when it found a CLI only inside an editor's extension. {n} is how many; {path} is where (one of them)." }), { n: info.rejected.length, path: <CopyableCode key="path" code={info.rejected[0]} /> })}
        </p>
      )}
      <GitSetupRow />
      {finished && (
        <div className={cx('banner', finished.ok ? 'success' : 'warn')} data-finished={finished.ok ? 'ok' : 'not-found'} style={{ borderRadius: 6, marginTop: 10 }}>
          <Icon name={finished.ok ? 'pass-filled' : 'warning'} />
          <span>{finished.text}</span>
        </div>
      )}
      {info?.updateRetry && !running && (
        <div className="setup-detail" data-update-retry>
          <p className="hint">{info.updateRetry.message}</p>
          <button className="btn primary" disabled={busy} onClick={() => void start('update', true)}>{info.updateRetry.label}</button>
        </div>
      )}
      {task && (
        <div className="task-terminal">
          <TerminalView ptyKey={task.key} visible onExit={() => void taskEnded()} />
        </div>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Quit
// ---------------------------------------------------------------------------

const BUSY: SessionStatus[] = ['working', 'waiting', 'background', 'watching']
/** What stopping a busy agent interrupts, in the quit dialog's table (#572). */
const STOPPING: Partial<Record<SessionStatus, Msg>> = {
  working: msg({ id: 'shell.quit.stopping.working', defaultMessage: 'Will be interrupted', description: "The quit dialog's table, What stopping it interrupts: a working agent." }),
  background: msg({ id: 'shell.quit.stopping.background', defaultMessage: 'Background tasks will stop', description: "The quit dialog's table: an agent waiting on background tasks it started." }),
  waiting: msg({ id: 'shell.quit.stopping.waiting', defaultMessage: 'Waiting for you', description: "The quit dialog's table: an agent waiting for your answer." }),
  watching: msg({ id: 'shell.quit.stopping.watching', defaultMessage: 'Its card loop pauses until it is resumed', description: "The quit dialog's table: an agent waiting on cards in a card loop." })
}

/**
 * Asks what to do with running sessions and unsaved files when Combwork quits. Main waits for
 * app:quitDecision; unsaved files are saved (or discarded) here first.
 */
export function QuitDialog() {
  const sessions = useStore((s) => s.quitRequest)
  const unsaved = useStore((s) => s.quitUnsaved)
  const scope = useStore((s) => s.quitScope)
  const windows = useStore((s) => s.windowCount)
  const workspaceName = useStore((s) => s.workspace?.name)
  // Closing a window, closing its workspace or switching it: only this workspace's sessions stop.
  const closing = scope !== 'app'
  // Quitting with several windows open closes them all: it says so, groups the agents by workspace and offers this window alone.
  const allWindows = !closing && windows > 1
  // What the dialog does, as its buttons and sentences name it.
  const closeAction = scope === 'workspace' ? 'closeWorkspace' : scope === 'switch' ? 'switchWorkspace' : 'closeWindow'
  const how = scope === 'workspace' ? 'workspace' : scope === 'switch' ? 'switch' : closing ? 'window' : windows > 1 ? 'allWindows' : 'app'
  const [dontAsk, setDontAsk] = useState(false)
  const [keep, setKeep] = useState<'save' | 'discard'>('save')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    setDontAsk(false)
    setKeep('save')
  }, [sessions])
  if (!sessions) return null
  const decide = async (choice: QuitChoice): Promise<void> => {
    if (choice !== 'cancel' && unsaved.length) {
      if (keep === 'discard') discardDrafts()
      else {
        setSaving(true)
        const r = await saveAllDrafts()
        setSaving(false)
        // Something couldn't be saved: stay open, so nothing is lost.
        if (r.failed.length) {
          notify('error', tr(msg({ id: 'shell.quit.saveFailed', defaultMessage: "{n, plural, one {Couldn't save a file, so Combwork is still open} other {Couldn't save # files, so Combwork is still open}}", description: "An error's title when quitting: unsaved files couldn't be saved, so Combwork didn't quit. The reasons are listed under it." }), { n: r.failed.length }), r.failed.map((f) => f.message).join('\n'))
          set({ quitUnsaved: r.failed.map((f) => f.abs) })
          return
        }
        // Edited while it was saving: those edits are unsaved again, so stay.
        const left = unsavedFiles()
        if (left.length) {
          notify('warning', tr(msg({ id: 'shell.quit.changedWhileSaving', defaultMessage: 'Some files changed while they were being saved', description: 'A warning when quitting: files were edited while Combwork saved them.' })), tr(msg({ id: 'shell.quit.changedWhileSavingDetail', defaultMessage: 'Combwork is still open, so your latest edits are kept. Save them, then try again.', description: 'More in the warning that files changed while they were saved.' })))
          set({ quitUnsaved: left.map((f) => f.abs) })
          return
        }
      }
    }
    set({ quitRequest: null, quitUnsaved: [] })
    void call('app:quitDecision', choice, dontAsk)
  }
  // What "when agents finish" waits for: working, background tasks, and a watcher whose card another agent is working on.
  const working = sessions.filter((s) => s.status === 'working' || s.status === 'background' || s.keepsQuitWaiting).length
  const busy = sessions.filter((s) => BUSY.includes(s.status)).length
  const action = closing ? (unsaved.length && keep === 'save' ? 'saveAndClose' : closeAction) : unsaved.length && keep === 'save' ? 'saveAndQuit' : 'quit'
  const parts = (p: string): string[] => p.split(/[\\/]/)
  // Grouped by the workspace's full path; two with the same name also show the parent folders that tell them apart.
  const groups = new Map<string, { name: string; path: string; rows: QuitSession[] }>()
  for (const s of sessions) {
    const path = allWindows ? (s.workspacePath ?? s.workspace ?? '') : ''
    const g = groups.get(path.toLowerCase()) ?? { name: allWindows ? (s.workspace ?? '') : '', path, rows: [] }
    groups.set(path.toLowerCase(), { ...g, rows: [...g.rows, s] })
  }
  const parents = distinguishingParents([...groups.values()].map((g) => g.path).filter(Boolean))
  // The agents' rows (#572), each workspace's under its name when several windows are open.
  const quitColumns: AgentColumn[] = [PROJECT_COLUMN, STATE_COLUMN, CARD_COLUMN, ...(busy ? [{ label: tr(msg({ id: 'shell.quit.stoppingColumn', defaultMessage: 'Stopping it', description: "The quit dialog's table: the heading of the column saying what stopping each agent interrupts." })) }] : [])]
  const tableRows: (AgentTableRow | AgentTableGroup)[] = []
  for (const [key, { name, path, rows }] of groups) {
    if (name) {
      const group = (
        <span className="quit-group-line">
          <Icon name="folder" /> {name}
          {parents.has(key) && <span className="quit-group-where">{parents.get(key)}</span>}
        </span>
      )
      tableRows.push({ key: `ws:${key}`, className: 'quit-group', title: path, group, text: parents.has(key) ? `${name} (${parents.get(key)})` : name })
    }
    for (const s of rows)
      tableRows.push({
        key: `${s.projectPath}:${s.agentId ?? s.agent ?? ''}`,
        name: s.agent ?? s.project,
        dot: s.status,
        className: 'quit-row',
        cells: [{ text: s.agent ? s.project : '' }, { text: s.status === 'watching' && s.watch ? s.watch : STATUS_TEXT[s.status] }, { text: s.card ?? '' }, ...(busy ? [{ text: STOPPING[s.status] ? tr(STOPPING[s.status]!) : '', warn: true }] : [])]
      })
  }
  return (
    <Modal
      title={tr(msg({ id: 'shell.quit.title', defaultMessage: '{how, select, workspace {Close this workspace?} switch {Switch workspace?} window {Close this window?} allWindows {Quit Combwork and close all {windows} windows?} other {Quit Combwork?}}', description: "The quit dialog's title: closing the workspace, switching it, closing the window, or quitting Combwork (with {windows} windows open, 2 or more)." }), { how, windows })}
      icon={busy || unsaved.length ? 'warning' : 'sign-out'}
      wide={sessions.length > 0}
      onClose={() => void decide('cancel')}
      footer={
        <>
          {sessions.length > 0 && !closing && (
            <label className="quit-dontask" title={unsaved.length ? tr(msg({ id: 'shell.quit.alwaysAsks', defaultMessage: 'Combwork always asks about unsaved files.', description: 'Tooltip of the quit dialog\'s "Don\'t ask again" box while files are unsaved.' })) : undefined}>
              <input type="checkbox" className="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} /> {tr(msg({ id: 'shell.quit.dontAsk', defaultMessage: "Don't ask again about sessions", description: 'A box in the quit dialog: next time, quit without asking about running sessions.' }))}
            </label>
          )}
          <button className="btn subtle" onClick={() => void decide('cancel')} disabled={saving}>
            {tr(msg({ id: 'shell.dialog.cancel', defaultMessage: 'Cancel', description: "A dialog's button that closes it without doing anything." }))}
          </button>
          {working > 0 && !closing && (
            <button className="btn subtle" onClick={() => void decide('wait')} disabled={saving} title={tr(msg({ id: 'shell.quit.whenTip', defaultMessage: 'Hide Combwork and quit as soon as no agent is working', description: "Tooltip of the quit dialog's button that quits once the agents finish." }))}>
              <Icon name="watch" /> {tr(msg({ id: 'shell.quit.when', defaultMessage: '{action, select, saveAndClose {Save and close} closeWorkspace {Close workspace} switchWorkspace {Switch workspace} closeWindow {Close window} saveAndQuit {Save and quit} other {Quit}} when {working, plural, one {the agent finishes} other {agents finish}}', description: "The quit dialog's button: quit once the working agents finish. {action} picks what it does (quit, or save and quit); {working} is how many agents are working." }), { action, working })}
            </button>
          )}
          <button className={cx('btn', busy || (unsaved.length > 0 && keep === 'discard') ? 'danger' : 'primary')} autoFocus onClick={() => void decide('now')} disabled={saving}>
            {saving ? tr(msg({ id: 'shell.quit.saving', defaultMessage: 'Saving…', description: "The quit dialog's button while unsaved files are saved." })) : sessions.length ? tr(msg({ id: 'shell.quit.now', defaultMessage: '{action, select, saveAndClose {Save and close now} closeWorkspace {Close workspace now} switchWorkspace {Switch workspace now} closeWindow {Close window now} saveAndQuit {Save and quit now} other {Quit now}}', description: "The quit dialog's main button with sessions running: do it now, stopping them. {action} picks what it does." }), { action }) : tr(msg({ id: 'shell.quit.action', defaultMessage: '{action, select, saveAndClose {Save and close} closeWorkspace {Close workspace} switchWorkspace {Switch workspace} closeWindow {Close window} saveAndQuit {Save and quit} other {Quit}}', description: "The quit dialog's main button with no sessions running. {action} picks what it does." }), { action })}
          </button>
        </>
      }
    >
      {unsaved.length > 0 && (
        <div className="quit-unsaved">
          <p style={{ marginTop: 0 }}>
            <strong>{tr(msg({ id: 'shell.quit.unsaved', defaultMessage: '{n, plural, one {# file has unsaved changes.} other {# files have unsaved changes.}}', description: 'The quit dialog: how many open files have unsaved edits (listed under it).' }), { n: unsaved.length })}</strong>
          </p>
          <div className="quit-list">
            {unsaved.map((p) => (
              <div key={p} className="quit-row" title={p}>
                <Icon name="file" />
                <strong>{parts(p).pop()}</strong>
                <span className="faint">{parts(p).slice(-3, -1).join('/')}</span>
              </div>
            ))}
          </div>
          <div className="segmented quit-unsaved-choice">
            <button className={cx(keep === 'save' && 'active')} onClick={() => setKeep('save')}>
              <Icon name="save" /> {tr(msg({ id: 'shell.quit.saveThem', defaultMessage: 'Save them', description: "The quit dialog's choice: save the unsaved files first." }))}
            </button>
            <button className={cx(keep === 'discard' && 'active')} onClick={() => setKeep('discard')}>
              <Icon name="discard" /> {tr(msg({ id: 'shell.quit.discard', defaultMessage: 'Discard the changes', description: "The quit dialog's choice: drop the unsaved edits." }))}
            </button>
          </div>
        </div>
      )}
      {sessions.length > 0 && (
        <p style={{ marginTop: unsaved.length ? undefined : 0 }}>
          {busy ? `${tr(msg({ id: 'shell.quit.busy', defaultMessage: '{n, plural, one {An agent is in the middle of something.} other {# agents are in the middle of something.}}', description: 'The quit dialog: how many agents are busy (working, waiting for you…).' }), { n: busy })} ` : ''}
          {tr(msg({ id: 'shell.quit.stops', defaultMessage: "{how, select, workspace {{busy, select, yes {{n, plural, one {Closing the workspace stops its session.} other {Closing the workspace stops its # sessions.}}} other {{n, plural, one {Closing the workspace stops its running session.} other {Closing the workspace stops its # running sessions.}}}}} switch {{busy, select, yes {{n, plural, one {Switching workspace stops this workspace's session.} other {Switching workspace stops this workspace's # sessions.}}} other {{n, plural, one {Switching workspace stops this workspace's running session.} other {Switching workspace stops this workspace's # running sessions.}}}}} window {{busy, select, yes {{n, plural, one {Closing this window stops this workspace's session.} other {Closing this window stops this workspace's # sessions.}}} other {{n, plural, one {Closing this window stops this workspace's running session.} other {Closing this window stops this workspace's # running sessions.}}}}} allWindows {{windows, plural, other {{busy, select, yes {{n, plural, one {Quitting closes all {windows, number} windows and stops its session.} other {Quitting closes all {windows, number} windows and stops all # sessions, in every workspace.}}} other {{n, plural, one {Quitting closes all {windows, number} windows and stops the running session.} other {Quitting closes all {windows, number} windows and stops # running sessions, in every workspace.}}}}}}} other {{busy, select, yes {{n, plural, one {Quitting stops its session.} other {Quitting stops all # sessions.}}} other {{n, plural, one {Quitting stops the running session.} other {Quitting stops # running sessions.}}}}}}", description: 'The quit dialog: what closing or quitting stops, a sentence each. {how} is what it does: close the workspace, switch it, close the window, quit with {windows} windows open (allWindows: their sessions in every workspace stop; a plural on {windows}, for the word windows) or quit (other); {busy} is yes when an agent is busy (then the sentence before says so, and "its session" is that agent\'s); {n} is how many sessions.' }), { how, windows, busy: busy ? 'yes' : 'no', n: sessions.length })}
        </p>
      )}
      {/* The agents as a table (#572): Agent · Project · State · Card · what stopping it interrupts, under their workspace
          when several windows are open; its plain text, grouped the same way, for screen readers. */}
      <div className="quit-agents" hidden={!sessions.length}>
        <AgentsDetail data={{ columns: quitColumns, rows: tableRows }} />
      </div>
      {allWindows && (
        // In the body, not the footer: beside Cancel, Quit when agents finish and Quit now it would push the footer out of the dialog.
        <div className="quit-window-only">
          <span className="grow">{tr(msg({ id: 'shell.quit.windowOnly', defaultMessage: '{named, select, yes {Meant to close only this window ({workspace})?} other {Meant to close only this window?}} Its agents stop, and the other {others, plural, one {window stays} other {# windows stay}} open, as with its X.', description: "The quit dialog with several windows open: closing just this one instead. {workspace} is its workspace's name; {others} how many other windows stay open; its X is the window's close button." }), { named: workspaceName ? 'yes' : 'no', workspace: workspaceName ?? '', others: windows - 1 })}</span>
          <button className="btn small subtle" onClick={() => void decide('window')} disabled={saving}>
            <Icon name="close" /> {tr(msg({ id: 'shell.quit.windowOnlyButton', defaultMessage: 'Close this window only', description: "The quit dialog's button that closes just this window." }))}
          </button>
        </div>
      )}
      {sessions.length > 0 && <div className="detail">{tr(msg({ id: 'shell.quit.kept', defaultMessage: 'Conversations are kept. Resume them from the project or its Sessions tab next time.', description: 'At the bottom of the quit dialog.' }))}</div>}
    </Modal>
  )
}

/** Shown if the window is opened while Combwork waits for agents to finish before quitting. */
export function QuitPendingBanner() {
  const pending = useStore((s) => s.quitPending)
  if (!pending) return null
  return (
    <div className="banner info quit-pending">
      <Icon name="watch" /> {tr(msg({ id: 'shell.quitPending.text', defaultMessage: '{n, plural, one {Combwork will quit when the working agent finishes.} other {Combwork will quit when # working agents finish.}}', description: 'A banner while Combwork waits for agents to finish before it quits.' }), { n: pending.working })}
      <button className="btn small" onClick={() => void call('app:cancelPendingQuit')}>
        {tr(msg({ id: 'shell.dialog.cancel', defaultMessage: 'Cancel', description: "A dialog's button that closes it without doing anything." }))}
      </button>
      <button className="btn small primary" onClick={() => void call('app:quit')}>
        {tr(msg({ id: 'shell.quitPending.now', defaultMessage: 'Quit now', description: "The banner's button: quits without waiting." }))}
      </button>
    </div>
  )
}

/**
 * What stands between you and running agents, until it is fixed: no provider turned on, none of those turned on
 * installed, or a provider in use (the default for new agents, or an agent's, #474) that isn't installed, isn't signed
 * in or needs its one-time setup. A provider only turned on isn't warned about. Not dismissable.
 */
export function ProvidersBanner() {
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const warn = useProviderWarnings()
  if (!settings) return null
  const on = enabledProviders(settings)
  if (!on.length) {
    return (
      <div className="banner warn wrap-banner providers-banner">
        <span className="wrap-banner-text">
          <Icon name="hubot" />
          <span className="grow">{tr(msg({ id: 'shell.providers.noneOn', defaultMessage: 'No coding agents are turned on. Choose the ones you use (Claude Code, …) to run sessions.', description: 'A banner when no provider is turned on.' }))}</span>
        </span>
        <span className="wrap-banner-actions">
          <button className="btn small primary" onClick={() => runCommand('settings.providers')}>
            {tr(msg({ id: 'shell.providers.choose', defaultMessage: 'Choose providers', description: "The banner's button: opens Settings → Providers." }))}
          </button>
        </span>
      </div>
    )
  }
  if (warn.noneInstalled) {
    return (
      <div className="banner warn wrap-banner providers-banner" data-none-installed="">
        <span className="wrap-banner-text">
          <Icon name="hubot" />
          <span className="grow">{tr(msg({ id: 'shell.providers.noneInstalled', defaultMessage: '{several, select, yes {No coding agent CLI is installed. Install one of those you turned on to run agents.} other {No coding agent CLI is installed. Install {provider} to run agents.}}', description: "A banner when no turned-on provider's CLI is installed. {provider} is the one turned on, when only one is." }), { several: on.length > 1 ? 'yes' : 'no', provider: on[0].name })}</span>
        </span>
        <span className="wrap-banner-actions">
          <button className="btn small primary" onClick={() => set({ setupOpen: on[0].id })}>
            {tr(msg({ id: 'shell.providers.setup', defaultMessage: 'Provider Setup', description: "The banner's button: opens Provider Setup." }))}
          </button>
        </span>
      </div>
    )
  }
  const issues = warn.providers.flatMap((p) => {
    const info = providers[p.id]
    if (!info || info.checking) return []
    return (info.readiness ?? []).filter((r) => r.level !== 'info').map((r) => ({ p, r }))
  })
  if (!issues.length) return null
  return (
    <>
      {issues.map(({ p, r }) => (
        <div key={`${p.id}:${r.id}`} className={cx('banner wrap-banner providers-banner' /* i18n-ignore: class names */, r.level === 'error' ? 'warn' : 'info')}>
          <span className="wrap-banner-text">
            <ProviderIcon provider={p.id} />
            <span className="grow">{r.message}</span>
          </span>
          <span className="wrap-banner-actions">
            <button className="btn small primary" onClick={() => set({ setupOpen: p.id })}>
              {r.action?.label ?? tr(msg({ id: 'shell.providers.setUp', defaultMessage: 'Set up', description: "A provider's banner's button when Combwork names no other action: opens Provider Setup." }))}
            </button>
          </span>
        </div>
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// Compact
// ---------------------------------------------------------------------------

/** Confirms a manual compaction, with an optional focus for the summary. */
export function CompactDialog() {
  const target = useStore((s) => s.compactFor)
  const path = target ? `${target.project}#${target.agentId}` : null
  const project = useStore((s) => findProject(s, s.compactFor?.project))
  const agent = project?.agents.find((a) => a.id === target?.agentId) ?? null
  const ttl = useStore((s) => s.settings?.sessions.cacheTtl ?? 'auto')
  const usage = useLiveUsage(project, target?.agentId)
  const provider = providerDescriptor(agent?.live?.provider)
  const [focus, setFocus] = useState('')
  const action = useBusy()
  const { setError: setCompactError } = action
  useEffect(() => {
    setFocus('')
    setCompactError(null)
  }, [path, setCompactError])
  if (!path || !project || !agent) return null
  const close = (): void => set({ compactFor: null })
  const live = agent.live
  // A watching agent can be compacted: its watch is kept, and a wake waits for the compaction to end.
  const idle = !!live && (live.status === 'ready' || live.status === 'finished' || live.status === 'watching')
  const cache = usage && provider.capabilities.promptCacheTtl ? cacheState(usage, ttl) : null
  const focusOk = provider.capabilities.compactFocus
  const run = async (): Promise<void> => {
    const r = await action.run('compact', () => call('session:compact', project.path, (focusOk && focus.trim()) || undefined, agent.id))
    if (r) close()
  }
  return (
    <Modal
      title={tr(msg({ id: 'shell.compact.title', defaultMessage: '{several, select, yes {Compact {project} · {agent}?} other {Compact {project}?}}', description: "The title of the Compact dialog: compacting an agent's conversation. {project} is the project, {agent} the agent (named when the project has several)." }), { several: project.agents.length > 1 ? 'yes' : 'no', project: project.name, agent: agent.name })}
      icon="fold"
      onClose={close}
      busy={!!action.busy}
      error={action.error}
      footer={
        <>
          <button className="btn subtle" onClick={close}>
            {tr(msg({ id: 'shell.dialog.cancel', defaultMessage: 'Cancel', description: "A dialog's button that closes it without doing anything." }))}
          </button>
          <BusyButton className="primary" disabled={!idle} busy={action.busy === 'compact'} busyLabel={tr(msg({ id: 'shell.compact.sending', defaultMessage: 'Sending…', description: "The Compact dialog's button while it asks the agent to compact." }))} onClick={() => void run()}>
            <Icon name="fold" /> {tr(msg({ id: 'shell.compact.button', defaultMessage: 'Compact', description: "The Compact dialog's button." }))}
          </BusyButton>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>{tr(msg({ id: 'shell.compact.what', defaultMessage: "The agent summarises the conversation so far and continues from the summary, which makes every later message cheaper. The full history stays in the session's transcript.", description: 'The Compact dialog: what compacting does.' }))}</p>
      {usage && (
        <div className="compact-facts">
          <span>
            <Icon name="dashboard" /> {tRich(msg({ id: 'shell.compact.context', defaultMessage: 'Context <b>{tokens}</b> tokens', description: "The Compact dialog: how big the conversation's context is. {tokens} is a number of tokens, shortened (148k); <b> is bold." }), { tokens: formatTokens(usage.contextTokens), b: bold })}
          </span>
          {cache && (
            <span className={cx(cache.warm ? 'ok' : 'warn')}>
              <Icon name={cache.warm ? 'flame' : 'clock'} /> {cache.warm ? tr(msg({ id: 'shell.compact.cacheWarm', defaultMessage: 'Cache warm ({minutes} min left), so compacting is cheap', description: 'The Compact dialog: the prompt cache is still warm. {minutes} is how many minutes it has left.' }), { minutes: Math.ceil(cache.secondsLeft / 60) }) : tr(msg({ id: 'shell.compact.cacheExpired', defaultMessage: 'Cache expired: compacting re-reads the whole context once', description: 'The Compact dialog: the prompt cache has expired.' }))}
            </span>
          )}
          {usage.compactions.length > 0 && (
            <span>
              <Icon name="history" /> {tr(msg({ id: 'shell.compact.before', defaultMessage: '{n, plural, one {Compacted # time before} other {Compacted # times before}}', description: 'The Compact dialog: how often this conversation was compacted already.' }), { n: usage.compactions.length })}
            </span>
          )}
        </div>
      )}
      {focusOk && (
      <label className="compact-focus">
        <span>
          {tRich(msg({ id: 'shell.compact.focus', defaultMessage: 'Focus <faint>(optional)</faint>', description: "The Compact dialog's box for what the summary should keep. <faint> is greyed." }), { faint })}
        </span>
        <textarea
          className="input"
          rows={3}
          value={focus}
          autoFocus
          placeholder={tr(msg({ id: 'shell.compact.focusPlaceholder', defaultMessage: 'Leave empty and the agent decides what to keep. Or steer it, e.g. “keep the Files tab decisions and open bugs; drop the test runs”.', description: "Placeholder of the Compact dialog's Focus box." }))}
          onChange={(e) => setFocus(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && idle) void run()
          }}
        />
      </label>
      )}
      {!idle && <div className="detail">{tr(msg({ id: 'shell.compact.busy', defaultMessage: 'The agent is busy. Compact once it has finished.', description: 'The Compact dialog while the agent works.' }))}</div>}
      <div className="detail">{tr(msg({ id: 'shell.compact.typed', defaultMessage: 'Anything you had half-typed in the session is cleared first; press Ctrl+Y in the session to get it back.', description: 'At the bottom of the Compact dialog. Ctrl+Y is a key: keep it.' }))}</div>
    </Modal>
  )
}
