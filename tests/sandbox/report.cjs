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
 * Scenario 9 (HI-2592, run kind clean) is the rename's acceptance test: its scan (clean.cjs) must find the old name nowhere.
 * Scenario 11 (HI-2602, run kind profile-move): the profile move the installer couldn't make, made by the app at start.
 */
const { cleanChecks, hitsMarkdown } = require('./clean.cjs')
// old-name: begin report-inputs
/** The 1.0 app's names: a meta from before HI-2458 names no app, and what the installer removes runs its exe. */
const OLD_APP = { productName: 'Hive Desktop', shortcutName: 'Hive Desktop', exeName: 'Hive' }
// old-name: end report-inputs
const SCENARIOS = {
  1: 'Fresh install and first launch',
  2: 'First run with no coding-agent CLIs',
  3: 'A CLI appearing while Combwork runs (fake CLI)',
  4: 'Upgrade from the previous release, running, as its updater runs the installer (--updated /S --force-run)',
  5: 'Uninstall',
  6: 'A new workspace in the fresh install (for the fresh-install comparison)',
  7: 'Install by hand over the previous release, running (/S --force-run)',
  8: "The installer's edge cases over the previous release, and a notification under the new app ID",
  9: 'A clean install used as a new user would, then searched: no trace of the old name anywhere (HI-2592)',
  10: 'Upgrade from a 1.1 release candidate (--previous-rc, e.g. RC2), running, as its updater runs the installer (--updated /S --force-run): the names upgrade (HI-2587) moves only what is still old',
  11: "The profile move the installer couldn't make (a file in 1.0's local profile folder held as it ran): the app refuses to start while it is held, then moves it itself (HI-2602)"
}
const KINDS = ['fresh', 'upgrade', 'manual', 'edges', 'clean', 'upgrade-rc', 'profile-move']
/** The names upgrade's checks after an upgrade (HI-2587), from 1.0 and from a release candidate alike. */
const NAME_IDS = ['4.board-file', '4.board-backups', '4.log-file', '4.workspace-files', '4.copy-marker', '4.names-done', '4.no-old-names']
/** electron-builder's APP_GUID for appId it.surmise.combwork (HI-2460): its uninstall entry's key. */
const COMBWORK_GUID = '10a7595a-0e90-558c-b6b6-ae33bdd80748'

/** The eras an upgrade starts from (checks.cjs previousEra, HI-2727): 1.0's names, a 1.1 release candidate's, Combwork's. */
const ERAS = ['1.0', 'rc', 'combwork']
/**
 * The drivers' check ids an upgrade over a release of `era` must produce (HI-2460's, HI-2587's, HI-2727's): mark's
 * before it, and after-upgrade's.
 */
const UPGRADE_IDS = {
  // 1.0: its folders, Launch at login, workspace, advanced ids and stored values all under the old names, moved.
  '1.0': {
    mark: ['4.settings-saved', '4.login-registered', '4.workspace-made', '4.advanced-saved', '4.values-written'],
    after: ['4.settings-kept', '4.theme-applied', '4.combwork-runs', '4.local-moved', '4.trust-kept', '4.roaming-moved', '4.record', '4.login-moved', '4.no-fallback', '4.workspace-moved', '4.workspace-card', '4.values-options', '4.values-facts', '4.advanced-kept', '4.advanced-old-id', ...NAME_IDS]
  },
  // A release candidate (HI-2587): its profile, .combwork and cw.* ids are moved already, so only what a 1.1 RC still
  // keeps under the old names is checked, besides what every upgrade keeps.
  rc: {
    mark: ['4.settings-saved', '4.workspace-made', '4.values-written'],
    after: ['4.settings-kept', '4.theme-applied', '4.combwork-runs', '4.workspace-moved', '4.workspace-card', '4.values-options', '4.values-facts', ...NAME_IDS]
  },
  // 1.1 and later (HI-2727): Combwork's names already, so nothing is moved; a real workspace (a git project, its cards,
  // a lane and its slot, a connection, advanced overrides at both levels, a skill copy) is carried over as it was.
  combwork: {
    mark: ['4.settings-saved', '4.login-registered', '4.connection-made', '4.workspace-made', '4.advanced-saved', '4.lane-made'],
    after: ['4.settings-kept', '4.theme-applied', '4.combwork-runs', '4.local-kept', '4.login-kept', '4.no-fallback', '4.connection-kept', '4.workspace-kept', '4.workspace-card', '4.workflow-kept', '4.values-facts', '4.advanced-kept', '4.lane-kept', '4.slot-kept', ...NAME_IDS]
  }
}

