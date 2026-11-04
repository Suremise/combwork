import { useState } from 'react'
import { HIVE_FOLDER_GUIDE, hiveVcsKey, hiveVcsText } from '@shared/hiveVcsText'
import { msg, tr } from '@shared/i18n'
import type { ProjectInfo } from '@shared/types'
import { call, errorMessage } from '../api'
import { rememberProjectPref } from '../projectPrefs'
import { confirm, notify, set, useStore } from '../store'
import { openGuideAt } from '../tips'
import { BusyButton, Icon, IconButton, sentences } from './ui'

const M = {
  titleSentence: msg({ id: 'git.hiveVcs.titleSentence', defaultMessage: '{title}.', description: "The .combwork notice's title as the first sentence of the notice, in bold: {title} with the full stop your language ends a sentence with." }),
  excluded: msg({ id: 'git.hiveVcs.excludedDone', defaultMessage: '{project}: .combwork excluded from git', description: "Notification after Exclude in the .combwork notice. {project} is the project's name." }),
  excludeFailed: msg({ id: 'git.hiveVcs.excludeFailed', defaultMessage: "Couldn't exclude .combwork", description: 'Title of an error notification: Exclude in the .combwork notice failed.' }),
  untrackTitle: msg({ id: 'git.hiveVcs.untrackTitle', defaultMessage: '{count, plural, one {Untrack this file?} other {Untrack these # files?}}', description: "Title of the confirmation before Hive stops git tracking files in the project's .combwork." }),
  untrackMessage: msg({
    id: 'git.hiveVcs.untrackMessage',
    defaultMessage: '{count, plural, one {Combwork runs git rm --cached on it in {project}, and nothing else: git stops tracking it and stages its removal from the repository. The file stays on disk. Commit afterwards to finish.} other {Combwork runs git rm --cached on them in {project}, and nothing else: git stops tracking them and stages their removal from the repository. The files stay on disk. Commit afterwards to finish.}}',
    description: "The confirmation before untracking .combwork's files, above the list of them. {project} is the project's name. Keep git rm --cached as it is."
  }),
  more: msg({ id: 'git.hiveVcs.more', defaultMessage: '… and {count, plural, one {# more} other {# more}}', description: 'Last line of a long list of files: how many more are not listed.' }),
  untrack: msg({ id: 'git.hiveVcs.untrack', defaultMessage: 'Untrack', description: "Button in the confirmation: stops git tracking .combwork's files." }),
  untracking: msg({ id: 'git.hiveVcs.untracking', defaultMessage: 'Untracking…', description: 'The Untrack button while it runs.' }),
  untracked: msg({ id: 'git.hiveVcs.untracked', defaultMessage: '{project}: .combwork untracked', description: "Notification after untracking .combwork's files. {project} is the project's name." }),
  untrackedDetail: msg({ id: 'git.hiveVcs.untrackedDetail', defaultMessage: 'Commit the change to finish (git commit). The files are still on disk.', description: 'Under "{project}: .combwork untracked". Keep git commit as it is.' }),
  untrackFailed: msg({ id: 'git.hiveVcs.untrackFailed', defaultMessage: "Couldn't untrack .combwork", description: 'Title of an error notification.' }),
  checking: msg({ id: 'git.hiveVcs.checking', defaultMessage: 'Checking…', description: 'The Untrack… button while Hive lists the files git tracks in .combwork.' }),
  untrackButton: msg({ id: 'git.hiveVcs.untrackButton', defaultMessage: 'Untrack…', description: "Button in the .combwork notice: stops git tracking .combwork's files, after a confirmation." }),
  excluding: msg({ id: 'git.hiveVcs.excluding', defaultMessage: 'Excluding…', description: 'The Exclude button while it runs.' }),
  exclude: msg({ id: 'git.hiveVcs.exclude', defaultMessage: 'Exclude', description: "Button in the .combwork notice: adds .combwork to the git repository's exclude file." }),
  learnMore: msg({ id: 'git.learnMore', defaultMessage: 'Learn more', description: "Link or button that opens the user guide's section about this." }),
  dismiss: msg({ id: 'git.hiveVcs.dismiss', defaultMessage: "Don't show this here again (Project Settings still says so)", description: 'Tooltip on the × of the .combwork notice in the Overview.' })
}

/**
 * Says when a project's .combwork isn't kept out of version control or is in a sync service's folder (#345). In the
 * Overview it can be dismissed for the situation it describes; Project Settings always shows it.
 */
export function HiveVcsNotice({ project, dismissible = false }: { project: ProjectInfo; dismissible?: boolean }) {
  const key = project.path.toLowerCase()
  const dismissed = useStore((s) => s.hiveVcsNotice[key])
  const [busy, setBusy] = useState(false)
  const v = project.hiveVcs
  const text = hiveVcsText(v)
  if (!v || !text || (dismissible && dismissed === hiveVcsKey(v))) return null
  const exclude = async (): Promise<void> => {
    setBusy(true)
    try {
      set({ workspace: await call('project:excludeHive', project.path) })
      notify('success', tr(M.excluded, { project: project.name }))
    } catch (e) {
      notify('error', tr(M.excludeFailed), errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  // Committed before it was excluded (#364): the user's index changes only after a confirmation listing the files.
  const untrack = async (): Promise<void> => {
    setBusy(true)
    try {
      const files = await call('project:hiveTracked', project.path)
      if (!files.length) {
        set({ workspace: await call('workspace:refresh') })
        return
      }
      const ok = await confirm({
        title: tr(M.untrackTitle, { count: files.length }),
        message: tr(M.untrackMessage, { count: files.length, project: project.name }),
        list: files.length > 50 ? [...files.slice(0, 50), tr(M.more, { count: files.length - 50 })] : files,
        confirmLabel: tr(M.untrack),
        busyLabel: tr(M.untracking),
        run: async () => set({ workspace: await call('project:untrackHive', project.path, files) })
      })
      if (ok) notify('success', tr(M.untracked, { project: project.name }), tr(M.untrackedDetail))
    } catch (e) {
      notify('error', tr(M.untrackFailed), errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="banner warn hive-vcs-notice">
      <Icon name="warning" />
      <span className="hive-vcs-text">
        {sentences(<strong>{tr(M.titleSentence, { title: text.title })}</strong>, text.detail)}
      </span>
      {text.canUntrack && (
        <BusyButton className="btn small primary" busy={busy} busyLabel={tr(M.checking)} onClick={() => void untrack()}>
          {tr(M.untrackButton)}
        </BusyButton>
      )}
      {text.canExclude && (
        <BusyButton className="btn small primary" busy={busy} busyLabel={tr(M.excluding)} onClick={() => void exclude()}>
          {tr(M.exclude)}
        </BusyButton>
      )}
      <button className="btn small subtle" onClick={() => openGuideAt(HIVE_FOLDER_GUIDE)}>
        {tr(M.learnMore)}
      </button>
      {dismissible && <IconButton icon="close" title={tr(M.dismiss)} onClick={() => rememberProjectPref('hiveVcsNotice', key, hiveVcsKey(v))} />}
    </div>
  )
}
