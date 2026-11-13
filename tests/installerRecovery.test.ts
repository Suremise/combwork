// An interrupted update's recovery (HI-3172, build/recovery.ps1 and installer.nsh's cwArmRecovery): the copy is staged
// and checked beside an earlier recovery without touching it, anything unexpected in the recovery folder refuses, and a
// per-machine folder is trusted only by its owner and ACL. The installer's own order (lock, stage, swap, Run value, and
// a refusal that never deletes an armed recovery) is checked in its text: the installer itself runs only in Windows
// Sandbox (the card's checks). Against temp folders only; nothing real is read or changed.
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { beforeAll, describe, expect, it } from 'vitest'
import { powershellEnv } from './powershellEnv'
import { tempDir } from './tempDir'

const HUNG_MS = 60_000
const SCRIPT = join(__dirname, '..', 'build', 'recovery.ps1')
const NSH = join(__dirname, '..', 'build', 'installer.nsh')
const root = process.env.SystemRoot ?? 'C:\\Windows'
const ps = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const psEnv = powershellEnv()

function recovery(args: string[]): { code: number | null; out: string } {
  const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args], { env: psEnv, windowsHide: true, timeout: HUNG_MS, encoding: 'utf8' })
  return { code: r.status, out: r.stdout.trim() }
}
const trust = (sddl: string): string => recovery(['-CheckSddl', sddl]).out

let dir = ''
/** A case's folders: the installer (`src`), the recovery folder (not made), and somewhere else. */
function fixture(name: string): { src: string; rec: string; other: string } {
  const d = join(dir, name)
  mkdirSync(join(d, 'other'), { recursive: true })
  const src = join(d, 'Setup 1.5.0.exe')
  writeFileSync(src, `new installer ${name}`)
  return { src, rec: join(d, 'combwork-resume'), other: join(d, 'other') }
}
const junction = (link: string, target: string): void => {
  const r = spawnSync(join(root, 'System32', 'cmd.exe'), ['/c', 'mklink', '/J', link, target], { windowsHide: true, encoding: 'utf8' })
  expect(r.status, r.stdout + r.stderr).toBe(0)
}

describe('the recovery copy (recovery.ps1, HI-3172)', () => {
  beforeAll(() => {
    dir = tempDir('cw-installer-recovery-')
  })

  it('stages a checked copy beside an earlier recovery, which it leaves as it is', () => {
    const f = fixture('stage')
    mkdirSync(f.rec)
    writeFileSync(join(f.rec, 'Combwork-Setup.exe'), 'earlier recovery')
    writeFileSync(join(f.rec, 'Combwork-Setup.new.exe'), 'stale')
    const r = recovery(['-Scope', 'user', '-Dir', f.rec, '-Source', f.src])
    expect(r, r.out).toEqual({ code: 0, out: 'staged' })
    expect(readFileSync(join(f.rec, 'Combwork-Setup.new.exe'), 'utf8')).toBe('new installer stage')
    expect(readFileSync(join(f.rec, 'Combwork-Setup.exe'), 'utf8')).toBe('earlier recovery')
  })

  it('makes a missing folder (per-user)', () => {
    const f = fixture('fresh')
    expect(recovery(['-Scope', 'user', '-Dir', f.rec, '-Source', f.src])).toEqual({ code: 0, out: 'staged' })
    expect(readdirSync(f.rec)).toEqual(['Combwork-Setup.new.exe'])
  })

  it('a resumed run (the recovery copy itself) stages nothing', () => {
    const f = fixture('self')
    mkdirSync(f.rec)
    const self = join(f.rec, 'Combwork-Setup.exe')
    writeFileSync(self, 'recovery')
    expect(recovery(['-Scope', 'user', '-Dir', f.rec, '-Source', self.toUpperCase()])).toEqual({ code: 0, out: 'self' })
    expect(readdirSync(f.rec)).toEqual(['Combwork-Setup.exe'])
  })

  it('refuses an unexpected entry, keeping the earlier recovery and staging nothing', () => {
    const f = fixture('unexpected')
    mkdirSync(f.rec)
    writeFileSync(join(f.rec, 'Combwork-Setup.exe'), 'earlier recovery')
    writeFileSync(join(f.rec, 'other.dll'), 'x')
    const r = recovery(['-Scope', 'user', '-Dir', f.rec, '-Source', f.src])
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^refused: unexpected .*other\.dll$/)
    expect(readdirSync(f.rec).sort()).toEqual(['Combwork-Setup.exe', 'other.dll'])
    expect(readFileSync(join(f.rec, 'Combwork-Setup.exe'), 'utf8')).toBe('earlier recovery')
  })

  it('refuses a junction inside the folder, its target untouched', () => {
    const f = fixture('child-junction')
    mkdirSync(f.rec)
    writeFileSync(join(f.other, 'canary.txt'), 'canary')
    junction(join(f.rec, 'Combwork-Setup.new.exe'), f.other)
    const r = recovery(['-Scope', 'user', '-Dir', f.rec, '-Source', f.src])
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/is a link$/)
    expect(readdirSync(f.other)).toEqual(['canary.txt'])
    expect(readFileSync(join(f.other, 'canary.txt'), 'utf8')).toBe('canary')
  })

  it('refuses a recovery folder that is a junction', () => {
    const f = fixture('folder-junction')
    junction(f.rec, f.other)
    const r = recovery(['-Scope', 'user', '-Dir', f.rec, '-Source', f.src])
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/is a link$/)
    expect(readdirSync(f.other)).toEqual([])
  })

  it("an installer that can't be copied refuses, leaving no partial copy and the earlier recovery", () => {
    const f = fixture('no-source')
    mkdirSync(f.rec)
    writeFileSync(join(f.rec, 'Combwork-Setup.exe'), 'earlier recovery')
    const r = recovery(['-Scope', 'user', '-Dir', f.rec, '-Source', join(f.other, 'missing.exe')])
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^refused: couldn't copy the installer/)
    expect(existsSync(join(f.rec, 'Combwork-Setup.new.exe'))).toBe(false)
    expect(readFileSync(join(f.rec, 'Combwork-Setup.exe'), 'utf8')).toBe('earlier recovery')
  })

  it('trusts a descriptor only Administrators, SYSTEM and TrustedInstaller can change', () => {
    // The ACL recovery.ps1 gives a folder it makes.
    expect(trust('O:BAG:SYD:PAI(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;0x1200a9;;;BU)')).toBe('trusted')
    expect(trust('O:SYD:(A;;FA;;;SY)(A;;FA;;;BA)(D;;FA;;;BU)')).toBe('trusted')
    // Another owner (a standard user who made the folder first).
    expect(trust('O:S-1-5-21-1-2-3-1001G:SYD:PAI(A;OICI;FA;;;BA)')).toBe('untrusted')
    // Users may modify it; may write to a file of it (an admin-owned file with a loose DACL); may change its ACL.
    expect(trust('O:BAD:PAI(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;BU)')).toBe('untrusted')
    expect(trust('O:BAD:(A;;FA;;;BA)(A;;0x2;;;BU)')).toBe('untrusted')
    expect(trust('O:BAD:(A;;FA;;;BA)(A;;WD;;;BU)')).toBe('untrusted')
    // An inherit-only entry counts too: whoever creates a file inside would own it.
    expect(trust('O:BAD:(A;;FA;;;BA)(A;OICIIO;FA;;;CO)')).toBe('untrusted')
    // No DACL at all: everyone has everything.
    expect(trust('O:BAG:SYD:NO_ACCESS_CONTROL')).toBe('untrusted')
  })
})

