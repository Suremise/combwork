import { useEffect, useState } from 'react'
import type { SetAsideCard } from '@shared/types'
import { BY_TEXT } from '@shared/taskHistory'
import { columnName } from '@shared/tasks'
import { formatDateTime } from '@shared/dates'
import { msg, tr } from '@shared/i18n'
import { call } from '../api'
import { confirm, loadTasks, notify, set, useDateStyle, useLanguage, useStore } from '../store'
import { BusyButton, Icon, Markdown, Modal, useBusy } from './ui'

/**
 * Cards an older Hive saved after the board moved to its database (#1017's downgrade), set aside in
 * `.hive/tasks.set-aside`: the Review… dialog (#1044, Darren's decision on #1017) is the only way they reach the board.
 * Each is added as a new card (its old number if free, else the next; "Added by Repair" in its history) or discarded,
 * after a confirmation. Nothing else is rewritten: links to an old number stay as they are.
 */

const M = {
  title: msg({ id: 'board.setAside.title', defaultMessage: 'Cards Made by an Older Combwork', description: "Title of the dialog listing cards an older version of Hive saved in this workspace after the board moved to its database; they were kept aside, not added to the board." }),
  intro: msg({ id: 'board.setAside.intro', defaultMessage: 'This workspace was opened in an older Combwork, which saved these cards where it keeps them. They were set aside, unchanged, and not added to the board. Add each one, or discard it.', description: 'The top of the dialog listing cards an older Hive saved.' }),
  links: msg({ id: 'board.setAside.links', defaultMessage: "Nothing is rewritten for them: a card here that links to one by its old number keeps that number, and a card added under a new number keeps its own links as they were.", description: 'A note in the dialog listing cards an older Hive saved: Hive changes no references between cards when adding them.' }),
  none: msg({ id: 'board.setAside.none', defaultMessage: 'No cards are set aside.', description: 'The dialog listing cards an older Hive saved, when none are left.' }),
  loading: msg({ id: 'board.setAside.loading', defaultMessage: 'Reading the set-aside cards…', description: 'The dialog listing cards an older Hive saved, while it reads them.' }),
  number: msg({ id: 'board.setAside.number', defaultMessage: '#{n} in the older Combwork', description: "A set-aside card's number as the older Hive gave it. {n} is the number (after #)." }),
  keeps: msg({ id: 'board.setAside.keeps', defaultMessage: 'Add keeps #{n}', description: "Beside a set-aside card: its old number {n} is free on this board, so Add gives it that number." }),
  taken: msg({ id: 'board.setAside.taken', defaultMessage: '#{n} is taken here: Add gives the next free number', description: "Beside a set-aside card: a card on this board has its old number {n}, so Add gives it a new one." }),
  made: msg({ id: 'board.setAside.made', defaultMessage: 'Made by {by} on {when}', description: "Who made a set-aside card ({by}: a name, You or Assistant) and when ({when}: a date and time)." }),
  where: msg({ id: 'board.setAside.where', defaultMessage: '{project, select, none {The workspace} other {{project}}} · {column} · {comments, plural, =0 {no comments} one {# comment} other {# comments}}', description: "A set-aside card's project (a folder name; none: about the whole workspace), its board column, and how many comments it has." }),
  unreadable: msg({ id: 'board.setAside.unreadable', defaultMessage: "This file isn't a card Combwork can read: it can only be discarded.", description: 'A set-aside file that is not a valid card.' }),
  add: msg({ id: 'board.setAside.add', defaultMessage: 'Add to Board', description: 'Button: adds the set-aside card to the board as a new card.' }),
  adding: msg({ id: 'board.setAside.adding', defaultMessage: 'Adding…', description: 'The Add to Board button while the card is being added.' }),
  discard: msg({ id: 'board.setAside.discard', defaultMessage: 'Discard…', description: 'Button: discards the set-aside card (asks first). The … says it asks: keep it.' }),
  added: msg({ id: 'board.setAside.added', defaultMessage: 'Added as #{n}', description: 'A notification: the set-aside card was added to the board with this number.' }),
  discardTitle: msg({ id: 'board.setAside.discardTitle', defaultMessage: 'Discard "{title}"?', description: "Title of the confirmation before a set-aside card is discarded. {title} is its title." }),
  discardMessage: msg({ id: 'board.setAside.discardMessage', defaultMessage: "It doesn't reach the board: its file goes to the Recycle Bin{readable, select, yes {, with its comments and history} other {}}.", description: 'The confirmation before a set-aside card is discarded; readable (yes) when it is a card, not a damaged file. Recycle Bin is Windows\' name for it.' }),
  discardButton: msg({ id: 'board.setAside.discardButton', defaultMessage: 'Discard', description: 'Button in the confirmation: discards the set-aside card.' }),
  discarding: msg({ id: 'board.setAside.discarding', defaultMessage: 'Discarding…', description: 'The Discard button while the card is being discarded.' }),
  close: msg({ id: 'board.setAside.close', defaultMessage: 'Close', description: 'Button: closes the dialog listing set-aside cards.' })
}

