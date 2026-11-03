// Electron refuses to start from a folder whose permissions name an AppContainer package but not ALL APPLICATION
// PACKAGES (#431): reading those permissions (SDDL from icacls /save), what Hive does about them at start, with
// stand-ins for Windows' tools, and the command it gives the user.
import { dirname, join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cantStartMessage, checkInstallDir, daclSids, grantCommand, installDirTarget, lacksAllAppPackages, tellCantStart, type InstallDirTools, type MessageTools } from '../src/main/installDir'

const USER = 'S-1-5-21-586760565-1193673989-400077746-1001'
const PACKAGE = 'S-1-15-2-1430448594-2639229838-973813799-439329657-1197984847-4069167804-1277922394'
const BROKEN = `D:PAI(A;OICI;0x1200a9;;;${PACKAGE})(A;OICI;FA;;;SY)(A;OICI;FA;;;${USER})`
const FIXED = `D:PAI(A;OICI;0x1200a9;;;AC)(A;OICI;0x1200a9;;;${PACKAGE})(A;OICI;FA;;;SY)(A;OICI;FA;;;${USER})`
const USUAL = `D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${USER})`
const DIR = 'C:\\Users\\me\\AppData\\Local\\Programs\\Hive'
const ICU = join(DIR, 'icudtl.dat')
const FOLDER = `grant ${DIR} *S-1-15-2-1:(OI)(CI)(RX)`

/** Stand-ins for icacls and the rest: reads answer in turn (the last one repeats), and every call is noted. */
function tools(reads: (string | null)[], opts: { grant?: number | null; files?: string[] } = {}): InstallDirTools & { calls: string[] } {
  const calls: string[] = []
  let n = 0
  return {
    calls,
    read: (p) => {
      calls.push(`read ${p}`)
      return reads[Math.min(n++, reads.length - 1)]
    },
    exists: (p) => (opts.files ?? []).includes(p),
    grant: (p, entry) => {
      calls.push(`grant ${p} ${entry}`)
      return opts.grant === undefined ? 0 : opts.grant
    },
    tell: (d, f) => calls.push(`tell ${d}${f ? ` about ${f}` : ''}`),
    exit: (code) => calls.push(`exit ${code}`)
  }
}

describe('install folder permissions', () => {
  it('lists the SIDs of the DACL entries only', () => {
    expect(daclSids(`O:${USER}G:${USER}D:PAI(A;OICI;0x1200a9;;;${PACKAGE})(A;OICI;FA;;;SY)(A;OICI;FA;;;${USER})S:AI(ML;;NW;;;LW)`)).toEqual([PACKAGE, 'SY', USER])
    expect(daclSids('D:(A;;FA;;;BA)')).toEqual(['BA'])
    expect(daclSids('O:BA')).toEqual([])
    // A conditional entry's condition has brackets of its own.
    expect(daclSids('D:(XA;OICI;FX;;;WD;(@User.Title == "PM" && (@User.Division == "Finance")))(A;;FA;;;ac)')).toEqual(['WD', 'AC'])
  })

  it('finds a package entry without ALL APPLICATION PACKAGES', () => {
    expect(lacksAllAppPackages(BROKEN)).toBe(true)
    // With ALL APPLICATION PACKAGES, by alias or SID, Electron's sandbox can read it.
    expect(lacksAllAppPackages(FIXED)).toBe(false)
    expect(lacksAllAppPackages(`D:(A;OICI;0x1200a9;;;${PACKAGE})(A;OICI;0x1200a9;;;S-1-15-2-1)`)).toBe(false)
    // No package entry: the usual per-user folder, inherited from the profile.
    expect(lacksAllAppPackages(USUAL)).toBe(false)
    // ALL RESTRICTED APPLICATION PACKAGES and capability SIDs aren't packages.
    expect(lacksAllAppPackages('D:(A;OICI;0x1200a9;;;S-1-15-2-2)(A;OICI;FA;;;SY)')).toBe(false)
    expect(lacksAllAppPackages('D:(A;OICI;0x1200a9;;;S-1-15-3-1024-1065365936-1281604716-3511738428-1654721687-432734479-3232135806-4053264122-3456934681)')).toBe(false)
    expect(lacksAllAppPackages('')).toBe(false)
  })

  it('gives a PowerShell command, each argument a literal', () => {
    expect(grantCommand(DIR)).toBe(`icacls '${DIR}' /grant '*S-1-15-2-1:(OI)(CI)(RX)'`)
    // Nothing in a path is expanded ($, %, backticks) and its quotes, PowerShell's typographic ones too, are doubled.
    const curly = String.fromCharCode(0x2019)
    expect(grantCommand(`C:\\Apps\\O'Brien $HOME %TEMP% \`x ${curly}y`)).toBe(`icacls 'C:\\Apps\\O''Brien $HOME %TEMP% \`x ${curly}${curly}y' /grant '*S-1-15-2-1:(OI)(CI)(RX)'`)
    // With the file Electron checks: the folder, then the file, which needs an entry of its own if it doesn't inherit.
    expect(grantCommand(DIR, ICU)).toBe(`icacls '${DIR}' /grant '*S-1-15-2-1:(OI)(CI)(RX)'; icacls '${ICU}' /grant '*S-1-15-2-1:(RX)'`)
  })

  it('names what still lacks the entry', () => {
    const folder = cantStartMessage(DIR)
    expect(folder.text).toContain(`the folder Combwork is installed in:\n${DIR}\n`)
    expect(folder.command).toBe(grantCommand(DIR))
    const file = cantStartMessage(DIR, ICU)
    expect(file.text).toContain(`a file in the folder Combwork is installed in:\n${ICU}\n`)
    expect(file.command).toBe(grantCommand(DIR, ICU))
  })
})

