// What a project's .hive version control notice says (#345): shared by the window and its tests.
import { msg, tr } from './i18n'
import type { HiveVcs } from './types'

/** The id of the user guide's heading on what .hive holds and how it is kept out of version control. */
// i18n-ignore: a user guide heading's id (#1535)
export const HIVE_FOLDER_GUIDE = 'what-hive-keeps-in-a-project'

const M = {
  trackedTitle: msg({ id: 'git.hiveVcs.trackedTitle', defaultMessage: '{count, plural, one {# file in .hive is committed to git} other {# files in .hive are committed to git}}', description: "Title of the notice in a project's Overview and Project Settings: files in the project's .hive folder were committed to git. Keep .hive. No full stop: the notice adds it." }),
  trackedDetail: msg({ id: 'git.hiveVcs.trackedDetail', defaultMessage: 'Excluding .hive keeps new files out of git, but {count, plural, one {this one was committed before, so git still tracks it and commits its changes} other {these were committed before, so git still tracks them and commits their changes}}. Run `git rm -r --cached .hive` in the project folder, then commit: the files stay on disk.{notExcluded, select, yes { Hive couldn\'t exclude .hive either: a rule in a .gitignore may bring it back.} other {}}', description: 'Under "n files in .hive are committed to git". Keep the git command as it is.' }),
  why: msg({ id: 'git.hiveVcs.why', defaultMessage: "It holds this computer's sessions, transcript backups and launch settings, which don't belong in commits or shared copies.", description: "Why .hive should be kept out of version control and sync services: what Hive keeps there. Follows the notice's first sentence." }),
  synced: msg({ id: 'git.hiveVcs.synced', defaultMessage: "{service} copies the project folder, .hive included: exclude .hive in {service} if it lets you, or keep the project in a folder it doesn't sync.", description: 'When the project is in a sync service\'s folder. {service} is its name (OneDrive, Dropbox…).' }),
  syncedTitle: msg({ id: 'git.hiveVcs.syncedTitle', defaultMessage: '.hive is synced by {service}', description: "Title of the notice when the project's .hive is in a sync service's folder. {service} is its name (OneDrive, Dropbox…). No full stop: the notice adds it." }),
  ignoredBut: msg({ id: 'git.hiveVcs.ignoredBut', defaultMessage: "Git ignores this project's .hive, but {synced} {why}", description: 'The notice when git ignores .hive but a sync service copies it. {synced} and {why} are the sentences about the service and about what .hive holds.' }),
  notExcludedTitle: msg({ id: 'git.hiveVcs.notExcludedTitle', defaultMessage: ".hive isn't excluded from version control", description: "Title of the notice when the project's .hive isn't kept out of version control. No full stop: the notice adds it." }),
  notExcluded: msg({ id: 'git.hiveVcs.notExcluded', defaultMessage: "Hive adds it to the git repository's .git/info/exclude, but git doesn't ignore it: Hive couldn't write that file, or a .gitignore rule brings .hive back.", description: 'The notice when git does not ignore .hive. Followed by why it matters.' }),
  otherVcs: msg({ id: 'git.hiveVcs.otherVcs', defaultMessage: "This project is in a {vcs} working copy, which Hive doesn't set up: add .hive to its ignore list.", description: 'The notice for a project kept in another version control system. {vcs} is its name (Subversion, Mercurial…).' }),
  noVcs: msg({ id: 'git.hiveVcs.noVcs', defaultMessage: 'No git repository holds this project; if you make one, Hive excludes .hive there by itself. With another version control system, add .hive to its ignore list.', description: 'The notice for a project in no git repository.' })
}

/** One situation, so a notice dismissed for it shows again when the situation changes. */
export const hiveVcsKey = (v: HiveVcs): string => `${v.state}|${v.vcs ?? ''}|${v.sync ?? ''}${v.tracked ? '|tracked' : ''}`

/** What the notice says about a project's .hive (#345), or null when version control already keeps it out and nothing syncs it. */
export function hiveVcsText(v: HiveVcs | undefined): { title: string; detail: string; canExclude: boolean; canUntrack?: boolean } | null {
  if (!v || (v.state === 'excluded' && !v.sync && !v.tracked)) return null
  // Committed before it was excluded (#364): excluding keeps new files out, but git goes on committing these.
  if (v.tracked) {
    return {
      title: tr(M.trackedTitle, { count: v.tracked }),
      detail: tr(M.trackedDetail, { count: v.tracked, notExcluded: v.state === 'excluded' ? 'no' : 'yes' }),
      canExclude: v.state === 'not-excluded',
      canUntrack: true
    }
  }
  const why = tr(M.why)
  const synced = v.sync ? tr(M.synced, { service: v.sync }) : ''
  if (v.state === 'excluded') return { title: tr(M.syncedTitle, { service: v.sync! }), detail: tr(M.ignoredBut, { synced, why }), canExclude: false }
  // Sentences, each a message of its own: what is wrong, why it matters, and the sync service's.
  const sentences = (first: string): string => [first, why, synced].filter(Boolean).join(' ')
  const title = tr(M.notExcludedTitle)
  if (v.state === 'not-excluded') return { title, detail: sentences(tr(M.notExcluded)), canExclude: true }
  if (v.state === 'other-vcs') return { title, detail: sentences(tr(M.otherVcs, { vcs: v.vcs ?? '' })), canExclude: false }
  return { title, detail: sentences(tr(M.noVcs)), canExclude: false }
}

