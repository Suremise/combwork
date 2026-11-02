// Heavy test runs, machine-wide (#204). Several agents checking their cards at once on one machine (full e2e sets,
// repeats, scenario runs) slowed each other until tests timed out: the flakes were the load, not the code. So at most
// a few heavy runs go at once across every worktree (heavySlots in hive-test\config.json, default 2, #589); a heavy run started while
// they are all taken waits for one, in the order the runs asked, saying who holds them (and in Hive's Progress panel).
// A pre-merge run goes first (#558): one started by the agent holding its project's merge slot (holdsMergeSlot), or
// with --pre-merge. It takes the next free slot before runs that asked earlier for other reasons (a merge shouldn't wait
// behind flake-proof repeats while every other merge waits behind it), but never stops a run that holds one.
// A run that isn't heavy (a few suites, a single scenario) never waits, nor does a runner started inside a run that
// holds a slot of the kind it needs (heldCredit, E2E_RUN_SLOTS): waiting behind its parent would never end (#211).
//
// Small runs and model trials (HI-2070): a heavy run within the small-run bound (smallRun in config.json: a few suites
// repeated a few times, a few fake scenario runs) is small. It takes the side slot (sideSlots, default 1) when that is
// free, else a heavy slot, else it waits for whichever frees first; heavy runs never take the side slot. A scenario run
// on a real model (claude-code, codex) is network-bound: it takes no CPU slot, only one of the model trials' own
// (modelTrials, default 2), which bound API spend and Codex's account-wide rate window. slotPool says which a run takes.
// On the side slot an e2e run runs at most SIDE_E2E_JOBS suites at once.
//
// Claims are files in a folder of the run context (runContext.HEAVY_DIR), as lanes are (lanes.mjs): `slot-<k>.json`
// for a run holding a heavy slot, `side-<k>.json` and `model-<k>.json` for the others, and `wait-<pid>.json` for one
// waiting (when it asked, which pool; `first` for a pre-merge run), each with its runner's process id, changed only
// under the claims lock. A crashed run's claim expires: its process is gone (or it is a day old).
//
// A run left over (#1008): one started in an agent's session that has ended since (Hive closed under it, the agent
// stopped or restarted) keeps running, and keeps its slot, while its process lives. Its claim records the agent's launch
// (owner: runOwner), and a waiting run asks Hive whether that launch still runs (launchEnded): the wait line names a
// holder that was left over, and a run in the same worktree says so as it starts. Nothing is stopped on its own: its
// results may still be wanted. Hive's notice after an unexpected close offers to stop it (#987).
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { processAlive } from './logs.mjs'
import { claimHeld, describeHolder, withLock } from './lanes.mjs'
import { parentSuite } from './runner.mjs'

/** Heavy runs at once, unless the machine's config.json or HIVE_TEST_HEAVY_SLOTS says otherwise. */
export const DEFAULT_SLOTS = 2
/**
 * The machine's test settings (#589): `{ "heavySlots": 3 }` in the shared test folder, read each time a run asks, so an
 * edit counts from the next run with no restart. Machine-wide, as the slots are: every worktree's runs read the same file.
 */
export const CONFIG_FILE = join(createRequire(import.meta.url)('./runContext.cjs').TEST_ROOT, 'config.json')
/** A run of more suites or scenarios than this (or any repeat) is heavy. */
export const HEAVY_OVER = 5

/** What a run has said about where its count came from: each line once a process. */
const said = new Set()
const sayOnce = (say, line) => {
  if (said.has(line)) return
  said.add(line)
  say(line)
}

/**
 * How many heavy runs may go at once (#589): HIVE_TEST_HEAVY_SLOTS, a one-off override; else `heavySlots` in the machine's
 * config.json (CONFIG_FILE); else DEFAULT_SLOTS. Each a whole number, 1 or more. A missing or unreadable file, or a value
 * that isn't one, falls back to the default, and the run says so in one line (once).
 */