/** The board's ⋯ menu item while any are set aside. */
export const SET_ASIDE_ITEM = msg({ id: 'board.setAside.menu', defaultMessage: 'Set-Aside Cards ({n, number})…', description: "An item of the board's ⋯ menu, shown while cards an older Hive saved are set aside: opens the dialog to add or discard them. {n} is how many. The … says it opens a dialog: keep it." })

const byText = (by: string): string => (Object.hasOwn(BY_TEXT, by) ? tr(BY_TEXT[by]) : by)

export function SetAsideDialog() {
  useLanguage()
  useDateStyle()
  const open = useStore((s) => s.setAsideOpen)
  // Read again whenever the board changes (another window added one, a card took a number).
  const tasks = useStore((s) => s.tasks)
  const [cards, setCards] = useState<SetAsideCard[] | null>(null)
  const action = useBusy()
  const { run, setError } = action
  useEffect(() => {
    if (!open) return setCards(null)
    setError(null)
    let live = true
    call('tasks:setAside').then(
      (c) => live && setCards(c),
      (e) => live && setError(String(e))
    )
    return () => {
      live = false
    }
  }, [open, tasks, setError])
  if (!open) return null
  const close = (): void => set({ setAsideOpen: false })
  const add = async (c: SetAsideCard): Promise<void> => {
    const r = await run(c.file, () => call('tasks:addSetAside', c.file))
    if (!r) return
    setCards((list) => list?.filter((x) => x.file !== c.file) ?? null)
    notify('success', tr(M.added, { n: r.value.number }), r.value.title)
    await loadTasks()
  }
  const discard = (c: SetAsideCard): void => {
    void confirm({
      title: tr(M.discardTitle, { title: c.title }),
      message: tr(M.discardMessage, { readable: c.readable ? 'yes' : 'no' }),
      confirmLabel: tr(M.discardButton),
      busyLabel: tr(M.discarding),
      danger: true,
      run: async () => {
        await call('tasks:discardSetAside', c.file)
        setCards((list) => list?.filter((x) => x.file !== c.file) ?? null)
      }
    })
  }
  const footer = (
    <button className="btn primary" onClick={close} autoFocus>
      {tr(M.close)}
    </button>
  )
  return (
    <Modal title={tr(M.title)} icon="archive" onClose={close} footer={footer} wide error={action.error}>
      <div className="set-aside">
        <p>{tr(M.intro)}</p>
        <p className="hint">{tr(M.links)}</p>
        {cards === null ? (
          <p className="faint">
            <Icon name="loading" spin /> {tr(M.loading)}
          </p>
        ) : !cards.length ? (
          <p>{tr(M.none)}</p>
        ) : (
          <ul className="set-aside-list">
            {cards.map((c) => (
              <li key={c.file} className="set-aside-card" data-file={c.file}>
                <div className="set-aside-head">
                  <span className="set-aside-number">{tr(M.number, { n: c.number ?? 0 })}</span>
                  <strong className="set-aside-title">{c.title}</strong>
                </div>
                {c.readable ? (
                  <>
                    <div className="faint">
                      {tr(M.made, { by: byText(c.createdBy), when: c.createdAt ? formatDateTime(c.createdAt) : '' })} · {tr(M.where, { project: c.project || 'none', column: columnName(c.column, tr), comments: c.comments })}
                    </div>
                    {c.preview.trim() && (
                      <div className="set-aside-preview">
                        <Markdown source={c.preview} />
                      </div>
                    )}
                    <div className="set-aside-number-note">
                      <Icon name={c.free ? 'check' : 'info'} /> {c.number !== null && tr(c.free ? M.keeps : M.taken, { n: c.number })}
                    </div>
                  </>
                ) : (
                  <div className="warn-text">
                    <Icon name="warning" /> {tr(M.unreadable)}
                  </div>
                )}
                <div className="set-aside-actions">
                  {c.readable && (
                    <BusyButton className="small primary" busy={action.busy === c.file} busyLabel={tr(M.adding)} disabled={!!action.busy} onClick={() => void add(c)}>
                      {tr(M.add)}
                    </BusyButton>
                  )}
                  <button className="btn small" disabled={!!action.busy} onClick={() => discard(c)}>
                    {tr(M.discard)}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
