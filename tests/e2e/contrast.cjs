// Text on Combwork's amber reads at WCAG AA (4.5:1) in both themes, measured as drawn (computed colours in the window):
// - menus (#362): a hovered or keyboard-chosen entry, and the command palette's chosen row: its label, icon, shortcut
//   and second line on the fill, a greyed entry's label too, and Recent's ✕; on a real context menu (a project's, in
//   the sidebar) with entries of each kind added to it. A session action's entry keeps its own wash (#344);
// - the status bar (#384): its items resting and hovered, a secondary part, and the caution, warning, update and
//   update-ready items (added beside its own); the activity bar's and a project's count badges.
// Throwaway profile and workspace, quiet; no agent is started. Empty Claude Code and Codex homes of its own: Combwork looks
// for both CLIs when it starts, and their sign-in checks must never read the user's.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'contrast-profile')
const ws = path.join(lib.WORK, 'contrast-ws')
const homes = { CLAUDE_CONFIG_DIR: path.join(lib.WORK, 'contrast-claude-home'), CODEX_HOME: path.join(lib.WORK, 'contrast-codex-home') }
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/**
 * In the window: each listed part of an element against the element's own background, as contrast ratios. Colours as
 * computed (rgb(), or color(srgb …) for a mix), a translucent background laid over the nearest one under it.
 */
function measure([selector, parts]) {
  const parse = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c)
    if (m) {
      const [r, g, b, a = 1] = m[1].split(',').map(Number)
      return [r, g, b, a]
    }
    const s = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/.exec(c)
    return s ? [s[1] * 255, s[2] * 255, s[3] * 255, s[4] === undefined ? 1 : Number(s[4])] : null
  }
  const over = (top, bottom) => top.slice(0, 3).map((v, i) => v * top[3] + bottom[i] * (1 - top[3]))
  const lum = (c) => {
    const [r, g, b] = c.map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
    return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100
  }
  const el = document.querySelector(selector)
  if (!el) return null
  // What shows through a translucent background: the nearest ancestor that paints one.
  let under = el.parentElement
  while (under && parse(getComputedStyle(under).backgroundColor)?.[3] === 0) under = under.parentElement
  const panel = under ? parse(getComputedStyle(under).backgroundColor) : [255, 255, 255, 1]
  const bg = over(parse(getComputedStyle(el).backgroundColor), panel)
  const out = { background: bg.map(Math.round) }
  // A part's colour as seen: its alpha times the opacity of it and its parents up to the measured element. A part
  // with a fill of its own (a key's) is read on that fill, over the element's (#446).
  const seen = (part, fill) => {
    const c = parse(getComputedStyle(part).color)
    for (let n = part; n && n !== el.parentElement; n = n.parentElement) c[3] *= Number(getComputedStyle(n).opacity)
    return over(c, fill)
  }
  const fillOf = (part) => {
    const f = part === el ? null : parse(getComputedStyle(part).backgroundColor)
    return f && f[3] > 0 ? over(f, bg) : bg
  }
  for (const p of parts) {
    const part = p === '' ? el : el.querySelector(p)
    out[p || 'label'] = part ? ratio(seen(part, fillOf(part)), fillOf(part)) : null
  }
  return out
}

