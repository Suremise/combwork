// Why Combwork stopped (#985): the profile's crash dumps are listed newest first and named in Copy Diagnostics, and every
// place Combwork's main process ends or restarts the app goes through exitBy(), which logs it with its caller.
import { readdirSync, readFileSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { crashDumpLines, crashDumps, pruneCrashDumps } from '../src/main/exitLog'
import { tempDir } from './tempDir'

describe('crash dumps (#985)', () => {
  it('lists the .dmp files newest first, and none for a folder that is missing', () => {
    const dir = tempDir('dumps-')
    const at = (name: string, when: number, bytes = 10): void => {
      writeFileSync(join(dir, name), Buffer.alloc(bytes))
      utimesSync(join(dir, name), when / 1000, when / 1000)
    }
    at('old.dmp', Date.UTC(2026, 9, 1))
    at('new.DMP', Date.UTC(2026, 9, 17, 3, 2, 56), 4096)
    at('settings.dat', Date.UTC(2026, 9, 18))
    expect(crashDumps(dir).map((d) => d.file)).toEqual([join(dir, 'new.DMP'), join(dir, 'old.dmp')])
    expect(crashDumps(join(dir, 'missing'))).toEqual([])
  })

  it('keeps the newest three dumps and removes the rest, nothing else (#1111)', () => {
    const dir = tempDir('dumps-')
    for (let i = 1; i <= 5; i++) {
      writeFileSync(join(dir, `d${i}.dmp`), Buffer.alloc(1024 * 1024))
      utimesSync(join(dir, `d${i}.dmp`), Date.UTC(2026, 9, i) / 1000, Date.UTC(2026, 9, i) / 1000)
    }
    writeFileSync(join(dir, 'settings.dat'), '')
    const { kept, removed, bytes } = pruneCrashDumps(crashDumps(dir))
    expect(kept.map((d) => d.file)).toEqual([join(dir, 'd5.dmp'), join(dir, 'd4.dmp'), join(dir, 'd3.dmp')])
    expect({ removed, bytes }).toEqual({ removed: 2, bytes: 2 * 1024 * 1024 })
    expect(readdirSync(dir).sort()).toEqual(['d3.dmp', 'd4.dmp', 'd5.dmp', 'settings.dat'])
    // Three or fewer: nothing goes.
    expect(pruneCrashDumps(crashDumps(dir)).removed).toBe(0)
  })

  it("Copy Diagnostics names the newest and how many, and says they're never sent", () => {
    const dir = tempDir('dumps-')
    expect(crashDumpLines([], dir)).toEqual(['None.'])
    const lines = crashDumpLines([{ file: join(dir, 'a.dmp'), at: Date.UTC(2026, 9, 17, 3, 2, 56), bytes: 2048 }, { file: join(dir, 'b.dmp'), at: 0, bytes: 1 }], dir)
    expect(lines[0]).toBe(`- 2 in \`${dir}\`; the newest from 2026-10-17T03:02:56.000Z: \`a.dmp\` (2 KB)`)
    expect(lines[1]).toMatch(/never sends them/)
  })
})

describe('every way out is logged (#985)', () => {
  // The main process's own files; the combwork MCP server, cw-progress, a close command's runner (HI-1368: its own
  // build entry, started detached as Node) and cw-sign (HI-2867: git's signer in agents' sessions) are processes of their own.
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name)
      if (e.isDirectory()) return e.name === 'mcp' || e.name === 'progressReporters' ? [] : files(p)
      return e.name.endsWith('.ts') && e.name !== 'cw-close-runner.ts' && e.name !== 'cw-sign.ts' ? [p] : []
    })

  it('ends or restarts the app only inside exitBy()', () => {
    const raw = /\b(app\.quit|app\.exit|process\.exit|app\.relaunch|\.quitAndInstall)\(/
    const outside: string[] = []
    for (const f of files(join(__dirname, '..', 'src', 'main'))) {
      if (f.endsWith('exitLog.ts')) continue
      const lines = readFileSync(f, 'utf8').split(/\r?\n/)
      lines.forEach((line, i) => {
        if (!raw.test(line) || line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return
        // The call, or its block's first line, is exitBy's.
        const from = lines.slice(Math.max(0, i - 2), i + 1).join('\n')
        if (!/exitBy\('[\w.]+', /.test(from)) outside.push(`${f}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(outside).toEqual([])
  })
})
