// The sides of a switch between platforms on one repository's store (HI-3140; HI-2799's Git to jj switch, s11): what a
// platform checks when a project's store comes to it, and when it leaves it for one that has no checks of its own (back
// to Git). workflow/storeSwitch.ts runs the switch itself (its fence, drain, write and settle) and asks these, never the
// platform's id. A platform sharing no store with another has no side.

import type { Detection, Gate, PlatformId } from '../../shared/platform/descriptors'
import type { FallbackProblem, GateCheck, SwitchRefusal } from '../../shared/platform/switching'
import { jjStoreSide } from './jjStoreSide'

/** A project switching with the store: its folder and name. */
export interface StoreMember {
  path: string
  name: string
}

export interface StoreSide {
  /** The refusal when the project's folder has no store this platform can use. */
  noStore: Extract<SwitchRefusal['why'], 'noJj' | 'noGit'>
  /** The store a folder this platform detected names, when it reads it its own way; null: as Git's (its common git dir). */
  storeRead?(d: Detection): Promise<string | 'none' | 'unknown' | null>
  /** Coming to this platform: its refusals (in order), its gates and the gates it refuses whatever the repository. */
  arrive?: {
    /** The project's slots folder (null without a workspace folder) inside a working tree its commands would reach. */
    slotsInGit(path: string, slots: string | null): SwitchRefusal | null
    /** A member other than `path` whose folder this platform couldn't use. */
    membersWithout(path: string, members: readonly StoreMember[]): SwitchRefusal | null
    /** The platform's own confirmation of the repository on exactly this store. */
    ready(path: string, store: string): Promise<SwitchRefusal | null>
    gates(path: string, store: string): Promise<GateCheck[]>
    unsupported: readonly Gate[]
  }
  /** Leaving this platform for one with no `arrive`: the repository's state it must have settled first. */
  leave?: {
    /** The folder whose repository is checked. */
    sideOf(path: string, members: readonly StoreMember[]): Promise<string>
    fallback(path: string): Promise<FallbackProblem[]>
    /** The platform's tool's readiness, for a refusal whose problem is its tool. */
    toolState(): string
  }
}

/** Each platform's side; Git's has no checks of its own (its store is the one every side shares). */
export const STORE_SIDES: Partial<Record<PlatformId, StoreSide>> = { git: { noStore: 'noGit' }, jj: jjStoreSide }

/** The refusal for a folder with no store `to` can use (Git's for a platform with no side). */
export const noStoreFor = (to: PlatformId): StoreSide['noStore'] => STORE_SIDES[to]?.noStore ?? 'noGit'

/** The sides checked when a store leaves them for one with no `arrive`: every side with a `leave`. */
export const leavingSides = (): StoreSide[] => Object.values(STORE_SIDES).filter((s): s is StoreSide => !!s?.leave)
