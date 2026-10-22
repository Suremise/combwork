import { Children, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ProjectInfo } from '@shared/types'
import { fmt, msg, tr, tRich, type Msg } from '@shared/i18n'
import {
  GIT_SECTIONS,
  GIT_VIEW_GUIDE,
  aheadBehindText,
  folderBusy,
  gitStateKey,
  gitStateText,
  gitStatusText,
  gitStatusTip,
  headText,
  identityProblem,
  identityWarnings,
  parentRepoText,
  remoteNameProblem,
  remoteUrlProblem,
  type GitBranchRow,
  type GitFolderAction,
  type GitHistory,
  type GitRepoInfo,
  type GitRepoSummary,
  type GitSection
} from '@shared/gitRepo'
import { gitFixText, gitProblemText } from '@shared/gitTool'
import { samePath } from '@shared/movePaths'
import type { HiveRequests } from '@shared/api'
import { call, errorMessage } from '../api'
import { gitReader, type GitReadState } from '../gitReads'
import { attempt } from '../actions'
import { bumpGit, choose, confirm, notify, prompt, set, showGit, showView, UNUSED_ROOT, useStore } from '../store'
import { openGuideAt } from '../tips'
import { useNow } from '../usage'
import { cx, timeAgo } from '../util'
import { projectSlots, useMergeSlots } from '../components/MergeSlots'
import { BusyButton, Icon, IconButton, LoadFailed, Modal, StaleNote, Tooltip, useBusy } from '../components/ui'
import { INIT_TEXT, InitRepoButton, InitRepoHost } from '../components/InitRepo'
import { ChangesTab } from './ProjectTabs'
import { GitQueueSection } from '../components/GitQueueSection'

/** A message with markup, as React children (keyed, so a list of parts renders without warnings). */
const rich = (m: Msg, values: Parameters<typeof tRich<React.ReactNode>>[1]): React.ReactNode[] => Children.toArray(tRich<React.ReactNode>(m, values))
const faint = (c: React.ReactNode[]): React.ReactNode => <span className="faint">{c}</span>
/** The ahead/behind counts, with their hook for tests. */
const ab = (c: React.ReactNode[]): React.ReactNode => <span data-git-ab="">{c}</span>

