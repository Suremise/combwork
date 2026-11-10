// The workflow options' words (SPEC §16.6.1, §16.6.2; glossary 2.6, agreed 20 Oct): each option's label and what it
// does, and its values, for the Version Control tab's Workflow section (#1418: its groups, and each preset's why) and the
// settings catalog's rows the Assistant sets them by. Kept as messages, shown with tr() where they are rendered.

import { msg, type Msg } from '../i18n/msg'
import { accepts, type PlatformId } from '../platform/descriptors'
import type { FormGroupId, OptionKey, PresetId } from './options'

interface OptionText {
  title: Msg
  desc: Msg
  /** None's own label, where it differs (N1, N6). */
  none?: Msg
  /** Git's label with everyone in the project folder, where it differs (G1: the work is on the target meanwhile). */
  shared?: Msg
}

/** Each option the form shows: its label (Git's; None's where it differs) and what it does. */
export const OPTION_TEXT: Partial<Record<OptionKey, OptionText>> = {
  review: {
    title: msg({ id: 'workflow.option.review.title', defaultMessage: 'Work is reviewed before it’s merged', description: 'A workflow option (glossary 2.6, G1): who reviews a card’s work before it is merged.' }),
    shared: msg({ id: 'workflow.option.review.shared', defaultMessage: 'Work is reviewed before it’s done', description: 'The workflow option G1 when everyone works in the project folder, where the work is on the target meanwhile (glossary 2.6, G1 shared folder).' }),
    none: msg({ id: 'workflow.option.review.none', defaultMessage: 'Who checks the work before it’s done', description: 'A workflow option for a project without version control (glossary 2.6, N1).' }),
    desc: msg({ id: 'workflow.option.review.desc', defaultMessage: 'A card goes to Review when its builder submits it and moves on only once it passes, waiting for your OK after the reviewer when you check too.', description: 'What the workflow option “Work is reviewed before it’s merged” does.' })
  },
  reviewers: {
    title: msg({ id: 'workflow.option.reviewers.title', defaultMessage: 'Reviewers per card', description: 'A workflow option (glossary 2.6, G1b): how many reviewer agents must pass a card.' }),
    desc: msg({ id: 'workflow.option.reviewers.desc', defaultMessage: 'With two, both must pass the same change.', description: 'What the workflow option “Reviewers per card” does.' })
  },
  noSelfReview: {
    title: msg({ id: 'workflow.option.noSelfReview.title', defaultMessage: 'Nobody reviews their own work', description: 'A workflow option (glossary 2.6, G2 and N2).' }),
    desc: msg({ id: 'workflow.option.noSelfReview.desc', defaultMessage: 'Always on while a reviewer agent checks the work.', description: 'What the workflow option “Nobody reviews their own work” does.' })
  },
  preChecks: {
    title: msg({ id: 'workflow.option.preChecks.title', defaultMessage: 'Checks pass before review', description: 'A workflow option (glossary 2.6, G3 and N3): named commands that must pass before a card goes to review.' }),
    desc: msg({ id: 'workflow.option.preChecks.desc', defaultMessage: 'A card goes to review only once each of these named commands has passed on its work.', description: 'What the workflow option “Checks pass before review” does.' })
  },
  sameness: {
    title: msg({ id: 'workflow.option.sameness.title', defaultMessage: 'A pass survives a clean rebase', description: 'A workflow option (glossary 2.6, G4).' }),
    desc: msg({ id: 'workflow.option.sameness.desc', defaultMessage: 'With Same change, a pass carries over to a clean rebase or squash of the same change; with Exact revision only, any new revision makes it stale.', description: 'What the workflow option “A pass survives a clean rebase” does.' })
  },
  finish: {
    title: msg({ id: 'workflow.option.finish.title', defaultMessage: 'Who merges', description: 'A workflow option (glossary 2.6, G5).' }),
    desc: msg({ id: 'workflow.option.finish.desc', defaultMessage: 'When a card is done: once Combwork’s merge queue has merged it, once its agent has merged it and Combwork finds the work in the target branch, once it is committed, or whenever it is moved there.', description: 'What the workflow option “Who merges” does (glossary 2.1: merge queue).' })
  },
  style: {
    title: msg({ id: 'workflow.option.style.title', defaultMessage: 'Merge style', description: 'A workflow option (glossary 2.6, G6).' }),
    desc: msg({ id: 'workflow.option.style.desc', defaultMessage: 'How a card’s work is merged into the target branch.', description: 'What the workflow option “Merge style” does.' })
  },
  target: {
    title: msg({ id: 'workflow.option.target.title', defaultMessage: 'Work merges into', description: 'A workflow option (glossary 2.6, G7): the target branch.' }),
    desc: msg({ id: 'workflow.option.target.desc', defaultMessage: 'The branch a card’s work is merged into: the repository’s default branch when left empty.', description: 'What the workflow option “Work merges into” does.' })
  },
  otherTargets: {
    title: msg({ id: 'workflow.option.otherTargets.title', defaultMessage: 'Other branches work can merge into', description: 'A workflow option (HI-2556, G7b): branches besides “Work merges into” that a lane or a card can be set to merge into (its “Merges into”). Darren’s name for it.' }),
    desc: msg({ id: 'workflow.option.otherTargets.desc', defaultMessage: 'Branches a lane or a card can merge into instead (its Merges into), each through its own merge queue with the same merge checks, separated by commas.', description: 'What the workflow option “Other branches work can merge into” does (HI-2556). Merges into is the lane’s and card’s field: as translated there.' })
  },
  mergeChecks: {
    title: msg({ id: 'workflow.option.mergeChecks.title', defaultMessage: 'Checks pass on the merged result', description: 'A workflow option (glossary 2.6, G9): named commands Combwork’s merge queue runs on a card’s work merged with the target branch.' }),
    desc: msg({ id: 'workflow.option.mergeChecks.desc', defaultMessage: 'Combwork’s merge queue runs these named commands on the card’s work merged with the target branch, and moves the target only once each one has passed.', description: 'What the workflow option “Checks pass on the merged result” does (glossary 2.1: merge queue).' })
  },
  focusedTests: {
    title: msg({ id: 'workflow.option.focusedTests.title', defaultMessage: 'Each card’s focused tests pass on the merged result', description: 'A workflow option (glossary 2.6, G20): the tests a card’s change needs are chosen when it is submitted, and Combwork’s merge queue runs them on its work merged with the target branch.' }),
    desc: msg({ id: 'workflow.option.focusedTests.desc', defaultMessage: 'When a card is submitted, the project’s command chooses the tests its change needs (or its builder names them, for its reviewer to check), and the merge queue runs them on the merged result, moving the target only once they pass.', description: 'What the workflow option “Each card’s focused tests pass on the merged result” does (glossary 2.1: merge queue).' })
  },
  strict: {
    title: msg({ id: 'workflow.option.strict.title', defaultMessage: 'Work is up to date with its target branch before it merges', description: 'A workflow option (glossary 2.6, G8, strict): a card’s work must contain the target branch’s latest commit before it is merged; Combwork’s merge queue brings it up to date itself.' }),
    desc: msg({ id: 'workflow.option.strict.desc', defaultMessage: 'When the target branch has moved on since the review, the merge queue brings the work up to date in its own folder first, and returns the card if that conflicts or makes a different change.', description: 'What the workflow option “Work is up to date with its target branch before it merges” does (glossary 2.1: merge queue; Squash is the merge style’s value).' })
  },
  pushTarget: {
    title: msg({ id: 'workflow.option.pushTarget.title', defaultMessage: 'Push the target branch after merging', description: 'A workflow option (glossary 2.6, G18): after Combwork’s merge queue merges a card, it pushes the target branch to its remote.' }),
    desc: msg({ id: 'workflow.option.pushTarget.desc', defaultMessage: 'After each merge, the merge queue pushes the target branch to the remote it tracks (or the only remote, or origin), never forced, and pauses, saying why, when the push is refused or fails.', description: 'What the workflow option “Push the target branch after merging” does (glossary 2.1: merge queue). Origin is git’s usual name for a remote: keep it.' })
  },
  followRemote: {
    title: msg({ id: 'workflow.option.followRemote.title', defaultMessage: 'The target branch follows its remote', description: 'A workflow option (glossary 2.6, G21): the target branch is the one it tracks on its remote; Combwork’s merge queue fetches it before each test merge and publishes each merge there first.' }),
    desc: msg({ id: 'workflow.option.followRemote.desc', defaultMessage: 'Before each test merge, the merge queue fetches the remote branch the target tracks and tests on its latest commit, pushes each merge there only if nobody pushed meanwhile (testing again if they did), and then brings the local target up to date.', description: 'What the workflow option “The target branch follows its remote” does (glossary 2.1: merge queue; 2.5: test merge). “Push the target branch after merging” is another option’s name.' })
  },
  commitMessage: {
    title: msg({ id: 'workflow.option.commitMessage.title', defaultMessage: 'Commit message', description: 'A workflow option (glossary 2.6, G19): the message of the commit Combwork’s merge queue makes when it merges a card (a merge commit, or a squash’s one commit).' }),
    desc: msg({ id: 'workflow.option.commitMessage.desc', defaultMessage: 'The message of the commit the merge queue makes: Combwork’s names the card’s key and title and adds Combwork’s trailers, and the branch’s own uses the message its commits have, with no card key or trailers, while Combwork still knows which card it merged.', description: 'What the workflow option “Commit message” does (glossary 2.1: merge queue). Trailers are git’s name for the “Key: value” lines at the end of a commit message: keep the word if your language’s git terms do.' })
  },
  mergeInstall: {
    title: msg({ id: 'workflow.option.mergeInstall.title', defaultMessage: 'Install dependencies from scratch', description: 'A workflow option (G9’s install): when the merge queue installs the project’s dependencies afresh before the merge checks.' }),
    desc: msg({ id: 'workflow.option.mergeInstall.desc', defaultMessage: 'Before the checks on the merged result, the merge queue installs the dependencies afresh, and always does when the lock file or manifests changed.', description: 'What the workflow option “Install dependencies from scratch” does. Lock file: as in the glossary (G15 value).' })
  },
  okBefore: {
    title: msg({ id: 'workflow.option.okBefore.title', defaultMessage: 'Your OK before merging', description: 'A workflow option (glossary 2.6, G10).' }),
    desc: msg({ id: 'workflow.option.okBefore.desc', defaultMessage: 'A card waits for your OK before it is merged: never, only cards with these labels, or every card.', description: 'What the workflow option “Your OK before merging” does.' })
  },
  folder: {
    title: msg({ id: 'workflow.option.folder.title', defaultMessage: 'Where cards are built', description: 'A workflow option (glossary 2.6, G11).' }),
    desc: msg({ id: 'workflow.option.folder.desc', defaultMessage: 'In its own folder, a slot Combwork lends to the card or its lane, each card is built on a branch of its own, apart from other agents’ work; in the project folder, everyone sees each other’s unfinished changes.', description: 'What the workflow option “Where cards are built” does (glossary 2.5: slot, a worktree Combwork lends to a card or a lane).' })
  },
  slotsUpToDate: {
    title: msg({ id: 'workflow.option.slotsUpToDate.title', defaultMessage: 'Slots are brought up to date before each card', description: 'A workflow option (glossary 2.6, G15; glossary 2.5: slot): before a card starts in a slot, the slot is brought to the target branch’s latest work.' }),
    desc: msg({ id: 'workflow.option.slotsUpToDate.desc', defaultMessage: 'Before a card starts in a slot, the slot is brought to the latest work of the target branch, and its dependencies are installed again when the lock file changed.', description: 'What the workflow option “Slots are brought up to date before each card” does (glossary 2.5: slot; lock file, as in the G15 value).' })
  },
  identity: {
    title: msg({ id: 'workflow.option.identity.title', defaultMessage: 'Commits use the project’s identity', description: 'A workflow option (glossary 2.6, G12).' }),
    desc: msg({ id: 'workflow.option.identity.desc', defaultMessage: 'Commits are made with the name and email from the project’s git config (else your global one).', description: 'What the workflow option “Commits use the project’s identity” does.' })
  },
  stopOwnRuns: {
    title: msg({ id: 'workflow.option.stopOwnRuns.title', defaultMessage: 'Agents stop what they started before review', description: 'A workflow option (glossary 2.6, G13).' }),
    desc: msg({ id: 'workflow.option.stopOwnRuns.desc', defaultMessage: 'A card goes to review only once its builder’s own runs and background commands have stopped.', description: 'What the workflow option “Agents stop what they started before review” does.' })
  },
  dependenciesDone: {
    title: msg({ id: 'workflow.option.dependenciesDone.title', defaultMessage: 'Cards start only when the cards they wait for are merged', description: 'A workflow option (glossary 2.6, G14).' }),
    none: msg({ id: 'workflow.option.dependenciesDone.none', defaultMessage: 'Cards start only when the cards they wait for are done', description: 'A workflow option for a project without version control (glossary 2.6, N6).' }),
    desc: msg({ id: 'workflow.option.dependenciesDone.desc', defaultMessage: 'A card that waits for others can’t start before their work is in.', description: 'What the workflow option “Cards start only when the cards they wait for are merged” does.' })
  },
  sharedFolderWarning: {
    title: msg({ id: 'workflow.option.sharedFolderWarning.title', defaultMessage: 'Warn when a commit includes another agent’s files', description: 'A workflow option (glossary 2.6, G16).' }),
    desc: msg({ id: 'workflow.option.sharedFolderWarning.desc', defaultMessage: 'A submit warns, never refuses, when its commit takes in files another agent is editing in the project folder.', description: 'What the workflow option “Warn when a commit includes another agent’s files” does.' })
  },
  reviewerMode: {
    title: msg({ id: 'workflow.option.reviewerMode.title', defaultMessage: 'Reviewers', description: 'A workflow option (glossary 2.6, G17): whether each lane has its own reviewer agent or the lanes share a pool of reviewers.' }),
    desc: msg({ id: 'workflow.option.reviewerMode.desc', defaultMessage: 'One reviewer per lane, or a shared pool: Combwork gives each card submitted in a pool lane, oldest first, to the next free reviewer that didn’t build it.', description: 'What the workflow option “Reviewers” does (glossary 2.6, G17; glossary: lane, pool).' })
  },
  commands: {
    title: msg({ id: 'workflow.option.commands.title', defaultMessage: 'Check commands', description: 'A workflow setting: the command each named check runs (the checks of “Checks pass before review”).' }),
    desc: msg({ id: 'workflow.option.commands.desc', defaultMessage: 'The command each named check runs. A run counts as the check only when it runs that command.', description: 'What the workflow setting “Check commands” does.' })
  },
  excluded: {
    title: msg({ id: 'workflow.option.excluded.title', defaultMessage: 'What the work is', description: 'A workflow option for a project without version control (glossary 2.6, N4).' }),
    desc: msg({ id: 'workflow.option.excluded.desc', defaultMessage: 'The whole project folder, apart from these folders and files (.combwork always).', description: 'What the workflow option “What the work is” does: the folders and files listed are left out of a card’s work.' })
  },
  stageNames: {
    title: msg({ id: 'workflow.option.stageNames.title', defaultMessage: 'Stage names', description: 'A workflow option (glossary 2.6, N5; glossary 2.2: stage): your own names for the board’s stages.' }),
    desc: msg({ id: 'workflow.option.stageNames.desc', defaultMessage: 'Rename any stage the board shows: a name changes no rule and applies at once.', description: 'What the workflow option “Stage names” does (glossary 2.2: stage).' })
  },
  fileLocks: {
    title: msg({ id: 'workflow.option.fileLocks.title', defaultMessage: 'File locks', description: 'A workflow option (glossary 2.6, N7): what happens when two agents in the same folder edit the same file.' }),
    desc: msg({ id: 'workflow.option.fileLocks.desc', defaultMessage: 'What happens when an agent tries to edit a file another agent in the same folder is editing.', description: 'What the workflow option “File locks” does.' })
  },
  loopWakes: {
    title: msg({ id: 'workflow.option.loopWakes.title', defaultMessage: 'Wake reviewers and builders', description: 'A workflow option, under Card loops: Combwork wakes the agents of a card loop for its handoffs (glossary: card loop).' }),
    desc: msg({ id: 'workflow.option.loopWakes.desc', defaultMessage: 'When a card with a reviewer arrives in Review, Combwork wakes the reviewer, and on the review’s verdict the card’s builder; off, only the agents’ own card watches wake them.', description: 'What the workflow option “Wake reviewers and builders” does.' })
  },
  maxAgents: {
    title: msg({ id: 'workflow.option.maxAgents.title', defaultMessage: 'Maximum agents', description: 'A workflow option (HI-2001): the most agents the project has, its team size. Nobody adds agents past it: the user, the Combwork Assistant or a program (HI-2058).' }),
    desc: msg({ id: 'workflow.option.maxAgents.desc', defaultMessage: 'Your team size: the most agents this project has, whoever adds them (you, the Assistant or a program using the Agent API), and lowering it removes none.', description: 'What the workflow option “Maximum agents” does (HI-2058: it binds the user too). Agent API is the name of a Combwork feature.' })
  },
  loopRounds: {
    title: msg({ id: 'workflow.option.loopRounds.title', defaultMessage: 'Rounds', description: 'A workflow option, under Card loops: how many rounds (a build and its review) a card gets before its agents ask you.' }),
    desc: msg({ id: 'workflow.option.loopRounds.desc', defaultMessage: 'How many rounds a card gets in a card loop (a build and its review each) before its agents stop and ask you, when the loop doesn’t say.', description: 'What the workflow option “Rounds” does (Card loops).' })
  },
  loopWaitHours: {
    title: msg({ id: 'workflow.option.loopWaitHours.title', defaultMessage: 'Wait (hours)', description: 'A workflow option, under Card loops: how many hours an agent in a card loop waits with no change before it tells you.' }),
    desc: msg({ id: 'workflow.option.loopWaitHours.desc', defaultMessage: 'How many hours, up to a day, an agent in a card loop waits with no change before it tells you, when the loop doesn’t say.', description: 'What the workflow option “Wait (hours)” does (Card loops).' })
  },
  loopStepWaitMinutes: {
    title: msg({ id: 'workflow.option.loopStepWaitMinutes.title', defaultMessage: 'Design check wait (minutes)', description: 'A workflow option, under Card loops: how long a builder waits for its reviewer to check a design it posted.' }),
    desc: msg({ id: 'workflow.option.loopStepWaitMinutes.desc', defaultMessage: 'How many minutes, up to 4 hours, a card loop’s builder waits for its reviewer to check a design it posted before it goes ahead as posted.', description: 'What the workflow option “Design check wait (minutes)” does (Card loops). A design: the plan a builder posts on its card before building.' })
  }
}

