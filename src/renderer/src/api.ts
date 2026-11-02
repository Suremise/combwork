import type { HiveChannel, HiveRequests } from '@shared/api'
import { coalesced } from '@shared/coalesce'

/** Calls the main process and unwraps Electron's "Error invoking remote method" prefix from errors. */
export async function call<C extends HiveChannel>(channel: C, ...args: Parameters<HiveRequests[C]>): Promise<Awaited<ReturnType<HiveRequests[C]>>> {
  try {
    return (await window.hive.invoke(channel, ...args)) as Awaited<ReturnType<HiveRequests[C]>>
  } catch (e) {
    const msg = (e as Error).message ?? String(e)
    throw new Error(msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), { cause: e })
  }
}

const shared = coalesced<unknown>()

/**
 * A read several parts of the window repeat as things change (`queue:list`, #1629): one call in flight per channel and
 * arguments, and those asked meanwhile share one more call made after it (coalesced).
 */
export function callShared<C extends HiveChannel>(channel: C, ...args: Parameters<HiveRequests[C]>): Promise<Awaited<ReturnType<HiveRequests[C]>>> {
  return shared(JSON.stringify([channel, ...args]), () => call(channel, ...args)) as Promise<Awaited<ReturnType<HiveRequests[C]>>>
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
