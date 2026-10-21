// A path as the part that matters (src/shared/shortPath.ts, #1317): the folder's name alone, or beside another path the
// part that differs, the common start dropped. List dialogs show it; the full path is in the tooltip and goes to Copy.
import { describe, expect, it } from 'vitest'
import { pathParts, shortPath } from '../src/shared/shortPath'

describe('pathParts', () => {
  it('a drive, a share, a POSIX root, or none', () => {
    expect(pathParts('D:\\Development\\HIVE\\hive')).toEqual({ root: 'D:\\', names: ['Development', 'HIVE', 'hive'], sep: '\\' })
    expect(pathParts('\\\\nas\\work\\hive\\api')).toEqual({ root: '\\\\nas\\work\\', names: ['hive', 'api'], sep: '\\' })
    expect(pathParts('/home/d/hive/')).toEqual({ root: '/', names: ['home', 'd', 'hive'], sep: '/' })
    expect(pathParts('hive/api')).toEqual({ root: '', names: ['hive', 'api'], sep: '/' })
    expect(pathParts('C:')).toEqual({ root: 'C:\\', names: [], sep: '\\' })
  })
})

describe('shortPath', () => {
  it("alone: the folder's name", () => {
    expect(shortPath('D:\\Development\\HIVE\\hive')).toBe('hive')
    expect(shortPath('D:\\Development\\HIVE\\hive\\')).toBe('hive')
    expect(shortPath('/home/d/hive')).toBe('hive')
  })

  it('a drive root or a share alone stays whole', () => {
    expect(shortPath('D:\\')).toBe('D:\\')
    expect(shortPath('\\\\nas\\work')).toBe('\\\\nas\\work\\')
  })

  it('beside another: the common start dropped, after …\\', () => {
    expect(shortPath('D:\\Dev\\HIVE.worktrees\\hive\\hb5\\api', 'D:\\Dev\\HIVE.worktrees\\hive\\hb6\\api')).toBe('…\\hb5\\api')
    expect(shortPath('D:\\Dev\\old\\x\\wt', 'D:\\Dev\\new\\y\\wt')).toBe('…\\old\\x\\wt')
    expect(shortPath('/srv/a/x/wt', '/srv/a/y/wt')).toBe('…/x/wt')
  })

  it('a path that differs only at the end shows its name', () => {
    expect(shortPath('D:\\Dev\\HIVE.worktrees\\hive\\hb5', 'D:\\Dev\\HIVE.worktrees\\hive\\hb6')).toBe('hb5')
    expect(shortPath('D:\\Dev\\hive', 'D:\\Dev\\hive-2')).toBe('hive')
  })

  it('compares without case, as Windows does', () => {
    expect(shortPath('d:\\dev\\HIVE\\a\\wt', 'D:\\Dev\\hive\\b\\wt')).toBe('…\\a\\wt')
  })

  it('the same path, or the folder above the other, shows its name', () => {
    expect(shortPath('D:\\Dev\\hive', 'D:\\Dev\\hive')).toBe('hive')
    expect(shortPath('D:\\Dev\\hive', 'D:\\Dev\\hive\\api')).toBe('hive')
  })

  it('on another drive or share: whole, since its root is what differs', () => {
    expect(shortPath('E:\\Dev\\hive', 'D:\\Dev\\hive')).toBe('E:\\Dev\\hive')
    expect(shortPath('\\\\nas\\work\\hive', '\\\\nas\\home\\hive')).toBe('\\\\nas\\work\\hive')
  })

  it('a share beside a path on the same share: the part that differs', () => {
    expect(shortPath('\\\\nas\\work\\hive\\old\\api', '\\\\nas\\work\\hive\\new\\api')).toBe('…\\old\\api')
  })

  it('nothing in common but the root: the path from its root', () => {
    expect(shortPath('D:\\a\\b', 'D:\\c\\d')).toBe('D:\\a\\b')
  })
})
