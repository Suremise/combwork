// THIRD_PARTY_NOTICES.md's content, made in memory: the licence of every package that ships inside Hive — the main
// process's runtime dependencies and the libraries bundled into the renderer — with their full texts, then the installer's
// components. scripts/licenses.mjs writes it (or, with --check, compares it with the committed file), and
// tests/licenses.test.ts checks the committed file is up to date (#386). Build-only tools (vite, electron-builder, sharp…)
// are not shipped and not listed. It reads the installed packages under `root`'s node_modules: no network.
import { existsSync, readdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { licenceText } from './licenseText.mjs'

// Bundled into the renderer by Vite (devDependencies because they are compiled in, not installed).
export const RENDERER = ['react', 'react-dom', '@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links', '@xterm/addon-webgl', 'monaco-editor', 'dompurify', 'marked', 'zustand', '@vscode/codicons']

// Packages offered under a choice of licences, and the one Hive takes (Darren's call, #185), said where each is listed.
const CHOSEN = { dompurify: 'Apache-2.0' }
// What a package's own licence field leaves out, from its licence files (#185).
const NOTES = { '@vscode/codicons': 'code MIT (LICENSE-CODE); the Git logo icon CC-BY-3.0 (Jason Long)' }

const declaredLicence = (meta) =>
  typeof meta.license === 'string' ? meta.license : meta.license?.type ?? (Array.isArray(meta.licenses) ? meta.licenses.map((l) => l.type ?? l).join(' OR ') : 'see licence text')
/** Its licence as published, and the one Hive uses when it has a choice ("(MPL-2.0 OR Apache-2.0), used under Apache-2.0"). */
const licenceOf = (meta) =>
  `${declaredLicence(meta)}${CHOSEN[meta.name] ? `, used under ${CHOSEN[meta.name]}` : ''}${NOTES[meta.name] ? `; ${NOTES[meta.name]}` : ''}`

// The hosts of npm's repository shortcuts ("github:owner/repo", "gist:id"…).
const SHORTCUT_HOSTS = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org', gist: 'gist.github.com' }
/**
 * Whether a link opens a web page: it parses as a URL (a host name with a dot, a valid port if any, no sign-in) and is
 * https://. A shape alone isn't enough: `https://example.org:bad/repo` looks like one and goes nowhere.
 */
function isWebUrl(u) {
  if (!/^https:\/\/\S+$/.test(u)) return false
  try {
    const url = new URL(u)
    return url.protocol === 'https:' && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(url.hostname) && !url.username && !url.password
  } catch {
    return false
  }
}

/**
 * A package.json `repository` (its string or its `url`), in any form npm documents, as an https:// web page: the
 * shorthand owner/repo (GitHub), github:, gitlab:, bitbucket: and gist: shortcuts, scp-style git@host:owner/repo,
 * ssh://, git://, git+ssh:// and git+https:// URLs, an ssh URL's path after a colon too (git+ssh://git@github.com:npm/cli);
 * a trailing .git and a #fragment (#semver) dropped (#788). Null when it is none of those, or isn't a valid URL then.
 */
export function repoWebUrl(value) {
  if (typeof value !== 'string') return null
  let v = value.trim().replace(/#.*$/, '')
  const shortcut = /^(github|gitlab|bitbucket|gist):(.+)$/.exec(v)
  if (shortcut) v = `https://${SHORTCUT_HOSTS[shortcut[1]]}/${shortcut[2]}`
  else if (/^[\w.-]+\/[\w.-]+$/.test(v)) v = `https://github.com/${v}`
  else {
    v = v.replace(/^git\+/, '')
    // scp-style: [user@]host:path, never a URL's scheme (followed by //).
    const scp = /^(?:[\w.-]+@)?([\w-]+(?:\.[\w-]+)+):(?!\/\/)\/?(.+)$/.exec(v)
    if (scp) v = `https://${scp[1]}/${scp[2]}`
    else {
      // An ssh URL may put the path after a colon, as scp does: ssh://git@host:owner/repo. A port is digits only.
      if (v.startsWith('ssh://')) v =v.replace(/^(ssh:\/\/(?:[^@/]+@)?[^/:]+):(?!\d+(?:\/|$))/, '$1/')
      v = v.replace(/^(?:ssh|git|https?):\/\/(?:[^@/]+@)?/, 'https://')
    }
  }
  v = v.replace(/\/+$/, '').replace(/\.git$/, '')
  return isWebUrl(v) ? v : null
}

/** Where a package's row links: its repository's page, else its homepage when that is a web page, else nowhere. */
const repoOf = (meta) => {
  const repo = repoWebUrl(typeof meta.repository === 'string' ? meta.repository : meta.repository?.url)
  if (repo) return repo
  const home = typeof meta.homepage === 'string' ? meta.homepage.trim().replace(/^http:\/\//, 'https://') : ''
  return isWebUrl(home) ? home : null
}
const licenceFiles = (dir) =>
  readdirSync(dir)
    .filter((f) => /^(licen[cs]e|copying|notice|thirdpartynotices)/i.test(f))
    .sort()
    .map((f) => ({ file: f, text: licenceText(readFileSync(join(dir, f), 'utf8')) }))

// What ships that isn't an npm package (#185): the installer's and uninstaller's NSIS parts and plug-ins. (Elevate,
// electron-builder's elevate.exe, isn't shipped since #385: electron-builder.yml packElevateHelper.)
// Their notices, as the components give them (or as their published pages state), are kept in scripts/notices.
const COMPONENTS = [
  { title: 'NSIS (the installer and uninstaller)', intro: 'NSIS 3.0.4.1 and the `System.dll`, `nsDialogs.dll` and `nsExec.dll` plug-ins that come with it. Its licence file:', file: 'nsis.txt' },
  { title: 'Nsis7z plug-in (the installer)', file: 'nsis7z.txt' },
  { title: 'StdUtils plug-in (the installer and uninstaller)', intro: '`StdUtils.dll` 1.1.4.0, by LoRd_MuldeR. Its notice:', file: 'stdutils.txt' },
  { title: 'UAC plug-in (the installer and uninstaller)', intro: '`UAC.dll`, by Anders (https://nsis.sourceforge.io/UAC_plug-in, with its source). Its licence, as included with it:', file: 'uac.txt' },
  { title: 'WinShell plug-in (the installer and uninstaller)', file: 'winshell.txt' },
  { title: 'GNU Lesser General Public License, version 2.1', intro: 'The licence of the Nsis7z and StdUtils plug-ins, above:', file: 'lgpl-2.1.txt' }
]

/**
 * The notices for the checkout at `root` (its package.json and node_modules), with \n line endings, and how many packages
 * they list. `noticesDir` holds the installer components' notices (scripts/notices).
 */
export function generateNotices(root, noticesDir = join(root, 'scripts', 'notices')) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const roots = [...new Set(['electron', ...Object.keys(pkg.dependencies ?? {}), ...RENDERER])]

  /** Where a package is installed, looking in the requiring package's own node_modules first. */
  function locate(name, from) {
    for (let dir = from; dir && dir.startsWith(root); dir = dirname(dir)) {
      const p = join(dir, 'node_modules', name)
      if (existsSync(join(p, 'package.json'))) return p
      if (dir === root) break
    }
    return null
  }

  const found = new Map()
  function walk(name, from, runtimeOnly) {
    const dir = locate(name, from)
    // Type definitions are compile-time only.
    if (!dir || name.startsWith('@types/')) return
    const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const id = `${meta.name}@${meta.version}`
    if (found.has(id)) return
    found.set(id, { meta, dir })
    // Electron's own dependencies only download its binary at install time; they don't ship.
    if (!runtimeOnly) return
    for (const dep of [...Object.keys(meta.dependencies ?? {}), ...Object.keys(meta.optionalDependencies ?? {})]) walk(dep, dir, true)
  }
  for (const name of roots) walk(name, root, name !== 'electron')

  const list = [...found.values()].sort((a, b) => a.meta.name.localeCompare(b.meta.name))
  const out = [
    '# Third-party notices',
    '',
    'Combwork is licensed under the [MIT License](LICENSE). It includes the open-source software listed below, each under its own licence, reproduced in full further down.',
    '',
    'Combwork runs on [Electron](https://www.electronjs.org/), which includes Chromium, Node.js and other components. Their licences ship with the app, in `LICENSE.electron.txt` and `LICENSES.chromium.html` in the folder Combwork is installed in.',
    '',
    "Combwork's Windows installer and its uninstaller are built with [NSIS](https://nsis.sourceforge.io/) (zlib/libpng licence), and use these NSIS plug-ins while they run (none is part of the installed app):",
    '',
    '- `System.dll`, `nsDialogs.dll` and `nsExec.dll`, which come with NSIS (zlib/libpng licence).',
    '- The Nsis7z plug-in (`nsis7z.dll`, installer only), which unpacks the app. It is based on [7-Zip](https://www.7-zip.org/) by Igor Pavlov and licensed under the GNU Lesser General Public License, version 2.1. Its source is available from https://nsis.sourceforge.io/Nsis7z_plug-in, and 7-Zip\'s from https://www.7-zip.org/.',
    '- The StdUtils plug-in (`StdUtils.dll`) by LoRd_MuldeR, licensed under the GNU Lesser General Public License, version 2.1 or later. Its source is available from https://github.com/lordmulder/stdutils.',
    '- The UAC plug-in (`UAC.dll`) by Anders, zlib licence: https://nsis.sourceforge.io/UAC_plug-in.',
    '- The WinShell plug-in (`WinShell.dll`) by Anders, published as freeware: https://nsis.sourceforge.io/WinShell_plug-in.',
    '',
    'The notices of these installer components are under "Installer and other components" at the end of this file.',
    '',
    'Where a package offers a choice of licences, its entry says which one Combwork uses.',
    '',
    'This file is generated by `scripts/licenses.mjs` during `npm run build`.',
    '',
    '| Package | Version | Licence |',
    '|---|---|---|',
    ...list.map(({ meta }) => {
      const repo = repoOf(meta)
      return `| ${repo ? `[${meta.name}](${repo})` : meta.name} | ${meta.version} | ${licenceOf(meta)} |`
    }),
    ''
  ]
  for (const { meta, dir } of list) {
    out.push(`## ${meta.name} ${meta.version}`, '', `Licence: ${licenceOf(meta)}`, '')
    const files = licenceFiles(dir)
    if (!files.length) out.push(`No licence file is included in the package; it is published under ${licenceOf(meta)}.`, '')
    for (const f of files) out.push(...(files.length > 1 ? [`*${f.file}*`, ''] : []), '```text', f.text, '```', '')
  }

  out.push('# Installer and other components', '', 'Not npm packages: the parts of the installer and uninstaller listed at the top of this file.', '')
  for (const c of COMPONENTS) {
    out.push(`## ${c.title}`, '', ...(c.intro ? [c.intro, ''] : []), '```text', licenceText(readFileSync(join(noticesDir, c.file), 'utf8')), '```', '')
  }
  return { text: out.join('\n'), packages: list.length }
}
