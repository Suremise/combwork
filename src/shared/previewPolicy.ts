// The Preview's network policy (HI-3615, design HI-3597 s16 §C and s21 §C′, SPEC §16.21): what a preview's page may reach.
// Pure: the partition's webRequest check (by the URL, before anything is resolved) and the filtering proxy's (by the
// resolved address it then connects to) both decide here, so the two layers never disagree.
//
// - Loopback (127/8, 0/8, ::1, ::, and the IPv4 forms IPv6 can carry: mapped, compatible, NAT64, 6to4; `localhost` and
//   `*.localhost`) only to this preview's own ports, over http or ws.
// - Private, link-local, shared and other non-public addresses (10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10,
//   fc00::/7, fe80::/10, multicast, reserved, broadcast): refused.
// - The public internet over https or wss (the user's decision, HI-3597): allowed.
// - Schemes: data:, blob: and about:blank in the page; nothing else (file:, Combwork's own, chrome:, devtools: …).

/** What an address is, for the policy. */
export type AddressClass = 'loopback' | 'private' | 'public'

/** Why a request is refused (the logs' and the tests' words: English codes, never shown as they are). */
export type Refusal =
  | 'scheme'
  | 'loopbackPort'
  | 'private'
  | 'plainHttpOutside'
  | 'secureToLoopback'
  | 'badHost'
  | 'mixedAddresses'
  | 'unresolved'
  | 'navigation'

/** A decision: allowed, or refused with why. */
export type Decision = { ok: true } | { ok: false; why: Refusal }

const OK: Decision = { ok: true }
const no = (why: Refusal): Decision => ({ ok: false, why })

/** An IPv4 address's four numbers, or null. */
function v4(ip: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return null
  const n = m.slice(1).map(Number) as [number, number, number, number]
  return n.every((x) => x <= 255) ? n : null
}

function classifyV4([a, b, c]: [number, number, number, number]): AddressClass {
  if (a === 127 || a === 0) return 'loopback'
  if (a === 10) return 'private'
  if (a === 172 && b >= 16 && b <= 31) return 'private'
  if (a === 192 && b === 168) return 'private'
  if (a === 169 && b === 254) return 'private'
  if (a === 100 && b >= 64 && b <= 127) return 'private'
  // Multicast, reserved and broadcast: never a page's to reach.
  if (a >= 224) return 'private'
  // 192.0.0.0/24 (protocol assignments) and 198.18.0.0/15 (benchmarking): not the internet.
  if (a === 192 && b === 0 && c === 0) return 'private'
  if (a === 198 && (b === 18 || b === 19)) return 'private'
  return 'public'
}

