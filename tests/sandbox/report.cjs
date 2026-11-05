/**
 * Turns what the Sandbox checks (checks.cjs) collected from the Sandbox into checks and a short Markdown report. Pure functions, no I/O.
 *   const result = evaluate(meta, files)   // files: { 's1-run': {...}, 's1': {...}, ... } (the JSON the scenarios wrote)
 *   const md = markdown(result)
 *
 * A report passes only with full coverage: every scenario that was asked for ran, every step the runner took
 * succeeded (meta.steps), each driver finished (completed) and produced all its required checks and facts, and the
 * required screenshots were collected. Anything missing is a failed check, never a silent gap.
 * The one exception: a run kind in meta.notRun ({ kind: { reason, installer } }) wasn't checked at all (its installer
 * was refused by an App Control policy before anything could run). Its checks are left out and, unless another check
 * failed, the report is NOT RUN with that reason.
 */
const SCENARIOS = {
  1: 'Fresh install and first launch',
  2: 'First run with no coding-agent CLIs',
  3: 'A CLI appearing while Combwork runs (fake CLI)',
  4: 'Upgrade from the previous release, running, as its updater runs the installer (--updated /S --force-run)',
  5: 'Uninstall',
  6: 'A new workspace in the fresh install (for the fresh-install comparison)',
  7: 'Install by hand over the previous release, running (/S --force-run)',
  8: "The installer's edge cases over the previous release, and a notification under the new app ID",
  10: 'Upgrade from a 1.1 release candidate (--previous-rc, e.g. RC2), running, as its updater runs the installer (--updated /S --force-run): the names upgrade (HI-2587) moves only what is still old'
}
const KINDS = ['fresh', 'upgrade', 'manual', 'edges', 'upgrade-rc']
/** The names upgrade's checks after an upgrade (HI-2587), from 1.0 and from a release candidate alike. */
const NAME_IDS = ['4.board-file', '4.board-backups', '4.log-file', '4.workspace-files', '4.copy-marker', '4.names-done', '4.no-old-names']
/** electron-builder's APP_GUID for appId it.surmise.combwork (HI-2460): its uninstall entry's key. */
const COMBWORK_GUID = '10a7595a-0e90-558c-b6b6-ae33bdd80748'

// What each run kind must produce: the drivers' check ids and facts, and the screenshots.
const REQUIRED = {
  fresh: {
    drivers: {
      s1: { scenario: 1, ids: ['1.start-screen', '1.profile', '2.banner', '2.no-claude-warning', '2.api-providers', '2.agent-setup-opens', '2.agent-setup-three'], facts: ['version'] },
      s3: { scenario: 3, ids: ['3.on-not-found', '3.banner-none-installed', '3.setup-not-installed', '3.user-path', '3.check-again-finds', '3.setup-found', '3.api-installed', '3.banner-gone'], facts: [] },
      s6: { scenario: 6, ids: ['6.workspace-opens', '6.hive-folder', '6.views'], facts: ['hive', 'views'] }
    },
    shots: ['s1-desktop.jpg', 's1-installed-apps.jpg', 's1-start-dark.png', 's1-start-light.png', 's1-agent-setup-dark.png', 's1-agent-setup-light.png', 's3-missing-dark.png', 's3-found-dark.png', 's3-found-light.png', 's6-workspace.png', 's6-workspace-overview.png', 's6-skills.png', 's6-mcp-servers.png', 's6-hive-assistant.png', 's5-desktop.jpg']
  },
  upgrade: overPrevious(4, 's4'),
  manual: overPrevious(7, 's7'),
  'upgrade-rc': overPrevious(10, 's10', true),
  edges: { drivers: { s8: { scenario: 8, ids: ['8.notification'], facts: ['exe'] } }, shots: ['s8-notified.png', 's8-desktop.jpg'] }
}

/** The edge cases' checks edges.ps1 must record (HI-2460). */
const EDGE_IDS = ['8.wait', '8.wait-unchanged', '8.continues', '8.refuses', '8.refuses-unchanged', '8.running', '8.running-unchanged', '8.uninstall-fails', '8.uninstall-fails-unchanged', '8.fallback-running', '8.fallback-moved']

