// Screenshot cases for the `tasks` area (#846): a card's history as the card dialog shows it, in the run's language
// (each line Hive's board wrote is stored with its message, shared/taskHistory.ts), reached for the i18nshots route
// (tests/e2e/i18nshots.cjs has the case format and ctx) with locale-independent means only: IPC, command ids and
// structural hooks (data-task, classes), never English text. The board's refusals reach the window through IPC, which
// tests/i18n/tasks.test.ts checks in another language.

/** Waits for a locator to be on the page; throws saying what didn't show. */
async function shown(ctx, locator, what) {
  if (!(await ctx.lib.until(async () => (await locator.count()) > 0, ctx.hungMs))) throw new Error(`${what} did not show`)
  return locator.first()
}

/**
 * A card with a long history (created, renamed, given to an agent, labelled, blocked, a decision recorded and changed,
 * moved, archived and brought back), its dialog open with History shown.
 */
async function history(ctx) {
  const { page, inv, agents, project } = ctx
  const name = project.split(/[\\/]/).pop()
  const other = await inv('tasks:create', { title: 'Earlier work', project: name })
  const c = await inv('tasks:create', { title: 'Card with a history', project: name })
  ctx.historyCards = [other.number, c.number]
  await inv('tasks:update', c.number, { title: 'A card with a history', description: 'Its history, in the window’s language.', agent: agents[0].id, labels: ['i18n'], blocked: 'Waiting for a decision', blockedBy: [other.number], links: [other.number], decision: 'Keep it short' })
  const decision = (await inv('tasks:update', c.number, { blocked: null, column: 'review' })).decisions[0]
  await inv('tasks:editDecision', c.number, decision.id, 'Keep it shorter')
  await inv('tasks:archive', c.number, true)
  await inv('tasks:archive', c.number, false)
  await inv('tasks:comment', c.number, 'A comment by the user.')
  await ctx.command('view.board')
  await (await shown(ctx, page.locator(`.board-view .task-card[data-task="${c.number}"]`), 'the card on the board')).click()
  const dialog = await shown(ctx, page.locator('.dialog[role="dialog"]'), "the card's dialog")
  // History by its own hook: Work's heading (#1224) is clickable too, and comes first (#1318).
  await (await shown(ctx, dialog.locator('.task-section-h[data-section="history"]'), "the dialog's History heading")).click()
  await shown(ctx, dialog.locator('.task-history > div'), "the card's history")
  await dialog.locator('.task-history').scrollIntoViewIfNeeded()
  return dialog
}

/** The dialog closed, and the two cards gone again. */
async function closeHistory(ctx) {
  const { page, lib, inv } = ctx
  if (!(await lib.until(async () => (await page.locator('.dialog[role="dialog"]').count()) === 0 || (await page.keyboard.press('Escape').then(() => false)), ctx.hungMs))) throw new Error("the card's dialog didn't close")
  for (const n of ctx.historyCards ?? []) await inv('tasks:delete', n)
}

module.exports = {
  area: 'tasks',
  screens: [{ name: 'card-history', open: history, close: closeHistory }]
}
