// What a project's .combwork version control notice says (#345): shared by the window and its tests.
import { msg, tr } from './i18n'
import type { CombworkVcs } from './types'

/** The id of the user guide's heading on what .combwork holds and how it is kept out of version control. */
// i18n-ignore: a user guide heading's id (#1535)
export const CW_FOLDER_GUIDE = 'what-hive-keeps-in-a-project'

const M = {
  trackedTitle: msg({ id: 'git.combworkVcs.trackedTitle', defaultMessage: '{count, plural, one {# file in .combwork is committed to git} other {# files in .combwork are committed to git}}', description: "Title of the notice in a project's Overview and Project Settings: files in the project's .combwork folder were committed to git. Keep .combwork. No full stop: the notice adds it." }),
  trackedDetail: msg({ id: 'git.combworkVcs.trackedDetail', defaultMessage: 'Excluding .combwork keeps new files out of git, but {count, plural, one {this one was committed before, so git still tracks it and commits its changes} other {these were committed before, so git still tracks them and commits their changes}}. Run `git rm -r --cached .combwork` in the project folder, then commit: the files stay on disk.{notExcluded, select, yes { Combwork couldn\'t exclude .combwork either: a rule in a .gitignore may bring it back.} other {}}', description: 'Under "n files in .combwork are committed to git". Keep the git command as it is.' }),
  why: msg({ id: 'git.combworkVcs.why', defaultMessage: "It holds this computer's sessions, transcript backups and launch settings, which don't belong in commits or shared copies.", description: "Why .combwork should be kept out of version control and sync services: what Combwork keeps there. Follows the notice's first sentence." }),
  synced: msg({ id: 'git.combworkVcs.synced', defaultMessage: "{service} copies the project folder, .combwork included: exclude .combwork in {service} if it lets you, or keep the project in a folder it doesn't sync.", description: 'When the project is in a sync service\'s folder. {service} is its name (OneDrive, Dropbox…).' }),
  syncedTitle: msg({ id: 'git.combworkVcs.syncedTitle', defaultMessage: '.combwork is synced by {service}', description: "Title of the notice when the project's .combwork is in a sync service's folder. {service} is its name (OneDrive, Dropbox…). No full stop: the notice adds it." }),
  ignoredBut: msg({ id: 'git.combworkVcs.ignoredBut', defaultMessage: "Git ignores this project's .combwork, but {synced} {why}", description: 'The notice when git ignores .combwork but a sync service copies it. {synced} and {why} are the sentences about the service and about what .combwork holds.' }),
  notExcludedTitle: msg({ id: 'git.combworkVcs.notExcludedTitle', defaultMessage: ".combwork isn't excluded from version control", description: "Title of the notice when the project's .combwork isn't kept out of version control. No full stop: the notice adds it." }),
  notExcluded: msg({ id: 'git.combworkVcs.notExcluded', defaultMessage: "Combwork adds it to the git repository's .git/info/exclude, but git doesn't ignore it: Combwork couldn't write that file, or a .gitignore rule brings .combwork back.", description: 'The notice when git does not ignore .combwork. Followed by why it matters.' }),
  otherVcs: msg({ id: 'git.combworkVcs.otherVcs', defaultMessage: "This project is in a {vcs} working copy, which Combwork doesn't set up: add .combwork to its ignore list.", description: 'The notice for a project kept in another version control system. {vcs} is its name (Subversion, Mercurial…).' }),
  noVcs: msg({ id: 'git.combworkVcs.noVcs', defaultMessage: 'No git repository holds this project; if you make one, Combwork excludes .combwork there by itself. With another version control system, add .combwork to its ignore list.', description: 'The notice for a project in no git repository.' })
}

/** One situation, so a notice dismissed for it shows again when the situation changes. */
export const combworkVcsKey = (v: CombworkVcs): string => `${v.state}|${v.vcs ?? ''}|${v.sync ?? ''}${v.tracked ? '|tracked' : ''}`

/** What the notice says about a project's .combwork (#345), or null when version control already keeps it out and nothing syncs it. */
export function combworkVcsText(v: CombworkVcs | undefined): { title: string; detail: string; canExclude: boolean; canUntrack?: boolean } | null {
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

