// Links into the user guide (#1535) go by a heading's id: `<a id="…"></a>` at the end of the heading in
// docs/USER_GUIDE.md, kept when the heading is renamed. tests/userGuide.test.ts checks every link the app makes.
import { docOutline, findHeading } from './docSections'

/** The id of the user guide's heading about the 1.0 board upgrade (its notice's Learn more). */
export const BOARD_UPGRADE_GUIDE = 'upgrading-to-10' // i18n-ignore: a user guide heading's id (#1535)

/**
 * The slug of the heading a link's id names in a document (the Docs view's Learn more), or null when none does for
 * sure: missing, or an id several headings carry. Decided by findHeading, as card references and hive_read_section are.
 */
export function guideTarget(md: string, id: string): string | null {
  const found = findHeading(docOutline(md), `#${id}`)
  return 'heading' in found ? found.heading.slug : null
}
