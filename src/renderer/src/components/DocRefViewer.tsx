import { useEffect, useState } from 'react'
import { parseDocRef } from '@shared/docRefs'
import type { CombworkRequests } from '@shared/api'
import type { ContextProblem } from '@shared/types'
import { fmt, msg, tr } from '@shared/i18n'
import { call, errorMessage } from '../api'
import { openFileLink } from '../fileLinks'
import { get, set, showView, useLanguage } from '../store'
import { Markdown, Modal } from './ui'
import { CW_DIR } from '@shared/defaults'

type Section = Awaited<ReturnType<CombworkRequests['docs:section']>>

const M = {
  open: msg({ id: 'board.context.open', defaultMessage: 'Open in Files', description: "Button in the doc section viewer (a card's Read first reference, #818): opens the project's file in the Files tab, at the section." }),
  openNote: msg({ id: 'board.context.openNote', defaultMessage: 'Open in Shared Notes', description: "Button in the doc section viewer (a card's Read first reference to a shared note, #818): opens the note in the Shared Notes view." }),
  close: msg({ id: 'board.context.close', defaultMessage: 'Close', description: 'Button: closes the doc section viewer.' }),
  loading: msg({ id: 'board.context.loading', defaultMessage: 'Reading…', description: 'The doc section viewer while it reads the section.' })
}

/** Why a card's Read first reference doesn't lead to a section (#818, #819): the viewer's, the card's and its tile's words. */
export const PROBLEM = msg({
  id: 'board.context.problem',
  defaultMessage:
    "{why, select, noHeading {That heading isn't in the file} ambiguous {Several headings have that heading's text, so the reference may mean another} notFound {The file isn't there} notMarkdown {It isn't a Markdown file} invalid {It isn't a doc section (a Markdown file, optionally with # and a heading's slug)} tooBig {The file is too big to read} other {It can't be read here}}.{closest, select, none {} other { {why, select, ambiguous {They are} other {Closest headings}}: {closest}.}}",
  description:
    "Why a card's Read first reference doesn't lead to a section (#818, #819; the section viewer, the card dialog, a card's tooltip): why ({why}, select: translate each; ambiguous: two headings now have the same text) and the closest headings' slugs, or for ambiguous the headings with that text ({closest}; none: leave that branch empty)."
})

/** A card's Read first problems, one a line: "docs/PLAN.md#setup: That heading isn't in the file. Closest headings: #install." */
export const problemLines = (problems: readonly ContextProblem[]): string[] =>
  problems.map((p) => `${p.ref}: ${tr(PROBLEM, { why: p.problem, closest: p.closest?.length ? fmt.list(p.closest.map((s) => `#${s}`)) : 'none' })}`) // i18n-ignore: a reference and its message, joined

/**
 * A card's Read first reference (#818), read: the section (the whole document when it names no heading) in Combwork's
 * Markdown, with a button to open its file in the Files tab at the heading, or a shared note in Shared Notes.
 */
export function DocRefViewer({ projectPath, docRef, onClose, onOpen }: { projectPath: string | null; docRef: string; onClose: () => void; onOpen?: (go: () => void) => void }) {
  useLanguage()
  const [section, setSection] = useState<Section | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    call('docs:section', projectPath, docRef).then(
      (s) => live && setSection(s),
      (e) => live && setError(errorMessage(e))
    )
    return () => {
      live = false
    }
  }, [projectPath, docRef])
  const parsed = parseDocRef(docRef)
  const shared = !!parsed?.path.startsWith('shared:')
  const line = section && 'line' in section ? section.line : undefined
  const go = (): void => {
    if (!parsed) return
    if (shared) {
      const ws = get().workspace?.path
      if (!ws) return
      showView('notes')
      set({ selectedNote: [ws, CW_DIR, 'shared', ...parsed.path.slice('shared:'.length).split('/')].join('\\') })
    } else if (projectPath) openFileLink({ project: projectPath, agentId: null, root: projectPath, rel: parsed.path }, line)
  }
  // The viewer closes, then whatever it opens over (the card dialog) closes the way it does, asking about unsaved edits:
  // only then is the file or note shown, so nothing is left covering it.
  const open = (): void => {
    onClose()
    if (onOpen) onOpen(go)
    else go()
  }
  return (
    <Modal
      title={docRef}
      icon="book"
      wide
      onClose={onClose}
      error={error}
      footer={
        <>
          {parsed && (shared || projectPath) && (
            <button className="btn" onClick={open}>
              {tr(shared ? M.openNote : M.open)}
            </button>
          )}
          <button className="btn solid" onClick={onClose}>
            {tr(M.close)}
          </button>
        </>
      }
    >
      {!section && !error && <p className="faint">{tr(M.loading)}</p>}
      {section && 'content' in section && <Markdown className="doc-ref-section" source={section.content} />}
      {section && 'problem' in section && <p className="banner warn">{tr(PROBLEM, { why: section.problem, closest: section.closest?.length ? fmt.list(section.closest.map((s) => `#${s}`)) : 'none' })}</p>}
    </Modal>
  )
}
