// A path as the part that matters (src/shared/shortPath.ts, #1317): the folder's name alone, or beside another path the
// part that differs, the common start dropped. List dialogs show it; the full path is in the tooltip and goes to Copy.
import { describe, expect, it } from 'vitest'
import { pathParts, shortName, shortPath } from '../src/shared/shortPath'

describe('pathParts', () => {
  it('a drive, a share, a POSIX root, or none', () => {
    expect(pathParts('D:\\Projects\\ACME\\acme')).toEqual({ root: 'D:\\', names: ['Projects', 'ACME', 'acme'], sep: '\\' })
    expect(pathParts('\\\\nas\\work\\acme\\api')).toEqual({ root: '\\\\nas\\work\\', names: ['acme', 'api'], sep: '\\' })
    expect(pathParts('/home/d/acme/')).toEqual({ root: '/', names: ['home', 'd', 'acme'], sep: '/' })
    expect(pathParts('acme/api')).toEqual({ root: '', names: ['acme', 'api'], sep: '/' })
    expect(pathParts('C:')).toEqual({ root: 'C:\\', names: [], sep: '\\' })
  })
})

describe('shortPath', () => {
  it("alone: the folder's name", () => {
    expect(shortPath('D:\\Projects\\ACME\\acme')).toBe('acme')
    expect(shortPath('D:\\Projects\\ACME\\acme\\')).toBe('acme')
    expect(shortPath('/home/d/acme')).toBe('acme')
  })

  it('a drive root or a share alone stays whole', () => {
    expect(shortPath('D:\\')).toBe('D:\\')
    expect(shortPath('\\\\nas\\work')).toBe('\\\\nas\\work\\')
  })

  it('beside another: the common start dropped, after …\\', () => {
    expect(shortPath('D:\\Dev\\ACME.worktrees\\acme\\hb5\\api', 'D:\\Dev\\ACME.worktrees\\acme\\hb6\\api')).toBe('…\\hb5\\api')
    expect(shortPath('D:\\Dev\\old\\x\\wt', 'D:\\Dev\\new\\y\\wt')).toBe('…\\old\\x\\wt')
    expect(shortPath('/srv/a/x/wt', '/srv/a/y/wt')).toBe('…/x/wt')
  })

  it('a path that differs only at the end shows its name', () => {
    expect(shortPath('D:\\Dev\\ACME.worktrees\\acme\\hb5', 'D:\\Dev\\ACME.worktrees\\acme\\hb6')).toBe('hb5')
    expect(shortPath('D:\\Dev\\acme', 'D:\\Dev\\acme-2')).toBe('acme')
  })

  it('compares without case, as Windows does', () => {
    expect(shortPath('d:\\dev\\ACME\\a\\wt', 'D:\\Dev\\acme\\b\\wt')).toBe('…\\a\\wt')
  })

  it('the same path, or the folder above the other, shows its name', () => {
    expect(shortPath('D:\\Dev\\acme', 'D:\\Dev\\acme')).toBe('acme')
    expect(shortPath('D:\\Dev\\acme', 'D:\\Dev\\acme\\api')).toBe('acme')
  })

  it('on another drive or share: whole, since its root is what differs', () => {
    expect(shortPath('E:\\Dev\\acme', 'D:\\Dev\\acme')).toBe('E:\\Dev\\acme')
    expect(shortPath('\\\\nas\\work\\acme', '\\\\nas\\home\\acme')).toBe('\\\\nas\\work\\acme')
  })

  it('a share beside a path on the same share: the part that differs', () => {
    expect(shortPath('\\\\nas\\work\\acme\\old\\api', '\\\\nas\\work\\acme\\new\\api')).toBe('…\\old\\api')
  })

  it('nothing in common but the root: the path from its root', () => {
    expect(shortPath('D:\\a\\b', 'D:\\c\\d')).toBe('D:\\a\\b')
  })
})

describe('shortName', () => {
  it("a CLI's folder named after a whole path: what follows the common start, cut at a dash", () => {
    const was = 'C--Users-tester--claude-projects-D--Projects-Workspaces-Scratch-juniper'
    const now = 'C--Users-tester--claude-projects-D--Projects-Workspaces-Tools-dialect'
    expect(shortName(was, now)).toBe('…Scratch-juniper')
    expect(shortName(now, was)).toBe('…Tools-dialect')
    expect(shortPath(`C:\\Users\\tester\\.claude\\projects\\${was}`, `C:\\Users\\tester\\.claude\\projects\\${now}`)).toBe('…Scratch-juniper')
  })
  it('names that share little stay whole', () => {
    expect(shortName('hb5', 'hb6')).toBe('hb5')
    expect(shortName('acme', 'acme-2')).toBe('acme')
    expect(shortName('short-a', 'short-b')).toBe('short-a')
  })
})
