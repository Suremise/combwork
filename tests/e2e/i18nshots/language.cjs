// Screenshot cases for the `language` area (#767): the screens it translates, reached for the i18nshots route (#756's
// design, section 4) with locale-independent means only: IPC, command ids and structural hooks, never English text.
// The route (card F2b) runs each case under a language (en-XA shows text not converted yet, a language shows text
// cut off), in both themes, and fails when a screen can't be reached, never on wording.
//
// A case: { name, open(ctx) }, where ctx is { page, inv(channel, ...args), command(id), lib } and open() resolves to
// the locator to photograph (null: the whole window) once the screen shows.

/** Settings → General → Language: the row, with its picker and the notes under it. */
async function languageSetting({ page, command, lib }) {
  // Settings opens on the section shown last (HI-2708's connections case leaves it on accounts), and settings.open
  // toggles the view: opened only when it isn't shown, then on General.
  if (!(await page.locator('.settings').count())) await command('settings.open')
  const general = page.locator('.settings-nav [data-section="general"]').first()
  if (!(await lib.until(async () => (await general.count()) > 0, 25000))) throw new Error("Settings' General section did not show in its list")
  await general.click()
  const picker = page.locator('.language-picker').first()
  if (!(await lib.until(async () => (await picker.count()) > 0, 25000))) throw new Error('the language picker did not show')
  await picker.scrollIntoViewIfNeeded()
  return page.locator('.setting', { has: picker }).first()
}

module.exports = {
  area: 'language',
  screens: [{ name: 'settings-language', open: languageSetting }]
}