const M = {
  tabs: msg({ id: 'git.tab.sections', defaultMessage: 'Git', description: "Accessible name of the Git tab's row of sections (Changes, History, Branches & remotes)." }),
  notRepo: msg({ id: 'git.setup.notRepo', defaultMessage: "{project} isn't a git repository", description: "Heading on the Git tab of a project that isn't a git repository. {project} is its name." }),
  withoutGit: msg({ id: 'git.setup.withoutGit', defaultMessage: 'Without git, agents work in the project folder, and Hive has no worktrees, merging or Git view for it.', description: "The Git tab of a project that isn't a git repository." }),
  howTo: msg({ id: 'git.setup.howTo', defaultMessage: 'To use them, make it a repository: Initialise makes it one on a branch called main, keeps its .hive out of git, and commits its files, so agents can work in worktrees at once. Then add a remote under Branches & remotes to push it.', description: "The Git tab of a project that isn't a git repository. Initialise and Branches & remotes are a button and a section: keep them as they are named there. Keep main (the branch name)." }),
  cantRead: msg({ id: 'git.problem.cantRead', defaultMessage: "{problem}, so Hive can't read this repository.", description: 'The Git tab when git cannot run. {problem} says why, such as "Git isn\'t installed (or isn\'t on Hive\'s PATH)".' }),
  learnMore: msg({ id: 'git.setup.learnMore', defaultMessage: 'Learn more', description: "Link on the Git tab of a project that isn't a git repository: opens the user guide's Git view section." }),
  agentSetup: msg({ id: 'git.problem.agentSetup', defaultMessage: 'Agent Setup', description: 'Button: opens Agent Setup, which checks git and says how to fix it.' }),
  retry: msg({ id: 'git.retry', defaultMessage: 'Retry', description: 'Button: reads git again.' }),
  reading: msg({ id: 'git.reading', defaultMessage: 'Reading git…', description: "A Git tab section while it reads git for the first time." }),
  historyLoad: msg({ id: 'git.history.loadTarget', defaultMessage: 'the history', description: 'What could not be read in Git → History: shown in "Could not load {what}: {error}" and "Could not refresh {what}; last updated …".' }),
  branchesLoad: msg({ id: 'git.branches.loadTarget', defaultMessage: 'the branches and remotes', description: 'What could not be read in Git → Branches & remotes: shown in "Could not load {what}: {error}" and "Could not refresh {what}; last updated …".' }),
  historyOf: msg({ id: 'git.history.headingOf', defaultMessage: 'History <faint>of {head}</faint>', description: 'Heading of Git → History. {head} is the branch checked out (or "detached at abc1234"). <faint> is the part shown dimmed.' }),
  historyHeading: msg({ id: 'git.history.heading', defaultMessage: 'History', description: 'Heading of Git → History, before the branch is known.' }),
  readHistoryAgain: msg({ id: 'git.history.reload', defaultMessage: 'Read the history again', description: 'Tooltip on the refresh button in Git → History.' }),
  noCommits: msg({ id: 'git.history.noCommits', defaultMessage: 'No commits yet.', description: 'Git → History when the repository has no commit.' }),
  tags: msg({ id: 'git.tags.heading', defaultMessage: 'Tags', description: 'Heading in Git → History, followed by how many tags there are.' }),
  createTag: msg({ id: 'git.tags.create', defaultMessage: 'Create tag…', description: 'Button in Git → History: opens the form that tags the commit checked out.' }),
  noTags: msg({ id: 'git.tags.none', defaultMessage: 'No tags. Create tag… tags the commit the project folder has checked out.', description: 'Git → History when there are no tags. Create tag… is the button of that name.' }),
  olderTags: msg({ id: 'git.tags.older', defaultMessage: 'and {count, number} older', description: 'Under the tags listed in Git → History: how many older tags are not listed.' }),
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
  enterName: msg({ id: 'git.form.enterName', defaultMessage: 'Enter a name', description: "Under a form's name box (a branch, a tag) while it is empty." }),
  branchNoSpaces: msg({ id: 'git.newBranch.noSpaces', defaultMessage: 'Branch names have no spaces', description: "Under the New branch form's box." }),
  switchNow: msg({ id: 'git.newBranch.switchNow', defaultMessage: 'Switch to it now', description: 'Check box in the New branch form.' }),
  createFailed: msg({ id: 'git.newBranch.failed', defaultMessage: "Couldn't create {branch}", description: 'Title of an error notification.' }),
  pushFailed: msg({ id: 'git.push.failed', defaultMessage: "Couldn't push {branch}", description: 'Title of an error notification.' }),
  pushTitle: msg({ id: 'git.push.title', defaultMessage: 'Push {branch}', description: 'Title of the dialog that pushes a branch that tracks no remote branch yet.' }),
  pushMessage: msg({ id: 'git.push.message', defaultMessage: '{branch} tracks no remote branch yet. Push it, and track it from now on:', description: 'The Push dialog, above the drop-down of remotes.' }),
  remote: msg({ id: 'git.push.remote', defaultMessage: 'Remote', description: "Label of the Push dialog's drop-down of remotes." }),
  cancel: msg({ id: 'git.cancel', defaultMessage: 'Cancel', description: "Button: closes the Git tab's dialog or form without doing anything." }),
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
  stateBanner: msg({ id: 'git.branches.stateBanner', defaultMessage: "Git is {state, select, merge {merging} rebase {rebasing} cherrypick {cherry-picking} revert {reverting} other {bisecting}} in the project folder. Finish or abort it in a terminal (or ask an agent to): Hive doesn't.", description: 'Banner in Git → Branches & remotes while git has an operation in progress.' }),
  fetchedAt: msg({ id: 'git.fetch.at', defaultMessage: 'As of the last fetch, {when}. Hive never fetches by itself.', description: 'In Git → Branches & remotes, beside Fetch. {when} is how long ago, such as "5m ago".' }),
  neverFetched: msg({ id: 'git.fetch.never', defaultMessage: 'Never fetched. Hive never fetches by itself.', description: 'In Git → Branches & remotes, beside Fetch.' }),
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
  switchTip: msg({ id: 'git.switch.tip', defaultMessage: 'Switch the project folder to {branch}', description: 'Tooltip on a branch\'s Switch button.' }),
  remoteBranches: msg({ id: 'git.branches.remote', defaultMessage: 'Remote branches ({count, number})', description: 'Button in Git → Branches & remotes that shows or hides the remote branches with no local one.' }),
  trackLocal: msg({ id: 'git.branches.trackLocal', defaultMessage: 'A local {branch} tracking {remote}, and switch to it', description: "Tooltip on a remote branch's Switch button. {branch} is the local branch it makes; {remote} the remote branch, such as origin/feature." }),
  remotes: msg({ id: 'git.remotes.heading', defaultMessage: 'Remotes', description: 'Heading in Git → Branches & remotes, followed by how many there are.' }),
  addRemote: msg({ id: 'git.remotes.add', defaultMessage: 'Add remote…', description: 'Button: opens the Add a remote form.' }),
  noRemotes: msg({ id: 'git.remotes.none', defaultMessage: "No remotes: this repository is only on this computer. Add one (a GitHub repository's URL, say) to push to it.", description: 'Git → Branches & remotes of a repository with no remote.' }),
  pushesTo: msg({ id: 'git.remotes.pushesTo', defaultMessage: '(pushes to {url})', description: "After a remote's URL, when it pushes to another URL." }),
  worktrees: msg({ id: 'git.worktrees.heading', defaultMessage: 'Worktrees', description: 'Heading in Git → Branches & remotes, followed by how many there are.' }),
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
  tagTitle: msg({ id: 'git.tags.title', defaultMessage: 'Tag {commit}', description: 'Title of the Create tag form. {commit} is the short hash of the commit checked out.' }),
  tagTheCommit: msg({ id: 'git.tags.titleNoCommit', defaultMessage: 'Tag the commit', description: 'Title of the Create tag form before the commit is known.' }),
  tagAbout: msg({ id: 'git.tags.about', defaultMessage: "{onBranch, select, yes {Tags the commit the project folder has checked out ({branch}). With a message, it's an annotated tag.} other {Tags the commit the project folder has checked out. With a message, it's an annotated tag.}}", description: 'The Create tag form. {branch} is the branch checked out ({onBranch} is no when HEAD is detached).' }),
  tagName: msg({ id: 'git.tags.name', defaultMessage: 'Name', description: "Field of the Create tag form: the new tag's name (v1.0.0, say)." }),
  message: msg({ id: 'git.tags.message',defaultMessage: 'Message', description: 'Field of the Create tag form.' }),
  optional: msg({ id: 'git.tags.optional', defaultMessage: 'Optional', description: "Placeholder in the Create tag form's message box." }),
  pushItTo: msg({ id: 'git.tags.pushTo', defaultMessage: 'Push it to', description: 'Field of the Create tag form: the remote to push the tag to.' }),
  dontPush: msg({ id: 'git.tags.dontPush', defaultMessage: "Don't push", description: 'The first choice of the Create tag form\'s Push it to drop-down.' }),
  createTagButton: msg({ id: 'git.tags.createButton', defaultMessage: 'Create tag', description: "The Create tag form's button." }),
  tagging: msg({ id: 'git.tags.busy', defaultMessage: 'Tagging…', description: "The Create tag form's button while it runs." }),
  tagNoSpaces: msg({ id: 'git.tags.noSpaces', defaultMessage: 'Tag names have no spaces', description: "Under the Create tag form's name box." }),
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
  removeRemoteMessage: msg({ id: 'git.remote.removeMessage', defaultMessage: '{n, plural, =0 {Hive forgets {remote} and its remote branches here. No branch tracks it.} one {Hive forgets {remote} and its remote branches here, and this branch stops tracking it:} other {Hive forgets {remote} and its remote branches here, and these # branches stop tracking it:}}', description: 'The confirmation before removing the remote {remote}; the branches that track it ({n}) follow, one per line.' }),
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
  untrack: msg({ id: 'git.untrack.button', defaultMessage: 'Stop tracking', description: 'The button of the confirmation before a branch stops tracking its remote branch.' }),
  statusBarTip: msg({ id: 'git.statusBar.tip', defaultMessage: 'Git branch of the selected project', description: "Tooltip on the status bar's git item before git has been read." })
}