/** An upgrade over the previous release (scenario n, its files' prefix pre): the drivers' checks (HI-2460's too) and shots. */
function overPrevious(n, pre, fromRc = false) {
  // From a release candidate (HI-2587): its profile, .combwork and cw.* ids are moved already, so only what a 1.1 RC
  // still keeps under Hive's names is checked, besides what every upgrade keeps.
  if (fromRc) {
    return {
      drivers: {
        [`${pre}-mark`]: { scenario: n, ids: ['4.settings-saved', '4.workspace-made'], facts: ['version'] },
        [`${pre}-after`]: { scenario: n, ids: ['4.settings-kept', '4.theme-applied', '4.combwork-runs', '4.workspace-moved', '4.workspace-card', ...NAME_IDS], facts: ['version'] },
        [`${pre}-notify`]: { scenario: n, ids: [`${n}.notification`], facts: ['exe'] }
      },
      shots: [`${pre}-mark-before-upgrade.png`, `${pre}-desktop-before.jpg`, `${pre}-desktop-after.jpg`, `${pre}-after-after-upgrade-light.png`, `${pre}-after-after-upgrade-dark.png`, `${pre}-toast.jpg`]
    }
  }
  return {
    drivers: {
      [`${pre}-mark`]: { scenario: n, ids: ['4.settings-saved', '4.login-registered', '4.workspace-made', '4.advanced-saved'], facts: ['version'] },
      [`${pre}-after`]: { scenario: n, ids: ['4.settings-kept', '4.theme-applied', '4.combwork-runs', '4.local-moved', '4.trust-kept', '4.roaming-moved', '4.record', '4.login-moved', '4.no-fallback', '4.workspace-moved', '4.workspace-card', '4.advanced-kept', '4.advanced-old-id', ...NAME_IDS], facts: ['version'] },
      [`${pre}-notify`]: { scenario: n, ids: [`${n}.notification`], facts: ['exe'] }
    },
    shots: [`${pre}-mark-before-upgrade.png`, `${pre}-desktop-before.jpg`, `${pre}-desktop-after.jpg`, `${pre}-after-after-upgrade-light.png`, `${pre}-after-after-upgrade-dark.png`, `${pre}-toast.jpg`]
  }
}

const entriesOf = s => (s?.uninstallEntries ? [].concat(s.uninstallEntries) : [])
const shortcutsOf = s => (s?.shortcuts ? [].concat(s.shortcuts) : [])
const inDesktop = l => /\\Desktop$/i.test(l.folder)
const inStart = l => /Start Menu\\Programs$/i.test(l.folder)
/** Whether a shortcut's target is `<name>.exe` in its own install folder (Programs\\<name>). */
const exeIn = (target, name) => new RegExp(`\\\\${name}\\\\${name}\\.exe$`, 'i').test(String(target))

/** Shortcuts as a short text: "Hive Desktop (Desktop, Start menu)". */
const describeShortcuts = list => list.map(l => `${l.name} (${inDesktop(l) ? 'Desktop' : inStart(l) ? 'Start menu' : l.folder})`).join(', ') || 'none'

