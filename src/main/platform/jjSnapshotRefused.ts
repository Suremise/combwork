// jj's size limit for new files (HI-2973): a snapshot leaves out a new file past `snapshot.max-new-file-size` (1 MiB by
// default) and says so only as a warning on stderr, exiting 0. jj repeats the warning on every snapshot while the file
// is there (even "No snapshot needed"), so the warning of the snapshot Combwork just took is the whole answer: no state
// to keep. Such a file is on disk and in no commit, so whatever Combwork reads as "recorded" or "clean" must see it.
//
// The pinned jj (0.47.1) prints, after `Warning: Refused to snapshot some files:`, one indented line per file:
//   `  big.bin: 2.0MiB (2100000 bytes); the maximum size allowed is 1.0MiB (1048576 bytes)`
// with the path as jj shows paths (backslashes on Windows). An indented line of another shape still names a file left
// out: its text up to the last `: ` is taken as the path, so an unknown reason never reads as clean.

/** The files a snapshot left out, as jj named them, and the limit it gave (bytes), when it gave one. */
export interface SnapshotRefused {
  files: string[]
  max: number | null
}

const HEADER = /Refused to snapshot some files:\s*$/
const SIZED = /^\s+(.+): [\d.]+\s*[A-Za-z]*B \(\d+ bytes\); the maximum size allowed is [\d.]+\s*[A-Za-z]*B \((\d+) bytes\)\s*$/

/** The files jj's snapshot left out, from its stderr; null when it left none out. */
export function snapshotRefused(err: string): SnapshotRefused | null {
  const lines = err.split(/\r?\n/)
  const at = lines.findIndex((l) => HEADER.test(l))
  if (at < 0) return null
  const files: string[] = []
  let max: number | null = null
  for (const l of lines.slice(at + 1)) {
    if (!/^\s+\S/.test(l)) break
    const m = SIZED.exec(l)
    if (m) {
      files.push(m[1])
      max = Number(m[2])
      continue
    }
    const t = l.trim()
    const i = t.lastIndexOf(': ')
    files.push(i > 0 ? t.slice(0, i) : t)
  }
  return { files, max }
}

/** A refusal's detail: the files (at most ten named) and the setting, in English as jj's own messages are. */
export function refusedDetail(r: SnapshotRefused): string {
  const named = r.files.slice(0, 10).join(', ') + (r.files.length > 10 ? ` (+${r.files.length - 10})` : '') // i18n-ignore: a protocol detail, in English as jj's are
  return `jj left new files out of its snapshot (snapshot.max-new-file-size${r.max !== null ? ` ${r.max}` : ''}): ${named || 'unnamed'}` // i18n-ignore: a protocol detail, in English as jj's are
}
