import { msg, tr } from '@shared/i18n'
import type { LaunchedSignInHost } from '@shared/types'

/** Where a session signed in (HI-2779), as its launch recorded it: said only off github.com. */
const SIGNED_IN_HOST = msg({ id: 'panes.footer.signInHost', defaultMessage: 'Signed in on {host}{repo, select, same {} other {, repositories on {repoHost}}}{account, select, none {} other { as {account}}}.', description: "Where a session signed in (HI-2779), in the hover of a pane footer's model and over a session in the Sessions tab: the GitHub host ({host}: yourcompany.ghe.com), the repositories' host when it differs ({repo}: same or other; {repoHost}), and the account when known ({account}; none: leave that branch empty)." })

/** The line of a session's sign-in host, or '' on plain github.com (nothing worth saying) or none recorded. */
export function signInHostLine(h: LaunchedSignInHost | undefined): string {
  if (!h || (h.host === 'github.com' && h.repoHost === 'github.com')) return ''
  return tr(SIGNED_IN_HOST, { host: h.host, repo: h.repoHost === h.host ? 'same' : 'other', repoHost: h.repoHost, account: h.account || 'none' })
}
