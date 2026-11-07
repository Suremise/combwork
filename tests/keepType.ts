// Tests that wrap, replace, spy on or mock what holds a WorkspaceService without losing its type (HI-2714). The
// WorkspaceService rule (tests/e2e/workspaceRule.mjs) pins a test where one goes into a slot that loses its type: bind's
// `thisArg: unknown` (`w.projectConfig.bind(w)`), a cast through unknown (`w as unknown as { … }`), vi.mock's untyped
// factory. Selection then keeps a pinned test for a change to any of the service's members. Here what holds one goes
// into a generic slot, which keeps its type, and each member is spelled where the test names it (`w.projectConfig`,
// `w['sessionsPlace']` for a private one, a literal key), so selection finds the test by that name. Name members by
// their literal names, never by a variable or a computed key.
import { vi, type MockInstance } from 'vitest'

type Method = (...a: never[]) => unknown
/** vi.mock's own factory type, ModuleMockFactoryWithHelper with no module: nothing of a WorkspaceService in it. */
type Untyped = (original: () => Promise<unknown>) => object | Promise<object>

/** The method, bound to its object: `bound(w, w.projectConfig)`, or `bound(w, w['sessionsPlace'])` for a private one. */
export function bound<S extends object, F extends Method>(self: S, fn: F): F {
  return fn.bind(self) as F
}

/**
 * vi.spyOn on a private method, which keyof (and so vi.spyOn's own type) leaves out: typed by the method, given beside
 * its name (`spyOnPrivate(usageHistory, 'transport', usageHistory['transport'])`). mockRestore() puts it back.
 */
export function spyOnPrivate<S extends object, F extends Method>(self: S, key: string, method: F): MockInstance<F> {
  if ((self as unknown as Record<string, unknown>)[key] !== method) throw new Error(`${key} isn't the method given beside it`)
  return (vi.spyOn as unknown as (o: object, k: string) => MockInstance<F>)(self, key)
}

/**
 * A vi.mock factory typed by the module it mocks (vi.mock's own slot for one is untyped):
 * `vi.mock('../src/main/tasks', mockFactory<typeof import('../src/main/tasks')>(async (original) => ({ ...(await original()), … })))`.
 * vi.mock is hoisted above the file's imports, so a test takes this one through vi.hoisted:
 * `const { mockFactory } = await vi.hoisted(() => import('./keepType'))`. (`vi.mock(import('…'), …)` would type it too,
 * but relatedTests.mjs reads that import() as a loader it can't follow, which keeps the test for every change.)
 */
export function mockFactory<T>(factory: (original: () => Promise<T>) => Partial<T> | Promise<Partial<T>>): Untyped {
  return factory as Untyped
}
