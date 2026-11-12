// The compatibility gates in the window's words (HI-2799, SPEC §16.3.6's matrix): each gate's name and why jj refuses it,
// shown as "not supported" in jj's Repository section and in the switch's warning, never offered as working.

import { msg, type Msg } from '../i18n/msg'
import type { Gate } from './descriptors'

export const GATE_TEXT: Record<Gate, { name: Msg; why: Msg }> = {
  attributes: {
    name: msg({ id: 'git.gate.attributes.name', defaultMessage: 'Git attributes and filters', description: 'A Git feature jj doesn’t support (HI-2799): .gitattributes line endings (eol, text), clean/smudge filters, diff and merge drivers. Keep Git.' }),
    why: msg({ id: 'git.gate.attributes.why', defaultMessage: 'jj doesn’t apply them: line endings, filters and merge drivers would be ignored.', description: 'Why jj can’t be used with Git attributes (HI-2799). Keep jj.' })
  },
  hooks: {
    name: msg({ id: 'git.gate.hooks.name', defaultMessage: 'Git hooks', description: 'A Git feature jj doesn’t support (HI-2799): pre-commit, commit-msg and other hooks. Keep Git.' }),
    why: msg({ id: 'git.gate.hooks.why', defaultMessage: 'jj doesn’t run them, so a hook the repository relies on would be skipped.', description: 'Why jj can’t be used where Git hooks are set (HI-2799). Keep jj.' })
  },
  lfs: {
    name: msg({ id: 'git.gate.lfs.name', defaultMessage: 'Git LFS', description: 'A Git feature jj doesn’t support (HI-2799): Large File Storage. Keep Git LFS (a product’s name).' }),
    why: msg({ id: 'git.gate.lfs.why', defaultMessage: 'jj doesn’t support large file storage.', description: 'Why jj can’t be used with Git LFS (HI-2799). Keep jj.' })
  },
  submodules: {
    name: msg({ id: 'git.gate.submodules.name', defaultMessage: 'Submodules', description: 'A Git feature jj doesn’t support (HI-2799): repositories nested as submodules.' }),
    why: msg({ id: 'git.gate.submodules.why', defaultMessage: 'jj doesn’t support submodules.', description: 'Why jj can’t be used with submodules (HI-2799). Keep jj.' })
  },
  signing: {
    name: msg({ id: 'git.gate.signing.name', defaultMessage: 'Commit signing', description: 'A feature not verified with jj (HI-2799): signed commits (gpgSign, jj’s signing.behavior).' }),
    why: msg({ id: 'git.gate.signing.why', defaultMessage: 'Signing with jj isn’t verified with Combwork yet.', description: 'Why jj can’t be used where commits are signed (HI-2799). Keep jj.' })
  },
  relocation: {
    name: msg({ id: 'git.gate.relocation.name', defaultMessage: 'Moving the workspace or project', description: 'What Combwork can’t do with a jj project (HI-2799): move its workspace or project folder, or repair a moved one.' }),
    why: msg({ id: 'git.gate.relocation.why', defaultMessage: 'No move of a jj workspace has been validated: after a move, Repair leaves jj’s workspaces as they are.', description: 'Why moving is not supported with jj (HI-2799, HI-2800): Repair (after a moved workspace or project) doesn’t repair jj’s own workspaces. Keep jj; Repair is the button’s name.' })
  },
  plainGit: {
    name: msg({ id: 'git.gate.plainGit.name', defaultMessage: 'Plain git commands by agents', description: 'What isn’t supported in a jj project (HI-2799): agents running git themselves (reset, rebase, merge) in a jj workspace.' }),
    why: msg({ id: 'git.gate.plainGit.why', defaultMessage: 'Agents are told to use jj, but a git command that moves HEAD, the index or a branch can still confuse jj’s view of the repository.', description: 'Why plain git commands aren’t supported in a jj project (HI-2799, HI-2800: agents in a jj project are told to use jj). Keep git, jj and HEAD.' })
  },
  advance: {
    name: msg({ id: 'git.gate.advance.name', defaultMessage: 'Combwork merging', description: 'What Combwork doesn’t do with jj (HI-2799): merge reviewed work into the target itself (the merge queue’s last step).' }),
    why: msg({ id: 'git.gate.advance.why', defaultMessage: 'jj can’t move a bookmark safely when others move it too, so you integrate reviewed work yourself.', description: 'Why Combwork doesn’t merge under jj (HI-2799, Darren’s decision A). Keep jj; a bookmark is jj’s named line.' })
  },
  publish: {
    name: msg({ id: 'git.gate.publish.name', defaultMessage: 'Pushing after a merge', description: 'What Combwork doesn’t do with jj (HI-2799): push the target after merging.' }),
    why: msg({ id: 'git.gate.publish.why', defaultMessage: 'Combwork doesn’t push for a jj project: push with jj yourself.', description: 'Why Combwork doesn’t push under jj (HI-2799). Keep jj.' })
  },
  sharedFolder: {
    name: msg({ id: 'git.gate.sharedFolder.name', defaultMessage: 'Agents sharing the project folder', description: 'What isn’t supported with jj (HI-2799): several agents working in the project folder itself rather than in their own folders.' }),
    why: msg({ id: 'git.gate.sharedFolder.why', defaultMessage: 'Cards never run in the project folder: each would need its own jj workspace.', description: 'Why the shared folder isn’t supported with jj (HI-2799, HI-2800): cards never run in a jj project’s folder. Keep jj; a jj workspace is a working folder jj makes.' })
  }
}