/** The values of the options that are choices, in the order offered. */
export const VALUE_TEXT = {
  review: {
    none: msg({ id: 'workflow.value.review.none', defaultMessage: 'No review', description: 'A value of the workflow option “Work is reviewed before it’s merged” (glossary 2.6, G1).' }),
    noneNone: msg({ id: 'workflow.value.review.noneNone', defaultMessage: 'No one', description: 'A value of the workflow option “Who checks the work before it’s done”, for a project without version control (glossary 2.6, N1).' }),
    agent: msg({ id: 'workflow.value.review.agent', defaultMessage: 'A reviewer agent', description: 'A value of the workflow option for review (glossary 2.6, G1 and N1).' }),
    agentThenYou: msg({ id: 'workflow.value.review.agentThenYou', defaultMessage: 'A reviewer agent, then you', description: 'A value of the workflow option for review (glossary 2.6, G1 and N1).' }),
    you: msg({ id: 'workflow.value.review.you', defaultMessage: 'You', description: 'A value of the workflow option for review: you review (glossary 2.6, G1 and N1).' })
  },
  sameness: {
    change: msg({ id: 'workflow.value.sameness.change', defaultMessage: 'Same change', description: 'A value of the workflow option “A pass survives a clean rebase” (glossary 2.6, G4).' }),
    exact: msg({ id: 'workflow.value.sameness.exact', defaultMessage: 'Exact revision only', description: 'A value of the workflow option “A pass survives a clean rebase” (glossary 2.6, G4).' })
  },
  finish: {
    combworkMerges: msg({ id: 'workflow.value.finish.combworkMerges', defaultMessage: 'Combwork merges', description: 'A value of the workflow option “Who merges” (glossary 2.6, G5).' }),
    agentMerges: msg({ id: 'workflow.value.finish.agentMerges', defaultMessage: 'The agent merges, Combwork checks', description: 'A value of the workflow option “Who merges” (glossary 2.6, G5).' }),
    committed: msg({ id: 'workflow.value.finish.committed', defaultMessage: 'Committed is done', description: 'A value of the workflow option “Who merges” (glossary 2.6, G5).' }),
    notChecked: msg({ id: 'workflow.value.finish.notChecked', defaultMessage: 'Not checked', description: 'A value of the workflow option “Who merges” (glossary 2.6, G5).' }),
    userIntegrates: msg({ id: 'workflow.value.finish.userIntegrates', defaultMessage: 'You integrate it yourself', description: 'A value of the workflow option “Who merges” (glossary 2.6, G5) for a project using jj (Jujutsu, HI-2799): Combwork never merges under jj; you bring the reviewed work into its target with jj.' })
  },
  style: {
    merge: msg({ id: 'workflow.value.style.merge', defaultMessage: 'Merge commit', description: 'A value of the workflow option “Merge style” (glossary 2.6, G6).' }),
    squash: msg({ id: 'workflow.value.style.squash', defaultMessage: 'Squash', description: 'A value of the workflow option “Merge style” (glossary 2.6, G6).' }),
    rebase: msg({ id: 'workflow.value.style.rebase', defaultMessage: 'Rebase and fast-forward', description: 'A value of the workflow option “Merge style” (glossary 2.6, G6; #1184): Combwork’s merge queue rebases the card’s commits onto the target branch and moves the branch forward to them, so the history stays linear, with no merge commit.' })
  },
  commitMessage: {
    combwork: msg({ id: 'workflow.value.commitMessage.cw', defaultMessage: 'Combwork’s: the card’s key and title, with trailers', description: 'A value of the workflow option “Commit message” (glossary 2.6, G19): the commit is titled with the card’s key and title (HI-12: Fix the login) and ends with Combwork’s trailers (Combwork-Card: HI-12 and others). Trailers: git’s “Key: value” lines at a message’s end.' }),
    branch: msg({ id: 'workflow.value.commitMessage.branch', defaultMessage: 'The branch’s own, with no card key or trailers', description: 'A value of the workflow option “Commit message” (glossary 2.6, G19): the commit takes the message the branch’s commits have (with several, the first one’s subject and each one’s message), never the card’s key or Combwork’s trailers. Trailers: git’s “Key: value” lines at a message’s end.' })
  },
  mergeInstall: {
    onManifestChange: msg({ id: 'workflow.value.mergeInstall.onManifestChange', defaultMessage: 'When the lock file or manifests change', description: 'A value of the workflow option “Install dependencies from scratch”: only when the project’s lock file or package manifests changed (glossary: lock file, as in the G15 value).' }),
    always: msg({ id: 'workflow.value.mergeInstall.always', defaultMessage: 'Before every merge', description: 'A value of the workflow option “Install dependencies from scratch”: before each card’s merge checks.' })
  },
  okBefore: {
    never: msg({ id: 'workflow.value.okBefore.never', defaultMessage: 'Never', description: 'A value of the workflow option “Your OK before merging” (glossary 2.6, G10).' }),
    labels: msg({ id: 'workflow.value.okBefore.labels', defaultMessage: 'Cards with these labels', description: 'A value of the workflow option “Your OK before merging” (glossary 2.6, G10).' }),
    every: msg({ id: 'workflow.value.okBefore.every', defaultMessage: 'Every card', description: 'A value of the workflow option “Your OK before merging” (glossary 2.6, G10).' })
  },
  folder: {
    slots: msg({ id: 'workflow.value.folder.slots', defaultMessage: 'Each card in its own folder', description: 'A value of the workflow option “Where cards are built” (glossary 2.6, G11). The folder is a slot, a worktree Combwork lends to the card or its lane (glossary 2.5: slot).' }),
    project: msg({ id: 'workflow.value.folder.project', defaultMessage: 'Everyone in the project folder', description: 'A value of the workflow option “Where cards are built” (glossary 2.6, G11).' })
  },
  reviewerMode: {
    lane: msg({ id: 'workflow.value.reviewerMode.lane', defaultMessage: 'One per lane', description: 'A value of the workflow option “Reviewers” (glossary 2.6, G17): each lane has its own reviewer agent.' }),
    pool: msg({ id: 'workflow.value.reviewerMode.pool', defaultMessage: 'A shared pool', description: 'A value of the workflow option “Reviewers” (glossary 2.6, G17): lanes share a pool of reviewer agents, each card going to the next free one.' })
  }
} satisfies Record<string, Record<string, Msg>>