function evaluate(meta, files) {
  const checks = []
  const add = (scenario, name, ok, detail) => checks.push({ scenario, name, ok: !!ok, detail: ok ? undefined : String(detail ?? '') })
  const asked = Array.isArray(meta.ran) ? meta.ran : []
  const notRun = Object.entries(meta.notRun || {}).filter(([k]) => asked.includes(k)).map(([kind, n]) => ({ kind, reason: n.reason, installer: n.installer }))
  // What was checked: the kinds asked for, less those not run.
  const ran = asked.filter(k => !notRun.some(n => n.kind === k))
  const need = (scenario, key) => {
    if (files[key] && typeof files[key] === 'object') return files[key]
    add(scenario, `${key}: result recorded`, false, files[`${key}:error`] || 'the scenario wrote no result (see the run log)')
    return null
  }
  // A driver's record counts only if the step finished, with every required check id and fact.
  const driver = (kind, key) => {
    const req = REQUIRED[kind].drivers[key]
    const d = need(req.scenario, key)
    if (!d) return null
    if (d.completed !== true) add(req.scenario, `${key}: the driver finished its step`, false, d.error || 'it stopped before the end (interrupted, timed out or failed)')
    const list = Array.isArray(d.checks) ? d.checks : []
    for (const c of list) checks.push({ scenario: c.scenario || req.scenario, name: c.name, ok: c.ok === true, detail: c.ok === true ? undefined : c.detail })
    for (const id of req.ids) if (!list.some(c => c.id === id)) add(req.scenario, `${key}: check "${id}" ran`, false, 'missing from the driver\'s record')
    for (const f of req.facts) if (d.facts?.[f] === undefined) add(req.scenario, `${key}: fact "${f}" recorded`, false, 'missing from the driver\'s record')
    return d
  }
  const version = meta.installerVersion
  // The build's names (checks.cjs appNames: HI-2458's productName, HI-2460's shortcut and exe).
  const app = meta.app || { productName: 'Hive Desktop', shortcutName: 'Hive Desktop', exeName: 'Hive' }

  const unknown = ran.filter(k => !KINDS.includes(k))
  if ((!asked.length) || unknown.length) add(0, 'The scenarios asked for ran', false, unknown.length ? `unknown: ${unknown.join(', ')}` : 'none ran')
  // Every step the runner took must have succeeded: a failed command or timeout fails the report.
  for (const s of meta.steps || []) add(s.scenario, `Step: ${s.what}`, s.ok, s.detail)
  for (const kind of ran.filter(k => KINDS.includes(k))) {
    for (const shot of REQUIRED[kind].shots) if (!(meta.shots || []).includes(shot)) add(Number(shot[1]) || 0, `Screenshot ${shot} collected`, false, 'missing')
  }

  if (ran.includes('fresh')) {
    const run = need(1, 's1-run')
    const st = need(1, 's1-state')
    if (run) add(1, `Silent install (/S) succeeds (${run.seconds} s)`, run.exitCode === 0, `exit ${run.exitCode}`)
    if (st) {
      const e = entriesOf(st)
      add(1, `One Installed-apps entry: "${app.productName} ${version}"`, e.length === 1 && e[0].displayName === `${app.productName} ${version}`, JSON.stringify(e.map(x => x.displayName)))
      add(1, `Installed in %LOCALAPPDATA%\\Programs\\${app.exeName} (${app.exeName}.exe, Uninstall ${app.exeName}.exe)`, st.installDir?.hiveExe && st.installDir?.uninstaller && st.installDir?.exe === `${app.exeName}.exe`, JSON.stringify(st.installDir))
      const l = shortcutsOf(st)
      add(1, `Shortcuts named "${app.shortcutName}" on the Desktop and in the Start menu`, l.length >= 2 && l.every(x => x.name === app.shortcutName && exeIn(x.target, app.exeName)) && l.some(inDesktop) && l.some(inStart), describeShortcuts(l))
    }
    const s1 = driver('fresh', 's1')
    if (s1?.facts?.version !== undefined) add(1, `The app reports version ${version}`, s1.facts.version === version, `reports ${s1.facts.version}`)
    driver('fresh', 's3')
    driver('fresh', 's6')
    const run5 = need(5, 's5-run')
    const st5 = need(5, 's5-state')
    if (run5) add(5, `Silent uninstall ("Uninstall ${app.exeName}.exe" /S) succeeds (${run5.seconds} s)`, run5.exitCode === 0, `exit ${run5.exitCode}`)
    if (st5) {
      add(5, 'The Installed-apps entry is gone', !entriesOf(st5).length, JSON.stringify(entriesOf(st5).map(x => x.displayName)))
      add(5, 'The install folder is gone', st5.installDir?.exists === false, st5.installDir?.path)
      add(5, 'The shortcuts are gone', !shortcutsOf(st5).length, describeShortcuts(shortcutsOf(st5)))
      add(5, `The profile (${st5.profileDir?.path}) is kept (deleteAppDataOnUninstall: false)`, st5.profileDir?.exists === true, JSON.stringify(st5.profileDir))
    }
  }

  for (const [kind, n, pre] of [['upgrade', 4, 's4'], ['manual', 7, 's7'], ['upgrade-rc', 10, 's10']]) {
    if (!ran.includes(kind)) continue
    const prevRun = need(n, `${pre}-prev-run`)
    const prevSt = need(n, `${pre}-prev-state`)
    if (prevRun) add(n, `The previous release installs (${prevRun.seconds} s)`, prevRun.exitCode === 0, `exit ${prevRun.exitCode}`)
    const prevNames = entriesOf(prevSt).map(x => x.displayName)
    driver(kind, `${pre}-mark`)
    const started = need(n, `${pre}-prev-started`)
    if (started) add(n, `The previous release ran (pid ${started.pid}, with a window) as the new installer started`, started.window === true && !!started.pid, JSON.stringify(started))
    const newRun = need(n, `${pre}-new-run`)
    const newSt = need(n, `${pre}-new-state`)
    if (newRun) {
      add(n, `The new build installs over it, running, with ${newRun.arguments} (${newRun.seconds} s)`, newRun.exitCode === 0, `exit ${newRun.exitCode}`)
      add(n, `--force-run starts ${app.exeName}.exe after the install`, newRun.hiveRunning === true && [].concat(newRun.running || []).includes('combwork'), `running: ${JSON.stringify(newRun.running)}`)
      add(n, 'Hive Desktop no longer runs', ![].concat(newRun.running || []).includes('hive'), `running: ${JSON.stringify(newRun.running)}`)
    }
    if (newSt) {
      const e = entriesOf(newSt)
      // HI-2460: Hive Desktop's entry gone, one of the new app's: "nobody ends up with both installed".
      // Its key is the new app ID's (it.surmise.combwork's APP_GUID), whatever the display name says.
      add(n, `One Installed-apps entry after the upgrade: "${app.productName} ${version}", Combwork's own (${COMBWORK_GUID}), no Hive Desktop`, e.length === 1 && e[0].displayName === `${app.productName} ${version}` && String(e[0].key).toLowerCase() === COMBWORK_GUID, `before: ${JSON.stringify(prevNames)}; after: ${JSON.stringify(e.map(x => x.displayName))}`)
      const l = shortcutsOf(newSt)
      add(n, `Shortcuts: only "${app.shortcutName}", starting ${app.exeName}.exe, on the Desktop and in the Start menu (before: ${describeShortcuts(shortcutsOf(prevSt))})`, l.length >= 2 && l.every(x => x.name === app.shortcutName && exeIn(x.target, app.exeName)) && l.some(inDesktop) && l.some(inStart), describeShortcuts(l))
      const ins = newSt.installs || {}
      add(n, `Installed in %LOCALAPPDATA%\\Programs\\${app.exeName}; Hive Desktop's folder gone`, ins.combwork?.hiveExe === true && ins.hive?.exists === false, JSON.stringify(ins))
      add(n, `The installed app code is the new build's (app.asar ${String(ins.combwork?.appAsarSha256).slice(0, 12)}…)`, !!ins.combwork?.appAsarSha256, JSON.stringify(ins.combwork))
      const pr = newSt.profiles || {}
      add(n, 'The profile folders moved: %APPDATA%\\Combwork and %LOCALAPPDATA%\\Combwork, no Hive folders left', pr.roamingCombwork?.exists && pr.localCombwork?.exists && !pr.roamingHive?.exists && !pr.localHive?.exists, JSON.stringify({ roaming: [pr.roamingCombwork?.exists, pr.roamingHive?.exists], local: [pr.localCombwork?.exists, pr.localHive?.exists] }))
      add(n, "The installer's record is in %LOCALAPPDATA%\\Combwork", /"by"\s*:\s*"installer"/.test(String(pr.localCombwork?.record)), String(pr.localCombwork?.record))
      const run = [].concat(newSt.run || [])
      add(n, "Hive Desktop's Launch at login removed by the installer", !run.some(v => /\\Hive\.exe/i.test(v.command)), JSON.stringify(run))
    }
    driver(kind, `${pre}-notify`)
    const after = driver(kind, `${pre}-after`)
    if (after?.facts?.version !== undefined) add(n, `After the upgrade the app reports ${version}`, after.facts.version === version, `reports ${after.facts.version}`)
  }

  if (ran.includes('edges')) {
    const e = need(8, 'edges')
    if (e) {
      if (e.completed !== true) add(8, 'edges.ps1 finished', false, 'it stopped before the end')
      const list = [].concat(e.checks || [])
      for (const c of list) add(8, c.name, c.ok === true, c.detail)
      for (const id of EDGE_IDS) if (!list.some(c => c.id === id)) add(8, `edge check "${id}" ran`, false, 'missing from edges.json')
    }
    driver('edges', 's8')
  }

  for (const id of meta.leftRunning || []) add(0, `CLEANUP: Sandbox ${id} confirmed stopped`, false, `CLEANUP NOT CONFIRMED: Sandbox ${id} may still be running`)
  if (!checks.length && !notRun.length) add(0, 'At least one check ran', false, 'nothing was checked')

  const passed = checks.filter(c => c.ok).length
  const differences = []
  if ((ran.includes('upgrade') || ran.includes('manual')) && meta.previousVersion === meta.installerVersion) {
    differences.push(`The previous release and this build both say **${meta.installerVersion}**: the in-app updater (no downgrades, only newer versions) would not offer this build, so the upgrade check is a reinstall over it, run by hand with the updater's arguments. The "Hive Desktop updated to …" notice can't show.`)
  }
  const s1 = files.s1
  if (s1?.facts?.gitMissing || files['s1-state']?.git === false) differences.push('**No Git** on a fresh machine: Combwork shows its Git warning (status bar "Git", Provider Setup "Git not found"). Expected; a fresh-install difference.')
  return { meta, checks, passed, failed: checks.length - passed, notRun, differences, files }
}

