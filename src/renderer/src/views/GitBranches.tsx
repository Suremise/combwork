import { useEffect, useMemo, useRef, useState } from 'react'
import type { CopyView, ProjectInfo, SlotView } from '@shared/types'
import { fmt, msg, tr } from '@shared/i18n'
import {
  aheadBehindText,
  gitStateKey,
  gitStateText,
  headText,
  identityProblem,
  identityWarnings,
  parentRepoText,
  remoteNameProblem,
  remoteUrlProblem,
  type BranchAt,
  type GitBranchRow,
  type GitRemoteBranchRow,
  type GitRepoInfo,
  type GitRepoSummary,
  type BranchUpdatePlan
} from '@shared/gitRepo'
import { BRANCH_GROUPS, busyLines, cleanupOffer, localGroup, localUse, remoteGroup, type BranchGroup, type CleanupOffer } from '@shared/branchCleanup'
import { samePath } from '@shared/movePaths'
import { call } from '../api'
import { attempt, releaseHeldSlot } from '../actions'
import { SLOT_HELD_TEXT } from '../components/SlotsAndCopies'
import { bumpGit, cardLabelOf, choose, confirm, notify, prompt, set, showVersionControl, UNUSED_ROOT, useStore } from '../store'
import { agentCard, branchCards, type BranchCard } from '@shared/branchCards'
import { revisionShort } from '@shared/platform/descriptors'
import { stageName } from '@shared/workflow/stages'
import { stageLook } from '@shared/laneStages'
import { useWorkBadges } from '../cardWork'
import { useProjectStages } from '../projectStages'
import { useNow } from '../usage'
import { cx } from '../util'
import { BusyButton, Icon, IconButton, Tooltip, useBusy } from '../components/ui'
import { INIT_TEXT, InitRepoButton } from '../components/InitRepo'
import { at, GIT_TEXT, GitForm, gitAction, Loading, rich, useFolderBusy, useGitRead, type FormSpec, type OpenForm } from './GitTab'
import { awayFromProject } from '../agentPlace'

/**
 * Version Control → Branches & remotes (#607, #1385; its own file since #1416): the project folder's branch or detached
 * HEAD, upstream and ahead/behind as of the last fetch, branches, remotes, other worktrees read-only, and the commit
 * identity, with the forms that change them (Add remote, Push to…, Track…, commit identity).
 */

/** The ahead/behind counts, with their hook for tests. */
const ab = (c: React.ReactNode[]): React.ReactNode => <span data-git-ab="">{c}</span>