/** The presets' names (glossary 2.1). */
export const PRESET_TEXT: Record<PresetId | 'custom', Msg> = {
  solo: msg({ id: 'workflow.preset.solo', defaultMessage: 'Solo', description: 'A workflow preset (glossary 2.1): one person, one agent at a time, no reviewer.' }),
  pair: msg({ id: 'workflow.preset.pair', defaultMessage: 'Pair', description: 'A workflow preset (glossary 2.1): a builder and a reviewer.' }),
  pairAgent: msg({ id: 'workflow.preset.pairAgent', defaultMessage: 'Pair (the agent merges)', description: 'A workflow preset (glossary 2.1, Pair): a builder and a reviewer, and the builder merges each card itself.' }),
  team: msg({ id: 'workflow.preset.team', defaultMessage: 'Team', description: 'A workflow preset (glossary 2.1): several builders and reviewers, stricter checks.' }),
  custom: msg({ id: 'workflow.preset.custom', defaultMessage: 'Custom', description: 'The workflow preset shown when the options no longer match a preset (glossary 2.1).' })
}

/** What a preset leaves for a later version, said under the preset choice while it is chosen (#1361). */
export const PRESET_NOTE_TEXT: Partial<Record<PresetId, Msg>> = {
  team: msg({ id: 'workflow.preset.note.teamFocused', defaultMessage: 'Team runs each card’s focused tests on the merged result when the project has a command that runs them: set it under Each card’s focused tests.', description: 'Under the preset choice of Project Settings → Workflow while Team is chosen (glossary 2.1: Team; G20: Each card’s focused tests is an option’s name, as translated there).' })
}