describe('at start', () => {
  it('leaves a folder alone when its permissions are fine or unreadable', () => {
    for (const read of [USUAL, FIXED, null]) {
      const t = tools([read])
      checkInstallDir({ dir: DIR, mayChange: true }, t)
      expect(t.calls).toEqual([`read ${DIR}`])
    }
  })

  it('checks the file Electron checks, when it is there', () => {
    const t = tools([BROKEN, FIXED], { files: [ICU] })
    checkInstallDir({ dir: DIR, mayChange: true }, t)
    expect(t.calls).toEqual([`read ${ICU}`, FOLDER, `read ${ICU}`])
  })

  it("gives that file the entry of its own when it doesn't inherit it from the folder", () => {
    const t = tools([BROKEN, BROKEN, FIXED], { files: [ICU] })
    checkInstallDir({ dir: DIR, mayChange: true }, t)
    expect(t.calls).toEqual([`read ${ICU}`, FOLDER, `read ${ICU}`, `grant ${ICU} *S-1-15-2-1:(RX)`, `read ${ICU}`])
  })

  it("names that file to the user when it still lacks the entry, and stops", () => {
    for (const reads of [[BROKEN], [BROKEN, BROKEN, null]]) {
      const t = tools(reads, { files: [ICU], grant: 5 })
      checkInstallDir({ dir: DIR, mayChange: true }, t)
      expect(t.calls).toEqual([`read ${ICU}`, FOLDER, `read ${ICU}`, `grant ${ICU} *S-1-15-2-1:(RX)`, `read ${ICU}`, `tell ${DIR} about ${ICU}`, 'exit 1'])
    }
  })

  it('adds the entry, and goes on once it is there', () => {
    const t = tools([BROKEN, FIXED])
    checkInstallDir({ dir: DIR, mayChange: true }, t)
    expect(t.calls).toEqual([`read ${DIR}`, FOLDER, `read ${DIR}`])
  })

  it("tells the user and stops when it couldn't add it", () => {
    const t = tools([BROKEN], { grant: 5 })
    checkInstallDir({ dir: DIR, mayChange: true }, t)
    expect(t.calls).toEqual([`read ${DIR}`, FOLDER, `read ${DIR}`, `tell ${DIR}`, 'exit 1'])
  })

  it("tells the user and stops when it can't confirm it added it", () => {
    for (const grant of [5, null, 0]) {
      const t = tools([BROKEN, null], { grant })
      checkInstallDir({ dir: DIR, mayChange: true }, t)
      expect(t.calls).toEqual([`read ${DIR}`, FOLDER, `read ${DIR}`, `tell ${DIR}`, 'exit 1'])
    }
  })

  it("never changes a folder it mayn't: tells the user and stops", () => {
    const t = tools([BROKEN, FIXED])
    checkInstallDir({ dir: DIR, mayChange: false }, t)
    expect(t.calls).toEqual([`read ${DIR}`, `tell ${DIR}`, 'exit 1'])
    const u = tools([BROKEN, FIXED], { files: [ICU] })
    checkInstallDir({ dir: DIR, mayChange: false }, u)
    expect(u.calls).toEqual([`read ${ICU}`, `tell ${DIR} about ${ICU}`, 'exit 1'])
  })
})

describe('which folder', () => {
  afterEach(() => vi.unstubAllEnvs())

  it("a development or test copy checks node_modules' Electron and never changes it", () => {
    vi.stubEnv('HIVE_TEST_INSTALL_DIR', '')
    expect(installDirTarget()).toEqual({ dir: dirname(process.execPath), mayChange: false })
  })

  it('a test folder of its own may be changed', () => {
    vi.stubEnv('HIVE_TEST_INSTALL_DIR', 'C:\\test\\folder')
    expect(installDirTarget()).toEqual({ dir: 'C:\\test\\folder', mayChange: true })
  })
})

describe("telling the user Hive can't start", () => {
  afterEach(() => vi.unstubAllEnvs())

  function ui(quiet: boolean, shows: boolean): MessageTools & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      quiet,
      window: (m, snapshot) => {
        calls.push(`window ${m.title}${snapshot ? ` to ${snapshot}` : ''}`)
        return shows
      },
      errorBox: (title, content) => calls.push(`errorBox ${title}: ${content}`),
      record: (title) => calls.push(`record ${title}`)
    }
  }

  it('shows the window with Copy Command', () => {
    const t = ui(false, true)
    tellCantStart(DIR, undefined, t)
    expect(t.calls).toEqual(["record Combwork can't start", "window Combwork can't start"])
  })

  it("falls back to Electron's error box, with the command, when the window can't be shown", () => {
    const t = ui(false, false)
    tellCantStart(DIR, undefined, t)
    expect(t.calls.slice(0, 2)).toEqual(["record Combwork can't start", "window Combwork can't start"])
    expect(t.calls[2]).toContain("errorBox Combwork can't start: ")
    expect(t.calls[2]).toContain(cantStartMessage(DIR).command)
    expect(t.calls[2]).toContain(DIR)
  })

  it('a quiet test copy shows nothing: it records it, and draws the window only to a picture asked for', () => {
    vi.stubEnv('HIVE_TEST_DIALOG_SNAPSHOT', '')
    const t = ui(true, false)
    tellCantStart(DIR, undefined, t)
    expect(t.calls).toEqual(["record Combwork can't start"])
    vi.stubEnv('HIVE_TEST_DIALOG_SNAPSHOT', 'C:\\shot.png')
    const u = ui(true, false)
    tellCantStart(DIR, undefined, u)
    expect(u.calls).toEqual(["record Combwork can't start", "window Combwork can't start to C:\\shot.png"])
  })
})
