import type { StoreSwitch } from '@shared/platform/switching'
import type { PlatformId } from '@shared/platform/descriptors'
import { PLATFORM_NAME } from '@shared/platform/switching'
import { GATE_TEXT } from '@shared/platform/gateTexts'
import { msg, tr } from '@shared/i18n'
import { cardLabelOf, useStore } from '../store'
import { Icon } from '../components/ui'

/**
 * A switch between Git and jj in its warning (HI-2799, SPEC §16.6.5): the repository's projects that switch together,
 * what still runs on it (the switch waits for all of it), to jj what the repository uses that jj doesn't support and
 * what jj never does in Combwork, and back to Git what isn't ready. Each list is what main found; nothing here decides.
 */

const M = {
  group: msg({ id: 'git.vc.store.group', defaultMessage: '{n, plural, one {This project switches:} other {These projects share this repository and switch together:}}', description: 'In the warning before switching between Git and jj (HI-2799): above the projects of the workspace on the same repository, which all switch.' }),
  member: msg({ id: 'git.vc.store.member', defaultMessage: '{project} (now {platform})', description: 'A project in the warning before switching between Git and jj (HI-2799). {platform} is None, Git or jj, its version control now.' }),
  drain: msg({ id: 'git.vc.store.drain', defaultMessage: 'Still running on this repository (the switch waits until all of it has finished):', description: 'In the warning before switching between Git and jj (HI-2799): above what still uses the repository. Nothing of it is stopped by Combwork.' }),
  lane: msg({ id: 'git.vc.store.lane', defaultMessage: '{project}: lane “{name}” (builder {builder})', description: 'A running lane in the switch’s warning (HI-2799). A noun before the name (glossary §1 rule 4).' }),
  laneUnnamed: msg({ id: 'git.vc.store.laneUnnamed', defaultMessage: '{project}: a lane (builder {builder})', description: 'A running lane with no name in the switch’s warning (HI-2799).' }),
  card: msg({ id: 'git.vc.store.card', defaultMessage: '{project}: {card} {title}, in flight', description: 'A card started and not done, in the switch’s warning (HI-2799). {card} is its key.' }),
  queue: msg({ id: 'git.vc.store.queue', defaultMessage: '{project}: its merge queue', description: 'In the switch’s warning (HI-2799): a project’s merge queue still has work (glossary 2.5: merge queue).' }),
  slot: msg({ id: 'git.vc.store.slot', defaultMessage: '{project}: slot {slot}, lent to {agent}', description: 'In the switch’s warning (HI-2799): a slot (a card’s own folder) still lent to an agent (glossary 2.5: slot).' }),
  kept: msg({ id: 'git.vc.store.kept', defaultMessage: '{project}: {card}’s committed work, kept in slot {slot} for when it starts again: start {card} and finish it', description: 'In the switch’s warning (HI-3069): a card was put back with commits, and its slot is kept for it; after the switch that slot could never be lent back, so the switch waits until the card has finished. {card} is a card key like AM-12; {slot} a slot’s name (glossary 2.5: slot).' }),
  copy: msg({ id: 'git.vc.store.copy', defaultMessage: '{project}: {kind, select, review {review copy} other {check copy}} {copy}', description: 'In the switch’s warning (HI-2799): a review or check copy still in use.' }),
  gates: msg({ id: 'git.vc.store.gates', defaultMessage: 'What this repository uses, checked for jj:', description: 'In the warning before switching to jj (HI-2799): above each Git feature jj doesn’t support, checked in this repository. Keep jj.' }),
  clear: msg({ id: 'git.vc.store.clear', defaultMessage: '{gate}: not used', description: 'A feature jj doesn’t support, not used by this repository (HI-2799). {gate} is its name.' }),
  uses: msg({ id: 'git.vc.store.uses', defaultMessage: '{gate}: used ({what})', description: 'A feature jj doesn’t support, used by this repository (HI-2799): {what} says where (a setting, a file), as found.' }),
  unknown: msg({ id: 'git.vc.store.unknown', defaultMessage: '{gate}: couldn’t be checked ({what}), so it counts as used', description: 'A feature jj doesn’t support whose use Combwork couldn’t read (HI-2799): unreadable counts as used, so the switch is refused.' }),
  stock: msg({ id: 'git.vc.store.stock', defaultMessage: 'Git for Windows’ own default settings (its LFS filter, the diff driver for Office documents) don’t count: only what the repository or your own Git settings use.', description: 'Under the gates in the warning before switching to jj (HI-2872): Git for Windows’ stock system settings are ignored. Keep Git for Windows (a product’s name) and LFS.' }),
  autocrlf: msg({ id: 'git.vc.store.autocrlf', defaultMessage: 'Git converts line endings here (core.autocrlf). If this repository doesn’t need that, turn it off for it alone: run {command} in it, then Check Again.', description: 'Under Git attributes in the warning before switching to jj (HI-2872), when Git’s line-ending conversion is on. {command} is a git command, kept as it is; core.autocrlf is a Git setting; Check Again is the dialog’s button.' }),
  unsupported: msg({ id: 'git.vc.store.unsupported', defaultMessage: 'Not supported with jj, whatever the repository:', description: 'In the warning before switching to jj (HI-2799): above what Combwork never does with jj (merging, pushing, moving…). Keep jj.' }),
  limit: msg({ id: 'git.vc.store.limit', defaultMessage: '{gate}: {why}', description: 'A limit of jj in Combwork (HI-2799): its name and why.' }),
  toJj: msg({ id: 'git.vc.store.toJj', defaultMessage: 'Combwork never creates a jj repository or changes how it is colocated: .jj, and .git where there is one, stay as they are. Cards run in slots of their own, and you integrate the reviewed work yourself: Combwork never moves a bookmark or pushes.', description: 'In the warning before switching to jj (HI-2799, HI-2896: a jj repository colocated with Git has a .git beside .jj, one not colocated has none; HI-2874: jj cards run). A bookmark is jj’s name for a branch. Keep jj, .jj and .git.' }),
  fallback: msg({ id: 'git.vc.store.fallback', defaultMessage: 'Before going back to Git:', description: 'In the warning before switching a jj project back to Git (HI-2799): above what isn’t ready. Keep Git.' }),
  heads: msg({ id: 'git.vc.store.heads', defaultMessage: 'jj has {n, plural, =0 {no readable operation head} one {# operation head} other {# operation heads}}: let jj reconcile them first.', description: 'Why a jj project can’t go back to Git yet (HI-2799): jj’s operation log has diverged. Keep jj.' }),
  conflictedBookmark: msg({ id: 'git.vc.store.conflictedBookmark', defaultMessage: 'Bookmark {name} is conflicted: resolve it with jj.', description: 'Why a jj project can’t go back to Git yet (HI-2799): a bookmark points at several commits. Keep jj.' }),
  notExported: msg({ id: 'git.vc.store.notExported', defaultMessage: 'Bookmark {name} isn’t the same in Git: run jj git export, or check it.', description: 'Why a jj project can’t go back to Git yet (HI-2799): a bookmark and its Git branch differ. Keep jj git export (a command).' }),
  conflictedCommit: msg({ id: 'git.vc.store.conflictedCommit', defaultMessage: 'Commit {commit} stores conflicts: resolve them with jj.', description: 'Why a jj project can’t go back to Git yet (HI-2799): a commit on a bookmark stores unresolved conflicts. {commit} is a short id. Keep jj.' }),
  fallbackUnknown: msg({ id: 'git.vc.store.fallbackUnknown', defaultMessage: 'Couldn’t read the repository ({detail}).', description: 'Why a jj project can’t go back to Git yet (HI-2799): jj couldn’t be read. {detail} is a short code, kept in English.' }),
  detached: msg({ id: 'git.vc.store.detached', defaultMessage: '{project}: its folder is on no branch (its head is detached at {head}), and stays so after the switch. Check out the branch its work goes on there (git switch) before its cards start in the project folder.', description: 'HI-3104: a hint in the warning before switching back to Git: a project’s folder has no branch checked out (a detached head, as a jj repository colocated with Git leaves it). Combwork doesn’t check one out; a card started in that folder is refused until the user does. {head} is a short commit id. git switch is a command: keep it.' }),
  toGit: msg({ id: 'git.vc.store.toGit', defaultMessage: 'Combwork leaves .jj in place: remove it with jj if you no longer want it.', description: 'In the warning before switching a jj project back to Git (HI-2799). Keep .jj and jj.' })
}

