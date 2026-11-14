import { useState } from 'react'
import { shownText } from '@shared/advanced'
import { msg, tr } from '@shared/i18n'
import { providerModule } from '@shared/providers'
import { PROVIDER_GAP_TEXT, providerGaps } from '@shared/providers/gaps'
import type { ProviderId } from '@shared/types'
import { call, errorMessage } from '../api'
import { reloadClis } from '../clis'
import { notify, useStore } from '../store'
import { Icon } from './ui'

const M = {
  heading: msg({ id: 'clis.settings.heading', defaultMessage: 'Your own CLIs', description: 'Settings → Coding agents (HI-3196): the heading over the CLIs that run from a description (a JSON file each in Combwork’s clis folder).' }),
  what: msg({ id: 'clis.settings.what', defaultMessage: 'A CLI with no provider of its own runs from a description: a JSON file in the clis folder of your Combwork profile. Combwork reads its status from its screen, and never changes its own config.', description: 'Settings → Coding agents (HI-3196): what the CLIs that run from a description are. clis is a folder’s name: keep it.' }),
  none: msg({ id: 'clis.settings.none', defaultMessage: 'No descriptions yet.', description: 'Settings → Coding agents (HI-3196): the clis folder holds no descriptions.' }),
  reload: msg({ id: 'clis.settings.reload', defaultMessage: 'Reload', description: 'Button in Settings → Coding agents (HI-3196): reads the clis folder’s descriptions again.' }),
  open: msg({ id: 'clis.settings.open', defaultMessage: 'Open Folder', description: 'Button in Settings → Coding agents (HI-3196): opens the clis folder in Explorer.' }),
  reloaded: msg({ id: 'clis.settings.reloaded', defaultMessage: '{n, plural, =0 {No CLIs from descriptions} one {# CLI from a description} other {# CLIs from descriptions}}{problems, plural, =0 {} one {; # description not used} other {; # descriptions not used}}', description: 'A notice after Reload (HI-3196): how many CLIs run from descriptions now, and how many description files couldn’t be used.' }),
  notUsed: msg({ id: 'clis.settings.notUsed', defaultMessage: '{file} isn’t used:', description: 'Settings → Coding agents (HI-3196): before the reasons a description file was refused. {file} is its name.' }),
  lastGood: msg({ id: 'clis.settings.lastGood', defaultMessage: '{file} has a problem; its last good version stays in use until it is fixed:', description: 'Settings → Coding agents (HI-3196): a description file changed into one that can’t be used, while its earlier version is still used for this run. {file} is its name.' }),
  gapsLine: msg({ id: 'clis.gaps.line', defaultMessage: '{cli} runs from a description: {gaps}.', description: 'A note in Agent Settings (HI-3196) about an agent whose CLI runs from a description: what it lacks. {cli} is its name; {gaps} a list of what it lacks.' }),
  gapsHeading: msg({ id: 'clis.gaps.heading', defaultMessage: '{cli} runs from a description, so it has:', description: 'Provider Setup (HI-3196): the heading over the list of what a CLI that runs from a description lacks. {cli} is its name.' })
}

/** What a CLI that runs from a description lacks, in one line (Agent Settings' note); null for a full provider. */
export function gapsLine(provider: ProviderId): string | null {
  const gaps = providerGaps(provider)
  const m = providerModule(provider)
  if (!gaps.length || !m) return null
  return tr(M.gapsLine, { cli: m.descriptor.name, gaps: gaps.map((g) => tr(PROVIDER_GAP_TEXT[g])).join('; ') })
}

/** Provider Setup's list of what a CLI that runs from a description lacks (none for a full provider). */
export function ProviderGapsNote({ provider }: { provider: ProviderId }) {
  useStore((s) => s.clis?.generation)
  const gaps = providerGaps(provider)
  const m = providerModule(provider)
  if (!gaps.length || !m) return null
  return (
    <div className="setup-detail" data-provider-gaps={provider}>
      <p className="hint">{tr(M.gapsHeading, { cli: m.descriptor.name })}</p>
      <ul className="hint">
        {gaps.map((g) => (
          <li key={g} data-gap={g}>
            {tr(PROVIDER_GAP_TEXT[g])}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Settings → Coding agents: the clis folder, its Reload and Open Folder, and each description that isn't used, with why. */
export function ClisFolder() {
  const view = useStore((s) => s.clis)
  const [busy, setBusy] = useState(false)
  const reload = async (): Promise<void> => {
    setBusy(true)
    try {
      const v = await reloadClis()
      notify('success', tr(M.reloaded, { n: v.clis.length, problems: v.problems.filter((p) => !p.usingLastGood).length }))
    } catch (e) {
      notify('error', errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="clis-folder" data-clis-folder>
      <h4>{tr(M.heading)}</h4>
      <p className="hint">{tr(M.what)}</p>
      {view?.folder && <div className="faint small mono">{view.folder}</div>}
      {!view?.clis.length && !view?.problems.length && <p className="faint small">{tr(M.none)}</p>}
      {view?.problems.map((p) => (
        <div key={p.file} className="banner warn" data-cli-problem={p.file}>
          <Icon name="warning" />
          <div>
            <div>{tr(p.usingLastGood ? M.lastGood : M.notUsed, { file: p.file })}</div>
            <ul>
              {p.problems.map((t, i) => (
                <li key={i}>{shownText(t)}</li>
              ))}
            </ul>
          </div>
        </div>
      ))}
      <div className="row-actions">
        <button className="btn small" disabled={busy} data-action="clis-reload" onClick={() => void reload()}>
          <Icon name="refresh" /> {tr(M.reload)}
        </button>
        <button className="btn small subtle" data-action="clis-open" onClick={() => void call('clis:openFolder').catch((e) => notify('error', errorMessage(e)))}>
          <Icon name="folder-opened" /> {tr(M.open)}
        </button>
      </div>
    </div>
  )
}