// What each run kind must produce: the drivers' check ids and facts, and the screenshots.
const REQUIRED = {
  fresh: {
    drivers: {
      s1: { scenario: 1, ids: ['1.start-screen', '1.profile', '2.banner', '2.no-claude-warning', '2.api-providers', '2.agent-setup-opens', '2.agent-setup-three'], facts: ['version'] },
      s3: { scenario: 3, ids: ['3.on-not-found', '3.banner-none-installed', '3.setup-not-installed', '3.user-path', '3.check-again-finds', '3.setup-found', '3.api-installed', '3.banner-gone'], facts: [] },
      s6: { scenario: 6, ids: ['6.workspace-opens', '6.combwork-folder', '6.views'], facts: ['workspaceTree', 'views'] }
    },
    shots: ['s1-desktop.jpg', 's1-installed-apps.jpg', 's1-start-dark.png', 's1-start-light.png', 's1-agent-setup-dark.png', 's1-agent-setup-light.png', 's3-missing-dark.png', 's3-found-dark.png', 's3-found-light.png', 's6-workspace.png', 's6-workspace-overview.png', 's6-skills.png', 's6-mcp-servers.png', 's6-assistant.png', 's5-desktop.jpg']
  },
  // From 1.0 here; required(kind, meta) gives an upgrade's for the era of meta.previousEra (HI-2727).
  upgrade: overPrevious(4, 's4'),
  manual: overPrevious(7, 's7'),
  'upgrade-rc': overPrevious(10, 's10', 'rc'),
  edges: { drivers: { s8: { scenario: 8, ids: ['8.notification'], facts: ['exe'] } }, shots: ['s8-notified.png', 's8-desktop.jpg'] },
  // HI-2592: a new user's first session (drive.cjs clean), then the scan (inside/clean-scan.cjs, its checks clean.cjs's).
  clean: {
    // Each a step a new user takes.
    drivers: { s9: { scenario: 9, ids: ['9.first-run', '9.provider-on', '9.account', '9.workspace', '9.git-project', '9.account-off-here', '9.account-on', '9.agent-started', '9.agent-env', '9.card', '9.settings', '9.diagnostics', '9.export', '9.quit'], facts: ['version', 'workspace', 'exportDir'] } },
    shots: ['s9-desktop.jpg', 's9-start.png', 's9-off-here.png', 's9-agent.png', 's9-board.png', 's9-settings.png']
  },
  // HI-2602: profile-move.ps1's record (PROFILE_MOVE_IDS), not a driver's; the error box and the moved app's window.
  'profile-move': { drivers: {}, shots: ['s11-refused.png', 's11-moved.png', 's11-desktop.jpg'] }
}

/** The edge cases' checks edges.ps1 must record (HI-2460). */
const EDGE_IDS = ['8.wait', '8.wait-unchanged', '8.continues', '8.refuses', '8.refuses-unchanged', '8.running', '8.running-unchanged', '8.uninstall-fails', '8.uninstall-fails-unchanged', '8.moved-at-start', '8.moved-at-start-installed']

/** The profile move's checks profile-move.ps1 must record (HI-2602), in its order. */
const PROFILE_MOVE_IDS = ['11.old-profile', '11.installer-held', '11.refused', '11.refused-unchanged', '11.moved', '11.record', '11.sign-in-checked', '11.sign-in-once']

