// HI-1183: follow mode's transport helpers: what a record may show of a URL, and the redaction of git's words.
import { describe, expect, it } from 'vitest'
import { displayUrl, redactTransport } from '../src/main/platform/gitTransport'
import { memoryTransportStore, snapshotDigest } from '../src/main/workflow/transportSnapshots'
import type { TransportSnapshot } from '../src/main/platform/integration'

const snap = (over: Partial<TransportSnapshot> = {}): TransportSnapshot => ({
  remote: 'origin',
  url: 'https://alice:s3cr3t-pass-word@example.com/team/repo.git',
  display: 'https://example.com/team/repo.git',
  ref: 'refs/heads/main',
  config: [
    ['http.extraheader', 'Authorization: Bearer tok_ABCDEFGHIJKLMNOP'],
    ['http.proxy', 'http://proxyuser:proxy-secret-99@proxy.local:8080'],
    ['credential.helper', '!f() { echo password=helper-secret-123; }; f'],
    ['http.sslbackend', 'schannel']
  ],
  objects: 'C:/repo/.git/objects',
  alternates: [],
  format: 'sha1',
  ...over
})

describe('follow mode’s transport helpers (HI-1183)', () => {
  it('a URL as it may be shown keeps no userinfo, query or fragment', () => {
    expect(displayUrl('https://alice:pw@example.com/r.git?token=x#frag')).toBe('https://example.com/r.git')
    expect(displayUrl('ssh://git@example.com:22/r.git')).toBe('ssh://example.com:22/r.git')
    expect(displayUrl('C:/Users/me/remote.git')).toBe('C:/Users/me/remote.git')
    expect(displayUrl('git@github.com:team/repo.git')).toBe('git@github.com:team/repo.git')
  })

  it('git’s words lose every credential: URL userinfo, authorization and bearer values, and each secret of the snapshot', () => {
    const s = snap()
    const text = [
      "fatal: unable to access 'https://alice:s3cr3t-pass-word@example.com/team/repo.git/': 403",
      'remote: header was Authorization: Bearer tok_ABCDEFGHIJKLMNOP',
      'remote: the token tok_ABCDEFGHIJKLMNOP is wrong',
      'proxy http://proxyuser:proxy-secret-99@proxy.local:8080 refused',
      'helper said helper-secret-123',
      'a bare s3cr3t-pass-word'
    ].join('\n')
    const out = redactTransport(text, s)
    for (const secret of ['s3cr3t-pass-word', 'tok_ABCDEFGHIJKLMNOP', 'proxy-secret-99', 'helper-secret-123']) expect(out).not.toContain(secret)
    expect(out).toContain('example.com/team/repo.git')
    expect(out).toContain('403')
    // With no snapshot, what any URL or header carries still goes.
    expect(redactTransport('https://u:p@h/x Authorization: Basic abc', null)).toBe('https://***@h/x Authorization: ***')
  })

  it('the store keeps a snapshot by id and digest: a changed or missing one is never returned', async () => {
    const store = memoryTransportStore()
    const s = snap()
    const kept = (await store.save('C:/P', s))!
    expect(kept.digest).toBe(snapshotDigest(s))
    expect(await store.load(kept.id, kept.digest)).toEqual(s)
    expect(await store.load(kept.id, 'other')).toBeNull()
    store.raw.set(kept.id, JSON.stringify({ ...s, url: 'https://elsewhere/r.git' }))
    expect(await store.load(kept.id, kept.digest)).toBeNull()
    // A project's clean-up drops only its own.
    const other = (await store.save('C:/Q', s))!
    await store.dropExcept('c:/p', new Set())
    expect(store.raw.has(kept.id)).toBe(false)
    expect(store.raw.has(other.id)).toBe(true)
  })
})