const M = {
  enterName: GIT_TEXT.enterName,
  cancel: GIT_TEXT.cancel,
  branchesLoad: msg({ id: 'git.branches.loadTarget', defaultMessage: 'the branches and remotes', description: 'What could not be read in Git → Branches & remotes: shown in "Could not load {what}: {error}" and "Could not refresh {what}; last updated …".' }),
  switchTitle: msg({ id: 'git.switch.title', defaultMessage: 'Switch {project} to {branch}?', description: "Title of the confirmation before switching the project folder's branch." }),
  switchMessage: msg({ id: 'git.switch.message', defaultMessage: "The project folder leaves {current} for {branch}. Uncommitted changes come along when they don't clash with {branch}; if they do, git refuses and nothing changes.", description: 'The confirmation before switching branch. {current} is the branch it is on now (or "its detached HEAD").' }),
  detachedHead: msg({ id: 'git.switch.detachedHead', defaultMessage: 'its detached HEAD', description: 'In "The project folder leaves {current} for {branch}…", when no branch is checked out.' }),
  switchIdle: msg({ id: 'git.switch.idle', defaultMessage: '{agents} {count, plural, one {has a session in the project folder: it finds {branch} on the next turn.} other {have sessions in the project folder: they find {branch} on the next turn.}}', description: 'Under the confirmation before switching branch: agents whose sessions run in the project folder. {agents} is their names as a list.' }),
  switch: msg({ id: 'git.switch.button', defaultMessage: 'Switch', description: 'Button: switches the project folder to that branch.' }),
  switchFailed: msg({ id: 'git.switch.failed', defaultMessage: "Couldn't switch to {branch}", description: 'Title of an error notification.' }),
  newBranchTitle: msg({ id: 'git.newBranch.title', defaultMessage: 'New branch', description: 'Title of the form that creates a branch.' }),
  newBranchAt: msg({ id: 'git.newBranch.message', defaultMessage: '{onBranch, select, yes {A branch at {commit}, where {current} is now.} other {A branch at {commit}.}}', description: 'The New branch form. {commit} is the short hash of the commit checked out; {current} the branch there now ({onBranch} is no when HEAD is detached).' }),
  newBranchBlocked: msg({ id: 'git.newBranch.blocked', defaultMessage: "It can't be switched to now: {why}", description: 'After "A branch at …" in the New branch form, when switching branch is refused now. {why} says why.' }),
  branchPlaceholder: msg({ id: 'git.newBranch.placeholder', defaultMessage: 'feature/name', description: "Placeholder in the New branch form's box: an example branch name." }),
  create: msg({ id: 'git.newBranch.create', defaultMessage: 'Create', description: "The New branch form's button." }),
  branchNoSpaces: msg({ id: 'git.newBranch.noSpaces', defaultMessage: 'Branch names have no spaces', description: "Under the New branch form's box." }),
  switchNow: msg({ id: 'git.newBranch.switchNow', defaultMessage: 'Switch to it now', description: 'Check box in the New branch form.' }),
  createFailed: msg({ id: 'git.newBranch.failed', defaultMessage: "Couldn't create {branch}", description: 'Title of an error notification.' }),
  pushFailed: msg({ id: 'git.push.failed', defaultMessage: "Couldn't push {branch}", description: 'Title of an error notification.' }),
  pushTitle: msg({ id: 'git.push.title', defaultMessage: 'Push {branch}', description: 'Title of the dialog that pushes a branch that tracks no remote branch yet.' }),
  pushMessage: msg({ id: 'git.push.message', defaultMessage: '{branch} tracks no remote branch yet. Push it, and track it from now on:', description: 'The Push dialog, above the drop-down of remotes.' }),
  remote: msg({ id: 'git.push.remote', defaultMessage: 'Remote', description: "Label of the Push dialog's drop-down of remotes." }),
  push: msg({ id: 'git.push.button', defaultMessage: 'Push', description: 'Button: pushes the branch to a remote.' }),
  changeUrlTitle: msg({ id: 'git.remote.changeTitle', defaultMessage: "Change {remote}'s URL", description: "Title of the form that changes a remote's URL, and the tooltip of its button. {remote} is its name, such as origin." }),
  change: msg({ id: 'git.remote.change', defaultMessage: 'Change', description: "The button of the form that changes a remote's URL." }),
  changeUrlFailed: msg({ id: 'git.remote.changeFailed', defaultMessage: "Couldn't change {remote}'s URL", description: 'Title of an error notification.' }),
  pullDetached: msg({ id: 'git.pull.detached', defaultMessage: 'HEAD is detached: switch to a branch to pull.', description: 'Why Pull is disabled (its tooltip).' }),
  pullNoUpstream: msg({ id: 'git.pull.noUpstream', defaultMessage: '{branch} tracks no remote branch to pull from.', description: 'Why Pull is disabled (its tooltip).' }),
  pullState: msg({ id: 'git.pull.state', defaultMessage: 'Git is {state, select, merge {merging} rebase {rebasing} cherrypick {cherry-picking} revert {reverting} other {bisecting}}: finish or abort it first.', description: 'Why Pull is disabled (its tooltip): git has an operation in progress in the project folder.' }),
  pushDetached: msg({ id: 'git.push.detached', defaultMessage: 'HEAD is detached: switch to a branch to push.', description: 'Why Push is disabled (its tooltip).' }),
  pushNoCommits: msg({ id: 'git.push.noCommits', defaultMessage: 'No commits to push yet.', description: 'Why Push is disabled (its tooltip).' }),
  pushNoRemote: msg({ id: 'git.push.noRemote', defaultMessage: 'Add a remote to push to.', description: 'Why Push is disabled (its tooltip).' }),
  branch: msg({ id: 'git.branches.branch', defaultMessage: 'Branch', description: 'Heading in Git → Branches & remotes: the branch checked out in the project folder.' }),
  readAgain: msg({ id: 'git.branches.reload', defaultMessage: "Read git again (doesn't fetch)", description: 'Tooltip on the refresh button in Git → Branches & remotes.' }),
  noCommitsBanner: msg({ id: 'git.branches.noCommits', defaultMessage: "No commits yet, and agents' worktrees need one.", description: 'Banner in Git → Branches & remotes of a repository with no commit.' }),
  tracks: msg({ id: 'git.branches.tracks', defaultMessage: 'tracks {upstream} · <ab>{aheadBehind}</ab>', description: 'Beside the branch checked out: the remote branch it tracks and how far apart they are ("tracks origin/main · ↑2 ↓0"). Keep <ab>…</ab> around the counts.' }),
  tracksNothing: msg({ id: 'git.branches.tracksNothing', defaultMessage: 'tracks no remote branch: Push sets one', description: 'Beside the branch checked out. Push is the button of that name.' }),
  stateBanner: msg({ id: 'git.branches.stateBanner', defaultMessage: "Git is {state, select, merge {merging} rebase {rebasing} cherrypick {cherry-picking} revert {reverting} other {bisecting}} in the project folder. Finish or abort it in a terminal (or ask an agent to): Combwork doesn't.", description: 'Banner in Git → Branches & remotes while git has an operation in progress.' }),
  fetchedAt: msg({ id: 'git.fetch.at', defaultMessage: 'As of the last fetch, {when}. Combwork never fetches by itself.', description: 'In Git → Branches & remotes, beside Fetch. {when} is how long ago, such as "5m ago".' }),
  neverFetched: msg({ id: 'git.fetch.never', defaultMessage: 'Never fetched. Combwork never fetches by itself.', description: 'In Git → Branches & remotes, beside Fetch.' }),
  fetchTip: msg({ id: 'git.fetch.tip', defaultMessage: 'Fetch every remote: ahead/behind and remote branches as they are now', description: 'Tooltip on the Fetch button.' }),
  fetch: msg({ id: 'git.fetch.button', defaultMessage: 'Fetch', description: 'Button: fetches every remote.' }),
  fetchFailed: msg({ id: 'git.fetch.failed', defaultMessage: "Couldn't fetch", description: 'Title of an error notification.' }),
  pullTip: msg({ id: 'git.pull.tip', defaultMessage: 'Fetch {upstream} and bring {branch} up to it (only when that needs no merge)', description: 'Tooltip on the Pull button.' }),
  pulling: msg({ id: 'git.pull.busy', defaultMessage: 'Pulling…', description: 'The Pull button while it runs.' }),
  pullFailed: msg({ id: 'git.pull.failed', defaultMessage: "Couldn't pull", description: 'Title of an error notification.' }),
  pull: msg({ id: 'git.pull.button', defaultMessage: 'Pull', description: 'Button: pulls the branch from the remote branch it tracks.' }),
  pushTo: msg({ id: 'git.push.tipTo', defaultMessage: 'Push {branch} to {upstream} (never forced)', description: 'Tooltip on the Push button.' }),
  pushTrack: msg({ id: 'git.push.tipTrack', defaultMessage: 'Push {branch} to a remote and track it', description: 'Tooltip on the Push button, when the branch tracks no remote branch yet.' }),
  pushing: msg({ id: 'git.push.busy', defaultMessage: 'Pushing…', description: 'The Push button while it runs.' }),
  commitFirst: msg({ id: 'git.newBranch.commitFirst', defaultMessage: 'Commit something first', description: 'Why New branch… is disabled (its tooltip): there is no commit to start a branch at.' }),
  branchAt: msg({ id: 'git.newBranch.tip', defaultMessage: 'A branch at {commit}', description: 'Tooltip on New branch…. {commit} is the short hash of the commit checked out.' }),
  newBranch: msg({ id: 'git.newBranch.button', defaultMessage: 'New branch…', description: 'Button: opens the New branch form.' }),
  branches: msg({ id: 'git.branches.heading', defaultMessage: 'Branches', description: 'Heading in Git → Branches & remotes, followed by how many there are.' }),
  checkedOutIn: msg({ id: 'git.branches.checkedOut', defaultMessage: '{where, select, agent {Checked out in {agent}\'s worktree: a branch is in one folder at a time.} other {Checked out in another worktree: a branch is in one folder at a time.}}', description: "Why a branch's Switch is disabled (its tooltip). {agent} is the agent whose worktree has it." }),
  agentWorktree: msg({ id: 'git.worktree.agent', defaultMessage: "{agent}'s worktree", description: "A worktree that belongs to an agent. {agent} is the agent's name." }),
  worktreeBadge: msg({ id: 'git.worktree.badge', defaultMessage: 'worktree', description: "Badge on a branch checked out in a worktree that isn't an agent's." }),
  unusedWorktree: msg({ id: 'git.worktree.unused', defaultMessage: 'Unused worktree', description: 'A worktree of the repository that belongs to no agent.' }),
  slotLease: msg({ id: 'git.worktree.slotLease', defaultMessage: '{kind, select, card {{slot}: {agent} on {card}} lane {{slot}: {agent}, lane {lane}} carried {{slot}: carried, agent {agent}} other {{slot}: not lent}}', description: "A slot's row in Git → Branches & remotes, Worktrees (#1450): its name and its lease: lent to an agent ({agent}) for a card ({card}: its key) or a lane ({lane}: its name), carried for an agent (its old worktree, adopted), or not lent. carried: a noun before the name (glossary §1 rule 4)." }),
  mergeBranch: msg({ id: 'git.branches.merge', defaultMessage: 'Merge {branch} into another branch…', description: "A branch row's button in Git → Branches & remotes (#1450): opens the Merge dialog on that branch." }),
  switchTip: msg({ id: 'git.switch.tip', defaultMessage: 'Switch the project folder to {branch}', description: 'Tooltip on a branch\'s Switch button.' }),
  remoteBranches: msg({ id: 'git.branches.remote', defaultMessage: 'Remote branches ({count, number})', description: 'Button in Git → Branches & remotes that shows or hides the remote branches with no local one.' }),
  trackLocal: msg({ id: 'git.branches.trackLocal', defaultMessage: 'A local {branch} tracking {remote}, and switch to it', description: "Tooltip on a remote branch's Switch button. {branch} is the local branch it makes; {remote} the remote branch, such as origin/feature." }),
  remotes: msg({ id: 'git.remotes.heading', defaultMessage: 'Remotes', description: 'Heading in Git → Branches & remotes, followed by how many there are.' }),
  addRemote: msg({ id: 'git.remotes.add', defaultMessage: 'Add remote…', description: 'Button: opens the Add a remote form.' }),
  noRemotes: msg({ id: 'git.remotes.none', defaultMessage: "No remotes: this repository is only on this computer. Add one (a GitHub repository's URL, say) to push to it.", description: 'Git → Branches & remotes of a repository with no remote.' }),
  pushesTo: msg({ id: 'git.remotes.pushesTo', defaultMessage: '(pushes to {url})', description: "After a remote's URL, when it pushes to another URL." }),
  worktrees: msg({ id: 'git.worktrees.heading', defaultMessage: 'Worktrees', description: 'Heading in Git → Branches & remotes, followed by how many there are.' }),
  copiesHeading: msg({ id: 'git.worktrees.copiesHeading', defaultMessage: 'Review copies (Combwork’s)', description: "A heading in Git → Branches & remotes, followed by how many: the worktrees Hive keeps for reviews (review copies: clean checkouts at the revision a reviewer checks). Hive's own, not the user's." }),
  copiesHint: msg({ id: 'git.worktrees.copiesHint', defaultMessage: 'Clean checkouts Combwork keeps for reviewers, each at the revision being checked. Combwork manages them: there is nothing to remove here.', description: "Under the Review copies (Hive's) heading in Git → Branches & remotes." }),
  copyRow: msg({ id: 'git.worktrees.copyRow', defaultMessage: '{use, select, review {{copy}: {agent} reviewing {card} at {revision}} check {{copy}: {agent} checking {card} at {revision}} other {{copy}: idle in the pool}}', description: "A review copy's row in Git → Branches & remotes: its name ({copy}, such as copy-1, keep it as it is) and who uses it: a reviewer ({agent}) reviewing a card ({card}: its key) at a revision ({revision}: a short commit id), an agent running a check on it, or no one (idle in Hive's pool of copies). Keep the select keys." }),
  queueHeading: msg({ id: 'git.worktrees.queueHeading', defaultMessage: 'Merge queue (Combwork’s)', description: "A heading in Git → Branches & remotes, followed by how many: the folder Hive's merge queue tests merges in (glossary: merge queue). Hive's own, not the user's." }),
  queueHint: msg({ id: 'git.worktrees.queueHint', defaultMessage: 'Where Combwork’s merge queue tests a card’s merge before it goes in. Combwork manages it: there is nothing to remove here.', description: "Under the Merge queue (Hive's) heading in Git → Branches & remotes." }),
  queueRow: msg({ id: 'git.worktrees.queueRow', defaultMessage: 'The merge queue’s folder', description: "The merge queue's folder's row in Git → Branches & remotes (glossary: merge queue)." }),
  readOnly: msg({ id: 'git.worktrees.readOnly', defaultMessage: "Read-only here: an agent's work comes into the project folder through Merge.", description: 'Under the Worktrees heading. Merge is the name of the action that brings an agent\'s branch in.' }),
  changes: msg({ id: 'git.worktrees.changes', defaultMessage: 'Changes', description: "Button on a worktree's row: shows its changes in Git → Changes." }),
  identity: msg({ id: 'git.identity.heading', defaultMessage: 'Commit identity', description: 'Heading in Git → Branches & remotes: who commits are made as.' }),
  setIdentity: msg({ id: 'git.identity.set', defaultMessage: 'Set for this repository…', description: "Button: opens the form that sets this repository's own commit name and email." }),
  thisRepo: msg({ id: 'git.identity.thisRepo', defaultMessage: 'This repository', description: "Column of the commit identity table: this repository's own setting." }),
  global: msg({ id: 'git.identity.global', defaultMessage: 'Global', description: "Column of the commit identity table: the user's global git setting." }),
  commitsUse: msg({ id: 'git.identity.used', defaultMessage: 'Commits use', description: 'Column of the commit identity table: what git uses.' }),
  name: msg({ id: 'git.identity.name', defaultMessage: 'Name', description: "Row of the commit identity table, and a field of the form that sets it: the commits' author name." }),
  email: msg({ id: 'git.identity.email', defaultMessage: 'Email', description: 'Row of the commit identity table, and a form field.' }),
  notSet: msg({ id: 'git.identity.notSet', defaultMessage: 'not set', description: 'In the commit identity table: no value there.' }),
  remoteName: msg({ id: 'git.remotes.name', defaultMessage: 'Name', description: "Field of the Add a remote form: the remote's short name in git (origin, say)." }),
  addRemoteTitle: msg({ id: 'git.remotes.addTitle',defaultMessage: 'Add a remote', description: 'Title of the Add a remote form.' }),
  addRemoteAbout: msg({ id: 'git.remotes.addAbout', defaultMessage: 'A repository to fetch from and push to: a URL (https://github.com/you/repo.git, git@github.com:you/repo.git) or a folder.', description: 'The Add a remote form. Keep the example URLs.' }),
  url: msg({ id: 'git.remotes.url', defaultMessage: 'URL', description: 'Field of the Add a remote form.' }),
  add: msg({ id: 'git.remotes.addButton', defaultMessage: 'Add', description: "The Add a remote form's button." }),
  adding: msg({ id: 'git.remotes.adding', defaultMessage: 'Adding…', description: "The Add a remote form's button while it runs." }),
  identityTitle: msg({ id: 'git.identity.title', defaultMessage: 'Commit identity for this repository', description: 'Title of the commit identity form.' }),
  identityAbout: msg({ id: 'git.identity.about', defaultMessage: "{hasGlobal, select, yes {Who {project}'s commits are made as, agents' too (git config --local). Leave both empty to use your global identity ({global}). On GitHub, its no-reply address keeps your email private.} other {Who {project}'s commits are made as, agents' too (git config --local). Leave both empty to use your global identity. On GitHub, its no-reply address keeps your email private.}}", description: "The commit identity form. {project} is the project's name; {global} the global email ({hasGlobal} is no when there is none). Keep git config --local." }),
  namePlaceholder: msg({ id: 'git.identity.namePlaceholder', defaultMessage: 'Your Name', description: "Placeholder in the commit identity form's name box: an example name." }),
  save: msg({ id: 'git.identity.save', defaultMessage: 'Save', description: "The commit identity form's button." }),
  saving: msg({ id: 'git.identity.saving', defaultMessage: 'Saving…', description: "The commit identity form's button while it runs." }),
  // Push to…, remotes' Rename and Remove, a branch's Track… and Stop tracking (#1385).
  pushToButton: msg({ id: 'git.pushTo.button', defaultMessage: 'Push to…', description: 'Button beside Push in Git → Branches & remotes: opens the Push to form (any remote, this branch or everything).' }),
  pushToTip: msg({ id: 'git.pushTo.tip', defaultMessage: 'Push to any remote, {branch} or every branch and tag, without changing what {branch} tracks', description: 'Tooltip on Push to…. {branch} is the branch checked out.' }),
  pushToTitle: msg({ id: 'git.pushTo.title', defaultMessage: 'Push to a remote', description: 'Title of the Push to form.' }),
  pushToAbout: msg({ id: 'git.pushTo.about', defaultMessage: '{onBranch, select, yes {Pushes to the remote you choose, without changing what {branch} tracks: Push still goes where it went. Never forced: a branch the remote has newer commits on is refused, and named.} other {Pushes to the remote you choose, without changing what any branch tracks. Never forced: a branch the remote has newer commits on is refused, and named.}}', description: 'The Push to form. {branch} is the branch checked out ({onBranch} is no when HEAD is detached). Push is the button of that name.' }),
  pushWhat: msg({ id: 'git.pushTo.what', defaultMessage: 'Push', description: "Label of the Push to form's drop-down: what to push (this branch, or every branch and tag)." }),
  pushThisBranch: msg({ id: 'git.pushTo.thisBranch', defaultMessage: 'This branch ({branch})', description: "A choice of the Push to form's drop-down. {branch} is the branch checked out." }),
  pushAll: msg({ id: 'git.pushTo.all', defaultMessage: 'All branches and tags', description: "A choice of the Push to form's drop-down: every local branch, then every tag." }),
  renameRemoteTip: msg({ id: 'git.remote.renameTip', defaultMessage: 'Rename {remote}…', description: "Tooltip on a remote's rename button. {remote} is its name, such as origin." }),
  renameRemoteTitle: msg({ id: 'git.remote.renameTitle', defaultMessage: 'Rename {remote}', description: 'Title of the dialog that renames a remote. {remote} is its name now.' }),
  renameRemoteMessage: msg({ id: 'git.remote.renameMessage', defaultMessage: 'Branches tracking it follow the new name. Nothing changes on the remote itself.', description: 'The dialog that renames a remote.' }),
  rename: msg({ id: 'git.remote.renameButton', defaultMessage: 'Rename', description: 'The button of the dialog that renames a remote.' }),
  remoteTaken: msg({ id: 'git.remote.taken', defaultMessage: 'There is a remote called {remote} already', description: "Under the rename dialog's box: another remote has that name." }),
  renameRemoteFailed: msg({ id: 'git.remote.renameFailed', defaultMessage: "Couldn't rename {remote}", description: 'Title of an error notification.' }),
  removeRemoteFailed: msg({ id: 'git.remote.removeFailed', defaultMessage: "Couldn't remove {remote}", description: 'Title of an error notification.' }),
  removeRemoteTip: msg({ id: 'git.remote.removeTip', defaultMessage: 'Remove {remote}…', description: "Tooltip on a remote's remove button. {remote} is its name." }),
  removeRemoteTitle: msg({ id: 'git.remote.removeTitle', defaultMessage: 'Remove the remote {remote}?', description: 'Title of the confirmation before removing a remote.' }),
  removeRemoteMessage: msg({ id: 'git.remote.removeMessage', defaultMessage: '{n, plural, =0 {Combwork forgets {remote} and its remote branches here. No branch tracks it.} one {Combwork forgets {remote} and its remote branches here, and this branch stops tracking it:} other {Combwork forgets {remote} and its remote branches here, and these # branches stop tracking it:}}', description: 'The confirmation before removing the remote {remote}; the branches that track it ({n}) follow, one per line.' }),
  removeRemoteDetail: msg({ id: 'git.remote.removeDetail', defaultMessage: 'Nothing on {remote} itself changes: its branches stay there, and you can add it again.', description: 'The confirmation before removing a remote, under its list.' }),
  remove: msg({ id: 'git.remote.removeButton', defaultMessage: 'Remove', description: 'The button of the confirmation before removing a remote.' }),
  removing: msg({ id: 'git.remote.removing', defaultMessage: 'Removing…', description: 'The Remove button while it runs.' }),
  trackTip: msg({ id: 'git.track.tip', defaultMessage: 'Track…: choose the remote branch {branch} pulls from and pushes to', description: "Tooltip on a branch's Track… button. {branch} is the local branch." }),
  trackTitle: msg({ id: 'git.track.title', defaultMessage: 'What {branch} tracks', description: 'Title of the Track form. {branch} is the local branch.' }),
  trackAbout: msg({ id: 'git.track.about', defaultMessage: '{tracks, select, yes {{branch} tracks {upstream} now. Pull and Push use the remote branch it tracks; other remotes stay as they are, and Push to… still pushes there.} other {{branch} tracks no remote branch now. Pull and Push use the remote branch it tracks; other remotes stay as they are, and Push to… still pushes there.}}', description: 'The Track form. {branch} is the local branch; {upstream} the remote branch it tracks now ({tracks} is no when none). Pull, Push and Push to… are buttons: keep their names.' }),
  remoteBranch: msg({ id: 'git.track.remoteBranch', defaultMessage: 'Remote branch', description: "Field of the Track form: the branch's name on the remote." }),
  trackPushFirst: msg({ id: 'git.track.pushFirst', defaultMessage: '{remote} has no {branch} yet, as of the last fetch: Track pushes {local} there first (never forced).', description: "Under the Track form when the chosen remote branch isn't known to exist. {remote} the remote, {branch} the branch name there, {local} the local branch." }),
  track: msg({ id: 'git.track.button', defaultMessage: 'Track', description: "The Track form's button." }),
  untrackTip: msg({ id: 'git.untrack.tip', defaultMessage: 'Stop tracking {upstream}…', description: "Tooltip on a branch's stop-tracking button. {upstream} is the remote branch it tracks." }),
  untrackTitle: msg({ id: 'git.untrack.title', defaultMessage: 'Stop {branch} tracking {upstream}?', description: 'Title of the confirmation before a branch stops tracking its remote branch.' }),
  untrackFailed: msg({ id: 'git.untrack.failed', defaultMessage: "Couldn't stop {branch} tracking {upstream}", description: 'Title of an error notification.' }),
  untrackMessage: msg({ id: 'git.untrack.message', defaultMessage: '{branch} no longer tracks a remote branch: Pull has nothing to pull from, and Push asks where to push it. Nothing changes on the remote.', description: 'The confirmation before a branch stops tracking its remote branch. Pull and Push are buttons: keep their names.' }),
  untrack: msg({ id: 'git.untrack.button', defaultMessage: 'Stop tracking', description: 'The button of the confirmation before a branch stops tracking its remote branch.' })
}