/**
 * An option's label for a platform; with `folder`, Git's label in a shared folder where it differs (G1 reads "Work is
 * reviewed before it's done" with everyone in the project folder, #1418).
 */
export const optionTitle = (key: OptionKey, platform: PlatformId, folder?: 'slots' | 'project'): Msg | null => {
  const t = OPTION_TEXT[key]
  if (!t) return null
  // `none`: the label where work is accepted, not merged (None's N options; HI-2822: by the descriptor).
  if (accepts(platform)) return t.none ?? t.title
  return folder === 'project' && t.shared ? t.shared : t.title
}

/** The Workflow section's group headings (#1418). */
export const GROUP_TEXT: Record<FormGroupId, Msg> = {
  team: msg({ id: 'workflow.group.team', defaultMessage: 'Team', description: 'A heading of the Workflow section: how many agents the project has (its team, HI-2001).' }),
  review: msg({ id: 'workflow.group.review', defaultMessage: 'Review', description: 'A heading of the Version Control tab’s Workflow section: the options about reviewing a card’s work.' }),
  checks: msg({ id: 'workflow.group.checks', defaultMessage: 'Checks', description: 'A heading of the Workflow section: the options about the checks that must pass (glossary 2.3: checks).' }),
  merging: msg({ id: 'workflow.group.merging', defaultMessage: 'Merging', description: 'A heading of the Workflow section (Git): the options about how and where work is merged.' }),
  where: msg({ id: 'workflow.group.where', defaultMessage: 'Where cards are built', description: 'A heading of the Workflow section (Git): the options about the folders cards are built in and the commits made there (glossary 2.6, G11).' }),
  work: msg({ id: 'workflow.group.work', defaultMessage: 'The work', description: 'A heading of the Workflow section for a project without version control: what a card’s work is, and when cards start.' }),
  loops: msg({ id: 'workflow.group.loops', defaultMessage: 'Card loops', description: 'A heading of the Workflow section: how card loops run, a builder and a reviewer taking cards in turn (glossary: card loop).' }),
  stages: msg({ id: 'workflow.group.stages', defaultMessage: 'Stages', description: 'A heading of the Workflow section: the names of the board’s stages (glossary 2.2: stage).' })
}