export function heavySlots(env = process.env, file = CONFIG_FILE, say = (line) => console.error(line)) {
  const whole = (v) => Number.isInteger(v) && v >= 1
  const set = env.HIVE_TEST_HEAVY_SLOTS
  if (set !== undefined && set !== '') {
    if (whole(Number(set))) return Number(set)
    sayOnce(say, `Test slots: HIVE_TEST_HEAVY_SLOTS=${JSON.stringify(set)} isn't a whole number from 1; it is left out.`)
  }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    const why = e?.code === 'ENOENT' ? 'there is none' : `it can't be read (${e?.code ?? e?.message})`
    sayOnce(say, `Test slots: ${DEFAULT_SLOTS} heavy runs at once, the default (${file}: ${why}).`)
    return DEFAULT_SLOTS
  }
  let n
  try {
    n = JSON.parse(text.replace(/^\uFEFF/, ''))?.heavySlots
  } catch {
    sayOnce(say, `Test slots: ${DEFAULT_SLOTS} heavy runs at once, the default (${file} isn't JSON).`)
    return DEFAULT_SLOTS
  }
  if (whole(n)) return n
  sayOnce(say, `Test slots: ${DEFAULT_SLOTS} heavy runs at once, the default (${file}: ${n === undefined ? 'no heavySlots in it' : `heavySlots ${JSON.stringify(n)} isn't a whole number from 1`}).`)
  return DEFAULT_SLOTS
}

/** Whether a run is heavy: more than HEAVY_OVER suites or scenarios, or run more than once (--repeat). */
export function isHeavy({ count, repeat = 1 }) {
  return repeat > 1 || count > HEAVY_OVER
}

/** Small runs' side slots and real-model trials at once (HI-2070), unless config.json or the environment says otherwise. */
export const DEFAULT_SIDE_SLOTS = 1
export const DEFAULT_MODEL_TRIALS = 2
/** The largest small run (HI-2070): e2e suites and their repeats, and fake scenario runs in all (scenarios × repeats). */
export const DEFAULT_SMALL_RUN = { e2eSuites: 3, e2eRepeat: 3, scenarioRuns: 5 }
/** Scenario providers that are real models: their runs are model trials. */
export const MODEL_PROVIDERS = ['claude-code', 'codex']

/**
 * The side slots, model trials and small-run bound (HI-2070), from the machine's config.json beside heavySlots
 * (`sideSlots`, a whole number from 0; `modelTrials`, from 1; `smallRun: { e2eSuites, e2eRepeat, scenarioRuns }`, each
 * from 1), read each time a run asks; HIVE_TEST_SIDE_SLOTS and HIVE_TEST_MODEL_TRIALS override the first two for one run.
 * A value that isn't one falls back to its default, said in one line (once).
 */
export function slotSettings(env = process.env, file = CONFIG_FILE, say = (line) => console.error(line)) {
  let cfg = {}
  try {
    cfg = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) ?? {}
  } catch {
    // No file, or not JSON: heavySlots says so; the defaults here.
  }
  const whole = (v, from) => Number.isInteger(v) && v >= from
  const pick = (name, variable, def, from) => {
    const set = env[variable]
    if (set !== undefined && set !== '') {
      if (whole(Number(set), from)) return Number(set)
      sayOnce(say, `Test slots: ${variable}=${JSON.stringify(set)} isn't a whole number from ${from}; it is left out.`)
    }
    const v = cfg[name]
    if (v === undefined) return def
    if (whole(v, from)) return v
    sayOnce(say, `Test slots: ${name} ${JSON.stringify(v)} in ${file} isn't a whole number from ${from}; ${def}, the default.`)
    return def
  }
  const side = pick('sideSlots', 'HIVE_TEST_SIDE_SLOTS', DEFAULT_SIDE_SLOTS, 0)
  const models = pick('modelTrials', 'HIVE_TEST_MODEL_TRIALS', DEFAULT_MODEL_TRIALS, 1)
  const small = { ...DEFAULT_SMALL_RUN }
  if (cfg.smallRun !== undefined) {
    for (const k of Object.keys(DEFAULT_SMALL_RUN)) {
      const v = cfg.smallRun?.[k]
      if (v === undefined) continue
      if (whole(v, 1)) small[k] = v
      else sayOnce(say, `Test slots: smallRun.${k} ${JSON.stringify(v)} in ${file} isn't a whole number from 1; ${DEFAULT_SMALL_RUN[k]}, the default.`)
    }
  }
  return { side, models, small }
}