/** Branches by their state, and cleaning up the merged ones (#1642). */
const C = {
  group: msg({ id: 'git.branches.group', defaultMessage: '{group, select, inUse {In use} merged {Merged into {target}} other {Not merged into {target}}}', description: "A heading inside Version Control → Branches & remotes' list of branches: the branches in use (the target, the default branch, the project folder's, a slot's or worktree's, an open card's), those merged into the target branch {target} that nothing uses, and those with commits not in it. Keep the select keys." }),
  groupTip: msg({ id: 'git.branches.groupTip', defaultMessage: "{group, select, inUse {The branch work merges into, the default branch, the project folder's, and those a slot, a worktree or an open card uses.} merged {Every commit of these is in {target}, and nothing uses them: Clean Up Merged Branches deletes them.} other {These have commits that aren't in {target}. Delete one only after checking the commits it drops.}}", description: 'Tooltip of a group heading in the list of branches (#1642). {target} is the branch the project merges into. Keep the select keys.' }),
  ahead: msg({ id: 'git.branches.notInTarget', defaultMessage: '{n, plural, one {# commit not in {target}} other {# commits not in {target}}}', description: "On a branch of the Not merged group in Version Control → Branches & remotes: how many of its commits aren't in the target branch {target}." }),
  cleanUp: msg({ id: 'git.branches.cleanUp', defaultMessage: 'Clean Up Merged Branches…', description: "A button over the list of branches in Version Control → Branches & remotes: lists the branches merged into the target that nothing uses, to delete the ones you tick (it asks first). Keep the …: it opens a dialog." }),
  cleanUpTip: msg({ id: 'git.branches.cleanUpTip', defaultMessage: "{n, plural, =0 {No branch is merged into {target} and unused.} one {# branch here or on a remote is merged into {target} and unused: pick which to delete.} other {# branches here or on a remote are merged into {target} and unused: pick which to delete.}}", description: 'Tooltip of Clean Up Merged Branches… ({n}: how many it offers, local and remote; {target}: the branch the project merges into).' }),
  cleanUpTitle: msg({ id: 'git.cleanUp.title', defaultMessage: 'Clean up merged branches', description: 'Title of the Clean Up Merged Branches dialog (Version Control → Branches & remotes).' }),
  cleanUpMessage: msg({ id: 'git.cleanUp.message', defaultMessage: "Every commit of these is already in {target}, and no slot, worktree or open card uses them. Tick the ones to delete.", description: 'The Clean Up Merged Branches dialog: what it lists. {target} is the branch the project merges into.' }),
  localHead: msg({ id: 'git.cleanUp.local', defaultMessage: 'In this repository ({n, number})', description: 'A heading in the Clean Up Merged Branches dialog: the local branches it offers ({n}), each with a tick box, ticked to start with.' }),
  remoteHead: msg({ id: 'git.cleanUp.remote', defaultMessage: 'On {remotes} ({n, number})', description: 'A heading in the Clean Up Merged Branches dialog: the branches it offers on the remote(s) {remotes} (a list of names), {n} of them, none ticked to start with.' }),
  remoteWarn: msg({ id: 'git.cleanUp.remoteWarn', defaultMessage: "Ticking these deletes them on the remote, for everyone who uses it, and Combwork can't undo that. None is ticked for you.", description: "A warning in the Clean Up Merged Branches dialog over the remote branches it offers: deleting them is outward-facing (git push --delete)." }),
  withLocal: msg({ id: 'git.cleanUp.withLocal', defaultMessage: 'its local branch is ticked above', description: 'Beside a remote branch in the Clean Up Merged Branches dialog: the local branch of the same name is ticked to be deleted, so this one is suggested too (it still needs its own tick).' }),
  none: msg({ id: 'git.cleanUp.none', defaultMessage: 'None', description: 'In the Clean Up Merged Branches dialog, under a heading with nothing to offer.' }),
  deleteTicked: msg({ id: 'git.cleanUp.delete', defaultMessage: 'Delete Ticked', description: 'The button of the Clean Up Merged Branches dialog: deletes the branches ticked.' }),
  deleting: msg({ id: 'git.cleanUp.deleting', defaultMessage: 'Deleting…', description: 'The Clean Up Merged Branches or Delete branch dialog\'s button while branches are being deleted.' }),
  failed: msg({ id: 'git.cleanUp.failed', defaultMessage: "Couldn't delete the branches", description: "An error notification's title: deleting branches in Version Control → Branches & remotes failed." }),
  deleteTip: msg({ id: 'git.branch.deleteTip', defaultMessage: 'Delete {branch}…', description: "Tooltip on a branch's Delete button in Version Control → Branches & remotes (it asks first, showing any commits it would drop)." }),
  deleteMergedTitle: msg({ id: 'git.branch.deleteMergedTitle', defaultMessage: 'Delete {branch}?', description: 'Title of the confirmation before deleting a branch merged into the target.' }),
  deleteMergedMessage: msg({ id: 'git.branch.deleteMergedMessage', defaultMessage: 'Every commit of it is in {target}: nothing is lost.', description: 'The confirmation before deleting a branch merged into the target branch {target}.' }),
  deleteUnmergedTitle: msg({ id: 'git.branch.deleteUnmergedTitle', defaultMessage: '{n, plural, one {Delete {branch} and the commit only it has?} other {Delete {branch} and the # commits only it has?}}', description: "Title of the confirmation before deleting a branch with {n} commits that aren't in the target." }),
  deleteUnmergedMessage: msg({ id: 'git.branch.deleteUnmergedMessage', defaultMessage: "{n, plural, one {This commit isn't in {target}. Deleting {branch} drops it, and Combwork can't bring it back:} other {These commits aren't in {target}. Deleting {branch} drops them, and Combwork can't bring them back:}}", description: "The confirmation before deleting a branch ({branch}) with {n} commits that aren't in the target {target}; the commits are listed under it." }),
  deleteMore: msg({ id: 'git.branch.deleteMore', defaultMessage: '…and {n, plural, one {# more} other {# more}}', description: 'The last line of the commits listed before deleting an unmerged branch: how many more there are than shown.' }),
  deleteButton: msg({ id: 'git.branch.delete', defaultMessage: 'Delete Branch', description: 'The button of the confirmation before deleting a branch.' }),
  dropsFailed: msg({ id: 'git.branch.dropsFailed', defaultMessage: "Couldn't read the commits {branch} would drop", description: "An error notification's title: reading an unmerged branch's commits before deleting it failed." })
}

