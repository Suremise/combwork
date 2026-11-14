import { AsyncLocalStorage } from 'node:async_hooks'
import { setDescriptorScope, type ProviderDescriptor } from '../shared/providers'
import type { ProviderId } from '../shared/types'

/**
 * A launch's own view of its CLI's descriptor (HI-3196): a CLI from a description takes its copy at the launch's start
 * (forLaunch), and what that launch's own steps read by id (its launch policy, modes, models) is that copy, whatever a
 * reload registers or removes meanwhile. Scoped to the launch's own async steps alone: every other reader (listings,
 * settings, another launch) reads the registry as it is now.
 */
const scope = new AsyncLocalStorage<Map<ProviderId, ProviderDescriptor>>()

setDescriptorScope((id) => scope.getStore()?.get(id))

/** Runs a launch's steps in a scope of their own, with its pinned descriptor if it has one already. */
export function inLaunchScope<T>(fn: () => T, pinned?: ProviderDescriptor): T {
  return scope.run(new Map(pinned ? [[pinned.id, pinned]] : []), fn)
}

/** The launch running now pins its CLI's descriptor (its copy): its own steps from here read that one by id. */
export function pinInLaunchScope(descriptor: ProviderDescriptor): void {
  scope.getStore()?.set(descriptor.id, descriptor)
}
