// HI-3560: who wrote a pull request, as it says: a commit's Co-Authored-By trailer naming a provider's model (by the
// provider's own names, never its id), else its description's "Generated with …" line; a human's trailer, or an email's
// domain alone, never reads as a model; nothing said is null.
import { describe, expect, it } from 'vitest'
import { prAuthorship, providerNamed } from '../src/shared/prAuthorship'
import { PROVIDERS } from '../src/shared/providers'

const names = PROVIDERS.map((p) => ({ id: p.id, name: p.name, assistant: p.assistant, company: p.company }))
const idOf = (product: string): string => PROVIDERS.find((p) => p.name === product)!.id

describe('who wrote a pull request (HI-3560)', () => {
  it('reads a commit’s Co-Authored-By naming a provider’s model', () => {
    expect(prAuthorship(['Fix the parser\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'], '', names)).toEqual({ name: 'Claude Opus 5.5', provider: idOf('Claude Code'), from: 'trailer' })
    expect(prAuthorship(['Tidy\n\nco-authored-by: Codex <codex@openai.com>'], '', names)).toMatchObject({ name: 'Codex', provider: idOf('Codex') })
    expect(prAuthorship(['x\n\nCo-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>'], '', names)).toMatchObject({ provider: idOf('GitHub Copilot') })
  })

  it('takes a human co-author for nobody’s model, even with a GitHub noreply address, and goes on to the next', () => {
    const human = 'Pair work\n\nCo-Authored-By: Mona Lisa <mona@users.noreply.github.com>'
    expect(prAuthorship([human], '', names)).toBeNull()
    expect(prAuthorship([human, 'More\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>'], '', names)).toMatchObject({ name: 'Claude Sonnet 5.5', from: 'trailer' })
  })

  it('reads the description when no commit says, and says nothing when neither does', () => {
    expect(prAuthorship(['Fix'], 'Fixes #3.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)', names)).toEqual({ name: 'Claude Code', provider: idOf('Claude Code'), from: 'body' })
    expect(prAuthorship(['Fix'], 'Written by hand, tested on Windows.', names)).toBeNull()
    expect(prAuthorship([], '', names)).toBeNull()
  })

  it('matches whole names, the longest first', () => {
    expect(providerNamed('GitHub Copilot agent', names)).toBe(idOf('GitHub Copilot'))
    expect(providerNamed('Claudette', names)).toBeNull()
  })
})