export function BranchesSection({ project }: { project: ProjectInfo }) {
  const read = useGitRead('git:info', project)
  const busyFor = useFolderBusy(project)
  const { busy, run } = useBusy()
  const [form, setForm] = useState<OpenForm | null>(null)
  const [showRemote, setShowRemote] = useState(false)
  // The info as last read: an open form (Track…'s note) reads it, not what was read when it opened (#1385).
  const latest = useRef<GitRepoInfo | null>(null)
  // Each branch's cards (#1424): from the badges the window reads of every live card, by the line each works on.
  const tasks = useStore((st) => st.tasks)
  const badges = useWorkBadges()
  const onBranch = useMemo(() => branchCards(project.name, tasks, badges), [project.name, tasks, badges])
  const busyBranches = useMemo(() => busyLines(onBranch), [onBranch])
  // The project's names for its stages, read once for every row (HR4's #1424 round 1).
  const names = useProjectStages().get(project.path.toLowerCase())?.names
  useNow(60000)
  // The project's slots and their leases (#1450), read with the branches: each slot row names its lease, each line its slot.
  const [slots, setSlots] = useState<SlotView[]>([])
  // Its review copies and their leases (HI-1710): each copy's row says who uses it.
  const [copies, setCopies] = useState<CopyView[]>([])
  const lanes = useStore((st) => st.lanes)
  useEffect(() => {
    if (read.loading) return
    let live = true
    void call('slots:list', project.path).then(
      (v) => live && setSlots(v),
      () => live && setSlots([])
    )
    void call('copies:list', project.path).then(
      (v) => live && setCopies(v),
      () => live && setCopies([])
    )
    return () => {
      live = false
    }
  }, [project.path, read.loading])

  const act = (name: string, title: string, fn: () => Promise<string>): void => void run(name, () => gitAction(project, title, fn))

  /** A branch, after a confirm that names the agents whose session runs in the folder (idle now: they find it on their next turn). */
  const switchTo = async (target: string, current: string | null): Promise<void> => {
    const idle = project.agents.filter((a) => !awayFromProject(a) && a.live).map((a) => a.name)
    const ok = await confirm({
      title: tr(M.switchTitle, { project: project.name, branch: target }),
      message: tr(M.switchMessage, { current: current ?? tr(M.detachedHead), branch: target }),
      ...(idle.length ? { detail: tr(M.switchIdle, { agents: fmt.list(idle, 'unit'), count: idle.length, branch: target }) } : {}),
      confirmLabel: tr(M.switch)
    })
    if (ok) act(`switch:${target}`, tr(M.switchFailed, { branch: target }), () => call('git:switch', project.path, target))
  }

  const newBranch = async (s: GitRepoSummary): Promise<void> => {
    const blocked = busyFor('create')
    let switchNow = !blocked
    const name = await prompt({
      title: tr(M.newBranchTitle),
      message: [tr(M.newBranchAt, { commit: s.head ?? '', onBranch: s.branch ? 'yes' : 'no', current: s.branch ?? '' }), blocked ? tr(M.newBranchBlocked, { why: blocked }) : ''].filter(Boolean).join(' '),
      placeholder: tr(M.branchPlaceholder),
      confirmLabel: tr(M.create),
      validate: (v) => (!v.trim() ? tr(M.enterName) : /\s/.test(v.trim()) ? tr(M.branchNoSpaces) : null),
      check: blocked ? undefined : { label: tr(M.switchNow), initial: true, set: (v) => (switchNow = v) }
    })
    if (name) act('create', tr(M.createFailed, { branch: name.trim() }), () => call('git:createBranch', project.path, name.trim(), !switchNow))
  }

  const pushNow = async (s: GitRepoSummary): Promise<void> => {
    if (s.upstream?.remote && !s.upstream.gone) return act('push', tr(M.pushFailed, { branch: s.branch ?? '' }), () => call('git:push', project.path))
    let remote = s.remotes.includes('origin') ? 'origin' : s.remotes[0]
    const go = await choose({
      title: tr(M.pushTitle, { branch: s.branch ?? '' }),
      message: tr(M.pushMessage, { branch: s.branch ?? '' }),
      select: { label: tr(M.remote), options: s.remotes.map((r) => ({ label: r, value: r })), initial: remote, set: (v) => (remote = v) },
      choices: [
        { label: tr(M.cancel), value: '' },
        { label: tr(M.push), value: 'push' }
      ]
    })
    if (go === 'push') act('push', tr(M.pushFailed, { branch: s.branch ?? '' }), () => call('git:push', project.path, remote))
  }

  const renameRemote = async (name: string, remotes: string[]): Promise<void> => {
    const next = await prompt({
      title: tr(M.renameRemoteTitle, { remote: name }),
      message: tr(M.renameRemoteMessage),
      initial: name,
      confirmLabel: tr(M.rename),
      validate: (v) => remoteNameProblem(v) ?? (remotes.some((x) => x !== name && x.toLowerCase() === v.trim().toLowerCase()) ? tr(M.remoteTaken, { remote: v.trim() }) : null)
    })
    if (next && next.trim() !== name) act(`remote:${name}`, tr(M.renameRemoteFailed, { remote: name }), () => call('git:renameRemote', project.path, name, next.trim()))
  }

  /**
   * Removes a remote after a confirm naming every branch that stops tracking it (read from main, never the view's capped
   * list); main refuses it if that set changed meanwhile. Run with the dialog open: a failure stays in it.
   */
  const removeRemote = async (name: string): Promise<void> => {
    const tracking = await attempt(tr(M.removeRemoteFailed, { remote: name }), () => call('git:remoteTracking', project.path, name))
    if (!tracking) return
    await confirm({
      title: tr(M.removeRemoteTitle, { remote: name }),
      message: tr(M.removeRemoteMessage, { remote: name, n: tracking.length }),
      ...(tracking.length ? { list: tracking, listMono: true } : {}),
      detail: tr(M.removeRemoteDetail, { remote: name }),
      confirmLabel: tr(M.remove),
      busyLabel: tr(M.removing),
      danger: true,
      run: async () => {
        try {
          notify('success', await call('git:removeRemote', project.path, name, tracking))
        } finally {
          bumpGit(project.path)
        }
      }
    })
  }

  const untrack = async (branch: string, upstream: string): Promise<void> => {
    const ok = await confirm({ title: tr(M.untrackTitle, { branch, upstream }), message: tr(M.untrackMessage, { branch }), confirmLabel: tr(M.untrack) })
    if (ok) act(`track:${branch}`, tr(M.untrackFailed, { branch, upstream }), () => call('git:setUpstream', project.path, branch, null))
  }

  /**
   * Clean Up Merged Branches (#1642): the offer ticked as the user leaves it, local branches first, then each remote's
   * (outward-facing, none ticked to start with), each deleted at the commit shown.
   */
  const cleanUp = async (offer: CleanupOffer, target: string): Promise<void> => {
    let picked: CleanupOffer = { local: offer.local, remote: [] }
    // What is deleted already (#1642 round 2): a retry after a failure, or a tick changed after one, never asks for it
    // again, so a remote that failed is tried again on its own.
    const done = new Set<string>()
    await confirm({
      title: tr(C.cleanUpTitle),
      message: tr(C.cleanUpMessage, { target }),
      content: <CleanupPicker offer={offer} onChange={(p) => (picked = p)} />,
      wide: true,
      confirmLabel: tr(C.deleteTicked),
      busyLabel: tr(C.deleting),
      danger: true,
      run: async () => {
        // Each part said as it is done: a remote's failure (shown in the dialog) never hides the local branches deleted.
        const asked = ({ name, sha }: BranchAt): BranchAt => ({ name, sha })
        const local = picked.local.filter((b) => !done.has(`local:${b.name}`))
        const remote = picked.remote.filter((r) => !done.has(`remote:${r.name}`))
        try {
          if (local.length) {
            notify('success', await call('git:deleteBranches', project.path, local.map(asked)))
            for (const b of local) done.add(`local:${b.name}`)
          }
          for (const name of [...new Set(remote.map((r) => r.remote))]) {
            const mine = remote.filter((r) => r.remote === name)
            notify('success', await call('git:deleteRemoteBranches', project.path, name, mine.map(asked)))
            for (const r of mine) done.add(`remote:${r.name}`)
          }
        } finally {
          bumpGit(project.path)
        }
      }
    })
  }

  const editRemote = async (name: string, url: string): Promise<void> => {
    const next = await prompt({ title: tr(M.changeUrlTitle, { remote: name }), initial: url, confirmLabel: tr(M.change), validate: remoteUrlProblem })
    // An https URL shows with its password hidden: unchanged, nothing to save.
    if (next && next.trim() !== url) act(`remote:${name}`, tr(M.changeUrlFailed, { remote: name }), () => call('git:setRemoteUrl', project.path, name, next.trim()))
  }

  return (
    <Loading read={read} what={tr(M.branchesLoad)}>
      {(info: GitRepoInfo) => {
        latest.current = info
        const s = info.summary
        // Inside another repository (a workspace kept in git): shown, never changed here.
        const ro = parentRepoText(s)
        const off = !!busy || !!ro
        const switchBlocked = ro ?? busyFor('switch')
        const pullBlocked = ro ? ro : !s.branch ? tr(M.pullDetached) : !s.upstream || s.upstream.gone ? tr(M.pullNoUpstream, { branch: s.branch }) : s.state ? tr(M.pullState, { state: gitStateKey(s.state) }) : busyFor('pull')
        const pushBlocked = ro ? ro : !s.branch ? tr(M.pushDetached) : !s.head ? tr(M.pushNoCommits) : !s.remotes.length ? tr(M.pushNoRemote) : null
        const fetched = at(s.fetchedAt)
        const remoteRows: GitRemoteBranchRow[] = info.remoteRows ?? info.remoteBranches.map((name) => ({ name, remote: name.slice(0, name.indexOf('/')), branch: name.slice(name.indexOf('/') + 1), sha: '', date: 0, toTarget: null, remoteHead: false }))
        const remoteOnly = remoteRows.filter((r) => !info.branches.some((b) => b.name === r.name.slice(r.name.indexOf('/') + 1)))
        // Grouped by state against the project's target (#1642); with none known, the list as it was.
        const target = info.target ?? null
        const offer = cleanupOffer(info, busyBranches)
        // Update from <target> (HI-1180): a branch that lacks some of the target's commits (never the target), with work of
        // its own, or in use (HR4's round 1: a card's new line behind its target, fast-forwarded); a merged branch nothing
        // uses is Clean Up's, not to update.
        const updatable = (b: GitBranchRow): boolean => !!target && b.name !== target && !!b.fromTarget && (!!b.toTarget || !!localUse(b, info, busyBranches))
        const updateFrom = async (b: GitBranchRow): Promise<void> => {
          const plan = await attempt(tr(U.planFailed, { branch: b.name }), () => call('git:updatePlan', project.path, b.name))
          if (plan) setForm({ make: () => updateForm(project, plan) })
        }
        const warnings = identityWarnings(info.identity, info.remotes)
        // A folder's slot (#1450), and its agent: the slot's lease's, else the agent whose session runs there.
        const slotOf = (path: string | null): SlotView | undefined => (path ? slots.find((x) => samePath(x.folder, path)) : undefined)
        const agentOf = (path: string | null) => {
          if (!path) return undefined
          const lease = slotOf(path)?.lease
          return project.agents.find((a) => (lease ? a.id === lease.agent : !!a.live?.cwd && samePath(a.live.cwd, path)))
        }
        const leaseText = (v: SlotView): string => {
          const l = v.lease
          const agent = l ? (project.agents.find((a) => a.id === l.agent)?.name ?? l.agent) : ''
          const card = l && l.card !== null ? cardLabelOf({ tasks }, l.card) : ''
          const lane = l?.lane ? (lanes.find((x) => x.id === l.lane)?.name ?? l.lane) : ''
          return tr(M.slotLease, { kind: l ? (l.kind === 'carried' ? 'carried' : l.card !== null ? 'card' : 'lane') : 'none', slot: v.name, agent, card, lane })
        }
        // The worktrees as the user's (agents', slots', unused ones) and Hive's own (HI-1710).
        const theirs = info.worktrees.filter((w) => !w.hive)
        const hiveCopies = info.worktrees.filter((w) => w.hive === 'copy')
        const hiveQueue = info.worktrees.filter((w) => w.hive === 'queue')
        const copyText = (path: string): string => {
          const c = copies.find((x) => samePath(x.folder, path))
          const l = c?.lease && !c.lease.returned ? c.lease : null
          const agent = l?.agent ? (project.agents.find((a) => a.id === l.agent)?.name ?? l.agent) : ''
          return tr(M.copyRow, { use: l ? l.kind : 'none', copy: c?.name ?? path.split(/[\\/]/).pop() ?? '', agent, card: l ? cardLabelOf({ tasks }, l.card) : '', revision: c?.revision ? c.revision.slice(0, 7) : '' }) // i18n-ignore: a select's key, never shown
        }
        const cardsOf = (branch: string | null) => (branch ? (onBranch.get(branch) ?? []) : [])
        // A worktree names the card its agent is on, whatever its folder has checked out (HR4's #1424 round 1).
        const agentsCard = (path: string) => agentCard(project.name, agentOf(path)?.id, tasks, badges)
        return (
          <div className="git-branches" data-git-branches="">
            <h2 className="section git-section-head">
              {tr(M.branch)}
              <span className="git-section-actions">
                <IconButton icon={read.loading ? 'loading' : 'refresh'} spin={read.loading} title={tr(M.readAgain)} action="reload-branches" onClick={read.reload} />
              </span>
            </h2>
            {!ro && !s.head && (
              <div className="banner warn" data-git-no-commits="">
                <Icon name="warning" /> {tr(M.noCommitsBanner)}
                <div style={{ marginTop: 6 }}>
                  <InitRepoButton project={project} label={tr(INIT_TEXT.firstCommitButton)} small />
                </div>
              </div>
            )}
            {ro && (
              <div className="banner info" data-git-parent="">
                <Icon name="info" /> {ro}
                <div style={{ marginTop: 6 }}>
                  <InitRepoButton project={project} label={tr(INIT_TEXT.ownRepoButton)} small />
                </div>
              </div>
            )}
            <div className="git-current" data-git-current="">
              <div className="git-current-line">
                <Icon name="git-branch" /> <strong data-git-head="">{headText(s)}</strong>
                {s.state && <span className="badge warn">{gitStateText(s.state)}</span>}
                {s.upstream ? (
                  <span className="faint" data-git-upstream="">
                    {rich(M.tracks, { upstream: s.upstream.name, aheadBehind: aheadBehindText(s.upstream), ab })}
                  </span>
                ) : s.branch && s.remotes.length ? (
                  <span className="faint">{tr(M.tracksNothing)}</span>
                ) : null}
              </div>
              {s.state && <div className="banner warn">{tr(M.stateBanner, { state: gitStateKey(s.state) })}</div>}
              {s.remotes.length > 0 && (
                <div className="git-fetched faint" data-git-fetched="">
                  {fetched ? tr(M.fetchedAt, { when: fetched }) : tr(M.neverFetched)}
                  <Tooltip content={tr(M.fetchTip)}>
                    <button className="btn small subtle" disabled={off} aria-label={tr(M.fetch)} data-action="fetch" onClick={() => act('fetch', tr(M.fetchFailed), () => call('git:fetch', project.path))}>
                      <Icon name={busy === 'fetch' ? 'loading' : 'refresh'} spin={busy === 'fetch'} /> {tr(M.fetch)}
                    </button>
                  </Tooltip>
                </div>
              )}
              <div className="git-actions">
                <Tooltip content={pullBlocked ?? tr(M.pullTip, { upstream: s.upstream?.name ?? '', branch: s.branch ?? '' })}>
                  <span>
                    <BusyButton className="small" busy={busy === 'pull'} busyLabel={tr(M.pulling)} disabled={!!pullBlocked || off} onClick={() => act('pull', tr(M.pullFailed), () => call('git:pull', project.path))}>
                      <Icon name="repo-pull" /> {tr(M.pull)}
                    </BusyButton>
                  </span>
                </Tooltip>
                <Tooltip content={pushBlocked ?? (s.upstream?.remote && !s.upstream.gone ? tr(M.pushTo, { branch: s.branch ?? '', upstream: s.upstream.name }) : tr(M.pushTrack, { branch: s.branch ?? '' }))}>
                  <span>
                    <BusyButton className="small" busy={busy === 'push'} busyLabel={tr(M.pushing)} disabled={!!pushBlocked || off} onClick={() => void pushNow(s)}>
                      <Icon name="repo-push" /> {tr(M.push)}
                    </BusyButton>
                  </span>
                </Tooltip>
                {s.remotes.length > 0 && (
                  <Tooltip content={ro ?? (!s.head ? tr(M.pushNoCommits) : tr(M.pushToTip, { branch: s.branch ?? '' }))}>
                    <span>
                      <button className="btn small" data-action="push-to" disabled={!s.head || off} onClick={() => setForm({ make: () => pushToForm(project, s) })}>
                        <Icon name="repo-push" /> {tr(M.pushToButton)}
                      </button>
                    </span>
                  </Tooltip>
                )}
                <Tooltip content={!s.head ? tr(M.commitFirst) : tr(M.branchAt, { commit: s.head })}>
                  <span>
                    <button className="btn small" data-action="new-branch" disabled={!s.head || off} onClick={() => void newBranch(s)}>
                      <Icon name="git-branch-create" /> {tr(M.newBranch)}
                    </button>
                  </span>
                </Tooltip>
              </div>
            </div>

            <h2 className="section git-section-head">
              {tr(M.branches)} <span className="badge">{info.branches.length}</span>
              {target && (
                <span className="git-section-actions">
                  <Tooltip content={ro ?? tr(C.cleanUpTip, { n: offer.local.length + offer.remote.length, target })}>
                    <span>
                      <button className="btn small" data-action="clean-up-branches" disabled={off || !(offer.local.length + offer.remote.length)} onClick={() => void cleanUp(offer, target)}>
                        <Icon name="trash" /> {tr(C.cleanUp)}
                      </button>
                    </span>
                  </Tooltip>
                </span>
              )}
            </h2>
            <div className="git-rows">
              {grouped(info.branches, (b) => localGroup(b, info, busyBranches)).map((item) => {
                if ('group' in item) return <GroupHead key={`group:${item.group}`} group={item.group} n={item.n} target={target ?? ''} />
                const b = item.row
                const agent = agentOf(b.worktree)
                const slot = slotOf(b.worktree)
                const why = b.current ? null : b.worktree ? tr(M.checkedOutIn, { where: agent ? 'agent' : 'other', agent: agent?.name ?? '' }) : switchBlocked
                const free = !!target && !localUse(b, info, busyBranches)
                return (
                  <div key={b.name} className={cx('git-row', 'git-branch', b.current && 'current')} data-branch={b.name}>
                    <Icon name={b.current ? 'check' : b.worktree ? 'repo' : 'git-branch'} />
                    <span className="git-name" title={b.name}>
                      {b.name}
                    </span>
                    {/* What it is and where it stands, then its last commit: what gives way to the time and the actions
                        when the row is short of room (HI-1897), cut with "…", the whole of it in its tooltip. */}
                    <span className="git-branch-info" onMouseEnter={(e) => fullTip(e.currentTarget)}>
                    {b.worktree &&
                      (slot ? (
                        <span className="badge" data-worktree="" data-slot={slot.name} title={leaseText(slot)}>
                          {slot.name}
                        </span>
                      ) : (
                        <span className="badge" data-worktree="">
                          {agent ? tr(M.agentWorktree, { agent: agent.name }) : tr(M.worktreeBadge)}
                        </span>
                      ))}
                    <BranchCards cards={cardsOf(b.name)} project={project} names={names} />
                    {b.upstream && (
                      <span className="faint git-track">
                        {b.upstream} · {aheadBehindText(b)}
                      </span>
                    )}
                    {free && !!b.toTarget && (
                      <span className="faint git-track" data-to-target={b.toTarget}>
                        {tr(C.ahead, { n: b.toTarget, target })}
                      </span>
                    )}
                    {updatable(b) && (
                      <span className="faint git-track" data-from-target={b.fromTarget}>
                        {tr(U.behind, { n: b.fromTarget!, target: target! })}
                      </span>
                    )}
                    <span className="git-subject faint">{b.subject}</span>
                    </span>
                    {/* The time and the actions never shrink, each action in its own place on every row (an empty one
                        where the row has none), so they line up down the list (HI-1897). */}
                    <span className="git-row-tail">
                    <span className="git-meta faint">{at(b.date)}</span>
                    {info.remotes.length > 0 && (
                      <span className="git-row-actions">
                        <IconButton icon={busy === `track:${b.name}` ? 'loading' : 'link'} spin={busy === `track:${b.name}`} title={tr(M.trackTip, { branch: b.name })} action="track" disabled={off} onClick={() => setForm({ make: () => trackForm(project, latest.current ?? info, b) })} />
                        {b.upstream ? <IconButton icon="debug-disconnect" title={tr(M.untrackTip, { upstream: b.upstream })} action="untrack" disabled={off} onClick={() => void untrack(b.name, b.upstream!)} /> : <span className="git-act-slot" />}
                      </span>
                    )}
                    {updatable(b) ? <IconButton icon="repo-pull" title={tr(U.tip, { branch: b.name, target: target! })} action="update-branch" disabled={!!ro} onClick={() => void updateFrom(b)} /> : <span className="git-act-slot" />}
                    {!b.current ? <IconButton icon="git-merge" title={tr(M.mergeBranch, { branch: b.name })} action="merge-branch" disabled={!!ro} onClick={() => set({ branchMergeFor: { project: project.path, branch: b.name } })} /> : <span className="git-act-slot" />}
                    {free ? <IconButton icon="trash" title={tr(C.deleteTip, { branch: b.name })} action="delete-branch" disabled={off} onClick={() => void deleteBranch(project, b, target!)} /> : <span className="git-act-slot" />}
                    {!b.current ? (
                      <Tooltip content={why ?? tr(M.switchTip, { branch: b.name })}>
                        <span>
                          <button className="btn small subtle" disabled={!!why || off} onClick={() => void switchTo(b.name, s.branch)}>
                            {busy === `switch:${b.name}` ? <Icon name="loading" spin /> : tr(M.switch)}
                          </button>
                        </span>
                      </Tooltip>
                    ) : (
                      // The current branch has no Switch: its place kept, unseen, so the others line up with it.
                      <span className="git-switch-slot" aria-hidden="true">
                        <button className="btn small subtle" tabIndex={-1} disabled>
                          {tr(M.switch)}
                        </button>
                      </span>
                    )}
                    </span>
                  </div>
                )
              })}
              {remoteOnly.length > 0 && (
                <button className="btn small subtle git-more" onClick={() => setShowRemote(!showRemote)}>
                  <Icon name={showRemote ? 'chevron-down' : 'chevron-right'} /> {tr(M.remoteBranches, { count: remoteOnly.length })}
                </button>
              )}
              {showRemote &&
                grouped(remoteOnly, (x) => remoteGroup(x, info)).map((item) => {
                  if ('group' in item) return <GroupHead key={`remote-group:${item.group}`} group={item.group} n={item.n} target={target ?? ''} remote />
                  const { name: r, toTarget } = item.row
                  return (
                  <div key={r} className="git-row git-branch remote" data-remote-branch={r}>
                    <Icon name="cloud" />
                    <span className="git-name" title={r}>
                      {r}
                    </span>
                    <span className="git-branch-info" onMouseEnter={(e) => fullTip(e.currentTarget)}>
                      {!!toTarget && remoteGroup(item.row, info) === 'unmerged' && (
                        <span className="faint git-track" data-to-target={toTarget}>
                          {tr(C.ahead, { n: toTarget, target: target ?? '' })}
                        </span>
                      )}
                    </span>
                    <span className="git-row-tail">
                      <Tooltip content={switchBlocked ?? tr(M.trackLocal, { branch: r.slice(r.indexOf('/') + 1), remote: r })}>
                        <span>
                          <button className="btn small subtle" disabled={!!switchBlocked || off} onClick={() => void switchTo(r, s.branch)}>
                            {tr(M.switch)}
                          </button>
                        </span>
                      </Tooltip>
                    </span>
                  </div>
                  )
                })}
            </div>

            <h2 className="section git-section-head">
              {tr(M.remotes)} <span className="badge">{info.remotes.length}</span>
              <span className="git-section-actions">
                <button className="btn small" data-action="add-remote" disabled={off} onClick={() => setForm({ make: () => remoteForm(project) })}>
                  <Icon name="add" /> {tr(M.addRemote)}
                </button>
              </span>
            </h2>
            {info.remotes.length === 0 ? (
              <p className="hint">{tr(M.noRemotes)}</p>
            ) : (
              <div className="git-rows">
                {info.remotes.map((r) => (
                  <div key={r.name} className="git-row git-remote" data-remote={r.name}>
                    <Icon name="cloud" />
                    <span className="git-name">{r.name}</span>
                    <span className="git-url">
                      {r.fetchUrl}
                      {r.pushUrl && r.pushUrl !== r.fetchUrl && <span className="faint"> {tr(M.pushesTo, { url: r.pushUrl })}</span>}
                    </span>
                    <IconButton icon="edit" title={tr(M.changeUrlTitle, { remote: r.name })} disabled={off} onClick={() => void editRemote(r.name, r.fetchUrl)} />
                    <IconButton icon="whole-word" title={tr(M.renameRemoteTip, { remote: r.name })} action="rename-remote" disabled={off} onClick={() => void renameRemote(r.name, info.remotes.map((x) => x.name))} />
                    <IconButton icon="trash" title={tr(M.removeRemoteTip, { remote: r.name })} action="remove-remote" disabled={off} onClick={() => void removeRemote(r.name)} />
                  </div>
                ))}
              </div>
            )}

            {theirs.length > 0 && (
              <>
                <h2 className="section">
                  {tr(M.worktrees)} <span className="badge">{theirs.length}</span>
                </h2>
                <p className="hint">{tr(M.readOnly)}</p>
                <div className="git-rows">
                  {theirs.map((w) => {
                    const agent = agentOf(w.path)
                    const slot = slotOf(w.path)
                    return (
                      <div key={w.path} className="git-row git-worktree" data-worktree-row={w.path} {...(slot ? { 'data-slot': slot.name } : {})}>
                        <Icon name="repo" />
                        <span className="git-name">{slot ? leaseText(slot) : agent ? tr(M.agentWorktree, { agent: agent.name }) : tr(M.unusedWorktree)}</span>
                        <span className="faint">{w.branch ?? (w.head ? headText({ branch: null, head: w.head }) : '')}</span>
                        {slot?.writer?.held && (
                          <>
                            <span className="faint" data-held={slot.writer.agent}>
                              {tr(SLOT_HELD_TEXT.held, { agent: project.agents.find((a) => a.id === slot.writer!.agent)?.name ?? slot.writer.agent })}
                            </span>
                            <button className="btn small subtle" data-action="release-held" onClick={() => void releaseHeldSlot(project.path, slot.name).then(read.reload)}>
                              {tr(SLOT_HELD_TEXT.release)}
                            </button>
                          </>
                        )}
                        <BranchCards cards={agentsCard(w.path)} project={project} names={names} />
                        <span className="git-url faint">{w.path}</span>
                        <button
                          className="btn small subtle"
                          onClick={() => {
                            set((st) => ({ changesRoot: { ...st.changesRoot, [project.path]: !slot && agent ? agent.id : UNUSED_ROOT } }))
                            showVersionControl(project.path, 'changes')
                          }}
                        >
                          {tr(M.changes)}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </>
            )}
            {/* Hive's own worktrees (HI-1710): its review copies and the merge queue's folder, each its group, nothing to remove. */}
            {hiveCopies.length > 0 && (
              <>
                <h2 className="section" data-worktrees="copies">
                  {tr(M.copiesHeading)} <span className="badge">{hiveCopies.length}</span>
                </h2>
                <p className="hint">{tr(M.copiesHint)}</p>
                <div className="git-rows">
                  {hiveCopies.map((w) => (
                    <div key={w.path} className="git-row git-worktree" data-worktree-row={w.path} data-hive="copy">
                      <Icon name="shield" />
                      <span className="git-name">{copyText(w.path)}</span>
                      <span className="faint">{w.branch ?? (w.head ? headText({ branch: null, head: w.head }) : '')}</span>
                      <span className="git-url faint">{w.path}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            {hiveQueue.length > 0 && (
              <>
                <h2 className="section" data-worktrees="queue">
                  {tr(M.queueHeading)} <span className="badge">{hiveQueue.length}</span>
                </h2>
                <p className="hint">{tr(M.queueHint)}</p>
                <div className="git-rows">
                  {hiveQueue.map((w) => (
                    <div key={w.path} className="git-row git-worktree" data-worktree-row={w.path} data-hive="queue">
                      <Icon name="git-merge" />
                      <span className="git-name">{tr(M.queueRow)}</span>
                      <span className="faint">{w.branch ?? (w.head ? headText({ branch: null, head: w.head }) : '')}</span>
                      <span className="git-url faint">{w.path}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <h2 className="section git-section-head">
              {tr(M.identity)}
              <span className="git-section-actions">
                <button className="btn small" data-action="set-identity" disabled={off} onClick={() => setForm({ make: () => identityForm(project, info) })}>
                  <Icon name="person" /> {tr(M.setIdentity)}
                </button>
              </span>
            </h2>
            {warnings.map((w) => (
              <div key={w} className="banner warn" data-identity-warning="">
                <Icon name="warning" /> {w}
              </div>
            ))}
            {/* In a narrow column the table scrolls sideways in its own box rather than run under the panel beside it (#886). */}
            <div className="git-identity-wrap">
            <table className="kv git-identity" data-git-identity="">
              <tbody>
                <tr>
                  <td></td>
                  <td className="faint">{tr(M.thisRepo)}</td>
                  <td className="faint">{tr(M.global)}</td>
                  <td className="faint">{tr(M.commitsUse)}</td>
                </tr>
                {(['name', 'email'] as const).map((k) => (
                  <tr key={k} className={`identity-${k}`}>
                    <td>{tr(k === 'name' ? M.name : M.email)}</td>
                    <td>{info.identity.local[k] ?? <span className="faint">{tr(M.notSet)}</span>}</td>
                    <td>{info.identity.global[k] ?? <span className="faint">{tr(M.notSet)}</span>}</td>
                    <td data-identity-used={k}>
                      <strong>{info.identity.effective[k] ?? '—'}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            {form && <GitForm make={form.make} onClose={() => setForm(null)} />}
          </div>
        )
      }}
    </Loading>
  )
}

/**
 * Rows in their groups (#1642): In use, Merged, Not merged, each under its heading with how many, in their order within
 * it (newest first). With no group (no target known) the rows as they are.
 */
function grouped<T>(rows: T[], groupOf: (row: T) => BranchGroup | null): ({ group: BranchGroup; n: number } | { row: T })[] {
  const groups = rows.map(groupOf)
  if (groups.every((g) => g === null)) return rows.map((row) => ({ row }))
  return BRANCH_GROUPS.flatMap((group) => {
    const mine = rows.filter((_, i) => groups[i] === group)
    return mine.length ? [{ group, n: mine.length }, ...mine.map((row) => ({ row }))] : []
  })
}

function GroupHead({ group, n, target, remote }: { group: BranchGroup; n: number; target: string; remote?: boolean }) {
  return (
    <div className="git-row git-group-h" data-branch-group={group} {...(remote ? { 'data-remote-group': '' } : {})}>
      <Tooltip content={tr(C.groupTip, { group, target })}>
        <span>
          {tr(C.group, { group, target })} <span className="badge">{n}</span>
        </span>
      </Tooltip>
    </div>
  )
}

/**
 * Clean Up Merged Branches' choice (#1642): the local branches offered, ticked; the remote ones apart, under a warning
 * that ticking them deletes them on the remote, none ticked (one whose local branch is ticked is marked suggested).
 */
function CleanupPicker({ offer, onChange }: { offer: CleanupOffer; onChange: (picked: CleanupOffer) => void }) {
  const [local, setLocal] = useState<ReadonlySet<string>>(() => new Set(offer.local.map((b) => b.name)))
  const [remote, setRemote] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    onChange({ local: offer.local.filter((b) => local.has(b.name)), remote: offer.remote.filter((r) => remote.has(r.name)) })
  }, [offer, local, remote, onChange])
  const flip = (from: ReadonlySet<string>, name: string, on: boolean): Set<string> => {
    const next = new Set(from)
    if (on) next.add(name)
    else next.delete(name)
    return next
  }
  const remotes = [...new Set(offer.remote.map((r) => r.remote))]
  return (
    <div className="git-cleanup" data-git-cleanup="">
      <div className="git-cleanup-h">{tr(C.localHead, { n: offer.local.length })}</div>
      {offer.local.length ? (
        <ul className="git-cleanup-list">
          {offer.local.map((b) => (
            <li key={b.name}>
              <label className="dialog-check">
                <input type="checkbox" className="checkbox" data-cleanup-local={b.name} checked={local.has(b.name)} onChange={(e) => setLocal(flip(local, b.name, e.target.checked))} />
                <code>{b.name}</code>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <div className="faint">{tr(C.none)}</div>
      )}
      {offer.remote.length > 0 && (
        <>
          <div className="git-cleanup-h">{tr(C.remoteHead, { remotes: fmt.list(remotes, 'unit'), n: offer.remote.length })}</div>
          <div className="banner warn" data-git-cleanup-remote-warning="">
            <Icon name="warning" /> {tr(C.remoteWarn)}
          </div>
          <ul className="git-cleanup-list">
            {offer.remote.map((r) => (
              <li key={r.name}>
                <label className="dialog-check">
                  <input type="checkbox" className="checkbox" data-cleanup-remote={r.name} checked={remote.has(r.name)} onChange={(e) => setRemote(flip(remote, r.name, e.target.checked))} />
                  <code>{r.name}</code>
                  {r.withLocal && local.has(r.branch) && <span className="faint">· {tr(C.withLocal)}</span>}
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/** Update from <target> (HI-1180): a branch's row action and its dialog. */
const U = {
  behind: msg({ id: 'git.update.behind', defaultMessage: "{n, plural, one {# commit of {target} it hasn't} other {# commits of {target} it hasn't}}", description: "On a branch in Version Control → Branches & remotes (HI-1180): how many commits of the target branch {target} the branch doesn't have yet (Update from {target} brings them in)." }),
  tip: msg({ id: 'git.update.tip', defaultMessage: 'Update {branch} from {target}…', description: "Tooltip on a branch's Update button in Version Control → Branches & remotes (HI-1180): merges the target {target} into the branch {branch}, or rebases it onto {target} (a dialog asks which first)." }),
  planFailed: msg({ id: 'git.update.planFailed', defaultMessage: "Couldn't read what updating {branch} would do", description: "An error notification's title (HI-1180): reading what Update from <target> would do to the branch {branch} failed." }),
  title: msg({ id: 'git.update.title', defaultMessage: 'Update {branch} from {target}', description: 'Title of the Update from <target> dialog (HI-1180): bring the branch {branch} up to date with the target branch {target}.' }),
  counts: msg({ id: 'git.update.counts', defaultMessage: "{target} has {behind, plural, one {# commit} other {# commits}} {branch} hasn't; {branch} has {ahead, plural, one {# commit} other {# commits}} of its own.", description: "The Update from <target> dialog's first sentence: how many commits of the target {target} the branch {branch} lacks ({behind}), and how many it has that the target hasn't ({ahead})." }),
  where: msg({ id: 'git.update.where', defaultMessage: '{where, select, project {It runs in the project folder, where {branch} is checked out.} slot {It runs in {slot}, the slot {branch} is checked out in.} worktree {It runs in {folder}, where {branch} is checked out.} other {{branch} is checked out nowhere: Combwork updates it in a temporary folder, removed after.}}', description: "The Update from <target> dialog: where the update runs (select: translate each): the project folder, a slot ({slot}: its name, such as slot-a), another worktree ({folder}: its path), or a temporary folder Hive makes when the branch isn't checked out anywhere." }),
  card: msg({ id: 'git.update.card', defaultMessage: "It is {card}'s work.", description: "The Update from <target> dialog: the branch is the line of a card ({card}: its key, such as HI-12) that isn't Done." }),
  agents: msg({ id: 'git.update.agents', defaultMessage: '{agents} {n, plural, one {works} other {work}} there: {n, plural, one {its} other {their}} next turn starts from the updated branch.', description: 'The Update from <target> dialog: agents ({agents}: their names, joined) work in the folder the update runs in, none in a turn now; what they do next starts from the updated branch.' }),
  approval: msg({ id: 'git.update.approval', defaultMessage: '{approval, select, carries {{card} has passed review: its pass carries over when the update is the same change, as a clean merge or rebase is.} other {{card} has passed review: once updated, it goes back for review (the project keeps a pass only for the exact commit).}}', description: "The Update from <target> dialog, for a card that passed review ({card}: its key): whether the pass survives the update (carries: the project's \"A pass survives a clean rebase\" is on; other: the card is reviewed again). Select: translate each." }),
  undone: msg({ id: 'git.update.undone', defaultMessage: 'A conflict is undone at once, leaving {branch} as it was.', description: 'The Update from <target> dialog: if git stops at a conflict, Hive aborts the merge or rebase, so the branch {branch} is never left half updated.' }),
  how: msg({ id: 'git.update.how', defaultMessage: 'How', description: 'A label in the Update from <target> dialog: the choice of Merge or Rebase.' }),
  merge: msg({ id: 'git.update.merge', defaultMessage: 'Merge {target} in', description: 'An option in the Update from <target> dialog (the default): merge the target branch {target} into the branch, as one merge commit.' }),
  rebase: msg({ id: 'git.update.rebase', defaultMessage: 'Rebase onto {target}', description: "An option in the Update from <target> dialog: replay the branch's own commits on top of the target branch {target}." }),
  mergeNote: msg({ id: 'git.update.mergeNote', defaultMessage: "One merge commit joins {target}'s commits to {branch}'s, which stay as they are.", description: 'What Merge does, under the choice in the Update from <target> dialog: one merge commit; the branch {branch} keeps its own commits as they are.' }),
  rebaseNote: msg({ id: 'git.update.rebaseNote', defaultMessage: "{branch}'s {n, plural, one {commit is} other {# commits are}} replayed on top of {target}, as new commits.{pushed, select, yes { What was pushed of {branch} then differs from it, and Combwork never forces a push.} other {}}", description: "What Rebase does, under the choice in the Update from <target> dialog: the branch's {n} commits are rewritten on top of {target}; with pushed yes, it tracks a remote branch, which then no longer matches (pushing it would need a force, which Hive never does)." }),
  forward: msg({ id: 'git.update.forward', defaultMessage: 'Fast-forward to {target}', description: 'The one choice in the Update from <target> dialog for a branch with no commits of its own (HI-1180): it is moved forward to the target branch {target}.' }),
  forwardNote: msg({ id: 'git.update.forwardNote', defaultMessage: '{branch} has no commits of its own, so it simply moves forward to {target}: no merge commit, nothing rewritten.', description: 'What Fast-forward does, under the choice in the Update from <target> dialog: the branch {branch} has nothing the target {target} lacks, so it moves to the target.' }),
  confirm: msg({ id: 'git.update.confirm', defaultMessage: 'Update', description: 'The Update from <target> dialog\'s button: updates the branch.' }),
  busy: msg({ id: 'git.update.busy', defaultMessage: 'Updating…', description: 'The Update from <target> dialog\'s button while the branch is being updated.' })
}

/** Update from <target> (HI-1180): what it does to the branch, merge or rebase, as its plan says it now. */
function updateForm(project: ProjectInfo, p: BranchUpdatePlan): FormSpec {
  const lines = [
    tr(U.counts, { target: p.target, behind: p.behind, branch: p.branch, ahead: p.ahead }),
    tr(U.where, { where: p.where, branch: p.branch, slot: p.slot ?? '', folder: p.folder ?? '' }),
    ...(p.card ? [tr(U.card, { card: p.card.key })] : []),
    ...(p.agents.length ? [tr(U.agents, { agents: fmt.list(p.agents.map((a) => a.name)), n: p.agents.length })] : []),
    ...(p.card && p.approval ? [tr(U.approval, { approval: p.approval, card: p.card.key })] : []),
    tr(U.undone, { branch: p.branch })
  ]
  return {
    project,
    title: tr(U.title, { branch: p.branch, target: p.target }),
    icon: 'repo-pull',
    about: lines.join(' '),
    // Nothing of its own: a fast-forward, the only choice (main does the same whichever it is given).
    fields: [{ key: 'how', label: tr(U.how), initial: 'merge', options: p.ahead ? [{ label: tr(U.merge, { target: p.target }), value: 'merge' }, { label: tr(U.rebase, { target: p.target }), value: 'rebase' }] : [{ label: tr(U.forward, { target: p.target }), value: 'merge' }] }],
    confirm: tr(U.confirm),
    busyLabel: tr(U.busy),
    // Why it can't run now (an agent in a turn there, uncommitted changes…): shown, and Update off.
    validate: () => p.blocked,
    note: (v) => (!p.ahead ? tr(U.forwardNote, { branch: p.branch, target: p.target }) : v.how === 'rebase' ? tr(U.rebaseNote, { branch: p.branch, n: p.ahead, target: p.target, pushed: p.pushed ? 'yes' : 'no' }) : tr(U.mergeNote, { target: p.target, branch: p.branch })),
    submit: (v) => call('git:updateBranch', project.path, p.branch, v.how === 'rebase' ? 'rebase' : 'merge')
  }
}

function remoteForm(project: ProjectInfo): FormSpec {
  return {
    project,
    title: tr(M.addRemoteTitle),
    icon: 'cloud',
    about: tr(M.addRemoteAbout),
    fields: [
      // i18n-ignore: git's usual name for a remote
      { key: 'name', label: tr(M.remoteName), initial: 'origin', placeholder: 'origin' },
      // i18n-ignore: an example URL
      { key: 'url', label: tr(M.url), placeholder: 'https://github.com/you/repo.git' }
    ],
    confirm: tr(M.add),
    busyLabel: tr(M.adding),
    validate: (v) => remoteNameProblem(v.name) ?? remoteUrlProblem(v.url),
    submit: (v) => call('git:addRemote', project.path, v.name.trim(), v.url.trim())
  }
}

/** Push to… (#1385): a remote (another than the branch's own first) and what: this branch, or every branch and tag. */
function pushToForm(project: ProjectInfo, s: GitRepoSummary): FormSpec {
  const first = s.remotes.find((r) => r !== s.upstream?.remote) ?? s.remotes[0] ?? ''
  return {
    project,
    title: tr(M.pushToTitle),
    icon: 'repo-push',
    about: tr(M.pushToAbout, { onBranch: s.branch ? 'yes' : 'no', branch: s.branch ?? '' }),
    fields: [
      { key: 'remote', label: tr(M.remote), initial: first, options: s.remotes.map((r) => ({ label: r, value: r })) },
      { key: 'scope', label: tr(M.pushWhat), initial: s.branch ? 'branch' : 'all', options: [...(s.branch ? [{ label: tr(M.pushThisBranch, { branch: s.branch }), value: 'branch' }] : []), { label: tr(M.pushAll), value: 'all' }] }
    ],
    confirm: tr(M.push),
    busyLabel: tr(M.pushing),
    validate: (v) => (v.remote ? null : tr(M.pushNoRemote)),
    // The branch the form names, as it named it when opened: never whichever is checked out when Push runs.
    submit: (v) => call('git:pushTo', project.path, v.remote, v.scope === 'all' ? 'all' : 'branch', v.scope === 'all' ? undefined : (s.branch ?? undefined))
  }
}

/** Track… (#1385): the remote and its branch (the same name by default); one not known there is pushed there first, said. */
function trackForm(project: ProjectInfo, info: GitRepoInfo, b: GitBranchRow): FormSpec {
  const remotes = info.remotes.map((r) => r.name)
  const initial = b.upstreamRemote && remotes.includes(b.upstreamRemote) ? b.upstreamRemote : remotes.includes('origin') ? 'origin' : (remotes[0] ?? '')
  const onRemote = b.upstream && b.upstreamRemote ? b.upstream.slice(b.upstreamRemote.length + 1) : b.name
  const known = (v: Record<string, string>): boolean => info.remoteBranches.includes(`${v.remote}/${v.branch.trim()}`)
  return {
    project,
    title: tr(M.trackTitle, { branch: b.name }),
    icon: 'link',
    about: tr(M.trackAbout, { branch: b.name, tracks: b.upstream ? 'yes' : 'no', upstream: b.upstream ?? '' }),
    fields: [
      { key: 'remote', label: tr(M.remote), initial, options: remotes.map((r) => ({ label: r, value: r })) },
      { key: 'branch', label: tr(M.remoteBranch), initial: onRemote, placeholder: b.name }
    ],
    confirm: tr(M.track),
    busyLabel: tr(M.saving),
    validate: (v) => (!v.branch.trim() ? tr(M.enterName) : /\s/.test(v.branch.trim()) ? tr(M.branchNoSpaces) : null),
    note: (v) => (known(v) ? null : tr(M.trackPushFirst, { remote: v.remote, branch: v.branch.trim(), local: b.name })),
    submit: (v) => call('git:setUpstream', project.path, b.name, v.remote, v.branch.trim(), !known(v))
  }
}

function identityForm(project: ProjectInfo, info: GitRepoInfo): FormSpec {
  return {
    project,
    title: tr(M.identityTitle),
    icon: 'person',
    about: tr(M.identityAbout, { project: project.name, hasGlobal: info.identity.global.email ? 'yes' : 'no', global: info.identity.global.email ?? '' }),
    fields: [
      { key: 'name', label: tr(M.name), initial: info.identity.local.name ?? '', placeholder: info.identity.global.name ?? tr(M.namePlaceholder) },
      // i18n-ignore: an example address in GitHub's own form
      { key: 'email', label: tr(M.email), initial: info.identity.local.email ?? '', placeholder: info.identity.global.email ?? 'id+you@users.noreply.github.com' }
    ],
    confirm: tr(M.save),
    busyLabel: tr(M.saving),
    validate: (v) => identityProblem(v.name, v.email),
    submit: (v) => call('git:setIdentity', project.path, v.name.trim(), v.email.trim())
  }
}

const CARDS = {
  open: msg({ id: 'git.branches.cardOpen', defaultMessage: '{card}: {stage}. Open the card', description: "Tooltip and accessible name of a card's key beside the branch it works on (Version Control → Branches & remotes): the card ({card}: its key, such as AL-12) and its stage ({stage}: the board's name for it, glossary 2.2); a click opens the card." }),
  underReview: msg({ id: 'git.branches.underReview', defaultMessage: 'under review: {revision}', description: "Beside a branch's card in Review (Version Control → Branches & remotes), lower case: the revision submitted for review ({revision}: a short commit id, a3f2c1d)." }),
  copy: msg({ id: 'git.branches.copyRevision', defaultMessage: 'Copy revision {revision}', description: "Tooltip of the button beside a branch's revision under review: copies the whole commit id. {revision} is its short form (a3f2c1d)." }),
  copied: msg({ id: 'git.branches.revisionCopied', defaultMessage: 'Copied', description: 'Shown for a moment after copying a revision beside a branch (Version Control → Branches & remotes).' }),
  merged: msg({ id: 'git.branches.merged', defaultMessage: '{has, select, yes {merged: {revision}} other {merged}}', description: "Beside a branch's card that is Done (Version Control → Branches & remotes), lower case: its work was merged, with the commit that merged it ({revision}: a short commit id) when it is known (has yes). Keep the select keys." }),
  earlier: msg({ id: 'git.branches.earlierCards', defaultMessage: '{n, plural, one {+# earlier card} other {+# earlier cards}}', description: "Beside a branch's card (Version Control → Branches & remotes): how many earlier cards worked on the same branch ({n}); its tooltip lists them." })
}

/**
 * A branch's cards (#1424): the card its line belongs to now (in flight first, else the latest), by key, a link that opens
 * it, with its stage in its category's colour (`names`: the project's, read once for the section), its revision under
 * review (with a copy button) or, Done, that it was merged and as what; and how many earlier cards worked on the same
 * branch. A worktree's: its agent's card, the same way.
 */
/**
 * A branch row's middle part (HI-1897) shows the whole of what it says in its tooltip, read as the pointer comes to it:
 * cut with "…" when the row is short of room, it can still be read.
 */
function fullTip(el: HTMLElement): void {
  const text = [...el.children].map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' · ')
  if (el.title !== text) el.title = text
}

export function BranchCards({ cards, project, names, inTarget }: { cards: BranchCard[]; project: ProjectInfo; names: Partial<Record<BranchCard['stage'], string>> | undefined; inTarget?: boolean }) {
  const tasks = useStore((st) => st.tasks)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  const c = cards[0]
  if (!c) return null
  const key = cardLabelOf({ tasks }, c.card)
  const stage = stageName(c.stage, names, tr)
  const short = (id: string): string => (project.platform ? revisionShort(project.platform.id, id) : id.slice(0, 7))
  const earlier = cards.slice(1)
  const review = c.underReview
  return (
    <span className="git-branch-card" data-branch-card={c.card} data-stage={c.stage}>
      <button type="button" className="link git-branch-card-key" aria-label={tr(CARDS.open, { card: key, stage })} title={tr(CARDS.open, { card: key, stage })} onClick={() => set({ taskOpen: c.card })}>
        {key}
      </button>
      <span className="git-branch-card-stage">
        <span className={cx('lane-seg', 'git-branch-card-swatch', stageLook(c.stage))} aria-hidden="true" />
        {stage}
      </span>
      {review && (
        <span className="git-branch-card-review faint" data-under-review={review}>
          {tr(CARDS.underReview, { revision: short(review) })}
          <button type="button" className="copy-code-btn" data-copy-revision={review} aria-label={tr(CARDS.copy, { revision: short(review) })} title={tr(CARDS.copy, { revision: short(review) })} onClick={() => void navigator.clipboard.writeText(review).then(() => setCopied(true), () => undefined)}>
            <Icon name={copied ? 'check' : 'copy'} />
          </button>
          {copied && (
            <span className="copy-code-done" role="status">
              {tr(CARDS.copied)}
            </span>
          )}
        </span>
      )}
      {/* Done, and merged unless its branch is known not to be in the target (a leftover with commits of its own, HI-1823). */}
      {c.stage === 'done' && inTarget !== false && (
        <span className="git-branch-card-merged faint" data-merged={c.merged ?? ''}>
          {tr(CARDS.merged, { has: c.merged ? 'yes' : 'no', revision: c.merged ? short(c.merged) : '' })}
        </span>
      )}
      {earlier.length > 0 && (
        <Tooltip content={fmt.list(earlier.map((x) => cardLabelOf({ tasks }, x.card)), 'unit')}>
          <span className="git-branch-card-earlier faint" data-earlier={earlier.length}>
            {tr(CARDS.earlier, { n: earlier.length })}
          </span>
        </Tooltip>
      )}
    </span>
  )
}

/**
 * Deletes one branch nothing uses (#1642), after a confirm: a merged one loses nothing; an unmerged one lists the commits
 * it drops (git's -D). Branches & remotes and the Changes tab's leftover branches (HI-1823) ask the same way; main checks
 * each deletion again (the branch's use now, at the commit shown).
 */
export async function deleteBranch(project: Pick<ProjectInfo, 'path'>, b: Pick<GitBranchRow, 'name' | 'sha' | 'toTarget'>, target: string): Promise<void> {
  if (!b.sha) return
  const one = { name: b.name, sha: b.sha }
  const remove = async (unmerged: boolean): Promise<void> => {
    try {
      notify('success', await call('git:deleteBranches', project.path, [one], unmerged))
    } finally {
      bumpGit(project.path)
    }
  }
  if (b.toTarget === 0) {
    await confirm({ title: tr(C.deleteMergedTitle, { branch: b.name }), message: tr(C.deleteMergedMessage, { target }), confirmLabel: tr(C.deleteButton), busyLabel: tr(C.deleting), danger: true, run: () => remove(false) })
    return
  }
  const drops = await attempt(tr(C.dropsFailed, { branch: b.name }), () => call('git:branchDrops', project.path, b.name))
  if (!drops) return
  const lines = drops.commits.map((c) => `${c.short} ${c.subject}`)
  if (drops.total > drops.commits.length) lines.push(tr(C.deleteMore, { n: drops.total - drops.commits.length }))
  await confirm({
    title: tr(C.deleteUnmergedTitle, { branch: b.name, n: drops.total }),
    message: tr(C.deleteUnmergedMessage, { branch: b.name, n: drops.total, target: drops.target }),
    list: lines,
    listOnly: true,
    listMono: true,
    confirmLabel: tr(C.deleteButton),
    busyLabel: tr(C.deleting),
    danger: true,
    run: () => remove(true)
  })
}
