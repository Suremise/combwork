// Which update Combwork takes, and when it installs one (#1647, src/shared/updates.ts, src/main/buildIdentity.ts): versions
// by semver with prereleases, a local build offered (never given) a release of its own version, and a downloaded update
// installed only over an older copy read from disk, never one that can't be read.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { compareVersions, installDecision, readBuildIdentity, updateDecision, type BuildIdentity } from '../src/shared/updates'
import { asarPackageVersion, installedCopy, runningIdentity } from '../src/main/buildIdentity'
// oxlint-disable-next-line typescript/no-require-imports -- the e2e suites' CommonJS helper, shared with them
const { fakeInstall } = require('./e2e/fakeInstall.cjs') as { fakeInstall: (dir: string, o?: { version?: string; identity?: unknown }) => string }

const base = tempDir('cw-updates-')
let n = 0
const dir = () => join(base, `r${++n}`)
const release = (version: string): BuildIdentity => ({ version, commit: null, local: false })
const local = (version: string, commit = 'abc1234def'): BuildIdentity => ({ version, commit, local: true })

describe('versions (#1647)', () => {
  it('compare by semver: a prerelease below its release, its identifiers in turn, never as text', () => {
    const order = ['0.9.2', '0.9.3', '0.10.0', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0-rc.2', '1.0.0', '1.0.1', '1.1.0']
    for (let i = 0; i < order.length; i++)
      for (let j = 0; j < order.length; j++) expect(Math.sign(compareVersions(order[i], order[j])!), `${order[i]} vs ${order[j]}`).toBe(Math.sign(i - j))
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0+build.5', '1.0.0')).toBe(0)
    expect(compareVersions('1.0', '1.0.0')).toBeNull()
    expect(compareVersions('latest', '1.0.0')).toBeNull()
  })

  it('a check: a newer release updates, a local build is offered its own version, nothing else', () => {
    expect(updateDecision(release('0.9.2'), '0.9.3')).toBe('update')
    expect(updateDecision(local('0.9.3'), '0.9.4')).toBe('update')
    expect(updateDecision(local('1.0.0-rc.3'), '1.0.0')).toBe('update')
    // The incident's kind: a local 0.9.3 and the published 0.9.3.
    expect(updateDecision(local('0.9.3'), '0.9.3')).toBe('offer')
    expect(updateDecision(release('0.9.3'), '0.9.3')).toBe('none')
    // An older release, rc.3 against a published rc.2 included.
    expect(updateDecision(local('1.0.0-rc.3'), '1.0.0-rc.2')).toBe('none')
    expect(updateDecision(release('1.0.0'), '1.0.0-rc.2')).toBe('none')
    expect(updateDecision(release('1.0.0'), 'not-a-version')).toBe('none')
  })

  it('an install: only over a copy read and older; never over an unreadable one, its own version or newer', () => {
    expect(installDecision({ kind: 'known', identity: release('0.9.2') }, '0.9.3')).toEqual({ install: true })
    expect(installDecision({ kind: 'known', identity: release('0.9.2'), legacy: true }, '0.9.3')).toEqual({ install: true })
    expect(installDecision({ kind: 'known', identity: local('0.9.3') }, '0.9.3')).toEqual({ install: false, why: 'notNewer' })
    expect(installDecision({ kind: 'known', identity: local('1.0.0-rc.3') }, '1.0.0-rc.2')).toEqual({ install: false, why: 'notNewer' })
    expect(installDecision({ kind: 'known', identity: local('1.0.0-rc.3') }, '1.0.0')).toEqual({ install: true })
    expect(installDecision({ kind: 'unreadable', why: 'x' }, '99.0.0')).toEqual({ install: false, why: 'unreadable' })
    expect(installDecision({ kind: 'known', identity: release('1.0.0') }, '')).toEqual({ install: false, why: 'notNewer' })
  })

  it('an identity file is checked: a version, local true or false, a commit or none', () => {
    expect(readBuildIdentity({ version: '0.9.3', commit: 'abc1234', local: true })).toEqual({ version: '0.9.3', commit: 'abc1234', local: true })
    expect(readBuildIdentity({ version: '0.9.3', local: false })).toEqual({ version: '0.9.3', commit: null, local: false })
    for (const bad of [null, [], 'x', { version: '0.9', local: true }, { version: '0.9.3' }, { version: '0.9.3', local: 'yes' }, { version: '0.9.3', local: true, commit: 'not hex!' }]) expect(readBuildIdentity(bad)).toBeNull()
  })
})

describe('the copy installed on disk (#1647)', () => {
  it("reads an asar's package.json version: the e2e stand-in's and one @electron/asar made", async () => {
    const d = fakeInstall(dir(), { version: '0.9.3' })
    expect(asarPackageVersion(join(d, 'app.asar'))).toBe('0.9.3')
    // @electron/asar's own layout (electron-builder's dependency), with more than one file.
    const src = dir()
    mkdirSync(join(src, 'out'), { recursive: true })
    writeFileSync(join(src, 'out', 'main.js'), 'x'.repeat(5000))
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'combwork', version: '1.0.0-rc.2' }))
    // oxlint-disable-next-line typescript/no-require-imports -- a dev-only dependency of electron-builder's
    const asar = require('@electron/asar') as { createPackage: (src: string, dest: string) => Promise<void> }
    const real = join(dir(), 'app.asar')
    mkdirSync(join(real, '..'), { recursive: true })
    await asar.createPackage(src, real)
    // createPackage resolves on its write stream's end() (@electron/asar 3.4.1), before the last file (package.json) is
    // written: under load the archive is read cut short (HI-1975), so wait for it to be whole. The timeout bounds a hung run.
    await vi.waitFor(() => expect(asarPackageVersion(real)).toBe('1.0.0-rc.2'), { timeout: 10_000 })
  })

  it('known when its identity and app agree; a legacy release without one; unreadable otherwise, never the running version', () => {
    expect(installedCopy(fakeInstall(dir(), { version: '0.9.3', identity: { version: '0.9.3', commit: 'abc1234', local: true } }))).toEqual({ kind: 'known', identity: { version: '0.9.3', commit: 'abc1234', local: true } })
    expect(installedCopy(fakeInstall(dir(), { version: '0.9.2' }))).toEqual({ kind: 'known', identity: { version: '0.9.2', commit: null, local: false }, legacy: true })
    // Its identity and its app disagree (one replaced, not the other), malformed, or no app at all.
    expect(installedCopy(fakeInstall(dir(), { version: '0.9.2', identity: { version: '0.9.3', local: true } }))).toMatchObject({ kind: 'unreadable', why: 'its identity says 0.9.3, its app 0.9.2' })
    expect(installedCopy(fakeInstall(dir(), { version: '0.9.3', identity: '{"version":' }))).toMatchObject({ kind: 'unreadable' })
    expect(installedCopy(fakeInstall(dir(), { version: '0.9.3', identity: { version: '0.9.3' } }))).toMatchObject({ kind: 'unreadable', why: 'its identity file is malformed' })
    expect(installedCopy(fakeInstall(dir(), { identity: { version: '0.9.3', local: true } }))).toMatchObject({ kind: 'unreadable' })
    const junk = dir()
    mkdirSync(junk, { recursive: true })
    writeFileSync(join(junk, 'app.asar'), 'not an archive at all')
    expect(installedCopy(junk)).toMatchObject({ kind: 'unreadable' })
  })

  it("this build's identity: its file when it names this version, else a release", () => {
    expect(runningIdentity('0.9.3', fakeInstall(dir(), { version: '0.9.3', identity: { version: '0.9.3', commit: 'abc1234', local: true } }))).toEqual({ version: '0.9.3', commit: 'abc1234', local: true })
    expect(runningIdentity('0.9.3', fakeInstall(dir(), { version: '0.9.3' }))).toEqual({ version: '0.9.3', commit: null, local: false })
    expect(runningIdentity('0.9.4', fakeInstall(dir(), { version: '0.9.3', identity: { version: '0.9.3', local: true } }))).toEqual({ version: '0.9.4', commit: null, local: false })
    expect(runningIdentity('0.9.3', fakeInstall(dir(), { version: '0.9.3', identity: 'junk' }))).toEqual({ version: '0.9.3', commit: null, local: false })
  })
})
