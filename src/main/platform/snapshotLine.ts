/**
 * One file's line in a check's stat snapshot (`checks.ts`'s `snapshot`, and a None check's point in its worker,
 * HI-2358): its path, size and modified time, or that it is gone. One function, so a snapshot taken on main's thread and
 * one taken in the worker compare exactly. No imports: the worker loads it.
 */
export const snapshotLine = (file: string, st: { size: number; mtimeMs: number } | null): string => (st ? `${file}:${st.size}:${st.mtimeMs}` : `${file}:gone`)
