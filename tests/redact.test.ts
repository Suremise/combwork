import { describe, expect, it } from 'vitest'
import { createContext, runInContext, runInNewContext } from 'vm'
import { argsForLog, userText } from '../src/main/logger'
import { MARKED_LOG, OLDER_LINE, maskSecrets, maskText, redact, redactLog, type RedactContext } from '../src/shared/redact'
import { SECRET_SAMPLES } from './secretSamples'

const ctx: RedactContext = {
  home: 'C:\\Users\\Jo Smith',
  folders: ['D:\\Work\\acme', 'D:\\Work\\acme.worktrees\\billing\\two'],
  names: [
    { name: 'acme', as: '<workspace>' },
    { name: 'billing', as: '<project>' },
    { name: 'Two', as: '<agent>' },
    { name: 'hive/two', as: '<branch>' }
  ]
}

describe('diagnostics redaction', () => {
  it('folders: the home folder becomes ~, the workspace and worktrees a placeholder, either slash', () => {
    expect(redact('cli at C:\\Users\\Jo Smith\\.local\\bin\\claude.exe', ctx)).toBe('cli at ~\\.local\\bin\\claude.exe')
    expect(redact('c:/users/jo smith/AppData/Roaming/Hive/logs', ctx)).toBe('~/AppData/Roaming/Hive/logs')
    expect(redact('opened D:\\Work\\acme\\billing and D:/work/acme.worktrees/billing/two/src', ctx)).toBe('opened <workspace>\\<project> and <workspace>/src')
  })

  it('names of workspaces, projects, agents and branches, as words only', () => {
    expect(redact('[sessions] billing#Two started on hive/two', ctx)).toBe('[sessions] <project>#<agent> started on <branch>')
    expect(redact('two-factor between billings', ctx)).toBe('two-factor between billings')
  })

  it('secrets: tokens, keys, headers, JWTs, long hex, emails', () => {
    const lines = [
      'Authorization: Bearer abc.def-123',
      'GET /v1/tasks?token=s3cr3tvalue&x=1',
      '{"apiKey": "k-12345678", "ok": true}',
      'ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAA',
      'push with ghp_abcdefghijklmnopqrstuvwxyz0123',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      'hook http://127.0.0.1:60849/hook?run=70f2eb161df8d337491abb47',
      'signed in as jo.smith@example.com'
    ]
    // Line by line, as the log is: a credential masks the rest of its own string.
    const out = lines.map((l) => redact(l, ctx)).join('\n')
    expect(out).not.toMatch(/abc\.def-123|s3cr3tvalue|k-12345678|sk-ant|ghp_|eyJhbGci|70f2eb16|jo\.smith@/)
    expect(out).toContain('Authorization: <redacted>')
    // Everything after a credential's name in its string is masked (#699): the rest of the query too.
    expect(out).toContain('GET /v1/tasks?token=<redacted>')
    expect(out).not.toContain('&x=1')
    // A quoted name masks the rest of its string too (#699 round 5): the JSON's other fields go with it.
    expect(out).toContain('{"apiKey": <redacted>')
    expect(out).toContain('<email>')
  })

  it('free text: secret options and their values (quoted with spaces too), passwords written out, sign-in and device codes (#699)', () => {
    for (const s of SECRET_SAMPLES) {
      for (const out of [maskText(s.text), redact(s.text, ctx)]) {
        for (const secret of s.secrets) expect(out, s.text).not.toContain(secret)
        for (const k of s.kept ?? []) expect(out, s.text).toContain(k)
      }
    }
    expect(maskText('password: very secret phrase')).toBe('password: <redacted>')
    expect(maskText('ran tool --password "very secret phrase" --verbose')).toBe('ran tool --password <redacted>')
    expect(maskText('{"password": "a b", "ok": true}')).toBe('{"password": <redacted>')
    expect(maskText('{"config":{"password":"hunter2","ok":true},"other":1}')).toBe('{"config":{"password":<redacted>')
    expect(maskText('enter ABCD-EFGH')).toBe('enter <redacted>')
  })

  it('a quoted key naming a credential masks its value whatever else is in the name: punctuation, escaped or mismatched quotes (#705 round 1)', () => {
    const BS = '\\'
    const quotes: [string, string][] = [['"', '"'], ["'", "'"], [`${BS}"`, `${BS}"`], ['"', "'"]]
    const words = ['token', 'password', 'api_key', 'auth', 'secret', 'pwd', 'credentials']
    const punct = ['/', '[0]', '!', '@', '#', '%', '&', '*', '|', '<', '>', '?', ';', '~', '`', '^', '+', '(', ')', '{', '}', ',', '$', 'é', ' ', '.', '-', '_']
    for (const [open, close] of quotes) {
      for (const w of words) {
        for (const p of punct) {
          for (const name of [`${w}${p}x`, `x${p}${w}`, `${p}${w}${p}`]) {
            for (const sep of [':', '=', ' : ', ': ']) {
              const text = `{${open}${name}${close}${sep}${open}privateValue${close}}`
              expect(maskText(text), text).not.toContain('privateValue')
            }
          }
        }
      }
    }
  })

  it("the log: a credential masks the rest of its line, and the lines a continuation carries it onto", () => {
    const T = '2026-10-02T10:00:00.000Z [INFO] [sessions]'
    const log = [`${T} Hive 0.7.0 starting (${MARKED_LOG})`, `${T} ran curl --api-key \``, '  continuedLogSecret `', '  againLogSecret', `${T} next line stays`].join('\n')
    const out = redactLog(log, ctx)
    expect(out).not.toMatch(/continuedLogSecret|againLogSecret/)
    expect(out).toContain(`${T} next line stays`)
    expect(out).toContain('ran curl --api-key <redacted>')
  })

  it('masking ends on any whitespace and on long input, and masks everything after a credential (#699 rounds 3–4)', () => {
    const WHITESPACE = ['\t', '\v', '\f', ' ', '\u00a0', '\u1680', '\u2000', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff', '\r', '\n', '\r\n']
    const shapes = (w: string): string[] => [
      `tool --token short${w}secret`,
      `tool --token ${w}${w}secret`,
      `tool --token "a${w}b" --x`,
      `tool --token \`${w}secret`,
      `tool --password \\${w}secret`,
      `tool --token=${w}`,
      `password: short${w}secret`,
      `token=short${w}secret`,
      `Authorization: short${w}secret`,
      `{"token": "short${w}secret"}`,
      `-u user:short${w}secret`,
      `enter ABCD-EFGH${w}`,
      `${w}--token${w}${w}`
    ]
    for (const w of WHITESPACE) {
      for (const text of shapes(w)) {
        // A masking that never ends would hang the test: vm's bound stops it, and the test fails with a timeout error.
        const out = runInNewContext('maskText(text)', { maskText, text }, { timeout: 5000 }) as string
        // Whatever separates the words, on one line or more, everything after a credential's name is masked.
        if (text.includes('secret')) expect(out, JSON.stringify(text)).not.toContain('secret')
      }
    }
    // Long input, shaped to make a backtracking pattern slow: words that hold a credential's name many times over, many
    // names, long runs of spaces, quotes and continuations. Each must finish well inside the bound.
    const long = ['token'.repeat(200_000), 'x-'.repeat(500_000), '--verbose '.repeat(100_000), 'mytoken'.repeat(100_000) + ' = v', `"${'a'.repeat(1_000_000)}`, ' '.repeat(1_000_000) + 'token=x', '"token": "'.repeat(100_000), 'a `\n'.repeat(200_000), `code${' '.repeat(1_000_000)}x`, `a.${'b.'.repeat(500_000)}`, `${'a@'.repeat(300_000)}`, '-u "'.repeat(250_000), `-u "${'a b'.repeat(300_000)}`, ' -u x'.repeat(200_000), '{"a":'.repeat(200_000), `"${'a'.repeat(99)}`.repeat(10_000), '{"config":{"x":['.repeat(60_000), `{"token":"${'\\"'.repeat(300_000)}`]
    for (const text of long) expect(() => runInNewContext('maskText(text)', { maskText, text }, { timeout: 5000 }), text.slice(0, 20)).not.toThrow()
  })

  // #699 round 6 (the Assistant's rule): backslashes and quotes at 10k, 100k and 1M characters, through masking whole
  // strings (Copy Diagnostics' path; the console cuts first), each well inside the bound.
  it('masking scales linearly on backslashes and quotes: 10k, 100k and 1M characters (#699 round 6)', () => {
    const BS = '\\'
    const vmContext = createContext({ maskText, text: '' })
    for (const n of [10_000, 100_000, 1_000_000]) {
      for (const text of [BS.repeat(n), '"'.repeat(n), "'".repeat(n), `${BS}"`.repeat(n / 2), `"${BS.repeat(n)}`, `-u ${BS.repeat(n)}`, `"token":${BS.repeat(n)}`, `${'"a'.repeat(n / 2)}`]) {
        vmContext.text = text
        expect(() => runInContext('maskText(text)', vmContext, { timeout: 5000 }), `${n}: ${JSON.stringify(text.slice(0, 8))}`).not.toThrow()
      }
    }
  })

  // #699 round 5: a long run of backslashes made the quoted-name search quadratic. Not one shape but every one of these:
  // each pair of the characters the patterns care about, repeated, and each credential prefix followed by a long run of
  // one of them, or repeated with it. At 200,000 characters a quadratic pattern takes minutes and a linear one
  // milliseconds, so the bound tells them apart under any load.
  it('masking is linear on every adversarial shape: each pair of special characters, each credential prefix (#699 round 5)', () => {
    const BS = '\\'
    const CHARS = [BS, '"', "'", '-', ':', '=', '@', '.', '+', '/', '`', ' ', '\t', '\n', 'a', 'A', '0', '{', '[', '\u2068', '\u2069', '?', '&', 'e']
    const PREFIXES = ['-u ', '--user=', '--token ', 'token', 'token=', '"', `${BS}"`, 'eyJ', 'a@', 'code ', 'Bearer ', 'sk-', '"token":']
    const N = 200_000
    const pairs: string[] = []
    for (const a of CHARS) for (const b of CHARS) pairs.push((a + b).repeat(N / 2))
    const prefixed: string[] = []
    for (const p of PREFIXES) {
      for (const c of CHARS) prefixed.push(p + c.repeat(N), (p + c).repeat(Math.floor(N / (p.length + 1))))
    }
    const vmContext = createContext({ maskText, redactLog, ctx, text: '' })
    const start = `2026-10-02T10:00:00.000Z [INFO] [main] Hive 0.7.0 starting (${MARKED_LOG})\n`
    for (const text of [...pairs, ...prefixed]) {
      vmContext.text = text
      // A pattern that reads a run again from inside it would blow the bound; vm stops it and the test fails.
      expect(() => runInContext('maskText(text)', vmContext, { timeout: 5000 }), JSON.stringify(text.slice(0, 12))).not.toThrow()
    }
    // The log too (a line at a time, its user-text marks first), on one long line of each case.
    for (const text of [...pairs, ...prefixed].filter((t) => !t.includes('\n'))) {
      vmContext.text = start + text
      expect(() => runInContext('redactLog(text, ctx)', vmContext, { timeout: 5000 }), `log ${JSON.stringify(text.slice(0, 12))}`).not.toThrow()
    }
  }, 300_000)

  it("names and identifiers keep their shape: no sign-in code is read into them, a session id's parts included", () => {
    for (const id of ['0B6F5D1E-6D5A-4C1F-9A4E-1C2D3E4F5A6B', 'ABCD-EFGH', 'hive.console.showText', 'PreToolUse']) expect(maskSecrets(id)).toBe(id)
    expect(maskText('session 0B6F5D1E-6D5A-4C1F-9A4E-1C2D3E4F5A6B resumed')).toBe('session 0B6F5D1E-6D5A-4C1F-9A4E-1C2D3E4F5A6B resumed')
    expect(maskText('ran npm test -- --reporter dot; 2758 tests passed')).toBe('ran npm test -- --reporter dot; 2758 tests passed')
  })

  it('keeps what a report needs', () => {
    const line = '2026-10-02T10:00:00.000Z [INFO] [updater] Update settings: check on, download auto, install auto, pre-releases off'
    expect(redact(line, ctx)).toBe(line)
    expect(redact('Claude Code 2.1.4 at ~/.local/bin', ctx)).toBe('Claude Code 2.1.4 at ~/.local/bin')
    expect(redact('session 0b6f5d1e-6d5a-4c1f-9a4e-1c2d3e4f5a6b resumed', ctx)).toBe('session 0b6f5d1e-6d5a-4c1f-9a4e-1c2d3e4f5a6b resumed')
  })
})

describe('diagnostics redaction of the log', () => {
  const T = '2026-10-02T10:00:00.000Z [INFO]'
  it("the user's own text the log marked: card titles, Assistant activity, session names, prompts", () => {
    const lines = [
      `${T} [tasks] #1 created by ${userText('Claudette (hive)')}: ${userText('Confidential customer merger notes')}`,
      `${T} [assistant] ${userText('D:\\Secret\\ws')}: ${userText('Moved #3 Fire Bob to Doing')}`,
      `${T} [sessions] Session 1 takes the name ${userText('Q3 layoffs plan')} it was given in the CLI`,
      `${T} [pty] spawn ${userText('D:\\Secret\\ws\\alpha#a-1')}: claude.exe ${JSON.stringify(['--model', 'opus', userText('Draft the merger memo for Acme')])}`
    ]
    const out = redactLog(lines.join('\n'), ctx)
    expect(out).not.toMatch(/Claudette|Confidential|merger|Secret|Fire Bob|layoffs|Acme|alpha/)
    expect(out).toContain('#1 created by <text>: <text>')
    expect(out).toContain('[assistant] <path>: <text>')
    expect(out).toContain('spawn <path>: claude.exe ["--model","opus","<text>"]')
    expect(out).not.toMatch(/[\u2068\u2069]/)
  })

  it('a span cut off at the end of a line goes too', () => {
    expect(redactLog(`${T} [tasks] #2 created by You: \u2068Private plans`, ctx)).toBe(`${T} [tasks] #2 created by You: <text>`)
  })

  it("older lines: earlier workspaces' folders and names, and any other path of the user's", () => {
    const earlier: RedactContext = { ...ctx, folders: [...ctx.folders, 'D:\\Clients\\Confidential Workspace'], names: [...ctx.names, { name: 'PrivateProject', as: '<name>' }] }
    const lines = [
      `${T} [workspace] Opened workspace D:\\Clients\\Confidential Workspace`,
      `${T} [workspace] Excluded .hive from git in D:\\Clients\\Confidential Workspace\\PrivateProject`,
      `${T} [worktrees] Removed worktree E:/elsewhere/thing/two`,
      `${T} [projects] Hid PrivateProject`
    ]
    const out = redactLog(lines.join('\n'), earlier)
    expect(out).not.toMatch(/Clients|Confidential|PrivateProject|elsewhere/)
    expect(out).toContain('Opened workspace <workspace>')
    expect(out).toContain('Removed worktree <path>')
  })

  it("keeps Hive's and the CLIs' own paths, and each line's [scope]", () => {
    const keep = [
      `${T} [main] at f (C:\\Users\\Jo Smith\\AppData\\Local\\Programs\\Hive\\resources\\app.asar\\out\\main\\index.js:12:3)`,
      `${T} [claude] Candidate C:\\Users\\Jo Smith\\.local\\bin\\claude.exe did not report a version`,
      `${T} [codex] Candidate C:\\Program Files\\nodejs\\codex.cmd did not report a version`
    ]
    const out = redactLog(keep.join('\n'), ctx)
    expect(out).toContain('(~\\AppData\\Local\\Programs\\Hive\\resources\\app.asar\\out\\main\\index.js:12:3)')
    expect(out).toContain('~\\.local\\bin\\claude.exe')
    expect(out).toContain('C:\\Program Files\\nodejs')
    expect(out).not.toContain('<path>')
    const sessions: RedactContext = { ...ctx, names: [{ name: 'sessions', as: '<project>' }] }
    expect(redactLog(`${T} [sessions] sessions finished`, sessions)).toBe(`${T} [sessions] <project> finished`)
    expect(redactLog(`${T} [main] D:\\dev\\hive\\out\\main\\index.js:5`, { ...ctx, app: 'D:\\dev\\hive' })).toBe(`${T} [main] <hive>\\out\\main\\index.js:5`)
  })

  it("lines logged before Hive marked the user's text keep only their time, level and scope", () => {
    const lines = [
      `${T} [tasks] #7 created by You: Earlier run, unknown version`,
      `${T} [main] Hive 0.3.1 starting (Electron 44.5.1)`,
      `${T} [tasks] #1 created by You: Confidential customer merger notes`,
      `${T} [main] Hive 0.4.0 starting (Electron 44.5.1; ${MARKED_LOG})`,
      `${T} [tasks] #2 created by ${userText('You')}: ${userText('Another secret plan')}`,
      `${T} [updates] Update settings: check on`
    ]
    expect(redactLog(lines.join('\n'), ctx).split('\n')).toEqual([
      `${T} [tasks] ${OLDER_LINE}`,
      `${T} [main] Hive 0.3.1 starting (Electron 44.5.1)`,
      `${T} [tasks] ${OLDER_LINE}`,
      `${T} [main] Hive 0.4.0 starting (Electron 44.5.1; ${MARKED_LOG})`,
      `${T} [tasks] #2 created by <text>: <text>`,
      `${T} [updates] Update settings: check on`
    ])
    // No start line in view: every line is from the running Hive, which marks.
    expect(redactLog(`${T} [tasks] #3 created by ${userText('You')}: ${userText('x')}`, ctx)).toBe(`${T} [tasks] #3 created by <text>: <text>`)
  })

  it("an agent's launch arguments: by role, not by how they look", () => {
    const claude = ['--session-id', '0b6f5d1e-6d5a-4c1f-9a4e-1c2d3e4f5a6b', '--name', 'Merger', '--settings', 'D:\\ws\\a\\.hive\\settings.json', '--model', 'opus', '--effort', 'high', '--permission-mode', 'auto', 'ConfidentialMerger']
    const out = redactLog(`${T} [pty] spawn x: claude.exe ${JSON.stringify(argsForLog(claude))}`, ctx)
    expect(out).not.toMatch(/Merger|\\ws\\/)
    expect(out).toContain('["--session-id","0b6f5d1e-6d5a-4c1f-9a4e-1c2d3e4f5a6b","--name","<text>","--settings","<path>","--model","opus","--effort","high","--permission-mode","auto","<text>"]')
    const codex = ['/d', '/s', '/c', 'D:\\tools\\codex.cmd', 'resume', '0b6f5d1e-6d5a-4c1f-9a4e-1c2d3e4f5a6b', '-c', 'developer_instructions="Be terse"', '-c', 'mcp_servers.acme-crm={command="x"}', '-s', 'workspace-write', 'resume']
    expect(argsForLog(codex).map((a) => a.replace(/\u2068[^\u2069]*\u2069/g, '<marked>'))).toEqual(['/d', '/s', '/c', '<marked>', 'resume', '0b6f5d1e-6d5a-4c1f-9a4e-1c2d3e4f5a6b', '-c', 'developer_instructions=<marked>', '-c', '<marked>', '-s', 'workspace-write', '<marked>'])
  })

  it('a value written into its flag (--flag=value) is judged the same way', () => {
    const extra = ['--append-system-prompt=ConfidentialMerger', '--name=PrivateClient', '--config=developer_instructions="Be terse"', '-c=mcp_servers.acme-crm.enabled=false', '--model=opus', '--model=has space', '--x.y=Secret', 'Next']
    const marked = (a: string): string => a.replace(/\u2068[^\u2069]*\u2069/g, '<marked>')
    expect(argsForLog(extra).map(marked)).toEqual(['--append-system-prompt=<marked>', '--name=<marked>', '--config=developer_instructions=<marked>', '-c=<marked>', '--model=opus', '--model=<marked>', '--x.y=<marked>', '<marked>'])
    const out = redactLog(`${T} [pty] spawn x: claude.exe ${JSON.stringify(argsForLog(extra))}`, ctx)
    expect(out).not.toMatch(/Confidential|PrivateClient|terse|acme|Secret|Next/)
  })
})
