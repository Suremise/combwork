// jj's documented limits match its capability gates (HI-2800, J7's "done when"): the user guide's "What jj doesn't support
// in Combwork" lists exactly the gates jj's descriptor still has closed, one item each, tagged with its gate and named as
// the window names it (GATE_TEXT), and every limit the window shows has its item. A gate opened or added changes both.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { PLATFORMS } from '../src/shared/platform/descriptors'
import { GATE_TEXT } from '../src/shared/platform/gateTexts'

const guide = readFileSync(join(__dirname, '..', 'docs', 'USER_GUIDE.md'), 'utf8').replace(/\r\n/g, '\n')

/** The section under the heading with this id, up to the next heading of its level or above. */
function section(id: string): string {
  const start = guide.indexOf(`<a id="${id}"></a>`)
  expect(start, `the guide has a heading #${id}`).toBeGreaterThan(-1)
  const rest = guide.slice(guide.indexOf('\n', start) + 1)
  const end = rest.search(/^#{1,4} /m)
  return end < 0 ? rest : rest.slice(0, end)
}

describe("jj's limits in the user guide", () => {
  const items = [...section('jj-limits').matchAll(/^- <!-- gate:(\w+) --> \*\*([^*]+)\*\*/gm)].map((m) => ({ gate: m[1], name: m[2] }))

  it('lists exactly the gates jj still has closed, once each, in the descriptor’s order', () => {
    expect(items.map((i) => i.gate)).toEqual([...PLATFORMS.jj.gates])
  })

  it('names each as the window does', () => {
    for (const i of items) expect(i.name, i.gate).toBe(GATE_TEXT[i.gate as keyof typeof GATE_TEXT].name.defaultMessage)
  })

  it('Git and None have no closed gates to document', () => {
    expect(PLATFORMS.git.gates).toEqual([])
    expect(PLATFORMS.none.gates).toEqual([])
  })
})