/** The report's one-line verdict: FAILED beats NOT RUN beats PASSED. */
function verdict(r) {
  const notRun = r.notRun || []
  const kinds = notRun.map(n => n.kind).join(', ')
  if (r.failed) return `FAILED: ${r.failed} of ${r.checks.length} checks${notRun.length ? `; not run: ${kinds}` : ''}`
  if (notRun.length) {
    const reasons = [...new Set(notRun.map(n => n.reason))].join(' ')
    return `NOT RUN: ${reasons}${r.checks.length ? ` (not run: ${kinds}; the other ${r.checks.length} checks passed)` : ''}`
  }
  return `PASSED: all ${r.checks.length} checks`
}

function markdown(r) {
  const m = r.meta
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const lines = [
    `# Combwork build checks in Windows Sandbox`,
    '',
    `**${verdict(r)}** · ${m.date}`,
    '',
    `- Installer: \`${m.installer}\` (version ${m.installerVersion}${m.buildInfo ? `, code ${m.buildInfo.code}, branch ${m.buildInfo.branch}, built ${m.buildInfo.builtAt}` : ''})`,
    m.previous ? `- Previous release for the upgrade: \`${m.previous}\` (version ${m.previousVersion})` : null,
    m.previousRc ? `- Release candidate for scenario 10's upgrade: \`${m.previousRc}\` (version ${m.previousRcVersion})` : null,
    `- Host Windows ${m.hostBuild}; network **off** in the Sandbox; fake CLIs only, nothing signed in.`,
    m.smartAppControl?.option === 'off' ? `- **Smart App Control in the Sandbox: ${m.smartAppControl.note}** (\`--smart-app-control off\`; state ${m.smartAppControl.state ?? 'unknown'}, read before each install). Inside the Sandbox only: the host isn't changed. Unsigned installers could run, so this run says nothing about signing.` : null,
    `- Scenarios run: ${(m.ran || []).filter(k => !(r.notRun || []).some(n => n.kind === k)).join(', ') || 'none'}. Took ${m.minutes} min.`,
    ''
  ].filter(l => l !== null)
  if (r.notRun?.length) {
    lines.push('## Not run', '', 'Nothing in these was checked, so none of their checks passed or failed:', '')
    for (const n of r.notRun) lines.push(`- **${n.kind}**: Windows refused \`${n.installer}\`.`)
    lines.push('', ...[...new Set(r.notRun.map(n => n.reason))].map(esc), '')
  }
  const failed = r.checks.filter(c => !c.ok)
  if (failed.length) {
    lines.push('## Failed checks', '')
    for (const c of failed) lines.push(`- **${c.scenario}. ${c.name}**: ${esc(c.detail || '')}`)
    lines.push('')
  }
  for (const [n, title] of Object.entries(SCENARIOS)) {
    const cs = r.checks.filter(c => String(c.scenario) === n)
    if (!cs.length) continue
    lines.push(`## ${n}. ${title}`, '', '| Check | Result |', '|---|---|')
    for (const c of cs) lines.push(`| ${esc(c.name)} | ${c.ok ? 'pass' : `**FAIL**: ${esc(c.detail || '').slice(0, 300)}`} |`)
    lines.push('')
  }
  if (r.differences.length) lines.push('## Notes and fresh-install differences', '', ...r.differences.map(d => `- ${d}`), '')
  if (m.timings && Object.keys(m.timings).length) lines.push('## Timings', '', ...Object.entries(m.timings).map(([k, v]) => `- ${k}: ${v}`), '')
  if (m.shots?.length) lines.push('## Screenshots', '', ...m.shots.map(s => `- [${s}](${encodeURI(s)})`), '')
  return lines.join('\n')
}

module.exports = { evaluate, markdown, verdict, SCENARIOS, KINDS, REQUIRED }