/** Suites an e2e run on the side slot runs at once, at most (HI-2070: beside two heavy runs, never the usual four). */
export const SIDE_E2E_JOBS = 2

/**
 * The kinds of slot the run this one was started inside holds for it (HI-2070): 'cpu' (a heavy or side slot) and
 * 'model' (a model trial's), from E2E_RUN_SLOTS, comma-separated, which the runners set for what they start and which
 * is carried into a test Hive's sessions (runContext CARRIED). A run inside a suite marked without it (an older runner)
 * has the CPU credit every nested run had before (#211); a run started outside any has none.
 */
export function heldCredit(env = process.env) {
  if (env.E2E_RUN_SLOTS !== undefined) return new Set(env.E2E_RUN_SLOTS.split(',').filter((k) => k === 'cpu' || k === 'model'))
  return new Set(parentSuite(env) ? ['cpu'] : [])
}

/** E2E_RUN_SLOTS for what a run starts: the credit it was given, and the kind of slot it holds now (a pool, or none). */
export function creditFor(pool, env = process.env) {
  const credit = heldCredit(env)
  if (pool === 'model') credit.add('model')
  else if (pool) credit.add('cpu')
  return [...credit].sort().join(',')
}

/**
 * Whether a scenario run's build needs a CPU slot it doesn't hold (HI-2070): a real model's trial (its own work takes no
 * CPU slot), with no CPU credit from the slot it took (pool) or what it runs inside, whether it took a model trial's
 * slot itself or one it runs inside covers it. A fake run's build is covered as its run is (a heavy or side slot, or none
 * for a light run, as an e2e run's).
 */
export function buildNeedsCpuSlot({ provider, pool }, env = process.env) {
  return MODEL_PROVIDERS.includes(provider) && !creditFor(pool, env).split(',').includes('cpu')
}

/**
 * Which slot a run waits for (HI-2070): 'model' for a scenario run on a real model, whatever its size; 'small' for a
 * heavy run within the small-run bound; 'heavy' for any other heavy run; null for one that waits for none: not heavy,
 * or started inside a run that holds a slot of the kind it needs (heldCredit: waiting for the parent's own slot would
 * never end, #211). Only matching credit counts: CPU work inside a model trial still asks for a CPU slot, and a model
 * trial inside a CPU run for a model trial's. kind: 'e2e' or 'scenarios'.
 */
export function slotPool({ kind, count, repeat = 1, provider = '' }, env = process.env, small = slotSettings(env).small) {
  const credit = heldCredit(env)
  if (kind === 'scenarios' && MODEL_PROVIDERS.includes(provider)) return credit.has('model') ? null : 'model'
  if (credit.has('cpu') || !isHeavy({ count, repeat })) return null
  const within = kind === 'e2e' ? count <= small.e2eSuites && repeat <= small.e2eRepeat : count * repeat <= small.scenarioRuns
  return within ? 'small' : 'heavy'
}

/** Vitest options whose value is the next argument (so it is no file filter). */
const VITEST_VALUE_OPTIONS = ['-c', '--config', '-r', '--root', '--dir', '--reporter', '--outputFile', '--environment', '--pool', '--maxWorkers', '--testTimeout', '--hookTimeout', '--retry', '--bail', '--mode', '--exclude']

/**
 * Whether a unit test run is the whole set (#599), heavy as a full e2e set is: its workers and what its tests start beside
 * e2e runs were what ran Windows short (0xc0000142 dialogs). A run of some files (a file filter), some tests (-t), the
 * changed or related files, a shard or a project, or watch mode, isn't. args: Vitest's command line after its script.
 */
export function isFullUnitRun({ args, watch = false, changed = false, related = [], testNamePattern = null }) {
  if (watch || changed || related?.length || testNamePattern) return false
  if (args.some((a) => /^(--changed|--related|-t|--testNamePattern|--shard|--project|--watch|-w)(=|$)/.test(a))) return false
  return !args.some((a, i) => !a.startsWith('-') && a !== 'run' && !VITEST_VALUE_OPTIONS.includes(args[i - 1]))
}

