import { parseBuildDetail, parseBuildSummary, type BuildKind } from '../../../shared/buildFacts'
import { formatDateTime } from '../../../shared/dates'
import { msg, tr, type Msg } from '../../../shared/i18n'
import type { JournalSource } from '../../../shared/journal'

/**
 * A build of Hive as the journal shows it (#1534): Hive stores the build's line and detail in English, which the
 * Assistant reads, and the window shows them in the user's language. Any other entry is shown as it was written.
 */

const KIND: Record<BuildKind, Msg> = {
  beta: msg({ id: 'assistant.journal.build.kind.beta', defaultMessage: 'beta', description: 'A kind of build of Hive itself, in a journal line such as "Built Hive 1.0.0-beta.1 (beta) from 1fef5341 on main".' }),
  baseline: msg({ id: 'assistant.journal.build.kind.baseline', defaultMessage: 'baseline', description: 'A kind of build of Hive itself: the 1.0 build installed for daily use before any release, in a journal line such as "Built Hive 1.0.0-rc.1 (baseline) from 1fef5341 on 1.0.0".' }),
  rc: msg({ id: 'assistant.journal.build.kind.rc', defaultMessage: 'release candidate', description: 'A kind of build of Hive itself, in a journal line such as "Built Hive 1.0.0-rc.2 (release candidate) from 1fef5341 on 1.0.0".' }),
  release: msg({ id: 'assistant.journal.build.kind.release', defaultMessage: 'release', description: 'A kind of build of Hive itself, in a journal line such as "Uploaded a draft of Hive 1.0.0 (release) from 1fef5341 on main".' })
}

const M = {
  built: msg({ id: 'assistant.journal.build.built', defaultMessage: 'Built Hive {version} ({kind}) from {commit} on {branch}', description: "A journal entry Hive writes when Hive itself is built from its source code: {version} its version (1.0.0-rc.1), {kind} what kind of build (baseline, release candidate…), {commit} the commit's short id, {branch} the git branch." }),
  builtDetached: msg({ id: 'assistant.journal.build.builtDetached', defaultMessage: 'Built Hive {version} ({kind}) from {commit}', description: 'As "Built Hive {version} ({kind}) from {commit} on {branch}", for a build made from no branch.' }),
  uploaded: msg({ id: 'assistant.journal.build.uploaded', defaultMessage: 'Uploaded a draft of Hive {version} ({kind}) from {commit} on {branch}', description: "A journal entry Hive writes when a release of Hive itself is built and uploaded as a draft GitHub release: {version} its version, {kind} what kind of build (release, release candidate…), {commit} the commit's short id, {branch} the git branch." }),
  uploadedDetached: msg({ id: 'assistant.journal.build.uploadedDetached', defaultMessage: 'Uploaded a draft of Hive {version} ({kind}) from {commit}', description: 'As "Uploaded a draft of Hive {version} ({kind}) from {commit} on {branch}", for a build made from no branch.' }),
  installer: msg({ id: 'assistant.journal.build.installer', defaultMessage: 'Installer: {path}', description: "In a journal entry for a build of Hive: where its installer file is ({path}, a folder path on this computer)." }),
  builtAt: msg({ id: 'assistant.journal.build.builtAt', defaultMessage: 'Built: {when}', description: 'In a journal entry for a build of Hive: when it was built ({when}, a date and time).' }),
  uploadedNote: msg({ id: 'assistant.journal.build.uploadedNote', defaultMessage: 'Uploaded to a draft GitHub release (npm run release).', description: 'In a journal entry for a build of Hive: it was uploaded as a draft release on GitHub. npm run release is a command: keep it as it is.' })
}

/** An entry's one line as the window shows it: a build of Hive's in the user's language, any other as written. */
export function journalSummary(e: { source: JournalSource; summary: string }): string {
  const b = e.source === 'hive' ? parseBuildSummary(e.summary) : null
  if (!b) return e.summary
  const values = { version: b.version, kind: tr(KIND[b.kind]), commit: b.commit }
  if (b.by === 'release') return b.branch ? tr(M.uploaded, { ...values, branch: b.branch }) : tr(M.uploadedDetached, values)
  return b.branch ? tr(M.built, { ...values, branch: b.branch }) : tr(M.builtDetached, values)
}

/** A build's detail as lines in the user's language, or null for another entry's (shown as written, in Markdown). */
export function journalBuildDetail(e: { source: JournalSource; summary: string; detail: string | null }): string[] | null {
  if (e.source !== 'hive' || !e.detail || !parseBuildSummary(e.summary)) return null
  const d = parseBuildDetail(e.detail)
  if (!d) return null
  return [tr(M.installer, { path: d.installer }), tr(M.builtAt, { when: formatDateTime(d.builtAt) }), ...(d.uploaded ? [tr(M.uploadedNote)] : [])]
}