/**
 * The project's Git tab (#607): Changes (whose changes, as the Changes tab had them), History (the project folder's
 * last commits and its tags) and Branches & remotes (its branch or detached HEAD, upstream and ahead/behind as of the
 * last fetch, branches, remotes, other worktrees read-only, and the commit identity). Every change here is the user's
 * own (never an agent tool), in the project folder only: switching branch or pulling is refused while an agent works
 * there or holds its merge slot.
 */

const at = (ms: number | null): string | null => (ms ? timeAgo(new Date(ms).toISOString()) : null)

/**
 * Reads a Git channel for the project: again when the project's git changes here, its agents work, the window gets
 * focus, or on `reload`; the last answer stays while it does.
 */
function useGitRead<C extends 'git:summary' | 'git:info' | 'git:history'>(channel: C, project: ProjectInfo): { data: Awaited<ReturnType<HiveRequests[C]>> | null; error: string | null; loading: boolean; at: number; reload: () => void } {
  type T = Awaited<ReturnType<HiveRequests[C]>>
  const version = useStore((s) => s.gitVersion[project.path] ?? 0)
  const usage = useStore((s) => s.usageVersion[project.path] ?? 0)
  const [state, setState] = useState<GitReadState<T>>({ for: project.path, data: null, error: null, loading: true, at: 0 })
  // One read at a time, those asked meanwhile one more after it (#1366, gitReads.ts).
  const reader = useMemo(() => gitReader<T>((path) => (call as (c: C, p: string) => Promise<T>)(channel, path), setState, errorMessage), [channel])
  const reload = useCallback(() => reader(project.path), [reader, project.path])
  useEffect(reload, [reload, version, usage, project.branch])
  // What the user did in a terminal meanwhile (a commit, git init) shows on coming back to the window.
  useEffect(() => {
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [reload])
  // Another project's answer never shows for this one.
  const mine = state.for === project.path
  return { data: mine ? state.data : null, error: mine ? state.error : null, loading: !mine || state.loading, at: mine ? state.at : 0, reload }
}

/** Why an action that moves the project folder is refused now (an agent works there, or its merge slot is held), or null. */
function useFolderBusy(project: ProjectInfo): (action: GitFolderAction) => string | null {
  const slots = projectSlots(useMergeSlots(), project.path)
  const agents = project.agents.filter((a) => !a.worktree).map((a) => ({ name: a.name, status: a.live?.status ?? null }))
  const folder = slots.map((s) => ({ branch: s.branch, holder: s.holder && s.holder.kind !== 'user' ? s.holder.name : null, ...(s.holder?.kind === 'user' ? { byUser: true } : {}), waiting: s.waiting.map((w) => w.name) }))
  return (action) => folderBusy(agents, folder, action)
}

/** Runs a Git action from the window: its reply as a notice, its failure as an error, and the view read again either way. */
async function gitAction(project: ProjectInfo, title: string, fn: () => Promise<string>): Promise<boolean> {
  const done = await attempt(title, fn)
  bumpGit(project.path)
  if (done === undefined) return false
  notify('success', done)
  return true
}

export function GitTab({ project }: { project: ProjectInfo }) {
  const section: GitSection = useStore((s) => s.gitSection[project.path]) ?? 'changes'
  const summary = useGitRead('git:summary', project)
  const s = summary.data
  return (
    <div className="git-view">
      <div className="git-head">
        <div className="segmented git-sections" role="tablist" aria-label={tr(M.tabs)}>
          {GIT_SECTIONS.map((x) => (
            <button key={x.id} role="tab" data-section={x.id} aria-selected={section === x.id} className={cx(section === x.id && 'active')} onClick={() => showGit(project.path, x.id)}>
              <Icon name={x.icon} /> {tr(x.label)}
            </button>
          ))}
        </div>
        {s?.isRepo && (
          <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{gitStatusTip(s, at(s.fetchedAt))}</span>}>
            <span className="git-head-status faint">
              <Icon name="git-branch" /> {gitStatusText(s)}
            </span>
          </Tooltip>
        )}
      </div>
      <div className="git-body">
        {s && !s.isRepo && !s.gitProblem ? (
          <GitSetupNotes project={project} />
        ) : section === 'changes' ? (
          <ChangesTab project={project} />
        ) : s?.gitProblem ? (
          <GitProblem problem={s.gitProblem} retry={summary.reload} />
        ) : section === 'history' ? (
          <HistorySection project={project} summary={s} />
        ) : section === 'queue' ? (
          <GitQueueSection project={project} />
        ) : (
          <BranchesSection project={project} />
        )}
      </div>
      <InitRepoHost project={project} />
    </div>
  )
}

