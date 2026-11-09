# OpenCode 2.2.6, as recorded

What the real OpenCode v2.2.6 did, recorded for the fake opencode (`tests/e2e/fake-opencode`) and its tests. Nothing in the fake is modelled on anything else.

- **Build:** `opencode-windows-x64.zip` from the v2.2.6 release (anomalyco/opencode, dc2ffcf, 6 Nov 2026). The zip's SHA-256 is `f75c16b33b8523fe1ff41e7d97e3ae654a47d59a0e327def24db2d9291bb24be`, as GitHub's digest and the release's `SHA256SUMS` give it. Its `opencode.exe` is `98cb0aa854c7c015cf6febafa7afb872c359bfe5a823a526f3b4fd347a9e9677`.
- **Conditions:** Darren's HI-2758 option A (8 Nov 2026). Every launch had a new throwaway root under `%LOCALAPPDATA%\combwork-test\tmp`, a minimal environment, updates off, a private `serve` on 127.0.0.1 stopped by tree, and no accounts, keys or cloud calls. Model turns went only to local Ollama `qwen3:8b`, through a logging proxy.
- **Sources:**
  - HI-2758's probe (HB1): `cli/version.txt`, `help.txt`, `models-with-ollama-and-builtins.txt`, `auth-list-saved-and-env.json`, `shared-service-port-in-use.txt` and `events/shell-permission-reject.json`;
  - HI-2760's probe (HB1, 9 Nov 2026, offline: no model call, prompts on a denied provider failing at once): `wire/message-paging.json` (`limit`, `order`, `cursor`), `wire/log-synced.txt` (the durable log's watermark) and `events/event-types-filter.txt` (`/api/event?types=`, with each event's durable seq);
  - HI-2763's R0 (HB2, 8 Nov 2026, 23:13–23:19 UTC): everything else.
- **Scrubbed:** machine paths are `<root>`/`<home>`/`<bin>`, the host is `<host>`, and the user is `<user>`. Event files drop the recorder's own `t`, which never goes over the wire. The SSE framing is exactly as sent in `events/sse-framing.txt`. `wire/integration.json` keeps the first 4 of the 240 integrations.

| Folder | What |
| --- | --- |
| `cli/` | The commands Combwork runs: their output and exit code. |
| `wire/` | The private server's answers: auth (401), info, sessions (create with or without an id, again, a bad id, absent), messages, permissions, interrupt, export/import, models, MCP, unknown routes. |
| `events/` | One session's `/api/event` stream per case: a shell tool with a permission answered once and rejected, no tool, interrupted, an MCP tool through Code Mode's `execute`, a provider failing at once (400) and after retries (refused connection). |
| `messages/` | `GET /api/session/{id}/message` after each case, and after an import. |
| `switches/` | What loaded from a hostile project with each discovery switch alone, both and none: config files, the model's instructions (codewords), which MCP server started with whose token, and plugin markers. |
| `tui/` | The TUI given an absent `--session`: a new-session screen, with no session created. |

**Not recorded, so not faked:**
- the TUI's own screens beyond that;
- a key sign-in through `auth login`, which needs an interactive terminal (`cli/auth-login-*-no-tty.txt`). The server's `POST /api/integration/{id}/connect/key` is HI-2758's record;
- a first `session import` on the CLI. Only an import of a session that already exists is on record.
