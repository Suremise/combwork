// The workflow options' words (SPEC §16.6.1, §16.6.2; glossary 2.6, agreed 20 Oct): each option's label and what it
// does, and its values, for the plain Workflow section in Project Settings (#1278) and the settings catalog's rows the
// Assistant sets them by. Kept as messages, shown with tr() where they are rendered.

import { msg, type Msg } from '../i18n/msg'
import type { PlatformId } from '../platform/descriptors'
import type { OptionKey, PresetId, PresetNeeds } from './options'

interface OptionText {
  title: Msg
  desc: Msg
  /** None's own label, where it differs (N1, N6). */
  none?: Msg
}

/** Each option the form shows: its label (Git's; None's where it differs) and what it does. */
export const OPTION_TEXT: Partial<Record<OptionKey, OptionText>> = {
  review: {
    title: msg({ id: 'workflow.option.review.title', defaultMessage: 'Work is reviewed before it’s merged', description: 'A workflow option (glossary 2.6, G1): who reviews a card’s work before it is merged.' }),
    none: msg({ id: 'workflow.option.review.none', defaultMessage: 'Who checks the work before it’s done', description: 'A workflow option for a project without version control (glossary 2.6, N1).' }),
    desc: msg({ id: 'workflow.option.review.desc', defaultMessage: 'A card goes to Review when its builder submits it, and on once it passes. With you as well, it waits for your OK after the reviewer.', description: 'What the workflow option “Work is reviewed before it’s merged” does.' })
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
    desc: msg({ id: 'workflow.option.preChecks.desc', defaultMessage: 'Each check is a named command. A card goes to review only once each one has passed on its work.', description: 'What the workflow option “Checks pass before review” does.' })
  },
  sameness: {
    title: msg({ id: 'workflow.option.sameness.title', defaultMessage: 'A pass survives a clean rebase', description: 'A workflow option (glossary 2.6, G4).' }),
    desc: msg({ id: 'workflow.option.sameness.desc', defaultMessage: 'With the same change, a pass still counts after the work is moved onto newer commits without changing it.', description: 'What the workflow option “A pass survives a clean rebase” does.' })
  },
  finish: {
    title: msg({ id: 'workflow.option.finish.title', defaultMessage: 'Who merges', description: 'A workflow option (glossary 2.6, G5).' }),
    desc: msg({ id: 'workflow.option.finish.desc', defaultMessage: 'When a card is done: once Hive’s merge queue has merged it, once its agent has merged it and Hive finds the work in the target branch, once it is committed, or whenever it is moved there.', description: 'What the workflow option “Who merges” does (glossary 2.1: merge queue).' })
  },
  style: {
    title: msg({ id: 'workflow.option.style.title', defaultMessage: 'Merge style', description: 'A workflow option (glossary 2.6, G6).' }),
    desc: msg({ id: 'workflow.option.style.desc', defaultMessage: 'How a card’s work is merged into the target branch.', description: 'What the workflow option “Merge style” does.' })
  },
  target: {
    title: msg({ id: 'workflow.option.target.title', defaultMessage: 'Work merges into', description: 'A workflow option (glossary 2.6, G7): the target branch.' }),
    desc: msg({ id: 'workflow.option.target.desc', defaultMessage: 'The target branch. Left empty, the repository’s default branch.', description: 'What the workflow option “Work merges into” does.' })
  },
  mergeChecks: {
    title: msg({ id: 'workflow.option.mergeChecks.title', defaultMessage: 'Checks pass on the merged result', description: 'A workflow option (glossary 2.6, G9): named commands Hive’s merge queue runs on a card’s work merged with the target branch.' }),
    desc: msg({ id: 'workflow.option.mergeChecks.desc', defaultMessage: 'Each check is a named command. Hive’s merge queue runs them on the card’s work merged with the target branch, and moves the target only once each one has passed.', description: 'What the workflow option “Checks pass on the merged result” does (glossary 2.1: merge queue).' })
  },
  strict: {
    title: msg({ id: 'workflow.option.strict.title', defaultMessage: 'Work is up to date with its target branch before it merges', description: 'A workflow option (glossary 2.6, G8, strict): a card’s work must contain the target branch’s latest commit before it is merged; Hive’s merge queue brings it up to date itself.' }),
    desc: msg({ id: 'workflow.option.strict.desc', defaultMessage: 'When the target branch has moved on since the review, Hive’s merge queue merges it into the card’s work (or rebases the work, with the Squash merge style) in its own folder, never on the builder’s branch. The review still counts if the result is the same change; if not, or if it conflicts, the card goes back to its builder.', description: 'What the workflow option “Work is up to date with its target branch before it merges” does (glossary 2.1: merge queue; Squash is the merge style’s value).' })
  },
  mergeInstall: {
    title: msg({ id: 'workflow.option.mergeInstall.title', defaultMessage: 'Install dependencies from scratch', description: 'A workflow option (G9’s install): when the merge queue installs the project’s dependencies afresh before the merge checks.' }),
    desc: msg({ id: 'workflow.option.mergeInstall.desc', defaultMessage: 'Before the checks on the merged result. A change to the lock file or the manifests always installs from scratch, whichever you choose.', description: 'What the workflow option “Install dependencies from scratch” does. Lock file: as in the glossary (G15 value).' })
  },
  okBefore: {
    title: msg({ id: 'workflow.option.okBefore.title', defaultMessage: 'Your OK before merging', description: 'A workflow option (glossary 2.6, G10).' }),
    desc: msg({ id: 'workflow.option.okBefore.desc', defaultMessage: 'A card waits for your OK before it is merged: never, only cards with these labels, or every card.', description: 'What the workflow option “Your OK before merging” does.' })
  },
  folder: {
    title: msg({ id: 'workflow.option.folder.title', defaultMessage: 'Where cards are built', description: 'A workflow option (glossary 2.6, G11).' }),
    desc: msg({ id: 'workflow.option.folder.desc', defaultMessage: 'In its own folder, a card is built in its builder’s worktree, apart from other agents’ work. In the project folder, everyone sees each other’s unfinished changes.', description: 'What the workflow option “Where cards are built” does.' })
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
    desc: msg({ id: 'workflow.option.sharedFolderWarning.desc', defaultMessage: 'In the project folder, a submit warns when its commit takes in files another agent is editing. It never refuses.', description: 'What the workflow option “Warn when a commit includes another agent’s files” does.' })
  },
  commands: {
    title: msg({ id: 'workflow.option.commands.title', defaultMessage: 'Check commands', description: 'A workflow setting: the command each named check runs (the checks of “Checks pass before review”).' }),
    desc: msg({ id: 'workflow.option.commands.desc', defaultMessage: 'The command each named check runs. A run counts as the check only when it runs that command.', description: 'What the workflow setting “Check commands” does.' })
  },
  excluded: {
    title: msg({ id: 'workflow.option.excluded.title', defaultMessage: 'What the work is', description: 'A workflow option for a project without version control (glossary 2.6, N4).' }),
    desc: msg({ id: 'workflow.option.excluded.desc', defaultMessage: 'The whole project folder, apart from these folders and files (.hive always).', description: 'What the workflow option “What the work is” does: the folders and files listed are left out of a card’s work.' })
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
    hiveMerges: msg({ id: 'workflow.value.finish.hiveMerges', defaultMessage: 'Hive merges', description: 'A value of the workflow option “Who merges” (glossary 2.6, G5).' }),
    agentMerges: msg({ id: 'workflow.value.finish.agentMerges', defaultMessage: 'The agent merges, Hive checks', description: 'A value of the workflow option “Who merges” (glossary 2.6, G5).' }),
    committed: msg({ id: 'workflow.value.finish.committed', defaultMessage: 'Committed is done', description: 'A value of the workflow option “Who merges” (glossary 2.6, G5).' }),
    notChecked: msg({ id: 'workflow.value.finish.notChecked', defaultMessage: 'Not checked', description: 'A value of the workflow option “Who merges” (glossary 2.6, G5).' })
  },
  style: {
    merge: msg({ id: 'workflow.value.style.merge', defaultMessage: 'Merge commit', description: 'A value of the workflow option “Merge style” (glossary 2.6, G6).' }),
    squash: msg({ id: 'workflow.value.style.squash', defaultMessage: 'Squash', description: 'A value of the workflow option “Merge style” (glossary 2.6, G6).' })
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
    slots: msg({ id: 'workflow.value.folder.slots', defaultMessage: 'Each card in its own folder', description: 'A value of the workflow option “Where cards are built” (glossary 2.6, G11). In this version the folder is the builder’s worktree.' }),
    project: msg({ id: 'workflow.value.folder.project', defaultMessage: 'Everyone in the project folder', description: 'A value of the workflow option “Where cards are built” (glossary 2.6, G11).' })
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
  team: msg({ id: 'workflow.preset.note.team', defaultMessage: 'Team checks the merged result with the quick checks and the unit tests. Running each card’s own focused tests there too comes in a later version.', description: 'Under the preset choice of Project Settings → Workflow while Team is chosen (glossary 2.1: Team; G9: the merged result).' })
}

/** Why a preset is shown unavailable (§16.19.1). */
export const PRESET_NEEDS_TEXT: Record<PresetNeeds, Msg> = {
  slots: msg({ id: 'workflow.preset.needs.slots', defaultMessage: 'Needs a folder of its own for every card, which comes in a later version.', description: 'Why a workflow preset can’t be chosen yet.' })
}

/** An option's label for a platform. */
export const optionTitle = (key: OptionKey, platform: PlatformId): Msg | null => {
  const t = OPTION_TEXT[key]
  return t ? (platform === 'none' && t.none ? t.none : t.title) : null
}
