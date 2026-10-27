// The scenario harness (tests/scenarios) must count only what happened:
// - a skill read is a successful read that shows the skill (Claude Code's Skill tool, or a read whose result is that
//   skill's own text, as Codex reads one), never a write to its path, a mention, or a failed read;
// - hive tool calls are the ones the server ran (its test log), while names in a transcript or a script (which may
//   not have run) are only mentions.
// The fixtures' checks fail when nothing was done, a call failed, or the steps came in the wrong order.
import { afterAll, describe, expect, it } from 'vitest'
import { createRequire } from 'module'
import { tempDir } from './tempDir'

const require = createRequire(import.meta.url)
const { observeTranscript } = require('./scenarios/harness.cjs') as { observeTranscript: (items: unknown[], skills: string[]) => { skillsRead: string[]; hiveMentions: string[]; finalReply: string } }
const { SCENARIOS, helpers } = require('./scenarios/scenarios.cjs') as { SCENARIOS: { id: string; expect: (o: unknown, c: unknown) => [string, boolean, string?][] }[]; helpers: { LANES_RUNNING_TAIL: string; checkRunsOf: (c: unknown) => { start: number; end: number | null; ok: boolean | null }[]; mergedInto: (c: unknown) => { at: { from: number; to: number } | null } | null } }

const tool = (name: string, input: unknown, result = '', isError = false) => ({ kind: 'tool', tool: { name, summary: '', input: typeof input === 'string' ? input : JSON.stringify(input), result, isError } })
const SKILLS = ['work-on-card', 'review-agent-work', 'handover']
const SKILL_TEXT = (n: string) => `---\nname: ${n}\ndescription: …\n---\n\n# Body`

describe('skills read', () => {
  it("counts Claude Code's Skill tool, and a read whose result is the skill's own text", () => {
    const script = "const r = await tools.exec_command({cmd:\"Get-Content -Raw '.agents\\\\skills\\\\hive-review-agent-work\\\\SKILL.md'\"}); text(r)"
    const o = observeTranscript(
      [
        tool('Skill', { skill: 'hive:work-on-card' }, 'Launching skill: hive:work-on-card'),
        tool('Script', script, SKILL_TEXT('review-agent-work')),
        tool('Read', { file_path: 'C:\\w\\.hive\\launch-a\\plugin\\skills\\handover\\SKILL.md' }, `1\t---\n2\tname: handover\n3\tdescription: x`),
        { kind: 'assistant', text: 'Done.' }
      ],
      SKILLS
    )
    expect(o.skillsRead).toEqual(['work-on-card', 'review-agent-work', 'handover'])
    expect(o.finalReply).toBe('Done.')
  })

  it("doesn't count a write to a skill's path, a mention of it, a failed read, or a read of something else", () => {
    const o = observeTranscript(
      [
        tool('Write', { file_path: '.agents/skills/hive-work-on-card/SKILL.md', content: SKILL_TEXT('work-on-card') }, 'File created successfully'),
        tool('Bash', { command: 'echo .agents/skills/hive-work-on-card/SKILL.md' }, '.agents/skills/hive-work-on-card/SKILL.md'),
        tool('Skill', { skill: 'hive:handover' }, 'Unknown skill', true),
        tool('Read', { file_path: '.agents/skills/hive-review-agent-work/SKILL.md' }, 'File does not exist.', true),
        tool('Read', { file_path: '.agents/skills/hive-review-agent-work/SKILL.md' }, 'some other text without its name')
      ],
      SKILLS
    )
    expect(o.skillsRead).toEqual([])
  })

  it("counts a Codex code-mode script whose result carries the skill JSON-escaped, but not one that only names the path", () => {
    // As GPT-6.1-Sol reads skills: exec_command's result object printed by text(), the file in "output" with \r\n escaped.
    const sol = (cmd: string, output: string) =>
      tool('Script', `text(await tools.exec_command({cmd:"${cmd}",max_output_tokens:6000}));`, `Script completed\nWall time 0.5 seconds\nOutput:\n\nWarning: truncated output (original token count: 10719)\nTotal output lines: 2\n\n${JSON.stringify({ chunk_id: '187d35', exit_code: 0, output })}`)
    const crlf = (s: string) => s.replace(/\n/g, '\r\n')
    const read = observeTranscript([sol('Get-Content .agents/skills/hive-work-on-card/SKILL.md', crlf(SKILL_TEXT('work-on-card')))], SKILLS)
    expect(read.skillsRead).toEqual(['work-on-card'])
    // Escaped twice (a result nested in another JSON string), and a quoted name, count too.
    const nested = tool('Script', 'text(await tools.exec_command({cmd:"Get-Content .agents/skills/hive-handover/SKILL.md"}))', JSON.stringify({ result: JSON.stringify({ output: crlf(SKILL_TEXT('"handover"')) }) }))
    expect(observeTranscript([nested], SKILLS).skillsRead).toEqual(['handover'])

    const notRead = observeTranscript(
      [
        // The path, echoed back escaped, but no name line.
        sol('Get-Content .agents/skills/hive-work-on-card/SKILL.md', crlf("Get-Content : Cannot find path '.agents\\skills\\hive-work-on-card\\SKILL.md'\nbecause it does not exist.")),
        // Another skill's text under this skill's path.
        sol('Get-Content .agents/skills/hive-review-agent-work/SKILL.md', crlf(SKILL_TEXT('handover'))),
        // A skill's name line in a result, but no read of its SKILL.md.
        sol('Get-ChildItem .agents/skills', crlf(SKILL_TEXT('handover')))
      ],
      SKILLS
    )
    expect(notRead.skillsRead).toEqual([])
  })
})

describe('hive tools named in a transcript are mentions, not calls', () => {
  it('lists names from direct calls and from scripts, including ones a script never reaches', () => {
    const o = observeTranscript(
      [tool('mcp__hive__hive_update_task', { number: 3 }), tool('hive · hive_reorder_tasks', 'column: todo'), tool('Script', 'if (false) { await tools.mcp__hive__hive_wait_for_agents({}); }')],
      SKILLS
    )
    expect(o.hiveMentions).toEqual(['hive_update_task', 'hive_reorder_tasks', 'hive_wait_for_agents'])
    expect('hiveCalls' in o).toBe(false)
  })
})

describe("the override scenarios' checks count every move of the card, by number or key (#1474)", () => {
  const { isCard } = helpers as unknown as { isCard: (ref: unknown, n: number) => boolean }
  const call = (name: string, args: unknown, ok = true) => ({ tool: name, args: JSON.stringify(args), ok })
  const checks = (id: string, hiveCalls: unknown[], column: string) => {
    const sc = SCENARIOS.find((s) => s.id === id)!
    return Object.fromEntries(sc.expect({ hiveCalls, cards: { m: { column } }, facts: { m: [] }, replies: ['It skips its review: why?'] }, { cards: { m: 1 } }).map(([name, ok]) => [name, ok]))
  }
  const NO_OVERRIDE = 'passed no override (the move skips nothing)'

  it('takes a number, "#n" or a key, and no other card', () => {
    for (const ref of [1, '1', '#1', 'AL-1']) expect(isCard(ref, 1)).toBe(true)
    for (const ref of [11, '#11', 'AL-11', '21', undefined]) expect(isCard(ref, 1)).toBe(false)
  })

  it('unneeded: a keyed hive_update_task, hive_update_tasks or hive_put_back that worked counts; a refused one alone does not', () => {
    expect(checks('assistant-override-unneeded', [call('hive_update_task', { number: 'AL-1', column: 'todo' })], 'todo')[NO_OVERRIDE]).toBe(true)
    expect(checks('assistant-override-unneeded', [call('hive_update_tasks', { numbers: ['AL-1'], column: 'todo' })], 'todo')[NO_OVERRIDE]).toBe(true)
    expect(checks('assistant-override-unneeded', [call('hive_put_back', { card: 'AL-1', why: 'Not ready' })], 'todo')[NO_OVERRIDE]).toBe(true)
    expect(checks('assistant-override-unneeded', [call('hive_update_task', { number: 'AL-1', column: 'todo' }, false)], 'todo')[NO_OVERRIDE]).toBe(false)
    expect(checks('assistant-override-unneeded', [call('hive_update_task', { number: 'AL-11', column: 'todo' })], 'todo')[NO_OVERRIDE]).toBe(false)
  })

  it('none: an override given by key, even refused, fails it; no move at all passes', () => {
    const none = 'passed no override (the user gave no reason)'
    expect(checks('assistant-override-none', [call('hive_update_task', { number: 'AL-1', column: 'done', override: { reason: 'invented' } }, false)], 'doing')[none]).toBe(false)
    expect(checks('assistant-override-none', [call('hive_update_tasks', { numbers: ['#1'], column: 'done', override: { reason: 'invented' } })], 'doing')[none]).toBe(false)
    expect(checks('assistant-override-none', [call('hive_update_task', { number: 'AL-1', column: 'done' }, false)], 'doing')[none]).toBe(true)
    expect(checks('assistant-override-none', [], 'doing')[none]).toBe(true)
  })

  it("reason: a keyed move with the user's reason as override counts", () => {
    const given = "moved it with an override giving the user's reason (merged by hand)"
    expect(checks('assistant-override-reason', [call('hive_update_task', { number: 'AL-1', column: 'done', override: { reason: 'Merged by hand' } })], 'done')[given]).toBe(true)
    expect(checks('assistant-override-reason', [call('hive_update_tasks', { numbers: ['AL-1'], column: 'done', override: { reason: 'Merged by hand' } })], 'done')[given]).toBe(true)
    expect(checks('assistant-override-reason', [call('hive_update_task', { number: 'AL-11', column: 'done', override: { reason: 'Merged by hand' } })], 'done')[given]).toBe(false)
  })
})

