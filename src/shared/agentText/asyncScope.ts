/**
 * Agent text's scopes in the main process (dialects, HI-2065): kept in AsyncLocalStorage, as `inWorkspace` keeps the
 * workspace, so a scope opened for a request or a wake holds through its awaits. Importing this installs it; main's
 * code that opens scopes imports them from here. Node only: never imported by the window.
 */
import { AsyncLocalStorage } from 'async_hooks'
import { inDialectScope, setScopeStore, type DialectScope, type DialectSession } from './index'

export { inDialectOf, inDefaultDialect } from './index'

const scopes = new AsyncLocalStorage<DialectScope>()
setScopeStore({ current: () => scopes.getStore(), run: (scope, fn) => scopes.run(scope, fn) })

/**
 * Runs an Agent API request in its caller's dialect: a project agent's or the Assistant's session (its chain, pinned at
 * its launch), or for a caller with no session (null: a script, a viewer) the API chain.
 */
export const inRequestScope = <T>(session: DialectSession | null, fn: () => T): T => inDialectScope(session ? { kind: 'session', session: { projectPath: session.projectPath, agentId: session.agentId } } : { kind: 'api' }, fn)
