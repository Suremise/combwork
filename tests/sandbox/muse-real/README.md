# Muse Code's real binary, in a Windows Sandbox

Muse Code has no real-tier e2e suite. Nothing of Muse's runs on the host, because on a PC without Muse's own sandbox its first screen asks for administrator rights to create local accounts (HI-3202). This folder checks Muse 1.4.20 itself in a disposable Windows Sandbox instead. The fake (`tests/e2e/fake-muse`, the `muse` suite) covers Combwork's side: its pane, locks, tool calls and usage.

## What it runs

- **The binary:** the pinned `muse.exe` 1.4.20, SHA-256 `2d223f7f…6618a`, checked again inside the Sandbox.
- **The launch:** built by Combwork's own code. `stage.mjs` bundles `run.ts` with `src/main/providers/muse` (`launch.ts`, `home.ts`) and the advanced values.
- **Offline and headless:** the Sandbox's network is off; `muse exec --provider echo --disable-sandbox -c telemetry.enabled=false` runs with stdin closed. Nothing is typed into Muse or answered.
- **Stubs:** Combwork's hook server is a local HTTP stub; its tools server is `mcp.cjs`.

## What it proves

- **The launch:** Muse 1.4.20 takes it (exit 0), with no token in its arguments and `META_API_KEY` stripped.
- **The hooks:** every hook reaches the server through cmd, quote-free, with the auth file's token and the URL's `&` intact.
- **The guidance:** it is the session's start context, multibyte text kept. Past 16,384 bytes it becomes a pointer to the full file.
- **The skill:** Combwork's copy in `.agents\skills\cw-<name>` is offered as a project skill.
- **The tools server:** it starts with its literal env passed as `${CW_MUSE_MCP_*}`, and its tools are listed.
- **The resume:** `resume <id>` resumes the session and runs no hook before a prompt, and its input box shows as `muse.ready.input` reads it. Given a prompt (`exec --session-id`), SessionStart runs and the guidance is given again.

## What it can't prove

The echo provider calls no model and makes no tool calls. So a file lock's block reply, the model's choice of tools, tool-call records and real token counts stay unverified here. The fake covers Combwork's side of each.

## How to run it

It runs in one Sandbox turn, about 5 minutes. The machine has one Sandbox at a time, so ask whoever is queueing them (the Assistant) for a turn.

1. Stage it: `node tests/sandbox/muse-real/stage.mjs`. It prints a new folder, `out\muse-real-<time>`, with the pinned binary from `%LOCALAPPDATA%\combwork-test\muse-1.4.20\` (or `--muse <path>`). `--dry` instead builds every launch on this machine without starting Muse.
2. Start a Sandbox with that folder as its build, network off, through the `windows-sandbox` MCP tools: `sandbox_start`, then `sandbox_run` of `C:\build\go.cmd` (up to 10 minutes).
3. Collect `report.json`, `console.txt`, `hooks.jsonl` and each run's `*-args.json` and `*-output.txt` with `sandbox_collect`. Then `sandbox_stop`, and delete the staged folder.

HI-3202's run (14 Nov 2026, 17:04–17:11 UTC) is Muse's real-binary evidence for that card. It ran an earlier `run.ts`, whose skill check read the wrong record and whose resume check expected a hook. Both behaviours were checked by hand in that Sandbox: the skill's `<skill id="cw-muse-probe" scope="project" …>` in the model's input, the resumed TUI's input box with no hook, and `exec --session-id`. The checks here are the corrected ones.