/** An upgrade over a release of `era` (scenario n, its files' prefix pre): the drivers' checks and shots. */
function overPrevious(n, pre, era = '1.0') {
  const ids = UPGRADE_IDS[era] || UPGRADE_IDS['1.0']
  return {
    drivers: {
      [`${pre}-mark`]: { scenario: n, ids: ids.mark, facts: ['version'] },
      [`${pre}-after`]: { scenario: n, ids: ids.after, facts: ['version'] },
      [`${pre}-notify`]: { scenario: n, ids: [`${n}.notification`], facts: ['exe'] }
    },
    shots: [`${pre}-mark-before-upgrade.png`, `${pre}-desktop-before.jpg`, `${pre}-desktop-after.jpg`, `${pre}-after-after-upgrade-light.png`, `${pre}-after-after-upgrade-dark.png`, `${pre}-toast.jpg`]
  }
}

/** What a run kind must produce in this run: an upgrade's by the era of the release it started from (meta.previousEra). */
function required(kind, meta) {
  if (kind === 'upgrade' || kind === 'manual') {
    const era = ERAS.includes(meta?.previousEra) ? meta.previousEra : '1.0'
    return era === '1.0' ? REQUIRED[kind] : overPrevious(kind === 'upgrade' ? 4 : 7, kind === 'upgrade' ? 's4' : 's7', era)
  }
  return REQUIRED[kind]
}

const entriesOf = s => (s?.uninstallEntries ? [].concat(s.uninstallEntries) : [])
const shortcutsOf = s => (s?.shortcuts ? [].concat(s.shortcuts) : [])
const inDesktop = l => /\\Desktop$/i.test(l.folder)
const inStart = l => /Start Menu\\Programs$/i.test(l.folder)
/** Whether a shortcut's target is `<name>.exe` in its own install folder (Programs\\<name>). */
const exeIn = (target, name) => new RegExp(`\\\\${name}\\\\${name}\\.exe$`, 'i').test(String(target))