/**
 * The user's answer to the merge queue's question before an upgraded project's first merge (HI-1697), kept on the card
 * as their comment, in their language (HI-1733): the two options by the names and values Version Control → Workflow
 * shows. Nothing reads its words: the choice is the board's record and the project's options.
 */
export const MERGE_ANSWER = msg({ id: 'workflow.mergeChoice.answer', defaultMessage: '{styleTitle}: {style}. {messageTitle}: {message}.', description: "The user's answer to the merge queue's question before an upgraded project's first merge, kept on the card as the user's own comment: the two workflow options they chose, each its name ({styleTitle}: Merge style; {messageTitle}: Commit message) and the value chosen ({style}: Squash, say; {message}: a value of Commit message). The names and values are the workflow options' own texts, already translated: arrange them as your language writes such a list." })

/** Why the presets set each option as they do (§16.6.3's Why column), one sentence each, shown in a preset's preview. */
export const OPTION_WHY: Partial<Record<OptionKey, Msg>> = {
  maxAgents: msg({ id: 'workflow.why.maxAgents', defaultMessage: 'Each preset is for a team of its size (one agent solo, a builder and a reviewer as a pair), so the Assistant never adds agents you didn’t plan for.', description: 'Why the presets set “Maximum agents” as they do (Solo: 1; Pair: 2; Team: 12).' }),
  review: msg({ id: 'workflow.why.review', defaultMessage: 'A pair exists to review: a second agent catches what the builder missed, while working solo you read the card’s work yourself.', description: 'Why the presets set “Work is reviewed before it’s merged” as they do (Solo: no review; Pair and Team: a reviewer agent).' }),
  reviewers: msg({ id: 'workflow.why.reviewers', defaultMessage: 'One reviewer is enough for most work; a second doubles the cost.', description: 'Why the presets set “Reviewers per card” to 1.' }),
  noSelfReview: msg({ id: 'workflow.why.noSelfReview', defaultMessage: 'A builder never passes its own work.', description: 'Why the presets turn on “Nobody reviews their own work” wherever there is a reviewer.' }),
  preChecks: msg({ id: 'workflow.why.preChecks', defaultMessage: 'Cheap checks before review catch most of the rounds that would be lost, and a team adds its tests.', description: 'Why the presets set “Checks pass before review” as they do (Pair: the quick checks; Team: the tests too).' }),
  sameness: msg({ id: 'workflow.why.sameness', defaultMessage: 'A clean rebase doesn’t change what was reviewed, so the pass still counts.', description: 'Why every preset sets “A pass survives a clean rebase” to Same change.' }),
  finish: msg({ id: 'workflow.why.finish', defaultMessage: 'Merged through Combwork’s queue, red work never reaches the target branch; working solo, a card is done once it’s committed.', description: 'Why the presets set “Who merges” as they do (glossary 2.1: merge queue).' }),
  style: msg({ id: 'workflow.why.style', defaultMessage: 'A merge commit keeps each card’s own commits, as Combwork has always merged.', description: 'Why the presets set “Merge style” to Merge commit.' }),
  target: msg({ id: 'workflow.why.target', defaultMessage: 'Finished work goes to the repository’s default branch; working solo, to the branch the project is on.', description: 'Why the presets set “Work merges into” as they do.' }),
  strict: msg({ id: 'workflow.why.strict', defaultMessage: 'The merge queue tests the merged result anyway, so this mostly changes the history’s shape.', description: 'Why the presets leave “Work is up to date with its target branch before it merges” off.' }),
  pushTarget: msg({ id: 'workflow.why.pushTarget', defaultMessage: 'Pushing reaches your remote and its sign-in, so it stays yours unless you turn it on.', description: 'Why the presets leave “Push the target branch after merging” off.' }),
  followRemote: msg({ id: 'workflow.why.followRemote', defaultMessage: 'Following a remote reaches it and its sign-in before every merge, so it stays yours unless you turn it on.', description: 'Why the presets leave “The target branch follows its remote” off.' }),
  commitMessage: msg({ id: 'workflow.why.commitMessage', defaultMessage: 'Card titles can name people and details a public history shouldn’t keep; choose Combwork’s for the card’s key, linking each merge to its card.', description: 'Why the presets set “Commit message” to the branch’s own (HI-1997), and what choosing Combwork’s (the card’s key and title, with trailers) gives instead.' }),
  mergeChecks: msg({ id: 'workflow.why.mergeChecks', defaultMessage: 'The checks run on the work as it will be once merged, not only as it was built.', description: 'Why the presets set “Checks pass on the merged result” when Combwork merges.' }),
  focusedTests: msg({ id: 'workflow.why.focusedTests', defaultMessage: 'Each card’s own tests on the merged result catch what its change breaks there, without running every test for every card.', description: 'Why Team turns on “Each card’s focused tests pass on the merged result” when the project has the command that runs them.' }),
  mergeInstall: msg({ id: 'workflow.why.mergeInstall', defaultMessage: 'A clean install before every merge catches a dependency that only worked on the builder’s machine.', description: 'Why Team installs dependencies from scratch before every merge.' }),
  okBefore: msg({ id: 'workflow.why.okBefore', defaultMessage: 'Some work needs your eyes before it ships, such as screenshots and release steps.', description: 'Why Team asks for your OK on cards labelled ui or release.' }),
  folder: msg({ id: 'workflow.why.folder', defaultMessage: 'Pairs and teams build in parallel, each card apart from the others.', description: 'Why the presets set “Where cards are built” as they do (Solo: the project folder).' }),
  identity: msg({ id: 'workflow.why.identity', defaultMessage: 'Commits name the project’s identity, whoever’s computer made them.', description: 'Why Pair and Team turn on “Commits use the project’s identity”.' }),
  stopOwnRuns: msg({ id: 'workflow.why.stopOwnRuns', defaultMessage: 'A run left going would keep changing or testing the work under review.', description: 'Why Pair and Team turn on “Agents stop what they started before review”.' }),
  dependenciesDone: msg({ id: 'workflow.why.dependenciesDone', defaultMessage: 'It’s cheap, and no card is built on work that isn’t in yet.', description: 'Why every preset turns on “Cards start only when the cards they wait for are merged” (or done).' }),
  slotsUpToDate: msg({ id: 'workflow.why.slotsUpToDate', defaultMessage: 'Each card starts from the latest work, so no card is built on an old copy of the target branch.', description: 'Why Pair and Team turn on “Slots are brought up to date before each card” (glossary 2.5: slot).' }),
  reviewerMode: msg({ id: 'workflow.why.reviewerMode', defaultMessage: 'One reviewer per lane keeps the work with a reviewer who has seen its earlier rounds; a shared pool suits a large team.', description: 'Why Pair and Team set “Reviewers” to One per lane (glossary 2.6, G17; glossary: lane, pool).' }),
  sharedFolderWarning: msg({ id: 'workflow.why.sharedFolderWarning', defaultMessage: 'In a shared folder, one agent’s commit can take in another’s half-done files.', description: 'Why Solo turns on “Warn when a commit includes another agent’s files”.' }),
  excluded: msg({ id: 'workflow.why.excluded', defaultMessage: 'Dependencies and build output aren’t part of what a card delivers.', description: 'Why the presets leave node_modules and .venv out of “What the work is” (no version control).' })
}

