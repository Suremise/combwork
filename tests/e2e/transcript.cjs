// Sessions tab transcript viewer, in a throwaway profile and workspace. Transcripts are Combwork backups
// (.combwork/sessions), so nothing is read from or written to the real ~/.claude. Never touches the clipboard.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { sessionsOf } = require('./storeDocs.cjs')

const scratch = lib.WORK
const userData = path.join(scratch, 'tprofile')
const ws = path.join(scratch, 'tws')
const shots = path.join(scratch, 'tshots')
for (const d of [userData, ws, shots]) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync(shots, { recursive: true })
const proj = path.join(ws, 'demo')
const sessDir = path.join(proj, '.combwork', 'sessions')
fs.mkdirSync(sessDir, { recursive: true })

const A = '11111111-aaaa-bbbb-cccc-000000000001' // synthetic
const B = '22222222-aaaa-bbbb-cccc-000000000002' // generated: a long session (1,200 turns)
// A 1×1 PNG: enough for the thumbnail and viewer.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const t = (m) => `2026-09-29T10:${String(m).padStart(2, '0')}:00.000Z`
const usage = (n) => ({ input_tokens: 5, cache_read_input_tokens: n, cache_creation_input_tokens: 100, output_tokens: 50 })
const lines = [
  { type: 'user', timestamp: t(0), message: { role: 'user', content: 'Please fix the flaky zebra test in login.spec.ts' } },
  { type: 'assistant', requestId: 'r1', timestamp: t(1), message: { model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: 'The zebra test probably races the timer.' }], usage: usage(1000) } },
  { type: 'assistant', requestId: 'r1', timestamp: t(1), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: "I'll look at the **test** first.\n\n```ts\nconst x = 1\n```" }], usage: usage(1000) } },
  { type: 'assistant', requestId: 'r1', timestamp: t(1), message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test -- login', description: 'Run the login tests' } }], usage: usage(1000) } },
  { type: 'user', timestamp: t(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'FAIL login.spec.ts\n  zebra timed out\n' + 'x'.repeat(6000) }] } },
  { type: 'assistant', requestId: 'r2', timestamp: t(3), message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'tu2', name: 'Edit', input: { file_path: proj + '\\login.spec.ts', old_string: 'wait(10)', new_string: 'wait(100)' } }], usage: usage(2000) } },
  { type: 'user', timestamp: t(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'The file has been updated.' }] } },
  { type: 'assistant', requestId: 'r3', timestamp: t(4), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Fixed: the zebra test now waits long enough.' }], usage: usage(2500) } },
  { type: 'user', timestamp: t(5), message: { role: 'user', content: [{ type: 'text', text: '[Image #1] this is what I see now' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] } },
  { type: 'user', isMeta: true, timestamp: t(5), message: { role: 'user', content: [{ type: 'text', text: `[Image: source: ${proj}\\.combwork\\images\\${A}\\shot.png]` }] } },
  { type: 'assistant', requestId: 'r4', timestamp: t(6), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'That looks right.' }], usage: usage(3000) } },
  { type: 'system', subtype: 'compact_boundary', timestamp: t(7), content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 180000, postTokens: 9000 } },
  { type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, timestamp: t(7), message: { role: 'user', content: 'Summary:\n1. We fixed the zebra test by waiting longer.' } },
  { type: 'user', timestamp: t(7), message: { role: 'user', content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep the test notes</command-args>' } },
  { type: 'user', timestamp: t(7), message: { role: 'user', content: '<local-command-stdout>\u001b[2mCompacted\u001b[22m</local-command-stdout>' } },
  { type: 'assistant', requestId: 'r5', timestamp: t(8), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Anything else?' }], usage: usage(30000) } },
  { type: 'custom-title', customTitle: 'Zebra test fix' }
]
fs.writeFileSync(path.join(sessDir, `${A}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
{
  // A long session, with the phrase the all-sessions search looks for near the start (before the loaded window).
  const out = []
  for (let i = 0; i < 1200; i++) {
    const at = new Date(Date.UTC(2026, 8, 28, 8, 0, i)).toISOString()
    out.push({ type: 'user', timestamp: at, message: { role: 'user', content: i === 3 ? 'Now make the transcript viewer faster' : `Step ${i}: carry on` } })
    out.push({ type: 'assistant', requestId: `b${i}`, timestamp: at, message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `bt${i}`, name: 'Bash', input: { command: `echo ${i}`, description: `Step ${i}` } }], usage: usage(1000 + i) } })
    out.push({ type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `bt${i}`, content: `output ${i}\n` + 'y'.repeat(i % 7 === 0 ? 5000 : 200) }] } })
    if (i === 1150) {
      out.push({ type: 'system', subtype: 'compact_boundary', timestamp: at, content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 190000, postTokens: 12000 } })
      out.push({ type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, timestamp: at, message: { role: 'user', content: 'Summary: steps 0 to 1149 done.' } })
    }
    out.push({ type: 'assistant', requestId: `c${i}`, timestamp: at, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: `Done with step ${i}.` }], usage: usage(1100 + i) } })
  }
  fs.writeFileSync(path.join(sessDir, `${B}.jsonl`), out.map((l) => JSON.stringify(l)).join('\n') + '\n')
}
fs.writeFileSync(
  path.join(proj, '.combwork', 'sessions.json'),
  JSON.stringify({ version: 1, sessions: [
    // Active just now: the suite appends to its backup as a running session's is (#1110: an ended one's is compressed).
    { id: A, agent: 'claude-code', name: 'Zebra test fix', createdAt: t(0), lastActiveAt: new Date().toISOString(), archived: false },
    { id: B, agent: 'claude-code', name: 'Long session', createdAt: t(0), lastActiveAt: t(0), archived: false }
  ] })
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` (${extra})` : ''}`)
// The longest a check waits for its condition: a bound for a hung run, never how long the step should take.
const HUNG_MS = 10000
/** Whether fn() comes true (checked until it does, up to HUNG_MS); a throw (an element not there yet) counts as not yet. */
const becomes = async (fn) => !!(await lib.until(() => Promise.resolve().then(fn).catch(() => false), HUNG_MS))
/** An element's text, or '' while it isn't there. */
const text = (loc) => loc.textContent({ timeout: 1000 }).then((got) => got ?? '').catch(() => '')

;(async () => {
  const env = lib.combworkEnv({ CW_USER_DATA: userData })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => results.push(`PAGEERROR ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && results.push(`CONSOLE ${m.text().slice(0, 200)}`))
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('demo', { exact: true }).first().click()
  await page.locator('.tab', { hasText: 'Sessions' }).click()
  await lib.until(async () => (await page.locator('.session-row').count()) > 0, 10000)

  const rows = page.locator('.session-row')
  check('two sessions listed', (await rows.count()) === 2, String(await rows.count()))
  await page.screenshot({ path: path.join(shots, '1-open.png') })
  const sel = await page.locator('.session-row.selected strong').textContent().catch(() => null)
  check('a session is selected by default', !!sel, sel)
  const t0 = Date.now()
  await page.locator('.session-row', { hasText: 'Long session' }).click()
  await page.locator('.tx-compaction').first().waitFor({ timeout: 15000 })
  check('long transcript renders', true, `${Date.now() - t0} ms`)
  check('opens at the latest message', await becomes(() => page.locator('.transcript').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 80)))
  // Only the latest items load at first; earlier ones load as you scroll up.
  const w = await inv('transcript:read', proj, B)
  check('a long transcript loads its latest 200 items', w.items.length === 200 && w.from === w.total - 200, `${w.items.length} of ${w.total} from ${w.from}`)
  check('the viewer offers the earlier items', (await page.locator('.transcript-earlier').count()) === 1)
  const firstBefore = await page.locator('.transcript-body [id^="tx-"]').first().getAttribute('id')
  await page.locator('.transcript').evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) })
  await lib.until(async () => (await page.locator('.transcript-body [id^="tx-"]').first().getAttribute('id')) !== firstBefore, 10000)
  const firstAfter = await page.locator('.transcript-body [id^="tx-"]').first().getAttribute('id')
  check('scrolling up loads earlier items', firstAfter !== firstBefore && Number(firstAfter?.slice(3)) < Number(firstBefore?.slice(3)), `${firstBefore} → ${firstAfter}`)
  await page.screenshot({ path: path.join(shots, '2-long.png') })

  // Synthetic session: structure.
  await page.locator('.session-row', { hasText: 'Zebra test fix' }).click()
  check('user messages', !!(await lib.until(async () => (await page.locator('.tx-user').count()) === 2, 10000)))
  check('replies grouped', (await page.locator('.tx-reply').count()) === 3, String(await page.locator('.tx-reply').count()))
  check('tool calls collapsed', (await page.locator('.tx-tool').count()) === 2 && (await page.locator('.tx-tool.open').count()) === 0)
  check('tool summary', (await page.locator('.tx-tool .tx-fold-detail').first().textContent()) === 'Run the login tests')
  check('edit path shortened', (await page.locator('.tx-tool .tx-fold-detail').nth(1).textContent()) === 'login.spec.ts')
  check('thinking collapsed', (await page.locator('.tx-thinking').count()) === 1)
  check('command shown with output', (await page.locator('.tx-command').textContent()).includes('/compact keep the test notes') && (await page.locator('.tx-command-output').textContent()) === 'Compacted')
  const divider = await page.locator('.tx-compaction-label').textContent()
  check('compaction divider', divider.includes('180k → 9.0k (30.1k with instructions)') && divider.includes('with instructions'), divider)
  // #815: the prompt cache is part of the usage line's message, with its separator (it was a fragment whose leading
  // space the catalogue dropped).
  const usageLine = await text(page.locator('.transcript-toolbar .path > .faint'))
  check('usage line ends with the prompt cache, separated', /\d+ prompts? · 1 compaction · cache (expired|warm \S+)$/.test(usageLine), usageLine)
  await page.locator('.tx-tool .tx-fold-head').first().click()
  const result = page.locator('.tx-tool.open .tx-result')
  const res = (await lib.until(async () => { const got = await text(result); return got.startsWith('FAIL login.spec.ts') && got }, HUNG_MS)) || (await text(result))
  check('tool expands with result', res.startsWith('FAIL login.spec.ts'))
  check('long result shortened', res.length <= 4000, String(res.length))
  await page.getByText(/Show all \(/).click()
  check('Show all loads the full result', await becomes(async () => (await text(result)).length > 6000))
  await page.locator('.tx-compaction-line').click()
  check('compaction summary expands', await becomes(async () => (await text(page.locator('.tx-compaction-summary'))).includes('waiting longer')))
  const imgSrc = () => page.locator('.tx-user .thumb img').getAttribute('src', { timeout: 1000 }).catch(() => null)
  check('image thumbnail loads', await becomes(async () => (await imgSrc())?.startsWith('data:image/png;base64,')), String(await imgSrc()).slice(0, 40))
  await page.screenshot({ path: path.join(shots, '3-synthetic.png') })
  await page.locator('.tx-user .thumb').click()
  check('image viewer opens', await becomes(async () => (await page.locator('.dialog .image-viewer img').count()) === 1))
  check('image path from Claude Code shown', await becomes(async () => (await text(page.locator('.dialog-header h2'))) === 'shot.png'))
  await page.screenshot({ path: path.join(shots, '4-image.png') })
  await page.keyboard.press('Escape')
  await lib.until(async () => (await page.locator('.dialog .image-viewer').count()) === 0, HUNG_MS)
  check('Resume offered for a stopped session', await becomes(async () => (await page.locator('.transcript-toolbar button', { hasText: 'Resume' }).count()) === 1))

  // Expand all / collapse all.
  await page.locator('.transcript-toolbar [aria-label="Expand Tool Calls"]').click()
  check('expand all', await becomes(async () => (await page.locator('.tx-fold.open').count()) === 3), String(await page.locator('.tx-fold.open').count()))
  await page.locator('.transcript-toolbar [aria-label="Collapse Tool Calls"]').click()
  check('collapse all', await becomes(async () => (await page.locator('.tx-fold.open').count()) === 0))

  // Search: the tree keeps the sessions that match, with each one's matches under it.
  await page.locator('.sessions-list input.input').fill('zebra')
  await lib.until(async () => (await page.locator('.search-hit').count()) >= 4, 10000)
  const hits = await page.locator('.search-hit').count()
  check('search lists the matches under their session', hits >= 4, String(hits))
  await page.locator('.search-hit', { hasText: 'timed out' }).click()
  check('jumping to a tool hit expands it', await becomes(async () => (await page.locator('.tx-tool.open').count()) >= 1))
  const highlights = () => page.evaluate(() => CSS.highlights.get('hive-search')?.size ?? 0)
  check('matches highlighted', await becomes(async () => (await highlights()) > 0), String(await highlights()))
  await page.screenshot({ path: path.join(shots, '5-search-this.png') })

  // Search every session: only the one whose transcript has it stays.
  await page.locator('.sessions-list input.input').fill('transcript viewer')
  await lib.until(async () => (await page.locator('.search-hit').count()) > 0, 10000)
  const groups = await page.locator('.sessions-tree .session-row strong').allTextContents()
  check('search keeps the sessions that match', groups.length === 1 && groups[0].includes('Long session'), JSON.stringify(groups))
  await page.locator('.search-hit').first().click()
  await lib.until(async () => (await page.locator('.transcript-toolbar strong').first().textContent()) === 'Long session', 10000)
  check('hit opens the other session', (await page.locator('.transcript-toolbar strong').first().textContent()) === 'Long session')
  const flashVisible = await page.locator('.flash').evaluate((el) => {
    const r = el.getBoundingClientRect()
    return r.top >= 0 && r.bottom <= window.innerHeight
  }).catch(() => false)
  check('jumped item is on screen', flashVisible)
  await page.screenshot({ path: path.join(shots, '6-search-all.png') })
  await page.locator('.sessions-list input.input').fill('')
  await sleep(300)

  // Incremental read: unchanged returns null, appended lines are picked up, a partial line waits.
  const r1 = await inv('transcript:read', proj, A)
  const r2 = await inv('transcript:read', proj, A, { knownVersion: r1.version })
  check('unchanged transcript returns null', r2 === null)
  fs.appendFileSync(path.join(sessDir, `${A}.jsonl`), JSON.stringify({ type: 'user', timestamp: t(9), message: { role: 'user', content: 'one more thing' } }) + '\n{"type":"assistant","partial')
  const r3 = await inv('transcript:read', proj, A, { knownVersion: r1.version })
  check('appended message read incrementally', !!r3 && r3.items.length === r1.items.length + 1 && r3.items.at(-1).text === 'one more thing')
  fs.appendFileSync(path.join(sessDir, `${A}.jsonl`), `":1,"requestId":"r9","timestamp":"${t(9)}","message":{"content":[{"type":"text","text":"Sure."}]}}\n`)
  const r4 = await inv('transcript:read', proj, A, { knownVersion: r3.version })
  check('partial last line completed later', !!r4 && r4.items.at(-1).text === 'Sure.')

  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  await page.locator('.session-row', { hasText: 'Zebra test fix' }).click()
  await sleep(700)
  await page.screenshot({ path: path.join(shots, '7-light.png') })
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))

  // Rename (the tag) and delete show on hover; deleting moves Combwork's copy to the Recycle Bin and hides the session.
  const row = page.locator('.session-row', { hasText: 'Zebra test fix' })
  await page.mouse.move(600, 5)
  check('row buttons are hidden until hover', !(await row.locator('.row-actions').isVisible()))
  await row.hover()
  check('hover shows rename and delete', (await row.locator('.row-actions [aria-label="Rename"]').isVisible()) && (await row.locator('.row-actions [aria-label="Delete session"]').isVisible()))
  check('the transcript toolbar has them too', (await page.locator('.transcript-toolbar [aria-label="Delete session"]').count()) === 1 && (await page.locator('.transcript-toolbar [aria-label="Rename"] .codicon-tag').count()) === 1)
  await page.screenshot({ path: path.join(shots, '8-row-hover.png') })
  // The row's buttons show only while it's hovered: hover again until Delete is there (a hover can be lost under load).
  await lib.until(async () => {
    await row.hover().catch(() => undefined)
    return row.locator('.row-actions [aria-label="Delete session"]').isVisible()
  }, 8000)
  await row.locator('.row-actions [aria-label="Delete session"]').click()
  await page.locator('.dialog-footer button', { hasText: /^Delete$/ }).click()
  check('the deleted session leaves the list', await becomes(async () => (await page.locator('.session-row', { hasText: 'Zebra test fix' }).count()) === 0))
  check("Combwork's copy is gone", await becomes(() => !fs.existsSync(path.join(sessDir, `${A}.jsonl`))))
  const sessionsFile = () => sessionsOf(proj)
  check('Combwork remembers it as deleted', await becomes(() => { const f = sessionsFile(); return !f.sessions.some((s) => s.id === A) && f.deleted?.includes(A) }), JSON.stringify(sessionsFile().deleted))
  check('the list leaves it out', !(await inv('session:list', proj)).some((s) => s.id === A))
  const kept = (await inv('session:keptUsage', proj)).find((s) => s.id === A)
  check('what it used stays in the totals', !!kept?.deleted && kept.usage?.requests > 0 && Object.keys(kept.usage.days ?? {}).length > 0, JSON.stringify(kept && { requests: kept.usage?.requests }))

  await app.close()
  console.log(results.join('\n'))
})().catch(async (e) => {
  console.log(results.join('\n'))
  console.error('ERROR', e)
  process.exit(1)
})
