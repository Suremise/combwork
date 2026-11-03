import { useEffect, useState } from 'react'
import type { Account, UsageMoveLimit, UsageMoveRule } from '@shared/types'
import { USAGE_MOVES } from '@shared/advanced'
import { msg, tr, tRich } from '@shared/i18n'
import { call, errorMessage } from '../api'
import { useAdvancedValue } from '../advanced'
import { notify } from '../store'

/**
 * An account's usage move (HI-2195), under it in Settings → Accounts & Connections: "When it reaches [98]% of its [weekly
 * limit], move its agents to [account]". Off by default; shown on a sign-in account with another of its CLI to move to,
 * or with a rule already. Each change is saved at once.
 */

const M = {
  rule: msg({ id: 'settings.accounts.usageMove.rule', defaultMessage: 'When it reaches {percent}% of {limit}, move its agents to {target}', description: "An account's usage move in Settings → Accounts & Connections (HI-2195), after a checkbox that turns it on. {percent} is a box for a number (98), {limit} a list (its weekly limit, its 5-hour limit, either limit), {target} a list of the CLI's other accounts. Keep all three; their order may change." }),
  weekly: msg({ id: 'settings.accounts.usageMove.weekly', defaultMessage: 'its weekly limit', description: 'An entry of the list in an account\'s usage move ("When it reaches 98% of its weekly limit…", HI-2195): its plan\'s weekly usage limit.' }),
  fiveHour: msg({ id: 'settings.accounts.usageMove.fiveHour', defaultMessage: 'its 5-hour limit', description: 'An entry of the list in an account\'s usage move ("When it reaches 98% of its 5-hour limit…", HI-2195): its plan\'s rolling 5-hour usage limit.' }),
  any: msg({ id: 'settings.accounts.usageMove.any', defaultMessage: 'either limit', description: 'An entry of the list in an account\'s usage move ("When it reaches 98% of either limit…", HI-2195): its weekly or its 5-hour limit, whichever gets there first.' }),
  turnOn: msg({ id: 'settings.accounts.usageMove.turnOn', defaultMessage: "Move this account's agents to another account at a usage threshold", description: "The checkbox's label for screen readers and its tooltip (Settings → Accounts & Connections, HI-2195): turns the account's usage move on or off." }),
  percentLabel: msg({ id: 'settings.accounts.usageMove.percentLabel', defaultMessage: 'Share of the limit', description: 'The label, for screen readers, of the number box in an account\'s usage move (HI-2195): at how many percent of its limit its agents move.' }),
  limitLabel: msg({ id: 'settings.accounts.usageMove.limitLabel', defaultMessage: 'Which limit', description: "The label, for screen readers, of the list of limits in an account's usage move (HI-2195)." }),
  targetLabel: msg({ id: 'settings.accounts.usageMove.targetLabel', defaultMessage: 'Account to move to', description: "The label, for screen readers, of the list of accounts in an account's usage move (HI-2195)." }),
  how: msg({ id: 'settings.accounts.usageMove.how', defaultMessage: "Each agent moves to the connection with the same name there, or its first one, once its turn is over, and resumes its conversation. The Assistant stays where it is (Settings → Assistant). Combwork moves them once per limit period and never back: move one back by choosing its connection.", description: "Under an account's usage move when it is on (Settings → Accounts & Connections, HI-2195): what happens." }),
  offInAdvanced: msg({ id: 'settings.accounts.usageMove.offInAdvanced', defaultMessage: 'Usage moves are turned off in Settings → Advanced: this one does nothing until they are on.', description: "Under an account's usage move (HI-2195) while Settings → Advanced → Move agents at a usage threshold is off. Settings → Advanced names a section." }),
  failed: msg({ id: 'settings.accounts.usageMove.failed', defaultMessage: "Couldn't change the usage move", description: "An error's title: saving an account's usage move failed (Settings → Accounts & Connections, HI-2195)." })
}

const DEFAULT_PERCENT = 98

export function UsageMoveRuleRow({ account, others }: { account: Pick<Account, 'id' | 'name' | 'usageMove'>; others: readonly Pick<Account, 'id' | 'name'>[] }) {
  const on = useAdvancedValue<boolean>(USAGE_MOVES) !== false
  const rule = account.usageMove
  const saved = rule?.percent ?? DEFAULT_PERCENT
  // The share as typed, saved when the box is left; the saved one again when it changes (another window, a refusal).
  const [draft, setDraft] = useState(String(saved))
  useEffect(() => setDraft(String(saved)), [saved])
  if (!rule && !others.length) return null
  const save = async (next: UsageMoveRule | null): Promise<void> => {
    try {
      await call('connections:setUsageMove', account.id, next)
    } catch (e) {
      notify('error', tr(M.failed), errorMessage(e))
    }
  }
  const shown: UsageMoveRule = rule ?? { percent: DEFAULT_PERCENT, limit: 'weekly', to: others[0]?.id ?? '' }
  const change = (patch: Partial<UsageMoveRule>): void => {
    if (rule) void save({ ...rule, ...patch })
  }
  const percent = (
    <input
      key="percent"
      className="input usage-move-percent"
      type="number"
      min={1}
      max={100}
      value={draft}
      disabled={!rule}
      aria-label={tr(M.percentLabel)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const n = Math.round(Number(draft))
        if (n >= 1 && n <= 100 && n !== shown.percent) change({ percent: n })
        else setDraft(String(shown.percent))
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
  const limit = (
    <select key="limit" className="select" value={shown.limit} disabled={!rule} aria-label={tr(M.limitLabel)} onChange={(e) => change({ limit: e.target.value as UsageMoveLimit })}>
      <option value="weekly">{tr(M.weekly)}</option>
      <option value="fiveHour">{tr(M.fiveHour)}</option>
      <option value="any">{tr(M.any)}</option>
    </select>
  )
  const target = (
    <select key="target" className="select" value={shown.to} disabled={!rule} aria-label={tr(M.targetLabel)} onChange={(e) => change({ to: e.target.value })}>
      {others.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  )
  return (
    <div className="usage-move" data-usage-move={rule ? 'on' : 'off'}>
      <div className="usage-move-line">
        <input type="checkbox" checked={!!rule} aria-label={tr(M.turnOn)} title={tr(M.turnOn)} disabled={!rule && !others.length} onChange={(e) => void save(e.target.checked ? shown : null)} />
        <span className={rule ? undefined : 'muted'}>{tRich(M.rule, { percent, limit, target })}</span>
      </div>
      {rule && <div className="hint usage-move-note">{tr(on ? M.how : M.offInAdvanced)}</div>}
    </div>
  )
}