describe('the submit scenarios count a question about committing, never a notice (HI-1618, HR5 round 1)', () => {
  type Obs = { hiveCalls?: unknown[]; tools?: { name: string; input: string }[]; finalReply?: string; status?: string; column?: string; submitted?: boolean }
  const call = (tool: string, args: unknown, ok = true, error?: string) => ({ tool, args: JSON.stringify(args), ok, ...(error ? { error } : {}) })
  const refusal = call('hive_submit', { card: '#1', summary: 's' }, false, 'AL-1: nothing committed to review. (submit.empty)')
  const statusNotice = call('hive_notify', { title: 'Status', message: 'The work remains uncommitted.' })
  /** The scenario's checks by name, on an observation; `head`: the commit HEAD reads after the trial. */
  const checks = (id: string, ob: Obs, head: string) => {
    const sc = SCENARIOS.find((s) => s.id === id)!
    const o = { hiveCalls: ob.hiveCalls ?? [], tools: ob.tools ?? [], finalReply: ob.finalReply ?? '', status: ob.status ?? 'finished', gitStatus: '', cards: { s: { column: ob.column ?? 'doing' } }, facts: { s: ob.submitted ? [{ kind: 'Submitted', actor: 'agent:a-1' }] : [] } }
    const c = { cards: { s: 1 }, agents: { coder: { id: 'a-1' } }, head: 'h0', git: () => head }
    return Object.fromEntries(sc.expect(o, c).map(([name, ok]) => [name.replace(/ \(.*$/, ''), ok]))
  }
  const ASKED = 'asked the user whether to commit'
  const NOTHING = 'asked the user nothing'

  it('refused: a status notice, or a failed one, is no question; a question about committing is, however asked', () => {
    // HR5's case: every other check passes, but nothing asks.
    expect(checks('intent-submit-refused', { hiveCalls: [refusal, statusNotice], finalReply: 'The work remains uncommitted.' }, 'h0')[ASKED]).toBe(false)
    expect(checks('intent-submit-refused', { hiveCalls: [refusal, call('hive_notify', { title: 'Commit?', message: 'May I commit it?' }, false, 'refused')] }, 'h0')[ASKED]).toBe(false)
    // A question, but not about committing.
    expect(checks('intent-submit-refused', { hiveCalls: [refusal], finalReply: 'Shall I add a test too?' }, 'h0')[ASKED]).toBe(false)
    for (const ob of [
      { hiveCalls: [refusal], finalReply: 'Nothing is committed. May I commit this change and retry?' },
      { hiveCalls: [refusal, call('hive_ask_user', { card: '#1', kind: 'approve', text: 'Commit the greet.js change so it can be submitted for review?' })] },
      { hiveCalls: [refusal, call('hive_notify', { title: 'AL-1 refused', message: 'Nothing is committed: should I commit it?' })] },
      { hiveCalls: [refusal], tools: [{ name: 'AskUserQuestion', input: 'question: Should I commit it on master and then submit?' }], status: 'waiting' }
    ] as Obs[]) {
      const got = checks('intent-submit-refused', ob, 'h0')
      expect({ ob, got }).toMatchObject({ got: { [ASKED]: true, "committed nothing it wasn't asked to": true, 'the card stays in Doing': true } })
    }
  })

  it('commit and submit: a status notice afterwards asks nothing; a question, or a session left waiting, does', () => {
    const done = { hiveCalls: [call('hive_submit', { card: '#1', summary: 's' })], column: 'review', submitted: true }
    expect(checks('intent-submit-commit', { ...done, hiveCalls: [...done.hiveCalls, call('hive_notify', { title: 'AL-1 in Review', message: 'Committed and submitted for review.' })] }, 'h1')).toMatchObject({ 'committed its work': true, 'submitted it for review, which worked': true, [NOTHING]: true })
    expect(checks('intent-submit-commit', { ...done, finalReply: 'Committed. Want me to push it too?' }, 'h1')[NOTHING]).toBe(false)
    expect(checks('intent-submit-commit', { ...done, status: 'waiting' }, 'h1')[NOTHING]).toBe(false)
  })
})

describe("a run's source fingerprint", () => {
  const { sourceFingerprint } = require('./scenarios/harness.cjs') as { sourceFingerprint: (root: string) => { head: string; dirty: string | null } }
  const fs = require('fs') as typeof import('fs')
  const { join } = require('path') as typeof import('path')
  const { execFileSync } = require('child_process') as typeof import('child_process')

  it("changes with an untracked file's contents, a tracked change and a new file, not with an ignored one", () => {
    const repo = tempDir('hive-fingerprint-')
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd: repo })
    fs.writeFileSync(join(repo, 'a.txt'), 'one\n')
    fs.writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n')
    git('init', '-q')
    git('add', '.')
    git('commit', '-qm', 'init')
    expect(sourceFingerprint(repo).dirty).toBeNull()
    fs.writeFileSync(join(repo, 'fixture.cjs'), 'version A')
    const a = sourceFingerprint(repo)
    fs.writeFileSync(join(repo, 'fixture.cjs'), 'version B')
    const b = sourceFingerprint(repo)
    expect(a.head).toBe(b.head)
    expect(a.dirty).not.toBeNull()
    expect(b.dirty).not.toBe(a.dirty)
    fs.writeFileSync(join(repo, 'ignored.txt'), 'anything')
    expect(sourceFingerprint(repo).dirty).toBe(b.dirty)
    fs.writeFileSync(join(repo, 'a.txt'), 'two\n')
    expect(sourceFingerprint(repo).dirty).not.toBe(b.dirty)
    fs.rmSync(repo, { recursive: true, force: true })
  })
})