describe("the installer's recovery order (installer.nsh, HI-3172)", () => {
  const nsh = readFileSync(NSH, 'utf8')
  const fn = (name: string): string => {
    const m = new RegExp(`\\nFunction ${name}\\r?\\n([\\s\\S]*?)\\nFunctionEnd`).exec(nsh)
    expect(m, name).toBeTruthy()
    return m![1]
  }

  it('arms under its lock: the lock, then the staged copy, the swap and the Run value, read back', () => {
    const arm = fn('cwArmRecovery')
    // The last of each: the Run value is also read early, to see whether a recovery is armed already.
    const at = (s: string): number => {
      const i = arm.lastIndexOf(s)
      expect(i, s).toBeGreaterThan(-1)
      return i
    }
    expect(arm).toContain('"Global\\CombworkRecovery-${APP_GUID}-machine"')
    expect(arm).toContain('"Global\\CombworkRecovery-${APP_GUID}-$R1"')
    const order = [at('${If} $1 > 259'), at('CreateMutexW'), at('WaitForSingleObject'), at('recovery.ps1'), at('MoveFileExW'), at('WriteRegStr HKLM'), at('ReadRegStr $1 HKLM'), at('StrCpy $cwRecoveryArmed "1"')]
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('a refusal removes only its own staged copy, never the armed recovery, and quits with 7', () => {
    const refuse = fn('cwRefuseRecovery')
    expect(refuse).toContain('Delete "$cwRecoveryDir\\${CW_RECOVERY_STAGED}"')
    expect(refuse).not.toContain('${CW_RECOVERY_FILE}')
    expect(refuse).not.toMatch(/DeleteRegValue|RMDir/)
    expect(refuse).toMatch(/SetErrorLevel 7\r?\n\s*Quit/)
    // And nothing else in the arming deletes or clears one.
    expect(fn('cwArmRecovery')).not.toMatch(/Delete |DeleteRegValue|RMDir/)
  })

  it('a shown install arms after its last page that can be cancelled; a finished one disarms', () => {
    expect(nsh).toMatch(/!macro customPageAfterChangeDir\r?\n\s*Page custom cwArmRecoveryPage/)
    expect(nsh).toMatch(/!macro customInstall\r?\n[\s\S]*?Call cwDisarmRecovery[\s\S]*?!macroend/)
    const disarm = fn('cwDisarmRecovery')
    expect(disarm).toMatch(/\$cwRecoveryArmed != "1"\r?\n\s*Return/)
    expect(disarm).toContain('${If} "$EXEPATH" != "$cwRecoveryDir\\${CW_RECOVERY_FILE}"')
  })
})
