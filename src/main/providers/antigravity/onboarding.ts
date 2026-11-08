import { existsSync, readFileSync } from 'original-fs'
import { mkdir, readFile, writeFile } from 'original-fs/promises'
import { dirname, join } from 'path'

// agy's first-run screens (HI-2547, Darren's decision (a) on r11): a fresh profile shows a colour scheme and agy's Terms
// of Service & Data Use at its first interactive start, which Combwork never answers for the user. The user completes
// them once, in Provider Setup's "Set up" (agy in a visible terminal, in Combwork's check profile); Combwork then copies
// only what says they are done into each agent's profile, so agents start straight to work. Seen with 1.5.0: the screens'
// state is cache\onboarding.json (`onboardingComplete`) and the `post_onboarding` block of jetski_state.pbtxt (its
// installation id is never copied). The user's own ~\.gemini is never read.

const CLI = join('.gemini', 'antigravity-cli')
export const ONBOARDING_FILE = join(CLI, 'cache', 'onboarding.json')
export const STATE_FILE = join(CLI, 'jetski_state.pbtxt')

/** Whether onboarding.json's text says the first-run screens are done. */
export function onboardingComplete(text: string): boolean {
  try {
    const j = JSON.parse(text)
    return !!j && typeof j === 'object' && j.onboardingComplete === true
  } catch {
    return false
  }
}

/** Whether a profile's first-run screens are done. */
export async function onboarded(profile: string): Promise<boolean> {
  return onboardingComplete(await readFile(join(profile, ONBOARDING_FILE), 'utf8').catch(() => ''))
}

/** The same, at once (Provider Setup's task asks every second and a half while it runs: one small file). */
export function onboardedNow(profile: string): boolean {
  const f = join(profile, ONBOARDING_FILE)
  try {
    return existsSync(f) && onboardingComplete(readFileSync(f, 'utf8'))
  } catch {
    return false
  }
}

/** jetski_state.pbtxt's `post_onboarding { … }` block (protobuf text), or null. */
export function postOnboardingBlock(text: string): string | null {
  const m = /^post_onboarding: \{\r?\n(?:[ \t][^\r\n]*\r?\n)*\}/m.exec(text)
  return m ? m[0] : null
}

/**
 * Copies what says the first-run screens are done from `from` (the check profile, once the user completed them there) into
 * `to` (an agent's profile) where it isn't done yet: onboarding.json as it is, and, into a profile with no jetski state,
 * only its post_onboarding block. Nothing when `from` isn't done. Whether it copied.
 */
export async function copyOnboarding(from: string, to: string): Promise<boolean> {
  if (!(await onboarded(from)) || (await onboarded(to))) return false
  const marker = await readFile(join(from, ONBOARDING_FILE), 'utf8')
  await mkdir(dirname(join(to, ONBOARDING_FILE)), { recursive: true })
  await writeFile(join(to, ONBOARDING_FILE), marker)
  if (!existsSync(join(to, STATE_FILE))) {
    const block = postOnboardingBlock(await readFile(join(from, STATE_FILE), 'utf8').catch(() => ''))
    if (block) await writeFile(join(to, STATE_FILE), block + '\n')
  }
  return true
}