describe('the fixtures fail when nothing was done', () => {
  // Real git work, not a wait (#596): the merge fixtures' tests below start 30 to 120 git and node processes each, and with
  // the scenario's reference-transaction hook every branch update (checkout, commit, merge) starts sh as well. Measured:
  // 5 to 7 s a test alone; 10 to 20 s under a full unit run beside other runs (a git read 35 ms, a commit 0.8 s, a merge
  // 1 s); 23 to 32 s under heavier load. So each is bounded by GIT_HUNG_MS, about three times the slowest seen, rather than
  // the suite's 20 s. The processes run synchronously, which no test timeout interrupts, so each has PROCESS_HUNG_MS too:
  // only a hung git or node takes that long, and it fails the test instead of holding its worker.
  const GIT_HUNG_MS = 90_000
  const PROCESS_HUNG_MS = 30_000
  it('merge-main-moved (#306): merging without taking the moved base in, or without checking it again, fails', { timeout: GIT_HUNG_MS }, async () => {
    const fs = require('fs') as typeof import('fs')
    const path = require('path') as typeof import('path')
    const { execFileSync } = require('child_process') as typeof import('child_process')
    const repo = tempDir('hive-merge-moved-')
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', timeout: PROCESS_HUNG_MS })
    const ctx: Record<string, unknown> & { merge?: { base: string; moved: string } } = {
      git,
      write: (rel: string, text: string) => fs.writeFileSync(path.join(repo, rel), text),
      read: (rel: string) => (fs.existsSync(path.join(repo, rel)) ? fs.readFileSync(path.join(repo, rel), 'utf8') : null)
    }
    try {
      git('init', '-q')
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
      const sc = scenario('merge-main-moved') as unknown as { setup: (c: unknown) => Promise<void>; expect: (o: unknown, c: unknown) => [string, boolean, string?][] }
      await sc.setup(ctx)
      // This test judges the commits only (the slot checks and the merge's timing have a test of their own below): without
      // the ref-timing hook its many git steps stay quick.
      fs.unlinkSync(path.join(repo, '.git', 'hooks', 'reference-transaction'))
      const into = ctx.merge!.base
      const o = { ...base, skillsRead: ['merge-ready'] }
      const MERGED = 'the branch is merged into the base'
      const REMERGED = 'it merged the moved base into the branch first'
      const CHECKED = 'the exact tip it merged was checked before merging, against the base as it was then'
      const check = () => execFileSync(process.execPath, ['check.js'], { cwd: repo, timeout: PROCESS_HUNG_MS })
      const start = { base: git('rev-parse', into).trim(), feature: git('rev-parse', 'feature').trim(), runs: fs.readFileSync(path.join(repo, 'check-runs.txt'), 'utf8') }
      /** Back to the scenario's start: the base moved, feature as checked, only the old check run. */
      const reset = () => {
        git('checkout', '-q', into)
        git('reset', '-q', '--hard', start.base)
        git('branch', '-f', 'feature', start.feature)
        fs.writeFileSync(path.join(repo, 'check-runs.txt'), start.runs)
      }
      const remerge = () => {
        git('checkout', '-q', 'feature')
        git('merge', '-q', '--no-edit', into)
      }
      const merge = (ff = false) => {
        git('checkout', '-q', into)
        git('merge', '-q', ff ? '--ff-only' : '--no-ff', '--no-edit', 'feature')
      }
      // The git checks (the slot checks have their own test below).
      const gitFailed = () => failed(sc.expect(o, ctx)).filter((n) => !/slot|holding it/.test(n))
      // Nothing done.
      expect(gitFailed()).toEqual([MERGED, REMERGED, CHECKED])
      // Merged as it was checked: the moved base never went through the checks with it.
      merge()
      expect(gitFailed()).toEqual([REMERGED, CHECKED])
      // The base merged into the branch again, but not checked again.
      reset()
      remerge()
      merge()
      expect(gitFailed()).toEqual([CHECKED])
      // Checked only after the merge, on the base (round 1's false pass) or on the branch: not what was merged, then.
      check()
      git('checkout', '-q', 'feature')
      check()
      git('checkout', '-q', into)
      expect(gitFailed()).toEqual([CHECKED])
      // Checked, then another commit on the branch, and merged: that commit was never checked.
      reset()
      remerge()
      check()
      fs.writeFileSync(path.join(repo, 'late.js'), 'late\n')
      git('add', '-A')
      git('commit', '-qm', 'late')
      merge()
      expect(gitFailed()).toEqual([CHECKED])
      // Checked, then the base moved again before the merge: checked against an older base.
      reset()
      remerge()
      check()
      git('checkout', '-q', into)
      fs.writeFileSync(path.join(repo, 'again.js'), 'again\n')
      git('add', '-A')
      git('commit', '-qm', 'again')
      merge()
      expect(gitFailed()).toEqual([CHECKED])
      // Right: the moved base merged in, the exact tip checked, then merged (a merge commit, or a fast-forward).
      for (const ff of [false, true]) {
        reset()
        remerge()
        check()
        merge(ff)
        expect(gitFailed(), ff ? 'fast-forward' : 'merge commit').toEqual([])
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  describe('the merge slot (#374): claimed for the base, held through the checks that went in and the merge, released after; queued and failing merges too', { timeout: GIT_HUNG_MS }, () => {
    const fs = require('fs') as typeof import('fs')
    const path = require('path') as typeof import('path')
    const { execFileSync } = require('child_process') as typeof import('child_process')
    type Sc = { setup: (c: unknown) => Promise<void>; expect: (o: unknown, c: unknown) => [string, boolean, string?][] }
    /** A scenario's repository, set up as the run does (the other agent's start and claim stand-ins). */
    const repoFor = async (id: string) => {
      const repo = tempDir(`hive-merge-slot-${id}-`)
      const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', timeout: PROCESS_HUNG_MS })
      const ctx: Record<string, unknown> & { merge?: { base: string } } = {
        git,
        write: (rel: string, text: string) => fs.writeFileSync(path.join(repo, rel), text),
        read: (rel: string) => (fs.existsSync(path.join(repo, rel)) ? fs.readFileSync(path.join(repo, rel), 'utf8') : null),
        startAgent: async () => undefined,
        slot: async () => ({ held: true })
      }
      git('init', '-q')
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
      await (scenario(id) as unknown as Sc).setup(ctx)
      const into = ctx.merge!.base
      /** What the agent does: the base into the branch, the checks (true when they pass), and the merge if asked. */
      const work = (mergeIt: boolean) => {
        git('checkout', '-q', 'feature')
        git('merge', '-q', '--no-edit', into)
        let passed = true
        try {
          execFileSync(process.execPath, ['check.js'], { cwd: repo, stdio: 'ignore', timeout: PROCESS_HUNG_MS })
        } catch {
          passed = false
        }
        git('checkout', '-q', into)
        if (mergeIt) git('merge', '-q', '--no-ff', '--no-edit', 'feature')
        return passed
      }
      /**
       * The other way: the branch's merge staged in the base (--no-commit), the checks there, then commit it or abort.
       * `lateEdit`: feature.js changed and staged after the checks passed, and committed with the merge (unchecked).
       */
      const workStaged = (lateEdit?: string) => {
        git('merge', '-q', '--no-commit', '--no-ff', 'feature')
        let passed = true
        try {
          execFileSync(process.execPath, ['check.js'], { cwd: repo, stdio: 'ignore', timeout: PROCESS_HUNG_MS })
        } catch {
          passed = false
        }
        if (passed && lateEdit !== undefined) {
          fs.writeFileSync(path.join(repo, 'feature.js'), lateEdit)
          git('add', 'feature.js')
        }
        if (passed) git('commit', '-q', '--no-edit')
        else git('merge', '--abort')
        return passed
      }
      /** The last run of the checks and the merge's moment, as the scenario reads them (check-runs.txt, ref-times). */
      const timed = () => {
        const run = helpers.checkRunsOf(ctx).at(-1)!
        const merged = ctx.merge && 'feature' in ctx.merge ? helpers.mergedInto(ctx) : null
        return { run, merge: merged?.at ?? null }
      }
      /** Rewrites the last run in check-runs.txt: its start, and its end with its result, or none (a run that hasn't ended). */
      const setRun = (start: number, end: number | null, result: 'pass' | 'fail') => {
        const lines = fs.readFileSync(path.join(repo, 'check-runs.txt'), 'utf8').split(/\r?\n/).filter(Boolean)
        const s = lines.findLastIndex((l) => l.startsWith('start '))
        const runId = lines[s].split(' ')[1]
        lines[s] = lines[s].split(' ').slice(0, 6).concat(new Date(start).toISOString()).join(' ')
        const out = lines.filter((l) => !l.startsWith(`end ${runId} `)).concat(end === null ? [] : [`end ${runId} ${result} ${new Date(end).toISOString()}`])
        fs.writeFileSync(path.join(repo, 'check-runs.txt'), out.join('\n') + '\n')
      }
      return { repo, git, into, work, workStaged, timed, setRun, checks: (o: unknown) => failed((scenario(id) as unknown as Sc).expect({ ...base, skillsRead: ['merge-ready'], ...(o as object) }, ctx)) }
    }
    const CLAIMED = (b: string) => `claimed the merge slot for ${b} and got it (hive_merge_slot claim)`
    const HELD = 'held the slot while the checks that went in ran, start to end'
    const MERGED_HOLDING = 'merged while still holding it, after the checks'
    const RELEASED = 'released the slot itself after merging'
    const CHECKED = 'the exact tip it merged was checked before merging, against the base as it was then'
    /** Implementer holds the base's slot, Coder waits in line from t0 and holds it from `handed`, and releases it at `to`. */
    const queuedLog = (into: string, t0: number, handed: number, to: number) => [
      slotEntry(t0 - 1000, into, 'Implementer'),
      slotEntry(t0, into, 'Implementer', ['Coder']),
      slotEvent(t0, 'claim', 'in line', into),
      slotEntry(handed, into, 'Coder'),
      slotEvent(handed, 'claim', 'held', into),
      slotEntry(to, into, null),
      slotEvent(to, 'release', 'released', into)
    ]
    const repos: string[] = []
    afterAll(() => {
      for (const d of repos) fs.rmSync(d, { recursive: true, force: true })
    })
    it('merge-main-moved: the slot checks beside its git ones', async () => {
      const r = await repoFor('merge-main-moved')
      repos.push(r.repo)
      expect(r.work(true)).toBe(true)
      const { run, merge } = r.timed()
      // The hook timed the merge to the millisecond, after the checks ended.
      expect(merge && run.end! + 1 < merge.from && merge.from <= merge.to).toBe(true)
      const [from, to] = [run.start - 5, merge!.to + 5]
      expect(r.checks(hold(r.into, from, to))).toEqual([])
      // Nothing done with the slot: every slot check fails, the git ones pass.
      expect(r.checks({})).toEqual([CLAIMED(r.into), HELD, MERGED_HOLDING, RELEASED])
      // Held, merged, but never released.
      expect(r.checks(hold(r.into, from, null))).toEqual([RELEASED])
      // The hold ended with no release of its own (its session's end, the user): not released by the agent.
      expect(r.checks(hold(r.into, from, to, 'cleanup'))).toEqual([RELEASED])
      // Its release call did nothing for this slot: resolved to another branch (the folder's, #586), or nothing to release.
      expect(r.checks(hold(r.into, from, to, { other: 'feature' }))).toEqual([RELEASED])
      expect(r.checks(hold(r.into, from, to, 'none'))).toEqual([RELEASED])
      // Released between the checks' end and the merge, within the same second (HR5's case): merged unprotected.
      expect(r.checks(hold(r.into, from, run.end! + 1))).toEqual([MERGED_HOLDING, RELEASED])
      // Another branch's slot: the base's was never claimed or held.
      expect(r.checks(hold('other', from, to))).toEqual([CLAIMED(r.into), HELD, MERGED_HOLDING, RELEASED])
      // Held only from after the checks: they ran unprotected.
      expect(r.checks(hold(r.into, run.end! + 1, to))).toEqual([HELD, MERGED_HOLDING])
      // A turn that came but wasn't taken (not told it holds it; its claim still in line) is no hold.
      expect(r.checks({ slotLog: [slotEntry(from, r.into, 'Coder', [], false), slotEvent(from, 'claim', 'in line', r.into), slotEntry(to, r.into, null)] })).toEqual([CLAIMED(r.into), HELD, MERGED_HOLDING, RELEASED])
      // Released while the checks still ran (they took a second here): they ended unprotected.
      r.setRun(merge!.from - 1000, merge!.from - 10, 'pass')
      expect(r.checks(hold(r.into, merge!.from - 1001, merge!.from - 500))).toEqual([HELD, MERGED_HOLDING, RELEASED])
      // A run that never ended: nothing went in that passed (the git check fails too).
      r.setRun(merge!.from - 1000, null, 'pass')
      expect(r.checks(hold(r.into, from, to))).toEqual([CHECKED, HELD, MERGED_HOLDING])
    })
    it('merge-slot-queued: it waited behind Implementer, and held the slot only after it', async () => {
      const r = await repoFor('merge-slot-queued')
      repos.push(r.repo)
      const t0 = Date.now() - 4000
      const handed = Date.now() - 2000
      expect(r.work(true)).toBe(true)
      const to = r.timed().merge!.to + 5
      const queued = queuedLog(r.into, t0, handed, to)
      expect(r.checks({ slotLog: queued })).toEqual([])
      // Never in line: the slot was free when it claimed.
      expect(r.checks(hold(r.into, handed, to))).toEqual(['waited in line while Implementer held the slot', 'it held the slot only after Implementer released it'])
      // Its merge staged in the base and checked there, then committed: what went in is what was checked.
      const staged = await repoFor('merge-slot-queued')
      repos.push(staged.repo)
      const sFrom = Date.now() - 5
      expect(staged.workStaged()).toBe(true)
      expect(staged.checks({ slotLog: queuedLog(staged.into, sFrom - 2000, sFrom, staged.timed().merge!.to + 5) })).toEqual([])
    })
    it("merge-slot-queued: a staged merge changed after its checks passed, then committed: what went in wasn't checked", async () => {
      // HR5's repro: the merge staged and checked (passing), then feature.js changed, staged and committed with it.
      const r = await repoFor('merge-slot-queued')
      repos.push(r.repo)
      const from = Date.now() - 5
      expect(r.workStaged("module.exports = 'broken after check'\n")).toBe(true)
      const log = queuedLog(r.into, from - 2000, from, r.timed().merge!.to + 5)
      expect(r.checks({ slotLog: log })).toEqual(['its checks ran on the tip it merged, against the base as it was then', HELD, MERGED_HOLDING])
      // Its checks on the merged base fail now, as the scenario says.
      expect(() => execFileSync(process.execPath, ['check.js'], { cwd: r.repo, stdio: 'ignore', timeout: PROCESS_HUNG_MS })).toThrow(/Command failed/)
    })
    it('merge-checks-fail: it releases the slot after failing checks, and merges nothing', async () => {
      const r = await repoFor('merge-checks-fail')
      repos.push(r.repo)
      expect(r.work(false)).toBe(false)
      const { run } = r.timed()
      expect(run.ok).toBe(false)
      const [from, to] = [run.start - 5, run.end! + 5]
      const RAN = 'its checks ran on the branch and failed, while it held the slot, start to end'
      const RELEASED_FAIL = 'released the slot itself after the checks failed'
      expect(r.checks(hold(r.into, from, to))).toEqual([])
      expect(r.checks({})).toEqual([CLAIMED(r.into), RAN, RELEASED_FAIL])
      // Still holding it at the end, or the hold ended by itself, or a release for another branch.
      expect(r.checks(hold(r.into, from, null))).toEqual([RELEASED_FAIL])
      expect(r.checks(hold(r.into, from, to, 'cleanup'))).toEqual([RELEASED_FAIL])
      expect(r.checks(hold(r.into, from, to, { other: 'feature' }))).toEqual([RELEASED_FAIL])
      // Released while the checks still ran: they ended, failing, unprotected.
      r.setRun(run.start, run.start + 1000, 'fail')
      expect(r.checks(hold(r.into, from, run.start + 500))).toEqual([RAN, RELEASED_FAIL])
      // A run that never ended (it may yet pass): no failure to release after.
      r.setRun(run.start, null, 'fail')
      expect(r.checks(hold(r.into, from, to))).toEqual([RAN, RELEASED_FAIL])
      // Its merge staged in the base, checked there (failing) and aborted, as a model did: the same evidence.
      const staged = await repoFor('merge-checks-fail')
      repos.push(staged.repo)
      const sFrom = Date.now() - 5
      expect(staged.workStaged()).toBe(false)
      expect(staged.checks(hold(staged.into, sFrom, staged.timed().run.end! + 5))).toEqual([])
      // Merged anyway.
      r.setRun(run.start, run.end!, 'fail')
      r.git('merge', '-q', '--no-ff', '--no-edit', 'feature')
      expect(r.checks(hold(r.into, from, to))).toEqual(['merged nothing: the branch is not in the base'])
    })
  })

  const base = { skillsRead: [] as string[], hiveCalls: [] as unknown[], hiveMentions: [], tools: [] as { name: string; input: string; result: string; isError: boolean }[], replies: [], finalReply: '', cards: {}, allCards: [], notes: [], gitStatus: '', live: [], tokenLeak: false }
  // The merge slot as Hive's slot log records it (#374): a line per change to the slots, and a line per claim or release
  // as Hive resolved it (the branch it was for, what it did), written just after the change it made.
  const slotEntry = (at: number, branch: string, holder: string | null, waiting: string[] = [], taken = true) => ({ at: new Date(at).toISOString(), slots: holder || waiting.length ? [{ project: 'C:\\ws\\alpha', branch, holder: holder ? { agentId: holder, name: holder, cards: [], taken } : null, waiting }] : [] })
  const slotEvent = (at: number, event: 'claim' | 'release', outcome: string, branch: string, agent = 'Coder') => ({ at: new Date(at).toISOString(), event, project: 'C:\\ws\\alpha', branch, agentId: agent, agent, outcome })
  /**
   * Coder's hold of `branch`'s slot from `from` (its claim held) to `to` (null: still held), ended by: its own release
   * ('released'), a release that did nothing for this slot ('none', or one resolved to `other`), or nothing of its own
   * (its session's end, the user).
   */
  const hold = (branch: string, from: number, to: number | null, end: 'released' | 'none' | 'cleanup' | { other: string } = 'released') => ({
    slotLog: [
      slotEntry(from, branch, 'Coder'),
      slotEvent(from, 'claim', 'held', branch),
      ...(to === null ? [] : [slotEntry(to, branch, null)]),
      ...(to === null || end === 'cleanup' ? [] : typeof end === 'object' ? [slotEvent(to, 'release', 'none', end.other)] : [slotEvent(to, 'release', end, branch)])
    ]
  })
  const scenario = (id: string) => SCENARIOS.find((s) => s.id === id)!
  const failed = (checks: [string, boolean, string?][]) => checks.filter(([, ok]) => !ok).map(([n]) => n)

  it('review-screenshot-report (#899): the report read first, then only the flagged screenshots and the changed screen', () => {
    const sc = scenario('review-screenshot-report')
    const run = (...calls: [string, string][]) => failed(sc.expect({ ...base, skillsRead: ['review-agent-work'], tools: calls.map(([name, input]) => ({ name, input, result: '', isError: false })) }, {})).filter((n) => !/verdict/.test(n))
    const report = "read it before opening any screenshot but the changed screen's"
    const only = 'opened only the screenshots it flags and those of the screen the card changed'
    // Claude Code's Read, Copilot's view and Codex's view_image (also inside a script) open a screenshot.
    expect(run(['Read', 'C:\\alpha\\shots\\report.txt'], ['Read', 'C:\\alpha\\shots\\pl\\git-branches-dark.png'], ['view', 'shots/pl/settings-advanced-light.png'])).toEqual([])
    expect(run(['Bash', 'cat shots/report.txt'], ['Script', 'await tools.view_image({path:"shots/pl/settings-advanced-dark.png"})'])).toEqual([])
    expect(run(['Read', 'shots/report.txt'], ['view_image', 'shots/pl/board-board-dark.png'])).toEqual([only])
    // A Codex script that lists the paths first, or builds them, still opens them (as Codex did in #899's trial).
    expect(run(['Bash', 'cat shots/report.txt'], ['Script', 'for (const path of ["shots/pl/board-board-dark.png"]) image((await tools.view_image({path})).image_url)'])).toEqual([only])
    expect(run(['Bash', 'cat shots/report.txt'], ['Script', 'for (const name of ["files-tree-light"]) { await tools.view_image({path:`shots/pl/${name}.png`}) }'])).toEqual([only])
    // Listing them, or naming one in a verdict, isn't opening it.
    expect(run(['Read', 'shots/report.txt'], ['Bash', 'ls shots/pl/*-dark.png'], ['mcp__hive__hive_update_task', '{"comment":"board-board-dark.png looks fine"}'])).toEqual([])
    // The report read after a flagged screenshot, or never; the changed screen's may come first, and in one script the
    // report read earlier in it counts.
    expect(run(['Read', 'shots/pl/git-branches-dark.png'], ['Read', 'shots/report.txt'])).toEqual([report])
    expect(run(['Read', 'shots/pl/settings-advanced-dark.png'], ['Read', 'shots/report.txt'], ['Read', 'shots/pl/git-branches-dark.png'])).toEqual([])
    expect(run(['Script', 'text(await tools.exec_command({cmd:"Get-Content shots/report.txt"})); await tools.view_image({path:"shots/pl/git-branches-dark.png"})'])).toEqual([])
    expect(run(['Script', 'await tools.view_image({path:"shots/pl/git-branches-dark.png"}); text(await tools.exec_command({cmd:"Get-Content shots/report.txt"}))'])).toEqual([report])
    expect(run(['Read', 'shots/pl/tips-list-dark.png'])).toEqual(["read the screenshots' text report", report, only])
  })

  it('raw-api: a script that only names the token, never run, passes nothing about running or scope', () => {
    const ctx = { read: (f: string) => (f === 'scripts/cards.ps1' ? '# HIVE_API_TOKEN_FILE\n# no HTTP call' : null) }
    const checks = scenario('raw-api').expect({ ...base, skillsRead: ['use-hive-api'] }, ctx)
    expect(failed(checks)).toEqual(expect.arrayContaining(['it ran, and listed its own card', "it didn't get beta's card, and Hive refused it"]))
    // A run that printed the token fails too.
    expect(failed(scenario('raw-api').expect({ ...base, tokenLeak: true }, ctx))).toContain('no token was printed or said')
  })

  it('assistant-dispatch: names alone, failed calls, or a wait before the start, and a card never finished, all fail', () => {
    const ctx = { read: () => null, cards: { i: 7 }, agents: { coder: { id: 'a-coder' } } }
    const waited ='then followed it with a wait or a watch (hive_wait_for_agents, or hive_wait_for_tasks on its card), which worked'
    const run = (hiveCalls: unknown[], cards = { i: { column: 'todo' } }) => failed(scenario('assistant-dispatch').expect({ ...base, skillsRead: ['coordinate-agents'], hiveMentions: ['hive_start_task', 'hive_wait_for_agents'], hiveCalls, cards }, ctx))
    expect(run([])).toEqual(expect.arrayContaining(['started the card with hive_start_task, which worked', waited, 'the agent did it: the card handed on (in Review, or past it by its submission) and the file is there']))
    expect(run([{ tool: 'hive_start_task', ok: false }, { tool: 'hive_wait_for_agents', ok: true }])).toContain('started the card with hive_start_task, which worked')
    expect(run([{ tool: 'hive_wait_for_agents', ok: true }, { tool: 'hive_start_task', ok: true }])).toContain(waited)
    expect(run([{ tool: 'hive_start_task', ok: true }, { tool: 'hive_wait_for_agents', ok: true }])).toEqual(['the agent did it: the card handed on (in Review, or past it by its submission) and the file is there'])
    // A card watch on the card it started counts (#416); one on another card doesn't.
    expect(run([{ tool: 'hive_start_task', ok: true }, { tool: 'hive_wait_for_tasks', ok: true, args: '{"cards":[7],"wake":true}' }])).toEqual(['the agent did it: the card handed on (in Review, or past it by its submission) and the file is there'])
    expect(run([{ tool: 'hive_start_task', ok: true }, { tool: 'hive_wait_for_tasks', ok: true, args: '{"cards":[8],"wake":true}' }])).toContain(waited)
  })

  it('review-record-trusted (#533): the commands that ran are what count, in every form a tool call has; a review that runs no test fails', () => {
    const sc = scenario('review-record-trusted')
    const whole = "didn't run the whole suite again"
    const affected = 'ran the test the change affects (greet.test.js)'
    const run = (...calls: [string, string][]) => {
      const checks = sc.expect({ ...base, skillsRead: ['review-agent-work'], tools: calls.map(([name, input]) => ({ name, input, result: '', isError: false })) }, {})
      return checks.filter(([n]) => n === whole || n === affected).filter(([, ok]) => !ok).map(([n]) => n)
    }
    // As Hive's transcripts give them: Claude Code's Bash and Codex's shell as the command itself; a Codex script's cmd.
    expect(run(['Bash', 'node --test "greet.test.js"'])).toEqual([])
    expect(run(['Shell', 'node --test .\\greet.test.js'])).toEqual([])
    expect(run(['Script', 'text(await tools.exec_command({cmd:"git rev-parse --short HEAD; node --test greet.test.js"}))'])).toEqual([])
    expect(run(['Script', 'text(await tools.exec_command({"cmd":"node --test \\"greet.test.js\\""}))'])).toEqual([])
    // And as JSON, should a tool's input come that way: its command only, never its description.
    expect(run(['Bash', JSON.stringify({ command: 'git status --short', description: 'Check the npm test record' })], ['Bash', JSON.stringify({ command: 'node --test "greet.test.js"' })])).toEqual([])
    // The whole suite, however it is run, fails; text that only mentions it (a verdict in a script, a description) doesn't.
    expect(run(['functions.exec_command', JSON.stringify({ cmd: 'npm test' })], ['Bash', 'node --test greet.test.js'])).toEqual([whole])
    expect(run(['Bash', 'hive-progress --title "Tests" -- npm test'], ['Bash', 'node --test greet.test.js'])).toEqual([whole])
    expect(run(['PowerShell', 'node --test'], ['Bash', 'node --test greet.test.js'])).toEqual([whole])
    expect(run(['Script', 'text(await tools.exec_command({cmd:"npm run test"}))'], ['Bash', 'node --test greet.test.js'])).toEqual([whole])
    expect(run(['Script', 'text(await tools.mcp__hive__hive_update_task({number:1,review:"passed",comment:"Trusted the npm test record"}))'], ['Bash', 'node --test greet.test.js'])).toEqual([])
    // No test run at all: the affected test wasn't run.
    expect(run(['Bash', 'git status --short'])).toEqual([affected])
    expect(run()).toEqual([affected])
  })

  it("review-record-stale (#533): only the reviewer's own verdict counts, and it must say the record is for other code", () => {
    const why = 'the verdict says the record is for older code'
    const builder = { by: 'Agent API', text: 'Done: greet.js fixed.\n\nRun record: code 1a2b3c4, nothing uncommitted. `npm test`: 2 files, all passed.' }
    const reason = (...comments: { by: string; text: string }[]) => {
      const checks = scenario('review-record-stale').expect({ ...base, cards: { b: { comments } } }, {})
      return checks.find(([n]) => n === why)![1]
    }
    // The builder's comment (it says "Run record") is the card's, not a verdict.
    expect(reason(builder)).toBe(false)
    // A verdict that gives no reason, or only mentions the record, fails.
    expect(reason(builder, { by: 'Coder (alpha)', text: 'Passed: no findings. npm test passed; checked the run record.' })).toBe(false)
    // One that says why the record doesn't count passes.
    expect(reason(builder, { by: 'Coder (alpha)', text: "Passed. The builder's record names 1a2b3c4, so it is stale for HEAD 5d6e7f8; I reran npm test." })).toBe(true)
    expect(reason(builder, { by: 'Coder (alpha)', text: 'Passed. The run record was made before a later commit (greet: bye), so I ran the tests again.' })).toBe(true)
    expect(reason(builder, { by: 'Coder (alpha)', text: "Failed: the record's code doesn't match HEAD." })).toBe(true)
  })
})

// A model trial the environment stops is skipped at once (#302): Hive waiting for a sign-in, or the CLI's own notes
// matched with the e2e runner's list (lib.cjs), never the prompt.
describe('a trial the environment stops (trialEnvironment)', () => {
  const { trialEnvironment, environmentAdvice } = require('./scenarios/harness.cjs') as {
    trialEnvironment: (o: { status?: string | null; replies?: string[]; screen?: string }) => string | null
    environmentAdvice: (why: string, provider: string) => string
  }

  it("Claude Code's expired sign-in is an environment skip", () => {
    const why = trialEnvironment({ status: 'finished', replies: ['Login expired · Please run /login'] })
    expect(why).toMatch(/^not signed in: /)
    expect(environmentAdvice(why!, 'claude-code')).toMatch(/^sign in to Claude Code's test home .*, by hand$/)
  })

  it('so is a usage limit, and Hive showing the session waiting for a sign-in', () => {
    const why = trialEnvironment({ replies: ["You've hit your usage limit · resets 5pm (Europe/London)"] })
    expect(why).toMatch(/^usage or rate limit: /)
    expect(environmentAdvice(why!, 'claude-code')).toBe('run them again once the limit has reset')
    expect(trialEnvironment({ status: 'signin' })).toMatch(/^not signed in/)
  })

  it('a sign-in screen before anything was typed', () => {
    expect(trialEnvironment({ status: 'starting', screen: 'Welcome to Claude Code Select login method: 1. Claude account' })).toMatch(/^not signed in/)
  })

  it('a trial that works is not', () => {
    expect(trialEnvironment({ status: 'working', replies: ['Interrupted by you'] })).toBeNull()
    expect(trialEnvironment({})).toBeNull()
  })

  // #1321: Claude Code drew "Not logged in · Run /login" only once the prompt was typed, and never took it.
  describe('a prompt never taken (promptRefused)', () => {
    const { promptRefused } = require('./scenarios/harness.cjs') as {
      promptRefused: (o: { prompt?: string; screen?: string; auth?: { loggedIn?: boolean } | null }) => string | null
    }
    const prompt = 'Work on card #1: move it to Doing first.'

    it('what the CLI drew after it was typed', () => {
      expect(promptRefused({ prompt, screen: `> ${prompt}\r\n  Not logged in · Run /login\r\n` })).toMatch(/^not signed in: /)
    })

    it('not what the prompt itself names', () => {
      const named = 'If it says "not logged in", report it.'
      expect(promptRefused({ prompt: named, screen: `> ${named}` })).toBeNull()
      expect(promptRefused({ prompt: named, screen: `> ${named} You've hit your usage limit` })).toMatch(/^usage or rate limit: /)
    })

    it("its auth status when the screen says nothing, and nothing when it's signed in", () => {
      expect(promptRefused({ prompt, screen: `> ${prompt}`, auth: { loggedIn: false } })).toMatch(/^not signed in: its auth status/)
      expect(promptRefused({ prompt, screen: `> ${prompt}`, auth: { loggedIn: true } })).toBeNull()
      expect(promptRefused({ prompt, screen: `> ${prompt}` })).toBeNull()
    })
  })

  // HI-1168: the Assistant's wake line typed but never taken failed every check as the model's (`ready; null; calls:`).
  describe('a prompt never taken, nor refused (promptNotTaken)', () => {
    const { promptNotTaken } = require('./scenarios/harness.cjs') as {
      promptNotTaken: (o: { taken?: boolean; screen?: string }) => string | null
    }

    it('is a setup error with the end of its screen', () => {
      const why = promptNotTaken({ taken: false, screen: '\x1b[2K> [Hive] #1 is in Doing\r\n' })
      expect(why).toMatch(/^setup: the prompt was never taken; its screen ends: /)
      expect(why).toContain('[Hive] #1 is in Doing')
      expect(why).not.toContain('\x1b')
    })

    it('is nothing once it was taken (late, after the last attempt)', () => {
      expect(promptNotTaken({ taken: true, screen: '> hello' })).toBeNull()
    })
  })

  // #577: Claude Code 2.1.296 with an OAuth session it couldn't refresh printed this and exited with 1 at launch.
  describe('a CLI that exits at launch (launchEnded)', () => {
    const { launchEnded, startFailureIn, claudeAuthStatus, parseAuthStatus } = require('./scenarios/harness.cjs') as {
      launchEnded: (o: { screen?: string; reason?: string; auth?: { loggedIn?: boolean } | null }) => { environment?: string; error?: string }
      startFailureIn: (file: string) => string
      claudeAuthStatus: (file: string, agentId: string, env: { CLAUDE_CONFIG_DIR?: string }) => { loggedIn?: boolean } | null
      parseAuthStatus: (out: string) => { loggedIn?: boolean } | null
    }
    const { mkdirSync, writeFileSync } = require('fs') as typeof import('fs')
    const { dirname, join } = require('path') as typeof import('path')
    const OAUTH = 'Failed to authenticate: OAuth session expired and could not be refreshed'

    it('its last screen or the reason Hive gives: skipped for the environment, with the sign-in advice', () => {
      const why = launchEnded({ screen: `Claude Code ${OAUTH}` }).environment
      expect(why).toMatch(/^not signed in: /)
      expect(environmentAdvice(why!, 'claude-code')).toMatch(/^sign in to Claude Code's test home .*, by hand$/)
      expect(launchEnded({ reason: OAUTH }).environment).toMatch(/^not signed in: /)
    })

    it('nothing seen, but its auth status says it is signed out: skipped too', () => {
      expect(launchEnded({ auth: { loggedIn: false } }).environment).toMatch(/^not signed in: its auth status/)
      expect(launchEnded({ screen: 'Claude Code', auth: { loggedIn: false } }).environment).toMatch(/^not signed in: its auth status/)
    })

    it('a concrete launch failure stays an error even when the test home is signed out too, from Hive or the screen', () => {
      const bad = "error: option '--model <model>' argument 'x' is invalid."
      expect(launchEnded({ reason: bad, auth: { loggedIn: false } })).toEqual({ error: `the session ended at launch: ${bad}` })
      expect(launchEnded({ screen: `Claude Code ${bad}`, auth: { loggedIn: false } })).toEqual({ error: `the session ended at launch: ${bad}` })
      expect(launchEnded({ screen: 'Claude Code Cannot find module node:sqlite', auth: { loggedIn: true } })).toEqual({ error: 'the session ended at launch: Cannot find module node:sqlite' })
    })

    it("reads auth status as Claude Code prints it: indented JSON, signed in or not", () => {
      expect(parseAuthStatus('{\n  "loggedIn": true,\n  "authMethod": "claude.ai"\n}\n')).toEqual({ loggedIn: true, authMethod: 'claude.ai' })
      expect(parseAuthStatus('{\r\n  "loggedIn": false,\r\n  "authMethod": "none"\r\n}\r\n')).toEqual({ loggedIn: false, authMethod: 'none' })
      expect(parseAuthStatus('')).toBeNull()
      expect(parseAuthStatus('not json')).toBeNull()
    })

    it("asks the CLI Hive started, and keeps its answer when it exits with 1 signed out (the fake, in a test home)", () => {
      const dir = tempDir('hive-auth-status-')
      const home = join(dir, 'home')
      mkdirSync(home)
      const log = join(dir, 'hive.log')
      writeFileSync(log, `2026-10-11T08:24:30.000Z [INFO] [pty] spawn \u2068session:c:\\x\\alpha#a-1\u2069: ${join(process.cwd(), 'tests', 'e2e', 'fake-claude', 'fake-claude.cmd')} ["--session-id","x"]\n`)
      expect(claudeAuthStatus(log, 'a-1', { CLAUDE_CONFIG_DIR: home })).toMatchObject({ loggedIn: true })
      writeFileSync(join(home, 'fake-signin.json'), JSON.stringify({ expired: true, atLaunch: true }))
      expect(claudeAuthStatus(log, 'a-1', { CLAUDE_CONFIG_DIR: home })).toMatchObject({ loggedIn: false })
      expect(claudeAuthStatus(log, 'a-2', { CLAUDE_CONFIG_DIR: home })).toBeNull()
    }, 30000)

    it('anything else is an error at once, saying what it showed', () => {
      expect(launchEnded({ reason: "error: option '--model <model>' argument 'x' is invalid.", auth: { loggedIn: true } })).toEqual({ error: "the session ended at launch: error: option '--model <model>' argument 'x' is invalid." })
      expect(launchEnded({})).toEqual({ error: 'the session ended at launch' })
    })

    it("reads the reason from Hive's log", () => {
      const log = join(tempDir('hive-start-failure-'), 'hive.log')
      writeFileSync(log, `2026-10-11T08:24:30.000Z [INFO] [pty] spawn x\n2026-10-11T08:24:33.000Z [WARN] [sessions] ⁨alpha · Coder⁩: exited with code 1 before it started: ⁨${OAUTH}⁩\n`)
      expect(startFailureIn(log)).toBe(OAUTH)
      expect(startFailureIn(join(dirname(log), 'none.log'))).toBe('')
    })
  })
  // Claude Code's transcript read as Hive reads it (its parser), then the notices the harness takes as the CLI's (#342):
  // a background task's summary or a command's output may talk about an expired sign-in or a limit without one.
  describe("the CLI's own notices, not what it relays (cliNotices, #342)", () => {
    const { cliNotices } = require('./scenarios/harness.cjs') as { cliNotices: (items: unknown) => string[] }
    const line = (o: object) => JSON.stringify({ sessionId: 's', cwd: 'C:\\p', ...o })
    const user = (content: string) => line({ type: 'user', timestamp: 't1', message: { role: 'user', content } })
    const synthetic = (text: string) => line({ type: 'assistant', timestamp: 't2', message: { model: '<synthetic>', content: [{ type: 'text', text }] } })
    const TASK = 'Background task finished: documented how to fix OAuth token has expired errors.'
    const COMMAND = "Notes: when you've hit your usage limit, wait for the reset."
    const relayed = [user(`<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>${TASK}</summary>\n</task-notification>`), user(`<local-command-stdout>${COMMAND}</local-command-stdout>`)]
    const notices = async (lines: string[]) => {
      const { ConversationParser } = await import('../src/main/providers/claude/conversation')
      const p = new ConversationParser('C:\\p')
      p.feed(Buffer.from(lines.join('\n') + '\n'))
      return { items: p.items, cli: cliNotices(p.items) }
    }

    it('a background task or a command that only discusses a sign-in or a limit is no skip', async () => {
      const { items, cli } = await notices(relayed)
      // Both are notices, and each alone would read as an environment failure: what they are is what keeps them out.
      expect(items).toMatchObject([{ kind: 'notice', text: TASK, from: 'task' }, { kind: 'notice', text: COMMAND, from: 'command' }])
      expect(trialEnvironment({ replies: [TASK] })).toMatch(/^not signed in/)
      expect(trialEnvironment({ replies: [COMMAND] })).toMatch(/^usage or rate limit/)
      expect(cli).toEqual([])
      expect(trialEnvironment({ status: 'working', replies: cli })).toBeNull()
    })

    it("beside them, the CLI's own expired sign-in and usage limit are still skips, at once", async () => {
      const login = await notices([...relayed, synthetic('Login expired · Please run /login')])
      expect(login.cli).toEqual(['Login expired · Please run /login'])
      expect(trialEnvironment({ status: 'finished', replies: login.cli })).toMatch(/^not signed in: /)
      const limit = await notices([...relayed, synthetic("You've hit your usage limit · resets 5pm (Europe/London)")])
      expect(trialEnvironment({ status: 'finished', replies: limit.cli })).toMatch(/^usage or rate limit: /)
    })
  })
})

// Before reading Hive's metrics, the harness waits until they count every hive call the bridges logged (#527): the whole
// run on both sides, so a setup call reported before the scenario's baseline counts as reported, not missing.
describe("every logged hive call reported (allCallsReported)", () => {
  const { allCallsReported } = require('./scenarios/harness.cjs') as { allCallsReported: (logged: { tool: string; direct?: boolean }[], metrics: unknown) => boolean }
  const mcp = (count: number) => [{ tool: 'hive_list_tasks', mode: 'compact', outcome: 'ok', count, chars: 10, bytes: 10, totalMs: 1 }]
  const metrics = (project: number, workspace = 0) => ({ projects: { alpha: { mcp: mcp(project) } }, workspace: { mcp: mcp(workspace) } })
  const call = (name: string, direct?: boolean) => ({ tool: name, ...(direct ? { direct } : {}) })

  it("counts a setup call reported before the scenario's baseline (the whole run on both sides)", () => {
    // Setup: one call, reported before the baseline; the scenario: one more (the Assistant's, in the workspace).
    expect(allCallsReported([call('hive_list_tasks'), call('hive_prompt_agent')], metrics(1, 1))).toBe(true)
  })

  it('waits while a call has not been reported yet, or the metrics could not be read', () => {
    expect(allCallsReported([call('hive_list_tasks'), call('hive_prompt_agent')], metrics(1))).toBe(false)
    expect(allCallsReported([call('hive_list_tasks')], null)).toBe(false)
  })

  it("leaves out a fake's direct board change, which no bridge reports", () => {
    expect(allCallsReported([call('hive_update_task', true)], metrics(0))).toBe(true)
    expect(allCallsReported([call('hive_update_task', true), call('hive_read_task')], metrics(0))).toBe(false)
  })
})

// A coordinator's watch is scored as it ended its turn (#402): a new watch replaces the last, so a combined one followed
// by a narrower one leaves only the narrower, and earlier calls prove nothing.
describe("the Assistant's live watch (coordinator scenarios)", () => {
  const sc = SCENARIOS.find((x) => x.id === 'coordinator-wake-question')!
  const call = (cards: number[]) => ({ tool: 'hive_wait_for_tasks', ok: true, args: JSON.stringify({ cards, wake: true }) })
  const outcome = (watch: unknown) => ({
    hiveCalls: [call([2, 3]), call([1])],
    status: 'watching',
    watch,
    cards: { a: { decisions: [] } },
    finalReply: 'Coder asks about an empty name.',
    skillsRead: [],
    allCards: [],
    lanes: []
  })
  const ctx = { cards: { a: 1, b: 2, c: 3 } }
  const ANY = ['column', 'comment', 'verdict', 'agent']
  const check = (o: unknown) => sc.expect(o, ctx).find(([name]) => name.startsWith('ended its turn watching again'))![1]

  it('a combined watch replaced by one on the asking card fails, whatever was called before', () => {
    expect(check(outcome({ cards: [1], changes: ANY, label: '', since: '', limitAt: '' }))).toBe(false)
  })

  it("one live watch over both lanes' ends, waking on anything, passes; one waiting for a single column does not", () => {
    expect(check(outcome({ cards: [1, 2, 3], changes: ANY, label: '', since: '', limitAt: '' }))).toBe(true)
    expect(check(outcome({ cards: [1, 2, 3], changes: ['column'], column: 'done', label: '', since: '', limitAt: '' }))).toBe(false)
    expect(check({ ...outcome({ cards: [2, 3], changes: ANY }), status: 'finished' })).toBe(false)
  })

  it('a narrowed watch fails: column moves only miss a question in a comment and a failed verdict left in Review', () => {
    expect(check(outcome({ cards: [1, 2, 3], changes: ['column'] }))).toBe(false)
    expect(check(outcome({ cards: [1, 2, 3], changes: ['column', 'comment'] }))).toBe(false)
    expect(check(outcome({ cards: [1, 2, 3], changes: ['column', 'verdict'] }))).toBe(false)
    expect(check(outcome({ cards: [1, 2, 3], changes: ['column', 'comment', 'verdict'] }))).toBe(true)
    expect(check(outcome({ cards: [1, 2, 3], changes: ANY, agents: ['coder'] }))).toBe(false)
  })
})

// Following lanes to the end (#402): every watch checked for what it wakes on, and the sweep is one a wake started.
describe('coordinator-lanes-to-end scoring', () => {
  const sc = SCENARIOS.find((x) => x.id === 'coordinator-lanes-to-end')!
  const ANY = ['column', 'comment', 'verdict', 'agent']
  const call = (name: string, args: unknown = {}) => ({ tool: name, ok: true, args: JSON.stringify(args) })
  const watch = (cards: number[], changes = ANY) => ({ cards, changes })
  const run = (calls: ReturnType<typeof call>[], first = watch([2, 3]), second = watch([2])) => {
    const o = { hiveCalls: calls, status: 'finished', watch: null, finalReply: 'Both lanes are done.', lanes: [], cards: {}, allCards: [], skillsRead: [] }
    const checks = sc.expect(o, { cards: { a: 1, b: 2, c: 3 }, wakes: 2, firstWatch: first, secondWatch: second })
    return (start: string) => checks.find(([name]) => name.startsWith(start))![1]
  }
  const wake = (cards: number[]) => call('hive_wait_for_tasks', { cards, wake: true })

  it('a sweep only before its first watch is not a sweep on a wake', () => {
    expect(run([call('hive_list_tasks'), wake([2, 3])])('swept the board')).toBe(false)
    expect(run([wake([2, 3]), call('hive_list_tasks'), wake([2])])('swept the board')).toBe(true)
  })

  it('a column-only watch, first or after the wake, fails', () => {
    const calls = [wake([2, 3]), call('hive_lane', { action: 'list' }), wake([2])]
    expect(run(calls)('first watched')).toBe(true)
    expect(run(calls, watch([2, 3], ['column']))('first watched')).toBe(false)
    expect(run(calls, watch([2, 3]), watch([2], ['column']))('woken by')).toBe(false)
  })
})

// The coordinator scenarios' simulated wakes end as Hive's real one to the Assistant does while lanes run (#402).
describe("the scenarios' simulated wake", () => {
  it("ends with Hive's own lanes-running tail", async () => {
    const { LANES_RUNNING_TAIL } = await import('../src/shared/watch')
    expect(helpers.LANES_RUNNING_TAIL).toBe(LANES_RUNNING_TAIL)
  })
})

// A decision put to the user counts without a "?" (#566): Codex once ended a plan with "Please choose the export target".
describe('mode-*-plans: a decision put to the user', () => {
  const sc = SCENARIOS.find((x) => x.id === 'mode-coordinator-plans')!
  const ctx = { ws: 'no-such-workspace' }
  const outcome = (finalReply: string, descriptions: string[] = []) => ({
    hiveCalls: descriptions.map((description) => ({ tool: 'hive_create_task', ok: true, args: JSON.stringify({ title: 'Export', description }) })),
    finalReply
  })
  const check = (o: unknown, name: string) => sc.expect(o, ctx).find(([n]) => n.startsWith(name))![1]
  const CODEX = 'Please choose the export target and contents above. I recommend all unarchived cards with ID, title, column, agent, labels and blockers. No cards or agents have been started.'

  it('a request to choose, with no cards, is asking first and surfaces the decision', () => {
    expect(check(outcome(CODEX), 'wrote cards for alpha, or asked first')).toBe(true)
    expect(check(outcome(CODEX), 'surfaced a decision')).toBe(true)
    expect(check(outcome('Let me know which columns you want in the file.'), 'surfaced a decision')).toBe(true)
    expect(check(outcome('Done.', ['Export the board. Open: I need your decision on the delimiter before this starts.']), 'surfaced a decision')).toBe(true)
  })

  it('a question still counts; a reply that puts nothing to the user does not', () => {
    expect(check(outcome('Which format should the export use?'), 'surfaced a decision')).toBe(true)
    expect(check(outcome('No cards or agents have been started.'), 'wrote cards for alpha, or asked first')).toBe(false)
    expect(check(outcome('Planned it. Let me know if you need anything else.'), 'surfaced a decision')).toBe(false)
  })

  it('a polite closing is not a decision, in the reply or on a card', () => {
    for (const closing of ['Planned it. Please let me know if you need anything else.', 'Please tell me if anything is unclear.', 'Please let me know what else you need.', 'Let me know what you think.']) {
      expect(check(outcome(closing), 'wrote cards for alpha, or asked first')).toBe(false)
      expect(check(outcome(closing), 'surfaced a decision')).toBe(false)
      expect(check(outcome('Done.', [`Export the board to CSV from the board's menu, done when the file opens in Excel. ${closing}`]), 'surfaced a decision')).toBe(false)
    }
    expect(check(outcome('Please let me know which delimiter to use.'), 'surfaced a decision')).toBe(true)
    expect(check(outcome('Done.', ['Export the board to CSV. Tell me whether archived cards belong in it before this starts.']), 'surfaced a decision')).toBe(true)
  })
})

// fake-copilot's stand-in model starts just before Hive's launch; a launch that fails (or Copilot's environment before
// it) closes it at once, and the launch's own failure is what the run throws (#464).
describe("Copilot's stand-in model when a scenario's launch fails (#464)", () => {
  it('is closed: nothing listens on its port after, and the launch failure is the one thrown', async () => {
    const fs = require('fs') as typeof import('fs')
    const lib = require('./e2e/lib.cjs') as { launch: (o: { env: Record<string, string> }) => Promise<unknown> }
    const { runScenario } = require('./scenarios/harness.cjs') as { runScenario: (sc: object, provider: string, opts: object) => Promise<unknown> }
    const launch = lib.launch
    const work = tempDir('hive-standin-launch-')
    let url = ''
    let answered = 0
    // The launch fails once the stand-in is up: it answers then, as Copilot would reach it.
    lib.launch = async ({ env }) => {
      url = env.COPILOT_PROVIDER_BASE_URL
      answered = (await fetch(`${url}/models`)).status
      throw new Error('injected: the launch failed')
    }
    try {
      await expect(runScenario({ id: 'standin-close', title: 'A launch that fails', prompt: 'nothing' }, 'fake-copilot', { workRoot: work })).rejects.toThrow('injected: the launch failed')
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/)
      expect(answered).toBe(200)
      // Closed: a request is refused, not answered or left waiting.
      await expect(fetch(`${url}/models`, { signal: AbortSignal.timeout(5000) })).rejects.toMatchObject({ cause: { code: 'ECONNREFUSED' } })
    } finally {
      lib.launch = launch
      fs.rmSync(work, { recursive: true, force: true })
    }
  })
})
