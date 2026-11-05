import { Children } from 'react'
import { DELIVER_WORKSPACE_NOTES, WORKSPACE_NOTES_MAX_ID } from '@shared/advanced'
import { fmt, tr, tRich } from '@shared/i18n'
import { msg } from '@shared/i18n/msg'
import { deliveredNotes, notesFor } from '@shared/workspaceNotes'
import { useAdvancedValue } from '../advanced'
import { NO_PROJECTS, useStore } from '../store'

const M = {
  title: msg({ id: 'workspace.notes.workspaceNotes.title', defaultMessage: 'Workspace notes', description: "The title of the shared note Combwork gives every agent when it starts (notes about this machine), over its editor. Keep Workspace notes in English: it is the note's name (its file is Workspace notes.md) and what agents are told." }),
  template: msg({
    id: 'workspace.notes.workspaceNotes.template',
    defaultMessage: "# Workspace notes\n\nNotes about this machine that every agent should know: a full path a command needs, a local tool's version. Rules for anyone who works on a project belong in its AGENTS.md instead.\n",
    description: "The text a new Workspace notes note starts with, which the user edits (Markdown: keep the # heading line and the blank lines). Keep Workspace notes in English (the note's name) and AGENTS.md (a file name)."
  }),
  how: msg({
    id: 'workspace.notes.workspaceNotes.how',
    defaultMessage: "Every agent and the Assistant get this note in their instructions when they start, on every coding agent and in any folder. A project's agents get the parts for everyone and the section headed with their project's name (<code>## {example}</code>). A change reaches each agent's next launch or new conversation: running agents keep what they started with.",
    description: "Above the Workspace notes note's editor: who gets it and when. <code> marks a Markdown heading: keep ## and the project name {example} as they are."
  }),
  off: msg({ id: 'workspace.notes.workspaceNotes.off', defaultMessage: "Delivering it is turned off (Settings → Advanced → Deliver workspace notes to agents): agents don't get it.", description: "Above the Workspace notes note's editor when its delivery is switched off. Names a setting: use its words as Settings shows them." }),
  cut: msg({
    id: 'workspace.notes.workspaceNotes.cut',
    defaultMessage: 'Over {max, number} bytes for {who}: they get it cut, and are told to read the note for the rest.',
    description: "A warning above the Workspace notes note's editor, as you type: what an agent gets of it is longer than the limit (Settings → Advanced). {max} is the limit in bytes, {who} the projects (a list, in the language's way) or the Assistant."
  }),
  assistant: msg({ id: 'workspace.notes.workspaceNotes.assistant', defaultMessage: 'the Assistant', description: 'In the warning that the Workspace notes note is cut for some: the Combwork Assistant, which gets the whole note.' })
}

const codeTag = (c: React.ReactNode[]): React.ReactNode => <code>{c}</code>

/** The Workspace notes note's title, for its editor. */
export const workspaceNotesTitle = (): string => tr(M.title)

/** What a new Workspace notes note starts with. */
export const workspaceNotesTemplate = (): string => tr(M.template)

/**
 * Above the Workspace notes note (#1433), from its text as typed: who gets it and when, whether it is switched off, and
 * which projects' agents (or the Assistant, which gets it whole) would get it cut at the limit.
 */
export function WorkspaceNotesNotice({ text }: { text: string }) {
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  const on = useAdvancedValue<boolean>(DELIVER_WORKSPACE_NOTES)
  const max = useAdvancedValue<number>(WORKSPACE_NOTES_MAX_ID)
  const names = projects.map((p) => p.name)
  const over = [...names.filter((n) => deliveredNotes(notesFor(text, n, names), max).cut), ...(deliveredNotes(notesFor(text, null, names), max).cut ? [tr(M.assistant)] : [])]
  return (
    <div className="workspace-notes-notice" data-workspace-notes-notice>
      <div className="banner info">
        <span>{Children.toArray(tRich<React.ReactNode>(M.how, { example: names[0] ?? '…', code: codeTag }))}</span>
      </div>
      {!on && <div className="banner warn" data-workspace-notes-off>{tr(M.off)}</div>}
      {on && over.length > 0 && (
        <div className="banner warn" data-workspace-notes-cut>
          {tr(M.cut, { max, who: fmt.list(over) })}
        </div>
      )}
    </div>
  )
}

/** The notice as DocEditor takes it (`notice`). */
export const workspaceNotesNotice = (text: string): React.ReactNode => <WorkspaceNotesNotice text={text} />