/** A project without git (#607): it says so, what that means, and how to start. */
function GitSetupNotes({ project }: { project: ProjectInfo }) {
  return (
    <div className="scroll-page">
      <div className="page-narrow git-setup" data-git-setup="">
        <h2 className="section">
          <Icon name="source-control" /> {tr(M.notRepo, { project: project.name })}
        </h2>
        <p>{tr(M.withoutGit)}</p>
        <p className="hint">{tr(M.howTo)}</p>
        <p>
          <InitRepoButton project={project} />
        </p>
        <p className="hint">
          <a onClick={() => openGuideAt(GIT_VIEW_GUIDE)}>{tr(M.learnMore)}</a>
        </p>
      </div>
    </div>
  )
}

function GitProblem({ problem, retry }: { problem: string; retry: () => void }) {
  const tool = useStore((s) => s.gitTool)
  return (
    <div className="empty-state changes-git-missing" style={{ paddingTop: '15vh' }}>
      <Icon name="warning" />
      {/* Main's text is English (agents read it too): the window's own, in its language, while it knows git's state. */}
      {tr(M.cantRead, { problem: gitProblemText(tool) ?? problem })}
      <p className="hint">{gitFixText(tool)}</p>
      <div className="flex" style={{ justifyContent: 'center' }}>
        <button className="btn small" onClick={() => set({ setupOpen: true })}>
          <Icon name="hubot" /> {tr(M.agentSetup)}
        </button>
        <button className="btn small" onClick={retry}>
          <Icon name="refresh" /> {tr(M.retry)}
        </button>
      </div>
    </div>
  )
}