/**
 * Whether a run waits for a test slot (both runners ask): a heavy one, unless it was started inside a suite
 * (runner.mjs parentSuite: a suite's agent shell, say). That run's load is its parent's, whose slot counts it; waiting
 * for a slot the parent holds would never end, and --no-wait would refuse it (#211). Only the slot is skipped: a nested
 * e2e runner still keeps to its parent's nested folder and ports above the parent's, and a nested scenario run still
 * claims a lane of its own (lanes.mjs), so neither shares folders or ports with its parent.
 */
export function needsSlot({ count, repeat = 1 }, env = process.env) {
  return isHeavy({ count, repeat }) && !parentSuite(env)
}

/**
 * A GET of Hive's Agent API with the session's own variables, which the runners read from the shell they were started
 * in, as their progress reporting does: the reply's JSON, or null when no Hive agent runs this, or the API doesn't answer
 * in time or refuses. workspace: the X-Hive-Workspace to name (the session's own by default).
 */
async function apiGet(path, env, { fetch = globalThis.fetch, timeoutMs = 3000, workspace = env.HIVE_WORKSPACE } = {}) {
  const url = env.HIVE_API_URL?.replace(/\/+$/, '')
  if (!url) return null
  // The session's token file, never HIVE_API_TOKEN (HI-2262: sessions no longer get it).
  let token = ''
  if (env.HIVE_API_TOKEN_FILE) {
    try {
      token = String(JSON.parse(readFileSync(env.HIVE_API_TOKEN_FILE, 'utf8')).token ?? '')
    } catch {
      token = ''
    }
  }
  if (!token) return null
  try {
    const res = await fetch(`${url}${path}`, {
      headers: { Authorization: `Bearer ${token}`, ...(workspace ? { 'X-Hive-Workspace': encodeURIComponent(workspace) } : {}) },
      signal: AbortSignal.timeout(timeoutMs)
    })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

/**
 * Whether this run is the merge slot holder's (#558): started in the session of the agent that holds its project's
 * merge slot (the default branch's), asked through Hive's Agent API. False when no Hive agent runs it or the API doesn't
 * answer in time: an ordinary run then.
 */
export async function holdsMergeSlot(env = process.env, { fetch = globalThis.fetch, timeoutMs = 3000 } = {}) {
  if (!env.HIVE_PROJECT || !env.HIVE_AGENT) return false
  const holder = (await apiGet(`/v1/projects/${encodeURIComponent(env.HIVE_PROJECT)}/merge-slot`, env, { fetch, timeoutMs }))?.holder
  return holder?.kind === 'agent' && holder.name === env.HIVE_AGENT
}

/**
 * The agent's launch a run was started in (#1008), from its shell's variables, for its claim: { project, agent, run,
 * workspace }, or undefined outside an agent's session.
 */
export function runOwner(env = process.env) {
  if (!env.HIVE_PROJECT || !env.HIVE_AGENT || !env.HIVE_RUN_ID) return undefined
  return { project: env.HIVE_PROJECT, agent: env.HIVE_AGENT, run: env.HIVE_RUN_ID, ...(env.HIVE_WORKSPACE ? { workspace: env.HIVE_WORKSPACE } : {}) }
}

/**
 * Whether the launch a claim's run was started in has ended (#1008): Hive closed under it, or its agent stopped or
 * restarted, so the run was left over and nobody waits for its results in that session. Asked through the Agent API
 * with this run's own session: true or false, or null when it can't say (no owner, no Hive agent here, no answer).
 */
export async function launchEnded(owner, env = process.env, opts = {}) {
  if (!owner?.project || !owner.agent || !owner.run) return null
  const path = `/v1/projects/${encodeURIComponent(owner.project)}/agents/${encodeURIComponent(owner.agent)}/launches/${encodeURIComponent(owner.run)}`
  const r = await apiGet(path, env, { ...opts, workspace: owner.workspace })
  return typeof r?.running === 'boolean' ? !r.running : null
}

/**
 * Marks the claims whose run was left over (leftOver: true, #1008), asking about each claim's launch at most every
 * askMs (its answer kept meanwhile): for waitForSlot, at each look. Nothing is stopped: the results may still be wanted.
 */
export function leftOverCheck({ env = process.env, askMs = 30_000, ended = launchEnded, now = () => Date.now() } = {}) {
  const known = new Map()
  return async (holders) => {
    const t = now()
    return Promise.all(
      holders.map(async (c) => {
        if (!c?.owner) return c
        const key = `${c.pid}:${c.at}`
        let k = known.get(key)
        if (!k || t - k.asked >= askMs) known.set(key, (k = { asked: t, left: await ended(c.owner, env) }))
        return k.left ? { ...c, leftOver: true } : c
      })
    )
  }
}

/**
 * Whether a run goes first in the queue, for waitForSlot's `first`: --pre-merge (flag), or its agent holds the merge
 * slot, asked again at most every askMs while the run waits (the agent may take the merge slot meanwhile, or let it go).
 */
export function preMerge(flag, { env = process.env, askMs = 30_000, holds = holdsMergeSlot, now = () => Date.now() } = {}) {
  let asked = null
  let last = false
  return async () => {
    if (flag) return true
    if (asked === null || now() - asked >= askMs) {
      asked = now()
      last = await holds(env)
    }
    return last
  }
}

/** The claims in dir whose names start with prefix: [{ file, claim }] (an unreadable one is { claim: null }). */
function claims(dir, prefix) {
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .map((f) => {
      try {
        return { file: join(dir, f), claim: JSON.parse(readFileSync(join(dir, f), 'utf8')) }
      } catch {
        return { file: join(dir, f), claim: null }
      }
    })
}

/** Each kind of slot's claim files (HI-2070): heavy slots keep their old name. */
export const SLOT_FILE = { heavy: 'slot-', side: 'side-', model: 'model-' }
/** The pools whose waiting runs queue for each kind of slot: a heavy slot is for heavy and small runs, the side one for small. */
const QUEUES_FOR = { heavy: ['heavy', 'small'], side: ['small'], model: ['model'] }

/**
 * One look, under the claims lock: takes a slot if one is free and no run ahead of this one is still waiting for it:
 * pre-merge runs (first) are ahead of the others, and among each, those that asked earlier. pool (slotPool): 'heavy'
 * takes a heavy slot; 'small' the side slot, else a heavy one; 'model' a model trial's. Returns { slot } (its number,
 * with pool: 'side' or 'model' for those), or { holders, ahead, pool }: the claims holding the slots it could take (each
 * with its pool), and how many runs wait ahead of this one for the nearest. Waiting (wait: true), this run's place in
 * the queue is kept (wait-<pid>.json, with when it first asked); otherwise it leaves no trace. Claims whose runner is
 * gone are removed. session: the agent's launch it was started in (runOwner), recorded in its slot's claim as owner.
 */
export async function trySlot(dir, { pool = 'heavy', slots = heavySlots(), side, models, owner = process.pid, what = '', root = '', first = false, wait = true, alive = processAlive, now = () => Date.now(), session = runOwner() } = {}) {
  mkdirSync(dir, { recursive: true })
  return withLock(dir, async () => {
    const t = now()
    const live = (prefix) =>
      claims(dir, prefix).filter(({ file, claim }) => {
        if (claimHeld(claim, alive, t)) return true
        rmSync(file, { force: true })
        return false
      })
    const mine = join(dir, `wait-${owner}.json`)
    const waiting = live('wait-').map((c) => c.claim)
    const me = { ...(waiting.find((c) => c.pid === owner) ?? { pid: owner, at: t, root, what }), first: !!first, pool }
    const others = waiting.filter((c) => c.pid !== owner)
    const order = (a, b) => Number(!!b.first) - Number(!!a.first) || a.at - b.at || a.pid - b.pid
    const settings = pool === 'heavy' ? null : slotSettings()
    const kinds = pool === 'small' ? [['side', side ?? settings.side], ['heavy', slots]] : pool === 'model' ? [['model', models ?? settings.models]] : [['heavy', slots]]
    const holders = []
    let ahead = Infinity
    for (const [kind, cap] of kinds) {
      // None of this kind (sideSlots 0): a small run takes a heavy slot, as before there was a side slot.
      if (!cap) continue
      const held = live(SLOT_FILE[kind]).map((c) => c.claim)
      const place = [...others.filter((c) => QUEUES_FOR[kind].includes(c.pool ?? 'heavy')), me].sort(order).indexOf(me)
      if (place < cap - held.length) {
        const used = new Set(held.map((c) => c.slot))
        let k = 0
        while (used.has(k)) k++
        writeFileSync(join(dir, `${SLOT_FILE[kind]}${k}.json`), JSON.stringify({ pid: owner, at: t, slot: k, root, what, ...(kind === 'heavy' ? {} : { pool: kind }), ...(first ? { first: true } : {}), ...(session ? { owner: session } : {}) }))
        rmSync(mine, { force: true })
        return kind === 'heavy' ? { slot: k } : { slot: k, pool: kind }
      }
      holders.push(...held.map((c) => ({ ...c, pool: kind })))
      ahead = Math.min(ahead, place)
    }
    if (wait) writeFileSync(mine, JSON.stringify(me))
    else rmSync(mine, { force: true })
    return { holders, ahead, pool }
  })
}

/** A claim, for a person: what it runs and where, its process and for how long. */
export function describeClaim(c, now = Date.now()) {
  return describeHolder(c, now, 'a heavy run')
}

/** How many of each kind go at once, for a waiting or refused run of a pool (HI-2070). */
function capacity(pool, slots, settings) {
  if (pool === 'model') return `${settings.models} real-model trials at once on this machine, modelTrials`
  if (pool === 'small' && settings.side) return `a small run: ${settings.side} side and ${slots} heavy slots on this machine, sideSlots and heavySlots`
  return `${slots} heavy runs at once on this machine, HIVE_TEST_HEAVY_SLOTS`
}

/** What a waiting run prints at a look that finds no slot (both runners): how many go at once, its place, the holders. */
export function waitLine({ holders, ahead, first = false, pool = 'heavy' }, slots = heavySlots(), settings = pool === 'heavy' ? null : slotSettings()) {
  const place = first ? `, pre-merge, ${ahead ? `${ahead} pre-merge ahead of this one` : 'next in line'}` : ahead ? `, ${ahead} ahead of this one` : ''
  return `Waiting for ${pool === 'model' ? 'a model-trial slot' : 'a test slot'} (${capacity(pool, slots, settings)})${place}: held by ${holders.map((c) => describeClaim(c)).join('; ') || 'runs just finishing'}.`
}

/** What a run refused at once (--no-wait) prints (both runners). */
export function refusedLine({ holders, pool = 'heavy' }, slots = heavySlots(), settings = pool === 'heavy' ? null : slotSettings()) {
  return `No ${pool === 'model' ? 'model-trial' : 'test'} slot free (--no-wait): ${capacity(pool, slots, settings)}, held by ${holders.map((c) => describeClaim(c)).join('; ')}.`
}

/** A holder, short, by whose run it is (HI-2070): "HB6's scenarios: 151 (fake)", or "e2e: 4 suites in D:\wt" outside an agent. */
const holderName = (c) => (c.owner?.agent ? `${c.owner.agent}'s ${c.what || 'run'}` : `${c.what || 'a run'} in ${c.root || 'another worktree'}`)

/**
 * The Progress panel's wait (HI-2070): what is ahead of this run, never its title as if it were this run's own:
 * "waiting for a test slot (2 heavy runs ahead: HB6's scenarios: 151 (fake), HB4's e2e: 4 suites × 5)".
 */
export function waitSummary({ holders, ahead = 0, pool = 'heavy' }) {
  const kinds = { heavy: 'heavy', side: 'small', model: 'model-trial' }
  // In the holders' order, as they are named after.
  const counts = [...new Set(holders.map((c) => c.pool ?? 'heavy'))].map((k) => {
    const n = holders.filter((c) => (c.pool ?? 'heavy') === k).length
    return `${n} ${kinds[k]} ${n === 1 ? 'run' : 'runs'}`
  })
  const resource = pool === 'model' ? 'a model-trial slot' : 'a test slot'
  if (!holders.length) return `waiting for ${resource} (runs just finishing)`
  return `waiting for ${resource} (${counts.join(' and ')} ahead: ${holders.map(holderName).join(', ')}${ahead ? `; ${ahead} more waiting first` : ''})`
}

/** The claims holding slots now, read without the lock (for a line to a person, not to take one). */
function slotHolders(dir, alive = processAlive, now = Date.now()) {
  try {
    return Object.values(SLOT_FILE).flatMap((prefix) => claims(dir, prefix).flatMap(({ claim }) => (claimHeld(claim, alive, now) ? [claim] : [])))
  } catch {
    return []
  }
}

/**
 * What a run prints as it starts when a run in its own worktree holds a slot and was left over (#1008): the agent that
 * started it, resumed, may want its results, or to stop it (by its process id). Empty when there is none.
 */
export function leftOverLine(holders, root, now = Date.now()) {
  const mine = holders.filter((c) => c.leftOver && root && String(c.root).toLowerCase() === String(root).toLowerCase())
  if (!mine.length) return ''
  return `Still running in this worktree, left over from a session that ended: ${mine.map((c) => describeClaim({ ...c, leftOver: false }, now)).join('; ')}. Its results may still be wanted; to stop it, stop its process by id (never by name).`
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Waits for a slot (wait: false, only one look): { slot, waitedMs, release() }, or { refused: { holders, ahead } }.
 * first: whether it is a pre-merge run, or a function saying so at each look (preMerge). onWait({ holders, ahead, first })
 * is called at each look that finds none, every pollMs, each holder left over marked (leftOver, through leftOver: a
 * leftOverCheck). say(line) prints, once, a run of this worktree that was left over (leftOverLine). release() lets the
 * slot go (only if it is still this run's); it is also let go when the process exits, and expires if it crashes.
 */
export async function waitForSlot(dir, { wait = true, pollMs = 2000, onWait = () => {}, first = false, leftOver = leftOverCheck(), say = (line) => console.log(line), ...opts } = {}) {
  const started = Date.now()
  const owner = opts.owner ?? process.pid
  const queued = join(dir, `wait-${owner}.json`)
  const leaveQueue = () => rmSync(queued, { force: true })
  let told = false
  const tell = async (held) => {
    if (told || !opts.root) return held
    told = true
    const marked = await leftOver(held)
    const line = leftOverLine(marked, opts.root, (opts.now ?? Date.now)())
    if (line) say(line)
    return marked
  }
  process.on('exit', leaveQueue)
  try {
    for (;;) {
      const goesFirst = typeof first === 'function' ? await first() : !!first
      // Those holding slots as this run asks: a run of this worktree left over is told as this one starts, or waits.
      const before = told || !opts.root ? [] : slotHolders(dir, opts.alive, (opts.now ?? Date.now)()).filter((c) => c.pid !== owner)
      const r = await trySlot(dir, { ...opts, owner, wait, first: goesFirst })
      if (r.slot !== undefined) {
        await tell(before)
        const file = join(dir, `${SLOT_FILE[r.pool ?? 'heavy']}${r.slot}.json`)
        const release = () => {
          try {
            if (JSON.parse(readFileSync(file, 'utf8')).pid === owner) rmSync(file, { force: true })
          } catch {
            // Gone already.
          }
        }
        process.on('exit', release)
        return { slot: r.slot, pool: r.pool ?? 'heavy', waitedMs: Date.now() - started, release }
      }
      await tell(r.holders)
      if (!wait) return { refused: { ...r, holders: await leftOver(r.holders) } }
      onWait({ ...r, holders: await leftOver(r.holders), first: goesFirst })
      await sleep(pollMs)
    }
  } finally {
    process.off('exit', leaveQueue)
  }
}