/** An IPv6 address as its eight groups (a trailing dotted IPv4 written as its two groups first), or null. */
function v6Groups(ip: string): number[] | null {
  let s = ip.replace(/^\[|\]$/g, '').toLowerCase()
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  // Hex groups and colons (a dotted IPv4 at its end): the parse below checks their count and range.
  if (!s.includes(':') || !/^[0-9a-f:.]+$/.test(s)) return null
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s)
  if (dotted) {
    const four = v4(dotted[1])
    if (!four) return null
    s = `${s.slice(0, dotted.index)}${((four[0] << 8) | four[1]).toString(16)}:${((four[2] << 8) | four[3]).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const part = (x: string): number[] => (x ? x.split(':').map((h) => parseInt(h, 16)) : [])
  const head = part(halves[0])
  const tail = halves.length === 2 ? part(halves[1]) : []
  const groups = halves.length === 2 ? [...head, ...Array.from({ length: Math.max(0, 8 - head.length - tail.length) }, () => 0), ...tail] : head
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null
}

/** The IPv4 address an IPv6 one carries in its last 32 bits. */
const embedded = (g: number[]): [number, number, number, number] => [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]

function classifyV6(g: number[]): AddressClass {
  const zeroHead = g.slice(0, 5).every((x) => x === 0)
  // ::, ::1
  if (g.every((x, i) => (i < 7 ? x === 0 : x === 0 || x === 1))) return 'loopback'
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible): the IPv4 address's class.
  if (zeroHead && (g[5] === 0xffff || g[5] === 0)) return classifyV4(embedded(g))
  // 64:ff9b::/96 (NAT64) and 64:ff9b:1::/48: the IPv4 address it reaches.
  if (g[0] === 0x64 && g[1] === 0xff9b) return classifyV4(embedded(g))
  // 2002::/16 (6to4): the IPv4 address in its second and third groups.
  if (g[0] === 0x2002) return classifyV4([g[1] >> 8, g[1] & 0xff, g[2] >> 8, g[2] & 0xff])
  // fc00::/7 (unique local), fe80::/10 (link-local), fec0::/10 (site-local), ff00::/8 (multicast).
  if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00) return 'private'
  // 100::/64 (discard), 2001:db8::/32 (documentation) and 2001::/23's special uses aren't the internet either.
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return 'private'
  if (g[0] === 0x2001 && g[1] === 0xdb8) return 'private'
  return 'public'
}

/** An IP address's class; null when it isn't one. */
export function classifyAddress(ip: string): AddressClass | null {
  const four = v4(ip)
  if (four) return classifyV4(four)
  const g = v6Groups(ip)
  return g ? classifyV6(g) : null
}

/** A host name that names this machine: localhost and *.localhost (RFC 6761), whatever their case or a trailing dot. */
export const isLocalhostName = (host: string): boolean => {
  const h = host.toLowerCase().replace(/\.$/, '')
  return h === 'localhost' || h.endsWith('.localhost')
}

/** The ports a request may use on loopback: this preview's own. */
export interface OwnPorts {
  ports: readonly number[]
}

const port = (p: string, scheme: string): number => (p ? Number(p) : scheme === 'https:' || scheme === 'wss:' ? 443 : 80)

/**
 * The page-side check (webRequest, before anything is resolved), by the URL as Chromium gives it (its host already in
 * canonical form: a decimal or hex IPv4 written as dotted). Names other than localhost's pass here; the proxy decides them
 * once it has resolved them.
 */
export function checkUrl(raw: string, own: OwnPorts): Decision {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return no('badHost')
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return OK
  if (u.protocol === 'about:') return u.href === 'about:blank' ? OK : no('scheme')
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return no('scheme')
  if (u.username || u.password) return no('badHost')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (!host) return no('badHost')
  const p = port(u.port, u.protocol)
  const plain = u.protocol === 'http:' || u.protocol === 'ws:'
  const cls = isLocalhostName(host) ? 'loopback' : classifyAddress(host)
  if (cls === 'loopback') {
    if (!plain) return no('secureToLoopback')
    return own.ports.includes(p) ? OK : no('loopbackPort')
  }
  if (cls === 'private') return no('private')
  // The internet, or a name not resolved yet: only over https and wss.
  return plain ? no('plainHttpOutside') : OK
}

/**
 * The proxy's check of one connection, by every address its host resolved to (all must pass: one name answering with a
 * public and a loopback address is refused whole) and whether it is a tunnel (CONNECT: https or wss) or plain (http, ws).
 */
export function checkAddresses(addresses: readonly string[], targetPort: number, tunnel: boolean, own: OwnPorts, hostWasLocalhost = false): Decision {
  if (!addresses.length) return no('unresolved')
  const classes = addresses.map((a) => classifyAddress(a))
  if (classes.some((c) => c === null)) return no('badHost')
  if (hostWasLocalhost && classes.some((c) => c !== 'loopback')) return no('mixedAddresses')
  const kinds = new Set(classes)
  if (kinds.size > 1) return no('mixedAddresses')
  const [cls] = kinds
  if (cls === 'private') return no('private')
  if (cls === 'loopback') return own.ports.includes(targetPort) ? OK : no('loopbackPort')
  // The internet: only through a tunnel (https, wss); plain http and ws stay on this machine.
  return tunnel ? OK : no('plainHttpOutside')
}

/** Whether a top-level navigation stays on the preview's own origin (http://127.0.0.1:<port> or localhost:<port>). */
export function sameOrigin(raw: string, ownPort: number): boolean {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:') return false
    const host = u.hostname.replace(/^\[|\]$/g, '')
    const local = isLocalhostName(host) || classifyAddress(host) === 'loopback'
    return local && port(u.port, u.protocol) === ownPort
  } catch {
    return false
  }
}

/** A URL the user may be offered to open in their browser (Combwork's own bar): http or https, with a host, no credentials. */
export function openableUrl(raw: string): string | null {
  try {
    const u = new URL(raw)
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password) return null
    return u.href.length <= 2048 ? u.href : null
  } catch {
    return null
  }
}