;(async () => {
  for (const d of [userData, ws, ...Object.values(homes)]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(path.join(ws, 'demo'), { recursive: true })
  for (const d of Object.values(homes)) fs.mkdirSync(d, { recursive: true })
  const { app, page, inv } = await lib.launch({ userData, env: homes, viewport: { width: 1000, height: 700 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  const shot = (name, clip) => page.screenshot({ path: path.join(lib.WORK, `contrast-${name}.png`), ...(clip ? { clip } : {}) })
  /** Every listed part reaches 4.5:1 (a part that isn't there doesn't count). */
  const allAA = (r) => !!r && Object.entries(r).every(([k, v]) => k === 'background' || v === null || v >= 4.5)

  for (const theme of ['light', 'dark']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.sleep(300)
    // A real menu: the project's, in the sidebar. Then entries of each kind beside its own, drawn by the same rules.
    await page.mouse.move(5, 5)
    await page.locator('.project-row', { hasText: 'demo' }).first().click({ button: 'right' })
    const menu = page.locator('.menu').first()
    check(`${theme}: the project's menu opens`, !!(await lib.until(async () => (await menu.count()) === 1, 5000)))
    await menu.evaluate((m) => {
      const add = (cls, html) => {
        const d = document.createElement('div')
        d.className = cls
        d.innerHTML = html
        m.appendChild(d)
        return d
      }
      add('menu-item two-line probe-detail', '<i class="codicon codicon-history"></i><span class="menu-text"><span class="menu-label">A session</span><span class="menu-detail">2 hours ago · cache expired</span></span><span class="menu-key">Ctrl+R</span>')
      add('menu-item muted two-line probe-muted', '<i class="codicon codicon-circle-filled"></i><span class="menu-text"><span class="menu-label">Open in Builder</span><span class="menu-detail">open in Builder — click to show it</span></span>')
      add('menu-item recent-item probe-recent', '<i class="codicon codicon-folder"></i><span>work</span><span class="menu-key">2 projects</span><button class="recent-remove"><i class="codicon codicon-close"></i></button>')
      add('menu-item act-resume probe-action', '<i class="codicon codicon-debug-continue"></i><span class="menu-text"><span class="menu-label">Resume</span><span class="menu-detail">the last session</span></span>')
    })
    const parts = ['', '.codicon', '.menu-key', '.menu-detail', '.menu-label']
    // Hovered: one of the menu's own plain entries (not a session action's), then each added one.
    const plain = menu.locator('.menu-item', { hasText: 'Project Settings' })
    await plain.evaluate((d) => d.setAttribute('data-probe', 'own'))
    await plain.hover()
    await lib.sleep(150)
    const own = await page.evaluate(measure, ['.menu [data-probe="own"]', ['', '.codicon']])
    check(`${theme}: a hovered entry's label and icon reach 4.5:1`, !!own && own.label >= 4.5 && own['.codicon'] >= 4.5, JSON.stringify(own))
    for (const [probe, what, want] of [
      ['.probe-detail', 'label, icon, shortcut and second line', parts],
      ['.probe-muted', "a greyed entry's label and second line", ['.menu-label', '.menu-detail', '.codicon']],
      ['.probe-recent', "a Recent entry's name, note and ✕", ['', '.menu-key', '.recent-remove']],
      ['.probe-action', "a session action's label and second line, on its own wash", ['.menu-label', '.menu-detail', '.codicon']]
    ]) {
      await page.locator(probe).hover()
      await lib.sleep(150)
      const r = await page.evaluate(measure, [`.menu ${probe}`, want])
      const low = r && Object.entries(r).filter(([k, v]) => k !== 'background' && v !== null && v < 4.5)
      check(`${theme}: hovered, ${what} reach 4.5:1`, !!r && low.length === 0, JSON.stringify(r))
      if (probe === '.probe-detail') await shot(`${theme}-menu-hover`)
    }
    // Chosen from the keyboard (.active): the same fill.
    await page.mouse.move(5, 5)
    await page.locator('.probe-detail').evaluate((d) => d.classList.add('active'))
    const active = await page.evaluate(measure, ['.menu .probe-detail', parts])
    check(`${theme}: chosen from the keyboard, every part reaches 4.5:1`, !!active && Object.entries(active).every(([k, v]) => k === 'background' || v === null || v >= 4.5), JSON.stringify(active))
    await page.keyboard.press('Escape')
    await lib.until(async () => (await menu.count()) === 0, HUNG_MS)

    // The command palette's chosen row: its label, category and shortcut, a command with one chosen (#446: the key on
    // its own fill).
    await page.keyboard.press('Control+Shift+P')
    const row = page.locator('.palette-item.active')
    check(`${theme}: the palette opens with a chosen row`, !!(await lib.until(async () => (await row.count()) === 1, 5000)))
    await page.locator('.palette input').fill('Show Task Board')
    await lib.until(async () => (await row.locator('kbd').count()) === 1, HUNG_MS)
    const pal = await page.evaluate(measure, ['.palette-item.active', ['', '.cat', 'kbd']])
    check(`${theme}: the palette's chosen row reaches 4.5:1 (label, category, shortcut)`, !!pal && pal.kbd !== null && Object.entries(pal).every(([k, v]) => k === 'background' || v === null || v >= 4.5), JSON.stringify(pal))
    await shot(`${theme}-palette`)
    // The first Escape clears the box (#433), the next closes the palette.
    await page.keyboard.press('Escape')
    if (await page.locator('.palette').count()) await page.keyboard.press('Escape')
    await lib.sleep(200)

    // The status bar (#384): one of its own items, resting and hovered; then items of each kind added beside them.
    const bar = page.locator('.statusbar')
    const item = bar.locator('.status-item:not(.warn):not(.caution):not(.update-item)').first()
    await item.evaluate((d) => d.setAttribute('data-probe', 'status'))
    await page.mouse.move(5, 5)
    await lib.sleep(150)
    const rest = await page.evaluate(measure, ['.statusbar [data-probe="status"]', ['']])
    check(`${theme}: a status bar item reaches 4.5:1`, allAA(rest), JSON.stringify(rest))
    await item.hover()
    await lib.sleep(150)
    const hovered = await page.evaluate(measure, ['.statusbar [data-probe="status"]', ['']])
    check(`${theme}: hovered, a status bar item reaches 4.5:1`, allAA(hovered), JSON.stringify(hovered))
    await page.mouse.move(5, 5)
    await bar.evaluate((b) => {
      const add = (cls, html) => {
        const d = document.createElement('div')
        d.className = cls
        d.innerHTML = html
        b.appendChild(d)
      }
      add('status-item probe-sub', '<i class="codicon codicon-pulse"></i><span>Claude Code</span><span class="status-sub">5h 55%</span>')
      add('status-item caution probe-caution', '<i class="codicon codicon-bell"></i><span>2 need you</span>')
      add('status-item warn probe-warn', '<i class="codicon codicon-warning"></i><span>Git</span>')
      add('status-item update-item probe-update', '<i class="codicon codicon-cloud-download"></i><span>Update 40%</span>')
      add('status-item update-item ready probe-ready', '<i class="codicon codicon-arrow-circle-up"></i><span>Restart to update</span>')
    })
    for (const [probe, what, want] of [
      ['.probe-sub', 'a secondary part', ['', '.status-sub']],
      ['.probe-caution', 'a caution item', ['', '.codicon']],
      ['.probe-warn', 'a warning item', ['', '.codicon']],
      ['.probe-update', 'an update item', ['', '.codicon']],
      ['.probe-ready', 'an update-ready item', ['', '.codicon']]
    ]) {
      const r = await page.evaluate(measure, [`.statusbar ${probe}`, want])
      check(`${theme}: ${what} in the status bar reaches 4.5:1`, allAA(r), JSON.stringify(r))
      // Hovered too: these keep their own background.
      await page.locator(probe).hover()
      await lib.sleep(120)
      const h = await page.evaluate(measure, [`.statusbar ${probe}`, want])
      check(`${theme}: hovered, ${what} in the status bar reaches 4.5:1`, allAA(h), JSON.stringify(h))
    }
    await page.mouse.move(5, 5)
    await lib.sleep(120)
    const vp = page.viewportSize()
    await shot(`${theme}-statusbar`, { x: 0, y: vp.height - 60, width: vp.width, height: 60 })

    // The count badges: the activity bar's and a project's (#384), added where Combwork shows them.
    await page.evaluate(() => {
      const a = document.querySelector('.activitybar .activity-btn')
      const s = document.createElement('span')
      s.className = 'activity-badge probe-activity'
      s.textContent = '3'
      a?.appendChild(s)
      const project = document.querySelector('.project-row')
      const n = document.createElement('span')
      n.className = 'project-need-count probe-need'
      n.textContent = '2'
      project?.appendChild(n)
    })
    for (const [probe, what] of [['.probe-activity', "the activity bar's count"], ['.probe-need', "a project's needs-you count"]]) {
      const r = await page.evaluate(measure, [probe, ['']])
      check(`${theme}: ${what} reaches 4.5:1`, allAA(r), JSON.stringify(r))
    }
    await shot(`${theme}-badges`, { x: 0, y: 0, width: 340, height: 240 })

    // A plain button keeps an edge on a row that colours when hovered (#1304: Antivirus scanning's Add Exclusions… was
    // only its fill, and a hovered setting row is within a shade of it in dark; on a white page in light, at rest too).
    // Its border or its fill against the row behind it, resting and hovered: at least 1.2:1, as a subtle button's edge
    // is; a primary button keeps its fill and no edge. Rows of each kind added to Settings, a button in each.
    await page.locator('.activity-btn[aria-label="Settings"]').click()
    const content = page.locator('.settings-content')
    check(`${theme}: Settings opens`, !!(await lib.until(async () => (await content.count()) === 1, HUNG_MS)))
    const rowKinds = ['setting', 'row', 'session-row', 'inbox-row', 'journal-row', 'running-row clickable']
    await content.evaluate((c, kinds) => {
      for (const [i, kind] of kinds.entries()) {
        const r = document.createElement('div')
        r.className = `${kind} probe-btnrow probe-btnrow-${i}`
        r.style.padding = '12px'
        r.innerHTML = '<span class="s-text">A setting</span><button class="btn small probe-plain">Add Exclusions…</button> <button class="btn small subtle">About Dev Drive</button> <button class="btn small primary probe-primary">Turn on</button>'
        c.prepend(r)
      }
    }, rowKinds)
    const edge = (selector) =>
      page.evaluate((sel) => {
        const parse = (c) => {
          const v = /rgba?\(([^)]+)\)/.exec(c)?.[1].split(',').map(Number) ?? [0, 0, 0, 0]
          return [v[0], v[1], v[2], v[3] === undefined ? 1 : v[3]]
        }
        const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3]))
        const lum = (c) => {
          const [r, g, b] = c.map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4))
          return 0.2126 * r + 0.7152 * g + 0.0722 * b
        }
        const ratio = (a, b) => {
          const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
          return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100
        }
        const btn = document.querySelector(sel)
        if (!btn) return null
        // What the button sits on: the nearest ancestor that paints, laid over the ones under it.
        const chain = []
        for (let n = btn.parentElement; n; n = n.parentElement) chain.push(parse(getComputedStyle(n).backgroundColor))
        const behind = chain.reverse().reduce((under, c) => over(c, under), [255, 255, 255])
        const st = getComputedStyle(btn)
        const fill = over(parse(st.backgroundColor), behind)
        return { border: ratio(over(parse(st.borderTopColor), behind), behind), fill: ratio(fill, behind), borderAlpha: parse(st.borderTopColor)[3] }
      }, selector)
    for (const [i, kind] of rowKinds.entries()) {
      const probeRow = page.locator(`.probe-btnrow-${i}`)
      for (const hover of [false, true]) {
        if (hover) await probeRow.hover({ position: { x: 4, y: 4 } })
        else await page.mouse.move(5, 5)
        const want = hover ? 'hovered' : 'resting'
        // Measured once the row is drawn as wanted: painted when hovered, clear at rest.
        const painted = await lib.until(async () => hover === !/^rgba\(0, 0, 0, 0\)$/.test(await probeRow.evaluate((r) => getComputedStyle(r).backgroundColor)), HUNG_MS)
        check(`${theme}: a ${want} .${kind.split(' ')[0]} is drawn ${hover ? 'with' : 'without'} its hover colour`, !!painted)
        const e = await edge(`.probe-btnrow-${i} .probe-plain`)
        check(`${theme}: a plain button keeps its edge on a ${want} .${kind.split(' ')[0]}`, !!e && Math.max(e.border, e.fill) >= 1.2, JSON.stringify(e))
        const p = await edge(`.probe-btnrow-${i} .probe-primary`)
        check(`${theme}: a primary button on a ${want} .${kind.split(' ')[0]} keeps its fill and no edge`, !!p && p.borderAlpha === 0 && p.fill >= 1.2, JSON.stringify(p))
        if (kind === 'setting') await shot(`${theme}-setting-${want}`, await probeRow.boundingBox())
      }
    }
    await page.evaluate(() => document.querySelectorAll('.probe-btnrow').forEach((e) => e.remove()))
    await page.mouse.move(5, 5)
    await page.locator('.activity-btn[aria-label="Projects"]').click()

    // The text greys and the accent as text (#421) on every background text sits on, hovered and selected rows too, and
    // the accent as text on its own tint over each (a badge, an active button): 4.5:1. The status dots (their fill, the
    // idle one's ring), resting and at the height of their pulse: 3:1, as icons need; and the pulse never fades (opacity).
    // As computed, from the theme's tokens.
    const tokens = await page.evaluate(() => {
      const parse = (c) => {
        const v = /rgba?\(([^)]+)\)/.exec(c)?.[1].split(',').map(Number) ?? [0, 0, 0]
        return [v[0], v[1], v[2], v[3] === undefined ? 1 : v[3]]
      }
      const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3]))
      const lum = (c) => {
        const [r, g, b] = c.slice(0, 3).map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4))
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
      }
      const ratio = (a, b) => {
        const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
        return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100
      }
      const low = []
      const root = getComputedStyle(document.documentElement)
      const shade = Number(root.getPropertyValue('--pulse-shade')) || 1
      // The pulse: a change of shade (brightness), never of opacity.
      const pulse = [...document.styleSheets].flatMap((sh) => [...sh.cssRules]).find((r) => r instanceof CSSKeyframesRule && r.name === 'pulse')
      if (!pulse) low.push('no pulse keyframes')
      else if (/opacity/.test(pulse.cssText)) low.push(`the pulse fades: ${pulse.cssText.replace(/\s+/g, ' ')}`)
      for (const bg of ['--bg', '--bg-sidebar', '--bg-elevated', '--bg-input', '--bg-hover', '--bg-active']) {
        const box = document.createElement('div')
        box.style.background = `var(${bg})`
        document.body.appendChild(box)
        const under = parse(getComputedStyle(box).backgroundColor)
        const tint = document.createElement('div')
        tint.style.background = 'var(--accent-soft)'
        box.appendChild(tint)
        const tinted = over(parse(getComputedStyle(tint).backgroundColor), under)
        for (const fg of ['--fg-muted', '--fg-faint', '--accent-ink']) {
          const t = document.createElement('span')
          t.style.color = `var(${fg})`
          box.appendChild(t)
          const c = parse(getComputedStyle(t).color)
          const r = ratio(c, under)
          if (r < 4.5) low.push(`${fg} on ${bg}: ${r}`)
          if (fg === '--accent-ink' && ratio(c, tinted) < 4.5) low.push(`${fg} on --accent-soft over ${bg}: ${ratio(c, tinted)}`)
        }
        for (const s of ['stopped', 'idle', 'starting', 'working', 'background', 'watching', 'waiting', 'finished', 'error', 'signin']) {
          const d = document.createElement('span')
          d.className = `dot ${s}`
          box.appendChild(d)
          const st = getComputedStyle(d)
          // A ring (idle, watching) is drawn in its border or shadow; the rest in their fill.
          const fill = parse(s === 'idle' ? st.borderTopColor : s === 'watching' ? (/rgba?\([^)]+\)/.exec(st.boxShadow)?.[0] ?? '') : st.backgroundColor)
          const pulsing = st.animationName === 'pulse'
          // At the height of its pulse: brightness(shade) scales each channel (clamped).
          const shaded = [...fill.slice(0, 3).map((v) => Math.min(255, v * shade)), fill[3]]
          const r = Math.min(ratio(over(fill, under), under), pulsing ? ratio(over(shaded, under), under) : Infinity)
          if (r < 3 || Number(st.opacity) < 1) low.push(`dot ${s} on ${bg}: ${r}${pulsing ? ' (with its pulse)' : ''}${Number(st.opacity) < 1 ? ` at opacity ${st.opacity}` : ''}`)
        }
        // The agent-state marks (#973): the ring in its border, the rest in their fill; the working dot through its pulse.
        for (const s of ['waiting', 'stalled', 'working', 'idle']) {
          const d = document.createElement('span')
          d.className = `state-mark ${s}`
          box.appendChild(d)
          const st = getComputedStyle(d)
          const fill = parse(s === 'idle' ? st.borderTopColor : st.backgroundColor)
          const pulsing = st.animationName === 'pulse'
          const shaded = [...fill.slice(0, 3).map((v) => Math.min(255, v * shade)), fill[3]]
          const r = Math.min(ratio(over(fill, under), under), pulsing ? ratio(over(shaded, under), under) : Infinity)
          if (r < 3 || Number(st.opacity) < 1) low.push(`state mark ${s} on ${bg}: ${r}${pulsing ? ' (with its pulse)' : ''}`)
        }
        box.remove()
      }
      return low
    })
    check(`${theme}: muted and faint text and the accent as text reach 4.5:1 (on its tint too), every status dot and state mark 3:1 through its pulse, on every background (#421, #973)`, tokens.length === 0, tokens.join('; '))
    await page.evaluate(() => document.querySelectorAll('.probe-sub, .probe-caution, .probe-warn, .probe-update, .probe-ready, .probe-activity, .probe-need').forEach((e) => e.remove()))
  }

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
