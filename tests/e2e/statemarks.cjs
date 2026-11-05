// The agent-state marks (#973), drawn by the window's own styles in both themes: four states, each its own shape
// (a diamond, a square, a dot, a ring) as well as its own colour, named for screen readers; the working dot pulses,
// and holds still under reduced motion. Shown through StateMark's test hook (the session page doesn't show them yet),
// with a screenshot of each theme. Their contrast on every background is the contrast suite's.
// Throwaway profile and workspace, quiet; no agent is started. Empty Claude Code and Codex homes of its own: Combwork looks
// for both CLIs when it starts, and their sign-in checks must never read the user's.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'statemarks-profile')
const ws = path.join(lib.WORK, 'statemarks-ws')
const homes = { CLAUDE_CONFIG_DIR: path.join(lib.WORK, 'statemarks-claude-home'), CODEX_HOME: path.join(lib.WORK, 'statemarks-codex-home') }
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** In the window: each mark of the gallery as drawn (its name, shape and colour). */
function marks() {
  return [...document.querySelectorAll('.state-mark-gallery .state-mark')].map((m) => {
    const st = getComputedStyle(m)
    const state = ['waiting', 'stalled', 'working', 'idle'].find((s) => m.classList.contains(s))
    return {
      state,
      role: m.getAttribute('role'),
      label: m.getAttribute('aria-label'),
      rotated: st.transform !== 'none',
      round: st.borderTopLeftRadius === '50%',
      filled: !/rgba\(0, 0, 0, 0\)|transparent/.test(st.backgroundColor),
      ring: st.borderTopStyle === 'solid' && parseFloat(st.borderTopWidth) > 0,
      colour: state === 'idle' ? st.borderTopColor : st.backgroundColor,
      animation: st.animationName,
      size: [m.getBoundingClientRect().width, m.getBoundingClientRect().height].map(Math.round)
    }
  })
}

;(async () => {
  for (const d of [userData, ws, ...Object.values(homes)]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(path.join(ws, 'demo'), { recursive: true })
  for (const d of Object.values(homes)) fs.mkdirSync(d, { recursive: true })
  const { app, page, inv } = await lib.launch({ userData, env: homes, viewport: { width: 900, height: 600 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    check('the test hook is there', await page.evaluate(() => typeof window.__cwStateMarks === 'function'))

    for (const theme of ['light', 'dark']) {
      await inv('settings:update', { appearance: { theme } })
      check(`${theme}: the theme is applied`, !!(await lib.until(() => page.evaluate((t) => document.documentElement.dataset.theme === t, theme), HUNG_MS)))
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await page.evaluate(() => {
        window.__stateMarksDone = window.__cwStateMarks()
      })
      await lib.until(async () => (await page.locator('.state-mark-gallery .state-mark').count()) === 4, HUNG_MS)
      const m = Object.fromEntries((await page.evaluate(marks)).map((x) => [x.state, x]))
      check(`${theme}: four marks, most urgent first`, Object.keys(m).join() === 'waiting,stalled,working,idle', Object.keys(m).join())
      check(
        `${theme}: each is named by its state for screen readers`,
        Object.values(m).every((x) => x.role === 'img') && [m.waiting?.label, m.stalled?.label, m.working?.label, m.idle?.label].join('|') === 'Waiting for you|Stalled|Working|Idle',
        JSON.stringify(Object.values(m).map((x) => [x.role, x.label]))
      )
      check(`${theme}: waiting is a diamond (a square turned 45°)`, !!m.waiting && m.waiting.rotated && !m.waiting.round && m.waiting.filled, JSON.stringify(m.waiting))
      check(`${theme}: stalled is a square`, !!m.stalled && !m.stalled.rotated && !m.stalled.round && m.stalled.filled, JSON.stringify(m.stalled))
      check(`${theme}: working is a filled dot that pulses`, !!m.working && m.working.round && m.working.filled && m.working.animation === 'pulse', JSON.stringify(m.working))
      check(`${theme}: idle is a ring`, !!m.idle && m.idle.round && !m.idle.filled && m.idle.ring, JSON.stringify(m.idle))
      check(`${theme}: four colours, one per state`, new Set(Object.values(m).map((x) => x.colour)).size === 4, JSON.stringify(Object.values(m).map((x) => x.colour)))
      check(`${theme}: each about as large as the others (8 to 12 px)`, Object.values(m).every((x) => x.size.every((v) => v >= 8 && v <= 12)), JSON.stringify(Object.values(m).map((x) => x.size)))
      const box = await page.locator('.state-mark-gallery').boundingBox()
      if (box) await page.screenshot({ path: path.join(lib.WORK, `statemarks-${theme}.png`), clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 } })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      check(`${theme}: under reduced motion, the working dot holds still`, !!(await lib.until(() => page.evaluate(() => getComputedStyle(document.querySelector('.state-mark-gallery .state-mark.working')).animationName === 'none'), HUNG_MS)))
      await page.evaluate(() => window.__stateMarksDone())
      check(`${theme}: the gallery is removed`, (await page.locator('.state-mark-gallery').count()) === 0)
    }
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