/** Shortcuts as a short text: "Combwork (Desktop, Start menu)". */
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
    const req = required(kind, meta).drivers[key]
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
  const app = meta.app || OLD_APP
  let asarNote = null

  const unknown = ran.filter(k => !KINDS.includes(k))
  if ((!asked.length) || unknown.length) add(0, 'The scenarios asked for ran', false, unknown.length ? `unknown: ${unknown.join(', ')}` : 'none ran')
  // Every step the runner took must have succeeded: a failed command or timeout fails the report.
  for (const s of meta.steps || []) add(s.scenario, `Step: ${s.what}`, s.ok, s.detail)
  for (const kind of ran.filter(k => KINDS.includes(k))) {
    for (const shot of required(kind, meta).shots) if (!(meta.shots || []).includes(shot)) add(Number(/^s(\d+)/.exec(shot)?.[1]) || 0, `Screenshot ${shot} collected`, false, 'missing')
  }

  if (ran.includes('fresh')) {
    const run = need(1, 's1-run')
    const st = need(1, 's1-state')
    if (run) add(1, `Silent install (/S) succeeds (${run.seconds} s)`, run.exitCode === 0, `exit ${run.exitCode}`)
    if (st) {
      const e = entriesOf(st)
      add(1, `One Installed-apps entry: "${app.productName} ${version}"`, e.length === 1 && e[0].displayName === `${app.productName} ${version}`, JSON.stringify(e.map(x => x.displayName)))
      add(1, `Installed in %LOCALAPPDATA%\\Programs\\${app.exeName} (${app.exeName}.exe, Uninstall ${app.exeName}.exe)`, st.installDir?.hasExe && st.installDir?.uninstaller && st.installDir?.exe === `${app.exeName}.exe`, JSON.stringify(st.installDir))
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

  const eraOf = kind => (kind === 'upgrade-rc' ? 'rc' : ERAS.includes(meta.previousEra) ? meta.previousEra : '1.0')
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
      add(n, `--force-run starts ${app.exeName}.exe after the install`, newRun.installedRunning === true && [].concat(newRun.running || []).includes('combwork'), `running: ${JSON.stringify(newRun.running)}`)
      add(n, 'The 1.0 app no longer runs', ![].concat(newRun.running || []).includes('old'), `running: ${JSON.stringify(newRun.running)}`)
    }
    if (newSt) {
      const e = entriesOf(newSt)
      // HI-2460: the 1.0 app's entry gone, one of the new app's: "nobody ends up with both installed".
      // Its key is the new app ID's (it.surmise.combwork's APP_GUID), whatever the display name says.
      add(n, `One Installed-apps entry after the upgrade: "${app.productName} ${version}", Combwork's own (${COMBWORK_GUID}), none of the 1.0 app's`, e.length === 1 && e[0].displayName === `${app.productName} ${version}` && String(e[0].key).toLowerCase() === COMBWORK_GUID, `before: ${JSON.stringify(prevNames)}; after: ${JSON.stringify(e.map(x => x.displayName))}`)
      const l = shortcutsOf(newSt)
      add(n, `Shortcuts: only "${app.shortcutName}", starting ${app.exeName}.exe, on the Desktop and in the Start menu (before: ${describeShortcuts(shortcutsOf(prevSt))})`, l.length >= 2 && l.every(x => x.name === app.shortcutName && exeIn(x.target, app.exeName)) && l.some(inDesktop) && l.some(inStart), describeShortcuts(l))
      const ins = newSt.installs || {}
      add(n, `Installed in %LOCALAPPDATA%\\Programs\\${app.exeName}; the 1.0 app's folder gone`, ins.combwork?.hasExe === true && ins.old?.exists === false, JSON.stringify(ins))
      add(n, `The installed app code is the new build's (app.asar ${String(ins.combwork?.appAsarSha256).slice(0, 12)}…)`, !!ins.combwork?.appAsarSha256, JSON.stringify(ins.combwork))
      const pr = newSt.profiles || {}
      const folders = JSON.stringify({ roaming: [pr.roamingCombwork?.exists, pr.roamingOld?.exists], local: [pr.localCombwork?.exists, pr.localOld?.exists] })
      const byInstaller = /"by"\s*:\s*"installer"/.test(String(pr.localCombwork?.record))
      // From 1.0 the installer moves its profile folders (HI-2461); from 1.1 on there is nothing of 1.0's to move (HI-2727).
      if (eraOf(kind) === 'combwork') {
        add(n, 'The profile folders kept where they were: %APPDATA%\\Combwork and %LOCALAPPDATA%\\Combwork, none of the 1.0 app\'s made', pr.roamingCombwork?.exists && pr.localCombwork?.exists && !pr.roamingOld?.exists && !pr.localOld?.exists, folders)
        add(n, 'No profile move by the installer (nothing of 1.0\'s to move): no record in %LOCALAPPDATA%\\Combwork', !byInstaller, String(pr.localCombwork?.record))
      } else {
        add(n, 'The profile folders moved: %APPDATA%\\Combwork and %LOCALAPPDATA%\\Combwork, none of the 1.0 app\'s left', pr.roamingCombwork?.exists && pr.localCombwork?.exists && !pr.roamingOld?.exists && !pr.localOld?.exists, folders)
        add(n, "The installer's record is in %LOCALAPPDATA%\\Combwork", byInstaller, String(pr.localCombwork?.record))
      }
      const run = [].concat(newSt.run || [])
      add(n, "The 1.0 app's Launch at login removed by the installer", !run.some(v => String(v.command).toLowerCase().includes(`\\${OLD_APP.exeName}.exe`.toLowerCase())), JSON.stringify(run))
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

  if (ran.includes('clean')) {
    const run = need(9, 's9-run')
    if (run) add(9, `Silent install (/S) on a Windows that never had Combwork or the app before it (${run.seconds} s)`, run.exitCode === 0, `exit ${run.exitCode}`)
    driver('clean', 's9')
    const scan = need(9, 's9-scan')
    if (scan) {
      const asar = cleanChecks(scan, (id, name, ok, detail) => add(9, name, ok, detail))
      asarNote = `**app.asar** holds ${asar.total} hit(s) of the old name (${asar.files.map(a => `${a.place}: ${a.count}`).join(', ') || 'none found'}): counted, not failed. The app's own code, with the upgrade code that knows the 1.0 names. The bundled code in app.asar.unpacked (${Number(scan.code) || 0} file(s)) is named, not read: which code may name the old name is the repository's name guard's job (tests/oldNames.mjs, HI-2647).`
    }
  }

  if (ran.includes('profile-move')) {
    const prev = need(11, 's11-prev-run')
    if (prev) add(11, `The 1.0 app installs (${prev.seconds} s)`, prev.exitCode === 0, `exit ${prev.exitCode}`)
    const m = need(11, 's11-profile')
    if (m) {
      if (m.completed !== true) add(11, 'profile-move.ps1 finished', false, 'it stopped before the end')
      const list = [].concat(m.checks || [])
      for (const c of list) add(11, c.name, c.ok === true, c.detail)
      for (const id of PROFILE_MOVE_IDS) if (!list.some(c => c.id === id)) add(11, `profile move check "${id}" ran`, false, 'missing from s11-profile.json')
    }
  }

  for (const id of meta.leftRunning || []) add(0, `CLEANUP: Sandbox ${id} confirmed stopped`, false, `CLEANUP NOT CONFIRMED: Sandbox ${id} may still be running`)
  if (!checks.length && !notRun.length) add(0, 'At least one check ran', false, 'nothing was checked')

  const passed = checks.filter(c => c.ok).length
  const differences = asarNote ? [asarNote] : []
  // A kind left out for the previous release (HI-2727: the profile move is 1.0's): a note, never a silent gap.
  for (const [kind, why] of Object.entries(meta.skipped || {})) differences.push(`**${kind}** ${why}.`)
  if (meta.previousEra && (ran.includes('upgrade') || ran.includes('manual'))) differences.push(`The upgrade starts from **${meta.previousVersion}**, ${meta.previousEra === 'combwork' ? "already under Combwork's names: its data is checked carried over as it was, nothing renamed" : meta.previousEra === 'rc' ? 'a 1.1 release candidate: what it still keeps under the old names is checked moved' : "under 1.0's names: the names upgrade and the profile move are checked"}.`)
  if ((ran.includes('upgrade') || ran.includes('manual')) && meta.previousVersion === meta.installerVersion) {
    differences.push(`The previous release and this build both say **${meta.installerVersion}**: the in-app updater (no downgrades, only newer versions) would not offer this build, so the upgrade check is a reinstall over it, run by hand with the updater's arguments. The previous release's "updated to …" notice can't show.`)
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
  // Scenario 9's hits, each with its place and text (HI-2592).
  const hits = hitsMarkdown(r.files?.['s9-scan'])
  if (hits.length) lines.push('## 9. Where the old name was found', '', ...hits)
  if (r.differences.length) lines.push('## Notes and fresh-install differences', '', ...r.differences.map(d => `- ${d}`), '')
  if (m.timings && Object.keys(m.timings).length) lines.push('## Timings', '', ...Object.entries(m.timings).map(([k, v]) => `- ${k}: ${v}`), '')
  if (m.shots?.length) lines.push('## Screenshots', '', ...m.shots.map(s => `- [${s}](${encodeURI(s)})`), '')
  return lines.join('\n')
}

module.exports = { evaluate, markdown, verdict, required, SCENARIOS, KINDS, REQUIRED, UPGRADE_IDS, ERAS, COMBWORK_GUID, PROFILE_MOVE_IDS }