export function StoreSwitchDetails({ store, to }: { store: StoreSwitch; to: PlatformId }) {
  const tasks = useStore((s) => s.tasks)
  const d = store.drain
  const busy = d.lanes.length + d.cards.length + d.queue.length + d.slots.length + d.copies.length + (d.kept?.length ?? 0)
  return (
    <div className="vc-store" data-vc-store={to}>
      {store.group.length > 0 && (
        <>
          <p>{tr(M.group, { n: store.group.length })}</p>
          <ul data-vc-store-group="">
            {store.group.map((g) => (
              <li key={g.path}>{tr(M.member, { project: g.name, platform: tr(PLATFORM_NAME[g.from]) })}</li>
            ))}
          </ul>
        </>
      )}
      {busy > 0 && (
        <>
          <p className="caution">{tr(M.drain)}</p>
          <ul data-vc-store-drain="">
            {d.lanes.map((l) => (
              <li key={`l${l.id}`}>{l.name ? tr(M.lane, { project: l.project, name: l.name, builder: l.builder }) : tr(M.laneUnnamed, { project: l.project, builder: l.builder })}</li>
            ))}
            {d.cards.map((c) => (
              <li key={`c${c.number}`}>{tr(M.card, { project: c.project, card: cardLabelOf({ tasks }, c.number), title: c.title })}</li>
            ))}
            {d.queue.map((p) => (
              <li key={`q${p}`}>{tr(M.queue, { project: p })}</li>
            ))}
            {d.slots.map((s) => (
              <li key={`s${s.project}${s.slot}`}>{tr(M.slot, { project: s.project, slot: s.slot, agent: s.agent })}</li>
            ))}
            {d.copies.map((c) => (
              <li key={`k${c.project}${c.copy}`}>{tr(M.copy, { project: c.project, kind: c.kind === 'review' ? 'review' : 'check', copy: c.copy })}</li>
            ))}
            {(d.kept ?? []).map((k) => (
              <li key={`h${k.project}${k.slot}`} data-vc-store-kept={k.slot}>
                {tr(M.kept, { project: k.project, card: cardLabelOf({ tasks }, k.card), slot: k.slot })}
              </li>
            ))}
          </ul>
        </>
      )}
      {store.gates && (
        <>
          <p>{tr(M.gates)}</p>
          <ul data-vc-store-gates="">
            {store.gates.map((g) => (
              <li key={g.gate} data-gate={g.gate} data-gate-state={'clear' in g ? 'clear' : 'uses' in g ? 'uses' : 'unknown'} className={'clear' in g ? undefined : 'caution'}>
                <Icon name={'clear' in g ? 'check' : 'warning'} /> {'clear' in g ? tr(M.clear, { gate: tr(GATE_TEXT[g.gate].name) }) : 'uses' in g ? tr(M.uses, { gate: tr(GATE_TEXT[g.gate].name), what: g.uses.join('; ') }) : tr(M.unknown, { gate: tr(GATE_TEXT[g.gate].name), what: g.unknown })}
                {'uses' in g && g.autocrlf && <div className="hint" data-gate-hint="autocrlf">{tr(M.autocrlf, { command: 'git config core.autocrlf false' /* i18n-ignore: a command */ })}</div>}
              </li>
            ))}
          </ul>
          <p className="hint" data-vc-store-stock="">{tr(M.stock)}</p>
        </>
      )}
      {store.unsupported && store.unsupported.length > 0 && (
        <>
          <p>{tr(M.unsupported)}</p>
          <ul data-vc-store-unsupported="">
            {store.unsupported.map((g) => (
              <li key={g} data-gate={g}>
                {tr(M.limit, { gate: tr(GATE_TEXT[g].name), why: tr(GATE_TEXT[g].why) })}
              </li>
            ))}
          </ul>
          <p className="hint">{tr(M.toJj)}</p>
        </>
      )}
      {store.fallback && (
        <>
          {store.fallback.length > 0 && (
            <>
              <p className="caution">{tr(M.fallback)}</p>
              <ul data-vc-store-fallback="">
                {store.fallback.map((f, i) => (
                  <li key={i} data-fallback={f.code}>
                    {f.code === 'heads' ? tr(M.heads, { n: f.n }) : f.code === 'conflictedBookmark' ? tr(M.conflictedBookmark, { name: f.name }) : f.code === 'notExported' ? tr(M.notExported, { name: f.name }) : f.code === 'conflictedCommit' ? tr(M.conflictedCommit, { commit: f.commit.slice(0, 12) }) : tr(M.fallbackUnknown, { detail: f.detail })}
                  </li>
                ))}
              </ul>
            </>
          )}
          {store.detached && store.detached.length > 0 && (
            <ul data-vc-store-detached="">
              {store.detached.map((d) => (
                <li key={d.project} className="caution">
                  <Icon name="warning" /> {tr(M.detached, { project: d.project, head: d.head })}
                </li>
              ))}
            </ul>
          )}
          <p className="hint">{tr(M.toGit)}</p>
        </>
      )}
    </div>
  )
}
