// HI-3378: the types of tests/timing.cjs, for the unit tests and vitest.config.ts.
export type TimingKind = 'hang' | 'budget' | 'quiet' | 'pace' | 'interval' | 'seam' | 'lock'
export interface Timing {
  kind: TimingKind
  ms: number
  note: string
}
/** A timing's value in ms, by name (tests/timing.json); an unknown name throws. */
export function timing(name: string): number
/** Every timing in force, by name. */
export function timings(): Record<string, Timing>
/** The values in force for an environment: the defaults, CW_TEST_TIMING's values over them, the hang values scaled. */
export function resolve(env?: Record<string, string | undefined>, defaults?: Record<string, Timing>): Record<string, Timing>
/** tests/timing.json's entries, checked. */
export function readDefaults(file?: string): Record<string, Timing>
export const KINDS: readonly TimingKind[]
/** The most a Node timer takes (2^31 - 1 ms): every value in force is from 1 to this. */
export const MAX_MS: number
