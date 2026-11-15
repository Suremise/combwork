// A stand-in CLI with no provider of its own (HI-3196): Combwork runs it from a description alone (the datacli suite writes
// one into its profile's clis folder). No hooks, transcript, sign-in or network. What it does is what a description says:
// - `datacli --version` prints "datacli 1.2.3";
// - it starts a session under `--session-id <id>`, or reopens `--resume <id>` (refused, exit 2, when its store has no such
//   session: a resume of a session that never had a prompt), `--yolo` is its autonomy mode;
// - it draws its prompt "> " when ready, and writes its turn's state as OSC 7501 (state=working / state=idle) as Copilot does;
// - each line typed is a turn: "Working…" (state=working) until FAKE_DATACLI_HOLD's file is gone if it exists, then
//   "Done: <line>" and its prompt again (state=idle); "ask" asks "Allow? (y/n)" and waits for a line ("y" or "n");
//   "/exit" ends it (exit 0);
// - `-p <text>` (HI-3266: a description whose prompt goes on its command line) is its first turn, taken at its start (after
//   its question before its start, when it asks one), with no prompt drawn before it.
// Every launch and every line taken is logged to FAKE_DATACLI_LOG (JSON lines); each session's lines are kept in
// FAKE_DATACLI_STORE (one JSON file: { <id>: [lines] }), so a resume reopens what it had.
const fs = require('fs')

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const log = (e) => {
  if (process.env.FAKE_DATACLI_LOG) fs.appendFileSync(process.env.FAKE_DATACLI_LOG, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...e })}\n`)
}
const storeFile = process.env.FAKE_DATACLI_STORE
const readStore = () => {
  try {
    return JSON.parse(fs.readFileSync(storeFile, 'utf8'))
  } catch {
    return {}
  }
}
const writeStore = (s) => storeFile && fs.writeFileSync(storeFile, JSON.stringify(s))

if (argv[0] === '--version') {
  process.stdout.write('datacli 1.2.3\n')
  process.exit(0)
}

const resumeId = flag('--resume')
const id = resumeId ?? flag('--session-id') ?? null
const argPrompt = flag('-p')
log({ kind: 'launch', args: argv, cwd: process.cwd(), yolo: argv.includes('--yolo'), env: { FAKE_DATACLI_MARK: process.env.FAKE_DATACLI_MARK ?? null, CW_PROJECT: process.env.CW_PROJECT ?? null, OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? null, OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null, DATACLI_CONTEXT: process.env.DATACLI_CONTEXT ?? null, DATACLI_OUTPUT: process.env.DATACLI_OUTPUT ?? null } })
if (resumeId && !readStore()[resumeId]) {
  process.stdout.write(`No session ${resumeId} to resume.\r\n`)
  log({ kind: 'resumeRefused', id: resumeId })
  process.exit(2)
}

const osc = (state) => process.stdout.write(`\x1b]7501;state=${state}:app=datacli\x07`)
const prompt = () => {
  osc('idle')
  process.stdout.write('\r\n> ')
}
process.stdout.write(`datacli 1.2.3 — session ${id ?? 'none'}${resumeId ? ` (resumed, ${(readStore()[resumeId] ?? []).length} lines)` : ''}\r\n`)
// While FAKE_DATACLI_TRUST's file exists: a question before its prompt, as a CLI asks to trust a folder; its answer is no prompt.
let trusting = !!process.env.FAKE_DATACLI_TRUST && fs.existsSync(process.env.FAKE_DATACLI_TRUST) && !resumeId
if (trusting) process.stdout.write('Trust this folder? (y/n) ')
else if (!argPrompt) prompt()

/** One chat request to the server its launch was given (OPENAI_BASE_URL, OPENAI_API_KEY, --model, DATACLI_OUTPUT). */
const ask = (text) =>
  new Promise((resolve, reject) => {
    const url = new URL(`${process.env.OPENAI_BASE_URL.replace(/\/$/, '')}/chat/completions`)
    const body = JSON.stringify({ model: flag('--model') ?? null, messages: [{ role: 'user', content: text }], ...(process.env.DATACLI_OUTPUT ? { max_tokens: Number(process.env.DATACLI_OUTPUT) } : {}) })
    const headers = { 'content-type': 'application/json', ...(process.env.OPENAI_API_KEY ? { authorization: `Bearer ${process.env.OPENAI_API_KEY}` } : {}) }
    const req = require('http').request(url, { method: 'POST', headers }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(data).choices[0].message.content)
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
    req.end(body)
  })

let line = ''
let asking = false
let busy = false
const take = (text) => {
  log({ kind: 'line', id, text, asking: asking || trusting })
  if (trusting) {
    trusting = false
    process.stdout.write(`\r\n${text === 'y' ? 'Trusted.' : 'Not trusted.'}`)
    return argPrompt ? take(argPrompt) : prompt()
  }
  if (asking) {
    asking = false
    process.stdout.write(`\r\n${text === 'y' ? 'Allowed.' : 'Not allowed.'}`)
    return prompt()
  }
  if (text === '/exit') {
    log({ kind: 'exit', id })
    process.exit(0)
  }
  if (id) {
    const s = readStore()
    s[id] = [...(s[id] ?? []), text]
    writeStore(s)
  }
  if (text === 'ask') {
    asking = true
    process.stdout.write('\r\nAllow? (y/n) ')
    return
  }
  busy = true
  osc('working')
  process.stdout.write('\r\nWorking…')
  const hold = process.env.FAKE_DATACLI_HOLD
  const done = (reply) => {
    busy = false
    process.stdout.write(`\r\nDone: ${reply ?? text}`)
    prompt()
  }
  // Given a server (HI-3197: OPENAI_BASE_URL), the line goes to it as OpenAI's chat API takes it, with its key and model.
  if (process.env.OPENAI_BASE_URL) {
    ask(text).then(
      (r) => done(r),
      (e) => done(`server error: ${e.message}`)
    )
    return
  }
  if (hold && fs.existsSync(hold)) {
    const t = setInterval(() => {
      if (!fs.existsSync(hold)) {
        clearInterval(t)
        done()
      }
    }, 100)
  } else setTimeout(done, 200)
}

process.stdin.setRawMode?.(true)
process.stdin.on('data', (d) => {
  for (const ch of d.toString('utf8')) {
    if (ch === '\r' || ch === '\n') {
      const text = line
      line = ''
      if (busy) log({ kind: 'typedWhileBusy', id, text })
      else if (text.length) take(text)
      else prompt()
    } else if (ch === '\x15') {
      line = ''
    } else if (ch === '\x7f' || ch === '\b') {
      line = line.slice(0, -1)
    } else if (ch >= ' ') {
      line += ch
      process.stdout.write(ch)
    }
  }
})
// A first prompt on its command line, with no question before it: its first turn now.
if (argPrompt && !trusting) take(argPrompt)