/** A section's first load: its spinner, or why it failed. */
function Loading<T>({ read, what, children }: { read: { data: T | null; error: string | null; loading: boolean; at: number; reload: () => void }; what: string; children: (data: T) => React.ReactNode }) {
  if (!read.data) {
    return (
      <div className="scroll-page">
        <div className="page-narrow">{read.error && !read.loading ? <LoadFailed inline what={what} error={read.error} onRetry={read.reload} /> : <p className="hint"><Icon name="loading" spin /> {tr(M.reading)}</p>}</div>
      </div>
    )
  }
  return (
    <div className="scroll-page">
      <div className="page-narrow">
        {read.error && <StaleNote what={what} error={read.error} at={read.at} onRetry={read.reload} />}
        {children(read.data)}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function HistorySection({ project, summary }: { project: ProjectInfo; summary: GitRepoSummary | null }) {
  const read = useGitRead('git:history', project)
  const [form, setForm] = useState<OpenForm | null>(null)
  useNow(60000)
  return (
    <Loading read={read} what={tr(M.historyLoad)}>
      {(h: GitHistory) => (
        <div className="git-history" data-git-history="">
          <h2 className="section git-section-head">
            {summary ? rich(M.historyOf, { head: headText(summary), faint }) : tr(M.historyHeading)}
            <span className="git-section-actions">
              <IconButton icon={read.loading ? 'loading' : 'refresh'} spin={read.loading} title={tr(M.readHistoryAgain)} action="reload-history" onClick={read.reload} />
            </span>
          </h2>
          {h.commits.length === 0 ? (
            <p className="hint">{tr(M.noCommits)}</p>
          ) : (
            <div className="git-rows">
              {h.commits.map((c) => (
                <Tooltip block key={c.hash} content={<span style={{ whiteSpace: 'pre-line' }}>{`${c.hash}\n${c.author} <${c.email}>\n${fmt.dateTime(c.date)}`}</span>}>
                  <div className="git-row git-commit" data-commit={c.short}>
                    <code className="git-hash">{c.short}</code>
                    <span className="git-subject">{c.subject}</span>
                    {c.refs.map((r) => (
                      <span key={r} className={cx('badge', 'git-ref', r.startsWith('tag: ') && 'git-tag', r.startsWith('HEAD') && 'git-headref')}>
                        {r.replace(/^tag: /, '')}
                      </span>
                    ))}
                    <span className="git-meta faint">
                      {c.author} · {at(c.date)}
                    </span>
                  </div>
                </Tooltip>
              ))}
            </div>
          )}
          <h2 className="section git-section-head">
            {tr(M.tags)} <span className="badge">{h.tags.length + h.moreTags}</span>
            <span className="git-section-actions">
              <button className="btn small" data-action="create-tag" disabled={!summary?.head || !!summary.parentRepo} onClick={() => setForm({ make: () => tagForm(project, summary) })}>
                <Icon name="tag" /> {tr(M.createTag)}
              </button>
            </span>
          </h2>
          {h.tags.length === 0 ? (
            <p className="hint">{tr(M.noTags)}</p>
          ) : (
            <div className="git-rows">
              {h.tags.map((t) => (
                <div key={t.name} className="git-row git-tag-row" data-tag={t.name}>
                  <Icon name="tag" />
                  <span className="git-name">{t.name}</span>
                  <code className="git-hash">{t.commit}</code>
                  <span className="git-subject faint">{t.subject}</span>
                  <span className="git-meta faint">{at(t.date)}</span>
                </div>
              ))}
              {h.moreTags > 0 && <p className="hint">{tr(M.olderTags, { count: h.moreTags })}</p>}
            </div>
          )}
          {form && <GitForm make={form.make} onClose={() => setForm(null)} />}
        </div>
      )}
    </Loading>
  )
}

// ---------------------------------------------------------------------------
// Branches & remotes
// ---------------------------------------------------------------------------

function BranchesSection({ project }: { project: ProjectInfo }) {
  const read = useGitRead('git:info', project)
  const busyFor = useFolderBusy(project)
  const { busy, run } = useBusy()
  const [form, setForm] = useState<OpenForm | null>(null)
  const [showRemote, setShowRemote] = useState(false)
  // The info as last read: an open form (Track…'s note) reads it, not what was read when it opened (#1385).
  const latest = useRef<GitRepoInfo | null>(null)
  useNow(60000)

  const act = (name: string, title: string, fn: () => Promise<string>): void => void run(name, () => gitAction(project, title, fn))

  /** A branch, after a confirm that names the agents whose session runs in the folder (idle now: they find it on their next turn). */
  const switchTo = async (target: string, current: string | null): Promise<void> => {
    const idle = project.agents.filter((a) => !a.worktree && a.live).map((a) => a.name)
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
        const remoteOnly = info.remoteBranches.filter((r) => !info.branches.some((b) => b.name === r.slice(r.indexOf('/') + 1)))
        const warnings = identityWarnings(info.identity, info.remotes)
        const agentOf = (path: string | null) => (path ? project.agents.find((a) => a.worktree && samePath(a.worktree.path, path)) : undefined)
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

            <h2 className="section">
              {tr(M.branches)} <span className="badge">{info.branches.length}</span>
            </h2>
            <div className="git-rows">
              {info.branches.map((b) => {
                const agent = agentOf(b.worktree)
                const why = b.current ? null : b.worktree ? tr(M.checkedOutIn, { where: agent ? 'agent' : 'other', agent: agent?.name ?? '' }) : switchBlocked
                return (
                  <div key={b.name} className={cx('git-row', 'git-branch', b.current && 'current')} data-branch={b.name}>
                    <Icon name={b.current ? 'check' : b.worktree ? 'repo' : 'git-branch'} />
                    <span className="git-name">{b.name}</span>
                    {b.worktree && <span className="badge" data-worktree="">{agent ? tr(M.agentWorktree, { agent: agent.name }) : tr(M.worktreeBadge)}</span>}
                    {b.upstream && (
                      <span className="faint git-track">
                        {b.upstream} · {aheadBehindText(b)}
                      </span>
                    )}
                    <span className="git-subject faint">{b.subject}</span>
                    <span className="git-meta faint">{at(b.date)}</span>
                    {info.remotes.length > 0 && (
                      <span className="git-row-actions">
                        <IconButton icon={busy === `track:${b.name}` ? 'loading' : 'link'} spin={busy === `track:${b.name}`} title={tr(M.trackTip, { branch: b.name })} action="track" disabled={off} onClick={() => setForm({ make: () => trackForm(project, latest.current ?? info, b) })} />
                        {b.upstream && <IconButton icon="debug-disconnect" title={tr(M.untrackTip, { upstream: b.upstream })} action="untrack" disabled={off} onClick={() => void untrack(b.name, b.upstream!)} />}
                      </span>
                    )}
                    {!b.current && (
                      <Tooltip content={why ?? tr(M.switchTip, { branch: b.name })}>
                        <span>
                          <button className="btn small subtle" disabled={!!why || off} onClick={() => void switchTo(b.name, s.branch)}>
                            {busy === `switch:${b.name}` ? <Icon name="loading" spin /> : tr(M.switch)}
                          </button>
                        </span>
                      </Tooltip>
                    )}
                  </div>
                )
              })}
              {remoteOnly.length > 0 && (
                <button className="btn small subtle git-more" onClick={() => setShowRemote(!showRemote)}>
                  <Icon name={showRemote ? 'chevron-down' : 'chevron-right'} /> {tr(M.remoteBranches, { count: remoteOnly.length })}
                </button>
              )}
              {showRemote &&
                remoteOnly.map((r) => (
                  <div key={r} className="git-row git-branch remote" data-remote-branch={r}>
                    <Icon name="cloud" />
                    <span className="git-name">{r}</span>
                    <Tooltip content={switchBlocked ?? tr(M.trackLocal, { branch: r.slice(r.indexOf('/') + 1), remote: r })}>
                      <span>
                        <button className="btn small subtle" disabled={!!switchBlocked || off} onClick={() => void switchTo(r, s.branch)}>
                          {tr(M.switch)}
                        </button>
                      </span>
                    </Tooltip>
                  </div>
                ))}
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

            {info.worktrees.length > 0 && (
              <>
                <h2 className="section">
                  {tr(M.worktrees)} <span className="badge">{info.worktrees.length}</span>
                </h2>
                <p className="hint">{tr(M.readOnly)}</p>
                <div className="git-rows">
                  {info.worktrees.map((w) => {
                    const agent = agentOf(w.path)
                    return (
                      <div key={w.path} className="git-row git-worktree" data-worktree-row={w.path}>
                        <Icon name="repo" />
                        <span className="git-name">{agent ? tr(M.agentWorktree, { agent: agent.name }) : tr(M.unusedWorktree)}</span>
                        <span className="faint">{w.branch ?? (w.head ? headText({ branch: null, head: w.head }) : '')}</span>
                        <span className="git-url faint">{w.path}</span>
                        <button
                          className="btn small subtle"
                          onClick={() => {
                            set((st) => ({ changesRoot: { ...st.changesRoot, [project.path]: agent?.id ?? UNUSED_ROOT } }))
                            showGit(project.path, 'changes')
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

// ---------------------------------------------------------------------------
// Forms: Add remote, Create tag, commit identity
// ---------------------------------------------------------------------------

interface FormField {
  key: string
  label: string
  initial?: string
  placeholder?: string
  /** A drop-down instead of a text box. */
  options?: { label: string; value: string }[]
}

interface FormSpec {
  title: string
  icon: string
  about?: string
  fields: FormField[]
  confirm: string
  busyLabel: string
  validate: (v: Record<string, string>) => string | null
  /** What to know about the values as they are (Track…'s push first, #1385), under the fields; null for nothing. */
  note?: (v: Record<string, string>) => string | null
  submit: (v: Record<string, string>) => Promise<string>
  project: ProjectInfo
}

/**
 * An open form: how to make its spec, not the spec itself. Its text is formatted each time it renders, so an open form
 * follows a change of language (what was typed stays: it is the form's state).
 */
interface OpenForm {
  make: () => FormSpec
}

function GitForm({ make, onClose }: { make: () => FormSpec; onClose: () => void }) {
  const spec = make()
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(spec.fields.map((f) => [f.key, f.initial ?? ''])))
  const { busy, error, run } = useBusy()
  const problem = spec.validate(values)
  const submit = async (): Promise<void> => {
    if (problem) return
    const r = await run('submit', () => spec.submit(values))
    bumpGit(spec.project.path)
    if (!r) return
    // A reply of several lines (Push to…'s outcomes) is a notice with its first line as the title.
    const [head, ...rest] = r.value.split('\n')
    notify('success', head, rest.length ? rest.join('\n') : undefined)
    onClose()
  }
  return (
    <Modal
      title={spec.title}
      icon={spec.icon}
      onClose={onClose}
      busy={!!busy}
      error={error}
      footer={
        <>
          <button className="btn subtle" onClick={onClose}>
            {tr(M.cancel)}
          </button>
          <BusyButton className="primary" busy={!!busy} busyLabel={spec.busyLabel} disabled={!!problem} onClick={() => void submit()}>
            {spec.confirm}
          </BusyButton>
        </>
      }
    >
      {spec.about && <p className="hint">{gitCommandsWhole(spec.about)}</p>}
      <div className="agent-form git-form">
        {spec.fields.map((f, i) => (
          <FormRow key={f.key} field={f} value={values[f.key]} first={i === 0} onChange={(v) => setValues((x) => ({ ...x, [f.key]: v }))} onEnter={() => void submit()} />
        ))}
      </div>
      {problem && Object.values(values).some((v) => v.trim()) && <div className="field-error">{problem}</div>}
      {!problem && spec.note?.(values) && <p className="hint git-form-note">{spec.note(values)}</p>}
    </Modal>
  )
}

/** A form's hint with each git command in it ("git config --local") kept on one line, never split after a dash (#890). */
function gitCommandsWhole(text: string): ReactNode {
  return text.split(/(\bgit(?: --?[\w-]+| [a-z][\w-]*)+)/).map((part, i) =>
    i % 2 ? (
      <span key={i} className="git-command">
        {part}
      </span>
    ) : (
      part
    )
  )
}

function FormRow({ field, value, first, onChange, onEnter }: { field: FormField; value: string; first: boolean; onChange: (v: string) => void; onEnter: () => void }) {
  return (
    <>
      <label htmlFor={`git-form-${field.key}`}>{field.label}</label>
      {field.options ? (
        <select id={`git-form-${field.key}`} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input id={`git-form-${field.key}`} className="input" value={value} placeholder={field.placeholder} autoFocus={first} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onEnter()} />
      )}
    </>
  )
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

function tagForm(project: ProjectInfo, s: GitRepoSummary | null): FormSpec {
  const remotes = s?.remotes ?? []
  return {
    project,
    title: s?.head ? tr(M.tagTitle, { commit: s.head }) : tr(M.tagTheCommit),
    icon: 'tag',
    about: tr(M.tagAbout, { onBranch: s?.branch ? 'yes' : 'no', branch: s?.branch ?? '' }),
    fields: [
      // i18n-ignore: an example version
      { key: 'name', label: tr(M.tagName), placeholder: 'v1.0.0' },
      { key: 'message', label: tr(M.message), placeholder: tr(M.optional) },
      ...(remotes.length ? [{ key: 'push', label: tr(M.pushItTo), initial: '', options: [{ label: tr(M.dontPush), value: '' }, ...remotes.map((r) => ({ label: r, value: r }))] }] : [])
    ],
    confirm: tr(M.createTagButton),
    busyLabel: tr(M.tagging),
    validate: (v) => (!v.name.trim() ? tr(M.enterName) : /\s/.test(v.name.trim()) ? tr(M.tagNoSpaces) : null),
    submit: (v) => call('git:createTag', project.path, v.name.trim(), v.message ?? '', v.push || undefined)
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

// ---------------------------------------------------------------------------
// The status bar
// ---------------------------------------------------------------------------

/**
 * The selected project's git in the status bar (#607): "main · origin · ↑2 ↓0", as of the last fetch. Read again when
 * its branch or agents change, after a Git action, when the window gets focus, and every minute; it opens Git →
 * Branches & remotes.
 */
export function GitStatusBarItem({ project }: { project: ProjectInfo }) {
  const read = useGitRead('git:summary', project)
  const reload = read.reload
  useNow(60000)
  useEffect(() => {
    const t = setInterval(reload, 60_000)
    return () => clearInterval(t)
  }, [reload])
  const s = read.data
  if (s && !s.isRepo) return null
  const text = s ? gitStatusText(s) : project.branch
  if (!text) return null
  return (
    <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{s ? gitStatusTip(s, at(s.fetchedAt)) : tr(M.statusBarTip)}</span>}>
      <div className={cx('status-item', s?.state && 'caution')} data-git-status="" onClick={() => {
          showView('projects')
          showGit(project.path, 'branches')
        }}>
        <Icon name="git-branch" /> {text}
      </div>
    </Tooltip>
  )
}