/** A preset in one sentence, for its choice in the Workflow section (#1418), per platform. */
export const PRESET_SUMMARY: Record<PlatformId, Partial<Record<PresetId, Msg>>> = {
  git: {
    solo: msg({ id: 'workflow.summary.git.solo', defaultMessage: 'Everyone in the project folder, no review: a card is done once it’s committed.', description: 'What the Solo preset sets up, for a Git project (glossary 2.1: Solo).' }),
    pairAgent: msg({ id: 'workflow.summary.git.pairAgent', defaultMessage: 'A reviewer agent passes each card, then its builder merges it and Combwork checks the work is in the target.', description: 'What the preset “Pair (the agent merges)” sets up (glossary 2.1: Pair).' }),
    pair: msg({ id: 'workflow.summary.git.pair', defaultMessage: 'A reviewer agent passes each card, then Combwork’s merge queue merges it once the checks pass on the merged result.', description: 'What the Pair preset sets up, for a Git project (glossary 2.1: Pair, merge queue).' }),
    team: msg({ id: 'workflow.summary.git.team', defaultMessage: 'Pair with stricter checks: the unit tests too, a clean install before every merge, and your OK for cards labelled ui or release.', description: 'What the Team preset sets up, for a Git project (glossary 2.1: Team, Pair).' })
  },
  none: {
    solo: msg({ id: 'workflow.summary.none.solo', defaultMessage: 'No review: a card is done when its builder submits it.', description: 'What the Solo preset sets up, for a project without version control.' }),
    pair: msg({ id: 'workflow.summary.none.pair', defaultMessage: 'A reviewer agent checks each card, after the quick checks pass.', description: 'What the Pair preset sets up, for a project without version control.' }),
    team: msg({ id: 'workflow.summary.none.team', defaultMessage: 'A reviewer agent, then you, check each card, after the quick checks and the tests pass.', description: 'What the Team preset sets up, for a project without version control.' })
  },
  // jj (HI-2799, option A): the user integrates what passed; Combwork never merges.
  jj: {
    solo: msg({ id: 'workflow.summary.jj.solo', defaultMessage: 'Each card in its own jj workspace, no review: you integrate the work yourself.', description: 'What the Solo preset sets up, for a project using jj (Jujutsu, HI-2799). Keep jj; a jj workspace is a working folder jj makes.' }),
    pair: msg({ id: 'workflow.summary.jj.pair', defaultMessage: 'A reviewer agent passes each card after the quick checks, then you integrate it yourself.', description: 'What the Pair preset sets up, for a project using jj (Jujutsu, HI-2799): Combwork never merges under jj.' }),
    team: msg({ id: 'workflow.summary.jj.team', defaultMessage: 'A reviewer agent, then you, check each card after the quick checks and the tests, then you integrate it yourself.', description: 'What the Team preset sets up, for a project using jj (Jujutsu, HI-2799): Combwork never merges under jj.' })
  }
}
