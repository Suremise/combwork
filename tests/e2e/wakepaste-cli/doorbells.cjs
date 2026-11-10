// How wakepaste-codex and wakepaste-copilot (run.cjs) find a doorbell on an agent's screen, and which delivery a held
// doorbell is (tests/wakepasteDoorbells.test.ts).

/**
 * The doorbells on a screen, each by its id, however its rows were wrapped: by its "(m4). Call cw_inbox" with
 * whitespace dropped, and up to a few non-letters between "Call" and "cw_inbox", as the CLI can draw in a doorbell's
 * first row where it wraps (HI-2387: Copilot's time and its border, "(m4). Call   19:34 ┃" / "cw_inbox …").
 */
function doorbellIds(text) {
  return [...text.replace(/\s+/g, '').matchAll(/\((m\d+)\)\.Call[^A-Za-z]{0,16}cw_inbox/g)].map((x) => x[1])
}

/**
 * The delivery a doorbell just typed is for: the newest of an agent's deliveries (its activity's inbox rows, oldest
 * first) that wasn't there before (`before`: their ids then). Taken from Combwork's deliveries, never from what the
 * screen shows that it didn't before (HI-2875): a CLI redrawing its whole conversation as its pane narrows can draw an
 * earlier doorbell after a snapshot of the screen, and that one, part of its history, never leaves the screen.
 */
function newDelivery(before, rows) {
  const ids = new Set(before)
  return [...(rows ?? [])].reverse().find((d) => d?.id && !ids.has(d.id))?.id ?? null
}

module.exports = { doorbellIds, newDelivery }
